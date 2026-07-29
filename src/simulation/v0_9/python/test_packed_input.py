#!/usr/bin/env python3
"""Byte-exact A/B tests for the v0.9 JSONL-to-mmap learner cache."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from torch.utils.data import DataLoader

from learner import (
    DecisionDataset,
    NormalizationAccumulator,
    collate as collate_torch,
    prepare_input_caches,
)
from learner_input import eligible_in_order, normalization_cache_path, split_eligible_paths
from packed_input import (
    FEATURE_WIDTH,
    FULL_FEATURE_SHA256,
    IL_SCHEMA,
    IL_VERSION,
    PACKED_CACHE_BUILD_HEADROOM_BYTES,
    PACKED_CACHE_FREE_RESERVE_BYTES,
    PACKED_CACHE_SCHEMA,
    PackedDecisionStore,
    _HashedWriter,
    build_packed_cache,
    cleanup_stale_packed_cache_temporaries,
    collate_numpy,
    expected_packed_data_bytes,
    file_sha256,
    fingerprint,
    iter_json_decisions,
    load_or_build_packed_cache,
    packed_cache_path,
    packed_cache_required_free_bytes,
    validate_packed_cache,
)
from shard_order import ordered_worker_paths

RUN = "a" * 64
SOURCE = "b" * 40
CORPUS = "c" * 64


def candidate(candidate_index: int, rejected: bool = False) -> dict[str, object]:
    return {
        "candidateFeatures": [
            candidate_index,
            -0.0,
            1e-7,
            -2.5,
            16_777_217,
            *(index / 7 for index in range(6)),
        ],
        "actionFeatures": [((index + 1) * (candidate_index + 1)) / 13 for index in range(50)],
        "richFeatures": [-(index + candidate_index) / 17 for index in range(45)],
        "teacherMean": None if rejected else 0.125 * (candidate_index + 1),
        "teacherStdErr": None if candidate_index % 2 == 0 else 0.03125,
        "teacherVisits": 8 + candidate_index,
    }


def decision_row(split: str, shard_index: int, decision_index: int, candidate_count: int) -> dict[str, object]:
    candidates = [
        candidate(index, rejected=index == 0 and candidate_count > 1)
        for index in range(candidate_count)
    ]
    return {
        "t": "v09_il_decision",
        "v": IL_VERSION,
        "schema": IL_SCHEMA,
        "featureFingerprints": {"full": FULL_FEATURE_SHA256},
        "split": split,
        "valueFeatures": [
            shard_index,
            decision_index,
            1e-30,
            -1e30,
            -0.0,
            *(index / 11 for index in range(55)),
        ],
        "candidates": candidates,
        "teacherIndex": candidate_count - 1,
        "incumbentIndex": 0,
    }


def array_bytes(decision: object) -> tuple[bytes, ...]:
    return (
        np.asarray(decision.features, dtype="<f4").tobytes(),
        np.asarray(decision.means, dtype="<f4").tobytes(),
        np.asarray(decision.mean_valid, dtype=np.bool_).tobytes(),
        np.asarray([decision.teacher_index], dtype="<i8").tobytes(),
        np.asarray(decision.weights, dtype="<f4").tobytes(),
    )


def batch_bytes(batch: object) -> tuple[tuple[str, tuple[int, ...], bytes], ...]:
    return tuple(
        (str(value.dtype), value.shape, value.tobytes(order="C"))
        for value in (
            batch.features,
            batch.means,
            batch.mean_valid,
            batch.mask,
            batch.teacher,
            batch.confidence,
        )
    )


def torch_batch_bytes(batch: object) -> tuple[tuple[str, tuple[int, ...], bytes], ...]:
    return tuple(
        (str(value.numpy().dtype), tuple(value.shape), value.numpy().tobytes(order="C"))
        for value in (
            batch.features,
            batch.means,
            batch.mean_valid,
            batch.mask,
            batch.teacher,
            batch.confidence,
        )
    )


class PackedInputTest(unittest.TestCase):
    def fixtures(
        self,
        root: Path,
    ) -> tuple[list[Path], list[SimpleNamespace], dict[str, frozenset[Path]]]:
        paths: list[Path] = []
        descriptors: list[SimpleNamespace] = []
        for shard_index in range(7):
            split = "train" if shard_index % 3 else "validation"
            path = (root / f"{shard_index:02d}.jsonl").resolve()
            rows = [
                decision_row(split, shard_index, decision_index, 1 + (shard_index + decision_index) % 4)
                for decision_index in range(1 + shard_index % 3)
            ]
            path.write_text(
                "\n".join(json.dumps(row, separators=(",", ":")) for row in rows)
                + '\n{"t":"v09_il_game"}\n',
                encoding="utf-8",
            )
            paths.append(path)
            descriptors.append(
                SimpleNamespace(
                    path=str(path),
                    split=split,
                    decisions=len(rows),
                    fileSha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                )
            )
        return paths, descriptors, split_eligible_paths(paths, descriptors)

    def resign_file(self, cache_directory: Path, key: str) -> None:
        manifest_path = cache_directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entry = manifest["files"][key]
        entry["sha256"] = file_sha256(cache_directory / entry["name"])
        unsigned = {name: value for name, value in manifest.items() if name != "cacheSha256"}
        manifest["cacheSha256"] = fingerprint(unsigned)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_json_and_packed_decisions_and_batches_are_byte_exact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-ab-") as directory:
            root = Path(directory)
            paths, descriptors, eligible = self.fixtures(root)
            cache_directory = packed_cache_path(
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            observed_train = []
            packed_normalization = NormalizationAccumulator()

            def observe(decision: object, split: str) -> None:
                if split == "train":
                    observed_train.append(decision)
                    packed_normalization.observe(decision)

            cache = build_packed_cache(
                paths,
                descriptors,
                cache_directory,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
                observer=observe,
            )
            expected_train = list(iter_json_decisions(eligible_in_order(paths, eligible["train"]), "train"))
            self.assertEqual([array_bytes(value) for value in observed_train], [array_bytes(value) for value in expected_train])
            json_normalization = NormalizationAccumulator()
            for decision in expected_train:
                json_normalization.observe(decision)
            for packed_value, json_value in zip(packed_normalization.finish(), json_normalization.finish()):
                if hasattr(packed_value, "numpy"):
                    self.assertEqual(packed_value.numpy().tobytes(), json_value.numpy().tobytes())
                else:
                    self.assertEqual(packed_value, json_value)
            self.assertEqual(
                cache.data_bytes,
                expected_packed_data_bytes(cache.candidates, cache.decisions, cache.shards),
            )

            validated = validate_packed_cache(
                paths,
                descriptors,
                cache_directory,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertEqual(validated.cache_sha256, cache.cache_sha256)
            store = PackedDecisionStore(validated)
            try:
                for shard_index, (path, descriptor) in enumerate(zip(paths, descriptors)):
                    unpacked = list(iter_json_decisions((path,), descriptor.split))
                    packed = list(store.iter_shard(shard_index))
                    self.assertEqual([array_bytes(value) for value in packed], [array_bytes(value) for value in unpacked])
                    self.assertEqual(batch_bytes(collate_numpy(packed)), batch_bytes(collate_numpy(unpacked)))
                    self.assertEqual(torch_batch_bytes(collate_torch(packed)), torch_batch_bytes(collate_torch(unpacked)))

                for worker in range(3):
                    worker_order = ordered_worker_paths(paths, 5090, worker, 3)
                    unpacked = list(iter_json_decisions(eligible_in_order(worker_order, eligible["train"]), "train"))
                    packed = [
                        decision
                        for path in eligible_in_order(worker_order, eligible["train"])
                        for decision in store.iter_shard(paths.index(path))
                    ]
                    self.assertEqual([array_bytes(value) for value in packed], [array_bytes(value) for value in unpacked])
                    self.assertEqual(batch_bytes(collate_numpy(packed)), batch_bytes(collate_numpy(unpacked)))
                    self.assertEqual(torch_batch_bytes(collate_torch(packed)), torch_batch_bytes(collate_torch(unpacked)))
            finally:
                store.close()

            reused, built = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
                observer=lambda _decision, _split: self.fail("cache reuse reparsed JSONL"),
            )
            self.assertFalse(built)
            self.assertEqual(reused.cache_sha256, cache.cache_sha256)

    def test_data_tampering_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-tamper-") as directory:
            root = Path(directory)
            paths, descriptors, _eligible = self.fixtures(root)
            cache, built = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertTrue(built)
            means_path = cache.directory / str(cache.files["means"]["name"])
            source = bytearray(means_path.read_bytes())
            source[len(source) // 2] ^= 0x01
            means_path.write_bytes(source)
            with self.assertRaisesRegex(ValueError, "data seal mismatch"):
                validate_packed_cache(
                    paths,
                    descriptors,
                    cache.directory,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )

    def test_resigned_noncanonical_numeric_data_fails_closed(self) -> None:
        corruptions = (
            ("features", None, "candidate numeric", lambda values: values.__setitem__((0, 0), np.nan)),
            ("means", None, "candidate numeric", lambda values: values.__setitem__(0, np.nan)),
            ("confidence", None, "candidate numeric", lambda values: values.__setitem__(0, np.nan)),
            ("confidence", None, "candidate numeric", lambda values: values.__setitem__(0, 0.0)),
            ("meanValid", "|u1", "candidate numeric", lambda values: values.__setitem__(0, 2)),
            (
                "meanValid",
                "|u1",
                "teacher index points at an invalid mean",
                lambda values: values.__setitem__(0, 0),
            ),
        )
        for index, (key, dtype_override, message, corrupt) in enumerate(corruptions):
            with self.subTest(key=key, corruption=index):
                with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-numeric-") as directory:
                    root = Path(directory)
                    paths, descriptors, _eligible = self.fixtures(root)
                    cache, built = load_or_build_packed_cache(
                        paths,
                        descriptors,
                        root,
                        run_fingerprint=RUN,
                        source_commit=SOURCE,
                        corpus_sha256=CORPUS,
                        feature_schema_sha256=FULL_FEATURE_SHA256,
                    )
                    self.assertTrue(built)
                    entry = cache.files[key]
                    values = np.memmap(
                        cache.directory / str(entry["name"]),
                        mode="r+",
                        dtype=np.dtype(dtype_override or str(entry["dtype"])),
                        shape=tuple(int(value) for value in entry["shape"]),
                    )
                    corrupt(values)
                    values.flush()
                    mmap = getattr(values, "_mmap", None)
                    if mmap is not None:
                        mmap.close()
                    self.resign_file(cache.directory, key)
                    with self.assertRaisesRegex(ValueError, message):
                        validate_packed_cache(
                            paths,
                            descriptors,
                            cache.directory,
                            run_fingerprint=RUN,
                            source_commit=SOURCE,
                            corpus_sha256=CORPUS,
                            feature_schema_sha256=FULL_FEATURE_SHA256,
                        )

    def test_cache_parent_and_manifest_symlinks_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-links-") as directory:
            root = Path(directory)
            campaign = root / "campaign"
            outside = root / "outside"
            campaign.mkdir()
            outside.mkdir()
            (campaign / "learner-cache").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "parent must not be a symlink"):
                packed_cache_path(
                    campaign,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            self.assertEqual(list(outside.iterdir()), [])

            (campaign / "learner-cache").unlink()
            paths, descriptors, _eligible = self.fixtures(campaign)
            cache, built = load_or_build_packed_cache(
                paths,
                descriptors,
                campaign,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertTrue(built)
            manifest = cache.directory / "manifest.json"
            outside_manifest = outside / "manifest.json"
            manifest.replace(outside_manifest)
            manifest.symlink_to(outside_manifest)
            with self.assertRaisesRegex(ValueError, "manifest must not be a symlink"):
                validate_packed_cache(
                    paths,
                    descriptors,
                    cache.directory,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )

    def test_final_packed_directory_symlink_fails_closed_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-directory-link-") as directory:
            root = Path(directory)
            paths, descriptors, _eligible = self.fixtures(root)
            cache, built = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertTrue(built)
            outside = root / "outside"
            outside.mkdir()
            target = outside / "packed-target"
            cache.directory.replace(target)
            cache.directory.symlink_to(target, target_is_directory=True)
            before = {
                path.relative_to(target): path.read_bytes()
                for path in target.rglob("*")
                if path.is_file()
            }

            with self.assertRaisesRegex(ValueError, "directory must not be a symlink"):
                validate_packed_cache(
                    paths,
                    descriptors,
                    cache.directory,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            with self.assertRaisesRegex(ValueError, "directory must not be a symlink"):
                load_or_build_packed_cache(
                    paths,
                    descriptors,
                    root,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            after = {
                path.relative_to(target): path.read_bytes()
                for path in target.rglob("*")
                if path.is_file()
            }
            self.assertEqual(after, before)

    def test_packed_data_file_symlink_fails_closed_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-data-link-") as directory:
            root = Path(directory)
            paths, descriptors, _eligible = self.fixtures(root)
            cache, built = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertTrue(built)
            data_path = cache.directory / str(cache.files["features"]["name"])
            outside = root / "outside-features.f32"
            data_path.replace(outside)
            data_path.symlink_to(outside)
            before = outside.read_bytes()

            with self.assertRaisesRegex(ValueError, "features data seal mismatch"):
                validate_packed_cache(
                    paths,
                    descriptors,
                    cache.directory,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            with self.assertRaisesRegex(ValueError, "features data seal mismatch"):
                load_or_build_packed_cache(
                    paths,
                    descriptors,
                    root,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            self.assertEqual(outside.read_bytes(), before)

    def test_combined_cache_prepare_is_resume_stable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-prepare-") as directory:
            root = Path(directory)
            paths, descriptors, eligible = self.fixtures(root)
            campaign = {"runFingerprint": RUN, "identity": {"sourceCommit": SOURCE}}
            first = prepare_input_caches(paths, descriptors, eligible, campaign, CORPUS, root)
            second = prepare_input_caches(paths, descriptors, eligible, campaign, CORPUS, root)

            for first_value, second_value in zip(first[:3], second[:3]):
                if hasattr(first_value, "numpy"):
                    self.assertEqual(first_value.numpy().tobytes(), second_value.numpy().tobytes())
                else:
                    self.assertEqual(first_value, second_value)
            self.assertEqual(first[3].cache_sha256, second[3].cache_sha256)
            self.assertEqual(first[4].cache_sha256, second[4].cache_sha256)
            expected_decisions = sum(
                descriptor.decisions for descriptor in descriptors if descriptor.split == "train"
            )
            iterations = int(os.environ.get("V09_PACKED_DATALOADER_STRESS", "1"))
            for _iteration in range(iterations):
                loader = DataLoader(
                    DecisionDataset(paths, "train", 5090, eligible["train"], first[4]),
                    batch_size=3,
                    num_workers=2,
                    collate_fn=collate_torch,
                )
                iterator = iter(loader)
                try:
                    self.assertEqual(
                        sum(int(batch.teacher.shape[0]) for batch in iterator),
                        expected_decisions,
                    )
                finally:
                    iterator._shutdown_workers()

    def test_existing_packed_cache_cannot_normalize_changed_source_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-normalization-source-race-") as directory:
            root = Path(directory)
            paths, descriptors, eligible = self.fixtures(root)
            campaign = {"runFingerprint": RUN, "identity": {"sourceCommit": SOURCE}}
            packed, built = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertTrue(built)
            changed = next(
                path for path, descriptor in zip(paths, descriptors) if descriptor.split == "train"
            )
            changed.write_bytes(changed.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "bytes changed after corpus validation"):
                prepare_input_caches(paths, descriptors, eligible, campaign, CORPUS, root)
            cache_path = normalization_cache_path(
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertFalse(cache_path.exists())
            self.assertTrue(packed.directory.is_dir())

    def test_disk_preflight_accounts_for_maximum_corpus_and_only_cleans_stale_temps(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-preflight-") as directory:
            root = Path(directory)
            paths, descriptors, _eligible = self.fixtures(root)
            cache_directory = packed_cache_path(
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            cache_directory.parent.mkdir()
            stale = cache_directory.parent / f".packed-{'1' * 64}.stale01"
            stale.mkdir()
            (stale / "partial.bin").write_bytes(b"partial")
            obsolete = cache_directory.parent / f"packed-{'2' * 64}"
            obsolete.mkdir()
            (obsolete / "old.bin").write_bytes(b"old-cache")
            maximum_data_bytes = expected_packed_data_bytes(
                sum(descriptor.decisions for descriptor in descriptors) * 96,
                sum(descriptor.decisions for descriptor in descriptors),
                len(paths),
            )
            required = packed_cache_required_free_bytes(maximum_data_bytes)
            self.assertEqual(
                required,
                maximum_data_bytes
                + PACKED_CACHE_FREE_RESERVE_BYTES
                + PACKED_CACHE_BUILD_HEADROOM_BYTES,
            )

            with patch("packed_input.shutil.disk_usage", return_value=SimpleNamespace(free=required - 1)):
                with self.assertRaisesRegex(
                    ValueError,
                    f"maximumDataBytes={maximum_data_bytes}",
                ):
                    build_packed_cache(
                        paths,
                        descriptors,
                        cache_directory,
                        run_fingerprint=RUN,
                        source_commit=SOURCE,
                        corpus_sha256=CORPUS,
                        feature_schema_sha256=FULL_FEATURE_SHA256,
                    )
            self.assertFalse(stale.exists())
            self.assertTrue(obsolete.is_dir())
            self.assertFalse(cache_directory.exists())
            self.assertEqual(list(cache_directory.parent.glob(f".{cache_directory.name}.*")), [])

    def test_stale_temp_cleanup_is_scoped_and_never_follows_links(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-stale-cleanup-") as directory:
            root = Path(directory)
            parent = root / "learner-cache"
            parent.mkdir()
            outside = root / "outside"
            outside.mkdir()
            sentinel = outside / "sentinel.bin"
            sentinel.write_bytes(b"must-survive")
            stale = parent / f".packed-{'3' * 64}.stale02"
            stale.mkdir()
            (stale / "outside-link").symlink_to(outside, target_is_directory=True)
            blocked = parent / f".packed-{'4' * 64}.stale03"
            blocked.symlink_to(outside, target_is_directory=True)
            completed = parent / f"packed-{'5' * 64}"
            completed.mkdir()
            unknown = parent / ".packed-not-owned.stale04"
            unknown.mkdir()

            with self.assertRaisesRegex(ValueError, "cleanup refuses symlink"):
                cleanup_stale_packed_cache_temporaries(parent)
            self.assertTrue(stale.is_dir())
            self.assertTrue(completed.is_dir())
            self.assertTrue(unknown.is_dir())
            self.assertEqual(sentinel.read_bytes(), b"must-survive")

            blocked.unlink()
            self.assertEqual(
                cleanup_stale_packed_cache_temporaries(parent),
                (stale.name,),
            )
            self.assertFalse(stale.exists())
            self.assertTrue(completed.is_dir())
            self.assertTrue(unknown.is_dir())
            self.assertEqual(sentinel.read_bytes(), b"must-survive")

    def test_completed_cache_gc_requires_valid_active_and_is_scoped(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-completed-cleanup-") as directory:
            root = Path(directory)
            paths, descriptors, _eligible = self.fixtures(root)
            cache, built = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertTrue(built)
            obsolete = cache.directory.parent / f"packed-{'6' * 64}"
            obsolete.mkdir()
            (obsolete / "old.bin").write_bytes(b"old-cache")
            unknown = cache.directory.parent / "packed-not-owned"
            unknown.mkdir()
            outside = root / "outside"
            outside.mkdir()
            sentinel = outside / "sentinel.bin"
            sentinel.write_bytes(b"must-survive")
            blocked = cache.directory.parent / f"packed-{'7' * 64}"
            blocked.symlink_to(outside, target_is_directory=True)
            means_path = cache.directory / str(cache.files["means"]["name"])
            original_means = means_path.read_bytes()
            corrupted_means = bytearray(original_means)
            corrupted_means[0] ^= 0x01
            means_path.write_bytes(corrupted_means)

            with self.assertRaisesRegex(ValueError, "means data seal mismatch"):
                load_or_build_packed_cache(
                    paths,
                    descriptors,
                    root,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            self.assertTrue(obsolete.is_dir())
            self.assertTrue(blocked.is_symlink())
            means_path.write_bytes(original_means)

            with self.assertRaisesRegex(ValueError, "cleanup refuses symlink"):
                load_or_build_packed_cache(
                    paths,
                    descriptors,
                    root,
                    run_fingerprint=RUN,
                    source_commit=SOURCE,
                    corpus_sha256=CORPUS,
                    feature_schema_sha256=FULL_FEATURE_SHA256,
                )
            self.assertTrue(obsolete.is_dir())
            self.assertTrue(blocked.is_symlink())
            self.assertEqual(sentinel.read_bytes(), b"must-survive")

            blocked.unlink()
            reused, rebuilt = load_or_build_packed_cache(
                paths,
                descriptors,
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            self.assertFalse(rebuilt)
            self.assertEqual(reused.cache_sha256, cache.cache_sha256)
            self.assertFalse(obsolete.exists())
            self.assertTrue(cache.directory.is_dir())
            self.assertTrue(unknown.is_dir())
            self.assertEqual(sentinel.read_bytes(), b"must-survive")

    def test_failed_build_removes_its_partial_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-packed-cleanup-") as directory:
            root = Path(directory)
            paths, descriptors, _eligible = self.fixtures(root)
            cache_directory = packed_cache_path(
                root,
                run_fingerprint=RUN,
                source_commit=SOURCE,
                corpus_sha256=CORPUS,
                feature_schema_sha256=FULL_FEATURE_SHA256,
            )
            with patch.object(_HashedWriter, "write", side_effect=OSError(28, "synthetic ENOSPC")):
                with self.assertRaisesRegex(OSError, "synthetic ENOSPC"):
                    build_packed_cache(
                        paths,
                        descriptors,
                        cache_directory,
                        run_fingerprint=RUN,
                        source_commit=SOURCE,
                        corpus_sha256=CORPUS,
                        feature_schema_sha256=FULL_FEATURE_SHA256,
                    )
            self.assertFalse(cache_directory.exists())
            self.assertEqual(list(cache_directory.parent.glob(f".{cache_directory.name}.*")), [])

            original_init = _HashedWriter.__init__
            calls = 0

            def fail_second_writer(writer: _HashedWriter, path: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError(28, "synthetic writer construction failure")
                original_init(writer, path)

            with patch.object(_HashedWriter, "__init__", new=fail_second_writer):
                with self.assertRaisesRegex(OSError, "writer construction failure"):
                    build_packed_cache(
                        paths,
                        descriptors,
                        cache_directory,
                        run_fingerprint=RUN,
                        source_commit=SOURCE,
                        corpus_sha256=CORPUS,
                        feature_schema_sha256=FULL_FEATURE_SHA256,
                    )
            self.assertFalse(cache_directory.exists())
            self.assertEqual(list(cache_directory.parent.glob(f".{cache_directory.name}.*")), [])


if __name__ == "__main__":
    unittest.main()
