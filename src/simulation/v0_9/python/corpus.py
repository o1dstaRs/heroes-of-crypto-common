#!/usr/bin/env python3
"""Strict, torch-free validation for Heroes of Crypto v0.9 IL-v4 game shards."""

from __future__ import annotations

import argparse
import concurrent.futures
import glob
import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

CAMPAIGN_SCHEMA = "hoc.ai.v0_9_campaign.v1"
SEED_LEDGER_SCHEMA = "hoc.ai.v0_9_seed_ledger.v1"
IL_SCHEMA = "hoc.ai.v0_9_il.v4"
IL_VERSION = 4
DECISION_TYPE = "v09_il_decision"
GAME_TYPE = "v09_il_game"
FEATURE_SCHEMA = "hoc.ai.v0_9_features.il_v4.v1"
MODEL_SCHEMA = "hoc.ai.v0_9_model.v1"
FULL_FEATURE_SHA256 = "01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e"
APPROVED_GPU_UUID = "GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350"

SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_COMMIT = re.compile(r"^[0-9a-f]{7,64}$")
PURPOSES = {
    ("wide_teacher", "train"): "wide_teacher_train",
    ("wide_teacher", "validation"): "wide_teacher_validation",
    ("dagger_1", "train"): "dagger_1_train",
    ("dagger_1", "validation"): "dagger_1_validation",
    ("dagger_2", "train"): "dagger_2_train",
    ("dagger_2", "validation"): "dagger_2_validation",
}
ALL_PURPOSES = {*PURPOSES.values(), "confirmation", "qualification"}
TEACHER_COHORTS = (
    "ranked-draft",
    "uniform-mixed",
    "ranged-heavy",
    "ground-melee",
    "flyer-heavy",
    "caster-support",
    "cross-archetype",
    "mirror-anchor",
    "mirror-melee",
    "pure-ranged",
    "mixed-cyclops-tsar",
    "new-level4",
)
TEACHER_MAPS = ("normal", "water", "lava", "block")
DAGGER_PATTERNS = ("student-green", "student-red", "student-self-a", "student-self-b")
TEACHER_SCHEDULE = {
    "cohorts": list(TEACHER_COHORTS),
    "maps": list(TEACHER_MAPS),
    "daggerPatterns": list(DAGGER_PATTERNS),
}
PARALLEL_VALIDATION_MIN_SHARDS = 64
MAX_AUTOMATIC_VALIDATION_WORKERS = 24
COMMON_KEYS = (
    "runFingerprint",
    "featureFingerprints",
    "sourceCommit",
    "rulesFingerprint",
    "anchorFingerprint",
    "phase",
    "split",
    "cohort",
    "map",
    "seed",
    "gameId",
)

_validation_worker_campaign: dict[str, Any] | None = None
_validation_worker_ledger: dict[str, Any] | None = None


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def read_utf8_and_sha256(path: Path) -> tuple[str, str]:
    """Read a shard once while preserving the SHA-256 of its exact on-disk bytes."""

    source = path.read_bytes()
    return source.decode("utf-8"), hashlib.sha256(source).hexdigest()


def expand_paths(patterns: Sequence[str]) -> list[Path]:
    paths: set[Path] = set()
    for pattern in patterns:
        matches = [Path(value).resolve() for value in glob.glob(pattern, recursive=True)]
        if not matches and Path(pattern).is_file():
            matches = [Path(pattern).resolve()]
        paths.update(path for path in matches if path.is_file())
    if not paths:
        raise ValueError("no IL-v4 JSONL shards matched")
    return sorted(paths)


