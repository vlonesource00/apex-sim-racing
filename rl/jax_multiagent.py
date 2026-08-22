from __future__ import annotations

from typing import NamedTuple

import jax
import jax.numpy as jnp

from jax_vehicle import CONFIG, StepResult, load_track, observe, reduced_step, shield_action, track_lookup

MULTI_STATE_SIZE = 18
MULTI_OBSERVATION_SIZE = 27


class MultiStepResult(NamedTuple):
    state: jax.Array
    controls: jax.Array
    reward: jax.Array
    done: jax.Array
    metrics: jax.Array


def reset_multi_batch(key: jax.Array, count: int, track_length: float) -> jax.Array:
    keys = jax.random.split(key, 8)
    ego_progress = jax.random.uniform(keys[0], (count,), minval=0.0, maxval=track_length)
    gap = jax.random.uniform(keys[1], (count,), minval=6.0, maxval=24.0)
    ego_lateral = jax.random.normal(keys[2], (count,)) * 0.32
    opponent_lateral = jax.random.uniform(keys[3], (count,), minval=-2.4, maxval=2.4)
    ego_speed = jax.random.uniform(keys[4], (count,), minval=27.0, maxval=48.0)
    # Stage-2 curriculum presents a pass opportunity in most episodes while
    # retaining a small set of equal-pace rivals that require patience.
    opponent_delta_speed = jax.random.uniform(keys[5], (count,), minval=-8.0, maxval=0.5)
    opponent_speed = jnp.clip(ego_speed + opponent_delta_speed, 20.0, 52.0)
    ego_soc = jax.random.uniform(keys[6], (count,), minval=0.35, maxval=0.95)
    opponent_soc = jax.random.uniform(keys[7], (count,), minval=0.25, maxval=0.9)
    zeros = jnp.zeros((count,))
    ego = jnp.stack((ego_progress, ego_lateral, zeros, ego_speed, zeros, zeros, zeros, ego_soc), axis=-1)
    opponent = jnp.stack((ego_progress + gap, opponent_lateral, zeros, opponent_speed,
                          zeros, zeros, zeros, opponent_soc), axis=-1)
    return jnp.concatenate((ego, opponent, zeros[:, None], zeros[:, None]), axis=-1)


def relative_features(state: jax.Array) -> jax.Array:
    ego = state[..., :8]
    opponent = state[..., 8:16]
    relative_progress = opponent[..., 0] - ego[..., 0]
    relative_lateral = opponent[..., 1] - ego[..., 1]
    relative_speed = opponent[..., 3] - ego[..., 3]
    closing = -relative_speed
    ttc = jnp.where((relative_progress > 0.0) & (closing > 0.2), relative_progress / closing, 9.0)
    lateral_clearance = jnp.abs(relative_lateral) - 1.9
    return jnp.stack((
        jnp.clip(relative_progress / 30.0, -1.0, 1.0),
        jnp.clip(relative_lateral / CONFIG["roadHalfWidthM"], -1.0, 1.0),
        jnp.clip(relative_speed / 20.0, -1.0, 1.0),
        jnp.clip(closing / 20.0, -1.0, 1.0),
        jnp.clip(ttc / 6.0, 0.0, 1.5),
        jnp.clip(lateral_clearance / 4.0, -1.0, 1.0),
        (relative_progress > 0.0).astype(state.dtype),
        (jnp.abs(relative_progress) < 5.5).astype(state.dtype)
    ), axis=-1)


def observe_multi(state: jax.Array, track: dict[str, jax.Array | float]) -> jax.Array:
    return jnp.concatenate((observe(state[..., :8], track), relative_features(state)), axis=-1)


def traffic_shield(state: jax.Array, action: jax.Array) -> jax.Array:
    ego = state[..., :8]
    opponent = state[..., 8:16]
    action = shield_action(ego, action)
    gap = opponent[..., 0] - ego[..., 0]
    lateral_delta = opponent[..., 1] - ego[..., 1]
    closing = ego[..., 3] - opponent[..., 3]
    ttc = jnp.where((gap > 0.0) & (closing > 0.2), gap / closing, 99.0)
    collision_course = (gap > 0.0) & (gap < 32.0) & (closing > 0.2) & (jnp.abs(lateral_delta) < 3.4)
    overlap_risk = (jnp.abs(gap) < 5.8) & (jnp.abs(lateral_delta) < 2.35)
    open_side = jnp.where(opponent[..., 1] >= ego[..., 1], -0.78, 0.78)
    approach_urgency = jnp.maximum(0.46, jnp.clip((22.0 - gap) / 15.0, 0.0, 1.0)) * collision_course.astype(state.dtype)
    overlap_urgency = overlap_risk.astype(state.dtype) * 0.9
    urgency = jnp.maximum(approach_urgency, overlap_urgency)
    brake_urgency = jnp.clip((12.0 - gap) / 8.0, 0.0, 1.0) * collision_course.astype(state.dtype)
    return jnp.stack((
        action[..., 0] * (1.0 - urgency) + open_side * urgency,
        jnp.minimum(action[..., 1], 0.10 - brake_urgency * 1.10),
        action[..., 2] * (1.0 - urgency * 0.65),
        jnp.minimum(action[..., 3], 0.35 - urgency * 0.55)
    ), axis=-1)


