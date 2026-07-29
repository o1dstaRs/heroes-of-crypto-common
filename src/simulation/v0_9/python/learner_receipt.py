import hashlib
import json
from collections.abc import Mapping
from typing import Any


LEARNER_REJECTION_SCHEMA = "hoc.ai.v0_9_learner_rejection.v2"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def rejection_fingerprint_payload(rejection: Mapping[str, Any]) -> dict[str, Any]:
    """Return a cross-language-stable identity that binds the exact metrics file.

    Detailed floating-point evidence remains in the rejection and is committed by metricsSha256. Keeping
    floats out of this small outer seal avoids Python/JavaScript JSON number-spelling differences.
    """
    return {
        "schema": rejection["schema"],
        "reason": rejection["reason"],
        "runFingerprint": rejection["runFingerprint"],
        "sourceCommit": rejection["sourceCommit"],
        "corpusSha256": rejection["corpusSha256"],
        "hidden": rejection["hidden"],
        "metricsSha256": rejection["metricsSha256"],
    }


def seal_learner_rejection(unsigned: Mapping[str, Any]) -> dict[str, Any]:
    payload = rejection_fingerprint_payload(unsigned)
    return {
        **unsigned,
        "rejectionSha256": hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest(),
    }
