from __future__ import annotations

import argparse
import json
from pathlib import Path

import jax
import jax.numpy as jnp

from jax_vehicle import env_step, load_track, observe, reset_batch


def load_actor(path: Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    layers = tuple({"weight": jnp.asarray(layer["weight"], dtype=jnp.float32).T,
                    "bias": jnp.asarray(layer["bias"], dtype=jnp.float32)} for layer in payload["layers"])
    return layers, payload


def apply_actor(layers, observation):
    values = observation
    for index, layer in enumerate(layers):
        values = values @ layer["weight"] + layer["bias"]
        values = jnp.tanh(values)
    return values


def evaluate(initial_state, track, steps: int, actor=None, random_actions=False):
    environment_count = initial_state.shape[0]

    def scan_step(carry, index):
        state, key = carry
        observation = observe(state, track)
        key, action_key, reset_key = jax.random.split(key, 3)
        if random_actions:
            action = jax.random.uniform(action_key, (environment_count, 4), minval=-1.0, maxval=1.0)
        elif actor is None:
            action = jnp.tile(jnp.asarray([0.0, 0.15, 0.0, 0.35]), (environment_count, 1))
        else:
            action = apply_actor(actor, observation)
        result = env_step(state, action, track)
        reset = reset_batch(reset_key, environment_count, track["length"])
        next_state = jnp.where(result.done[:, None], reset, result.state)
        progress_delta = jnp.maximum(0.0, result.state[:, 0] - state[:, 0])
        metrics = jnp.stack((result.reward, result.done.astype(jnp.float32), progress_delta,
                             jnp.abs(result.state[:, 1]), result.state[:, 6]), axis=-1)
        return (next_state, key), metrics

    (_, _), metrics = jax.lax.scan(scan_step, (initial_state, jax.random.PRNGKey(90210)), jnp.arange(steps))
    mean = jnp.mean(metrics, axis=(0, 1))
    return {"rewardPerStep": mean[0], "doneRate": mean[1], "progressMPerStep": mean[2],
            "meanAbsLateralM": mean[3], "meanTireUtilization": mean[4]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("policy", type=Path)
    parser.add_argument("--envs", type=int, default=4096)
    parser.add_argument("--steps", type=int, default=1000)
    args = parser.parse_args()
    track = load_track()
    initial = reset_batch(jax.random.PRNGKey(1234), args.envs, track["length"])
    actor, payload = load_actor(args.policy)
    evaluator = jax.jit(lambda state: (
        evaluate(state, track, args.steps, actor=actor),
        evaluate(state, track, args.steps, actor=None),
        evaluate(state, track, args.steps, random_actions=True)
    ))
    learned, heuristic, random = evaluator(initial)
    jax.block_until_ready(learned)
    convert = lambda values: {key: float(value) for key, value in values.items()}
    print(json.dumps({"device": str(jax.devices()[0]), "policy": str(args.policy),
                      "training": payload.get("metadata", {}), "learned": convert(learned),
                      "heuristic": convert(heuristic), "random": convert(random)}, indent=2))


if __name__ == "__main__":
    main()
