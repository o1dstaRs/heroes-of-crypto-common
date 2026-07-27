#!/usr/bin/env python3
"""Fail-closed preflight for the v0.9 RTX 5090 learner node."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

APPROVED_GPU_UUID = "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350"
PINNED_TORCH = "2.11.0+cu130"
PINNED_NUMPY = "2.2.6"


def command(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def nvidia_rows() -> list[dict[str, str]]:
    output = command(
        "nvidia-smi",
        "--query-gpu=uuid,name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
    )
    rows = []
    for line in output.splitlines():
        values = [value.strip() for value in line.split(",")]
        if len(values) != 4:
            raise RuntimeError(f"unexpected nvidia-smi row: {line}")
        rows.append(dict(zip(("uuid", "name", "memoryMiB", "driver"), values)))
    return rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu-uuid", required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--minimum-vram-mib", type=int, default=30_000)
    parser.add_argument("--minimum-free-disk-gib", type=int, default=100)
    parser.add_argument("--minimum-compute-capability", default="12.0")
    parser.add_argument("--expected-feature-hash", default="01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.gpu_uuid != APPROVED_GPU_UUID:
        raise RuntimeError(f"v0.9 requires the approved RTX 5090 UUID {APPROVED_GPU_UUID}")
    if sys.version_info < (3, 12):
        raise RuntimeError(f"Python 3.12+ is required, found {platform.python_version()}")
    try:
        import torch
    except ImportError as error:
        raise RuntimeError("PyTorch is not installed in the isolated v0.9 environment") from error
    try:
        import numpy
    except ImportError as error:
        raise RuntimeError("the pinned v0.9 environment is missing NumPy") from error
    if torch.__version__ != PINNED_TORCH or torch.version.cuda != "13.0":
        raise RuntimeError(f"expected torch {PINNED_TORCH}/CUDA 13.0, found {torch.__version__}/{torch.version.cuda}")
    if numpy.__version__ != PINNED_NUMPY:
        raise RuntimeError(f"expected numpy {PINNED_NUMPY}, found {numpy.__version__}")

    GPUs = nvidia_rows()
    selected = next((row for row in GPUs if row["uuid"].lower() == args.gpu_uuid.lower()), None)
    if selected is None:
        raise RuntimeError(f"GPU UUID {args.gpu_uuid} is not visible through nvidia-smi")
    if "5090" not in selected["name"]:
        raise RuntimeError(f"GPU UUID {args.gpu_uuid} is {selected['name']}, not an RTX 5090")
    if int(selected["memoryMiB"]) < args.minimum_vram_mib:
        raise RuntimeError(f"selected GPU exposes only {selected['memoryMiB']} MiB")
    if not torch.cuda.is_available():
        raise RuntimeError("the installed PyTorch build cannot access CUDA")
    if torch.cuda.device_count() != 1:
        raise RuntimeError(
            "CUDA_VISIBLE_DEVICES must expose exactly one GPU; mixed 5090/4090 visibility is forbidden"
        )

    # The launch contract binds CUDA_VISIBLE_DEVICES to the UUID, making torch device zero unambiguous even on
    # the mixed 5090/4090 host.
    visible = os.environ.get("CUDA_VISIBLE_DEVICES")
    if visible != args.gpu_uuid:
        raise RuntimeError("CUDA_VISIBLE_DEVICES must equal the selected GPU UUID exactly")
    properties = torch.cuda.get_device_properties(0)
    required_major, required_minor = (int(value) for value in args.minimum_compute_capability.split(".", 1))
    if (properties.major, properties.minor) != (required_major, required_minor):
        raise RuntimeError(
            f"PyTorch reports sm_{properties.major}{properties.minor}; "
            f"the approved RTX 5090 must report exactly sm_{required_major}{required_minor}"
        )
    if "5090" not in properties.name:
        raise RuntimeError(f"PyTorch device zero is {properties.name}, not an RTX 5090")

    args.output_directory.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(args.output_directory)
    free_gib = disk.free / (1024**3)
    if free_gib < args.minimum_free_disk_gib:
        raise RuntimeError(f"only {free_gib:.1f} GiB is free at {args.output_directory}")

    # An actual kernel proves the build contains or can JIT a valid sm_120 image; a device-name check alone does
    # not catch the common "no kernel image is available" packaging failure.
    left = torch.arange(1024, device="cuda", dtype=torch.float32).reshape(32, 32)
    right = torch.eye(32, device="cuda", dtype=torch.float32)
    result = (left @ right).sum()
    torch.cuda.synchronize()
    if float(result.cpu()) != float(left.sum().cpu()):
        raise RuntimeError("CUDA smoke kernel produced an unexpected result")

    report: dict[str, Any] = {
        "ok": True,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "torch": torch.__version__,
        "numpy": numpy.__version__,
        "torchCuda": torch.version.cuda,
        "cudnn": torch.backends.cudnn.version(),
        "gpu": selected,
        "torchDevice": {
            "name": properties.name,
            "computeCapability": f"{properties.major}.{properties.minor}",
            "totalMemory": properties.total_memory,
        },
        "cudaVisibleDevices": visible,
        "outputDirectory": str(args.output_directory.resolve()),
        "freeDiskGiB": round(free_gib, 2),
        "featureSchemaSha256": args.expected_feature_hash,
        "nvidiaSmi": command("nvidia-smi", "--query-gpu=uuid,name,pstate,temperature.gpu", "--format=csv,noheader"),
    }
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
