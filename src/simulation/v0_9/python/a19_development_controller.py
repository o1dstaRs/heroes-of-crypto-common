"""After an accepted 5090 fit: export parity, smoke, and development only; never lock or use confirmation."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import time
from types import SimpleNamespace

from a19_pilot_controller import PilotController


class DevelopmentStages(PilotController):
    """Reuse the admitted resource/yield/resume policy and the existing ranked-match worker pool."""
    def command(self, action, stage):
        if stage not in ("smoke", "development"):
            raise ValueError("Automatic development cannot consume a confirmation bank")
        return [self.args.bun, str(self.repository / "src/simulation/v0_9/a19_student_eval.ts"), action,
                "--out", str(self.campaign), "--repository", str(self.repository), "--stage", stage]

    def stage(self, name):
        if name not in ("smoke", "development"):
            raise ValueError("Automatic development cannot consume a confirmation bank")
        original = self.manifest
        # The inherited scheduler needs only board counts and the immutable trial identity.
        # Its child CLI always validates the complete, unchanged on-disk manifest itself.
        self.manifest = {"manifestSha256": original["manifestSha256"],
                         "stages": {"smoke": range(3), "development": original["registration"]["stages"]["development"]}}
        try:
            return super().stage(name)
        finally:
            self.manifest = original

    def stop_children(self):
        pids = {child.pid for child in self.children}
        super().stop_children()
        for lease in self.campaign.glob("student-lease-*.json"):
            if json.loads(lease.read_text())["pid"] in pids:
                lease.rename(lease.with_name(lease.name + f".abandoned-{time.time_ns()}"))


class DevelopmentContinuation:
    def __init__(self, args):
        self.args = args
        self.campaign, self.repository, self.output = args.campaign.resolve(), args.repository.resolve(), args.out.resolve()
        self.manifest = json.loads((self.campaign / "manifest.json").read_text())
        self.deadline = time.monotonic() + args.max_hours * 3600
        self.child = None
        self.scheduler = None

    def status(self, state, **fields):
        row = {"state": state, "pid": os.getpid(), "updatedAtUtc": datetime.now(timezone.utc).isoformat(),
               "actorManifestSha256": self.manifest["manifestSha256"], "promoted": False,
               "controllerSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), **fields}
        temporary = self.output / "continuation-status.tmp.json"
        temporary.write_text(json.dumps(row, indent=2) + "\n")
        temporary.replace(self.output / "continuation-status.json")
        print(json.dumps(row), flush=True)

    def stop(self):
        if self.scheduler:
            self.scheduler.stop_children()
        if self.child is not None and self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGTERM)
            try:
                self.child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(self.child.pid, signal.SIGKILL)
                self.child.wait()

    def command(self, name, command):
        with (self.output / f"{name}.log").open("x") as log:
            self.child = subprocess.Popen(["nice", "-n", "19", *command], cwd=self.repository,
                env={**os.environ, "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"},
                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
            while self.child.poll() is None:
                if time.monotonic() >= self.deadline:
                    raise TimeoutError("Development wall budget ended; preserve completed artifacts")
                time.sleep(1)
        if self.child.returncode:
            raise RuntimeError(f"Development {name} failed; inspect its preserved log")

    def run(self):
        if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
            raise ValueError("Run the continuation on the admitted Linux x64 actor host")
        try:
            while time.monotonic() < self.deadline:
                path = self.campaign / "gpu-continuation-status.json"
                fit = json.loads(path.read_text()) if path.exists() else {"state": "not_started"}
                if fit.get("manifestSha256", self.manifest["manifestSha256"]) != self.manifest["manifestSha256"]:
                    raise ValueError("GPU fit belongs to another actor campaign")
                if fit["state"].startswith("stopped"):
                    self.status("stopped_fit_gate", fitState=fit["state"])
                    return
                if fit["state"] == "fit_complete":
                    break
                self.status("waiting_fit", fitState=fit["state"])
                time.sleep(30)
            else:
                raise TimeoutError("Development wall budget ended while waiting for the accepted fit")
            model = self.campaign / "models/proposal-v2-pilot/research-model.json"
            receipt = model.with_name("complete.json")
            if fit["modelPath"] != str(model) or fit["receipt"]["modelFileSha256"] != hashlib.sha256(model.read_bytes()).hexdigest():
                raise ValueError("Accepted fit status and exported weights do not match")
            # Reuse the existing admission check before any PyTorch/Bun work. No learner is started here.
            admission = PilotController(SimpleNamespace(campaign=self.campaign, repository=self.repository,
                                                        max_hours=self.args.max_hours))
            admission.deadline = self.deadline
            # Keep admission diagnostics in the continuation directory, never overwrite the actor status.
            admission.status = lambda state, **fields: self.status(state, **fields)
            admission.wait_available("cpu_export_parity")
            self.status("checking_export")
            fixture, parity = self.output / "pytorch-references.json", self.output / "cpu-parity.json"
            self.command("pytorch-export", [self.args.python,
                str(self.repository / "src/simulation/v0_9/python/a19_export_parity.py"), "--campaign", str(self.campaign),
                "--actor-repository", str(self.args.actor_repository.resolve()), "--model", str(model),
                "--fit-receipt", str(receipt), "--bun", self.args.bun, "--out", str(fixture)])
            admission.wait_available("bun_export_parity")
            self.command("bun-parity", [self.args.bun, str(self.repository / "src/simulation/v0_9/a19_inference_benchmark.ts"),
                "--model", str(model), "--fixture", str(fixture), "--out", str(parity)])
            report = json.loads(parity.read_text())
            if (report.get("fixtureModelBound") is not True or report.get("untrainedDiagnostic") is not False
                or report["modelFileSha256"] != hashlib.sha256(model.read_bytes()).hexdigest()
                or report["maximumAbsoluteError"] > 0.00001 or report["resolvedRankingMismatches"] != 0):
                raise ValueError("Fitted-model CPU parity did not pass")
            trial = self.output / "trial"
            admission.wait_available("student_initialization")
            self.command("student-init", [self.args.bun, str(self.repository / "src/simulation/v0_9/a19_student_eval.ts"),
                "init", "--out", str(trial), "--repository", str(self.repository), "--registration", str(self.args.registration.resolve()),
                "--actor-campaign", str(self.campaign), "--actor-source", str(self.args.actor_repository.resolve()),
                "--model", str(model), "--fit-receipt", str(receipt), "--minimum-logit-gain", str(self.args.minimum_logit_gain),
                "--protect-v08-root", str(self.args.protect_v08_root.resolve())])
            self.scheduler = DevelopmentStages(SimpleNamespace(campaign=trial, repository=self.repository, bun=self.args.bun,
                processes=self.args.processes, workers_per_process=self.args.workers_per_process, max_hours=self.args.max_hours))
            self.scheduler.deadline = self.deadline
            self.status("running_development", trial=str(trial))
            self.scheduler.stage("smoke")
            summary = self.scheduler.stage("development")
            self.status("development_complete", trial=str(trial), statistics=summary["statistics"],
                modelFileSha256=report["modelFileSha256"],
                note="Development only. Review model, disabled parity and production timing before locking one finalist. Untouched banks remain unstarted.")
        except BaseException as error:
            self.stop()
            self.status("stopped", error=repr(error), acceptedArtifactsPreserved=True)
            raise


def main():
    parser = argparse.ArgumentParser()
    for name in ("campaign", "repository", "actor-repository", "registration", "out", "protect-v08-root"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--bun", default="bun")
    parser.add_argument("--minimum-logit-gain", type=float, default=1)
    parser.add_argument("--processes", type=int, default=6)
    parser.add_argument("--workers-per-process", type=int, default=4)
    parser.add_argument("--max-hours", type=float, default=24)
    args = parser.parse_args()
    if (not 0 < args.max_hours <= 48 or args.processes < 1 or args.workers_per_process < 1
        or args.processes * args.workers_per_process > 24 or not 0 < args.minimum_logit_gain < float("inf")):
        parser.error("Invalid bounded development resource policy")
    args.out.mkdir(parents=True, exist_ok=False)
    def stop_requested(_signal, _frame):
        raise InterruptedError("Development stop requested")
    signal.signal(signal.SIGTERM, stop_requested)
    with (args.out / "continuation.lock").open("x") as lease:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        DevelopmentContinuation(args).run()


if __name__ == "__main__":
    main()
