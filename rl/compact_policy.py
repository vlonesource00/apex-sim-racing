from __future__ import annotations

import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
parser.add_argument("--digits", type=int, default=6)
args = parser.parse_args()
payload = json.loads(args.source.read_text(encoding="utf-8"))
for layer in payload["layers"]:
    layer["weight"] = [[round(value, args.digits) for value in row] for row in layer["weight"]]
    layer["bias"] = [round(value, args.digits) for value in layer["bias"]]
payload.setdefault("metadata", {})["quantization"] = f"decimal-{args.digits}"
args.destination.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
print(json.dumps({"sourceBytes": args.source.stat().st_size, "destinationBytes": args.destination.stat().st_size,
                  "ratio": args.destination.stat().st_size / args.source.stat().st_size}, indent=2))
