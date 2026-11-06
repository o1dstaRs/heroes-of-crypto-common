"""Registered small-capacity feature fits; no campaign runs on import or CPU fallback."""
from __future__ import annotations

import argparse
import copy
import fcntl
import gc
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

from a19_feature_admission import (GPU_UUID, GIB, admit_gpu, check_fit_design, check_gpu_environment, check_memory, gpu_snapshot,
                                   check_window, load_registration, memory_snapshot, read, require, sha, verify_files)
from a19_feature_data import validate_scenarios


def exclusive(path: Path, value: dict) -> None:
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def train(registration_path: Path) -> None:
    # Reject expired/unfunded/unbound requests before torch/CUDA or output creation.
    check_gpu_environment()
    reg, auth = load_registration(registration_path)
    root = registration_path.resolve().parent
    check_fit_design(reg)
    weighting = reg.get("pairLossWeighting", "comparisons")
    require(weighting in ["comparisons", "roots"], "Unknown paired-root objective")
    checks = read(root / reg["preflightReceipt"])
    require(checks["passed"] and checks["featurePathGradientPassed"] and checks["exportGateParityPassed"]
            and checks["strictCollectorPassed"], "Source-bound functional preflights required")
    for path in [reg["preflightReceipt"], reg["dataManifest"], reg["initialModel"], reg["partnerModel"], reg["parityRows"]]:
        require(path in reg["files"], "Critical input not sealed: " + path)
    snapshot = memory_snapshot()
    check_memory(snapshot["hostAvailableBytes"], snapshot["ancestorHeadrooms"],
                 reg["estimatedPeakHostBytes"], reg["hostReserveBytes"])
    require(shutil.disk_usage(root).free >= reg["minimumFreeDiskBytes"], "Insufficient output disk reserve")
    import torch
    from torch.nn import functional as F
    from a19_model import A19ProposalModel
    from a19_feature_adapter import (A19FeatureAdapterModel, paired_gate_gain, paired_root_loss,
                                     roots_with_terminal_contrast, served_gate_choices, served_policy)
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    require(not torch.cuda.is_initialized(), "CUDA initialized before admission")
    manifest = read(root / reg["dataManifest"])
    require(manifest["complete"] is True and manifest["validationOutcomeFiltering"] is False,
            "Complete outcome-blind data admission required")
    require(manifest["validationRefills"] == 0, "Validation refills are forbidden")
    # Load only CPU tensors first; all data identity and coverage checks precede GPU admission.
    packs = {}
    for name in ["train", "validation", "warmTrain", "warmValidation"]:
        entry = manifest[name]
        require(entry["path"] in reg["files"] and sha(root / entry["path"]) == entry["sha256"],
                "Unsealed tensor pack: " + name)
        packs[name] = torch.load(root / entry["path"], map_location="cpu", weights_only=True, mmap=True)
    for split in ["train", "validation"]:
        pack = packs[split]
        require(pack["rows"] == manifest[split]["rows"] == len(pack["families"]) > 0, "Empty/partial root pack")
        require(len(set(pack["families"])) == pack["rows"], "Duplicate root family")
        require(all(t["phase"] == split for t in pack["scenarioTasks"]), "Wrong training role")
        require(pack["returns"].shape[-1] == 8, "Incomplete future pack")
        require(bool((pack["legal"].gather(1, pack["actions"].clamp_min(0)) | ~pack["mask"]).all()),
                "Labeled illegal action")
    validate_scenarios(packs["train"]["scenarioTasks"] + packs["validation"]["scenarioTasks"], set())
    # Repeated world/action comparisons never satisfy a root-family readiness count.
    informative_train = roots_with_terminal_contrast(packs["train"]["returns"], packs["train"]["mask"])
    require(int(informative_train.sum()) >= reg["minimumInformativeTrainRoots"], "Insufficient training information")
    require(not set(manifest["warmTrain"]["families"]) & set(manifest["warmValidation"]["families"]),
            "Warm teacher families overlap")
    initial = read(root / reg["initialModel"])
    partner_raw = read(root / reg["partnerModel"])
    require(not initial.get("syntheticFunctionalFixture", False) and
            not partner_raw.get("syntheticFunctionalFixture", False), "Synthetic fixtures are not training candidates")
    ew, cw, gw = reg["widths"]
    partner = A19ProposalModel(189, cw, gw).eval().requires_grad_(False)
    partner.load_state_dict({k: torch.tensor(v, dtype=torch.float32) for k, v in partner_raw["weights"].items()})
    verify_files(root, reg["files"])
    check_window(auth, reg["fitBudgetSeconds"])
    ownership = admit_gpu()
    require(torch.cuda.device_count() == 1, "Exactly one visible GPU required")
    device = torch.cuda.get_device_properties(0)
    require(device.name == "NVIDIA GeForce RTX 5090" and
            str(device.uuid).removeprefix("GPU-") == GPU_UUID.removeprefix("GPU-"), "Wrong physical GPU")
    out = root / reg["outputDirectory"]
    out.mkdir(parents=True, exist_ok=False)
    exclusive(out / "gpu-start.json", {"uuid": str(device.uuid), "atUnix": time.time(),
              "registrationSha256": sha(registration_path), "ownershipAdmission": ownership, "promotion": False})
    started = time.monotonic()
    last_gpu_check = 0.
    partner.to("cuda")
    # Root packs are small and fixed; warm data streams from CPU by sampled batch.
    for split in ["train", "validation"]:
        pack = packs[split]
        for key in ["inputs"]:
            pack[key] = [x.to("cuda") for x in pack[key]]
        for key in ["legal", "actions", "returns", "mask", "baseline", "eligibleOrder", "native", "baselineChoice"]:
            pack[key] = pack[key].to("cuda")

    def check_budget():
        nonlocal last_gpu_check
        check_window(auth, 1)
        require(time.monotonic() - started < reg["fitBudgetSeconds"], "Fit stage time cap")
        require(torch.cuda.memory_allocated() < 28 * GIB, "GPU allocation bound")
        require(shutil.disk_usage(root).free >= reg["minimumFreeDiskBytes"], "Disk reserve reached")
        memory = memory_snapshot()
        check_memory(memory["hostAvailableBytes"], memory["ancestorHeadrooms"],
                     reg["minimumRunningHeadroomBytes"], reg["hostReserveBytes"])
        if time.monotonic() - last_gpu_check >= 5:
            telemetry = gpu_snapshot()
            target_pids = {r["pid"] for r in telemetry["processes"] if r["gpuUuid"] == GPU_UUID}
            foreign = target_pids - {os.getpid()} - set(ownership["knownWslMirroredPids"])
            require(not foreign, "New GPU process report; stop owned fit for attribution")
            require(telemetry["devices"][GPU_UUID]["temperature"] < 80, "GPU temperature bound")
            print(json.dumps({"gpuHeartbeat": telemetry, "pid": os.getpid(),
                              "allocatedBytes": torch.cuda.memory_allocated()}), flush=True)
            last_gpu_check = time.monotonic()

    def warm_batch(pack, indices):
        # Historical pack columns match the original full legal-catalog teacher format.
        return [v.index_select(0, indices).to("cuda") for v in pack["columns"]]

    def trust(policy, baseline, legal):
        return (baseline.exp() * (baseline - policy).masked_fill(~legal, 0)).sum(-1).mean()

    def root_objective(model, split):
        pack = packs[split]
        student = model(*pack["inputs"])[0]
        with torch.no_grad():
            fixed = partner(pack["inputs"][0][:, :, :189], *pack["inputs"][1:])[0]
        policy = served_policy(student, fixed, pack["legal"])
        loss, details = paired_root_loss(policy, pack["actions"], pack["returns"], pack["mask"], weighting=weighting)
        return loss, trust(policy, pack["baseline"], pack["legal"]), policy, details

    @torch.no_grad()
    def validate(model):
        loss, kl, policy, details = root_objective(model, "validation")
        pack = packs["validation"]
        choices = served_gate_choices(policy, pack["native"], pack["eligibleOrder"])
        gains, known = paired_gate_gain(choices, pack["baselineChoice"], pack["actions"], pack["returns"], pack["mask"])
        warm = packs["warmValidation"]
        ce = 0.
        for first in range(0, warm["rows"], 128):
            check_budget()
            columns = warm_batch(warm, torch.arange(first, min(first + 128, warm["rows"])))
            fixed = partner(columns[0][:, :, :189], *columns[1:7])[0]
            probability = served_policy(model(*columns[:7])[0], fixed, columns[11])
            ce += float(F.nll_loss(probability, columns[10])) * len(columns[10])
        return {"pairLoss": float(loss), "pairLossWeighting": weighting,
                "comparisonWeightedLoss": float(details["comparisonWeightedLoss"]),
                "equalInformativeRootLoss": float(details["equalInformativeRootLoss"]),
                "nonTiedComparisons": int(details["nonTiedComparisons"]),
                "informativeRoots": int(details["informativeRoots"]), "kl": float(kl),
                "warmTeacherCE": ce / warm["rows"],
                "changedGateChoices": int((choices != pack["baselineChoice"]).sum()),
                "unlabeledGateChoices": int((~known).sum()),
                "meanLabeledPairedRootGain": float(gains[known].mean()) if bool(known.any()) else None}

    proofs = []
    for recipe in reg["recipes"]:
        check_budget()
        model = A19FeatureAdapterModel.from_artifact(initial, ew, cw, gw, rank=recipe["rank"], seed=recipe["seed"]).to("cuda").eval()
        parameters = [p for p in model.parameters() if p.requires_grad]
        optimizer = torch.optim.AdamW(parameters, lr=recipe["learningRate"], weight_decay=.001)
        baseline_model = A19FeatureAdapterModel.from_artifact(initial, ew, cw, gw, rank=0, seed=0).to("cuda").eval().requires_grad_(False)
        with torch.no_grad():
            for split in ["train", "validation"]:
                pack = packs[split]
                fixed = partner(pack["inputs"][0][:, :, :189], *pack["inputs"][1:])[0]
                predicted = served_policy(model(*pack["inputs"])[0], fixed, pack["legal"])
                require(float((predicted - pack["baseline"]).masked_fill(~pack["legal"], 0).abs().max()) < 2e-4,
                        "Initial served policy does not match collection")
        before = validate(model)
        best, best_state, best_epoch, stale = before, copy.deepcopy(model.state_dict()), -1, 0
        tick = time.monotonic()
        destination = out / str(recipe["ordinal"])
        destination.mkdir()
        exclusive(destination / "initial.json", before)
        for epoch in range(reg["maximumEpochs"]):
            check_budget()
            generator = torch.Generator(device="cpu").manual_seed(recipe["batchSeed"] + epoch)
            indices = torch.randint(packs["warmTrain"]["rows"], (reg["warmBatch"],), generator=generator)
            columns = warm_batch(packs["warmTrain"], indices)
            loss, kl, _, _ = root_objective(model, "train")
            with torch.no_grad():
                fixed = partner(columns[0][:, :, :189], *columns[1:7])[0]
                baseline = served_policy(baseline_model(*columns[:7])[0], fixed, columns[11])
            preservation = trust(served_policy(model(*columns[:7])[0], fixed, columns[11]), baseline, columns[11])
            objective = loss + recipe["klWeight"] * kl + reg["warmTrustWeight"] * preservation
            require(bool(torch.isfinite(objective)), "Nonfinite feature objective")
            optimizer.zero_grad(set_to_none=True)
            objective.backward()
            require(all(p.grad is not None and bool(torch.isfinite(p.grad).all()) for p in parameters), "Invalid feature gradient")
            torch.nn.utils.clip_grad_norm_(parameters, 1.)
            optimizer.step()
            measured = validate(model)
            observed_gate_safe = weighting != "roots" or (
                measured["unlabeledGateChoices"] == 0 and measured["meanLabeledPairedRootGain"] >= 0)
            if observed_gate_safe and measured["warmTeacherCE"] <= before["warmTeacherCE"] + reg["teacherCeTolerance"] and measured["pairLoss"] < best["pairLoss"] - 1e-5:
                best, best_state, best_epoch, stale = measured, copy.deepcopy(model.state_dict()), epoch, 0
            else:
                stale += 1
            with (destination / "epochs.jsonl").open("a") as stream:
                stream.write(json.dumps({"epoch": epoch, "objective": float(objective.detach()), "validation": measured,
                                         "bestEpoch": best_epoch}) + "\n")
            if epoch % 10 == 0:
                print(json.dumps({"recipe": recipe["ordinal"], "epoch": epoch, "validation": measured}), flush=True)
            if epoch + 1 >= reg["minimumEpochs"] and (stale >= reg["patience"] or time.monotonic() - tick >= reg["maximumFitSeconds"]):
                break
        model.load_state_dict(best_state)
        model.check_frozen_parameters()
        state = model.folded_state_dict()
        artifact = {"schema": "hoc.ai.v0_9_kit12h_proposal_float.v1", "promoted": False,
                    "manifestSha256": sha(registration_path), "sourceSha256": reg["trainerSha256"],
                    "observationSha256": reg["observationSha256"], "relation": False,
                    "weights": {k: v.tolist() for k, v in state.items()}}
        exclusive(destination / "model.json", artifact)
        # References are from the actual exported checkpoint, not a synthetic preflight model.
        cpu = model.folded_model()
        unfolded_cpu = copy.deepcopy(model).cpu()
        partner_cpu = copy.deepcopy(partner).cpu()
        references = []
        fold_error = 0.
        with torch.no_grad():
            for row in read(root / reg["parityRows"]):
                o = row["observation"]
                columns = [torch.tensor([o["entities"]], dtype=torch.float32),
                           torch.ones(1, len(o["entities"]), dtype=torch.bool),
                           torch.tensor([o["globals"]], dtype=torch.float32),
                           torch.tensor([o["terrain"]], dtype=torch.long),
                           torch.tensor([o["actorIndex"]], dtype=torch.long),
                           torch.tensor([[c["features"] for c in o["candidates"]]], dtype=torch.float32),
                           torch.tensor([[c["targetIndex"] for c in o["candidates"]]], dtype=torch.long)]
                predicted = cpu(*columns)
                unfolded = unfolded_cpu(*columns)
                fold_error = max(fold_error, *(float((a-b).abs().max()) for a, b in zip(predicted, unfolded)))
                require(fold_error < 2e-5, "Actual checkpoint folding changed predictions")
                fixed = partner_cpu(columns[0][:, :, :189], *columns[1:])[0]
                probability = served_policy(predicted[0], fixed, torch.ones_like(fixed, dtype=torch.bool))
                choice = served_gate_choices(probability, torch.tensor([row["native"]]),
                                             torch.tensor([row["eligible"]]))
                unfolded_choice = served_gate_choices(
                    served_policy(unfolded[0], fixed, torch.ones_like(fixed, dtype=torch.bool)),
                    torch.tensor([row["native"]]), torch.tensor([row["eligible"]]))
                require(bool(torch.equal(choice, unfolded_choice)), "Actual checkpoint folding changed served gate")
                references.append({**row, "expected": {"policy": predicted[0][0].tolist(),
                                    "valueLogit": predicted[1][0].item(), "primary": predicted[2][0].tolist()},
                                   "expectedGateChoice": int(choice[0])})
        exclusive(destination / "references.json", {"modelFileSha256": sha(destination / "model.json"),
                  "maximumFoldError": fold_error, "foldGateMismatches": 0, "rows": references})
        del cpu, unfolded_cpu, partner_cpu, references
        proof = {"complete": True, "recipe": recipe, "pairLossWeighting": weighting,
                 "before": before, "best": best, "bestEpoch": best_epoch,
                 "weightsUpdated": best_epoch >= 0, "pairImprovement": before["pairLoss"] - best["pairLoss"],
                 "modelFileSha256": sha(destination / "model.json"), "activeSeconds": time.monotonic() - tick,
                 "frozenParametersUnchanged": True, "trainableParameters": sum(p.numel() for p in parameters)}
        exclusive(destination / "complete.json", proof)
        proofs.append(proof)
        del model, optimizer, baseline_model, parameters, state, best_state
        gc.collect()
        torch.cuda.empty_cache()
    verify_files(root, reg["files"])
    eligible = [p for p in proofs if p["weightsUpdated"] and p["pairImprovement"] >= reg["minimumPairImprovement"]]
    if eligible:
        winner = min(eligible, key=lambda p: (p["best"]["pairLoss"], p["modelFileSha256"]))
        exclusive(out / "finalist-lock.json", {"ordinal": winner["recipe"]["ordinal"], "modelSha256": winner["modelFileSha256"],
                  "selection": "Validation locked before any development games; no fallback finalist",
                  "pairLossWeighting": weighting, "promotion": False})
    exclusive(out / "complete.json", {"complete": True, "fits": proofs, "updatedCandidates": len(eligible),
              "newStrengthGames": 0, "promotion": False, "elapsedSeconds": time.monotonic() - started})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registration", required=True, type=Path)
    args = parser.parse_args()
    check_gpu_environment()
    reg, _ = load_registration(args.registration)
    root = args.registration.resolve().parent
    require(sha(Path(__file__)) == reg["trainerSha256"], "Trainer source changed")
    def stop(*_):
        raise InterruptedError("Owned feature trainer interrupted")
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    with (root / reg["gpuLease"]).open("a") as lease:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        train(args.registration)


if __name__ == "__main__":
    main()
