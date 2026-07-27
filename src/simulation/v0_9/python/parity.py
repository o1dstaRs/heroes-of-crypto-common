#!/usr/bin/env python3
"""Reference fixed-point inference used for Python/Bun parity fixtures."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

INT16_MAX = 32767
INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1


def round_half_away(value: float) -> int:
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def divide_half_away(value: int, divisor: int) -> int:
    magnitude = (abs(value) + divisor // 2) // divisor
    return magnitude if value >= 0 else -magnitude


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def score(artifact: dict[str, Any], raw_features: list[float]) -> int:
    architecture = artifact["architecture"]
    if len(raw_features) != architecture["inputSize"]:
        raise ValueError("parity feature width mismatch")
    normalization = artifact["normalization"]
    fixed = artifact["fixedPoint"]
    activations = []
    for index, raw in enumerate(raw_features):
        if not isinstance(raw, (int, float)) or not math.isfinite(raw):
            raise ValueError(f"feature {index} is not finite")
        normalized = (raw - normalization["offsets"][index]) * normalization["scales"][index]
        clipped = max(-fixed["inputClip"], min(fixed["inputClip"], normalized))
        activations.append(clamp(round_half_away(clipped * fixed["inputScale"]), -INT16_MAX, INT16_MAX))

    for layer in artifact["layers"]:
        if len(activations) != layer["inputSize"]:
            raise ValueError("dense layer shape mismatch")
        output = []
        divisor = 2 ** layer["scaleShift"]
        for row in range(layer["outputSize"]):
            accumulator = layer["biases"][row]
            offset = row * layer["inputSize"]
            for column, activation in enumerate(activations):
                accumulator += activation * layer["weights"][offset + column]
            value = divide_half_away(accumulator, divisor)
            if layer["activation"] == "relu":
                value = max(0, value)
                value = clamp(value, -INT16_MAX, INT16_MAX)
            else:
                value = clamp(value, INT32_MIN, INT32_MAX)
            output.append(value)
        activations = output
    return int(activations[0])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--vectors", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    if (
        artifact.get("schema") != "hoc.ai.v0_9_model.v1"
        or artifact.get("status") != "trained"
        or artifact.get("promoted") is not False
        or not artifact.get("modelSha256")
    ):
        raise ValueError("parity requires a sealed, unpromoted v0.9 research artifact")
    with args.vectors.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            vector = json.loads(line)
            identifier = vector.get("id", f"line-{line_number}")
            value = score(artifact, vector["features"])
            expected = vector.get("expectedScore")
            if expected is not None and expected != value:
                raise ValueError(f"{identifier} expected {expected}, received {value}")
            print(json.dumps({"id": identifier, "score": value}, separators=(",", ":")))


if __name__ == "__main__":
    main()
