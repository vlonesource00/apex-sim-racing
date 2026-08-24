from __future__ import annotations

import json
from pathlib import Path
from typing import NamedTuple

import jax
import jax.numpy as jnp
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((Path(__file__).parent / "model_config.json").read_text(encoding="utf-8"))


class StepResult(NamedTuple):
    state: jax.Array
    controls: jax.Array
    reward: jax.Array
    done: jax.Array


def load_track(path: Path | None = None, reference_path: Path | None = None) -> dict[str, jax.Array | float]:
    payload = json.loads((path or Path(__file__).parent / "track_profile.json").read_text(encoding="utf-8"))
    samples = payload["samples"]
    target_speed = np.asarray([sample["targetSpeedMps"] for sample in samples], dtype=np.float32)
    reference_line = np.zeros_like(target_speed)
    reference_throttle = np.zeros_like(target_speed)
    reference_brake = np.zeros_like(target_speed)
    reference_ers = np.zeros_like(target_speed)
    if reference_path is not None:
        reference = json.loads(reference_path.read_text(encoding="utf-8"))
        if not reference.get("complete", False):
            raise ValueError(f"Reference lap is incomplete: {reference_path}")
        reference_samples = reference.get("samples", [])
        if len(reference_samples) < 32:
            raise ValueError(f"Reference lap has too few samples: {reference_path}")
        reference_s = np.asarray([sample["s"] for sample in reference_samples], dtype=np.float64)
        reference_speed = np.asarray([sample["speed"] for sample in reference_samples], dtype=np.float64)
        reference_lateral = np.asarray([sample.get("lateral", 0.0) for sample in reference_samples], dtype=np.float64)
        reference_throttle_samples = np.asarray([sample.get("throttle", 0.0) for sample in reference_samples], dtype=np.float64)
        reference_brake_samples = np.asarray([sample.get("brake", 0.0) for sample in reference_samples], dtype=np.float64)
        reference_soc = np.asarray([sample.get("ersSoc", 0.0) for sample in reference_samples], dtype=np.float64)
        order = np.argsort(reference_s)
        reference_s = reference_s[order]
        reference_speed = reference_speed[order]
        reference_lateral = reference_lateral[order]
        reference_throttle_samples = reference_throttle_samples[order]
        reference_brake_samples = reference_brake_samples[order]
        reference_soc = reference_soc[order]
        unique_s, unique_index = np.unique(reference_s, return_index=True)
        reference_speed = reference_speed[unique_index]
        reference_lateral = reference_lateral[unique_index]
        reference_throttle_samples = reference_throttle_samples[unique_index]
        reference_brake_samples = reference_brake_samples[unique_index]
        reference_soc = reference_soc[unique_index]
        track_s = np.asarray([sample.get("s", index / len(samples) * payload["lengthM"])
                              for index, sample in enumerate(samples)], dtype=np.float64)
        target_speed = np.interp(track_s, unique_s, reference_speed, period=float(payload["lengthM"])).astype(np.float32)
        reference_line = np.interp(track_s, unique_s, reference_lateral, period=float(payload["lengthM"])).astype(np.float32)
        reference_throttle = np.interp(track_s, unique_s, reference_throttle_samples,
                                       period=float(payload["lengthM"])).astype(np.float32)
        reference_brake = np.interp(track_s, unique_s, reference_brake_samples,
                                    period=float(payload["lengthM"])).astype(np.float32)
        interpolated_soc = np.interp(track_s, unique_s, reference_soc, period=float(payload["lengthM"])).astype(np.float32)
        # Positive values represent a human deployment request.  Harvesting is
        # handled by the deterministic hybrid controller, not learned as a
        # negative tactical action.
        reference_ers = np.clip((interpolated_soc - np.roll(interpolated_soc, -1)) * 95.0, 0.0, 1.0)
        # Remove one-frame recording noise without erasing real braking zones.
        radius = 3
        padded = np.concatenate((target_speed[-radius:], target_speed, target_speed[:radius]))
        target_speed = np.convolve(padded, np.ones(radius * 2 + 1) / (radius * 2 + 1), mode="valid").astype(np.float32)
    return {
        "length": float(payload["lengthM"]),
        "curvature": jnp.asarray([sample["curvature"] for sample in samples], dtype=jnp.float32),
        "target_speed": jnp.asarray(target_speed, dtype=jnp.float32),
        "reference_line": jnp.asarray(reference_line, dtype=jnp.float32),
        "reference_throttle": jnp.asarray(reference_throttle, dtype=jnp.float32),
        "reference_brake": jnp.asarray(reference_brake, dtype=jnp.float32),
        "reference_ers": jnp.asarray(reference_ers, dtype=jnp.float32),
    }


