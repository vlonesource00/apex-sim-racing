// Car setups. Tuneable constants consumed by createCar / stepCar.
// Values aim at a ~1250 kg RWD GT race car on slicks (GT3/GT4 flavour).

export const CAR_CLASSES = {
  gt3: {
    name: 'GT3',
    mass: 1250,
    inertiaZ: 1900,          // yaw inertia kg m^2
    wheelbase: 2.62,
    trackWidth: 1.68,
    cgHeight: 0.30,
    weightDist: 0.46,        // fraction of static load on FRONT axle
    rollSplit: 0.52,         // fraction of lateral transfer taken by front axle

    wheelRadius: 0.33,
    wheelInertia: 1.35,      // kg m^2 per wheel

    // Engine / drivetrain
    peakPower: 410000,       // W (~550 hp)
    idleRpm: 1200,
    redline: 9000,
    torqueCurve: rpmTorqueGT3,
    gears: [3.10, 2.15, 1.60, 1.30, 1.08, 0.92], // 1..6
    reverse: 2.9,
    finalDrive: 3.70,
    driveWheels: 'rear',     // 'rear'|'front'|'all'
    diffPreload: 60,         // N m locking
    diffLock: 0.55,          // 0 open .. 1 locked

    // Brakes (sized for ~1.5g peak decel; threshold braking matters)
    brakeTorqueFront: 3600,  // N m total per axle at full pedal
    brakeTorqueRear: 2500,
    brakeBias: 0.59,         // fraction to front
    engineInertia: 0.28,     // kg m^2, reflected through gearbox

    // Aero
    aeroDragCd: 0.30,
    frontalArea: 1.95,
    downforceClFront: 0.62,  // Cl per axle (force = 0.5 rho v^2 A Cl)
    downforceClRear: 0.85,

    // Tires
    tire: {
      mu: 1.38,              // peak friction on track
      B: 11.5,               // stiffness factor
      C: 1.72,               // shape
      E: -0.55,              // curvature
      Fz0: 3200,             // nominal load N
      Ka: 0.86,              // load sensitivity exponent
    },

    rollingResistance: 0.010,
    dragAirDensity: 1.20,

    // Visual / body
    body: { length: 4.55, width: 1.98, height: 1.05 },
  },
};

// Torque (N m) vs rpm for the GT3 engine. Broad, flat-ish curve, sharp cut at redline.
function rpmTorqueGT3(rpm) {
  const r = Math.max(rpm, 0);
  if (r > 9200) return 0; // limiter
  // Normalized shape
  const x = r / 9000;
  // Rise quickly, plateau, slight fall, then limiter cut
  let t = 430 * (1 - Math.pow(Math.abs(x - 0.62) / 0.62, 2.2) * 0.32);
  if (x < 0.18) t *= x / 0.18 * 0.85 + 0.15; // weak below ~1600 rpm
  if (r > 9000) t *= Math.max(0, 1 - (r - 9000) / 200); // soft cut
  return Math.max(t, 60);
}

export function getSetup(id) {
  return CAR_CLASSES[id] || CAR_CLASSES.gt3;
}
