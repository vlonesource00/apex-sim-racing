from __future__ import annotations

import argparse
from collections import deque
import json
import math
import time
from pathlib import Path

import jax
import jax.numpy as jnp

from jax_stage5 import (ACTION_SIZE, FOLLOW, MANEUVER_COUNT, PACK_CARS, STAGE5_OBSERVATION_SIZE,
                        Stage5State, load_track, observe_stage5, reset_done, reset_stage5_batch,
                        stage5_env_step)
from train_ppo import adam_init, adam_step, calculate_gae

HIDDEN = 64


def dense(key, output_size, input_size, scale=1.0):
    limit = scale * math.sqrt(6.0 / (input_size + output_size))
    return {"weight": jax.random.uniform(key, (output_size, input_size), minval=-limit, maxval=limit),
            "bias": jnp.zeros((output_size,))}


def init_parameters(key):
    keys = jax.random.split(key, 9)
    return {
        "encoder": dense(keys[0], HIDDEN, STAGE5_OBSERVATION_SIZE),
        "gru": {
            "wz": dense(keys[1], HIDDEN, HIDDEN), "uz": dense(keys[2], HIDDEN, HIDDEN),
            "wr": dense(keys[3], HIDDEN, HIDDEN), "ur": dense(keys[4], HIDDEN, HIDDEN),
            "wh": dense(keys[5], HIDDEN, HIDDEN), "uh": dense(keys[6], HIDDEN, HIDDEN),
        },
        "actor": dense(keys[7], ACTION_SIZE, HIDDEN, 0.12),
        "critic": dense(keys[8], 1, HIDDEN, 1.0),
        "log_std": jnp.full((4,), -1.15)
    }


def apply_dense(layer, values):
    return jnp.einsum("...i,oi->...o", values, layer["weight"]) + layer["bias"]


def gru_step(parameters, observation, hidden):
    encoded = jnp.tanh(apply_dense(parameters["encoder"], observation))
    gru = parameters["gru"]
    z = jax.nn.sigmoid(apply_dense(gru["wz"], encoded) + apply_dense(gru["uz"], hidden))
    r = jax.nn.sigmoid(apply_dense(gru["wr"], encoded) + apply_dense(gru["ur"], hidden))
    candidate = jnp.tanh(apply_dense(gru["wh"], encoded) + apply_dense(gru["uh"], r * hidden))
    return (1.0 - z) * hidden + z * candidate


def policy_value(parameters, observation, hidden):
    next_hidden = gru_step(parameters, observation, hidden)
    output = apply_dense(parameters["actor"], next_hidden)
    return output[..., :MANEUVER_COUNT], output[..., MANEUVER_COUNT:], apply_dense(
        parameters["critic"], next_hidden)[..., 0], next_hidden


def log_probability(logits, mean, log_std, maneuver, raw_continuous):
    categorical = jax.nn.log_softmax(logits)
    selected = jnp.take_along_axis(categorical, maneuver[..., None], axis=-1)[..., 0]
    inverse_variance = jnp.exp(-2.0 * log_std)
    gaussian = jnp.sum(-0.5 * ((raw_continuous - mean) ** 2 * inverse_variance
                               + 2.0 * log_std + math.log(2.0 * math.pi)), axis=-1)
    return selected + gaussian


def heuristic_actions(state, target_bias=0.0):
    cars = state.cars
    progress = cars[..., 0]
    gap = progress[:, None, :] - progress[:, :, None]
    diagonal = jnp.eye(cars.shape[1], dtype=bool)[None, ...]
    ahead = (gap > 0) & (gap < 38) & ~diagonal
    nearest = jnp.argmin(jnp.where(ahead, gap, jnp.inf), axis=-1)
    present = jnp.any(ahead, axis=-1)
    target_lateral = jnp.take_along_axis(jnp.broadcast_to(cars[:, None, :, 1], gap.shape), nearest[..., None], axis=-1)[..., 0]
    left_room = target_lateral > -0.4
    attack = jnp.where(left_room, 2, 3)
    maneuver = jnp.where(present, attack, 0)
    logits = jax.nn.one_hot(maneuver, MANEUVER_COUNT) * 2.0 - 1.0
    corridor = jnp.where(maneuver == 2, -0.72, jnp.where(maneuver == 3, 0.72, 0.0)) + target_bias
    continuous = jnp.stack((jnp.clip(corridor, -1, 1), jnp.where(present, 0.62, 0.18),
                            jnp.where(state.class_id == 0, 0.75, -1.0), jnp.full_like(corridor, 0.15)), axis=-1)
    return jnp.concatenate((logits, continuous), axis=-1)


