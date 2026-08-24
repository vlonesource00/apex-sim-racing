from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import jax.numpy as jnp
import numpy as np

from jax_stage5 import driver_pedals, driver_steering, minimum_jerk, validate_corridor

ROOT = Path(__file__).resolve().parents[1]
node = shutil.which("node") or shutil.which("node.exe")
if not node:
    raise RuntimeError("Node.js is required to generate authoritative browser parity vectors")
script = str(ROOT / "tools" / "stage5-parity-vectors.mjs")
if node.endswith(".exe") and script.startswith("/mnt/"):
    script = f"{script[5].upper()}:{script[6:]}"
payload = json.loads(subprocess.check_output([node, script], text=True))

samples = jnp.asarray([0, 0.1, 0.25, 0.5, 0.75, 1], dtype=jnp.float32)
np.testing.assert_allclose(np.asarray(minimum_jerk(samples)), payload["minimumJerk"], atol=1e-6, rtol=0)

for case in payload["controls"]:
    values = case["input"]
    steering = driver_steering(values["previous"], values["headingError"], values["lateralError"],
                               values["yawRate"], values["dt"], values["committed"],
                               values["recovering"], values["yielding"])
    throttle, brake = driver_pedals(values["speedError"], values["straight"], values["recovering"],
                                     values["vehicleSpeed"], values["desiredSpeed"], values["headingError"])
    np.testing.assert_allclose(float(steering), case["steering"], atol=1e-6, rtol=0)
    np.testing.assert_allclose([float(throttle), float(brake)],
                               [case["pedals"]["throttle"], case["pedals"]["brake"]], atol=1e-6, rtol=0)

for scenario in payload["scenarios"]:
    cars = jnp.asarray([scenario["cars"]], dtype=jnp.float32)
    terminal = jnp.asarray([scenario["terminal"]], dtype=jnp.float32)
    target = jnp.asarray([scenario["target"]], dtype=jnp.int32)
    target_speed = cars[..., 3] + 7.0
    safe, clearance, separation = validate_corridor(cars, terminal, target, target_speed, 3120.0, 5.45)
    expected = scenario["output"]
    np.testing.assert_array_equal(np.asarray(safe[0]), [item["collisionFree"] and item["legal"] for item in expected])
    np.testing.assert_allclose(np.asarray(clearance[0]), [item["minimumClearanceM"] for item in expected], atol=2e-4, rtol=0)
    np.testing.assert_allclose(np.asarray(separation[0]), [item["targetSeparationM"] for item in expected], atol=1e-6, rtol=0)

print(json.dumps({"status": "passed", "scenarios": len(payload["scenarios"]),
                  "carsPerScenario": 4, "corridorSamples": 18,
                  "controlVectors": len(payload["controls"]),
                  "contract": "browser corridor + deterministic driver == JAX deployment stack"}))
