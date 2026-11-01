"""Bounded Puffalo CPU stages for the A19 pilot; uses the canonical Bun runner, never promotes a model."""
from __future__ import annotations

import argparse
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import time


def windows(count: int, processes: int) -> list[tuple[int, int]]:
    if count < processes or processes < 1:
        raise ValueError("Not enough reserved boards for the requested process layout")
    return [(i * count // processes, (i + 1) * count // processes - i * count // processes)
            for i in range(processes)]


def other_bun(own_pids: set[int]) -> list[int]:
    rows = subprocess.check_output(["ps", "-u", str(os.getuid()), "-o", "pid=,comm="], text=True)
    return [int(parts[0]) for row in rows.splitlines() if len(parts := row.split()) == 2
            and parts[1] == "bun" and int(parts[0]) not in own_pids]


def cpu_busy() -> float:
    def sample():
        values = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:]))
        return sum(values), values[3] + values[4]
    left = sample()
    time.sleep(1)
    right = sample()
    return 1 - (right[1] - left[1]) / max(1, right[0] - left[0])


class PilotController:
    def __init__(self, args):
        self.args = args
        self.campaign = args.campaign.resolve()
        self.repository = args.repository.resolve()
        self.manifest = json.loads((self.campaign / "manifest.json").read_text())
        self.deadline = time.monotonic() + args.max_hours * 3600
        self.children = []
        self.logs = []

    def status(self, state: str, **fields):
        value = {"state": state, "pid": os.getpid(), "updatedAtUtc": datetime.now(timezone.utc).isoformat(),
                 "manifestSha256": self.manifest["manifestSha256"], "promoted": False, **fields}
        temporary = self.campaign / "controller-status.tmp.json"
        temporary.write_text(json.dumps(value, indent=2) + "\n")
        temporary.replace(self.campaign / "controller-status.json")
        print(json.dumps(value), flush=True)

    def wait_available(self, stage):
        while True:
            if time.monotonic() >= self.deadline:
                raise TimeoutError("Pilot CPU budget ended while waiting for shared resources")
            processes = other_bun(set())
            busy = cpu_busy()
            cgroup = Path("/sys/fs/cgroup/user.slice") / f"user-{os.getuid()}.slice"
            limit = (cgroup / "memory.max").read_text().strip()
            current = int((cgroup / "memory.current").read_text())
            headroom = float("inf") if limit == "max" else int(limit) - current
            if not processes and busy <= 0.15 and headroom >= 16 * 1024**3:
                return
            self.status("waiting_resources", stage=stage, otherBunPids=processes, cpuBusyFraction=busy,
                        accountMemoryHeadroomBytes=None if limit == "max" else headroom)
            time.sleep(30)

    def stop_children(self):
        for process in self.children:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in self.children:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        # Only leases naming this controller's now-dead children can be archived for a retry.
        pids = {p.pid for p in self.children}
        for lease in self.campaign.glob("pilot-lease-*.json"):
            if json.loads(lease.read_text())["pid"] in pids:
                lease.rename(lease.with_name(lease.name + f".abandoned-{time.time_ns()}"))
        for log in self.logs:
            log.close()
        self.children.clear()
        self.logs.clear()

    def stage(self, name):
        if (self.campaign / name / "summary.json").exists():
            subprocess.run(self.command("verify", name), check=True, stdout=subprocess.DEVNULL)
            return json.loads((self.campaign / name / "summary.json").read_text())
        while True:
            self.wait_available(name)
            count = len(self.manifest["stages"][name])
            processes = min(self.args.processes, count)
            segments = windows(count, processes)
            interrupted = False
            try:
                for index, (first, size) in enumerate(segments):
                    log = (self.campaign / f"{name}-process-{index}-{time.time_ns()}.log").open("w")
                    self.logs.append(log)
                    command = ["nice", "-n", "10", *self.command("run", name), "--workers", str(self.args.workers_per_process),
                               "--first-board", str(first), "--board-count", str(size)]
                    self.children.append(subprocess.Popen(command, cwd=self.repository, stdout=log, stderr=subprocess.STDOUT,
                                                          start_new_session=True, env={**os.environ, "BUN_JSC_numberOfGCMarkers": "2"}))
                own = {p.pid for p in self.children}
                while any(p.poll() is None for p in self.children):
                    if time.monotonic() >= self.deadline:
                        raise TimeoutError("Pilot CPU budget ended; accepted boards are retained")
                    conflicts = other_bun(own)
                    if conflicts:
                        self.status("yielding_resources", stage=name, otherBunPids=conflicts)
                        interrupted = True
                        break
                    if any(p.poll() not in (None, 0) for p in self.children):
                        raise RuntimeError("Pilot child failed; inspect its preserved process log")
                    self.status("running_cpu", stage=name, childPids=list(own),
                                completedBoards=len(list((self.campaign / name).glob("board-*.json"))), targetBoards=count)
                    time.sleep(15)
                if not interrupted and any(p.poll() != 0 for p in self.children):
                    raise RuntimeError("Pilot child did not finish successfully")
            finally:
                self.stop_children()
            if interrupted:
                continue
            subprocess.run(self.command("finalize", name), check=True, stdout=subprocess.DEVNULL)
            return json.loads((self.campaign / name / "summary.json").read_text())

    def command(self, action, stage):
        return [self.args.bun, str(self.repository / "src/simulation/v0_9/a19_pilot.ts"), action,
                "--out", str(self.campaign), "--repository", str(self.repository), "--stage", stage]

    def run(self):
        if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
            raise RuntimeError("This controller is for the admitted Linux x64 training host")
        if self.args.processes * self.args.workers_per_process > 24:
            raise ValueError("At most 24 total simulation workers are permitted")
        try:
            self.stage("smoke")
            self.stage("aa")
            screen = self.stage("teacher_screen")
            if not screen["teacherPassedScreen"]:
                self.status("teacher_not_qualified", stage="teacher_screen", statistics=screen["statistics"])
                return
            confirmation = self.stage("teacher_confirmation")
            if confirmation["statistics"]["lower95"] <= 0.5:
                self.status("teacher_not_qualified", stage="teacher_confirmation", statistics=confirmation["statistics"])
                return
            self.stage("corpus_train")
            self.stage("corpus_validation")
            self.status("ready_for_5090", stage="cpu_complete", note="GPU access and the approved UUID preflight are required; no model has been trained or promoted")
        except BaseException as error:
            self.stop_children()
            self.status("stopped", error=repr(error), acceptedBoardsPreserved=True)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--bun", default="bun")
    parser.add_argument("--processes", type=int, default=6)
    parser.add_argument("--workers-per-process", type=int, default=4)
    parser.add_argument("--max-hours", type=float, default=24)
    args = parser.parse_args()
    if args.processes < 1 or args.workers_per_process < 1 or not 0 < args.max_hours <= 48:
        parser.error("Invalid bounded pilot resource policy")
    def stop_requested(_signal, _frame):
        raise InterruptedError("Pilot controller stop requested")
    signal.signal(signal.SIGTERM, stop_requested)
    with (args.campaign / "controller.lock").open("a+") as lease:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        PilotController(args).run()


if __name__ == "__main__":
    main()
