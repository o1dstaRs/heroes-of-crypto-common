"""Admit complete, predeclared research roots without outcome-based filtering."""
from __future__ import annotations

from collections import Counter
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def permute_seed(value: int) -> int:
    value = ((value ^ (value >> 16)) * 0x85EBCA6B) & 0xFFFFFFFF
    value = ((value ^ (value >> 13)) * 0xC2B2AE35) & 0xFFFFFFFF
    return (value ^ (value >> 16)) & 0xFFFFFFFF


def scenario_channels(seed: int) -> set[int]:
    require(type(seed) is int and 0 <= seed <= 0xFFFFFFFF - 2, "Invalid scenario seed")
    channels = {seed + i for i in range(3)} | {permute_seed(seed + i) for i in range(3)}
    require(len(channels) == 6, "Overlapping scenario seed channels")
    return channels


def paired_future_seed(namespace: str, seed: int, index: int, world: int) -> int:
    require(namespace.isascii() and bool(namespace), "Future namespace must be nonempty ASCII")
    value = 0x811C9DC5
    for part in [namespace, seed, index, world]:
        part = str(part)
        for char in f"{len(part)}:{part}|":
            value = ((value ^ ord(char)) * 0x01000193) & 0xFFFFFFFF
    return permute_seed(value)


def validate_scenarios(tasks: list[dict[str, Any]], excluded_channels: set[int]) -> None:
    seen = set(excluded_channels)
    families = set()
    for task in tasks:
        require(task["phase"] in ["train", "validation"], "Data sampler cannot filter strength games")
        require(task["family"] not in families, "Duplicate root family")
        families.add(task["family"])
        require(type(task["index"]) is int and 0 <= task["index"] < 4, "Invalid seat/color index")
        require(task["rootPhase"] in [0, 1, 2] and type(task["rootPhase"]) is int, "Invalid requested phase")
        require(task["map"] in [1, 3, 4], "Unexpected registered map")
        channels = scenario_channels(task["seed"])
        require(not channels & seen, "Overlapping registered scenario channels")
        seen.update(channels)


def admit_batch(tasks: list[dict[str, Any]], roots: dict[str, dict[str, Any]],
                branches: dict[tuple[str, int, int], dict[str, Any]], root_hashes: dict[str, str],
                *, namespace: str, contract_sha256: str) -> dict[str, Any]:
    """No outcome threshold, unit success quota, replacement case or phase fallback."""
    validate_scenarios(tasks, set())
    require(set(roots) == {t["family"] for t in tasks}, "Missing/foreign registered root")
    require(set(root_hashes) == set(roots), "Missing/foreign root hash")
    used = set()
    admitted = []
    missing = Counter()
    for task in tasks:
        family = task["family"]
        row = roots[family]
        require(row["task"] == task and row["strengthEvaluation"] is False, "Root task/role mismatch")
        require(row["trainingUseAllowed"] == (task["phase"] == "train"), "Training split flag mismatch")
        if not row.get("prefiltered", False):
            record = row["record"]
            require(record["endReason"] == "elimination" and
                    record["rejectedCandidate"] == record["rejectedOpponent"] == 0, "Incomplete/invalid root game")
            require(row["statistics"]["rootRestorationChecks"] > 0, "Root restoration evidence absent")
            for offset, key in enumerate(["pairSeed", "pickSeed", "battleSeed"]):
                require(record[key] == permute_seed(task["seed"] + offset), "Wrong root game seed")
            require(record["gridType"] == task["map"] and record["game"] == task["index"], "Wrong root map/index")
        diagnostic = row["captureDiagnostics"]
        require(diagnostic["requestedPhase"] == task["rootPhase"], "Capture request changed")
        position = row["selected"]
        require(row["labelRootUsable"] == (position is not None), "Root usability flag mismatch")
        if position is None:
            require(diagnostic["selectedPhase"] is None, "Missing root has a selected phase")
            reason = diagnostic["missingRootReason"]
            require(reason in ["focal_absent_from_draft", "no_focal_turn", "no_eligible_primary_tie",
                               "no_eligible_root_in_requested_phase"], "Missing root lacks explicit reason")
            if row.get("prefiltered"):
                require(bool(task.get("focal")), "Natural background cannot be presence-filtered")
                require(reason == "focal_absent_from_draft", "Prefilter may only exclude absent focal units")
            missing[reason] += 1
            continue
        require(not row.get("prefiltered", False), "Prefiltered case cannot produce labels")
        require(diagnostic["missingRootReason"] is None, "Selected root marked missing")
        require(position["team"] == row["targetTeam"], "Wrong target team")
        require(not task.get("focal") or position["actor"] == task["focal"], "Wrong focal actor")
        require(position["focalPresentAtRoot"] is True, "Missing focal root")
        lap = position["lap"]
        require(type(lap) is int and lap >= 1, "Invalid root lap")
        actual_phase = 0 if lap <= 2 else 1 if lap <= 5 else 2
        require(actual_phase == task["rootPhase"] == diagnostic["selectedPhase"], "Silent phase fallback")
        observation = position["observation"]
        require(observation["contractSha256"] == contract_sha256, "Observation contract changed")
        catalog = [c["signature"] for c in observation["candidates"]]
        signatures = position["signatures"]
        require(len(set(catalog)) == len(catalog), "Duplicate catalog signature")
        require(2 <= len(signatures) <= 3 and len(set(signatures)) == len(signatures), "Invalid labeled actions")
        require(set(signatures) <= set(position["eligibleSignatures"]) <= set(catalog), "Unscored/unknown action label")
        require(position["baselineSignature"] in signatures and position["nativeSignature"] in signatures,
                "Baseline/native action omitted")
        returns = []
        for action in range(len(signatures)):
            scores = []
            for world in range(8):
                key = (family, action, world)
                require(key in branches, "Incomplete paired future family")
                used.add(key)
                branch = branches[key]
                require(branch["task"] == {"stage": "returns", "task": task, "action": action, "world": world},
                        "Branch task mismatch")
                require(branch["rootFileSha256"] == root_hashes[family], "Branch root identity mismatch")
                require(branch["futureSeed"] == paired_future_seed(namespace, task["seed"], task["index"], world),
                        "Unexpected/unpaired future seed")
                require(branch["strengthEvaluation"] is False, "Branch role mismatch")
                require(branch["statistics"]["interventionApplied"] ==
                        branch["statistics"]["interventionExecuted"] == 1, "Intervention not executed once")
                require(branch["statistics"]["rootRestorationChecks"] > 0, "Missing branch restoration evidence")
                score = branch["score"]
                require(type(score) in [int, float] and score in [0, .5, 1], "Invalid completed-game score")
                scores.append(score)
            returns.append(scores)
        admitted.append({"family": family, "task": task, "observation": observation,
                         "actions": [catalog.index(s) for s in signatures], "returns": returns,
                         "eligibleOrder": [catalog.index(s) for s in position["eligibleSignatures"]],
                         "native": catalog.index(position["nativeSignature"]),
                         "baselineChoice": catalog.index(position["baselineSignature"]),
                         "baseline": position["baselinePrediction"]["policy"],
                         "actor": position["actor"], "lap": lap})
    require(set(branches) == used, "Foreign/unused continuation artifact")
    return {"complete": True, "registeredScenarios": len(tasks), "rows": admitted,
            "missing": dict(missing), "pairedContinuations": len(used),
            "validationOutcomeFiltering": False}


