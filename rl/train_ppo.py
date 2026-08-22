from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import jax
import jax.numpy as jnp
import numpy as np

from jax_vehicle import env_step, load_track, observe, reset_batch


def init_layer(key, inputs: int, outputs: int, scale: float = math.sqrt(2.0)):
    weight = jax.random.normal(key, (inputs, outputs)) * (scale / math.sqrt(inputs))
    return {"weight": weight, "bias": jnp.zeros((outputs,))}


def init_network(key, sizes: list[int], output_scale: float = 1.0):
    keys = jax.random.split(key, len(sizes) - 1)
    layers = []
    for index, (inputs, outputs) in enumerate(zip(sizes[:-1], sizes[1:], strict=True)):
        scale = output_scale if index == len(sizes) - 2 else math.sqrt(2.0)
        layers.append(init_layer(keys[index], inputs, outputs, scale))
    return tuple(layers)


def apply_network(layers, values):
    for index, layer in enumerate(layers):
        values = values @ layer["weight"] + layer["bias"]
        if index < len(layers) - 1:
            values = jnp.tanh(values)
    return values


def init_parameters(key, observation_size: int):
    actor_key, critic_key = jax.random.split(key)
    return {
        "actor": init_network(actor_key, [observation_size, 64, 64, 4], 0.01),
        "critic": init_network(critic_key, [observation_size, 64, 64, 1], 1.0),
        "log_std": jnp.full((4,), -1.1)
    }


def gaussian_log_probability(mean, log_std, raw_action):
    inverse_variance = jnp.exp(-2.0 * log_std)
    return jnp.sum(-0.5 * ((raw_action - mean) ** 2 * inverse_variance + 2.0 * log_std + math.log(2.0 * math.pi)), axis=-1)


def policy_value(parameters, observation):
    mean = apply_network(parameters["actor"], observation)
    value = apply_network(parameters["critic"], observation)[..., 0]
    return mean, value


def collect_rollout(parameters, initial_state, key, track, horizon: int):
    environment_count = initial_state.shape[0]

    def rollout_step(carry, _):
        state, random_key = carry
        sample_key, reset_key, next_key = jax.random.split(random_key, 3)
        observation = observe(state, track)
        mean, value = policy_value(parameters, observation)
        noise = jax.random.normal(sample_key, mean.shape)
        raw_action = mean + jnp.exp(parameters["log_std"]) * noise
        action = jnp.tanh(raw_action)
        log_probability = gaussian_log_probability(mean, parameters["log_std"], raw_action)
        result = env_step(state, action, track)
        reset_state = reset_batch(reset_key, environment_count, track["length"])
        next_state = jnp.where(result.done[:, None], reset_state, result.state)
        transition = (observation, raw_action, log_probability, value, result.reward, result.done)
        return (next_state, next_key), transition

    return jax.lax.scan(rollout_step, (initial_state, key), None, length=horizon)


def calculate_gae(rewards, dones, values, final_value, gamma=0.995, gae_lambda=0.95):
    def scan_step(carry, transition):
        advantage, next_value = carry
        reward, done, value = transition
        alive = 1.0 - done.astype(value.dtype)
        delta = reward + gamma * alive * next_value - value
        advantage = delta + gamma * gae_lambda * alive * advantage
        return (advantage, value), advantage

    (_, _), advantages = jax.lax.scan(
        scan_step, (jnp.zeros_like(final_value), final_value),
        (rewards[::-1], dones[::-1], values[::-1])
    )
    advantages = advantages[::-1]
    return advantages, advantages + values


def ppo_loss(parameters, batch, clip_ratio=0.2, value_weight=0.1, entropy_weight=0.0005):
    observation, raw_action, old_log_probability, advantage, returns = batch
    mean, value = policy_value(parameters, observation)
    log_probability = gaussian_log_probability(mean, parameters["log_std"], raw_action)
    ratio = jnp.exp(log_probability - old_log_probability)
    clipped_ratio = jnp.clip(ratio, 1.0 - clip_ratio, 1.0 + clip_ratio)
    policy_loss = -jnp.mean(jnp.minimum(ratio * advantage, clipped_ratio * advantage))
    value_loss = 0.5 * jnp.mean((value - returns) ** 2)
    entropy = jnp.sum(parameters["log_std"] + 0.5 * math.log(2.0 * math.pi * math.e))
    total = policy_loss + value_weight * value_loss - entropy_weight * entropy
    return total, (policy_loss, value_loss, entropy)


def adam_init(parameters):
    zeros = jax.tree.map(jnp.zeros_like, parameters)
    return zeros, zeros, jnp.asarray(0, dtype=jnp.int32)


