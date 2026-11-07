"""Resource and immutable-input checks shared by the feature-cycle controller."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import time
from typing import Any

GPU_UUID = "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350"
PEER_GPU_UUID = "GPU-e59a6fce-1961-bafe-927c-06c0149f2370"
GIB = 1024 ** 3


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path: Path) -> Any:
    return json.loads(path.read_text())


def verify_files(root: Path, files: dict[str, str]) -> None:
    require(bool(files), "Missing immutable source/input manifest")
    for name, digest in files.items():
        require(len(digest) == 64 and sha(root / name) == digest, "Source/input changed: " + name)


def check_window(authorization: dict[str, Any], estimate_seconds: float,
                 *, now: float | None = None, shutdown_seconds: float = 90) -> None:
    now = time.time() if now is None else now
    require(authorization.get("authorized") is True, "New finite research authorization required")
    require(authorization.get("approvedGpuUuid") == GPU_UUID and authorization.get("maximumGpus") == 1,
            "Only the approved RTX 5090 UUID may be used")
    require(authorization.get("promotionAllowed") is False, "Research may not promote")
    stop = authorization.get("stopAtUnix")
    require(type(stop) in [int, float] and math.isfinite(stop), "Finite authorization cutoff required")
    require(type(estimate_seconds) in [int, float] and math.isfinite(estimate_seconds) and estimate_seconds > 0,
            "Complete-stage runtime estimate required")
    require(stop - now >= estimate_seconds + shutdown_seconds, "Complete stage does not fit the remaining authorization")


def check_memory(host_available: int, ancestor_headrooms: list[int | None],
                 peak_bytes: int, reserve_bytes: int) -> None:
    require(peak_bytes > 0 and reserve_bytes >= 0, "Invalid memory estimate")
    require(host_available >= peak_bytes + reserve_bytes, "Host memory reserve cannot fund stage")
    for headroom in ancestor_headrooms:
        require(headroom is None or headroom >= peak_bytes, "Service/ancestor cgroup cannot fund stage")


def memory_snapshot() -> dict[str, Any]:
    values = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    host_available = int(values["MemAvailable"].split()[0]) * 1024
    group = next(line.split(":", 2)[2] for line in Path("/proc/self/cgroup").read_text().splitlines()
                 if line.startswith("0::"))
    mount = Path("/sys/fs/cgroup")
    current = mount / group.lstrip("/")
    headrooms, ancestors = [], []
    while True:
        limit_file = current / "memory.max"
        usage_file = current / "memory.current"
        if limit_file.exists() and usage_file.exists():
            limit = limit_file.read_text().strip()
            usage = int(usage_file.read_text())
            headroom = None if limit == "max" else max(0, int(limit) - usage)
            headrooms.append(headroom)
            ancestors.append({"cgroup": str(current.relative_to(mount)), "limit": limit,
                              "currentBytes": usage, "headroomBytes": headroom})
        if current == mount:
            break
        require(mount in current.parents, "Cgroup outside expected mount")
        current = current.parent
    return {"hostAvailableBytes": host_available, "ancestorHeadrooms": headrooms, "ancestors": ancestors}


def load_registration(path: Path, *, estimated_seconds: float | None = None) -> tuple[dict, dict]:
    registration = read(path)
    require(registration["schema"] == "hoc.ai.a19.feature-cycle.v1", "Wrong feature-cycle registration")
    require(registration["promotionAllowed"] is False, "No automatic research promotion")
    root = path.resolve().parent
    authorization_path = root / registration["authorization"]
    require(sha(authorization_path) == registration["authorizationSha256"], "Authorization changed")
    authorization = read(authorization_path)
    estimate = registration["fitBudgetSeconds"] if estimated_seconds is None else estimated_seconds
    check_window(authorization, estimate)
    verify_files(root, registration["files"])
    return registration, authorization


def check_gpu_environment() -> None:
    require(os.environ.get("CUDA_VISIBLE_DEVICES") == GPU_UUID, "Set the approved RTX 5090 UUID before GPU training")


def check_pair_objective(reg: dict[str, Any]) -> dict[str, Any]:
    """Validate the complete loss recipe before Torch/CUDA or output creation."""
    weighting = reg.get("pairLossWeighting", "comparisons")
    require(weighting in ["comparisons", "roots"], "Unknown paired-root objective")
    payoff = reg.get("pairPayoffWeighting", "sign")
    require(payoff in ["sign", "magnitude"], "Unknown paired-root payoff objective")
    objective = reg.get("pairLossObjective", "paired-preference")
    require(objective in ["paired-preference", "score-difference"], "Unknown paired-root loss objective")
    scale = reg.get("pairScoreScale")
    if objective == "score-difference":
        require(weighting == "roots" and payoff == "sign", "Score differences require equal roots and no preference-weight modifier")
        require(type(scale) in [int, float] and math.isfinite(scale) and scale > 0,
                "Register a finite positive score-difference scale")
    else:
        require(scale is None, "Score scale only applies to the score-difference objective")
    return {"weighting": weighting, "payoffWeighting": payoff, "objective": objective, "scoreScale": scale}


def check_fit_design(reg: dict[str, Any]) -> None:
    recipes = reg["recipes"]
    require(len(recipes) == reg["maximumFits"] == 4, "Four matched preregistered recipes required")
    require([r["ordinal"] for r in recipes] == list(range(4)), "Recipe ordinals must be0,1,2,3")
    for pair in [recipes[:2], recipes[2:]]:
        require([r["rank"] for r in pair] == [0, 4], "Each pair needs a frozen control and rank4 feature arm")
        for field in ["learningRate", "klWeight", "batchSeed", "seed"]:
            require(pair[0][field] == pair[1][field], "Unmatched recipe field: " + field)
        require(math.isfinite(pair[0]["learningRate"]) and 0 < pair[0]["learningRate"] <= .05,
                "Invalid research learning rate")
        require(math.isfinite(pair[0]["klWeight"]) and pair[0]["klWeight"] >= 0, "Invalid KL weight")
    require(reg["useCachedOldFeatures"] is False, "Feature-aware arm cannot reuse frozen feature cache")
    require(reg["minimumWorldsPerAction"] == 8, "Preserve all eight futures")
    require(reg["developmentGames"] == 768 and reg["freshGames"] == 3072,
            "Preserve complete game banks")
    require(reg["teacherCeTolerance"] == .03 and reg["minimumPairImprovement"] == .005,
            "Checkpoint constraints must be preregistered")


def gpu_snapshot() -> dict[str, Any]:
    devices = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid,memory.used,utilization.gpu,temperature.gpu",
                                       "--format=csv,noheader,nounits"], text=True)
    processes = subprocess.check_output(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid",
                                         "--format=csv,noheader,nounits"], text=True)
    inventory = {}
    for line in devices.splitlines():
        uuid, memory, utilization, temperature = [v.strip() for v in line.split(",")]
        inventory[uuid] = {"memoryMiB": float(memory), "utilization": float(utilization),
                           "temperature": float(temperature)}
    apps = [{"gpuUuid": line.split(",")[0].strip(), "pid": int(line.split(",")[1])}
            for line in processes.splitlines() if line.strip()]
    return {"atUnix": time.time(), "devices": inventory, "processes": apps}


def classify_gpu_admission(samples: list[dict[str, Any]], *, wsl: bool) -> dict[str, Any]:
    require(len(samples) >= 2, "Two independent device telemetry samples required")
    mirrored = set()
    for sample in samples:
        target = sample["devices"][GPU_UUID]
        require(target["memoryMiB"] == 0 and target["utilization"] == 0,
                "5090 has real allocation/activity; do not compete with its owner")
        require(0 <= target["temperature"] < 80, "5090 temperature admission failed")
        target_pids = {r["pid"] for r in sample["processes"] if r["gpuUuid"] == GPU_UUID}
        if target_pids:
            peer_pids = {r["pid"] for r in sample["processes"] if r["gpuUuid"] == PEER_GPU_UUID}
            require(wsl and target_pids <= peer_pids and PEER_GPU_UUID in sample["devices"],
                    "Unattributed 5090 compute owner; stop this stage only")
            # WSL can mirror an identical process under both UUIDs. This exception
            # never admits a target with even1MiB allocation or reported activity.
            mirrored.update(target_pids)
    return {"admitted": True, "knownWslMirroredPids": sorted(mirrored), "samples": samples}


def admit_gpu() -> dict[str, Any]:
    first = gpu_snapshot()
    time.sleep(.5)
    second = gpu_snapshot()
    return classify_gpu_admission([first, second], wsl="microsoft" in platform.release().lower())
