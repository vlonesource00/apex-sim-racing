from __future__ import annotations

from typing import NamedTuple

import jax
import jax.numpy as jnp

from jax_vehicle import CONFIG, load_track, observe, reduced_step, shield_action, track_lookup

PACK_CARS = 4
TRAFFIC_SLOTS = 3
PACK_OBSERVATION_SIZE = 19 + TRAFFIC_SLOTS * 8


class PackState(NamedTuple):
    cars: jax.Array
    pace_bias: jax.Array
    pass_timer: jax.Array
    tainted: jax.Array
    contact_active: jax.Array


class PackStepResult(NamedTuple):
    state: PackState
    controls: jax.Array
    reward: jax.Array
    done: jax.Array
    metrics: jax.Array


def reset_pack_batch(key: jax.Array, count: int, track: dict[str, jax.Array | float], car_count: int = PACK_CARS) -> PackState:
    keys = jax.random.split(key, 7)
    base_progress = jax.random.uniform(keys[0], (count, 1), minval=0.0, maxval=track["length"])
    gaps = jax.random.uniform(keys[1], (count, car_count), minval=7.0, maxval=12.0)
    progress = base_progress + jnp.cumsum(gaps, axis=1) - gaps[:, :1]
    lateral = jax.random.uniform(keys[2], (count, car_count), minval=-1.65, maxval=1.65)
    _, local_target = track_lookup(progress, track)
    speed_fraction = jax.random.uniform(keys[3], (count, car_count), minval=0.72, maxval=0.94)
    speed = jnp.clip(local_target * speed_fraction + jax.random.uniform(keys[4], (count, car_count), minval=-1.5, maxval=1.5), 16.0, 52.0)
    pace_bias = jax.random.uniform(keys[5], (count, car_count), minval=-0.12, maxval=0.12)
    soc = jax.random.uniform(keys[6], (count, car_count), minval=0.3, maxval=0.95)
    zeros = jnp.zeros((count, car_count), dtype=jnp.float32)
    cars = jnp.stack((progress, lateral, zeros, speed, zeros, zeros, zeros, soc), axis=-1)
    pair_shape = (count, car_count, car_count)
    diagonal = jnp.eye(car_count, dtype=bool)[None, ...]
    return PackState(cars, pace_bias, jnp.where(diagonal, -1.0, jnp.zeros(pair_shape)),
                     jnp.zeros(pair_shape, dtype=bool), jnp.zeros(pair_shape, dtype=bool))


def _pairwise(cars: jax.Array):
    ego = cars[:, :, None, :]
    opponent = cars[:, None, :, :]
    gap = opponent[..., 0] - ego[..., 0]
    lateral = opponent[..., 1] - ego[..., 1]
    relative_speed = opponent[..., 3] - ego[..., 3]
    return gap, lateral, relative_speed


def _slot_features(cars: jax.Array, index: jax.Array, present: jax.Array) -> jax.Array:
    count, agents, _ = cars.shape
    selected = jnp.take_along_axis(cars[:, None, :, :], index[..., None, None], axis=2)[:, :, 0, :]
    ego = cars
    gap = selected[..., 0] - ego[..., 0]
    lateral = selected[..., 1] - ego[..., 1]
    relative_speed = selected[..., 3] - ego[..., 3]
    closing = -relative_speed
    ttc = jnp.where((gap > 0.0) & (closing > 0.2), gap / closing, 9.0)
    values = jnp.stack((jnp.clip(gap / 30.0, -1.5, 1.5),
                        jnp.clip(lateral / CONFIG["roadHalfWidthM"], -1.0, 1.0),
                        jnp.clip(relative_speed / 20.0, -1.0, 1.0),
                        jnp.clip(closing / 20.0, -1.0, 1.0),
                        jnp.clip(ttc / 6.0, 0.0, 1.5),
                        jnp.clip((jnp.abs(lateral) - 1.9) / 4.0, -1.0, 1.0),
                        (gap > 0.0).astype(cars.dtype),
                        (jnp.abs(gap) < 5.5).astype(cars.dtype)), axis=-1)
    missing = jnp.asarray([1.5, 0.0, 0.0, 0.0, 1.5, 1.0, 0.0, 0.0], dtype=cars.dtype)
    return jnp.where(present[..., None], values, missing)


