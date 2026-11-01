"""Build CPU PyTorch reference predictions from accepted exported weights; never fit or update weights."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch

from a19_model import A19ProposalModel
from a19_train import collate, load_decisions, verify_stage


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def reference_predictions(artifact: dict, rows: list[dict], contract: dict) -> list[dict]:
    """Read the same float32 JSON export as Bun, with PyTorch's independent matrix implementation."""
    model = A19ProposalModel(len(contract["entities"]), len(contract["candidates"]), len(contract["globals"]))
    parameters = {key: torch.tensor(value, dtype=torch.float32) for key, value in artifact["weights"].items()}
    if any(not torch.isfinite(value).all() for value in parameters.values()):
        raise ValueError("Non-finite exported model weight")
    model.load_state_dict(parameters, strict=True)
    model.eval()
    result = []
    with torch.no_grad():
        for first in range(0, len(rows), 16):
            batch = rows[first:first + 16]
            inputs, *_ = collate(batch, torch.device("cpu"))
            policy, value, primary = model(*inputs)
            if any(not torch.isfinite(tensor).all() for tensor in (policy, value, primary)):
                raise ValueError("Non-finite PyTorch reference prediction")
            for index, row in enumerate(batch):
                count = len(row["observation"]["candidates"])
                result.append({"policy": policy[index, :count].tolist(), "primary": primary[index, :count].tolist(),
                               "valueLogit": float(value[index])})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--actor-repository", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--fit-receipt", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bun", default="bun")
    parser.add_argument("--maximum-observations", type=int, default=128)
    args = parser.parse_args()
    if not 96 <= args.maximum_observations <= 512 or args.out.exists():
        raise ValueError("Choose 96..512 reference observations and a fresh output file")
    torch.set_num_threads(2)
    torch.set_grad_enabled(False)
    campaign, repository = args.campaign.resolve(), args.actor_repository.resolve()
    manifest = json.loads((campaign / "manifest.json").read_text())
    contract = json.loads((campaign / "feature-contract.json").read_text())
    for name in ("a19_model.py", "a19_train.py"):
        relative = "src/simulation/v0_9/python/" + name
        if sha(Path(__file__).with_name(name).read_bytes()) != manifest["source"]["files"][relative]:
            raise ValueError("Reference implementation changed from the accepted learner")
    raw = args.model.read_bytes()
    model = json.loads(raw)
    receipt = json.loads(args.fit_receipt.read_text())
    if (
        args.model.resolve() != args.fit_receipt.resolve().parent / "research-model.json"
        or model.get("schema") != "hoc.ai.v0_9_a19_proposal_float.v2"
        or model.get("promoted") is not False or model.get("untrainedDiagnostic") is True
        or receipt.get("promoted") is not False or receipt.get("modelFileSha256") != sha(raw)
        or receipt.get("manifestSha256") != manifest["manifestSha256"]
        or model.get("manifestSha256") != manifest["manifestSha256"]
        or model.get("sourceSha256") != manifest["source"]["sha256"]
        or model.get("observationSha256") != contract["contractSha256"]
        or not isinstance(receipt.get("epochs"), int) or receipt["epochs"] < 1
        or not isinstance(model.get("epoch"), int) or not 0 <= model["epoch"] < receipt["epochs"]
        or receipt.get("bestValidationPolicyLoss") != model.get("validation", {}).get("policyLogLoss")
    ):
        raise ValueError("Use the accepted fitted model and its matching completion receipt")
    corpus = verify_stage(campaign, repository, "corpus_validation", args.bun)
    if corpus["manifestSha256"] != manifest["manifestSha256"] or corpus["sourceSha256"] != manifest["source"]["sha256"]:
        raise ValueError("Validation corpus belongs to another campaign or source")
    rows = load_decisions(corpus, contract["contractSha256"])
    rows.sort(key=lambda row: sha(json.dumps([row["seedBase"], row["ordinal"], row["team"], row["lap"]]).encode()))
    rows = rows[:args.maximum_observations]
    if len(rows) < 96:
        raise ValueError("Accepted validation corpus has fewer than 96 reference states")
    fixture = {
        "schema": "hoc.ai.v0_9_a19_pytorch_references.v1",
        "scope": "Read-only CPU predictions of accepted 5090-trained weights on verified validation states",
        "manifestSha256": manifest["manifestSha256"], "sourceSha256": manifest["source"]["sha256"],
        "modelFileSha256": sha(raw), "fitReceiptFileSha256": sha(args.fit_receipt.read_bytes()),
        "generatorSourceSha256": sha(Path(__file__).read_bytes()),
        "observations": [row["observation"] for row in rows],
        "expected": reference_predictions(model, rows, contract),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x") as output:
        json.dump(fixture, output, separators=(",", ":"), allow_nan=False)
        output.write("\n")
    print(json.dumps({"fixtureFileSha256": sha(args.out.read_bytes()), "modelFileSha256": sha(raw),
                      "observations": len(rows), "device": "cpu", "optimizationSteps": 0}))


if __name__ == "__main__":
    main()
