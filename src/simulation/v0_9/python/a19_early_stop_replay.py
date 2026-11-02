"""Replay a fixed cheaper stop rule on recorded training histories, without fitting."""
from pathlib import Path
import argparse
import hashlib
import json
import math


def choose(history, minimum_epochs, patience, minimum_improvement):
    if (type(minimum_epochs) is not int or minimum_epochs < 1
        or type(patience) is not int or patience < 1
        or not math.isfinite(minimum_improvement) or minimum_improvement < 0):
        raise ValueError("Invalid early-stopping rule")
    if not history:
        raise ValueError("Cannot analyze an empty epoch history")
    for index, row in enumerate(history):
        if row["epoch"] != index or not math.isfinite(row["validation"]["policyLogLoss"]):
            raise ValueError("Epoch history must be contiguous with finite validation losses")
    best, best_epoch, stale = math.inf, -1, 0
    for row in history:
        epoch, loss = row["epoch"], row["validation"]["policyLogLoss"]
        if loss < best - minimum_improvement:
            best, best_epoch, stale = loss, epoch, 0
        else:
            stale += 1
        if epoch + 1 >= minimum_epochs and stale >= patience:
            return epoch + 1, best_epoch, best
    return len(history), best_epoch, best


def analyze(evidence, rule):
    cases, rejected = [], []
    recipes = {row["recipeSha256"]: row for row in evidence["registration"]["recipes"]}
    if len(recipes) != len(evidence["registration"]["recipes"]):
        raise ValueError("Duplicate registered recipes")
    seen = set()
    for fit in sorted(evidence["teachers"], key=lambda x: x["recipe"]["ordinal"]):
        identity = fit["recipeSha256"]
        if identity in seen or fit["recipe"] != recipes.get(identity) or fit.get("complete") is not True:
            raise ValueError("Incomplete, duplicate or unregistered fit")
        seen.add(identity)
        by_epoch = {}
        inconsistent = False
        for row in fit["history"]:
            if row["epoch"] in by_epoch:
                before = {k: v for k, v in by_epoch[row["epoch"]].items() if k not in ("activeSeconds", "cudaPeakAllocatedBytes")}
                after = {k: v for k, v in row.items() if k not in ("activeSeconds", "cudaPeakAllocatedBytes")}
                if before != after:
                    inconsistent = True
            by_epoch[row["epoch"]] = row
        if (fit.get("historyMalformedLines") or inconsistent
                or sorted(by_epoch) != list(range(fit["completedEpochs"]))):
            rejected.append({"recipeSha256": fit["recipeSha256"], "reason": "Incomplete or inconsistent epoch history"})
            continue
        history = [by_epoch[n] for n in range(fit["completedEpochs"])]
        baseline = choose(history, fit["recipe"]["minimumEpochsBeforeEarlyStop"],
                          fit["recipe"]["patienceEpochs"], fit["recipe"]["minimumValidationImprovement"])
        if baseline[1] != fit["bestEpoch"] or baseline[2] != fit["validation"]["policyLogLoss"]:
            raise ValueError("Recorded checkpoint does not match the original stopping rule")
        proposed = choose(history, rule["minimumEpochs"], rule["patienceEpochs"], rule["minimumValidationImprovement"])
        cutoff = proposed[0]
        observed_active = fit["activeSeconds"]
        prefix_active = history[cutoff - 1]["activeSeconds"]
        if not (math.isfinite(observed_active) and math.isfinite(prefix_active)
                and observed_active > 0 and 0 < prefix_active <= observed_active + 5):
            raise ValueError("Invalid recorded active fit timing")
        cases.append({"ordinal": fit["recipe"]["ordinal"], "recipeSha256": fit["recipeSha256"],
                      "width": fit["recipe"]["width"], "originalEpochs": fit["completedEpochs"],
                      "proposedEpochs": cutoff, "originalBestEpoch": fit["bestEpoch"],
                      "proposedBestEpoch": proposed[1], "identicalBestCheckpointSelected": proposed[1] == fit["bestEpoch"],
                      "originalValidationPolicyLoss": baseline[2], "proposedValidationPolicyLoss": proposed[2],
                      "validationLossIncrease": proposed[2] - baseline[2],
                      "observedOriginalActiveSeconds": observed_active,
                      "observedPrefixActiveSeconds": min(prefix_active, observed_active),
                      "originalBestCheckpointSha256": fit["bestCheckpointSha256"]})
    original = sum(row["observedOriginalActiveSeconds"] for row in cases)
    shortened = sum(row["observedPrefixActiveSeconds"] for row in cases)
    return {"schema": "hoc.ai.v09_early_stop_replay.v1", "rule": rule, "analyzedFits": len(cases),
            "rejectedHistories": rejected, "cases": cases,
            "identicalSelectedCheckpoints": sum(row["identicalBestCheckpointSelected"] for row in cases),
            "changedSelectedCheckpoints": sum(not row["identicalBestCheckpointSelected"] for row in cases),
            "maximumValidationLossIncrease": max((row["validationLossIncrease"] for row in cases), default=None),
            "observedOriginalActiveSeconds": original, "estimatedPrefixActiveSeconds": shortened,
            "estimatedActiveTimeReduction": 1 - shortened / original if original else None,
            "estimatedActiveTimeSpeedup": original / shortened if shortened else None,
            "allSelectedCheckpointsPreserved": bool(cases) and not rejected and all(row["identicalBestCheckpointSelected"] for row in cases),
            "gpuWorkPerformed": False, "currentTrainingChanged": False, "heldOutOpened": False,
            "interpretation": "Counterfactual stopping on actual same-recipe histories. Prefix timing excludes future control/checkpoint/startup differences; this is not a measured end-to-end speedup or a rule admitted to other datasets or architectures."}


def controls():
    rows = lambda values: [{"epoch": n, "validation": {"policyLogLoss": x}} for n, x in enumerate(values)]
    assert choose(rows([3, 2, 2, 2, 2]), 3, 2, .0001) == (4, 1, 2)
    assert choose(rows([3, 2, 2, 2, 1]), 3, 2, .0001)[1] == 1
    assert choose(rows([3, 2, 2, 2, 1]), 5, 4, .0001)[1] == 4
    assert choose(rows([2, 1.99995, 1.9998, 1.9998]), 4, 1, .0001) == (4, 2, 1.9998)
    return {"passed": True, "plateauLateImprovementAndMinimumDelta": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--registration", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    registration_bytes, evidence_bytes = args.registration.read_bytes(), args.evidence.read_bytes()
    record, evidence = json.loads(registration_bytes), json.loads(evidence_bytes)
    if record["originalRegistrationSha256"] != evidence["registration"]["registrationSha256"]:
        raise ValueError("Stopping rule and evidence belong to different registered sweeps")
    result = analyze(evidence, record["rule"])
    result["controls"] = controls()
    result["evidenceFileSha256"] = hashlib.sha256(evidence_bytes).hexdigest()
    result["registrationFileSha256"] = hashlib.sha256(registration_bytes).hexdigest()
    result["analyzerSourceSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with args.out.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    print(json.dumps({k: v for k, v in result.items() if k != "cases"}))