def observe_pack(state: PackState, track: dict[str, jax.Array | float]) -> jax.Array:
    cars = state.cars
    count, agents, _ = cars.shape
    base = observe(cars.reshape((-1, 8)), track).reshape((count, agents, 19))
    gap, lateral, _ = _pairwise(cars)
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]

    ahead_mask = (gap > 0.0) & ~diagonal
    ahead_index = jnp.argmin(jnp.where(ahead_mask, gap, jnp.inf), axis=-1)
    ahead_present = jnp.any(ahead_mask, axis=-1)

    side_mask = (jnp.abs(gap) < 7.0) & ~diagonal
    side_score = jnp.abs(gap) + jnp.abs(lateral) * 0.15
    side_index = jnp.argmin(jnp.where(side_mask, side_score, jnp.inf), axis=-1)
    side_present = jnp.any(side_mask, axis=-1)

    behind_mask = (gap < 0.0) & ~diagonal
    behind_index = jnp.argmin(jnp.where(behind_mask, -gap, jnp.inf), axis=-1)
    behind_present = jnp.any(behind_mask, axis=-1)

    slots = (_slot_features(cars, ahead_index, ahead_present),
             _slot_features(cars, side_index, side_present),
             _slot_features(cars, behind_index, behind_present))
    return jnp.concatenate((base, *slots), axis=-1)


