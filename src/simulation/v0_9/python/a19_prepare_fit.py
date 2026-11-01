"""Complete CPU admission of qualified data and rehearsed tooling before the GPU launcher may run."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import time

import torch

from a19_gpu_continuation import validate_readiness
from a19_model import A19ProposalModel, a19_proposal_loss
from a19_train import collate, load_decisions, verify_stage


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_observation(observation: dict, contract: dict) -> None:
    entities, candidates = observation["entities"], observation["candidates"]
    vectors = [(observation["globals"], len(contract["globals"]))]
    vectors += [(row, len(contract["entities"])) for row in entities]
    vectors += [(row["features"], len(contract["candidates"])) for row in candidates]
    if (observation.get("schema") != contract["schema"] or observation.get("contractSha256") != contract["contractSha256"]
        or not 1 <= len(entities) <= contract["maximumEntities"] or not 2 <= len(candidates) <= contract["maximumCandidates"]
        or len(observation["entityIds"]) != len(entities) or len(set(observation["entityIds"])) != len(entities)
        or not isinstance(observation["actorIndex"], int) or not 0 <= observation["actorIndex"] < len(entities)
        or len(observation["terrain"]) != 256
        or any(not isinstance(value, int) or not 0 <= value < 5 for value in observation["terrain"])
        or len({row["signature"] for row in candidates}) != len(candidates)
        or any(not isinstance(row["targetIndex"], int) or not -1 <= row["targetIndex"] < len(entities) for row in candidates)
        or any(len(vector) != width or any(not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 8
                                          for value in vector) for vector, width in vectors)):
        raise ValueError("Full-corpus CPU scan found an incompatible or non-finite neural observation")


def validate_tooling(evidence: Path, manifest: dict):
    rehearsal = json.loads((evidence / "cpu-rehearsal-report.json").read_text())
    parity = json.loads((evidence / "cpu-trained-export-parity.json").read_text())
    engine = json.loads((evidence / "cpu-trained-model-smoke.json").read_text())
    model_sha = sha(evidence / "model.json")
    if (rehearsal.get("schema") != "hoc.ai.v0_9_a19_cpu_rehearsal.v1"
        or rehearsal.get("sourceSha256") != manifest["source"]["sha256"]
        or rehearsal.get("learnerSourceSha256") != manifest["source"]["files"]["src/simulation/v0_9/python/a19_train.py"]
        or rehearsal.get("gpuWorkPerformed") is not False or rehearsal.get("finiteGradientSteps", 0) < 1
        or rehearsal.get("checkpointResumeExact") is not True or rehearsal.get("orphanExportRecovered") is not True
        or rehearsal.get("wrongScheduleRejectedWithoutCheckpointMutation") is not True
        or rehearsal.get("hardwareReceiptIsExplicitlyUnqualified") is not True):
        raise ValueError("Exact learner CPU recovery rehearsal is incomplete")
    if rehearsal.get("realCudaVisibilityMask") != "" or rehearsal.get("allOptimizerParametersOnCpu") is not True:
        raise ValueError("The CPU rehearsal must prove its real CUDA mask stayed empty")
    if (parity.get("schema") != "hoc.ai.v0_9_a19_cpu_inference_diagnostic.v1"
        or parity.get("manifestSha256") != manifest["manifestSha256"] or parity.get("sourceSha256") != manifest["source"]["sha256"]
        or parity.get("observations", 0) < 32 or parity.get("fixtureModelBound") is not True
        or parity.get("untrainedDiagnostic") is not True or parity.get("resolvedRankingMismatches") != 0
        or parity.get("inferenceSourceSha256") != sha(Path(__file__).parent.parent / "a19_inference.ts")
        or not isinstance(parity.get("maximumAbsoluteError"), (int, float))
        or not math.isfinite(parity["maximumAbsoluteError"]) or not 0 <= parity["maximumAbsoluteError"] <= 0.00001
        or parity.get("permutationCases") != parity["observations"] or parity.get("candidateOrderCases") != parity["observations"]):
        raise ValueError("CPU-trained export parity is incomplete")
    if (engine.get("schema") != "hoc.ai.v0_9_a19_model_smoke.v1" or engine.get("diagnosticOnly") is not True
        or engine.get("strengthClaim") is not False or engine.get("boardBank") != "actor smoke only"
        or engine.get("actorSourceSha256") != manifest["source"]["sha256"]
        or engine.get("manifestSha256") != manifest["manifestSha256"] or engine.get("activeGames", 0) < 12
        or engine.get("exactAbstainingMatches", 0) < 12 or engine.get("rejectedActions") != 0
        or engine.get("inferred", 0) < 1 or engine.get("corrected", 0) < 1):
        raise ValueError("CPU-trained export has not exercised complete legal engine corrections and abstention parity")
    if any(report.get("modelFileSha256") != model_sha for report in (rehearsal, parity, engine)):
        raise ValueError("Readiness evidence used different CPU diagnostic weights")
    return {name: sha(evidence / name) for name in ("cpu-rehearsal-report.json", "cpu-trained-export-parity.json",
                                                   "cpu-trained-model-smoke.json", "model.json")}


def main():
    parser = argparse.ArgumentParser()
    for name in ("campaign", "actor-repository", "evidence", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--bun", default="bun")
    parser.add_argument("--engine-admission", type=Path)
    args = parser.parse_args()
    campaign, repository = args.campaign.resolve(), args.actor_repository.resolve()
    output = args.out.resolve()
    if output.exists() or platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise ValueError("Use a fresh CPU readiness output on the admitted Linux x64 actor host")
    started = time.monotonic()
    torch.set_num_threads(2)
    manifest = json.loads((campaign / "manifest.json").read_text())
    admission = json.loads(args.engine_admission.read_text()) if args.engine_admission else {}
    engine_admitted = (admission.get("schema") == "hoc.ai.v0_9_a19_engine_admission.v1"
        and admission.get("admitted") is True and admission.get("openEngineCorrectnessIssues") == 0
        and admission.get("manifestSha256") == manifest["manifestSha256"]
        and admission.get("sourceSha256") == manifest["source"]["sha256"]
        and admission.get("snapshotSourceSha256") == manifest["source"]["files"]["src/simulation/battle_snapshot.ts"])
    for name in ("a19_train.py", "a19_model.py"):
        if sha(Path(__file__).with_name(name)) != manifest["source"]["files"]["src/simulation/v0_9/python/" + name]:
            raise ValueError("CPU preparation differs from the admitted learner")
    evidence_sha = validate_tooling(args.evidence.resolve(), manifest)
    teacher = verify_stage(campaign, repository, "teacher_confirmation", args.bun)
    if (teacher["summary"]["statistics"]["games"] != 6000 or teacher["summary"]["statistics"]["lower95"] <= 0.5
        or teacher["summary"]["rejectedActions"] != 0):
        raise ValueError("Teacher has not qualified; do not spend GPU time")
    receipts = {stage: verify_stage(campaign, repository, stage, args.bun)
                for stage in ("corpus_train", "corpus_validation")}
    if any(receipt["summary"].get("hostPlatform") != "linux" or receipt["summary"].get("hostArchitecture") != "x64"
           for receipt in receipts.values()):
        raise ValueError("Fresh corpus must use the admitted Linux x64 actors")
    contract = json.loads((campaign / "feature-contract.json").read_text())
    if contract["contractSha256"] != manifest["observationSha256"]:
        raise ValueError("Prepared data has a different feature contract")
    all_paths = [entry["path"] for receipt in receipts.values() for entry in receipt["files"]]
    if len(set(all_paths)) != len(all_paths):
        raise ValueError("Fresh training and validation file sets overlap")
    data_started = time.monotonic()
    corpus = {}
    resident_rows = {}
    biggest_entities = biggest_candidates = None
    for stage, receipt in receipts.items():
        rows = load_decisions(receipt, contract["contractSha256"])
        resident_rows[stage] = rows
        for row in rows:
            check_observation(row["observation"], contract)
            for samples in row["samples"]:
                if samples is not None and any(not 0 <= sample["value"] <= 1 or not isinstance(sample["terminal"], bool)
                                               for sample in samples):
                    raise ValueError("Invalid retained rollout target")
        for first in range(0, len(rows), 32):
            collate(rows[first:first + 32], torch.device("cpu"))
        by_entities = max(rows, key=lambda row: len(row["observation"]["entities"]))
        by_candidates = max(rows, key=lambda row: len(row["observation"]["candidates"]))
        if biggest_entities is None or len(by_entities["observation"]["entities"]) > len(biggest_entities["observation"]["entities"]):
            biggest_entities = by_entities
        if biggest_candidates is None or len(by_candidates["observation"]["candidates"]) > len(biggest_candidates["observation"]["candidates"]):
            biggest_candidates = by_candidates
        corpus[stage] = {"manifestSha256": receipt["manifestSha256"], "files": receipt["files"],
                         "summarySha256": receipt["summary"]["summarySha256"], "decisions": len(rows)}
    data_seconds = time.monotonic() - data_started
    if data_seconds > 60:
        raise ValueError("CPU data preparation exceeds one minute; optimize it before starting the GPU window")
    # A worst-sized padded batch combines the actual maximum entity and candidate shapes.
    inputs, samples, mask, outcomes, selected, action_mask = collate([biggest_entities, biggest_candidates] * 16, torch.device("cpu"))
    model = A19ProposalModel(len(contract["entities"]), len(contract["candidates"]), len(contract["globals"]))
    artifact = json.loads((args.evidence / "model.json").read_text())
    model.load_state_dict({key: torch.tensor(value, dtype=torch.float32) for key, value in artifact["weights"].items()}, strict=True)
    policy, value, primary = model(*inputs)
    loss, _ = a19_proposal_loss(policy, value, primary, samples, mask, outcomes, selected, action_mask)
    loss.backward()
    if not torch.isfinite(loss) or any(parameter.grad is None or not torch.isfinite(parameter.grad).all() for parameter in model.parameters()):
        raise ValueError("The maximum actual corpus shape has a non-finite loss/gradient")
    report = {"schema": "hoc.ai.v0_9_a19_gpu_readiness.v1", "readyForGpu": engine_admitted, "promoted": False,
              "manifestSha256": manifest["manifestSha256"], "sourceSha256": manifest["source"]["sha256"],
              "learnerSourceSha256": manifest["source"]["files"]["src/simulation/v0_9/python/a19_train.py"],
              "hardwareStillRequired": True, "gpuWorkPerformed": False, "corpus": corpus,
              "checks": dict.fromkeys(("teacherQualified", "allCorpusRowsCheckedOnCpu", "trainValidationIndependent",
                  "exactLearnerCpuRehearsal", "checkpointResumeExact", "cpuExportParity", "activeEngineSmoke",
                  "maximumShapeBatchChecked"), True), "toolingEvidenceSha256": evidence_sha,
              "engineAdmissionFileSha256": sha(args.engine_admission) if args.engine_admission else None,
              "teacherSummarySha256": teacher["summary"]["summarySha256"], "cpuDataLoadAndCollationSeconds": data_seconds,
              "maximumActualBatchShape": {"batch": 32, "entities": inputs[0].shape[1], "candidates": inputs[5].shape[1]},
              "elapsedSeconds": time.monotonic() - started,
              "initialGpuWindowSeconds": 120, "maximumActiveFitSeconds": 1200,
              "note": "Full CPU preparation passed. Actual CUDA hardware, first-epoch throughput and trained-model confirmation remain."}
    report["checks"]["currentEngineAdmitted"] = engine_admitted
    if engine_admitted:
        validate_readiness(report, manifest, campaign, verify_files=True)
    else:
        report["note"] = "CPU data/tooling checks passed, but engine admission is unresolved. GPU launch remains blocked."
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"readyForGpu": engine_admitted, "readinessFileSha256": sha(output),
                      "trainDecisions": corpus["corpus_train"]["decisions"],
                      "validationDecisions": corpus["corpus_validation"]["decisions"],
                      "cpuDataLoadAndCollationSeconds": data_seconds, "gpuWorkPerformed": False}))


if __name__ == "__main__":
    main()