def _require_sha(value: Any, context: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ValueError(f"{context} must be a lowercase SHA-256")
    return value


def _unsigned(value: dict[str, Any], signature: str) -> dict[str, Any]:
    return {key: entry for key, entry in value.items() if key != signature}


def validate_campaign_manifest(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    path = path.resolve()
    campaign = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(campaign, dict):
        raise ValueError("campaign manifest must be an object")
    manifest_sha = _require_sha(campaign.get("manifestSha256"), "campaign manifestSha256")
    if (
        campaign.get("schema") != CAMPAIGN_SCHEMA
        or campaign.get("promoted") is not False
        or campaign.get("durationHours") != 168
        or fingerprint(_unsigned(campaign, "manifestSha256")) != manifest_sha
    ):
        raise ValueError("campaign manifest identity mismatch")
    schemas = campaign.get("schemas")
    features = campaign.get("featureFingerprints")
    identity = campaign.get("identity")
    if (
        not isinstance(schemas, dict)
        or schemas.get("il") != IL_SCHEMA
        or schemas.get("features") != FEATURE_SCHEMA
        or schemas.get("model") != MODEL_SCHEMA
        or not isinstance(features, dict)
        or features.get("full") != FULL_FEATURE_SHA256
        or any(not SHA256.fullmatch(str(features.get(key, ""))) for key in ("bootstrap", "rich", "full", "schema"))
        or not isinstance(identity, dict)
        or not GIT_COMMIT.fullmatch(str(identity.get("sourceCommit", "")))
        or identity.get("gpuUuid") != APPROVED_GPU_UUID
    ):
        raise ValueError("campaign schema, feature, or source identity mismatch")
    for key in ("sourceStatusSha256", "rulesFingerprint", "rosterFingerprint", "anchorFingerprint"):
        _require_sha(identity.get(key), f"campaign identity.{key}")
    if (
        campaign.get("teacherSchedule") != TEACHER_SCHEDULE
        or campaign.get("teacherScheduleSha256") != fingerprint(TEACHER_SCHEDULE)
    ):
        raise ValueError("campaign teacher schedule mismatch")
    _require_sha(campaign.get("runFingerprint"), "campaign runFingerprint")
    expected_run = os.environ.get("V09_RUN_FINGERPRINT")
    if expected_run is not None and campaign["runFingerprint"] != expected_run:
        raise ValueError("campaign runFingerprint does not match V09_RUN_FINGERPRINT")
    if Path(campaign.get("outputDirectory", "")).resolve() != path.parent:
        raise ValueError("campaign outputDirectory does not match the manifest location")

    ledger_path = path.parent / "seed-ledger.json"
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    if not isinstance(ledger, dict):
        raise ValueError("seed ledger must be an object")
    ledger_sha = _require_sha(ledger.get("ledgerSha256"), "seed ledgerSha256")
    if (
        ledger.get("schema") != SEED_LEDGER_SCHEMA
        or ledger.get("runFingerprint") != campaign["runFingerprint"]
        or campaign.get("seedLedgerSha256") != ledger_sha
        or fingerprint(_unsigned(ledger, "ledgerSha256")) != ledger_sha
    ):
        raise ValueError("campaign seed ledger identity mismatch")
    streams = ledger.get("streams")
    expected_purposes = (
        "wide_teacher_train",
        "wide_teacher_validation",
        "dagger_1_train",
        "dagger_1_validation",
        "dagger_2_train",
        "dagger_2_validation",
        "confirmation",
        "qualification",
    )
    if not isinstance(streams, list) or len(streams) != len(expected_purposes):
        raise ValueError("seed ledger must contain every purpose exactly once")
    seen: set[int] = set()
    total = 0
    for stream_index, stream in enumerate(streams):
        if not isinstance(stream, dict):
            raise ValueError("malformed seed stream")
        seeds = stream.get("seeds")
        expected_purpose = expected_purposes[stream_index]
        if (
            stream.get("purpose") != expected_purpose
            or stream.get("material") != f"hoc-v0.9|{campaign['runFingerprint']}|{expected_purpose}"
            or not isinstance(seeds, list)
            or not isinstance(stream.get("count"), int)
            or stream["count"] < 1
            or stream.get("count") != len(seeds)
            or stream.get("seedsSha256") != fingerprint(seeds)
        ):
            raise ValueError("malformed or tampered seed stream")
        for seed in seeds:
            if not isinstance(seed, int) or seed < 0 or seed > 0xFFFFFFFF or seed in seen:
                raise ValueError("seed ledger contains an invalid or duplicate uint32 seed")
            seen.add(seed)
        total += len(seeds)
    if total != ledger.get("totalAllocated"):
        raise ValueError("seed ledger total mismatch")
    return campaign, ledger


@dataclass(frozen=True)
class ShardDescriptor:
    path: str
    fileSha256: str
    purpose: str
    seedIndex: int
    phase: str
    split: str
    seed: int
    gameId: str
    studentBinding: str
    trajectoryPattern: str
    cohort: str
    map: str
    greenVersion: str
    redVersion: str
    decisions: int


def _row_chain_next(previous: str, raw_decision_line: str) -> str:
    # Hash the exact stripped line bytes. Never JSON round-trip floats across languages.
    return hashlib.sha256(f"{previous}\n{raw_decision_line.strip()}".encode("utf-8")).hexdigest()


def _validate_common(
    row: dict[str, Any],
    campaign: dict[str, Any],
    expected: dict[str, Any] | None,
    context: str,
) -> dict[str, Any]:
    identity = campaign["identity"]
    if (
        row.get("v") != IL_VERSION
        or row.get("schema") != IL_SCHEMA
        or row.get("runFingerprint") != campaign["runFingerprint"]
        or row.get("featureFingerprints") != campaign["featureFingerprints"]
        or row.get("sourceCommit") != identity["sourceCommit"]
        or row.get("rulesFingerprint") != identity["rulesFingerprint"]
        or row.get("anchorFingerprint") != identity["anchorFingerprint"]
    ):
        raise ValueError(f"{context}: row provenance does not match the campaign")
    if (
        row.get("phase") not in ("wide_teacher", "dagger_1", "dagger_2")
        or row.get("split") not in ("train", "validation")
        or row.get("map") not in ("normal", "water", "lava", "block")
        or not isinstance(row.get("seed"), int)
        or row["seed"] < 0
        or row["seed"] > 0xFFFFFFFF
        or not isinstance(row.get("gameId"), str)
        or not row["gameId"]
    ):
        raise ValueError(f"{context}: malformed game identity")
    common = {key: row.get(key) for key in COMMON_KEYS}
    if expected is not None and common != expected:
        raise ValueError(f"{context}: decision/footer game identity mismatch")
    return common


def validate_shard(
    path: Path,
    campaign: dict[str, Any],
    ledger: dict[str, Any],
) -> ShardDescriptor:
    path = path.resolve()
    try:
        path.relative_to(Path(campaign["outputDirectory"]).resolve())
    except ValueError as error:
        raise ValueError(f"{path}: shard is outside the immutable campaign output") from error
    source, file_sha256 = read_utf8_and_sha256(path)
    source_lines = [line.strip() for line in source.splitlines() if line.strip()]
    if not source_lines:
        raise ValueError(f"{path}: empty shard")
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(source_lines, start=1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{index}: invalid JSON") from error
        if not isinstance(row, dict):
            raise ValueError(f"{path}:{index}: row must be an object")
        rows.append(row)
    footers = [index for index, row in enumerate(rows) if row.get("t") == GAME_TYPE]
    if footers != [len(rows) - 1]:
        raise ValueError(f"{path}: shard needs exactly one final game footer and no rows after it")
    footer = rows[-1]
    if any(row.get("t") != DECISION_TYPE for row in rows[:-1]):
        raise ValueError(f"{path}: non-decision row appears before the footer")
    footer_common = _validate_common(footer, campaign, None, f"{path}:footer")
    chain = "0" * 64
    for decision_index, (row, raw) in enumerate(zip(rows[:-1], source_lines[:-1])):
        _validate_common(row, campaign, footer_common, f"{path}:decision {decision_index}")
        if row.get("decision") != decision_index:
            raise ValueError(f"{path}: decision indices are not contiguous")
        chain = _row_chain_next(chain, raw)
    if (
        footer.get("decisions") != len(rows) - 1
        or footer.get("rowChainSha256") != chain
        or footer.get("winner") not in ("green", "red", "draw")
        or footer.get("endReason") not in ("elimination", "turn_cap", "stuck")
    ):
        raise ValueError(f"{path}: footer count, outcome, or raw-line row chain mismatch")

    purpose = PURPOSES.get((footer["phase"], footer["split"]))
    if purpose is None:
        raise ValueError(f"{path}: phase/split does not map to a seed stream")
    parts = footer["gameId"].split(":")
    if len(parts) != 5 or parts[0] != purpose:
        raise ValueError(f"{path}: gameId does not bind the corpus purpose")
    try:
        seed_index = int(parts[1])
        game_seed = int(parts[2])
    except ValueError as error:
        raise ValueError(f"{path}: gameId seed lane is malformed") from error
    binding, pattern = parts[3], parts[4]
    stream = next((entry for entry in ledger["streams"] if entry["purpose"] == purpose), None)
    if (
        stream is None
        or seed_index < 0
        or seed_index >= len(stream["seeds"])
        or stream["seeds"][seed_index] != footer["seed"]
        or game_seed != footer["seed"]
    ):
        raise ValueError(f"{path}: seed is not in its preregistered purpose/index lane")
    if footer["phase"] == "wide_teacher":
        valid_versions = (
            binding == "v0.8-a13"
            and pattern == "anchor-mirror"
            and footer.get("greenVersion") == "v0.8+a13"
            and footer.get("redVersion") == "v0.8+a13"
        )
    else:
        student_version = f"v0.9-research:{binding}"
        dagger_patterns = campaign["teacherSchedule"]["daggerPatterns"]
        expected_pattern = dagger_patterns[seed_index % len(dagger_patterns)]
        patterns = {
            "student-green": (student_version, "v0.8+a13"),
            "student-red": ("v0.8+a13", student_version),
            "student-self-a": (student_version, student_version),
            "student-self-b": (student_version, student_version),
        }
        valid_versions = (
            SHA256.fullmatch(binding) is not None
            and pattern == expected_pattern
            and patterns.get(pattern)
            == (
                footer.get("greenVersion"),
                footer.get("redVersion"),
            )
        )
    if not valid_versions:
        raise ValueError(f"{path}: footer versions do not match the bound trajectory/student")
    teacher_cohorts = campaign["teacherSchedule"]["cohorts"]
    teacher_maps = campaign["teacherSchedule"]["maps"]
    expected_cohort = teacher_cohorts[seed_index % len(teacher_cohorts)]
    expected_map = teacher_maps[(seed_index // len(teacher_cohorts)) % len(teacher_maps)]
    expected_filename = f"{seed_index:06d}-{footer['seed']}.jsonl"
    if (
        footer.get("cohort") != expected_cohort
        or footer.get("map") != expected_map
        or path.parent.name != binding
        or path.name != expected_filename
    ):
        raise ValueError(f"{path}: shard path/cohort/map does not match its deterministic seed-index schedule")
    return ShardDescriptor(
        path=str(path),
        fileSha256=file_sha256,
        purpose=purpose,
        seedIndex=seed_index,
        phase=footer["phase"],
        split=footer["split"],
        seed=footer["seed"],
        gameId=footer["gameId"],
        studentBinding=binding,
        trajectoryPattern=pattern,
        cohort=footer["cohort"],
        map=footer["map"],
        greenVersion=footer["greenVersion"],
        redVersion=footer["redVersion"],
        decisions=footer["decisions"],
    )


def _initialize_validation_worker(campaign: dict[str, Any], ledger: dict[str, Any]) -> None:
    global _validation_worker_campaign, _validation_worker_ledger
    _validation_worker_campaign = campaign
    _validation_worker_ledger = ledger


def _validate_shard_worker(path: Path) -> ShardDescriptor:
    if _validation_worker_campaign is None or _validation_worker_ledger is None:
        raise RuntimeError("corpus validation worker was not initialized")
    return validate_shard(path, _validation_worker_campaign, _validation_worker_ledger)


def _available_cpu_count() -> int:
    if hasattr(os, "sched_getaffinity"):
        return max(1, len(os.sched_getaffinity(0)))
    return max(1, os.cpu_count() or 1)


def corpus_validation_workers(shards: int, requested: int | None = None) -> int:
    if type(shards) is not int or shards < 1:
        raise ValueError("corpus validation requires a positive shard count")
    if requested is None:
        configured = os.environ.get("V09_CORPUS_VALIDATION_WORKERS")
        if configured is not None:
            try:
                requested = int(configured)
            except ValueError as error:
                raise ValueError("V09_CORPUS_VALIDATION_WORKERS must be a positive integer") from error
        else:
            # Reserve roughly one logical quarter for the supervisor, OS, and page-cache work. This maps the
            # 48-thread Puffalo Xeon to its 24 physical cores and the 16-thread M4 Max to its 12 performance
            # cores, while the cap prevents thousands of tiny shards from spawning an excessive process pool.
            available = _available_cpu_count()
            requested = min(MAX_AUTOMATIC_VALIDATION_WORKERS, max(1, (available * 3) // 4))
    if type(requested) is not int or requested < 1:
        raise ValueError("corpus validation workers must be a positive integer")
    return min(shards, requested)


def validate_shards(
    paths: Sequence[Path],
    campaign: dict[str, Any],
    ledger: dict[str, Any],
    workers: int | None = None,
) -> list[ShardDescriptor]:
    worker_count = corpus_validation_workers(len(paths), workers)
    if worker_count == 1 or (workers is None and len(paths) < PARALLEL_VALIDATION_MIN_SHARDS):
        return [validate_shard(path, campaign, ledger) for path in paths]

    # `executor.map` returns results (and surfaces failures) in the immutable path order even though shard
    # parsing happens concurrently. Each worker receives the large campaign/ledger once via the initializer;
    # only compact Path tasks cross the queue afterward. The learner calls this before CUDA initialization, so
    # Linux can safely use its lightweight default process start method; macOS uses spawn automatically.
    chunksize = max(1, len(paths) // (worker_count * 16))
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=worker_count,
        initializer=_initialize_validation_worker,
        initargs=(campaign, ledger),
    ) as executor:
        return list(executor.map(_validate_shard_worker, paths, chunksize=chunksize))


def validate_corpus(
    patterns: Sequence[str],
    campaign_manifest: Path,
    allow_partial: bool = False,
    workers: int | None = None,
) -> tuple[dict[str, Any], list[Path], list[ShardDescriptor]]:
    campaign, ledger = validate_campaign_manifest(campaign_manifest)
    paths = expand_paths(patterns)
    descriptors = validate_shards(paths, campaign, ledger, workers)
    game_ids: set[str] = set()
    lanes: set[tuple[str, int]] = set()
    binding_by_purpose: dict[str, str] = {}
    indices_by_purpose: dict[str, set[int]] = {}
    for descriptor in descriptors:
        if descriptor.gameId in game_ids:
            raise ValueError(f"duplicate gameId in corpus: {descriptor.gameId}")
        game_ids.add(descriptor.gameId)
        lane = (descriptor.purpose, descriptor.seedIndex)
        if lane in lanes:
            raise ValueError(f"duplicate purpose/seed-index lane in corpus: {descriptor.purpose}:{descriptor.seedIndex}")
        lanes.add(lane)
        indices_by_purpose.setdefault(descriptor.purpose, set()).add(descriptor.seedIndex)
        prior = binding_by_purpose.setdefault(descriptor.purpose, descriptor.studentBinding)
        if prior != descriptor.studentBinding:
            raise ValueError(
                f"corpus mixes stale student bindings for {descriptor.purpose}: {prior} and "
                f"{descriptor.studentBinding}"
            )
    phase_order = ("wide_teacher", "dagger_1", "dagger_2")
    highest_phase = max(phase_order.index(descriptor.phase) for descriptor in descriptors)
    required_purposes = {
        PURPOSES[(phase, split)]
        for phase in phase_order[: highest_phase + 1]
        for split in ("train", "validation")
    }
    if set(indices_by_purpose) != required_purposes:
        raise ValueError(
            "corpus phases must form an exact wide_teacher -> dagger_1 -> dagger_2 prefix: "
            f"expected={sorted(required_purposes)} actual={sorted(indices_by_purpose)}"
        )
    streams = {stream["purpose"]: stream for stream in ledger["streams"]}
    for purpose in required_purposes:
        indices = indices_by_purpose[purpose]
        if allow_partial:
            expected_prefix = set(range(len(indices)))
            if indices != expected_prefix:
                raise ValueError(f"partial smoke corpus for {purpose} must be an exact seed-index prefix")
        else:
            stream = streams[purpose]
            expected = set(range(stream["count"]))
            if indices != expected:
                missing = sorted(expected - indices)
                extra = sorted(indices - expected)
                raise ValueError(
                    f"corpus does not exactly cover {purpose}: "
                    f"missing={missing[:8]} extra={extra[:8]}"
                )
    phases = {(descriptor.phase, descriptor.split) for descriptor in descriptors}
    for phase in {descriptor.phase for descriptor in descriptors}:
        if (phase, "train") not in phases or (phase, "validation") not in phases:
            raise ValueError(f"corpus phase {phase} must include both train and validation streams")
        if allow_partial:
            train_purpose = PURPOSES[(phase, "train")]
            validation_purpose = PURPOSES[(phase, "validation")]
            if len(indices_by_purpose[train_purpose]) != len(indices_by_purpose[validation_purpose]):
                raise ValueError(f"partial smoke corpus phase {phase} must balance train and validation prefixes")
    if not any(descriptor.split == "train" and descriptor.decisions > 0 for descriptor in descriptors):
        raise ValueError("corpus contains no non-empty training shard")
    if not any(descriptor.split == "validation" and descriptor.decisions > 0 for descriptor in descriptors):
        raise ValueError("corpus contains no non-empty validation shard")
    return campaign, paths, descriptors


def descriptor_fingerprint(descriptors: Iterable[ShardDescriptor]) -> str:
    return fingerprint([asdict(descriptor) for descriptor in descriptors])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign-manifest", type=Path, required=True)
    parser.add_argument("--data", action="append", required=True)
    parser.add_argument("--allow-partial", action="store_true")
    parser.add_argument("--summary-only", action="store_true")
    parser.add_argument(
        "--workers",
        type=int,
        help="parallel shard validators (default: V09_CORPUS_VALIDATION_WORKERS or topology-derived)",
    )
    args = parser.parse_args()
    campaign, paths, descriptors = validate_corpus(
        args.data,
        args.campaign_manifest,
        args.allow_partial,
        args.workers,
    )
    report = {
        "schema": "hoc.ai.v0_9_corpus_validation.v1",
        "runFingerprint": campaign["runFingerprint"],
        "shards": len(paths),
        "decisions": sum(descriptor.decisions for descriptor in descriptors),
        "corpusSha256": descriptor_fingerprint(descriptors),
    }
    if not args.summary_only:
        report["descriptors"] = [asdict(descriptor) for descriptor in descriptors]
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