def track_lookup(progress: jax.Array, track: dict[str, jax.Array | float]) -> tuple[jax.Array, jax.Array]:
    count = track["curvature"].shape[0]
    index = jnp.floor(jnp.mod(progress, track["length"]) / track["length"] * count).astype(jnp.int32)
    return track["curvature"][index], track["target_speed"][index]


def reference_lookup(progress: jax.Array, track: dict[str, jax.Array | float]):
    count = track["curvature"].shape[0]
    index = jnp.floor(jnp.mod(progress, track["length"]) / track["length"] * count).astype(jnp.int32)
    return (track["reference_line"][index], track["reference_throttle"][index],
            track["reference_brake"][index], track["reference_ers"][index])


def reduced_step(state: jax.Array, action: jax.Array, curvature: jax.Array, nominal_target_speed: jax.Array) -> StepResult:
    c = CONFIG
    ctrl = c["controller"]
    ers = c["ers"]
    dt = c["dt"]
    progress, lateral, heading, speed_raw, yaw_rate, beta, _, ers_soc_raw = jnp.moveaxis(state, -1, 0)
    speed = jnp.maximum(1.0, speed_raw)
    ers_soc = jnp.clip(ers_soc_raw, 0.0, 1.0)
    action = jnp.clip(action, -1.0, 1.0)
    line_target = action[..., 0] * c["roadHalfWidthM"] * c["lineOffsetFraction"]
    pace = 0.72 + (action[..., 1] + 1.0) * 0.165
    aggression = 0.88 + (action[..., 2] + 1.0) * 0.08
    ers_request = action[..., 3]
    target_speed = jnp.clip(nominal_target_speed, 8.0, 95.0) * pace
    line_error = lateral - line_target
    desired_heading = jnp.clip(-line_error * 0.045, -0.28, 0.28)
    heading_control_error = heading - desired_heading
    steer = jnp.clip((
        -ctrl["headingGain"] * heading_control_error
        - ctrl["lineGain"] * line_error
        - ctrl["yawGain"] * yaw_rate
    ) * aggression, -c["maxSteerRad"], c["maxSteerRad"])
    speed_error = target_speed - speed
    throttle = jnp.clip(speed_error * ctrl["speedThrottleGain"], 0.0, 1.0)
    brake = jnp.clip(-speed_error * ctrl["speedBrakeGain"], 0.0, 1.0)

    safe_speed = jnp.maximum(4.0, speed)
    alpha_front = steer - beta - c["frontAxleM"] * yaw_rate / safe_speed
    alpha_rear = -beta + c["rearAxleM"] * yaw_rate / safe_speed
    downforce = c["aeroDownforcePerSpeed2"] * speed * speed
    normal_total = c["massKg"] * 9.81 + downforce
    max_lateral = c["tireMu"] * normal_total
    front_force_raw = c["corneringFrontNPerRad"] * alpha_front
    rear_force_raw = c["corneringRearNPerRad"] * alpha_rear
    requested_lateral = jnp.abs(front_force_raw) + jnp.abs(rear_force_raw)
    lateral_scale = jnp.minimum(1.0, max_lateral / jnp.maximum(1.0, requested_lateral))
    front_force = front_force_raw * lateral_scale
    rear_force = rear_force_raw * lateral_scale

    can_deploy = (ers_request > 0.0) & (ers_soc > ers["minSoc"]) & (throttle > 0.05)
    can_regen = (ers_request < 0.0) & ((brake > 0.02) | (throttle < 0.05)) & (ers_soc < 0.999)
    ers_power = jnp.where(can_deploy, ers["maxPowerW"] * ers_request,
                          jnp.where(can_regen, ers["regenPowerW"] * ers_request, 0.0))
    ers_accel = jnp.where(can_deploy, ers_power / jnp.maximum(4.0, speed) / c["massKg"], 0.0)
    longitudinal_accel = (throttle * c["maxDriveAccelMps2"] + ers_accel
                          - brake * c["maxBrakeAccelMps2"]
                          - c["dragAccelPerSpeed2"] * speed * speed - c["rollingAccelMps2"])
    beta_dot = (front_force + rear_force) / (c["massKg"] * safe_speed) - yaw_rate
    yaw_dot = (c["frontAxleM"] * front_force - c["rearAxleM"] * rear_force) / c["yawInertiaKgM2"]
    next_speed = jnp.maximum(1.0, speed + longitudinal_accel * dt)
    next_beta = jnp.clip(beta + beta_dot * dt, -0.42, 0.42)
    next_yaw_rate = jnp.clip(yaw_rate + yaw_dot * dt, -2.8, 2.8)
    next_heading = jnp.clip(heading + (next_yaw_rate - curvature * next_speed) * dt, -jnp.pi, jnp.pi)
    velocity_heading = next_heading + next_beta
    progress_delta = jnp.maximum(0.0, next_speed * jnp.cos(velocity_heading) * dt)
    next_lateral = lateral + next_speed * jnp.sin(velocity_heading) * dt
    longitudinal_demand = jnp.abs(longitudinal_accel) * c["massKg"]
    tire_util = jnp.sqrt(requested_lateral ** 2 + longitudinal_demand ** 2) / jnp.maximum(1.0, max_lateral)
    next_soc = jnp.clip(ers_soc - ers_power * dt / ers["capacityJ"], 0.0, 1.0)
    off_track = jnp.abs(next_lateral) > c["roadHalfWidthM"]
    edge_risk = jnp.maximum(0.0, jnp.abs(next_lateral) - c["roadHalfWidthM"] * 0.76)
    reward = (progress_delta * 0.1 - next_lateral ** 2 * 0.012 - next_heading ** 2 * 0.35
              - next_beta ** 2 * 0.5 - edge_risk ** 2 * 0.18
              - jnp.maximum(0.0, tire_util - 1.0) ** 2 * 1.25
              - off_track.astype(state.dtype) * 30.0)
    next_state = jnp.stack((progress + progress_delta, next_lateral, next_heading, next_speed,
                            next_yaw_rate, next_beta, tire_util, next_soc), axis=-1)
    controls = jnp.stack((steer, throttle, brake), axis=-1)
    done = off_track | ~jnp.isfinite(reward)
    return StepResult(next_state, controls, reward, done)