def opponent_action(state: jax.Array) -> jax.Array:
    opponent = state[..., 8:16]
    # A stable but non-identical rival: varying pace and lane make memorising
    # one pass side or timing window insufficient.
    line = 0.12 * jnp.sin(opponent[..., 0] * 0.0023)
    pace = 0.02 + 0.16 * jnp.sin(opponent[..., 0] * 0.0031)
    aggression = jnp.full_like(line, 0.08)
    ers = jnp.where(opponent[..., 7] > 0.15, 0.22, -0.2)
    return jnp.stack((line, pace, aggression, ers), axis=-1)


def multi_env_step(state: jax.Array, action: jax.Array, track: dict[str, jax.Array | float]) -> MultiStepResult:
    ego = state[..., :8]
    opponent = state[..., 8:16]
    passed = state[..., 16]
    prior_contact = state[..., 17]
    ego_curvature, ego_target = track_lookup(ego[..., 0], track)
    opponent_curvature, opponent_target = track_lookup(opponent[..., 0], track)
    safe_action = traffic_shield(state, action)
    ego_result = reduced_step(ego, safe_action, ego_curvature, ego_target)
    # Racing room is reciprocal: the rival also reacts to an overlap instead of
    # blindly following its line through the attacking car.
    swapped_state = jnp.concatenate((opponent, ego, state[..., 16:18]), axis=-1)
    opponent_safe_action = traffic_shield(swapped_state, opponent_action(state))
    opponent_result = reduced_step(opponent, opponent_safe_action, opponent_curvature, opponent_target)

    next_ego = ego_result.state
    next_opponent = opponent_result.state
    longitudinal = next_opponent[..., 0] - next_ego[..., 0]
    lateral = next_opponent[..., 1] - next_ego[..., 1]
    contact = (jnp.abs(longitudinal) < 4.7) & (jnp.abs(lateral) < 1.9)
    deep_contact = (jnp.abs(longitudinal) < 3.6) & (jnp.abs(lateral) < 1.45)
    new_contact = contact & (prior_contact <= 0.0)
    contact_time = prior_contact + contact.astype(state.dtype) * CONFIG["dt"]
    newly_passed = (passed < 0.5) & (longitudinal < -5.0) & ~contact & (contact_time < 0.02)
    next_passed = jnp.maximum(passed, newly_passed.astype(state.dtype))
    durable_clear = (next_passed > 0.5) & (longitudinal < -5.0) & ~contact
    ego_delta = next_ego[..., 0] - ego[..., 0]
    opponent_delta = next_opponent[..., 0] - opponent[..., 0]
    relative_gain = ego_delta - opponent_delta
    opponent_off = jnp.abs(next_opponent[..., 1]) > CONFIG["roadHalfWidthM"]
    ego_off = jnp.abs(next_ego[..., 1]) > CONFIG["roadHalfWidthM"]
    forced_off = opponent_off & contact
    reward = (ego_result.reward
              + relative_gain * 2.0
              + newly_passed.astype(state.dtype) * 30.0
              + durable_clear.astype(state.dtype) * 0.30
              - contact.astype(state.dtype) * 16.0
              - deep_contact.astype(state.dtype) * 24.0
              - forced_off.astype(state.dtype) * 45.0)
    done = ego_result.done | opponent_off | (contact_time > 0.12) | ~jnp.isfinite(reward)
    next_state = jnp.concatenate((next_ego, next_opponent, next_passed[..., None], contact_time[..., None]), axis=-1)
    metrics = jnp.stack((newly_passed.astype(state.dtype), new_contact.astype(state.dtype),
                         (new_contact & deep_contact).astype(state.dtype), ego_off.astype(state.dtype),
                         forced_off.astype(state.dtype), durable_clear.astype(state.dtype), relative_gain), axis=-1)
    return MultiStepResult(next_state, ego_result.controls, reward, done, metrics)


__all__ = ["MULTI_OBSERVATION_SIZE", "MultiStepResult", "load_track", "multi_env_step",
           "observe_multi", "relative_features", "reset_multi_batch", "traffic_shield"]
