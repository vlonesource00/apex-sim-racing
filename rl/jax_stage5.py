"""Stage 5 headless tactical stack.

The policy chooses racecraft at 20 Hz.  This module owns the deterministic
minimum-jerk corridor validation, longitudinal controller, traffic shield and
class-randomized 120 Hz vehicle integration used underneath it.  It deliberately
does not expose steering/throttle/brake as learned actions.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

import jax
import jax.numpy as jnp

from jax_vehicle import load_track, observe, reference_lookup, track_lookup

CONFIG = json.loads((Path(__file__).parent / "stage5_config.json").read_text())
MANEUVERS = tuple(CONFIG["maneuvers"])
MANEUVER_COUNT = len(MANEUVERS)
ACTION_SIZE = MANEUVER_COUNT + 4
PACK_CARS = 4
DECISION_DT = 1.0 / CONFIG["decisionHz"]
PHYSICS_DT = 1.0 / CONFIG["simulationHz"]
PHYSICS_SUBSTEPS = CONFIG["simulationHz"] // CONFIG["decisionHz"]
FOLLOW, DRAFT, ATTACK_LEFT, ATTACK_RIGHT, LATE_BRAKE, SWITCHBACK, DEFEND_LEFT, DEFEND_RIGHT, ABORT = range(9)


class Stage5State(NamedTuple):
    cars: jax.Array                 # [batch, cars, 8], same physical state schema as jax_vehicle
    class_id: jax.Array             # [batch, cars]
    physical: jax.Array             # mass, mu, downforce, drive accel, lateral budget, brake accel
    tire_wear: jax.Array            # 0..1 strategic degradation
    tire_temperature: jax.Array     # carcass Celsius
    maneuver: jax.Array             # committed deployed manoeuvre
    target_index: jax.Array         # opponent index
    target_corridor: jax.Array      # metres
    target_closing_speed: jax.Array # m/s
    ers_request: jax.Array          # 0..1
    commitment: jax.Array           # seconds remaining
    steer_command: jax.Array        # deployed normalized road-wheel request
    pass_timer: jax.Array           # pairwise retained clean-pass timer
    tainted: jax.Array              # pairwise contact-tainted pass
    contact_active: jax.Array
    scenario_id: jax.Array


class Stage5Step(NamedTuple):
    state: Stage5State
    controls: jax.Array
    reward: jax.Array
    done: jax.Array
    metrics: jax.Array


def minimum_jerk(value: jax.Array) -> jax.Array:
    u = jnp.clip(value, 0.0, 1.0)
    return u * u * u * (10.0 + u * (-15.0 + u * 6.0))


def smooth_step(value: jax.Array) -> jax.Array:
    u = jnp.clip(value, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


def driver_steering(previous, heading_error, lateral_error, yaw_rate, dt,
                    committed=False, recovering=False, yielding=False):
    heading_gain = jnp.where(recovering, 2.8, jnp.where(committed, 3.45, 2.25))
    lateral_gain = jnp.where(recovering, 0.085, jnp.where(committed, 0.08, 0.055))
    yaw_damping = jnp.where(committed, 0.12, 0.17)
    target = jnp.clip(heading_error * heading_gain - lateral_error * lateral_gain
                      - yaw_rate * yaw_damping, -1.0, 1.0)
    target = jnp.where(yielding, jnp.clip(target, -0.3, 0.3), target)
    rate = jnp.where(committed, 7.5, jnp.where(recovering, 6.0, 5.2))
    return jnp.clip(previous + jnp.clip(target - previous, -rate * dt, rate * dt), -1.0, 1.0)


def driver_pedals(speed_error, straight, recovering, vehicle_speed, desired_speed, heading_error):
    throttle = jnp.where(speed_error > -0.6,
                         jnp.clip(jnp.where(straight, 0.92, 0.48) + speed_error * 0.14, 0.0, 1.0), 0.0)
    brake = jnp.clip((-speed_error - 1.1) * 0.15, 0.0, 1.0)
    recovery_throttle = jnp.where(vehicle_speed < desired_speed,
                                   jnp.where(jnp.abs(heading_error) > 1.15, 0.35, 0.68), 0.0)
    recovery_brake = jnp.where(vehicle_speed > desired_speed + 2.5,
                                jnp.clip(0.25 + (vehicle_speed - desired_speed) * 0.035, 0.25, 0.78), 0.0)
    return jnp.where(recovering, recovery_throttle, throttle), jnp.where(recovering, recovery_brake, brake)


def decode_action(action: jax.Array):
    if action.shape[-1] != ACTION_SIZE:
        raise ValueError(f"Stage 5 action requires {ACTION_SIZE} outputs")
    maneuver = jnp.argmax(action[..., :MANEUVER_COUNT], axis=-1)
    continuous = jnp.clip(action[..., MANEUVER_COUNT:], -1.0, 1.0)
    corridor = continuous[..., 0]
    closing = continuous[..., 1] * 12.0
    ers = (continuous[..., 2] + 1.0) * 0.5
    commitment = 0.35 + (continuous[..., 3] + 1.0) * 0.5 * 3.65
    return maneuver, corridor, closing, ers, commitment


def _class_table(dtype=jnp.float32):
    rows = []
    for name in ("prototype", "gt", "touring"):
        spec = CONFIG["classes"][name]
        power_accel = {"prototype": 10.4, "gt": 7.0, "touring": 5.4}[name]
        rows.append((spec["massKg"], spec["tireMu"], spec["downforcePerSpeed2"],
                     power_accel, spec["lateralAccelerationMps2"], spec["brakingMps2"]))
    return jnp.asarray(rows, dtype=dtype)


def _pairwise(cars: jax.Array, track_length: float):
    progress = cars[..., 0]
    gap = progress[:, None, :] - progress[:, :, None]
    gap = jnp.mod(gap + track_length * 0.5, track_length) - track_length * 0.5
    lateral = cars[:, None, :, 1] - cars[:, :, None, 1]
    relative_speed = cars[:, None, :, 3] - cars[:, :, None, 3]
    return gap, lateral, relative_speed


def _nearest_targets(cars: jax.Array, track_length: float):
    gap, lateral, _ = _pairwise(cars, track_length)
    agents = cars.shape[1]
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]
    candidates = (gap > -1.5) & (gap < 55.0) & (jnp.abs(lateral) < 5.3) & ~diagonal
    index = jnp.argmin(jnp.where(candidates, jnp.maximum(gap, 0.0), jnp.inf), axis=-1)
    present = jnp.any(candidates, axis=-1)
    return index, present


def _take_opponent(values: jax.Array, index: jax.Array):
    return jnp.take_along_axis(values, index[..., None], axis=-1)[..., 0]


def validate_corridor(cars: jax.Array, terminal: jax.Array, target_index: jax.Array,
                      target_speed: jax.Array, track_length: float, road_margin: float = 5.45):
    """Vectorized port of TrafficAwareness.evaluateCorridor (18 samples/3.4 s)."""
    batch, agents, _ = cars.shape
    times = jnp.linspace(0.0, 3.4, 18, dtype=cars.dtype)
    start = cars[..., 1]
    transition = jnp.clip(0.75 + jnp.abs(terminal - start) * 0.2, 0.75, 2.2)
    blend = smooth_step(times[:, None, None] / transition[None, ...])
    lateral = start[None, ...] + (terminal - start)[None, ...] * blend
    acceleration = jnp.clip((target_speed - cars[..., 3]) * 0.45, -7.0, 4.8)
    forward = jnp.maximum(0.0, cars[..., 3][None, ...] * times[:, None, None]
                          + 0.5 * acceleration[None, ...] * times[:, None, None] ** 2)
    ego_progress = cars[..., 0][None, ...] + forward
    opponent_progress = cars[:, None, :, 0] + jnp.maximum(0.0, cars[:, None, :, 3]) * times[:, None, None, None]
    gap = opponent_progress - ego_progress[..., None]
    gap = jnp.mod(gap + track_length * 0.5, track_length) - track_length * 0.5
    opponent_lateral = cars[:, None, :, 1]
    lateral_gap = jnp.abs(lateral[:, :, :, None] - opponent_lateral[None, ...])
    longitudinal_clearance = jnp.abs(gap) - 5.4
    lateral_clearance = lateral_gap - 2.9
    diagonal = jnp.eye(agents, dtype=bool)[None, None, ...]
    target_mask = jax.nn.one_hot(target_index, agents, dtype=bool)[None, ...]
    initial_separation = jnp.abs(start[:, :, None] - cars[:, None, :, 1])[None, ...]
    separating = target_mask & (jnp.abs(gap) > 2.8) & (lateral_gap >= initial_separation - 0.08)
    collision = (longitudinal_clearance < 0.0) & (lateral_clearance < 0.0) & ~separating & ~diagonal
    collision_free = ~jnp.any(collision, axis=(0, 3))
    clearance = jnp.where(diagonal, 99.0, jnp.maximum(longitudinal_clearance, lateral_clearance))
    minimum_clearance = jnp.min(clearance, axis=(0, 3))
    legal = jnp.abs(terminal) <= road_margin
    target_lateral = _take_opponent(jnp.broadcast_to(cars[:, None, :, 1], (batch, agents, agents)), target_index)
    target_separation = jnp.abs(terminal - target_lateral)
    return legal & collision_free, minimum_clearance, target_separation


def _scenario_layout(key: jax.Array, count: int, track: dict, difficulty=1.0):
    keys = jax.random.split(key, 8)
    scenario_count = len(CONFIG["curriculum"])
    available_scenarios = jnp.clip(jnp.floor(2 + difficulty * (scenario_count - 2)), 2, scenario_count).astype(jnp.int32)
    scenario = jax.random.randint(keys[0], (count,), 0, available_scenarios)
    base = jax.random.uniform(keys[1], (count, 1), minval=0.0, maxval=track["length"])
    minimum_gap = 18.0 - difficulty * 10.0
    maximum_gap = 28.0 - difficulty * 11.0
    normal_gaps = jax.random.uniform(keys[2], (count, PACK_CARS), minval=minimum_gap, maxval=maximum_gap)
    progress = base + jnp.cumsum(normal_gaps, axis=1) - normal_gaps[:, :1]
    lateral = jax.random.uniform(keys[3], (count, PACK_CARS), minval=-1.4, maxval=1.4)
    _, nominal = track_lookup(progress, track)
    speed = nominal * jax.random.uniform(keys[4], (count, PACK_CARS), minval=0.76, maxval=0.98)
    stopped = scenario == CONFIG["curriculum"].index("STOPPED_CAR_AHEAD")
    slow = scenario == CONFIG["curriculum"].index("SLOW_CAR_AHEAD")
    pullout = scenario == CONFIG["curriculum"].index("DRAFT_PULL_OUT")
    inside = scenario == CONFIG["curriculum"].index("INSIDE_BRAKING_ATTACK")
    outside = scenario == CONFIG["curriculum"].index("OUTSIDE_EXIT_ATTACK")
    side_by_side = scenario == CONFIG["curriculum"].index("SIDE_BY_SIDE_ENTRY")
    switchback = scenario == CONFIG["curriculum"].index("SWITCHBACK_AFTER_BLOCK")
    three_wide = scenario == CONFIG["curriculum"].index("THREE_WIDE")
    multiclass = scenario == CONFIG["curriculum"].index("MULTICLASS_LAPPING")
    recovery = scenario == CONFIG["curriculum"].index("FAILED_ATTACK_RECOVERY")
    scenario_gap = 40.0 - difficulty * 12.0
    progress = progress.at[:, 1].set(jnp.where(stopped | slow | pullout, progress[:, 0] + scenario_gap, progress[:, 1]))
    speed = speed.at[:, 1].set(jnp.where(stopped, 0.0, jnp.where(slow, 12.0, speed[:, 1])))
    lateral = lateral.at[:, 1].set(jnp.where(stopped | slow | pullout, 0.0, lateral[:, 1]))
    # Purpose-built race situations replace ordinary random driving for every
    # curriculum label.  Mirrored signs prevent one-side policy shortcuts.
    mirror = jnp.where((jnp.arange(count) & 1) == 0, -1.0, 1.0)
    attack_gap = 15.0 - difficulty * 5.0
    progress = progress.at[:, 1].set(jnp.where(inside | outside | switchback,
                                               progress[:, 0] + attack_gap, progress[:, 1]))
    speed = speed.at[:, 0].set(jnp.where(inside | outside | switchback,
                                         speed[:, 1] + 3.0 + difficulty * 3.0, speed[:, 0]))
    lateral = lateral.at[:, 0].set(jnp.where(inside, mirror * 2.7,
                                             jnp.where(outside, -mirror * 3.0, lateral[:, 0])))
    lateral = lateral.at[:, 1].set(jnp.where(inside | outside, 0.0,
                                             jnp.where(switchback, mirror * 3.1, lateral[:, 1])))
    progress = progress.at[:, 1].set(jnp.where(side_by_side, progress[:, 0] + 0.8, progress[:, 1]))
    lateral = lateral.at[:, 0].set(jnp.where(side_by_side, mirror * 2.15, lateral[:, 0]))
    lateral = lateral.at[:, 1].set(jnp.where(side_by_side, -mirror * 2.15, lateral[:, 1]))
    speed = speed.at[:, 1].set(jnp.where(side_by_side, speed[:, 0] * 0.98, speed[:, 1]))
    progress = progress.at[:, 1].set(jnp.where(multiclass, progress[:, 0] + 24.0, progress[:, 1]))
    lateral = lateral.at[:, 1].set(jnp.where(multiclass, mirror * 0.7, lateral[:, 1]))
    speed = speed.at[:, 1].set(jnp.where(multiclass, speed[:, 0] * 0.68, speed[:, 1]))
    lateral = lateral.at[:, 0].set(jnp.where(recovery, mirror * 6.15, lateral[:, 0]))
    progress = progress.at[:, 2].set(jnp.where(three_wide, progress[:, 0] + 3.0, progress[:, 2]))
    progress = progress.at[:, 3].set(jnp.where(three_wide, progress[:, 0] + 3.5, progress[:, 3]))
    lateral = lateral.at[:, 2].set(jnp.where(three_wide, -3.25, lateral[:, 2]))
    lateral = lateral.at[:, 3].set(jnp.where(three_wide, 3.25, lateral[:, 3]))
    return scenario, progress, lateral, speed, keys


def reset_stage5_batch(key: jax.Array, count: int, track: dict, difficulty=1.0) -> Stage5State:
    scenario, progress, lateral, speed, keys = _scenario_layout(key, count, track, difficulty)
    class_id = jax.random.randint(keys[5], (count, PACK_CARS), 0, 3)
    multiclass = scenario == CONFIG["curriculum"].index("MULTICLASS_LAPPING")
    class_id = class_id.at[:, 0].set(jnp.where(multiclass, 0, class_id[:, 0]))
    class_id = class_id.at[:, 1].set(jnp.where(multiclass, 2, class_id[:, 1]))
    class_id = class_id.at[:, 2].set(jnp.where(multiclass, 1, class_id[:, 2]))
    table = _class_table()
    physical = table[class_id]
    # Domain randomization stays centered on the three real classes.
    mass_scale = jax.random.uniform(keys[6], (count, PACK_CARS), minval=0.94, maxval=1.06)
    grip_scale = jax.random.uniform(keys[7], (count, PACK_CARS), minval=0.92, maxval=1.08)
    physical = physical.at[..., 0].multiply(mass_scale)
    physical = physical.at[..., 1].multiply(grip_scale)
    physical = physical.at[..., 2].multiply(jnp.clip(grip_scale, 0.96, 1.04))
    zeros = jnp.zeros((count, PACK_CARS), dtype=jnp.float32)
    tire_wear = jax.random.uniform(jax.random.fold_in(key, 91), (count, PACK_CARS), minval=0.0, maxval=0.22 * difficulty)
    ideal_temperature = jnp.take(jnp.asarray([94.0, 88.0, 82.0]), class_id)
    tire_temperature = ideal_temperature + jax.random.normal(jax.random.fold_in(key, 92), (count, PACK_CARS)) * (3 + 8 * difficulty)
    initial_speed_scale = jnp.take(jnp.asarray([1.0, 0.86, 0.73]), class_id)
    cars = jnp.stack((progress, lateral, zeros, speed * initial_speed_scale, zeros, zeros, zeros,
                      jnp.where(class_id == 0, 0.74, 0.0)), axis=-1)
    recovery = scenario == CONFIG["curriculum"].index("FAILED_ATTACK_RECOVERY")
    recovery_heading = jnp.sign(lateral[:, 0]) * (0.06 + difficulty * 0.06)
    cars = cars.at[:, 0, 2].set(jnp.where(recovery, recovery_heading, cars[:, 0, 2]))
    pair_shape = (count, PACK_CARS, PACK_CARS)
    diagonal = jnp.eye(PACK_CARS, dtype=bool)[None, ...]
    return Stage5State(cars, class_id, physical, tire_wear, tire_temperature, jnp.full_like(class_id, FOLLOW),
                       jnp.zeros_like(class_id), lateral, zeros, zeros, zeros, zeros,
                       jnp.where(diagonal, -1.0, jnp.zeros(pair_shape)),
                       jnp.zeros(pair_shape, dtype=bool), jnp.zeros(pair_shape, dtype=bool), scenario)


def observe_stage5(state: Stage5State, track: dict) -> jax.Array:
    count, agents, _ = state.cars.shape
    base = observe(state.cars.reshape((-1, 8)), track).reshape((count, agents, 19))
    one_hot_class = jax.nn.one_hot(state.class_id, 3)
    physical_scale = jnp.asarray([1400.0, 2.0, 5.0, 12.0, 25.0, 14.0])
    gap, lateral, relative_speed = _pairwise(state.cars, track["length"])
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]
    ahead_mask = (gap > 0) & ~diagonal
    side_mask = (jnp.abs(gap) < 7) & ~diagonal
    behind_mask = (gap < 0) & ~diagonal
    masks = (ahead_mask, side_mask, behind_mask)
    slots = []
    for mask in masks:
        score = jnp.where(mask, jnp.abs(gap) + jnp.abs(lateral) * 0.15, jnp.inf)
        index = jnp.argmin(score, axis=-1)
        present = jnp.any(mask, axis=-1)
        selected_gap = _take_opponent(gap, index)
        selected_lateral = _take_opponent(lateral, index)
        selected_relative = _take_opponent(relative_speed, index)
        closing = -selected_relative
        ttc = jnp.where((selected_gap > 0) & (closing > 0.2), selected_gap / closing, 9.0)
        values = jnp.stack((jnp.clip(selected_gap / 30, -1.5, 1.5),
                            jnp.clip(selected_lateral / 7.2, -1, 1),
                            jnp.clip(selected_relative / 20, -1, 1),
                            jnp.clip(closing / 20, -1, 1), jnp.clip(ttc / 6, 0, 1.5),
                            jnp.clip((jnp.abs(selected_lateral) - 2.9) / 4, -1, 1),
                            (selected_gap > 0).astype(base.dtype),
                            (jnp.abs(selected_gap) < 5.5).astype(base.dtype)), axis=-1)
        slots.append(jnp.where(present[..., None], values,
                               jnp.asarray([1.5, 0, 0, 0, 1.5, 1, 0, 0], dtype=base.dtype)))
    memory = jnp.concatenate((jax.nn.one_hot(state.maneuver, MANEUVER_COUNT),
                              (state.commitment / 4.0)[..., None],
                              (state.target_closing_speed / 12.0)[..., None]), axis=-1)
    tire = jnp.stack((state.tire_wear, (state.tire_temperature - 80.0) / 60.0), axis=-1)
    return jnp.concatenate((base, one_hot_class, state.physical / physical_scale, tire, *slots, memory), axis=-1)


def _vehicle_substep(cars, physical, previous_steer, line_target, closing_target,
                     ers_request, committed, track):
    progress, lateral, heading, speed_raw, yaw_rate, beta, _, soc = jnp.moveaxis(cars, -1, 0)
    mass, mu, downforce_k, drive_accel, _, brake_accel = jnp.moveaxis(physical, -1, 0)
    curvature, nominal_speed = track_lookup(progress + jnp.clip(speed_raw * 0.45, 8, 24), track)
    speed = jnp.maximum(1.0, speed_raw)
    line_error = lateral - line_target
    desired_heading = jnp.clip(-line_error * 0.045, -0.28, 0.28)
    heading_error = desired_heading - heading
    steer_command = driver_steering(previous_steer, heading_error, line_error, yaw_rate,
                                    PHYSICS_DT, committed=committed)
    steer = steer_command * 0.55
    class_speed_scale = jnp.where(downforce_k > 3.0, 1.0, jnp.where(downforce_k > 1.0, 0.86, 0.73))
    target_speed = jnp.clip(nominal_speed * class_speed_scale + closing_target, 4.0, 95.0)
    speed_error = target_speed - speed
    throttle, brake = driver_pedals(speed_error, jnp.abs(curvature) < 0.0038,
                                     jnp.zeros_like(speed_error, dtype=bool), speed, target_speed, heading_error)
    front_axle, rear_axle = 1.3624, 1.2576
    alpha_front = steer - beta - front_axle * yaw_rate / jnp.maximum(4.0, speed)
    alpha_rear = -beta + rear_axle * yaw_rate / jnp.maximum(4.0, speed)
    normal = mass * 9.81 + downforce_k * speed * speed
    max_lateral = mu * normal
    front_raw, rear_raw = 86000.0 * alpha_front, 90000.0 * alpha_rear
    force_scale = jnp.minimum(1.0, max_lateral / jnp.maximum(1.0, jnp.abs(front_raw) + jnp.abs(rear_raw)))
    front, rear = front_raw * force_scale, rear_raw * force_scale
    can_deploy = (ers_request > 0.01) & (soc > 0.04) & (physical[..., 2] > 3.0) & (throttle > 0.05)
    ers_accel = jnp.where(can_deploy, 120000.0 * ers_request / jnp.maximum(4.0, speed) / mass, 0.0)
    accel = throttle * drive_accel + ers_accel - brake * brake_accel - 0.00062 * speed * speed - 0.11
    beta_dot = (front + rear) / (mass * jnp.maximum(4.0, speed)) - yaw_rate
    yaw_dot = (front_axle * front - rear_axle * rear) / (mass * 1.36)
    next_speed = jnp.maximum(0.0, speed + accel * PHYSICS_DT)
    next_beta = jnp.clip(beta + beta_dot * PHYSICS_DT, -0.42, 0.42)
    next_yaw = jnp.clip(yaw_rate + yaw_dot * PHYSICS_DT, -2.8, 2.8)
    next_heading = jnp.clip(heading + (next_yaw - curvature * next_speed) * PHYSICS_DT, -jnp.pi, jnp.pi)
    velocity_heading = next_heading + next_beta
    progress_delta = jnp.maximum(0.0, next_speed * jnp.cos(velocity_heading) * PHYSICS_DT)
    next_lateral = lateral + next_speed * jnp.sin(velocity_heading) * PHYSICS_DT
    tire_util = (jnp.abs(front_raw) + jnp.abs(rear_raw)) / jnp.maximum(1.0, max_lateral)
    # Browser hybrid control also harvests under braking and on meaningful
    # high-speed lift.  This matters on Endurance Park where the Prototype can
    # complete much of the lap with little friction braking.
    can_regen = (physical[..., 2] > 3.0) & (soc < 0.995) & ((brake > 0.015) | ((throttle < 0.22) & (speed > 22.0)))
    regen_power = jnp.where(can_regen, (45000.0 * brake + 18000.0 * (1.0 - throttle)), 0.0)
    next_soc = jnp.clip(soc + (regen_power - jnp.where(can_deploy, 120000.0 * ers_request, 0.0))
                        * PHYSICS_DT / 8e6, 0, 1)
    next_cars = jnp.stack((progress + progress_delta, next_lateral, next_heading, next_speed,
                           next_yaw, next_beta, tire_util, next_soc), axis=-1)
    return next_cars, steer_command, jnp.stack((steer_command, throttle, brake), axis=-1), progress_delta


def stage5_env_step(state: Stage5State, action: jax.Array, track: dict) -> Stage5Step:
    cars = state.cars
    batch, agents, _ = cars.shape
    requested, corridor_norm, closing, ers, duration = decode_action(action)
    target_index, target_present = _nearest_targets(cars, track["length"])
    gap, _, _ = _pairwise(cars, track["length"])
    target_gap = _take_opponent(gap, target_index)
    target_lateral = _take_opponent(jnp.broadcast_to(cars[:, None, :, 1], (batch, agents, agents)), target_index)
    road_margin = 5.45
    requested_corridor = corridor_norm * road_margin
    # Track positive lateral is driver-left, matching the browser Frenet frame.
    requested_corridor = jnp.where(requested == ATTACK_LEFT, target_lateral + 3.9, requested_corridor)
    requested_corridor = jnp.where(requested == ATTACK_RIGHT, target_lateral - 3.9, requested_corridor)
    requested_corridor = jnp.where(requested == DEFEND_LEFT, 3.7, requested_corridor)
    requested_corridor = jnp.where(requested == DEFEND_RIGHT, -3.7, requested_corridor)
    reference_line = reference_lookup(cars[..., 0] + jnp.clip(cars[..., 3] * 0.6, 12.0, 30.0), track)[0]
    follow_line = jnp.where(target_present, target_lateral, reference_line)
    requested_corridor = jnp.where((requested == FOLLOW) | (requested == DRAFT), follow_line, requested_corridor)
    requested_corridor = jnp.clip(requested_corridor, -road_margin, road_margin)
    target_speed = cars[..., 3] + jnp.maximum(0.0, closing)
    safe, clearance, target_separation = validate_corridor(cars, requested_corridor, target_index,
                                                            target_speed, track["length"], road_margin)
    attack = (requested == ATTACK_LEFT) | (requested == ATTACK_RIGHT) | (requested == LATE_BRAKE) | (requested == SWITCHBACK)
    requested = jnp.where(attack & (~target_present | ~safe | (target_separation < 3.45)), ABORT, requested)
    still_committed = (state.commitment > 0) & (state.maneuver != ABORT) & safe
    deployed = jnp.where(still_committed, state.maneuver, requested)
    deployed_corridor = jnp.where(still_committed, state.target_corridor, requested_corridor)
    deployed_closing = jnp.where(still_committed, state.target_closing_speed, closing)
    deployed_ers = jnp.where(still_committed, state.ers_request, ers)
    deployed_duration = jnp.where(still_committed, state.commitment - DECISION_DT,
                                  jnp.where(deployed == ABORT, 0.0, duration))
    # ABORT immediately returns to the current lane and removes acceleration authority.
    deployed_corridor = jnp.where(deployed == ABORT, cars[..., 1], deployed_corridor)
    deployed_closing = jnp.where(deployed == ABORT, jnp.minimum(0.0, closing), deployed_closing)
    # Tactical RL must not erase the human-informed solo baseline.  With no
    # traffic target, line, pace and deployment remain deterministic.
    reference_ers = reference_lookup(cars[..., 0], track)[3]
    deployed_closing = jnp.where(target_present, deployed_closing, 0.0)
    deployed_ers = jnp.where(target_present, deployed_ers, reference_ers)

    next_cars, next_steer = cars, state.steer_command
    next_wear, next_temperature = state.tire_wear, state.tire_temperature
    controls, progress_delta = jnp.zeros((*cars.shape[:2], 3)), jnp.zeros(cars.shape[:2])
    committed_mask = (deployed != FOLLOW) & (deployed != DRAFT) & (deployed != ABORT)
    for _ in range(PHYSICS_SUBSTEPS):
        next_cars, next_steer, controls, sub_progress = _vehicle_substep(
            next_cars, state.physical, next_steer, deployed_corridor, deployed_closing,
            deployed_ers, committed_mask, track)
        progress_delta += sub_progress
        utilization = jnp.maximum(0.0, next_cars[..., 6])
        next_wear = jnp.clip(next_wear + (0.00010 + jnp.maximum(0.0, utilization - 0.72) ** 2 * 0.0018) * PHYSICS_DT, 0, 1)
        next_temperature += (utilization ** 2 * 2.4 - (next_temperature - 24.0) * 0.015) * PHYSICS_DT

    old_gap, _, _ = _pairwise(cars, track["length"])
    next_gap, next_lateral, _ = _pairwise(next_cars, track["length"])
    diagonal = jnp.eye(agents, dtype=bool)[None, ...]
    contact = (jnp.abs(next_gap) < 4.7) & (jnp.abs(next_lateral) < 1.9) & ~diagonal
    deep_contact = (jnp.abs(next_gap) < 3.6) & (jnp.abs(next_lateral) < 1.45) & ~diagonal
    new_contact = contact & ~state.contact_active
    tainted = state.tainted | contact
    crossed = (old_gap > 0) & (next_gap <= 0) & ~diagonal
    timer = jnp.where(crossed & ~tainted & ~contact, DECISION_DT, state.pass_timer)
    holding = (timer > 0) & (next_gap < -5) & ~contact
    timer = jnp.where(holding, timer + DECISION_DT, timer)
    timer = jnp.where((timer > 0) & ((next_gap > 3) | contact), 0.0, timer)
    clean_pass = (timer >= 2.0) & (state.pass_timer < 2.0)
    timer = jnp.where(clean_pass, -1.0, timer)
    timer = jnp.where(diagonal, -1.0, timer)
    tainted = jnp.where((next_gap > 10) | clean_pass, False, tainted)
    upper = jnp.triu(jnp.ones((agents, agents), dtype=bool), 1)[None, ...]
    off = jnp.abs(next_cars[..., 1]) > 7.2
    forced_off = off[:, None, :] & contact
    alternate_left = jnp.clip(target_lateral + 3.9, -road_margin, road_margin)
    alternate_right = jnp.clip(target_lateral - 3.9, -road_margin, road_margin)
    left_safe, left_clearance, _ = validate_corridor(
        cars, alternate_left, target_index, target_speed, track["length"], road_margin)
    right_safe, right_clearance, _ = validate_corridor(
        cars, alternate_right, target_index, target_speed, track["length"], road_margin)
    opportunity = target_present & (target_gap < 30) & (cars[..., 3] > _take_opponent(
        jnp.broadcast_to(cars[:, None, :, 3], (batch, agents, agents)), target_index) + 1.0) & (left_safe | right_safe)
    wasted_opportunity = opportunity & ((deployed == FOLLOW) | (deployed == DRAFT) | (deployed == ABORT))
    committed_attack = opportunity & ((deployed == ATTACK_LEFT) | (deployed == ATTACK_RIGHT)
                                      | (deployed == LATE_BRAKE) | (deployed == SWITCHBACK))
    best_left = left_safe & (~right_safe | (left_clearance >= right_clearance))
    correct_pass_side = ((deployed == ATTACK_LEFT) & best_left) | ((deployed == ATTACK_RIGHT) & ~best_left & right_safe)
    wrong_pass_side = opportunity & ((deployed == ATTACK_LEFT) | (deployed == ATTACK_RIGHT)) & ~correct_pass_side
    scenario = state.scenario_id[:, None]
    draft_phase = (scenario == CONFIG["curriculum"].index("DRAFT_PULL_OUT")) & (target_gap > 18.0)
    pullout_phase = (scenario == CONFIG["curriculum"].index("DRAFT_PULL_OUT")) & (target_gap <= 18.0)
    switchback_phase = scenario == CONFIG["curriculum"].index("SWITCHBACK_AFTER_BLOCK")
    braking_attack_phase = scenario == CONFIG["curriculum"].index("INSIDE_BRAKING_ATTACK")
    pair_gap, pair_lateral, pair_relative = _pairwise(cars, track["length"])
    diagonal_agents = jnp.eye(agents, dtype=bool)[None, ...]
    challenger = jnp.any((pair_gap < -3.0) & (pair_gap > -25.0) & (jnp.abs(pair_lateral) < 4.4)
                         & (pair_relative > 1.0) & ~diagonal_agents, axis=-1)
    defensive_move = (deployed == DEFEND_LEFT) | (deployed == DEFEND_RIGHT)
    old_target_separation = jnp.abs(cars[..., 1] - target_lateral)
    next_target_lateral = _take_opponent(jnp.broadcast_to(next_cars[:, None, :, 1],
                                                          (batch, agents, agents)), target_index)
    lateral_clearance_gain = jnp.clip(jnp.abs(next_cars[..., 1] - next_target_lateral)
                                      - old_target_separation, -0.5, 0.5)
    overlap = (jnp.abs(next_gap) < 4.7) & (jnp.abs(next_lateral) >= 1.9) & ~diagonal
    relative_gain = progress_delta - jnp.mean(progress_delta, axis=1, keepdims=True)
    clean_count = jnp.sum(clean_pass.astype(cars.dtype), axis=-1)
    contact_count = jnp.sum(contact.astype(cars.dtype), axis=-1)
    ideal_temperature = jnp.take(jnp.asarray([94.0, 88.0, 82.0]), state.class_id)
    wear_cost = (next_wear - state.tire_wear) * 180.0
    temperature_cost = jnp.maximum(0.0, next_temperature - ideal_temperature - 8.0) ** 2 * 0.0012
    reward = (progress_delta * 0.22 + relative_gain * 2.6 + clean_count * 150.0
              + jnp.sum(overlap.astype(cars.dtype), axis=-1) * 0.28
              + committed_attack.astype(cars.dtype) * 0.42
              + correct_pass_side.astype(cars.dtype) * 0.72
              - wrong_pass_side.astype(cars.dtype) * 0.95
              + (draft_phase & (deployed == DRAFT)).astype(cars.dtype) * 0.32
              + (pullout_phase & ((deployed == ATTACK_LEFT) | (deployed == ATTACK_RIGHT))).astype(cars.dtype) * 0.52
              + (switchback_phase & (deployed == SWITCHBACK)).astype(cars.dtype) * 0.62
              + (braking_attack_phase & (deployed == LATE_BRAKE)).astype(cars.dtype) * 0.42
              + (challenger & defensive_move).astype(cars.dtype) * 0.34
              + jnp.where(committed_attack, jnp.maximum(0.0, lateral_clearance_gain) * 1.8, 0.0)
              + jnp.where(committed_attack, controls[..., 1] * 0.18, 0.0)
              - wasted_opportunity.astype(cars.dtype) * 1.6
              - contact_count * 35.0 - jnp.sum(deep_contact.astype(cars.dtype), axis=-1) * 85.0
              - jnp.sum(forced_off.astype(cars.dtype), axis=-1) * 240.0
              - off.astype(cars.dtype) * 90.0 - wear_cost - temperature_cost)
    done = jnp.any(off, axis=-1) | jnp.any(deep_contact, axis=(1, 2)) | ~jnp.all(jnp.isfinite(reward), axis=-1)
    metrics = jnp.stack((jnp.sum(clean_pass.astype(cars.dtype), axis=(1, 2)),
                         jnp.sum((new_contact & upper).astype(cars.dtype), axis=(1, 2)),
                         jnp.sum((deep_contact & upper).astype(cars.dtype), axis=(1, 2)),
                         jnp.sum(forced_off.astype(cars.dtype), axis=(1, 2)),
                         jnp.sum(wasted_opportunity.astype(cars.dtype), axis=1),
                         jnp.sum(overlap.astype(cars.dtype), axis=(1, 2)),
                         jnp.mean(progress_delta, axis=1), done.astype(cars.dtype)), axis=-1)
    next_state = Stage5State(next_cars, state.class_id, state.physical, next_wear, next_temperature, deployed, target_index,
                             deployed_corridor, deployed_closing, deployed_ers, deployed_duration, next_steer,
                             timer, tainted, contact, state.scenario_id)
    return Stage5Step(next_state, controls, reward, done, metrics)


def reset_done(state: Stage5State, fresh: Stage5State, done: jax.Array) -> Stage5State:
    return jax.tree.map(lambda old, new: jnp.where(done.reshape((done.shape[0],) + (1,) * (old.ndim - 1)), new, old), state, fresh)


STAGE5_OBSERVATION_SIZE = 19 + 3 + 6 + 2 + 3 * 8 + MANEUVER_COUNT + 2

__all__ = ["ACTION_SIZE", "MANEUVERS", "PACK_CARS", "STAGE5_OBSERVATION_SIZE", "Stage5State",
           "Stage5Step", "decode_action", "driver_pedals", "driver_steering", "load_track", "minimum_jerk", "observe_stage5",
           "reset_done", "reset_stage5_batch", "stage5_env_step", "validate_corridor"]