def observe(state: jax.Array, track: dict[str, jax.Array | float]) -> jax.Array:
    progress = state[..., 0]
    speed = state[..., 3]
    offsets = jnp.asarray([0.0, 18.0, 40.0, 70.0, 110.0, 160.0], dtype=state.dtype)
    look_progress = progress[..., None] + offsets
    curvature, target_speed = track_lookup(look_progress, track)
    base = jnp.stack((
        state[..., 1] / CONFIG["roadHalfWidthM"], state[..., 2] / 0.5,
        speed / 80.0, state[..., 4] / 2.0, state[..., 5] / 0.3,
        state[..., 6] / 1.5, state[..., 7]
    ), axis=-1)
    return jnp.concatenate((base, curvature * 80.0, target_speed / 80.0), axis=-1)


def reset_batch(key: jax.Array, count: int, track_length: float) -> jax.Array:
    progress_key, lateral_key, speed_key = jax.random.split(key, 3)
    progress = jax.random.uniform(progress_key, (count,), minval=0.0, maxval=track_length)
    lateral = jax.random.normal(lateral_key, (count,)) * 0.35
    speed = jax.random.uniform(speed_key, (count,), minval=20.0, maxval=38.0)
    return jnp.stack((progress, lateral, jnp.zeros(count), speed, jnp.zeros(count),
                      jnp.zeros(count), jnp.zeros(count), jnp.full(count, 0.74)), axis=-1)


def shield_action(state: jax.Array, action: jax.Array) -> jax.Array:
    lateral = state[..., 1]
    heading = state[..., 2]
    speed = jnp.maximum(0.0, state[..., 3])
    beta = state[..., 5]
    projected_lateral = lateral + speed * jnp.sin(heading + beta) * 0.8
    warning_edge = CONFIG["roadHalfWidthM"] * 0.72
    risk_for = lambda value: jnp.clip((jnp.abs(value) - warning_edge) / (CONFIG["roadHalfWidthM"] - warning_edge), 0.0, 1.0)
    risk = jnp.maximum(risk_for(lateral), risk_for(projected_lateral))
    center_request = -jnp.sign(jnp.where(projected_lateral != 0, projected_lateral, lateral)) * 0.55
    action = jnp.clip(action, -1.0, 1.0)
    return jnp.stack((
        action[..., 0] * (1.0 - risk) + center_request * risk,
        jnp.minimum(action[..., 1], 0.12 - risk * 0.82),
        action[..., 2] * (1.0 - risk),
        jnp.minimum(action[..., 3], 0.25 - risk * 0.9)
    ), axis=-1)


def env_step(state: jax.Array, action: jax.Array, track: dict[str, jax.Array | float]) -> StepResult:
    curvature, target_speed = track_lookup(state[..., 0], track)
    return reduced_step(state, shield_action(state, action), curvature, target_speed)
