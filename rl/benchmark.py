from __future__ import annotations

import argparse
import json
import time

import jax
import jax.numpy as jnp

from jax_vehicle import env_step, load_track, reset_batch

parser = argparse.ArgumentParser()
parser.add_argument("--envs", type=int, default=4096)
parser.add_argument("--steps", type=int, default=2000)
args = parser.parse_args()
track = load_track()
state = reset_batch(jax.random.PRNGKey(73), args.envs, track["length"])

def rollout(initial):
    def body(index, current):
        phase = current[:, 0] * 0.003 + index * 0.002
        action = jnp.stack((jnp.sin(phase) * 0.18, jnp.full(args.envs, 0.25),
                            jnp.zeros(args.envs), jnp.full(args.envs, 0.45)), axis=-1)
        result = env_step(current, action, track)
        reset = jnp.stack((jnp.mod(result.state[:, 0], track["length"]), jnp.zeros(args.envs),
                           jnp.zeros(args.envs), jnp.full(args.envs, 28.0), jnp.zeros(args.envs),
                           jnp.zeros(args.envs), jnp.zeros(args.envs), jnp.full(args.envs, 0.74)), axis=-1)
        return jnp.where(result.done[:, None], reset, result.state)
    return jax.lax.fori_loop(0, args.steps, body, initial)

compiled = jax.jit(rollout)
compiled(state).block_until_ready()
start = time.perf_counter()
result = compiled(state)
result.block_until_ready()
elapsed = time.perf_counter() - start
total = args.envs * args.steps
print(json.dumps({"device": str(jax.devices()[0]), "environments": args.envs, "stepsPerEnvironment": args.steps,
                  "totalSteps": total, "seconds": elapsed, "stepsPerSecond": total / elapsed,
                  "estimated50MSeconds": 50_000_000 / (total / elapsed)}, indent=2))
