#!/usr/bin/env python3
"""Sealed memory-mapped IL-v4 decision cache for the v0.9 learner."""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence

import numpy as np

from learner_input import cache_parent_path, validate_cache_parent

IL_SCHEMA = "hoc.ai.v0_9_il.v4"
IL_TYPE = "v09_il_decision"
IL_VERSION = 4
FEATURE_WIDTH = 166
FULL_FEATURE_SHA256 = "01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e"
PACKED_CACHE_SCHEMA = "hoc.ai.v0_9_packed_decisions.flat_f32_mmap_v1"
PACKED_CACHE_FREE_RESERVE_BYTES = 16 * 1024**3
PACKED_CACHE_BUILD_HEADROOM_BYTES = 1024**3
PACKED_CACHE_DISK_CHECK_INTERVAL_BYTES = 256 * 1024**2
PACKED_CACHE_VALIDATION_CHUNK = 65_536

_FILE_LAYOUT = {
    "features": ("features.f32", "<f4"),
    "means": ("means.f32", "<f4"),
    "meanValid": ("mean-valid.bool", "|b1"),
    "confidence": ("confidence.f32", "<f4"),
    "teacher": ("teacher.i64", "<i8"),
    "candidateOffsets": ("candidate-offsets.i64", "<i8"),
    "shardDecisionOffsets": ("shard-decision-offsets.i64", "<i8"),
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    file_descriptor = os.open(path, flags)
    with os.fdopen(file_descriptor, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class Decision:
    features: Sequence[Sequence[float]]
    means: Sequence[float]
    mean_valid: Sequence[bool]
    teacher_index: int
    incumbent_index: int
    weights: Sequence[float]


def decision_from_row(row: dict[str, Any], expected_split: str | None) -> Decision | None:
    if row.get("t") != IL_TYPE:
        return None
    if row.get("v") != IL_VERSION or row.get("schema") != IL_SCHEMA:
        raise ValueError("mixed or unsupported IL schema")
    fingerprints = row.get("featureFingerprints", {})
    if fingerprints.get("full") != FULL_FEATURE_SHA256:
        raise ValueError("IL row has a different full feature fingerprint")
    if expected_split is not None and row.get("split") != expected_split:
        return None
    value_features = row.get("valueFeatures")
    candidates = row.get("candidates")
    teacher_index = row.get("teacherIndex")
    if (
        not isinstance(value_features, list)
        or len(value_features) != 60
        or not isinstance(candidates, list)
        or not candidates
        or len(candidates) > 96
        or not isinstance(teacher_index, int)
        or teacher_index < 0
        or teacher_index >= len(candidates)
        or row.get("incumbentIndex") != 0
    ):
        raise ValueError("malformed IL-v4 decision")
    features: list[list[float]] = []
    means: list[float] = []
    mean_valid: list[bool] = []
    weights: list[float] = []
    for candidate in candidates:
        cf = candidate.get("candidateFeatures")
        af = candidate.get("actionFeatures")
        rich = candidate.get("richFeatures")
        vector = [*value_features, *(cf or []), *(af or []), *(rich or [])]
        if (
            len(vector) != FEATURE_WIDTH
            or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector)
        ):
            raise ValueError("invalid IL-v4 candidate feature vector")
        mean = candidate.get("teacherMean")
        visits = candidate.get("teacherVisits")
        stderr = candidate.get("teacherStdErr")
        if (
            (
                mean is not None
                and (not isinstance(mean, (int, float)) or not math.isfinite(mean))
            )
            or not isinstance(visits, int)
            or visits < 1
            or (
                stderr is not None
                and (
                    not isinstance(stderr, (int, float))
                    or not math.isfinite(stderr)
                    or stderr < 0
                )
            )
        ):
            raise ValueError("invalid IL-v4 teacher observation")
        features.append([float(value) for value in vector])
        means.append(float(mean) if mean is not None else 0.0)
        mean_valid.append(mean is not None)
        confidence = math.sqrt(float(visits))
        if stderr is not None:
            confidence /= max(0.02, 1.0 + float(stderr))
        weights.append(confidence)
    if not mean_valid[teacher_index]:
        raise ValueError("teacherIndex points at an engine-rejected candidate")
    return Decision(features, means, mean_valid, teacher_index, 0, weights)


def iter_json_decisions(
    paths: Sequence[Path],
    split: str | None,
    expected_file_sha256: Mapping[Path, str] | None = None,
) -> Iterator[Decision]:
    for path in paths:
        source = path.read_bytes()
        try:
            lines = source.decode("utf-8").splitlines()
        except UnicodeDecodeError as error:
            raise ValueError(f"{path}: invalid UTF-8") from error
        if expected_file_sha256 is not None:
            expected = expected_file_sha256.get(path.resolve())
            if expected is None or hashlib.sha256(source).hexdigest() != expected:
                raise ValueError(f"{path}: bytes changed after corpus validation")
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
                decision = decision_from_row(value, split)
            except Exception as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error
            if decision is not None:
                yield decision


@dataclass(frozen=True)
class NumpyBatch:
    features: np.ndarray
    means: np.ndarray
    mean_valid: np.ndarray
    mask: np.ndarray
    teacher: np.ndarray
    confidence: np.ndarray


def collate_numpy(decisions: Sequence[Decision]) -> NumpyBatch:
    maximum = max(len(decision.features) for decision in decisions)
    batch = len(decisions)
    features = np.zeros((batch, maximum, FEATURE_WIDTH), dtype=np.float32)
    means = np.zeros((batch, maximum), dtype=np.float32)
    mean_valid = np.zeros((batch, maximum), dtype=np.bool_)
    mask = np.zeros((batch, maximum), dtype=np.bool_)
    teacher = np.zeros((batch,), dtype=np.int64)
    confidence = np.ones((batch, maximum), dtype=np.float32)
    for index, decision in enumerate(decisions):
        count = len(decision.features)
        features[index, :count] = decision.features
        means[index, :count] = decision.means
        mean_valid[index, :count] = decision.mean_valid
        mask[index, :count] = True
        teacher[index] = decision.teacher_index
        confidence[index, :count] = decision.weights
    return NumpyBatch(features, means, mean_valid, mask, teacher, confidence)


def _cache_identity(
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
) -> dict[str, Any]:
    return {
        "schema": PACKED_CACHE_SCHEMA,
        "runFingerprint": run_fingerprint,
        "sourceCommit": source_commit,
        "corpusSha256": corpus_sha256,
        "featureSchemaSha256": feature_schema_sha256,
        "featureWidth": FEATURE_WIDTH,
        "layout": {key: list(value) for key, value in _FILE_LAYOUT.items()},
    }


def packed_cache_path(
    campaign_directory: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
) -> Path:
    identity = _cache_identity(
        run_fingerprint=run_fingerprint,
        source_commit=source_commit,
        corpus_sha256=corpus_sha256,
        feature_schema_sha256=feature_schema_sha256,
    )
    return cache_parent_path(campaign_directory) / f"packed-{fingerprint(identity)}"


@dataclass(frozen=True)
class PackedCache:
    directory: Path
    cache_sha256: str
    path_order_sha256: str
    shards: int
    decisions: int
    candidates: int
    data_bytes: int
    files: Mapping[str, Mapping[str, Any]]


class _HashedWriter:
    def __init__(self, path: Path):
        self.path = path
        self.stream = path.open("wb")
        self.digest = hashlib.sha256()
        self.bytes_written = 0

    def write(self, value: bytes) -> None:
        self.stream.write(value)
        self.digest.update(value)
        self.bytes_written += len(value)

    def close(self) -> tuple[str, int]:
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        return self.digest.hexdigest(), self.bytes_written


def _write_array(writer: _HashedWriter, value: np.ndarray, dtype: str) -> None:
    contiguous = np.ascontiguousarray(value, dtype=np.dtype(dtype))
    writer.write(contiguous.tobytes(order="C"))


def _path_order_sha256(paths: Sequence[Path]) -> str:
    return fingerprint([str(path.resolve()) for path in paths])


def expected_packed_data_bytes(candidates: int, decisions: int, shards: int) -> int:
    candidate_bytes = candidates * (FEATURE_WIDTH * 4 + 4 + 1 + 4)
    return candidate_bytes + decisions * 8 + (decisions + 1) * 8 + (shards + 1) * 8


def _atomic_manifest(path: Path, value: Mapping[str, Any]) -> None:
    file_descriptor, temporary = tempfile.mkstemp(prefix=".manifest.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def build_packed_cache(
    paths: Sequence[Path],
    descriptors: Sequence[Any],
    directory: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
    observer: Callable[[Decision, str], None] | None = None,
) -> PackedCache:
    if len(paths) != len(descriptors):
        raise ValueError("packed cache needs one validated descriptor per shard path")
    directory = Path(os.path.abspath(os.fspath(directory)))
    parent = validate_cache_parent(directory.parent, create=True)
    if directory.parent != parent:
        raise ValueError("packed cache directory must be directly inside learner-cache")
    if directory.is_symlink():
        raise ValueError("packed cache directory must not be a symlink")
    if directory.exists() and not directory.is_dir():
        raise ValueError("packed cache directory must be a real directory")
    expected_decisions = sum(descriptor.decisions for descriptor in descriptors)
    maximum_data_bytes = expected_packed_data_bytes(expected_decisions * 96, expected_decisions, len(paths))
    free_bytes = shutil.disk_usage(parent).free
    if free_bytes < PACKED_CACHE_FREE_RESERVE_BYTES + PACKED_CACHE_BUILD_HEADROOM_BYTES:
        raise ValueError(
            "packed cache has insufficient free disk for an atomic build with its safety reserve: "
            f"free={free_bytes} "
            f"required={PACKED_CACHE_FREE_RESERVE_BYTES + PACKED_CACHE_BUILD_HEADROOM_BYTES}"
        )
    temporary = Path(tempfile.mkdtemp(prefix=f".{directory.name}.", dir=parent))
    writers: dict[str, _HashedWriter] = {}
    candidate_offsets = [0]
    shard_decision_offsets = [0]
    candidates = 0
    decisions = 0
    next_disk_check = PACKED_CACHE_DISK_CHECK_INTERVAL_BYTES
    try:
        for key, (filename, _dtype) in _FILE_LAYOUT.items():
            if key not in ("candidateOffsets", "shardDecisionOffsets"):
                writers[key] = _HashedWriter(temporary / filename)
        for path, descriptor in zip(paths, descriptors):
            resolved = path.resolve()
            if Path(descriptor.path).resolve() != resolved or descriptor.split not in ("train", "validation"):
                raise ValueError("packed cache descriptor/path order or split mismatch")
            shard_decisions = 0
            for decision in iter_json_decisions(
                (resolved,),
                descriptor.split,
                {resolved: descriptor.fileSha256},
            ):
                if observer is not None:
                    observer(decision, descriptor.split)
                candidate_count = len(decision.features)
                _write_array(writers["features"], np.asarray(decision.features), "<f4")
                _write_array(writers["means"], np.asarray(decision.means), "<f4")
                _write_array(writers["meanValid"], np.asarray(decision.mean_valid), "|b1")
                _write_array(writers["confidence"], np.asarray(decision.weights), "<f4")
                writers["teacher"].write(struct.pack("<q", decision.teacher_index))
                candidates += candidate_count
                decisions += 1
                shard_decisions += 1
                candidate_offsets.append(candidates)
            bytes_written = sum(writer.bytes_written for writer in writers.values())
            if bytes_written >= next_disk_check:
                free_bytes = shutil.disk_usage(parent).free
                if free_bytes < PACKED_CACHE_FREE_RESERVE_BYTES:
                    raise OSError(
                        28,
                        "packed cache build reached its 16-GiB free-disk safety reserve",
                        str(temporary),
                    )
                next_disk_check = bytes_written + PACKED_CACHE_DISK_CHECK_INTERVAL_BYTES
            if shard_decisions != descriptor.decisions:
                raise ValueError(
                    f"packed cache decision count mismatch for {resolved}: "
                    f"{shard_decisions} != {descriptor.decisions}"
                )
            shard_decision_offsets.append(decisions)

        files: dict[str, dict[str, Any]] = {}
        for key, writer in writers.items():
            digest, byte_count = writer.close()
            filename, dtype = _FILE_LAYOUT[key]
            files[key] = {
                "name": filename,
                "dtype": dtype,
                "bytes": byte_count,
                "sha256": digest,
            }
        for key, values in (
            ("candidateOffsets", np.asarray(candidate_offsets, dtype="<i8")),
            ("shardDecisionOffsets", np.asarray(shard_decision_offsets, dtype="<i8")),
        ):
            filename, dtype = _FILE_LAYOUT[key]
            writer = _HashedWriter(temporary / filename)
            writers[key] = writer
            _write_array(writer, values, dtype)
            digest, byte_count = writer.close()
            files[key] = {
                "name": filename,
                "dtype": dtype,
                "bytes": byte_count,
                "sha256": digest,
            }

        shapes = {
            "features": [candidates, FEATURE_WIDTH],
            "means": [candidates],
            "meanValid": [candidates],
            "confidence": [candidates],
            "teacher": [decisions],
            "candidateOffsets": [decisions + 1],
            "shardDecisionOffsets": [len(paths) + 1],
        }
        for key, shape in shapes.items():
            files[key]["shape"] = shape
        data_bytes = expected_packed_data_bytes(candidates, decisions, len(paths))
        if data_bytes != sum(entry["bytes"] for entry in files.values()):
            raise ValueError("packed cache data byte accounting mismatch")
        identity = _cache_identity(
            run_fingerprint=run_fingerprint,
            source_commit=source_commit,
            corpus_sha256=corpus_sha256,
            feature_schema_sha256=feature_schema_sha256,
        )
        manifest: dict[str, Any] = {
            **identity,
            "pathOrderSha256": _path_order_sha256(paths),
            "shards": len(paths),
            "decisions": decisions,
            "candidates": candidates,
            "dataBytes": data_bytes,
            "maximumDataBytes": maximum_data_bytes,
            "files": files,
        }
        manifest["cacheSha256"] = fingerprint(manifest)
        _atomic_manifest(temporary / "manifest.json", manifest)
        validate_packed_cache(
            paths,
            descriptors,
            temporary,
            run_fingerprint=run_fingerprint,
            source_commit=source_commit,
            corpus_sha256=corpus_sha256,
            feature_schema_sha256=feature_schema_sha256,
        )
        validate_cache_parent(parent, create=False)
        if directory.is_symlink():
            raise ValueError("packed cache directory must not be a symlink")
        try:
            os.replace(temporary, directory)
        except OSError:
            if directory.is_symlink() or not directory.is_dir():
                raise
            shutil.rmtree(temporary)
            return validate_packed_cache(
                paths,
                descriptors,
                directory,
                run_fingerprint=run_fingerprint,
                source_commit=source_commit,
                corpus_sha256=corpus_sha256,
                feature_schema_sha256=feature_schema_sha256,
            )
        return PackedCache(
            directory=directory,
            cache_sha256=manifest["cacheSha256"],
            path_order_sha256=manifest["pathOrderSha256"],
            shards=len(paths),
            decisions=decisions,
            candidates=candidates,
            data_bytes=data_bytes,
            files=files,
        )
    except BaseException:
        for writer in writers.values():
            if not writer.stream.closed:
                writer.stream.close()
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def _validated_manifest(
    directory: Path,
    expected_identity: Mapping[str, Any],
    path_order_sha256: str,
    shards: int,
) -> dict[str, Any]:
    path = directory / "manifest.json"
    if path.is_symlink():
        raise ValueError("packed cache manifest must not be a symlink")
    if not path.is_file():
        raise ValueError("packed cache manifest must be a regular file")
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        file_descriptor = os.open(path, flags)
        with os.fdopen(file_descriptor, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read sealed packed cache {directory}") from error
    if not isinstance(value, dict):
        raise ValueError("packed cache manifest must be an object")
    cache_sha256 = value.get("cacheSha256")
    unsigned = {key: entry for key, entry in value.items() if key != "cacheSha256"}
    if (
        any(value.get(key) != entry for key, entry in expected_identity.items())
        or value.get("pathOrderSha256") != path_order_sha256
        or value.get("shards") != shards
        or not isinstance(cache_sha256, str)
        or fingerprint(unsigned) != cache_sha256
    ):
        raise ValueError("packed cache identity or seal mismatch")
    return value


def validate_packed_cache(
    paths: Sequence[Path],
    descriptors: Sequence[Any],
    directory: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
) -> PackedCache:
    if len(paths) != len(descriptors):
        raise ValueError("packed cache needs one validated descriptor per shard path")
    directory = Path(os.path.abspath(os.fspath(directory)))
    parent = validate_cache_parent(directory.parent, create=False)
    if directory.parent != parent:
        raise ValueError("packed cache directory must be directly inside learner-cache")
    if directory.is_symlink():
        raise ValueError("packed cache directory must not be a symlink")
    if not directory.is_dir():
        raise ValueError("packed cache directory must be a real directory")
    identity = _cache_identity(
        run_fingerprint=run_fingerprint,
        source_commit=source_commit,
        corpus_sha256=corpus_sha256,
        feature_schema_sha256=feature_schema_sha256,
    )
    manifest = _validated_manifest(directory, identity, _path_order_sha256(paths), len(paths))
    decisions = manifest.get("decisions")
    candidates = manifest.get("candidates")
    data_bytes = manifest.get("dataBytes")
    maximum_data_bytes = manifest.get("maximumDataBytes")
    files = manifest.get("files")
    if (
        type(decisions) is not int
        or decisions != sum(descriptor.decisions for descriptor in descriptors)
        or type(candidates) is not int
        or candidates < decisions
        or type(data_bytes) is not int
        or data_bytes != expected_packed_data_bytes(candidates, decisions, len(paths))
        or type(maximum_data_bytes) is not int
        or maximum_data_bytes != expected_packed_data_bytes(decisions * 96, decisions, len(paths))
        or not isinstance(files, dict)
        or set(files) != set(_FILE_LAYOUT)
    ):
        raise ValueError("packed cache counts or file catalog are malformed")
    expected_shapes = {
        "features": [candidates, FEATURE_WIDTH],
        "means": [candidates],
        "meanValid": [candidates],
        "confidence": [candidates],
        "teacher": [decisions],
        "candidateOffsets": [decisions + 1],
        "shardDecisionOffsets": [len(paths) + 1],
    }
    for key, (filename, dtype) in _FILE_LAYOUT.items():
        entry = files.get(key)
        if (
            not isinstance(entry, dict)
            or entry.get("name") != filename
            or entry.get("dtype") != dtype
            or entry.get("shape") != expected_shapes[key]
            or type(entry.get("bytes")) is not int
            or entry["bytes"] != int(np.prod(expected_shapes[key], dtype=np.int64)) * np.dtype(dtype).itemsize
            or not isinstance(entry.get("sha256"), str)
        ):
            raise ValueError(f"packed cache {key} metadata is malformed")
        path = directory / filename
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size != entry["bytes"]
            or file_sha256(path) != entry["sha256"]
        ):
            raise ValueError(f"packed cache {key} data seal mismatch")
    if sum(entry["bytes"] for entry in files.values()) != data_bytes:
        raise ValueError("packed cache data byte accounting mismatch")

    cache = PackedCache(
        directory=directory,
        cache_sha256=manifest["cacheSha256"],
        path_order_sha256=manifest["pathOrderSha256"],
        shards=len(paths),
        decisions=decisions,
        candidates=candidates,
        data_bytes=data_bytes,
        files=files,
    )
    store = PackedDecisionStore(cache)
    try:
        candidate_offsets = store.candidate_offsets
        shard_offsets = store.shard_decision_offsets
        if (
            int(candidate_offsets[0]) != 0
            or int(candidate_offsets[-1]) != candidates
            or int(shard_offsets[0]) != 0
            or int(shard_offsets[-1]) != decisions
        ):
            raise ValueError("packed cache decision/shard offsets are malformed")
        for start in range(0, decisions, PACKED_CACHE_VALIDATION_CHUNK):
            end = min(start + PACKED_CACHE_VALIDATION_CHUNK, decisions)
            offsets = np.asarray(candidate_offsets[start : end + 1])
            candidate_counts = np.diff(offsets)
            teachers = np.asarray(store.teacher[start:end])
            if (
                np.any(candidate_counts < 1)
                or np.any(candidate_counts > 96)
                or np.any(teachers < 0)
                or np.any(teachers >= candidate_counts)
            ):
                raise ValueError("packed cache decision offsets or teacher indices are malformed")
            selected = offsets[:-1] + teachers
            if not np.all(store.mean_valid[selected]):
                raise ValueError("packed cache teacher index points at an invalid mean")
        for start in range(0, len(paths), PACKED_CACHE_VALIDATION_CHUNK):
            end = min(start + PACKED_CACHE_VALIDATION_CHUNK, len(paths))
            offsets = np.asarray(shard_offsets[start : end + 1])
            expected = np.fromiter(
                (descriptors[index].decisions for index in range(start, end)),
                dtype="<i8",
                count=end - start,
            )
            if not np.array_equal(np.diff(offsets), expected):
                raise ValueError("packed cache decision/shard offsets are malformed")
        for start in range(0, candidates, PACKED_CACHE_VALIDATION_CHUNK):
            end = min(start + PACKED_CACHE_VALIDATION_CHUNK, candidates)
            confidence = np.asarray(store.confidence[start:end])
            encoded_mean_valid = np.asarray(store.mean_valid[start:end]).view(np.uint8)
            if (
                not np.all(np.isfinite(store.features[start:end]))
                or not np.all(np.isfinite(store.means[start:end]))
                or not np.all(np.isfinite(confidence))
                or np.any(confidence <= 0)
                or np.any((encoded_mean_valid != 0) & (encoded_mean_valid != 1))
            ):
                raise ValueError("packed cache candidate numeric values are malformed")
    finally:
        store.close()
    return cache


def load_or_build_packed_cache(
    paths: Sequence[Path],
    descriptors: Sequence[Any],
    campaign_directory: Path,
    *,
    run_fingerprint: str,
    source_commit: str,
    corpus_sha256: str,
    feature_schema_sha256: str,
    observer: Callable[[Decision, str], None] | None = None,
) -> tuple[PackedCache, bool]:
    directory = packed_cache_path(
        campaign_directory,
        run_fingerprint=run_fingerprint,
        source_commit=source_commit,
        corpus_sha256=corpus_sha256,
        feature_schema_sha256=feature_schema_sha256,
    )
    arguments = {
        "run_fingerprint": run_fingerprint,
        "source_commit": source_commit,
        "corpus_sha256": corpus_sha256,
        "feature_schema_sha256": feature_schema_sha256,
    }
    if directory.exists():
        return validate_packed_cache(paths, descriptors, directory, **arguments), False
    return (
        build_packed_cache(
            paths,
            descriptors,
            directory,
            observer=observer,
            **arguments,
        ),
        True,
    )


class PackedDecisionStore:
    def __init__(self, cache: PackedCache):
        self.cache = cache
        self.features = self._map("features")
        self.means = self._map("means")
        self.mean_valid = self._map("meanValid")
        self.confidence = self._map("confidence")
        self.teacher = self._map("teacher")
        self.candidate_offsets = self._map("candidateOffsets")
        self.shard_decision_offsets = self._map("shardDecisionOffsets")

    def _map(self, key: str) -> np.memmap:
        entry = self.cache.files[key]
        return np.memmap(
            self.cache.directory / str(entry["name"]),
            mode="r",
            dtype=np.dtype(str(entry["dtype"])),
            shape=tuple(int(value) for value in entry["shape"]),
            order="C",
        )

    def iter_shard(self, shard_index: int) -> Iterator[Decision]:
        first_decision = int(self.shard_decision_offsets[shard_index])
        last_decision = int(self.shard_decision_offsets[shard_index + 1])
        for decision_index in range(first_decision, last_decision):
            first_candidate = int(self.candidate_offsets[decision_index])
            last_candidate = int(self.candidate_offsets[decision_index + 1])
            yield Decision(
                features=self.features[first_candidate:last_candidate],
                means=self.means[first_candidate:last_candidate],
                mean_valid=self.mean_valid[first_candidate:last_candidate],
                teacher_index=int(self.teacher[decision_index]),
                incumbent_index=0,
                weights=self.confidence[first_candidate:last_candidate],
            )

    def close(self) -> None:
        for value in (
            self.features,
            self.means,
            self.mean_valid,
            self.confidence,
            self.teacher,
            self.candidate_offsets,
            self.shard_decision_offsets,
        ):
            mmap = getattr(value, "_mmap", None)
            if mmap is not None:
                mmap.close()
