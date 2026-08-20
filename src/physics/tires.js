// Pacejka-style combined-slip tire model on a friction circle.
// Returns forces in the wheel frame: fx = longitudinal (+forward), fy = lateral (+left).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Load sensitivity: friction coefficient falls as load rises (tires saturate).
// D = mu * Fz0 * (Fz / Fz0)^Ka  with Ka < 1  =>  effective mu drops with load.
export function tirePeak(p, load, surfaceMu = 1) {
  const L = Math.max(load, 1);
  return p.mu * surfaceMu * p.Fz0 * Math.pow(L / p.Fz0, p.Ka);
}

// Magic Formula magnitude curve evaluated at slip magnitude x.
export function magicMag(p, D, x) {
  const Bx = p.B * x;
  return D * Math.sin(p.C * Math.atan(Bx - p.E * (Bx - Math.atan(Bx))));
}

/**
 * @param {object} p tire params {mu, B, C, E, Fz0, Ka, gripLowSpeed}
 * @param {number} load      vertical load N
 * @param {number} slipRatio longitudinal slip kappa
 * @param {number} slipAngle lateral slip rad
 * @param {number} speed     wheel forward speed m/s (for low-speed blending)
 * @param {number} surfaceMu multiplier for the current surface (grass etc.)
 */
export function tireForces(p, load, slipRatio, slipAngle, speed, surfaceMu = 1) {
  const D = tirePeak(p, load, surfaceMu);
  const sx = clamp(slipRatio, -3, 3);
  const sy = Math.tan(clamp(slipAngle, -0.6, 0.6));
  const smag = Math.sqrt(sx * sx + sy * sy);
  const lowSpeed = clamp(speed / 4, 0, 1);
  const F = smag > 1e-6 ? magicMag(p, D, smag) * (0.25 + 0.75 * lowSpeed) : 0;
  const inv = F / (smag + 1e-6);
  return { fx: sx * inv, fy: -sy * inv, F, D };
}

// Aligning torque approximation for force-feedback / steering feel.
export function aligningTorque(p, load, slipAngle, speed) {
  const { fy } = tireForces(p, load, 0, slipAngle, speed, 1);
  const trail = 0.05 * clamp(1 - Math.abs(slipAngle) / 0.35, 0.1, 1); // pneumatic trail shrinks near limit
  return -fy * trail;
}

export const SURFACE = {
  track: { mu: 1.0, rr: 0.010, bump: 0.0 },
  curb:  { mu: 0.96, rr: 0.012, bump: 0.5 },
  grass: { mu: 0.55, rr: 0.055, bump: 0.8 },
  gravel:{ mu: 0.62, rr: 0.075, bump: 1.0 },
  wet:   { mu: 0.72, rr: 0.012, bump: 0.0 },
};
