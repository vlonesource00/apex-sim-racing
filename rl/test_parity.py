from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import jax
import jax.numpy as jnp
import numpy as np

jax.config.update("jax_enable_x64", True)

from jax_vehicle import reduced_step

ROOT = Path(__file__).resolve().parents[1]
rng = np.random.default_rng(73)
payload = {
    "initial": {"progressM": 120.0, "lateralM": 0.15, "headingErrorRad": 0.01, "speedMps": 34.0, "ersSoc": 0.74},
    "frames": []
}
for index in range(500):
    payload["frames"].append({
        "action": np.clip(rng.normal([0.0, 0.15, 0.0, 0.25], [0.35, 0.25, 0.25, 0.4]), -1, 1).tolist(),
        "track": {"curvature": float(0.006 + np.sin(index * 0.031) * 0.004), "targetSpeedMps": float(42 + np.cos(index * 0.017) * 5)}
    })

with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
    json.dump(payload, handle)
    input_path = Path(handle.name)

try:
    js = json.loads(subprocess.check_output(["node", str(ROOT / "tests" / "rl-js-rollout.mjs"), str(input_path)], text=True))
finally:
    input_path.unlink(missing_ok=True)

state = jnp.asarray([120.0, 0.15, 0.01, 34.0, 0.0, 0.0, 0.0, 0.74], dtype=jnp.float64)
max_state_error = 0.0
max_control_error = 0.0
max_reward_error = 0.0
for frame, js_frame in zip(payload["frames"], js["trace"], strict=True):
    result = reduced_step(state, jnp.asarray(frame["action"], dtype=jnp.float64),
                          jnp.asarray(frame["track"]["curvature"], dtype=jnp.float64),
                          jnp.asarray(frame["track"]["targetSpeedMps"], dtype=jnp.float64))
    state = result.state
    max_state_error = max(max_state_error, float(np.max(np.abs(np.asarray(state) - np.asarray(js_frame["state"])))))
    controls = [js_frame["controls"][key] for key in ("steer", "throttle", "brake")]
    max_control_error = max(max_control_error, float(np.max(np.abs(np.asarray(result.controls) - controls))))
    max_reward_error = max(max_reward_error, abs(float(result.reward) - js_frame["reward"]))

metrics = {"frames": len(payload["frames"]), "maxStateError": max_state_error,
           "maxControlError": max_control_error, "maxRewardError": max_reward_error}
print(json.dumps(metrics, indent=2))
assert max_state_error < 1e-8
assert max_control_error < 1e-9
assert max_reward_error < 1e-9
