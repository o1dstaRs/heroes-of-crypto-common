"""Portable research pair export; this module does not import a training backend."""
from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from typing import Any


def policy_head_sha256(weights: dict[str, Any]) -> str:
    matrix, bias = weights.get("policy.weight"), weights.get("policy.bias")
    if not isinstance(matrix, list) or len(matrix) != 1 or len(matrix[0]) != 64 or not isinstance(bias, list) or len(bias) != 1:
        raise ValueError("a policy head must contain 64 weights and one bias")
    values = matrix[0] + bias
    if not all(type(value) in [float, int] and math.isfinite(value) for value in values):
        raise ValueError("invalid policy-head values")
    try:
        raw = struct.pack("<65f", *values)
    except (OverflowError, struct.error) as error:
        raise ValueError("policy head exceeds float32") from error
    if not all(math.isfinite(value) for value in struct.unpack("<65f", raw)):
        raise ValueError("policy head exceeds float32")
    return hashlib.sha256(raw).hexdigest()


def encode_head_pair(student: dict[str, Any], partner: dict[str, Any], *, initial_heads: dict[str, str],
                     train_members: str, registration_sha256: str, trainer_sha256: str,
                     observation_sha256: str, initial_student_sha256: str, initial_partner_sha256: str,
                     recipe_ordinal: int, checkpoint_epoch: int, functional_fixture: bool = False) -> dict[str, bytes]:
    if train_members not in ["student", "joint"]:
        raise ValueError("invalid exportable head-pair training members")
    for digest in [registration_sha256, trainer_sha256, observation_sha256, initial_student_sha256,
                   initial_partner_sha256, initial_heads.get("student"), initial_heads.get("partner")]:
        if not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
            raise ValueError("head-pair export requires complete source/input identities")
    if type(recipe_ordinal) is not int or recipe_ordinal < 0 or type(checkpoint_epoch) is not int or checkpoint_epoch < -1 or type(functional_fixture) is not bool:
        raise ValueError("invalid head-pair checkpoint identity")
    encode = lambda value: (json.dumps(value, indent=2, allow_nan=False) + "\n").encode()
    bundle, members = {}, {}
    for role, weights in [("student", student), ("partner", partner)]:
        head = policy_head_sha256(weights)
        if train_members == "student" and role == "partner" and head != initial_heads[role]:
            raise ValueError("a frozen-partner control cannot export a changed partner")
        path = "model.json" if role == "student" else "partner-model.json"
        artifact = {"schema": "hoc.ai.v0_9_a19_proposal_float.v2", "promoted": False,
                    "manifestSha256": registration_sha256, "sourceSha256": trainer_sha256,
                    "observationSha256": observation_sha256, "pairRole": role,
                    "recipeOrdinal": recipe_ordinal, "checkpointEpoch": checkpoint_epoch,
                    "syntheticFunctionalFixture": functional_fixture, "weights": weights}
        bundle[path] = encode(artifact)
        members[role] = {"file": path, "sha256": hashlib.sha256(bundle[path]).hexdigest(),
                         "initialHeadSha256": initial_heads[role], "headSha256": head}
    manifest = {"schema": "hoc.ai.v0_9.a19.research-head-pair.v1", "promoted": False,
                "trainingMembers": train_members, "registrationSha256": registration_sha256,
                "trainerSha256": trainer_sha256, "observationSha256": observation_sha256,
                "initialStudentSha256": initial_student_sha256, "initialPartnerSha256": initial_partner_sha256,
                "recipeOrdinal": recipe_ordinal, "checkpointEpoch": checkpoint_epoch,
                "syntheticFunctionalFixture": functional_fixture, "members": members}
    bundle["pair-manifest.json"] = encode(manifest)
    return bundle


def make_head_pair_finalist_lock(proof: dict[str, Any], objective: dict[str, Any]) -> dict[str, Any]:
    """Legacy single-model consumers fail rather than silently substitute a partner."""
    recipe = proof.get("recipe", {})
    if proof.get("weightsUpdated") is not True or recipe.get("trainingMembers") not in ["student", "joint"]:
        raise ValueError("head-pair finalist requires an updated complete pair")
    for name in ["pairManifestSha256", "studentModelSha256", "partnerModelSha256"]:
        if not isinstance(proof.get(name), str) or not re.fullmatch("[0-9a-f]{64}", proof[name]):
            raise ValueError("head-pair finalist needs both complete member identities")
    if type(recipe.get("ordinal")) is not int or recipe["ordinal"] < 0:
        raise ValueError("invalid head-pair finalist ordinal")
    return {"schema": "hoc.ai.v0_9.a19.research-head-pair-finalist.v1", "promotion": False,
            "ordinal": recipe["ordinal"], "pairManifestSha256": proof["pairManifestSha256"],
            "studentModelSha256": proof["studentModelSha256"], "partnerModelSha256": proof["partnerModelSha256"],
            "trainingMembers": recipe["trainingMembers"], "objective": objective,
            "selection": "Both members locked together before development games; no fallback finalist"}