def adam_step(parameters, optimizer, gradients, learning_rate=3e-4, max_gradient_norm=1.0):
    moment, variance, count = optimizer
    gradient_norm = jnp.sqrt(sum(jnp.sum(value * value) for value in jax.tree.leaves(gradients)))
    scale = jnp.minimum(1.0, max_gradient_norm / jnp.maximum(1e-8, gradient_norm))
    gradients = jax.tree.map(lambda value: value * scale, gradients)
    count = count + 1
    moment = jax.tree.map(lambda old, grad: 0.9 * old + 0.1 * grad, moment, gradients)
    variance = jax.tree.map(lambda old, grad: 0.999 * old + 0.001 * grad * grad, variance, gradients)
    moment_hat = jax.tree.map(lambda value: value / (1.0 - 0.9 ** count), moment)
    variance_hat = jax.tree.map(lambda value: value / (1.0 - 0.999 ** count), variance)
    parameters = jax.tree.map(lambda param, m, v: param - learning_rate * m / (jnp.sqrt(v) + 1e-8),
                              parameters, moment_hat, variance_hat)
    return parameters, (moment, variance, count), gradient_norm


def export_policy(parameters, destination: Path, observation_size: int, metadata: dict):
    layers = []
    for layer in parameters["actor"]:
        layers.append({
            "weight": np.round(np.asarray(layer["weight"]).T, 6).tolist(),
            "bias": np.round(np.asarray(layer["bias"]), 6).tolist()
        })
    payload = {"format": "apex73-hybrid-policy-v1", "observationSize": observation_size,
               "actionSize": 4, "actions": ["lineOffset", "pace", "aggression", "ersStrategy"],
               "layers": layers, "metadata": {**metadata, "quantization": "decimal-6"}}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--envs", type=int, default=512)
    parser.add_argument("--horizon", type=int, default=96)
    parser.add_argument("--updates", type=int, default=8)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--seed", type=int, default=73)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "policies" / "stage1_policy.json")
    args = parser.parse_args()
    track = load_track()
    key = jax.random.PRNGKey(args.seed)
    state_key, parameter_key, rollout_key = jax.random.split(key, 3)
    state = reset_batch(state_key, args.envs, track["length"])
    observation_size = int(observe(state[:1], track).shape[-1])
    parameters = init_parameters(parameter_key, observation_size)
    optimizer = adam_init(parameters)

    @jax.jit
    def train_epoch(params, opt, batch):
        (loss, components), gradients = jax.value_and_grad(ppo_loss, has_aux=True)(params, batch)
        params, opt, gradient_norm = adam_step(params, opt, gradients)
        return params, opt, loss, components, gradient_norm

    compiled_rollout = jax.jit(lambda p, s, k: collect_rollout(p, s, k, track, args.horizon))
    compiled_rollout(parameters, state, rollout_key)[0][0].block_until_ready()
    start = time.perf_counter()
    history = []
    total_steps = 0
    for update in range(args.updates):
        rollout_key, sample_key = jax.random.split(rollout_key)
        (state, _), transitions = compiled_rollout(parameters, state, sample_key)
        observations, raw_actions, old_log_probabilities, values, rewards, dones = transitions
        final_value = policy_value(parameters, observe(state, track))[1]
        advantages, returns = calculate_gae(rewards, dones, values, final_value)
        advantages = (advantages - jnp.mean(advantages)) / (jnp.std(advantages) + 1e-8)
        flatten = lambda value: value.reshape((-1,) + value.shape[2:])
        batch = (flatten(observations), flatten(raw_actions), old_log_probabilities.reshape(-1),
                 advantages.reshape(-1), returns.reshape(-1))
        for _ in range(args.epochs):
            parameters, optimizer, loss, components, gradient_norm = train_epoch(parameters, optimizer, batch)
        loss.block_until_ready()
        total_steps += args.envs * args.horizon
        history.append({"update": update + 1, "rewardMean": float(jnp.mean(rewards)),
                        "doneRate": float(jnp.mean(dones)), "loss": float(loss),
                        "policyLoss": float(components[0]), "valueLoss": float(components[1]),
                        "entropy": float(components[2]), "gradientNorm": float(gradient_norm)})

    elapsed = time.perf_counter() - start
    metadata = {"stage": "single-car-line-and-pace", "seed": args.seed, "environmentSteps": total_steps,
                "trainingSeconds": elapsed, "stepsPerSecond": total_steps / elapsed,
                "device": str(jax.devices()[0]), "finalMetrics": history[-1]}
    export_policy(parameters, args.output, observation_size, metadata)
    print(json.dumps({"policy": str(args.output), "observationSize": observation_size,
                      "environmentSteps": total_steps, "seconds": elapsed,
                      "stepsPerSecond": total_steps / elapsed, "device": str(jax.devices()[0]),
                      "historyCheckpoints": [history[0], history[len(history) // 2], history[-1]]}, indent=2))


if __name__ == "__main__":
    main()