def pack_traffic_shield(cars: jax.Array, action: jax.Array) -> jax.Array:
    count, agents, _ = cars.shape
    safe = shield_action(cars.reshape((-1, 8)), action.reshape((-1, 4))).reshape((count, agents, 4))
    # The reduced model's nominal target already represents a qualifying-speed
    # envelope. Pack tactics may attack up to it, but not turn a tactical pace
    # output into an across-the-board corner-speed override.
    safe = safe.at[..., 1].set(jnp.minimum(safe[..., 1], 0.28))
    gap, lateral, relative_speed = _pairwise(cars)
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]
    closing = -relative_speed
    collision_course = (gap > 0.0) & (gap < 34.0) & (closing > 0.2) & (jnp.abs(lateral) < 3.5) & ~diagonal
    approach = jnp.maximum(0.42, jnp.clip((23.0 - gap) / 16.0, 0.0, 1.0)) * collision_course
    # At prototype speeds an 11 m trigger is already inside the reaction
    # horizon. Reserve a corridor early enough for the low-level controller to
    # produce lateral separation without a last-instant swerve.
    corridor = (jnp.abs(gap) < 18.0) & (jnp.abs(lateral) < 3.1) & ~diagonal
    overlap = (jnp.abs(gap) < 9.0) & (jnp.abs(lateral) < 2.7) & ~diagonal
    urgency_matrix = jnp.maximum(jnp.maximum(approach, corridor.astype(cars.dtype) * 0.68),
                                 overlap.astype(cars.dtype) * 0.98)
    threat_index = jnp.argmax(urgency_matrix, axis=-1)
    urgency = jnp.max(urgency_matrix, axis=-1)
    threat_lateral = jnp.take_along_axis(lateral, threat_index[..., None], axis=-1)[..., 0]

    nearby = (jnp.abs(gap) < 13.0) & (jnp.abs(lateral) < 3.6) & ~diagonal
    negative_blocked = jnp.any(nearby & (lateral < -0.25), axis=-1)
    positive_blocked = jnp.any(nearby & (lateral > 0.25), axis=-1)
    open_side = jnp.where(threat_lateral >= 0.0, -0.78, 0.78)
    open_side = jnp.where((open_side < 0.0) & negative_blocked & ~positive_blocked, 0.78, open_side)
    open_side = jnp.where((open_side > 0.0) & positive_blocked & ~negative_blocked, -0.78, open_side)
    boxed = negative_blocked & positive_blocked
    open_side = jnp.where(boxed, 0.0, open_side)
    ego_lateral = cars[..., 1]
    open_side = jnp.where((ego_lateral < -3.8) & (open_side < 0.0), 0.35, open_side)
    open_side = jnp.where((ego_lateral > 3.8) & (open_side > 0.0), -0.35, open_side)
    closest_gap = jnp.min(jnp.where(collision_course, gap, jnp.inf), axis=-1)
    brake_urgency = jnp.where(jnp.isfinite(closest_gap), jnp.clip((13.0 - closest_gap) / 9.0, 0.0, 1.0), 0.0)
    # Deterministic overlap ownership: the trailing car yields longitudinally
    # while both cars retain their lateral corridor.
    overlap_ahead = jnp.any(overlap & (gap > 0.0), axis=-1)
    corridor_ahead = jnp.any(corridor & (gap > 0.0), axis=-1)
    brake_urgency = jnp.maximum(brake_urgency, corridor_ahead.astype(cars.dtype) * 0.48)
    brake_urgency = jnp.maximum(brake_urgency, overlap_ahead.astype(cars.dtype))
    brake_urgency = jnp.maximum(brake_urgency, boxed.astype(cars.dtype) * (urgency > 0.0))

    traffic_safe = jnp.stack((jnp.clip(safe[..., 0] * (1.0 - urgency) + open_side * urgency, -0.72, 0.72),
                              jnp.minimum(safe[..., 1], 0.12 - brake_urgency * 1.12),
                              safe[..., 2] * (1.0 - urgency * 0.68),
                              jnp.minimum(safe[..., 3], 0.38 - brake_urgency * 0.58)), axis=-1)
    # Final containment only takes authority near the physical edge. Re-running
    # the projected edge shield here would erase a valid side-by-side corridor.
    edge_risk = jnp.clip((jnp.abs(ego_lateral) - 3.8) / 1.9, 0.0, 1.0)
    center_request = -jnp.sign(ego_lateral) * 0.52
    inward_blocked = ((ego_lateral > 0.0) & negative_blocked) | ((ego_lateral < 0.0) & positive_blocked)
    hold_request = jnp.clip(ego_lateral / (CONFIG["roadHalfWidthM"] * CONFIG["lineOffsetFraction"]), -0.72, 0.72)
    containment_request = jnp.where(inward_blocked, hold_request, center_request)
    containment_brake = jnp.maximum(edge_risk, inward_blocked.astype(cars.dtype) * edge_risk)
    return jnp.stack((traffic_safe[..., 0] * (1.0 - edge_risk) + containment_request * edge_risk,
                      jnp.minimum(traffic_safe[..., 1], 0.10 - containment_brake * 1.10),
                      traffic_safe[..., 2] * (1.0 - edge_risk),
                      jnp.minimum(traffic_safe[..., 3], 0.25 - containment_brake * 0.95)), axis=-1)


