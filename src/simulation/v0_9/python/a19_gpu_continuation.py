"""Bounded research continuation: fit only after confirmed CPU data and approved, idle 5090 access."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import signal
import subprocess
import time

APPROVED_GPU_UUID = "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350"


def fit_budget_problem(elapsed: float, records: list[dict], maximum_seconds: float,
                       initial_epoch_seconds: float, epochs: int = 20) -> str | None:
    if elapsed >= maximum_seconds:
        return "Active learner time limit reached; retain checkpoints instead of extending the run"
    if not records:
        return "No completed first epoch inside the initial GPU window" if elapsed >= initial_epoch_seconds else None
    latest = records[-1]
    if (records[0].get("epoch") != 0 or not isinstance(latest.get("epoch"), int)
        or not 0 <= latest["epoch"] < epochs or not isinstance(latest.get("elapsedSeconds"), (int, float))
        or not math.isfinite(latest["elapsedSeconds"]) or latest["elapsedSeconds"] <= 0):
        return "Invalid learner progress; do not spend more GPU time"
    values = [latest.get("trainingLoss"), *latest.get("validation", {}).values()]
    if not values or any(not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in values):
        return "Non-finite or negative learner metrics; stop before further GPU work"
    projected = elapsed + (epochs - latest["epoch"] - 1) * latest["elapsedSeconds"]
    return "Measured epoch throughput projects beyond the initial active-GPU budget" if projected > maximum_seconds else None


def validate_readiness(report: dict, manifest: dict, campaign: Path, verify_files: bool = True) -> None:
    checks = report.get("checks", {})
    if (report.get("schema") != "hoc.ai.v0_9_a19_gpu_readiness.v1" or report.get("readyForGpu") is not True
        or report.get("promoted") is not False or report.get("manifestSha256") != manifest["manifestSha256"]
        or report.get("sourceSha256") != manifest["source"]["sha256"]
        or report.get("learnerSourceSha256") != manifest["source"]["files"]["src/simulation/v0_9/python/a19_train.py"]
        or any(checks.get(name) is not True for name in ("teacherQualified", "allCorpusRowsCheckedOnCpu",
            "trainValidationIndependent", "exactLearnerCpuRehearsal", "checkpointResumeExact",
            "cpuExportParity", "activeEngineSmoke", "maximumShapeBatchChecked", "currentEngineAdmitted"))):
        raise ValueError("Complete source-bound CPU readiness evidence is required before GPU work")
    for stage, count in (("corpus_train", 510), ("corpus_validation", 96)):
        receipt = report.get("corpus", {}).get(stage, {})
        files = receipt.get("files", [])
        if (len(files) != count or not isinstance(receipt.get("decisions"), int) or receipt["decisions"] < 1
            or receipt.get("manifestSha256") != manifest["manifestSha256"]):
            raise ValueError("Readiness requires both complete, verified fresh corpus stages")
        for index, entry in enumerate(files):
            expected = (campaign / stage / f"board-{index:06}.json").resolve()
            if Path(entry["path"]).resolve() != expected:
                raise ValueError("Readiness corpus escaped its registered phase")
            if verify_files and hashlib.sha256(expected.read_bytes()).hexdigest() != entry["sha256"]:
                raise ValueError("Corpus changed after its CPU readiness scan")


def approved_gpu(inventory: str, applications: str, own_pid: int | None = None) -> dict | None:
    """An unreadable or occupied target never becomes an implicit idle GPU."""
    rows = list(csv.reader(inventory.splitlines(), skipinitialspace=True))
    target = next((row for row in rows if row and row[0].strip() == APPROVED_GPU_UUID), None)
    if target is None:
        return None
    if len(target) != 5 or "5090" not in target[1]:
        raise ValueError("Approved UUID did not identify the intended RTX 5090")
    for row in csv.reader(applications.splitlines(), skipinitialspace=True):
        if not row or all(not value.strip() for value in row):
            continue
        if len(row) != 2:
            raise ValueError("GPU workload inventory is unreadable")
        if row[0].strip() == APPROVED_GPU_UUID and row[1].strip() != str(own_pid):
            return None
    free_mib, utilization, temperature = [float(value.strip()) for value in target[2:]]
    if not all(math.isfinite(value) for value in (free_mib, utilization, temperature)):
        raise ValueError("GPU telemetry contains a non-finite value")
    if own_pid is None and (free_mib < 8192 or utilization >= 10 or temperature >= 85):
        return None
    return {"uuid": APPROVED_GPU_UUID, "name": target[1].strip(), "freeMiB": free_mib,
            "utilizationPercent": utilization, "temperatureC": temperature}


class Continuation:
    def __init__(self, args):
        self.args = args
        self.campaign, self.repository = args.campaign.resolve(), args.repository.resolve()
        self.manifest = json.loads((self.campaign / "manifest.json").read_text())
        self.output = self.campaign / "models" / "proposal-v2-pilot"
        self.deadline = time.monotonic() + args.max_hours * 3600
        self.child = None

    def status(self, state, **fields):
        row = {"state": state, "pid": os.getpid(), "updatedAtUtc": datetime.now(timezone.utc).isoformat(),
               "manifestSha256": self.manifest["manifestSha256"], "gpuUuid": APPROVED_GPU_UUID,
               "controllerSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "promoted": False, **fields}
        path = self.campaign / "gpu-continuation-status.json"
        temporary = path.with_suffix(".tmp.json")
        temporary.write_text(json.dumps(row, indent=2) + "\n")
        temporary.replace(path)
        print(json.dumps(row), flush=True)

    def gpu(self, own_pid=None):
        try:
            inventory = subprocess.run(["nvidia-smi", "--query-gpu=uuid,name,memory.free,utilization.gpu,temperature.gpu",
                                        "--format=csv,noheader,nounits"], text=True, capture_output=True, timeout=5)
            apps = subprocess.run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"],
                                  text=True, capture_output=True, timeout=5)
        except subprocess.TimeoutExpired:
            return None, "GPU telemetry timed out"
        if inventory.returncode or apps.returncode:
            return None, (inventory.stdout + inventory.stderr + apps.stdout + apps.stderr)[-1500:]
        try:
            device = approved_gpu(inventory.stdout, apps.stdout, own_pid)
            return device, None if device else "Approved GPU absent, busy, hot, or below the free-memory reserve"
        except ValueError as error:
            return None, str(error)

    def cpu_available(self):
        processes = subprocess.check_output(["ps", "-u", str(os.getuid()), "-o", "comm="], text=True)
        if any(row.strip() == "bun" for row in processes.splitlines()):
            return False
        group = Path("/sys/fs/cgroup/user.slice") / f"user-{os.getuid()}.slice"
        limit = (group / "memory.max").read_text().strip()
        return limit == "max" or int(limit) - int((group / "memory.current").read_text()) >= 16 * 1024**3

    def stop_child(self):
        if self.child is None:
            return
        if self.child.poll() is None:
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.child.wait()
        lease = self.output / "learner-lease.json"
        if lease.exists() and json.loads(lease.read_text())["pid"] == self.child.pid:
            lease.rename(lease.with_name(lease.name + f".abandoned-{time.time_ns()}"))

    def run(self):
        try:
            while time.monotonic() < self.deadline:
                path = self.campaign / "controller-status.json"
                cpu = json.loads(path.read_text()) if path.exists() else {"state": "not_started"}
                if cpu.get("manifestSha256", self.manifest["manifestSha256"]) != self.manifest["manifestSha256"]:
                    raise ValueError("CPU continuation belongs to another frozen campaign")
                if cpu["state"] in ("stopped", "teacher_not_qualified"):
                    self.status("stopped_cpu_gate", cpuState=cpu)
                    return
                if cpu["state"] != "ready_for_5090":
                    self.status("waiting_cpu", cpuStage=cpu.get("stage"), cpuState=cpu["state"])
                    time.sleep(30)
                    continue
                if not self.cpu_available():
                    self.status("waiting_resources")
                    time.sleep(30)
                    continue
                if not self.args.readiness.exists():
                    self.status("waiting_readiness", note="No GPU work until the complete CPU readiness report exists")
                    time.sleep(30)
                    continue
                readiness_bytes = self.args.readiness.read_bytes()
                readiness = json.loads(readiness_bytes)
                validate_readiness(readiness, self.manifest, self.campaign, verify_files=False)
                hold_path = self.campaign / "gpu-readiness-hold.json"
                if hold_path.exists() and json.loads(hold_path.read_text()).get("automaticGpuLaunch") is not True:
                    self.status("held_for_readiness", note="Keep GPU launch held until the audited CPU report releases it")
                    time.sleep(30)
                    continue
                gpu, reason = self.gpu()
                if gpu is None:
                    self.status("waiting_gpu", reason=reason)
                    time.sleep(30)
                    continue
                validate_readiness(readiness, self.manifest, self.campaign, verify_files=True)
                if self.output.exists():
                    raise FileExistsError("Preserve the existing model output; inspect it before a separate resume")
                self.status("starting_fit", gpu=gpu, readinessFileSha256=hashlib.sha256(readiness_bytes).hexdigest(),
                            maximumActiveSeconds=self.args.maximum_fit_seconds, initialEpochSeconds=self.args.initial_epoch_seconds)
                environment = {**os.environ, "CUDA_VISIBLE_DEVICES": APPROVED_GPU_UUID, "OMP_NUM_THREADS": "2",
                               "OPENBLAS_NUM_THREADS": "2"}
                log = self.campaign / "learner.log"
                with log.open("x") as output:
                    self.child = subprocess.Popen(["nice", "-n", "19", self.args.python,
                        str(self.repository / "src/simulation/v0_9/python/a19_train.py"),
                        "--campaign", str(self.campaign), "--repository", str(self.repository),
                        "--out", str(self.output), "--bun", self.args.bun, "--epochs", "20", "--batch-size", "32"],
                        cwd=self.repository, env=environment, stdout=output, stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL, start_new_session=True)
                    fit_started = time.monotonic()
                    while self.child.poll() is None:
                        if time.monotonic() >= self.deadline:
                            raise TimeoutError("Research continuation wall budget ended; preserve accepted checkpoints")
                        epochs_path = self.output / "epochs.jsonl"
                        records = []
                        if epochs_path.exists():
                            records = [json.loads(line) for line in epochs_path.read_text().splitlines(keepends=True)
                                       if line.endswith("\n")]
                        fit_elapsed = time.monotonic() - fit_started
                        problem = fit_budget_problem(fit_elapsed, records, self.args.maximum_fit_seconds,
                                                     self.args.initial_epoch_seconds)
                        if problem:
                            raise TimeoutError(problem)
                        gpu, reason = self.gpu(self.child.pid)
                        self.status("fitting", childPid=self.child.pid, gpu=gpu, telemetryNote=reason,
                                    learnerLog=str(log), activeSeconds=fit_elapsed,
                                    completedEpochs=len(records), maximumActiveSeconds=self.args.maximum_fit_seconds)
                        time.sleep(1 if not records else 5)
                if self.child.returncode:
                    raise RuntimeError(f"Frozen learner exited {self.child.returncode}; inspect {log}")
                receipt = json.loads((self.output / "complete.json").read_text())
                if receipt["manifestSha256"] != self.manifest["manifestSha256"] or receipt["promoted"] is not False or \
                        receipt["modelFileSha256"] != hashlib.sha256((self.output / "research-model.json").read_bytes()).hexdigest():
                    raise ValueError("Fitted-model completion receipt mismatch")
                self.status("fit_complete", receipt=receipt, modelPath=str(self.output / "research-model.json"),
                            note="Research artifact only; student development, untouched match confirmation, and latency qualification remain")
                return
            raise TimeoutError("Research continuation wall budget ended while waiting")
        except BaseException as error:
            self.stop_child()
            self.status("stopped", error=repr(error), acceptedCheckpointsPreserved=True)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--bun", required=True)
    parser.add_argument("--readiness", type=Path, required=True)
    parser.add_argument("--maximum-fit-seconds", type=float, default=1200)
    parser.add_argument("--initial-epoch-seconds", type=float, default=120)
    parser.add_argument("--max-hours", type=float, default=24)
    args = parser.parse_args()
    if (not 0 < args.max_hours <= 48 or not 30 <= args.maximum_fit_seconds <= 1800
        or not 10 <= args.initial_epoch_seconds <= min(120, args.maximum_fit_seconds)):
        parser.error("The continuation requires a bounded wall budget of at most 48 hours")
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise RuntimeError("This continuation is for the admitted Linux x64 training host")
    def stop_requested(_signal, _frame):
        raise InterruptedError("Continuation stop requested")
    signal.signal(signal.SIGTERM, stop_requested)
    with (args.campaign / "gpu-continuation.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Continuation(args).run()


if __name__ == "__main__":
    main()
