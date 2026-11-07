"""Verify every registered strict root and future before producing tensor packs."""
from __future__ import annotations

import argparse
from pathlib import Path
import os
import time

from a19_feature_admission import read, require, sha, verify_files
from a19_feature_data import admit_batch, collate_roots, validate_scenarios
from a19_feature_train import exclusive


def prepare(root: Path) -> dict:
    started = time.monotonic()
    registration = read(root / "collection-registration.json")
    verify_files(root, registration["files"])
    require(sha(root / "banks.json") == registration["banksSha256"], "Registered bank changed")
    banks = read(root / "banks.json")
    exclusions = read(root / "historical-exclusions.json")
    require(sha(root / "historical-exclusions.json") == banks["historicalExclusionsSha256"], "Exclusion ledger changed")
    validate_scenarios(banks["tasks"], set(exclusions["excludedChannels"]))
    for stage in ["roots", "returns"]:
        for shard in range(2):
            receipt = read(root / f"data/{stage}-shard-{shard}.json")
            require(receipt["passed"] and receipt["dataIdentitySha256"] == registration["dataIdentitySha256"],
                    "Incomplete/foreign collection shard")
    roots, root_hashes, branches, files = {}, {}, {}, {}
    expected = set()
    for task in banks["tasks"]:
        family = task["family"]
        require(not Path(family).is_absolute() and ".." not in Path(family).parts, "Invalid family path")
        rel = f"data/roots/{family}.json"
        expected.add(rel)
        row = read(root / rel)
        require(row["dataIdentitySha256"] == registration["dataIdentitySha256"], "Foreign collection root")
        roots[family], root_hashes[family] = row, sha(root / rel)
        files[rel] = root_hashes[family]
        if row["selected"] is not None:
            for action in range(len(row["selected"]["signatures"])):
                for world in range(8):
                    rel = f"data/returns/{family}/{action}-{world}.json"
                    expected.add(rel)
                    branch = read(root / rel)
                    require(branch["dataIdentitySha256"] == registration["dataIdentitySha256"], "Foreign collection return")
                    branches[(family, action, world)] = branch
                    files[rel] = sha(root / rel)
    actual = {str(p.relative_to(root)) for folder in ["roots", "returns"]
              for p in (root / "data" / folder).rglob("*.json")}
    require(actual == expected, "Foreign/missing data artifact")
    design = read(root / "design.json")
    admitted = admit_batch(banks["tasks"], roots, branches, root_hashes,
                           namespace=banks["futureNamespace"], contract_sha256=design["observationSha256"])
    result = {"complete": True, "dataIdentitySha256": registration["dataIdentitySha256"],
              "registeredScenarios": admitted["registeredScenarios"], "missing": admitted["missing"],
              "pairedContinuations": admitted["pairedContinuations"], "sourceFiles": files,
              "validationOutcomeFiltering": False, "validationRefills": 0}
    exclusive(root / "data-admission.json", result)
    # No alternate cases or validation information quotas are introduced here.
    import torch
    torch.set_num_threads(2)
    destination = root / "packs"
    destination.mkdir(exist_ok=False)
    manifest = {"complete": True, "validationOutcomeFiltering": False, "validationRefills": 0,
                "dataAdmissionSha256": sha(root / "data-admission.json"), "torchVersion": torch.__version__}
    for split in ["train", "validation"]:
        rows = [row for row in admitted["rows"] if row["task"]["phase"] == split]
        require(bool(rows), "No usable roots in fixed split; do not refill validation")
        pack = collate_roots(rows)
        path = destination / f"{split}.pt"
        torch.save(pack, path)
        manifest[split] = {"path": str(path.relative_to(root)), "sha256": sha(path), "rows": len(rows),
                           "families": pack["families"]}
    owner = root.parent / "v09-independent-20261027/kit12h-20261102"
    for split, name in [("train", "warmTrain"), ("validation", "warmValidation")]:
        path = owner / f"warm-{split}.pt"
        receipt_path = owner / f"warm-{split}-ready.json"
        receipt = read(receipt_path)
        require(sha(path) == receipt["filesSha256"], "Warm teacher tensor pack changed")
        manifest[name] = {"path": os.path.relpath(path, root),
                          "sha256": sha(path), "families": receipt["families"], "rows": receipt["rows"]}
    verify_files(root, registration["files"])
    manifest["preparationSeconds"] = time.monotonic() - started
    exclusive(root / "data-manifest.json", manifest)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    import json
    result = prepare(args.root.resolve())
    print(json.dumps({k: v if k not in ["train", "validation", "warmTrain", "warmValidation"]
                     else {n: x for n, x in v.items() if n != "families"} for k, v in result.items()}, indent=2))