def pack_env_step(state: PackState, action: jax.Array, track: dict[str, jax.Array | float]) -> PackStepResult:
    cars = state.cars
    count, agents, _ = cars.shape
    safe_action = pack_traffic_shield(cars, action)
    biased_action = safe_action.at[..., 1].set(jnp.clip(safe_action[..., 1] + state.pace_bias, -1.0, 1.0))
    curvature, target_speed = track_lookup(cars[..., 0], track)
    result = reduced_step(cars, biased_action, curvature, target_speed)
    next_cars = result.state

    old_gap, _, _ = _pairwise(cars)
    gap, lateral, _ = _pairwise(next_cars)
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]
    contact = (jnp.abs(gap) < 4.7) & (jnp.abs(lateral) < 1.9) & ~diagonal
    deep_contact = (jnp.abs(gap) < 3.6) & (jnp.abs(lateral) < 1.45) & ~diagonal
    new_contact = contact & ~state.contact_active
    upper = jnp.triu(jnp.ones((agents, agents), dtype=bool), k=1)[None, ...]

    approach_zone = (old_gap > -12.0) & (old_gap < 28.0) & ~diagonal
    tainted = state.tainted | (contact & approach_zone)
    crossed = (old_gap > 0.0) & (gap <= 0.0) & ~diagonal
    timer = state.pass_timer
    timer = jnp.where(crossed & ~tainted & ~contact, CONFIG["dt"], timer)
    holding_clear = (timer > 0.0) & (gap < -5.0) & ~contact
    timer = jnp.where(holding_clear, timer + CONFIG["dt"], timer)
    timer = jnp.where((timer > 0.0) & ((gap > 3.0) | contact), 0.0, timer)
    clean_pass = (timer >= 1.0) & (state.pass_timer < 1.0)
    timer = jnp.where(clean_pass, -1.0, timer)
    reset_pair = (gap > 10.0) & (timer < 0.0)
    timer = jnp.where(reset_pair, 0.0, timer)
    tainted = jnp.where((gap > 10.0) | clean_pass, False, tainted)
    timer = jnp.where(diagonal, -1.0, timer)

    delta = next_cars[..., 0] - cars[..., 0]
    relative_gain = delta - jnp.mean(delta, axis=1, keepdims=True)
    off = jnp.abs(next_cars[..., 1]) > CONFIG["roadHalfWidthM"]
    contact_count = jnp.sum(contact.astype(cars.dtype), axis=-1)
    clean_count = jnp.sum(clean_pass.astype(cars.dtype), axis=-1)
    forced_off = off[:, None, :] & contact
    forced_count = jnp.sum(forced_off.astype(cars.dtype), axis=-1)
    edge_excess = jnp.maximum(0.0, jnp.abs(next_cars[..., 1]) - CONFIG["roadHalfWidthM"] * 0.62)
    stability_excess = jnp.maximum(0.0, jnp.abs(next_cars[..., 5]) - 0.18)
    # Dense pre-contact shaping: preserve a viable racing corridor while making
    # the deep-overlap envelope expensive before the discrete contact event.
    closing_margin = (jnp.clip((9.0 - jnp.abs(gap)) / 6.0, 0.0, 1.0)
                      * jnp.clip((2.35 - jnp.abs(lateral)) / 0.95, 0.0, 1.0)
                      * (~diagonal).astype(cars.dtype))
    margin_cost = jnp.sum(closing_margin, axis=-1)
    # A position is only valuable if it survives the one-second clean-pass
    # audit.  Contact and displacement therefore dominate the dense progress
    # signal instead of becoming an exploitable shortcut to the pass bonus.
    reward = (result.reward + relative_gain * 1.25 + clean_count * 24.0
              + jnp.sum(holding_clear.astype(cars.dtype), axis=-1) * 0.18
              - contact_count * 28.0 - jnp.sum(deep_contact.astype(cars.dtype), axis=-1) * 64.0
              - forced_count * 128.0 - off.astype(cars.dtype) * 80.0
              - margin_cost * 2.8 - edge_excess ** 2 * 1.6 - stability_excess ** 2 * 18.0)
    done = jnp.any(off, axis=-1) | jnp.any(deep_contact, axis=(1, 2)) | ~jnp.all(jnp.isfinite(reward), axis=-1)
    metrics = jnp.stack((jnp.sum(clean_pass.astype(cars.dtype), axis=(1, 2)),
                         jnp.sum((new_contact & upper).astype(cars.dtype), axis=(1, 2)),
                         jnp.sum((deep_contact & upper).astype(cars.dtype), axis=(1, 2)),
                         jnp.sum(off.astype(cars.dtype), axis=1),
                         jnp.sum((forced_off & upper).astype(cars.dtype), axis=(1, 2)),
                         jnp.sum(holding_clear.astype(cars.dtype), axis=(1, 2)),
                         jnp.mean(delta, axis=1), done.astype(cars.dtype)), axis=-1)
    return PackStepResult(PackState(next_cars, state.pace_bias, timer, tainted, contact),
                          result.controls, reward, done, metrics)


def reset_done(state: PackState, reset: PackState, done: jax.Array) -> PackState:
    return jax.tree.map(lambda current, fresh: jnp.where(done.reshape((done.shape[0],) + (1,) * (current.ndim - 1)), fresh, current), state, reset)


__all__ = ["PACK_CARS", "PACK_OBSERVATION_SIZE", "PackState", "PackStepResult", "load_track",
           "observe_pack", "pack_env_step", "pack_traffic_shield", "reset_done", "reset_pack_batch"]
