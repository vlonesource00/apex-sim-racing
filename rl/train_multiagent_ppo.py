from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import jax
import jax.numpy as jnp

from jax_multiagent import MULTI_OBSERVATION_SIZE, load_track, multi_env_step, observe_multi, reset_multi_batch
from train_ppo import (
    adam_init,
    adam_step,
    calculate_gae,
    export_policy,
    gaussian_log_probability,
    init_parameters,
    policy_value,
    ppo_loss,
)


def collect_rollout(parameters, initial_state, key, track, horizon: int):
    environment_count = initial_state.shape[0]

    def rollout_step(carry, _):
        state, random_key = carry
        sample_key, reset_key, next_key = jax.random.split(random_key, 3)
        observation = observe_multi(state, track)
        mean, value = policy_value(parameters, observation)
        noise = jax.random.normal(sample_key, mean.shape)
        raw_action = mean + jnp.exp(parameters["log_std"]) * noise
        action = jnp.tanh(raw_action)
        log_probability = gaussian_log_probability(mean, parameters["log_std"], raw_action)
        result = multi_env_step(state, action, track)
        reset_state = reset_multi_batch(reset_key, environment_count, track["length"])
        next_state = jnp.where(result.done[:, None], reset_state, result.state)
        transition = (observation, raw_action, log_probability, value, result.reward, result.done, result.metrics)
        return (next_state, next_key), transition

    return jax.lax.scan(rollout_step, (initial_state, key), None, length=horizon)


def main():
    parser = argparse.ArgumentParser(description="Train a traffic-aware clean-overtaking tactical policy.")
    parser.add_argument("--envs", type=int, default=1024)
    parser.add_argument("--horizon", type=int, default=128)
    parser.add_argument("--updates", type=int, default=192)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--seed", type=int, default=173)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "policies" / "stage2_multiagent_policy.json")
    args = parser.parse_args()

    track = load_track()
    key = jax.random.PRNGKey(args.seed)
    parameter_key, reset_key, rollout_key = jax.random.split(key, 3)
    parameters = init_parameters(parameter_key, MULTI_OBSERVATION_SIZE)
    optimizer = adam_init(parameters)
    state = reset_multi_batch(reset_key, args.envs, track["length"])

    collect = jax.jit(lambda params, current, rng: collect_rollout(params, current, rng, track, args.horizon))

    @jax.jit
    def optimize(params, optimizer_state, batch):
        (loss, details), gradients = jax.value_and_grad(ppo_loss, has_aux=True)(params, batch)
        params, optimizer_state, gradient_norm = adam_step(params, optimizer_state, gradients)
        return params, optimizer_state, loss, details, gradient_norm

    started = time.perf_counter()
    history = []
    for update in range(1, args.updates + 1):
        rollout_key, sample_key = jax.random.split(rollout_key)
        (state, _), transitions = collect(parameters, state, sample_key)
        observations, raw_actions, old_log_probabilities, values, rewards, dones, metrics = transitions
        final_value = policy_value(parameters, observe_multi(state, track))[1]
        advantages, returns = calculate_gae(rewards, dones, values, final_value)
        advantages = (advantages - jnp.mean(advantages)) / (jnp.std(advantages) + 1e-8)
        flatten = lambda value: value.reshape((-1,) + value.shape[2:])
        batch = (flatten(observations), flatten(raw_actions), flatten(old_log_probabilities),
                 flatten(advantages), flatten(returns))
        for _ in range(args.epochs):
            parameters, optimizer, loss, details, gradient_norm = optimize(parameters, optimizer, batch)

        if update == 1 or update % 8 == 0 or update == args.updates:
            mean_metrics = jnp.mean(metrics, axis=(0, 1))
            record = {
                "update": update,
                "reward": float(jnp.mean(rewards)),
                "cleanPassEventRate": float(mean_metrics[0]),
                "contactIncidentRate": float(mean_metrics[1]),
                "forcedOpponentOffRate": float(mean_metrics[4]),
                "durableClearRate": float(mean_metrics[5]),
                "loss": float(loss),
                "gradientNorm": float(gradient_norm),
            }
            history.append(record)
            print(json.dumps(record), flush=True)

    jax.block_until_ready(parameters)
    elapsed = time.perf_counter() - started
    total_steps = args.envs * args.horizon * args.updates
    metadata = {
        "stage": "stage2-multi-agent-clean-overtaking",
        "seed": args.seed,
        "environmentCount": args.envs,
        "horizon": args.horizon,
        "updates": args.updates,
        "trainingSteps": total_steps,
        "stepsPerSecond": round(total_steps / max(elapsed, 1e-6)),
        "observationSchema": [
            "ego-lateral", "ego-heading-error", "ego-speed", "ego-yaw-rate", "ego-body-slip",
            "ego-tire-utilization", "ego-ers-soc", "curvature-x6", "target-speed-x6",
            "opponent-gap", "opponent-lateral", "relative-speed", "closing-speed", "ttc",
            "lateral-clearance", "opponent-ahead", "side-by-side"
        ],
        "cleanPassRule": "opponent more than 5m behind, no contact, both cars remain racing",
        "rewardRules": ["durable position gain", "relative progress", "no contact", "no forced-off rival"],
        "finalTrainingMetrics": history[-1] if history else {},
    }
    export_policy(parameters, args.output, MULTI_OBSERVATION_SIZE, metadata)
    print(json.dumps({"policy": str(args.output), "device": str(jax.devices()[0]), **metadata}, indent=2))


if __name__ == "__main__":
    main()