def league_actions(state):
    """Deterministic opponent pool: attacker, blocker, early braker, erratic veteran."""
    attacker = heuristic_actions(state)
    shape = state.cars.shape[:2]
    variant = (state.scenario_id[:, None] + jnp.arange(PACK_CARS)[None, :]) % 4
    blocker_maneuver = jnp.where(state.cars[..., 1] >= 0, 6, 7)
    blocker = jnp.concatenate((jax.nn.one_hot(blocker_maneuver, MANEUVER_COUNT) * 2 - 1,
                               jnp.stack((-jnp.sign(state.cars[..., 1]) * 0.58,
                                          jnp.full(shape, 0.1), jnp.full(shape, -1.0),
                                          jnp.full(shape, 0.45)), axis=-1)), axis=-1)
    early = jnp.concatenate((jax.nn.one_hot(jnp.zeros(shape, dtype=jnp.int32), MANEUVER_COUNT) * 2 - 1,
                             jnp.stack((jnp.zeros(shape), jnp.full(shape, -0.62),
                                        jnp.full(shape, -1.0), jnp.full(shape, -0.4)), axis=-1)), axis=-1)
    erratic_maneuver = jnp.where(((jnp.floor(state.cars[..., 0] / 45).astype(jnp.int32)
                                   + jnp.arange(PACK_CARS)[None, :]) % 2) == 0, 2, 3)
    erratic = jnp.concatenate((jax.nn.one_hot(erratic_maneuver, MANEUVER_COUNT) * 2 - 1,
                               jnp.stack((jnp.where(erratic_maneuver == 2, -0.7, 0.7),
                                          jnp.full(shape, 0.42), jnp.full(shape, -0.4),
                                          jnp.full(shape, -0.1)), axis=-1)), axis=-1)
    return jnp.where((variant == 1)[..., None], blocker,
                     jnp.where((variant == 2)[..., None], early,
                               jnp.where((variant == 3)[..., None], erratic, attacker)))


def collect_rollout(parameters, league_parameters, initial_state, initial_hidden,
                    initial_league_hidden, key, track, horizon, difficulty):
    environment_count = initial_state.cars.shape[0]
    live_mask = (jnp.arange(PACK_CARS) % 2 == 0)[None, :]

    def step(carry, _):
        state, hidden, league_hidden, random_key = carry
        maneuver_key, continuous_key, reset_key, next_key = jax.random.split(random_key, 4)
        observation = observe_stage5(state, track)
        logits, mean, value, next_hidden = policy_value(parameters, observation, hidden)
        league_logits, league_mean, _, next_league_hidden = policy_value(
            league_parameters, observation, league_hidden)
        maneuver = jax.random.categorical(maneuver_key, logits)
        raw_continuous = mean + jnp.exp(parameters["log_std"]) * jax.random.normal(continuous_key, mean.shape)
        policy_action = jnp.concatenate((jax.nn.one_hot(maneuver, MANEUVER_COUNT) * 2.0 - 1.0,
                                         jnp.tanh(raw_continuous)), axis=-1)
        # Half the field is deliberately non-live league opposition.  This
        # prevents cooperative identical-policy blind spots from update one.
        historical_action = jnp.concatenate((jax.nn.one_hot(jnp.argmax(league_logits, axis=-1), MANEUVER_COUNT) * 2 - 1,
                                              jnp.tanh(league_mean)), axis=-1)
        scripted_action = league_actions(state)
        historical_mask = (jnp.arange(PACK_CARS) == 1)[None, :, None]
        opponent_action = jnp.where(historical_mask, historical_action, scripted_action)
        deployed_action = jnp.where(live_mask[..., None], policy_action, opponent_action)
        result = stage5_env_step(state, deployed_action, track)
        fresh = reset_stage5_batch(reset_key, environment_count, track, difficulty)
        next_state = reset_done(result.state, fresh, result.done)
        next_hidden = jnp.where(result.done[:, None, None], 0.0, next_hidden)
        next_league_hidden = jnp.where(result.done[:, None, None], 0.0, next_league_hidden)
        done_agents = jnp.broadcast_to(result.done[:, None], result.reward.shape)
        training_mask = jnp.broadcast_to(live_mask, result.reward.shape)
        transition = (observation, hidden, maneuver, raw_continuous,
                      log_probability(logits, mean, parameters["log_std"], maneuver, raw_continuous),
                      value, result.reward, done_agents, training_mask, result.metrics)
        return (next_state, next_hidden, next_league_hidden, next_key), transition

    return jax.lax.scan(step, (initial_state, initial_hidden, initial_league_hidden, key), None, length=horizon)


