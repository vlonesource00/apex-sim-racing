import { clamp } from '../core/math.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function steeringCommand({ previous = 0, headingError = 0, lateralError = 0,
  yawRate = 0, dt = 0, committed = false, recovering = false, yielding = false } = {}) {
  const headingGain = recovering ? 2.8 : committed ? 3.45 : 2.25;
  const lateralGain = recovering ? 0.085 : committed ? 0.08 : 0.055;
  const yawDamping = committed ? 0.12 : 0.17;
  let target = clamp(finite(headingError) * headingGain
    - finite(lateralError) * lateralGain - finite(yawRate) * yawDamping, -1, 1);
  if (yielding) target = clamp(target, -0.3, 0.3);
  const rate = committed ? 7.5 : recovering ? 6 : 5.2;
  return clamp(finite(previous) + clamp(target - finite(previous),
    -rate * clamp(finite(dt), 0, 0.1), rate * clamp(finite(dt), 0, 0.1)), -1, 1);
}

export function basePedals({ speedError = 0, straight = false, recovering = false,
  vehicleSpeed = 0, desiredSpeed = 0, headingError = 0 } = {}) {
  let throttle = speedError > -0.6
    ? clamp((straight ? 0.92 : 0.48) + finite(speedError) * 0.14, 0, 1) : 0;
  let brake = clamp((-finite(speedError) - 1.1) * 0.15, 0, 1);
  if (recovering) {
    throttle = vehicleSpeed < desiredSpeed ? (Math.abs(headingError) > 1.15 ? 0.35 : 0.68) : 0;
    brake = vehicleSpeed > desiredSpeed + 2.5
      ? clamp(0.25 + (vehicleSpeed - desiredSpeed) * 0.035, 0.25, 0.78) : 0;
  }
  return { throttle, brake };
}
