from __future__ import annotations

import argparse
import json
from pathlib import Path

import jax
import jax.numpy as jnp

from jax_stage5 import (_pairwise, PACK_CARS, load_track, observe_stage5,
                        reset_stage5_batch, stage5_env_step)
from train_stage5_ppo import HIDDEN, heuristic_actions, league_actions, policy_value


def load_policy(path: Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("format") != "apex73-stage5-gru-policy-v1":
        raise ValueError(f"Not a Stage 5 recurrent policy: {path}")
    def arrays(value):
        return {key: arrays(item) for key, item in value.items()} if isinstance(value, dict) else jnp.asarray(value)
    return arrays(payload["parameters"]), payload


def deterministic_policy_action(parameters, observation, hidden):
    logits, mean, _, next_hidden = policy_value(parameters, observation, hidden)
    maneuver = jnp.argmax(logits, axis=-1)
    return jnp.concatenate((jax.nn.one_hot(maneuver, logits.shape[-1]) * 2.0 - 1.0,
                            jnp.tanh(mean)), axis=-1), next_hidden


def make_rollout(track, horizon: int, candidate: bool):
    live_mask = (jnp.arange(PACK_CARS) % 2 == 0)[None, :, None]

    def rollout(parameters, state):
        hidden = jnp.zeros((*state.cars.shape[:2], HIDDEN), dtype=jnp.float32)

        def step(carry, _):
            current, memory = carry
            observation = observe_stage5(current, track)
            if candidate:
                live_action, next_memory = deterministic_policy_action(parameters, observation, memory)
            else:
                live_action, next_memory = heuristic_actions(current), memory
            action = jnp.where(live_mask, live_action, league_actions(current))
            result = stage5_env_step(current, action, track)
            gap, lateral, _ = _pairwise(result.state.cars, track["length"])
            diagonal = jnp.eye(PACK_CARS, dtype=bool)[None, ...]
            live_rows = jnp.asarray([True, False, True, False])[None, :, None]
            live_columns = jnp.swapaxes(live_rows, 1, 2)
            live_involved = live_rows | live_columns
            contact = (jnp.abs(gap) < 4.7) & (jnp.abs(lateral) < 1.9) & ~diagonal
            deep = (jnp.abs(gap) < 3.6) & (jnp.abs(lateral) < 1.45) & ~diagonal
            new_contact = contact & ~current.contact_active
            new_clean = (result.state.pass_timer < 0.0) & (current.pass_timer >= 0.0)
            off = jnp.abs(result.state.cars[..., 1]) > 7.2
            forced = off[:, None, :] & contact & live_involved
            car0_pair = jnp.zeros((1, PACK_CARS, 1), dtype=bool).at[:, 0, :].set(True)
            events = jnp.stack((jnp.any(new_clean & live_rows, axis=(1, 2)),
                                jnp.any(new_contact & live_involved, axis=(1, 2)),
                                jnp.any(deep & live_involved, axis=(1, 2)),
                                jnp.any(forced, axis=(1, 2)),
                                jnp.any(deep & car0_pair, axis=(1, 2)),
                                jnp.any(forced & car0_pair, axis=(1, 2))), axis=-1)
            live = jnp.asarray([1.0, 0.0, 1.0, 0.0])[None, :, None]
            maneuver_count = jnp.sum(jax.nn.one_hot(jnp.argmax(live_action[..., :9], axis=-1), 9) * live, axis=1)
            return (result.state, next_memory), (events, maneuver_count)

        (final_state, _), (events, maneuver_count) = jax.lax.scan(
            step, (state, hidden), None, length=horizon)
        return final_state, jnp.any(events, axis=0), jnp.sum(maneuver_count, axis=(0, 1))

    return jax.jit(rollout)


def make_solo_rollout(track, horizon: int, candidate: bool):
    def rollout(parameters, state):
        hidden = jnp.zeros((*state.cars.shape[:2], HIDDEN), dtype=jnp.float32)
        start = state.cars[..., 0]

        def step(carry, _):
            current, memory = carry
            observation = observe_stage5(current, track)
            if candidate:
                action, next_memory = deterministic_policy_action(parameters, observation, memory)
            else:
                action, next_memory = heuristic_actions(current), memory
            result = stage5_env_step(current, action, track)
            return (result.state, next_memory), None

        (final_state, _), _ = jax.lax.scan(step, (state, hidden), None, length=horizon)
        distance = jnp.maximum(0.0, final_state.cars[..., 0] - start)
        return jnp.mean(distance) / (horizon / 20.0)

    return jax.jit(rollout)


def evaluate(parameters, track, seeds, envs, episodes, horizon, candidate):
    rollout = make_rollout(track, horizon, candidate)
    solo_rollout = make_solo_rollout(track, max(256, horizon), candidate)
    totals = jnp.zeros((4,), dtype=jnp.float32)
    stopped_success = stopped_total = 0
    side_success = side_total = 0
    solo_speeds = []
    maneuver_totals = jnp.zeros((9,), dtype=jnp.float32)
    for seed in seeds:
        for episode in range(episodes):
            key = jax.random.PRNGKey(seed * 100003 + episode)
            state = reset_stage5_batch(key, envs, track, 1.0)
            final_state, event, maneuver_count = rollout(parameters, state)
            maneuver_totals += maneuver_count
            event = jax.device_get(event)
            totals += jnp.sum(event[:, :4].astype(jnp.float32), axis=0)
            scenarios = jax.device_get(state.scenario_id)
            progress_clear = jax.device_get(final_state.cars[:, 0, 0] > state.cars[:, 1, 0] + 5.0)
            stopped = scenarios == 1
            side = scenarios == 5
            safe = ~(event[:, 4] | event[:, 5])
            stopped_success += int(jnp.sum(jnp.asarray(stopped & progress_clear & safe)))
            stopped_total += int(jnp.sum(jnp.asarray(stopped)))
            side_success += int(jnp.sum(jnp.asarray(side & safe)))
            side_total += int(jnp.sum(jnp.asarray(side)))
        solo_state = reset_stage5_batch(jax.random.PRNGKey(seed + 700000), envs, track, 0.0)
        quarter = jnp.arange(PACK_CARS)[None, :] * track["length"] / PACK_CARS
        solo_state = solo_state._replace(cars=solo_state.cars.at[..., 0].set(
            solo_state.cars[:, :1, 0] + quarter))
        solo_speeds.append(float(solo_rollout(parameters, solo_state)))
    situations = len(seeds) * envs * episodes
    event_rates = jax.device_get(totals) / max(1, situations)
    solo_speed = max(1.0, sum(solo_speeds) / len(solo_speeds))
    maneuver_totals = jax.device_get(maneuver_totals)
    maneuver_names = ["FOLLOW", "DRAFT", "ATTACK_LEFT", "ATTACK_RIGHT", "LATE_BRAKE",
                      "SWITCHBACK", "DEFEND_LEFT", "DEFEND_RIGHT", "ABORT"]
    return {
        "situations": situations,
        "seeds": seeds,
        "cleanPassRate": float(event_rates[0]),
        "contactRate": float(event_rates[1]),
        "deepContactRate": float(event_rates[2]),
        "forcedOffRate": float(event_rates[3]),
        "soloLapTimeS": float(track["length"] / solo_speed),
        "stoppedCarBypassRate": stopped_success / max(1, stopped_total),
        "sideBySideCompletionRate": side_success / max(1, side_total),
        "stoppedCarSituations": stopped_total,
        "sideBySideSituations": side_total,
        "horizonDecisions": horizon,
        "maneuverDistribution": {name: float(value / max(1.0, maneuver_totals.sum()))
                                  for name, value in zip(maneuver_names, maneuver_totals)},
    }


def main():
    parser = argparse.ArgumentParser(description="Multi-seed Stage 5 promotion evaluator.")
    parser.add_argument("policy", type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--envs", type=int, default=1024)
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--horizon", type=int, default=128)
    parser.add_argument("--seeds", default="101,202,303,404,505")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "artifacts")
    args = parser.parse_args()
    seeds = [int(value.strip()) for value in args.seeds.split(",") if value.strip()]
    parameters, payload = load_policy(args.policy)
    track = load_track(reference_path=args.reference)
    baseline = evaluate(parameters, track, seeds, args.envs, args.episodes, args.horizon, False)
    candidate = evaluate(parameters, track, seeds, args.envs, args.episodes, args.horizon, True)
    baseline["controller"] = "deterministic-stage5-heuristic"
    candidate["controller"] = str(args.policy)
    candidate["trainingMetadata"] = payload.get("metadata", {})
    args.output_dir.mkdir(parents=True, exist_ok=True)
    baseline_path = args.output_dir / "stage5_promotion_baseline.json"
    candidate_path = args.output_dir / "stage5_promotion_candidate.json"
    baseline_path.write_text(json.dumps(baseline, indent=2), encoding="utf-8")
    candidate_path.write_text(json.dumps(candidate, indent=2), encoding="utf-8")
    print(json.dumps({"baseline": baseline, "candidate": candidate,
                      "baselinePath": str(baseline_path), "candidatePath": str(candidate_path)}, indent=2))


if __name__ == "__main__":
    main()