def ppo_loss(parameters, batch, clip_ratio=0.2, value_weight=0.5, entropy_weight=0.02):
    observation, hidden, maneuver, raw_continuous, old_log_probability, advantage, returns, mask = batch
    logits, mean, value, _ = policy_value(parameters, observation, hidden)
    current_log_probability = log_probability(logits, mean, parameters["log_std"], maneuver, raw_continuous)
    ratio = jnp.exp(current_log_probability - old_log_probability)
    policy = -jnp.minimum(ratio * advantage, jnp.clip(ratio, 1 - clip_ratio, 1 + clip_ratio) * advantage)
    value_loss = (value - returns) ** 2
    categorical_entropy = -jnp.sum(jax.nn.softmax(logits) * jax.nn.log_softmax(logits), axis=-1)
    gaussian_entropy = jnp.sum(parameters["log_std"] + 0.5 * math.log(2 * math.pi * math.e))
    weight = mask.astype(value.dtype)
    denominator = jnp.maximum(1.0, jnp.sum(weight))
    total = jnp.sum(weight * (policy + value_weight * value_loss
                              - entropy_weight * (categorical_entropy + gaussian_entropy))) / denominator
    return total, (jnp.sum(weight * policy) / denominator,
                   jnp.sum(weight * value_loss) / denominator,
                   jnp.sum(weight * categorical_entropy) / denominator)


def behavior_cloning_loss(parameters, observation, maneuver, target_continuous):
    hidden = jnp.zeros((observation.shape[0], HIDDEN), dtype=observation.dtype)
    logits, mean, _, _ = policy_value(parameters, observation, hidden)
    # A solo human lap contains no evidence for FOLLOW versus ATTACK/DEFEND.
    # Training every frame as FOLLOW created a severe cowardice prior.  BC is
    # therefore limited to pace-line/ERS outputs; PPO owns manoeuvre choice.
    classification = jnp.asarray(0.0, dtype=observation.dtype)
    continuous = jnp.mean((jnp.tanh(mean) - target_continuous) ** 2)
    return classification + continuous * 2.5, (classification, continuous)


