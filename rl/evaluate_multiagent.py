from __future__ import annotations

import argparse
import json
from pathlib import Path

import jax
import jax.numpy as jnp

from evaluate_policy import apply_actor, load_actor
from jax_multiagent import load_track, multi_env_step, observe_multi, reset_multi_batch


def heuristic_action(state):
    opponent_lateral = state[:, 9]
    ego_lateral = state[:, 1]
    gap = state[:, 8] - state[:, 0]
    open_side = jnp.where(opponent_lateral >= ego_lateral, -0.64, 0.64)
    attacking = (gap > -6.0) & (gap < 28.0)
    return jnp.stack((jnp.where(attacking, open_side, 0.0), jnp.full_like(gap, 0.18),
                      jnp.full_like(gap, 0.22), jnp.full_like(gap, 0.62)), axis=-1)


def evaluate(initial_state, track, steps: int, actor=None):
    environment_count = initial_state.shape[0]

    def scan_step(carry, _):
        state, key = carry
        key, reset_key = jax.random.split(key)
        action = apply_actor(actor, observe_multi(state, track)) if actor is not None else heuristic_action(state)
        result = multi_env_step(state, action, track)
        reset = reset_multi_batch(reset_key, environment_count, track["length"])
        next_state = jnp.where(result.done[:, None], reset, result.state)
        return (next_state, key), jnp.concatenate((result.metrics, result.done[:, None]), axis=-1)

    (_, _), metrics = jax.lax.scan(scan_step, (initial_state, jax.random.PRNGKey(90210)), None, length=steps)
    totals = jnp.sum(metrics, axis=(0, 1))
    episodes = environment_count + totals[7]
    environment_steps = environment_count * steps
    return {
        "episodes": episodes,
        "cleanPassesPer100Episodes": 100.0 * totals[0] / episodes,
        "contactIncidentsPer100Episodes": 100.0 * totals[1] / episodes,
        "deepContactIncidentsPer100Episodes": 100.0 * totals[2] / episodes,
        "egoOffsPer100Episodes": 100.0 * totals[3] / episodes,
        "forcedOpponentOffsPer100Episodes": 100.0 * totals[4] / episodes,
        "durableClearPercent": 100.0 * totals[5] / environment_steps,
        "relativeGainMPerStep": totals[6] / environment_steps,
    }


def main():
    parser = argparse.ArgumentParser(description="Audit learned overtakes against a deterministic baseline.")
    parser.add_argument("policy", type=Path)
    parser.add_argument("--envs", type=int, default=4096)
    parser.add_argument("--steps", type=int, default=700)
    args = parser.parse_args()
    track = load_track()
    initial = reset_multi_batch(jax.random.PRNGKey(441), args.envs, track["length"])
    actor, payload = load_actor(args.policy)
    evaluator = jax.jit(lambda state: (evaluate(state, track, args.steps, actor), evaluate(state, track, args.steps)))
    learned, heuristic = evaluator(initial)
    jax.block_until_ready(learned)
    convert = lambda values: {key: float(value) for key, value in values.items()}
    result = {"device": str(jax.devices()[0]), "policy": str(args.policy),
              "training": payload.get("metadata", {}), "learned": convert(learned),
              "heuristic": convert(heuristic)}
    result["acceptance"] = {
        "cleanPasses": result["learned"]["cleanPassesPer100Episodes"] >= 20.0,
        "contactControl": (
            result["learned"]["contactIncidentsPer100Episodes"] < result["heuristic"]["contactIncidentsPer100Episodes"]
            and result["learned"]["deepContactIncidentsPer100Episodes"] <= 0.25
        ),
        "noForcedOff": result["learned"]["forcedOpponentOffsPer100Episodes"] <= 0.5,
    }
    print(json.dumps(result, indent=2))
    if not all(result["acceptance"].values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
