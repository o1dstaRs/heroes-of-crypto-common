#!/usr/bin/env python3
"""Focused regression tests for v0.9 split planning and sealed preprocessing reuse."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from corpus import read_utf8_and_sha256
from learner_input import (
    eligible_in_order,
    normalization_cache_path,
    read_normalization_cache,
    split_eligible_paths,
    write_normalization_cache,
)
from shard_order import ordered_worker_paths

SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64


class LearnerInputTest(unittest.TestCase):
    def test_split_filter_preserves_full_corpus_permutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-input-order-") as directory:
            root = Path(directory)
            paths = [(root / f"{index}.jsonl").resolve() for index in range(6)]
            descriptors = [
                SimpleNamespace(path=str(path), split="train" if index % 2 == 0 else "validation")
                for index, path in enumerate(paths)
            ]
            eligible = split_eligible_paths(paths, descriptors)
            full_permutation = [paths[index] for index in (5, 2, 1, 4, 0, 3)]

            self.assertEqual(eligible_in_order(full_permutation, eligible["train"]), [paths[2], paths[4], paths[0]])
            self.assertEqual(
                eligible_in_order(full_permutation, eligible["validation"]),
                [paths[5], paths[1], paths[3]],
            )
            for worker in range(3):
                old_worker_order = ordered_worker_paths(paths, 5090, worker, 3)
                old_train_yields = [
                    path for path in old_worker_order if descriptors[paths.index(path)].split == "train"
                ]
                self.assertEqual(eligible_in_order(old_worker_order, eligible["train"]), old_train_yields)

    def test_normalization_cache_is_content_bound_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-normalization-") as directory:
            path = normalization_cache_path(
                Path(directory),
                run_fingerprint=SHA_B,
                source_commit="d" * 40,
                corpus_sha256=SHA_A,
                feature_schema_sha256=SHA_C,
            )
            different_source_path = normalization_cache_path(
                Path(directory),
                run_fingerprint=SHA_B,
                source_commit="e" * 40,
                corpus_sha256=SHA_A,
                feature_schema_sha256=SHA_C,
            )
            self.assertNotEqual(path, different_source_path)
            written = write_normalization_cache(
                path,
                run_fingerprint=SHA_B,
                source_commit="d" * 40,
                corpus_sha256=SHA_A,
                feature_schema_sha256=SHA_C,
                offsets=[1.25, -2.5],
                scales=[0.5, 4.0],
                observations=123,
            )
            loaded = read_normalization_cache(
                path,
                run_fingerprint=SHA_B,
                source_commit="d" * 40,
                corpus_sha256=SHA_A,
                feature_schema_sha256=SHA_C,
                feature_width=2,
            )
            self.assertEqual(loaded, written)

            tampered = json.loads(path.read_text(encoding="utf-8"))
            tampered["offsets"][0] = 99
            path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "identity or seal mismatch"):
                read_normalization_cache(
                    path,
                    run_fingerprint=SHA_B,
                    source_commit="d" * 40,
                    corpus_sha256=SHA_A,
                    feature_schema_sha256=SHA_C,
                    feature_width=2,
                )

    def test_cache_parent_symlink_is_rejected_without_writing_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-cache-parent-link-") as directory:
            root = Path(directory)
            campaign = root / "campaign"
            outside = root / "outside"
            campaign.mkdir()
            outside.mkdir()
            (campaign / "learner-cache").symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "parent must not be a symlink"):
                normalization_cache_path(
                    campaign,
                    run_fingerprint=SHA_B,
                    source_commit="d" * 40,
                    corpus_sha256=SHA_A,
                    feature_schema_sha256=SHA_C,
                )
            self.assertEqual(list(outside.iterdir()), [])

    def test_normalization_cache_file_symlink_is_rejected_on_read_and_write(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-normalization-link-") as directory:
            root = Path(directory)
            campaign = root / "campaign"
            campaign.mkdir()
            path = normalization_cache_path(
                campaign,
                run_fingerprint=SHA_B,
                source_commit="d" * 40,
                corpus_sha256=SHA_A,
                feature_schema_sha256=SHA_C,
            )
            path.parent.mkdir()
            target = root / "outside.json"
            sentinel = b"outside-must-not-change\n"
            target.write_bytes(sentinel)
            path.symlink_to(target)

            with self.assertRaisesRegex(ValueError, "file must not be a symlink"):
                read_normalization_cache(
                    path,
                    run_fingerprint=SHA_B,
                    source_commit="d" * 40,
                    corpus_sha256=SHA_A,
                    feature_schema_sha256=SHA_C,
                    feature_width=2,
                )
            with self.assertRaisesRegex(ValueError, "file must not be a symlink"):
                write_normalization_cache(
                    path,
                    run_fingerprint=SHA_B,
                    source_commit="d" * 40,
                    corpus_sha256=SHA_A,
                    feature_schema_sha256=SHA_C,
                    offsets=[1.25, -2.5],
                    scales=[0.5, 4.0],
                    observations=123,
                )
            self.assertEqual(target.read_bytes(), sentinel)

    def test_shard_text_and_exact_byte_hash_share_one_read(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hoc-v09-one-read-") as directory:
            path = Path(directory) / "shard.jsonl"
            source = b'{"scientific":1e-7}\r\n{"t":"footer"}\r\n'
            path.write_bytes(source)
            text, digest = read_utf8_and_sha256(path)

            self.assertEqual(text.splitlines(), ['{"scientific":1e-7}', '{"t":"footer"}'])
            self.assertEqual(digest, hashlib.sha256(source).hexdigest())


if __name__ == "__main__":
    unittest.main()
