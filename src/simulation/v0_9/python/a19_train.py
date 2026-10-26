"""Fit the A19 research proposal model on verified current-rules corpus stages, on the approved 5090."""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import time

import torch
from torch.nn import functional as F

from a19_model import A19ProposalModel, a19_proposal_loss
from preflight import APPROVED_GPU_UUID


def verify_stage(campaign: Path, repository: Path, stage: str, bun: str) -> dict:
    result = subprocess.run([bun, str(repository / "src/simulation/v0_9/a19_pilot.ts"), "verify",
                             "--out", str(campaign), "--repository", str(repository), "--stage", stage],
                            check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def load_decisions(receipt: dict, expected_contract: str) -> list[dict]:
    rows = []
    rollouts = receipt["summary"]["teacherRollouts"]
    if rollouts not in (4, 8):
        raise ValueError("Unsupported registered independent rollout bank")
    for entry in receipt["files"]:
        raw = Path(entry["path"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise ValueError("Corpus file changed after its source-verified receipt")
        board = json.loads(raw)
        if board["manifestSha256"] != receipt["manifestSha256"] or board["stage"] != receipt["stage"]:
            raise ValueError("Mixed campaign or corpus phase")
        for game in board["games"]:
            outcome = {"win": 1.0, "draw": 0.5, "loss": 0.0}[game["record"]["candidateResult"]]
            for row in game["training"]["decisions"]:
                obs = row["observation"]
                if obs["contractSha256"] != expected_contract or row["outcome"] != outcome:
                    raise ValueError("Observation schema or completed-game outcome mismatch")
                if not 0 < len(obs["entities"]) <= 64 or not 1 < len(obs["candidates"]) <= 256:
                    raise ValueError("Observation exceeds the declared model shape; never silently truncate")
                if not 0 <= obs["actorIndex"] < len(obs["entities"]):
                    raise ValueError("Actor outside the live entity set")
                for target in obs["candidates"]:
                    if not -1 <= target["targetIndex"] < len(obs["entities"]):
                        raise ValueError("Candidate target outside the live entity set")
                if len(row["samples"]) != len(obs["candidates"]) or row["samples"][0] is None:
                    raise ValueError("Missing paired anchor rollout evidence")
                if not 0 <= row["selectedIndex"] < len(obs["candidates"]) or row["samples"][row["selectedIndex"]] is None:
                    raise ValueError("Teacher choice has no complete rollout evidence")
                for samples in row["samples"]:
                    if samples is not None and [x["index"] for x in samples] != list(range(rollouts)):
                        raise ValueError("Incomplete registered independent rollout bank")
                    if samples is not None and any(not 0 <= x["material"] <= 1 for x in samples):
                        raise ValueError("Invalid retained material tiebreak evidence")
                rows.append(row)
    if not rows:
        raise ValueError("Verified corpus contains no trainable decisions")
    return rows


def collate(rows: list[dict], device: torch.device):
    observations = [row["observation"] for row in rows]
    n, c = max(len(x["entities"]) for x in observations), max(len(x["candidates"]) for x in observations)
    entities = torch.zeros(len(rows), n, len(observations[0]["entities"][0]))
    entity_mask = torch.zeros(len(rows), n, dtype=torch.bool)
    candidates = torch.zeros(len(rows), c, len(observations[0]["candidates"][0]["features"]))
    target = torch.full((len(rows), c), -1, dtype=torch.long)
    candidate_mask = torch.zeros(len(rows), c, dtype=torch.bool)
    action_mask = torch.zeros(len(rows), c, dtype=torch.bool)
    rollouts = len(rows[0]["samples"][0])
    if rollouts not in (4, 8) or any(len(row["samples"][0]) != rollouts for row in rows):
        raise ValueError("Mixed or unsupported independent rollout banks")
    samples = torch.zeros(len(rows), c, rollouts)
    for i, (row, obs) in enumerate(zip(rows, observations)):
        entities[i, :len(obs["entities"])] = torch.tensor(obs["entities"])
        entity_mask[i, :len(obs["entities"])] = True
        action_mask[i, :len(obs["candidates"])] = True
        for j, action in enumerate(obs["candidates"]):
            candidates[i, j] = torch.tensor(action["features"])
            target[i, j] = action["targetIndex"]
            if row["samples"][j] is not None:
                values = torch.tensor([sample["value"] for sample in row["samples"][j]])
                if not torch.isfinite(values).all():
                    raise ValueError("Non-finite scored action")
                samples[i, j] = values
                candidate_mask[i, j] = True
    inputs = (entities, entity_mask, torch.tensor([x["globals"] for x in observations], dtype=torch.float32),
              torch.tensor([x["terrain"] for x in observations], dtype=torch.long),
              torch.tensor([x["actorIndex"] for x in observations], dtype=torch.long), candidates, target)
    if any(x.is_floating_point() and not torch.isfinite(x).all() for x in inputs):
        raise ValueError("Non-finite model input")
    return tuple(x.to(device) for x in inputs), samples.to(device), candidate_mask.to(device), torch.tensor([x["outcome"] for x in rows], dtype=torch.float32, device=device), torch.tensor([x["selectedIndex"] for x in rows], dtype=torch.long, device=device), action_mask.to(device)


def evaluate(model, rows, device, batch_size):
    model.eval()
    total, correct, regret, value_error, policy_error, unscored = 0, 0, 0.0, 0.0, 0.0, 0
    with torch.no_grad():
        for first in range(0, len(rows), batch_size):
            chunk = rows[first:first + batch_size]
            inputs, samples, mask, outcomes, selected_indices, action_mask = collate(chunk, device)
            logits, value, primary = model(*inputs)
            means = samples.mean(-1)
            selected = primary.masked_fill(~mask, -torch.inf).argmax(-1)
            best = means.masked_fill(~mask, -torch.inf).argmax(-1)
            full_choice = logits.masked_fill(~action_mask, -torch.inf).argmax(-1)
            correct += int((full_choice == selected_indices).sum())
            unscored += int((~mask.gather(1, full_choice[:, None])).sum())
            policy_error += float(F.cross_entropy(logits.masked_fill(~action_mask, -torch.inf), selected_indices, reduction="sum"))
            regret += float((means.gather(1, best[:, None]) - means.gather(1, selected[:, None])).sum())
            value_error += float(F.binary_cross_entropy_with_logits(value, outcomes, reduction="sum"))
            total += len(chunk)
    return {"decisions": total, "scoredSubsetRegret": regret / total, "teacherPolicyTop1": correct / total,
            "policyLogLoss": policy_error / total, "unscoredProposalRate": unscored / total, "valueLogLoss": value_error / total}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bun", default="bun")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--seed", type=int, default=2026102562)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    campaign, repository, output = args.campaign.resolve(), args.repository.resolve(), args.out.resolve()
    if (output.exists() and not args.resume) or output.parent != campaign / "models":
        raise ValueError("Choose a fresh output immediately under this isolated pilot's models directory")
    if args.resume and not (output / "checkpoint.pt").is_file():
        raise ValueError("Resume requires an accepted epoch checkpoint; preserve failed startup output")
    if not 1 <= args.epochs <= 100 or not 1 <= args.batch_size <= 256:
        raise ValueError("Invalid bounded training schedule")
    if os.environ.get("CUDA_VISIBLE_DEVICES") != APPROVED_GPU_UUID:
        raise ValueError("CUDA_VISIBLE_DEVICES must name the approved RTX 5090 UUID exactly")
    if Path(__file__).resolve() != repository / "src/simulation/v0_9/python/a19_train.py":
        raise ValueError("Run the learner contained in the source-verified frozen repository")
    if not torch.cuda.is_available():
        raise RuntimeError("Approved CUDA device unavailable; refusing CPU substitution")
    apps = subprocess.check_output(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader"], text=True)
    if any(line.split(",")[0].strip() == APPROVED_GPU_UUID and line.split(",")[1].strip() != str(os.getpid()) for line in apps.splitlines()):
        raise RuntimeError("Approved GPU already has a compute workload; leave it untouched")
    train_receipt = verify_stage(campaign, repository, "corpus_train", args.bun)
    validation_receipt = verify_stage(campaign, repository, "corpus_validation", args.bun)
    if train_receipt["manifestSha256"] != validation_receipt["manifestSha256"]:
        raise ValueError("Train/validation manifest mismatch")
    train_paths = {entry["path"] for entry in train_receipt["files"]}
    if train_paths.intersection(entry["path"] for entry in validation_receipt["files"]):
        raise ValueError("Training and validation corpora overlap")
    contract = json.loads((campaign / "feature-contract.json").read_text())
    if contract["contractSha256"] != train_receipt["observationSha256"]:
        raise ValueError("Feature contract mismatch")
    output.mkdir(parents=True, exist_ok=args.resume)
    lease = output / "learner-lease.json"
    descriptor = os.open(lease, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(descriptor, json.dumps({"pid": os.getpid(), "manifestSha256": train_receipt["manifestSha256"]}).encode())
    os.close(descriptor)
    atexit.register(lambda: lease.unlink(missing_ok=True))
    hardware = output / f"hardware-{time.time_ns()}"
    hardware.mkdir()
    preflight = subprocess.run([os.sys.executable, str(Path(__file__).with_name("preflight.py")),
                               "--gpu-uuid", APPROVED_GPU_UUID, "--output-directory", str(hardware),
                               "--expected-feature-hash", contract["contractSha256"]], text=True, capture_output=True)
    (hardware / "preflight.log").write_text(preflight.stdout + preflight.stderr)
    if preflight.returncode:
        raise RuntimeError(f"GPU preflight failed; inspect {hardware / 'preflight.log'}")
    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = torch.device("cuda:0")
    train = load_decisions(train_receipt, contract["contractSha256"])
    validation = load_decisions(validation_receipt, contract["contractSha256"])
    model = A19ProposalModel(len(contract["entities"]), len(contract["candidates"]), len(contract["globals"])).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.0001)
    corpus_sha256 = hashlib.sha256(json.dumps([
        [receipt["stage"], [entry["sha256"] for entry in receipt["files"]]]
        for receipt in [train_receipt, validation_receipt]
    ], separators=(",", ":")).encode()).hexdigest()
    best = float("inf")
    best_artifact = None
    first_epoch = 0
    if args.resume:
        checkpoint = torch.load(output / "checkpoint.pt", map_location=device, weights_only=True)
        if (checkpoint["manifestSha256"] != train_receipt["manifestSha256"] or
                checkpoint["corpusSha256"] != corpus_sha256 or checkpoint["seed"] != args.seed or
                checkpoint["epochs"] != args.epochs or checkpoint["batchSize"] != args.batch_size):
            raise ValueError("Checkpoint belongs to another source, corpus or training schedule")
        model.load_state_dict(checkpoint["model"])
        optimizer.load_state_dict(checkpoint["optimizer"])
        torch.set_rng_state(checkpoint["cpuRng"].cpu())
        torch.cuda.set_rng_state(checkpoint["cudaRng"].cpu())
        best = checkpoint["bestValidationPolicyLoss"]
        best_artifact = checkpoint["bestArtifact"]
        # A crash may leave a newer, uncommitted JSON export. The accepted epoch checkpoint wins.
        temporary = output / "research-model.tmp.json"
        temporary.write_text(json.dumps(best_artifact, separators=(",", ":")))
        temporary.replace(output / "research-model.json")
        first_epoch = checkpoint["epoch"] + 1
    for epoch in range(first_epoch, args.epochs):
        started = time.monotonic()
        model.train()
        order = list(range(len(train)))
        random.Random(args.seed + epoch).shuffle(order)
        losses = 0.0
        for first in range(0, len(order), args.batch_size):
            rows = [train[i] for i in order[first:first + args.batch_size]]
            inputs, samples, mask, outcomes, selected_indices, action_mask = collate(rows, device)
            optimizer.zero_grad(set_to_none=True)
            logits, value, primary = model(*inputs)
            loss, _ = a19_proposal_loss(logits, value, primary, samples, mask, outcomes, selected_indices, action_mask)
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite learner loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses += float(loss.detach()) * len(rows)
        metrics = evaluate(model, validation, device, args.batch_size)
        record = {"epoch": epoch, "trainingLoss": losses / len(train), "validation": metrics,
                  "elapsedSeconds": time.monotonic() - started, "cudaPeakMemoryBytes": torch.cuda.max_memory_allocated()}
        with (output / "epochs.jsonl").open("a") as log:
            log.write(json.dumps(record) + "\n")
        print(json.dumps(record), flush=True)
        if metrics["policyLogLoss"] < best:
            best = metrics["policyLogLoss"]
            best_artifact = {"schema": "hoc.ai.v0_9_a19_proposal_float.v2", "promoted": False,
                        "manifestSha256": train_receipt["manifestSha256"], "sourceSha256": train_receipt["sourceSha256"],
                        "observationSha256": contract["contractSha256"], "epoch": epoch, "validation": metrics,
                        "weights": {key: value.detach().cpu().tolist() for key, value in model.state_dict().items()}}
            temporary = output / "research-model.tmp.json"
            temporary.write_text(json.dumps(best_artifact, separators=(",", ":")))
            temporary.replace(output / "research-model.json")
        temporary = output / "checkpoint.tmp.pt"
        torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "epoch": epoch,
                    "manifestSha256": train_receipt["manifestSha256"], "seed": args.seed,
                    "epochs": args.epochs, "batchSize": args.batch_size,
                    "corpusSha256": corpus_sha256, "bestValidationPolicyLoss": best,
                    "bestArtifact": best_artifact,
                    "cpuRng": torch.get_rng_state(), "cudaRng": torch.cuda.get_rng_state()}, temporary)
        temporary.replace(output / "checkpoint.pt")
    # Sealed stage bytes must still be identical after fitting.
    for receipt in [train_receipt, validation_receipt]:
        for entry in receipt["files"]:
            if hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest() != entry["sha256"]:
                raise RuntimeError("Corpus changed during fitting; artifact is ineligible")
    (output / "complete.json").write_text(json.dumps({"promoted": False, "epochs": args.epochs,
        "manifestSha256": train_receipt["manifestSha256"], "bestValidationPolicyLoss": best,
        "modelFileSha256": hashlib.sha256((output / "research-model.json").read_bytes()).hexdigest()}, indent=2) + "\n")


if __name__ == "__main__":
    main()
