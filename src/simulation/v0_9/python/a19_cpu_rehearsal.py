"""Exercise the exact frozen learner on real smoke states, on CPU, with explicitly unqualified hardware.

Only hardware calls and stage admission are replaced. The production learner's batching, optimizer,
checkpoint, resume, validation and export code run unchanged. Outputs cannot qualify a student trial.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch

# This is a standalone CPU utility. Keep the real process mask empty even while the frozen
# learner's own admission check is replaced below; optimizer internals also import torch.cuda.
os.environ["CUDA_VISIBLE_DEVICES"] = ""
import torch


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SimulatedInterruption(RuntimeError):
    pass


class CpuTorch:
    def __init__(self, interrupt_epoch=None):
        self.interrupt_epoch = interrupt_epoch
        self.cuda = SimpleNamespace(is_available=lambda: True, get_rng_state=lambda: torch.get_rng_state().clone(),
                                    set_rng_state=lambda value: torch.set_rng_state(value), max_memory_allocated=lambda: 0)

    def device(self, name):
        if str(name) not in ("cuda:0", "cpu"):
            raise ValueError("Unexpected rehearsal device")
        return torch.device("cpu")

    def save(self, value, path):
        if value.get("epoch") == self.interrupt_epoch:
            raise SimulatedInterruption("Stop before committing the next epoch checkpoint")
        return torch.save(value, path)

    def __getattr__(self, name):
        return getattr(torch, name)


class CpuOs:
    environ = {**os.environ, "CUDA_VISIBLE_DEVICES": "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350"}

    def __getattr__(self, name):
        return getattr(os, name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--smoke-campaign", type=Path, required=True)
    parser.add_argument("--feature-contract", type=Path)
    parser.add_argument("--reference-generator", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bun", default="bun")
    args = parser.parse_args()
    repository, campaign, output = args.repository.resolve(), args.smoke_campaign.resolve(), args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(2)
    started = time.monotonic()
    manifest = json.loads((campaign / "manifest.json").read_text())
    for name, digest in manifest["source"]["files"].items():
        if sha(repository / name) != digest:
            raise ValueError(f"Frozen learner/engine input changed: {name}")
    # Historical read-only downloads may omit this separately sealed contract. Copy evidence into
    # the rehearsal directory instead of modifying the archived campaign or generating new boards.
    evidence = output / "verified-smoke"
    evidence.mkdir()
    shutil.copyfile(campaign / "manifest.json", evidence / "manifest.json")
    shutil.copytree(campaign / "smoke", evidence / "smoke")
    shutil.copyfile(args.feature_contract or campaign / "feature-contract.json", evidence / "feature-contract.json")
    campaign = evidence
    raw = subprocess.check_output([args.bun, str(repository / "src/simulation/v0_9/a19_pilot.ts"), "verify",
        "--out", str(campaign), "--repository", str(repository), "--stage", "smoke"], text=True)
    smoke = json.loads(raw)
    if smoke["stage"] != "smoke" or len(smoke["files"]) != 3 or smoke["summary"]["teacherRollouts"] != 8:
        raise ValueError("Use the complete verified R8 smoke; no confirmation states are allowed")
    train_receipt, validation_receipt = {**smoke, "files": smoke["files"][:2]}, {**smoke, "files": smoke["files"][2:]}
    if {entry["path"] for entry in train_receipt["files"]} & {entry["path"] for entry in validation_receipt["files"]}:
        raise ValueError("Rehearsal train and validation boards overlap")
    python_root = repository / "src/simulation/v0_9/python"
    sys.path.insert(0, str(python_root))
    learner = load_module("a19_frozen_cpu_rehearsal_learner", python_root / "a19_train.py")
    contract = json.loads((campaign / "feature-contract.json").read_text())
    rehearsal = output / "unqualified-campaign"
    rehearsal.mkdir()
    (rehearsal / "feature-contract.json").write_text(json.dumps(contract))
    train_rows = learner.load_decisions(train_receipt, contract["contractSha256"])
    validation_rows = learner.load_decisions(validation_receipt, contract["contractSha256"])
    full, resumed = rehearsal / "models/uninterrupted", rehearsal / "models/resumed"
    original_run, original_check_output = subprocess.run, subprocess.check_output
    original_step = torch.optim.AdamW.step
    steps = 0

    def checked_step(optimizer, *positional, **keywords):
        nonlocal steps
        if os.environ.get("CUDA_VISIBLE_DEVICES") != "" or any(parameter.device.type != "cpu"
               for group in optimizer.param_groups for parameter in group["params"]):
            raise ValueError("CPU rehearsal must never expose or allocate a CUDA device")
        if any(parameter.grad is not None and not torch.isfinite(parameter.grad).all()
               for group in optimizer.param_groups for parameter in group["params"]):
            raise ValueError("Non-finite real-data rehearsal gradient")
        steps += 1
        return original_step(optimizer, *positional, **keywords)

    def cpu_hardware(command, *positional, **keywords):
        if len(command) > 1 and Path(command[1]).name == "preflight.py":
            return subprocess.CompletedProcess(command, 0,
                stdout=json.dumps({"ok": False, "cpuRehearsal": True, "gpu": None,
                                   "note": "Hardware deliberately skipped; this is not a GPU admission receipt"}) + "\n", stderr="")
        return original_run(command, *positional, **keywords)

    def no_nvidia(command, *positional, **keywords):
        if command[0] == "nvidia-smi":
            return ""
        return original_check_output(command, *positional, **keywords)

    def fit(folder, resume=False, seed=2026102562, interrupt_epoch=None):
        argv = [str(python_root / "a19_train.py"), "--campaign", str(rehearsal), "--repository", str(repository),
                "--out", str(folder), "--epochs", "4", "--batch-size", "16", "--seed", str(seed)]
        if resume:
            argv.append("--resume")
        try:
            with patch.object(sys, "argv", argv), patch.object(learner, "torch", CpuTorch(interrupt_epoch)), \
                    patch.object(learner, "os", CpuOs()), \
                    patch.object(learner, "verify_stage", side_effect=lambda _c, _r, stage, _b:
                        train_receipt if stage == "corpus_train" else validation_receipt), \
                    patch.object(subprocess, "run", side_effect=cpu_hardware), \
                    patch.object(subprocess, "check_output", side_effect=no_nvidia), \
                    patch.object(torch.optim.AdamW, "step", checked_step):
                learner.main()
        finally:
            lease = folder / "learner-lease.json"
            if lease.exists():
                if json.loads(lease.read_text())["pid"] != os.getpid():
                    raise ValueError("Rehearsal must never remove another process's lease")
                lease.unlink()

    fit(full)
    try:
        fit(resumed, interrupt_epoch=2)
        raise AssertionError("Interrupted checkpoint path was not exercised")
    except SimulatedInterruption:
        pass
    checkpoint = torch.load(resumed / "checkpoint.pt", map_location="cpu", weights_only=True)
    if checkpoint["epoch"] != 1:
        raise AssertionError("Uncommitted checkpoint replaced the accepted epoch")
    before = sha(resumed / "checkpoint.pt")
    try:
        fit(resumed, resume=True, seed=2026102563)
        raise AssertionError("Wrong-schedule resume was accepted")
    except ValueError as error:
        if "another source, corpus or training schedule" not in str(error):
            raise
    if sha(resumed / "checkpoint.pt") != before:
        raise AssertionError("Rejected resume changed the accepted checkpoint")
    (resumed / "research-model.json").write_text('{"diagnosticOrphan":true}')
    fit(resumed, resume=True)
    if sha(full / "research-model.json") != sha(resumed / "research-model.json"):
        raise AssertionError("Resume changed the final selected model")
    end = torch.load(resumed / "checkpoint.pt", map_location="cpu", weights_only=True)
    uninterrupted = torch.load(full / "checkpoint.pt", map_location="cpu", weights_only=True)
    if any(not torch.equal(value, uninterrupted["model"][name]) for name, value in end["model"].items()):
        raise AssertionError("Resume changed final model tensors")
    # Every output remains explicitly ineligible for 5090/strength admission, including partial artifacts.
    for folder in (full, resumed):
        path = folder / "research-model.json"
        artifact = json.loads(path.read_text())
        artifact.update({"untrainedDiagnostic": True, "cpuRehearsal": True, "trainingDevice": "cpu",
                         "scope": "Readiness rehearsal on smoke boards only; not a qualified trained student"})
        path.write_text(json.dumps(artifact, separators=(",", ":")))
        receipt_path = folder / "complete.json"
        receipt = json.loads(receipt_path.read_text())
        receipt.update({"cpuRehearsal": True, "eligibleForStrength": False, "modelFileSha256": sha(path)})
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    model_path = resumed / "research-model.json"
    artifact = json.loads(model_path.read_text())
    references = load_module("a19_cpu_rehearsal_reference", args.reference_generator.resolve())
    rows = train_rows + validation_rows
    fixture = {"manifestSha256": manifest["manifestSha256"], "sourceSha256": manifest["source"]["sha256"],
               "modelFileSha256": sha(model_path), "cpuRehearsal": True,
               "observations": [row["observation"] for row in rows],
               "expected": references.reference_predictions(artifact, rows, contract)}
    (output / "pytorch-references.json").write_text(json.dumps(fixture, separators=(",", ":"), allow_nan=False))
    report = {"schema": "hoc.ai.v0_9_a19_cpu_rehearsal.v1", "readyForGpu": False, "gpuWorkPerformed": False,
              "sourceSha256": manifest["source"]["sha256"], "learnerSourceSha256": sha(python_root / "a19_train.py"),
              "trainDecisions": len(train_rows), "validationDecisions": len(validation_rows),
              "dataScope": "Verified smoke boards only; disjoint rehearsal train/validation boards",
              "epochs": 4, "finiteGradientSteps": steps, "checkpointResumeExact": True,
              "orphanExportRecovered": True, "wrongScheduleRejectedWithoutCheckpointMutation": True,
              "modelPath": str(model_path), "modelFileSha256": sha(model_path),
              "hardwareReceiptIsExplicitlyUnqualified": True, "promoted": False,
              "realCudaVisibilityMask": os.environ.get("CUDA_VISIBLE_DEVICES"), "allOptimizerParametersOnCpu": True,
              "rehearsalSourceSha256": sha(Path(__file__)),
              "torchVersion": torch.__version__, "elapsedSeconds": time.monotonic() - started}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