def load_behavior_cloning_reference(reference_path: Path, track):
    """Convert a recorded human lap into deployed Stage 5 observations/targets.

    Speed, throttle and braking are already distilled into the deterministic
    reference envelope.  BC teaches the tactical network to preserve the human
    line and deployment schedule when traffic is absent; PPO then learns only
    the deviations needed for racecraft.
    """
    payload = json.loads(reference_path.read_text(encoding="utf-8"))
    samples = payload.get("samples", [])
    if not payload.get("complete") or len(samples) < 32:
        raise ValueError(f"Behavior-cloning reference must be a complete lap: {reference_path}")
    progress = jnp.asarray([sample["s"] for sample in samples], dtype=jnp.float32)
    lateral = jnp.asarray([sample.get("lateral", 0.0) for sample in samples], dtype=jnp.float32)
    speed = jnp.asarray([sample.get("speed", 0.0) for sample in samples], dtype=jnp.float32)
    yaw_rate = jnp.asarray([sample.get("yawRate", 0.0) for sample in samples], dtype=jnp.float32)
    body_slip = jnp.asarray([math.radians(sample.get("bodySlip", 0.0)) for sample in samples], dtype=jnp.float32)
    utilization = jnp.asarray([sample.get("tyreUtilisation", 0.0) for sample in samples], dtype=jnp.float32)
    soc = jnp.asarray([sample.get("ersSoc", 0.0) for sample in samples], dtype=jnp.float32)
    wear = jnp.asarray([sample.get("tyreWear", 0.0) for sample in samples], dtype=jnp.float32)
    temperature = jnp.asarray([sample.get("tyreTempC", 94.0) for sample in samples], dtype=jnp.float32)
    count = len(samples)
    offsets = jnp.asarray([0.0, track["length"] * 0.25, track["length"] * 0.5,
                           track["length"] * 0.75], dtype=jnp.float32)
    car_progress = progress[:, None] + offsets[None, :]
    cars = jnp.zeros((count, PACK_CARS, 8), dtype=jnp.float32)
    cars = cars.at[..., 0].set(car_progress)
    cars = cars.at[..., 3].set(speed[:, None])
    cars = cars.at[..., 7].set(soc[:, None])
    cars = cars.at[:, 0, 1].set(lateral)
    cars = cars.at[:, 0, 4].set(yaw_rate)
    cars = cars.at[:, 0, 5].set(body_slip)
    cars = cars.at[:, 0, 6].set(utilization)
    class_id = jnp.zeros((count, PACK_CARS), dtype=jnp.int32)
    physical = jnp.broadcast_to(jnp.asarray([925.0, 1.92, 4.505, 10.4, 24.0, 11.5]),
                                (count, PACK_CARS, 6))
    tires = jnp.broadcast_to(wear[:, None], (count, PACK_CARS))
    temperatures = jnp.broadcast_to(temperature[:, None], (count, PACK_CARS))
    zeros = jnp.zeros((count, PACK_CARS), dtype=jnp.float32)
    pair_shape = (count, PACK_CARS, PACK_CARS)
    diagonal = jnp.eye(PACK_CARS, dtype=bool)[None, ...]
    state = Stage5State(cars, class_id, physical, tires, temperatures,
                        jnp.full((count, PACK_CARS), FOLLOW, dtype=jnp.int32),
                        jnp.zeros((count, PACK_CARS), dtype=jnp.int32), cars[..., 1], zeros, zeros,
                        zeros, zeros, jnp.where(diagonal, -1.0, jnp.zeros(pair_shape)),
                        jnp.zeros(pair_shape, dtype=bool), jnp.zeros(pair_shape, dtype=bool),
                        jnp.zeros((count,), dtype=jnp.int32))
    observation = observe_stage5(state, track)[:, 0]
    track_index = jnp.floor(jnp.mod(progress, track["length"]) / track["length"]
                            * track["reference_ers"].shape[0]).astype(jnp.int32)
    ers_target = track["reference_ers"][track_index]
    target_continuous = jnp.stack((jnp.clip(lateral / 5.45, -0.98, 0.98),
                                   jnp.zeros_like(lateral),
                                   jnp.clip(ers_target * 2.0 - 1.0, -0.98, 0.98),
                                   jnp.full_like(lateral, -0.95)), axis=-1)
    return observation, jnp.full((count,), FOLLOW, dtype=jnp.int32), target_continuous


def serializable(tree):
    return jax.tree.map(lambda value: jax.device_get(value).tolist(), tree)


def load_exported_parameters(path: Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("format") != "apex73-stage5-gru-policy-v1":
        raise ValueError(f"Not a Stage 5 recurrent policy: {path}")
    def arrays(value):
        return {key: arrays(item) for key, item in value.items()} if isinstance(value, dict) else jnp.asarray(value)
    return arrays(payload["parameters"])


def export_policy(parameters, destination, metadata):
    payload = {"format": "apex73-stage5-gru-policy-v1", "observationSize": STAGE5_OBSERVATION_SIZE,
               "actionSize": ACTION_SIZE, "maneuvers": list(CONFIG_MANEUVERS), "gruUnits": HIDDEN,
               "parameters": serializable(parameters), "metadata": metadata}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, separators=(",", ":")))


