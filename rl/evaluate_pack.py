from __future__ import annotations

import argparse
import json
from pathlib import Path

import jax
import jax.numpy as jnp

from evaluate_policy import apply_actor, load_actor
from jax_pack import PACK_CARS, load_track, observe_pack, pack_env_step, reset_done, reset_pack_batch


def heuristic_actions(state):
    cars = state.cars
    agents = cars.shape[1]
    ego = cars[:, :, None, :]
    opponents = cars[:, None, :, :]
    gap = opponents[..., 0] - ego[..., 0]
    lateral = opponents[..., 1] - ego[..., 1]
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]
    ahead = (gap > 0.0) & ~diagonal
    index = jnp.argmin(jnp.where(ahead, gap, jnp.inf), axis=-1)
    front_lateral = jnp.take_along_axis(lateral, index[..., None], axis=-1)[..., 0]
    front_gap = jnp.take_along_axis(gap, index[..., None], axis=-1)[..., 0]
    has_front = jnp.any(ahead, axis=-1)
    attack = has_front & (front_gap < 30.0)
    line = jnp.where(attack, jnp.where(front_lateral >= 0.0, -0.66, 0.66), 0.0)
    return jnp.stack((line, jnp.full_like(line, 0.18), jnp.full_like(line, 0.18), jnp.full_like(line, 0.55)), axis=-1)


def evaluate(initial_state, track, steps: int, actor=None):
    environment_count = initial_state.cars.shape[0]

    def scan_step(carry, _):
        state, key = carry
        key, reset_key = jax.random.split(key)
        if actor is not None:
            action = apply_actor(actor, observe_pack(state, track))
            # Hybrid authority: the learned layer chooses pace/aggression/ERS;
            # deterministic geometry retains final ownership of the lane target.
            geometric_line = heuristic_actions(state)[..., 0]
            action = action.at[..., 0].set(geometric_line)
        else:
            action = heuristic_actions(state)
        result = pack_env_step(state, action, track)
        reset = reset_pack_batch(reset_key, environment_count, track)
        return (reset_done(result.state, reset, result.done), key), result.metrics

    (_, _), metrics = jax.lax.scan(scan_step, (initial_state, jax.random.PRNGKey(9917)), None, length=steps)
    totals = jnp.sum(metrics, axis=(0, 1))
    episodes = environment_count + totals[7]
    return {"episodes": episodes,
            "cleanPassesPer100Episodes": 100.0 * totals[0] / episodes,
            "contactIncidentsPer100Episodes": 100.0 * totals[1] / episodes,
            "deepContactsPer100Episodes": 100.0 * totals[2] / episodes,
            "offsPer100Episodes": 100.0 * totals[3] / episodes,
            "forcedOffsPer100Episodes": 100.0 * totals[4] / episodes,
            "meanProgressMPerStep": totals[6] / (environment_count * steps)}


def main():
    parser = argparse.ArgumentParser(description="Audit a shared policy in four-car packs.")
    parser.add_argument("policy", type=Path)
    parser.add_argument("--envs", type=int, default=2048)
    parser.add_argument("--steps", type=int, default=900)
    args = parser.parse_args()
    track = load_track()
    initial = reset_pack_batch(jax.random.PRNGKey(881), args.envs, track)
    actor, payload = load_actor(args.policy)
    learned, heuristic = jax.jit(lambda state: (evaluate(state, track, args.steps, actor),
                                                 evaluate(state, track, args.steps)))(initial)
    jax.block_until_ready(learned)
    convert = lambda values: {key: float(value) for key, value in values.items()}
    result = {"device": str(jax.devices()[0]), "policy": str(args.policy),
              "training": payload.get("metadata", {}), "learned": convert(learned),
              "heuristic": convert(heuristic)}
    result["acceptance"] = {
        "moreCleanPassing": result["learned"]["cleanPassesPer100Episodes"] >= result["heuristic"]["cleanPassesPer100Episodes"] * 1.1,
        "lessDeepContact": result["learned"]["deepContactsPer100Episodes"] <= result["heuristic"]["deepContactsPer100Episodes"],
        "noRaceRuining": result["learned"]["forcedOffsPer100Episodes"] <= 0.5,
        "stablePack": result["learned"]["offsPer100Episodes"] <= result["heuristic"]["offsPer100Episodes"],
    }
    print(json.dumps(result, indent=2))
    if not all(result["acceptance"].values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