def collate_roots(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Pack admitted observations. Importing admission checks does not initialize torch."""
    import torch
    require(bool(rows), "No admissible roots")
    observations = [r["observation"] for r in rows]
    n = max(len(o["entities"]) for o in observations)
    c = max(len(o["candidates"]) for o in observations)
    b = len(rows)
    ew = len(observations[0]["entities"][0])
    cw = len(observations[0]["candidates"][0]["features"])
    e = torch.zeros(b, n, ew)
    em = torch.zeros(b, n, dtype=torch.bool)
    candidate = torch.zeros(b, c, cw)
    target = torch.full((b, c), -1, dtype=torch.long)
    legal = torch.zeros(b, c, dtype=torch.bool)
    actions = torch.full((b, 3), -1, dtype=torch.long)
    returns = torch.zeros(b, 3, 8)
    mask = torch.zeros(b, 3, dtype=torch.bool)
    baseline = torch.full((b, c), -1e9)
    eligible_order = torch.full((b, c), -1, dtype=torch.long)
    for i, row in enumerate(rows):
        o = row["observation"]
        count, count_c = len(o["entities"]), len(o["candidates"])
        e[i, :count] = torch.tensor(o["entities"], dtype=torch.float32)
        em[i, :count] = True
        candidate[i, :count_c] = torch.tensor([v["features"] for v in o["candidates"]], dtype=torch.float32)
        target[i, :count_c] = torch.tensor([v["targetIndex"] for v in o["candidates"]])
        legal[i, :count_c] = True
        size = len(row["actions"])
        actions[i, :size] = torch.tensor(row["actions"])
        returns[i, :size] = torch.tensor(row["returns"], dtype=torch.float32)
        mask[i, :size] = True
        require(len(row["baseline"]) == count_c, "Baseline policy/catalog mismatch")
        baseline[i, :count_c] = torch.tensor(row["baseline"], dtype=torch.float32)
        eligible_order[i, :len(row["eligibleOrder"])] = torch.tensor(row["eligibleOrder"], dtype=torch.long)
        require(0 <= o["actorIndex"] < count, "Invalid actor index")
        require(bool(((target[i, :count_c] >= -1) & (target[i, :count_c] < count)).all()), "Invalid target index")
    inputs = [e, em, torch.tensor([o["globals"] for o in observations], dtype=torch.float32),
              torch.tensor([o["terrain"] for o in observations], dtype=torch.long),
              torch.tensor([o["actorIndex"] for o in observations], dtype=torch.long), candidate, target]
    require(all(bool(torch.isfinite(v).all()) for v in [e, candidate, inputs[2], baseline]), "Nonfinite features")
    return {"inputs": inputs, "legal": legal, "actions": actions, "returns": returns, "mask": mask,
            "baseline": baseline, "families": [r["family"] for r in rows], "rows": b,
            "eligibleOrder": eligible_order, "native": torch.tensor([r["native"] for r in rows]),
            "baselineChoice": torch.tensor([r["baselineChoice"] for r in rows]),
            "scenarioTasks": [r["task"] for r in rows]}