CONFIG_MANEUVERS = tuple(json.loads((Path(__file__).parent / "stage5_config.json").read_text())["maneuvers"])


def main():
    parser = argparse.ArgumentParser(description="Train Stage 5 recurrent tactics through the deployed planner/controller contract.")
    parser.add_argument("--envs", type=int, default=1024, help="1024 packs = 4096 cars in VRAM")
    parser.add_argument("--horizon", type=int, default=128)
    parser.add_argument("--updates", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--seed", type=int, default=505)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--bc-epochs", type=int, default=80,
                        help="Supervised human-lap warm start epochs; only runs with --reference")
    parser.add_argument("--league-pool-size", type=int, default=8)
    parser.add_argument("--reference", type=Path,
                        help="Human lap used as the solo target-speed/ERS curriculum before traffic deviations.")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "policies" / "stage5_candidate_policy.json")
    parser.add_argument("--warm-start", type=Path, help="Continue from an exported Stage 5 policy.")
    args = parser.parse_args()
    track = load_track(reference_path=args.reference)
    parameter_key, reset_key, rollout_key = jax.random.split(jax.random.PRNGKey(args.seed), 3)
    parameters = load_exported_parameters(args.warm_start) if args.warm_start else init_parameters(parameter_key)
    optimizer = adam_init(parameters)
    league_parameters = jax.tree.map(jnp.array, parameters)
    historical_pool = deque([league_parameters], maxlen=max(2, args.league_pool_size))
    state = reset_stage5_batch(reset_key, args.envs, track)
    hidden = jnp.zeros((args.envs, PACK_CARS, HIDDEN), dtype=jnp.float32)
    league_hidden = jnp.zeros_like(hidden)
    collect = jax.jit(lambda params, old_params, current, memory, old_memory, rng, difficulty: collect_rollout(
        params, old_params, current, memory, old_memory, rng, track, args.horizon, difficulty))

    @jax.jit
    def optimize(params, optimizer_state, batch):
        (loss, details), gradients = jax.value_and_grad(ppo_loss, has_aux=True)(params, batch)
        params, optimizer_state, gradient_norm = adam_step(params, optimizer_state, gradients,
                                                           learning_rate=args.learning_rate)
        return params, optimizer_state, loss, details, gradient_norm

    @jax.jit
    def clone_human(params, optimizer_state, observation, maneuver, continuous):
        (loss, details), gradients = jax.value_and_grad(behavior_cloning_loss, has_aux=True)(
            params, observation, maneuver, continuous)
        params, optimizer_state, gradient_norm = adam_step(
            params, optimizer_state, gradients, learning_rate=args.learning_rate)
        return params, optimizer_state, loss, details, gradient_norm

    cloning_record = None
    if args.reference and args.bc_epochs > 0:
        bc_observation, bc_maneuver, bc_continuous = load_behavior_cloning_reference(args.reference, track)
        for _ in range(args.bc_epochs):
            parameters, optimizer, bc_loss, bc_details, bc_gradient_norm = clone_human(
                parameters, optimizer, bc_observation, bc_maneuver, bc_continuous)
        jax.block_until_ready(parameters)
        cloning_record = {"samples": int(bc_observation.shape[0]), "epochs": args.bc_epochs,
                          "loss": float(bc_loss), "maneuverLoss": float(bc_details[0]),
                          "continuousLoss": float(bc_details[1]),
                          "gradientNorm": float(bc_gradient_norm)}
        historical_pool.clear()
        historical_pool.append(jax.tree.map(jnp.array, parameters))
        league_parameters = historical_pool[0]
        print(json.dumps({"behaviorCloning": cloning_record}), flush=True)

    started = time.perf_counter()
    warmup_finished = None
    history = []
    for update in range(1, args.updates + 1):
        rollout_key, sample_key = jax.random.split(rollout_key)
        difficulty = jnp.asarray(min(1.0, 0.18 + 0.82 * update / max(1, args.updates * 0.62)), dtype=jnp.float32)
        (state, hidden, league_hidden, _), transitions = collect(
            parameters, league_parameters, state, hidden, league_hidden, sample_key, difficulty)
        observations, memories, maneuvers, raw_continuous, old_logp, values, rewards, dones, masks, metrics = transitions
        final_observation = observe_stage5(state, track)
        final_value = policy_value(parameters, final_observation, hidden)[2]
        advantages, returns = calculate_gae(rewards, dones, values, final_value)
        valid_advantages = jnp.where(masks, advantages, jnp.nan)
        mean_advantage = jnp.nanmean(valid_advantages)
        std_advantage = jnp.nanstd(valid_advantages) + 1e-8
        advantages = (advantages - mean_advantage) / std_advantage
        flatten = lambda value: value.reshape((-1,) + value.shape[3:])
        batch = (flatten(observations), flatten(memories), flatten(maneuvers), flatten(raw_continuous),
                 flatten(old_logp), flatten(advantages), flatten(returns), flatten(masks))
        for _ in range(args.epochs):
            parameters, optimizer, loss, details, gradient_norm = optimize(parameters, optimizer, batch)
        if update % 32 == 0:
            historical_pool.append(jax.tree.map(jnp.array, parameters))
            league_parameters = historical_pool[(update // 32) % len(historical_pool)]
            league_hidden = jnp.zeros_like(league_hidden)
        elif len(historical_pool) > 1 and update % 8 == 0:
            league_parameters = historical_pool[(update // 8) % len(historical_pool)]
        if update == 1 or update % 8 == 0 or update == args.updates:
            mean_metrics = jnp.mean(metrics, axis=(0, 1))
            record = {"update": update, "reward": float(jnp.mean(rewards)),
                      "cleanPassRate": float(mean_metrics[0]), "contactRate": float(mean_metrics[1]),
                      "deepContactRate": float(mean_metrics[2]), "forcedOffRate": float(mean_metrics[3]),
                      "wastedOpportunityRate": float(mean_metrics[4]), "overlapRate": float(mean_metrics[5]),
                      "curriculumDifficulty": float(difficulty),
                      "loss": float(loss), "gradientNorm": float(gradient_norm)}
            history.append(record)
            print(json.dumps(record), flush=True)
        if update == 1:
            jax.block_until_ready(parameters)
            warmup_finished = time.perf_counter()
    jax.block_until_ready(parameters)
    elapsed = time.perf_counter() - started
    warmup_seconds = (warmup_finished - started) if warmup_finished else elapsed
    steady_seconds = max(1e-6, elapsed - warmup_seconds)
    transitions = args.envs * PACK_CARS * args.horizon * args.updates
    steady_transitions = args.envs * PACK_CARS * args.horizon * max(0, args.updates - 1)
    metadata = {"stage": "stage5-recurrent-browser-stack-candidate", "seed": args.seed,
                "device": str(jax.devices()[0]), "environmentCount": args.envs,
                "parallelCars": args.envs * PACK_CARS, "agentTransitions": transitions,
                "agentTransitionsPerSecond": round(transitions / max(elapsed, 1e-6)),
                "compilationAndWarmupSeconds": round(warmup_seconds, 3),
                "steadyStateAgentTransitionsPerSecond": round(steady_transitions / steady_seconds),
                "scenarioCurriculum": json.loads((Path(__file__).parent / "stage5_config.json").read_text())["curriculum"],
                "humanReference": str(args.reference) if args.reference else None,
                "warmStart": str(args.warm_start) if args.warm_start else None,
                "behaviorCloning": cloning_record,
                "opponentLeague": [f"rotating pool of up to {args.league_pool_size} historical checkpoints",
                                     "deterministic-attacker", "aggressive-blocker", "early-braker", "erratic-veteran"],
                "finalTrainingMetrics": history[-1] if history else {}}
    export_policy(parameters, args.output, metadata)
    print(json.dumps({"policy": str(args.output), **metadata}, indent=2))


if __name__ == "__main__":
    main()
