from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import jax
import jax.numpy as jnp

from evaluate_policy import load_actor
from jax_pack import PACK_CARS, PACK_OBSERVATION_SIZE, load_track, observe_pack, pack_env_step, reset_done, reset_pack_batch
from train_ppo import adam_init, adam_step, calculate_gae, export_policy, gaussian_log_probability, init_parameters, policy_value, ppo_loss


def collect_rollout(parameters, initial_state, key, track, horizon: int):
    environment_count = initial_state.cars.shape[0]

    def rollout_step(carry, _):
        state, random_key = carry
        sample_key, reset_key, next_key = jax.random.split(random_key, 3)
        observation = observe_pack(state, track)
        mean, value = policy_value(parameters, observation)
        raw_action = mean + jnp.exp(parameters["log_std"]) * jax.random.normal(sample_key, mean.shape)
        action = jnp.tanh(raw_action)
        result = pack_env_step(state, action, track)
        reset = reset_pack_batch(reset_key, environment_count, track)
        next_state = reset_done(result.state, reset, result.done)
        done_agents = jnp.broadcast_to(result.done[:, None], result.reward.shape)
        transition = (observation, raw_action, gaussian_log_probability(mean, parameters["log_std"], raw_action),
                      value, result.reward, done_agents, result.metrics)
        return (next_state, next_key), transition

    return jax.lax.scan(rollout_step, (initial_state, key), None, length=horizon)


def main():
    parser = argparse.ArgumentParser(description="Train a parameter-shared four-car pack-racing policy.")
    parser.add_argument("--envs", type=int, default=1024,
                        help="Parallel four-car packs (1024 packs = 4096 cars).")
    parser.add_argument("--horizon", type=int, default=128)
    parser.add_argument("--updates", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--seed", type=int, default=307)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--log-std", type=float, default=-1.25)
    parser.add_argument("--init-policy", type=Path,
                        help="Warm-start the actor from an existing browser policy; the critic is retrained.")
    parser.add_argument("--reference", type=Path,
                        help="Use a completed human reference lap as the target-speed profile.")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "policies" / "stage4_reference_pack_policy.json")
    args = parser.parse_args()
    track = load_track(reference_path=args.reference)
    parameter_key, reset_key, rollout_key = jax.random.split(jax.random.PRNGKey(args.seed), 3)
    parameters = init_parameters(parameter_key, PACK_OBSERVATION_SIZE)
    if args.init_policy is not None:
        actor, payload = load_actor(args.init_policy)
        if payload.get("observationSize") != PACK_OBSERVATION_SIZE:
            raise ValueError(f"Expected {PACK_OBSERVATION_SIZE} observations in {args.init_policy}")
        parameters = {**parameters, "actor": actor, "log_std": jnp.full((4,), args.log_std)}
    optimizer = adam_init(parameters)
    state = reset_pack_batch(reset_key, args.envs, track)
    collect = jax.jit(lambda params, current, rng: collect_rollout(params, current, rng, track, args.horizon))

    @jax.jit
    def optimize(params, optimizer_state, batch):
        (loss, details), gradients = jax.value_and_grad(ppo_loss, has_aux=True)(params, batch)
        params, optimizer_state, gradient_norm = adam_step(
            params, optimizer_state, gradients, learning_rate=args.learning_rate)
        return params, optimizer_state, loss, details, gradient_norm

    started = time.perf_counter()
    history = []
    for update in range(1, args.updates + 1):
        rollout_key, sample_key = jax.random.split(rollout_key)
        (state, _), transitions = collect(parameters, state, sample_key)
        observations, raw_actions, old_log_probabilities, values, rewards, dones, metrics = transitions
        final_value = policy_value(parameters, observe_pack(state, track))[1]
        advantages, returns = calculate_gae(rewards, dones, values, final_value)
        advantages = (advantages - jnp.mean(advantages)) / (jnp.std(advantages) + 1e-8)
        flatten = lambda value: value.reshape((-1,) + value.shape[3:])
        batch = (flatten(observations), flatten(raw_actions), flatten(old_log_probabilities),
                 flatten(advantages), flatten(returns))
        for _ in range(args.epochs):
            parameters, optimizer, loss, details, gradient_norm = optimize(parameters, optimizer, batch)
        if update == 1 or update % 8 == 0 or update == args.updates:
            mean_metrics = jnp.mean(metrics, axis=(0, 1))
            record = {"update": update, "reward": float(jnp.mean(rewards)),
                      "cleanPassRate": float(mean_metrics[0]), "contactIncidentRate": float(mean_metrics[1]),
                      "deepContactRate": float(mean_metrics[2]), "offRate": float(mean_metrics[3]),
                      "forcedOffRate": float(mean_metrics[4]), "loss": float(loss),
                      "gradientNorm": float(gradient_norm)}
            history.append(record)
            print(json.dumps(record), flush=True)

    jax.block_until_ready(parameters)
    elapsed = time.perf_counter() - started
    agent_steps = args.envs * PACK_CARS * args.horizon * args.updates
    stage = ("stage4-human-reference-pack-finetune" if args.init_policy and args.reference
             else "stage4-browser-aligned-pack-finetune" if args.init_policy
             else "stage3-parameter-shared-pack-self-play")
    metadata = {"stage": stage,
                "seed": args.seed,
                "environmentCount": args.envs, "carsPerEnvironment": PACK_CARS,
                "parallelCars": args.envs * PACK_CARS, "horizon": args.horizon,
                "updates": args.updates, "agentTransitions": agent_steps,
                "agentTransitionsPerSecond": round(agent_steps / max(elapsed, 1e-6)),
                "learningRate": args.learning_rate, "explorationLogStd": args.log_std,
                "initialPolicy": str(args.init_policy) if args.init_policy else None,
                "referenceLap": str(args.reference) if args.reference else None,
                "trafficSlots": ["nearest-ahead", "nearest-side", "nearest-behind"],
                "cleanPassRule": "shared-policy crossover plus 5m clearance held for 1s without contact",
                "finalTrainingMetrics": history[-1] if history else {}}
    export_policy(parameters, args.output, PACK_OBSERVATION_SIZE, metadata)
    print(json.dumps({"policy": str(args.output), "device": str(jax.devices()[0]), **metadata}, indent=2))


if __name__ == "__main__":
    main()
