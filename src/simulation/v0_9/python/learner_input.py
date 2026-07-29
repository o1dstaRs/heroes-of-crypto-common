#!/usr/bin/env python3
"""Torch-free input planning and sealed preprocessing caches for the v0.9 learner."""

from __future__ import annotations

import hashlib
import json
import math
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

NORMALIZATION_CACHE_SCHEMA = "hoc.ai.v0_9_normalization_cache.welford_f64_to_f32_v1"
CACHE_DIRECTORY_NAME = "learner-cache"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _absolute_without_symlink_resolution(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def validate_cache_parent(parent: Path, *, create: bool) -> Path:
    """Return a lexical absolute cache parent while refusing links and non-directories."""

    parent = _absolute_without_symlink_resolution(parent)
    if parent.name != CACHE_DIRECTORY_NAME:
        raise ValueError(f"learner cache parent must be named {CACHE_DIRECTORY_NAME}")
    if parent.is_symlink():
        raise ValueError("learner cache parent must not be a symlink")
    if not parent.exists():
        if not create:
            return parent
        parent.mkdir(mode=0o700)
    if parent.is_symlink() or not parent.is_dir():
        raise ValueError("learner cache parent must be a real directory")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        file_descriptor = os.open(parent, flags)
    except OSError as error:
        raise ValueError("learner cache parent could not be opened without following links") from error
    try:
        if not stat.S_ISDIR(os.fstat(file_descriptor).st_mode):
            raise ValueError("learner cache parent must be a real directory")
    finally:
        os.close(file_descriptor)
    return parent


def cache_parent_path(campaign_directory: Path, *, create: bool = False) -> Path:
    campaign = campaign_directory.resolve()
    if not campaign.is_dir():
        raise ValueError("campaign cache root must be a directory")
    return validate_cache_parent(campaign / CACHE_DIRECTORY_NAME, create=create)


def validate_cache_file_path(path: Path, *, create_parent: bool, allow_missing: bool) -> Path:
    path = _absolute_without_symlink_resolution(path)
    validate_cache_parent(path.parent, create=create_parent)
    if path.is_symlink():
        raise ValueError("learner cache file must not be a symlink")
    if path.exists() and not path.is_file():
        raise ValueError("learner cache file must be a regular file")
    if not allow_missing and not path.is_file():
        raise ValueError("learner cache file is missing")
    return path


def split_eligible_paths(
    paths: Sequence[Path],
    descriptors: Sequence[Any],
) -> dict[str, frozenset[Path]]:
    """Bind validated descriptors to paths without changing the corpus's canonical order."""

    if len(paths) != len(descriptors):
        raise ValueError("validated shard paths and descriptors have different lengths")
    eligible: dict[str, set[Path]] = {"train": set(), "validation": set()}
    seen: set[Path] = set()
    for path, descriptor in zip(paths, descriptors):
        resolved = path.resolve()
        if resolved in seen:
            raise ValueError(f"validated corpus repeats a shard path: {resolved}")
        seen.add(resolved)
        if Path(descriptor.path).resolve() != resolved:
            raise ValueError("validated shard descriptor order does not match the expanded paths")
        split = descriptor.split
        if split not in eligible:
            raise ValueError(f"validated shard has an unsupported split: {split}")
        eligible[split].add(resolved)
    return {split: frozenset(selected) for split, selected in eligible.items()}


def eligible_in_order(paths: Iterable[Path], eligible: frozenset[Path]) -> list[Path]:
    """Filter an existing order; never reshuffle or repartition the selected paths."""

    return [path for path in paths if path in eligible]


@dataclass(frozen=True)
class NormalizationCache:
    offsets: tuple[float, ...]
    scales: tuple[float, ...]
    observations: int
    cache_sha256: str


def normalization_cache_path(
    campaign_directory: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
) -> Path:
    if len(corpus_sha256) != 64 or any(character not in "0123456789abcdef" for character in corpus_sha256):
        raise ValueError("normalization cache corpus identity must be a lowercase SHA-256")
    identity = {
        "schema": NORMALIZATION_CACHE_SCHEMA,
        "runFingerprint": run_fingerprint,
        "sourceCommit": source_commit,
        "corpusSha256": corpus_sha256,
        "featureSchemaSha256": feature_schema_sha256,
    }
    return cache_parent_path(campaign_directory) / f"normalization-{fingerprint(identity)}.json"


def _normalization_payload(
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
    offsets: Sequence[float],
    scales: Sequence[float],
    observations: int,
) -> dict[str, Any]:
    return {
        "schema": NORMALIZATION_CACHE_SCHEMA,
        "runFingerprint": run_fingerprint,
        "sourceCommit": source_commit,
        "corpusSha256": corpus_sha256,
        "featureSchemaSha256": feature_schema_sha256,
        "observations": observations,
        "offsets": list(offsets),
        "scales": list(scales),
    }


def write_normalization_cache(
    path: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
    offsets: Sequence[float],
    scales: Sequence[float],
    observations: int,
) -> NormalizationCache:
    payload = _normalization_payload(
        run_fingerprint=run_fingerprint,
        source_commit=source_commit,
        corpus_sha256=corpus_sha256,
        feature_schema_sha256=feature_schema_sha256,
        offsets=offsets,
        scales=scales,
        observations=observations,
    )
    payload["cacheSha256"] = fingerprint(payload)
    # Validate before publishing so malformed values can never become a reusable cache.
    cache = validate_normalization_cache(
        payload,
        run_fingerprint=run_fingerprint,
        source_commit=source_commit,
        corpus_sha256=corpus_sha256,
        feature_schema_sha256=feature_schema_sha256,
        feature_width=len(offsets),
    )
    path = validate_cache_file_path(path, create_parent=True, allow_missing=True)
    file_descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        validate_cache_file_path(path, create_parent=False, allow_missing=True)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    return cache


def validate_normalization_cache(
    value: Mapping[str, Any],
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
    feature_width: int,
) -> NormalizationCache:
    cache_sha256 = value.get("cacheSha256")
    unsigned = {key: entry for key, entry in value.items() if key != "cacheSha256"}
    if (
        value.get("schema") != NORMALIZATION_CACHE_SCHEMA
        or value.get("runFingerprint") != run_fingerprint
        or value.get("sourceCommit") != source_commit
        or value.get("corpusSha256") != corpus_sha256
        or value.get("featureSchemaSha256") != feature_schema_sha256
        or not isinstance(cache_sha256, str)
        or fingerprint(unsigned) != cache_sha256
    ):
        raise ValueError("normalization cache identity or seal mismatch")
    offsets = value.get("offsets")
    scales = value.get("scales")
    observations = value.get("observations")
    if (
        not isinstance(offsets, list)
        or not isinstance(scales, list)
        or len(offsets) != feature_width
        or len(scales) != feature_width
        or type(observations) is not int
        or observations < 2
        or any(
            isinstance(entry, bool) or not isinstance(entry, (int, float)) or not math.isfinite(entry)
            for entry in offsets
        )
        or any(
            isinstance(entry, bool)
            or not isinstance(entry, (int, float))
            or not math.isfinite(entry)
            or entry <= 0
            for entry in scales
        )
    ):
        raise ValueError("normalization cache values are malformed")
    return NormalizationCache(
        offsets=tuple(float(entry) for entry in offsets),
        scales=tuple(float(entry) for entry in scales),
        observations=observations,
        cache_sha256=cache_sha256,
    )


def read_normalization_cache(
    path: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
    feature_width: int,
) -> NormalizationCache:
    try:
        path = validate_cache_file_path(path, create_parent=False, allow_missing=False)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        file_descriptor = os.open(path, flags)
        with os.fdopen(file_descriptor, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read sealed normalization cache {path}") from error
    if not isinstance(value, dict):
        raise ValueError("normalization cache must be an object")
    return validate_normalization_cache(
        value,
        run_fingerprint=run_fingerprint,
        source_commit=source_commit,
        corpus_sha256=corpus_sha256,
        feature_schema_sha256=feature_schema_sha256,
        feature_width=feature_width,
    )
