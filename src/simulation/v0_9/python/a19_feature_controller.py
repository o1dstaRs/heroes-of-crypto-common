"""Bounded stage supervisor: immutable inputs, finite funding, owned process groups."""
from __future__ import annotations

import argparse
from pathlib import Path
import os
import signal
import subprocess
import time

from a19_feature_admission import (check_memory, check_window, load_registration,
                                   memory_snapshot, require, verify_files)


def stop_children(children: list[subprocess.Popen]) -> None:
    for child in children:
        if child.poll() is None:
            # A paused process cannot handle SIGTERM until continued.
            try:
                os.killpg(child.pid, signal.SIGCONT)
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in children:
        if child.poll() is None:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


def cpu_ticks() -> tuple[int, int]:
    fields = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
    return sum(fields), fields[3] + fields[4]


def run_stage(registration_path: Path, name: str) -> None:
    reg, auth = load_registration(registration_path, estimated_seconds=1)
    require(name in reg["stages"], "Unknown registered stage")
    stage = reg["stages"][name]
    root = registration_path.resolve().parent
    check_window(auth, stage["estimatedSecondsWithReserve"])
    require(1 <= len(stage["commands"]) <= 2, "At most two bounded child groups")
    require(stage["cpuOnly"] in [True, False], "Explicit GPU visibility policy required")
    snapshot = memory_snapshot()
    check_memory(snapshot["hostAvailableBytes"], snapshot["ancestorHeadrooms"],
                 stage["estimatedPeakHostBytes"], reg["hostReserveBytes"])
    previous = cpu_ticks()
    children, logs = [], []
    paused, high = False, 0
    started = time.monotonic()
    prior_handlers = {sig: signal.getsignal(sig) for sig in [signal.SIGINT, signal.SIGTERM]}
    for sig in prior_handlers:
        signal.signal(sig, lambda *_: (_ for _ in ()).throw(InterruptedError("Owned feature stage interrupted")))
    try:
        for index, command in enumerate(stage["commands"]):
            require(isinstance(command, list) and command and all(isinstance(s, str) for s in command),
                    "Stage commands must be explicit argv arrays")
            path = root / f"{name}-{index}-{time.time_ns()}.log"
            log = path.open("x")
            logs.append(log)
            env = {**os.environ, "CUDA_VISIBLE_DEVICES": "" if stage["cpuOnly"] else auth["approvedGpuUuid"],
                   "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "BUN_JSC_numberOfGCMarkers": "1"}
            children.append(subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                                             start_new_session=True))
        while any(child.poll() is None for child in children):
            check_window(auth, 1)
            require(time.monotonic() - started < stage["maximumWallSeconds"], "Stage wall-time bound")
            require(all(child.poll() in [None, 0] for child in children), "Child failed; preserve partial evidence")
            snapshot = memory_snapshot()
            check_memory(snapshot["hostAvailableBytes"], snapshot["ancestorHeadrooms"],
                         reg["minimumRunningHeadroomBytes"], reg["hostReserveBytes"])
            current = cpu_ticks()
            total, idle = current[0] - previous[0], current[1] - previous[1]
            busy = 1 - idle / max(1, total)
            previous = current
            high = high + 1 if busy > .85 else 0
            if stage["cpuOnly"] and high >= 3 and not paused:
                for child in children:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGSTOP)
                paused = True
            elif paused and busy <= .6:
                for child in children:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGCONT)
                paused, high = False, 0
            time.sleep(2)
        require(all(child.returncode == 0 for child in children), "Incomplete stage cannot pass")
        verify_files(root, reg["files"])
    finally:
        stop_children(children)
        for stream in logs:
            stream.close()
        for sig, handler in prior_handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registration", type=Path, required=True)
    parser.add_argument("--stage", required=True)
    args = parser.parse_args()
    run_stage(args.registration, args.stage)
