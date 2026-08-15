#!/usr/bin/env python3
"""Tests for topology-aware v0.9 corpus validation parallelism."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

import corpus
from corpus import corpus_validation_workers


class CorpusParallelismTest(unittest.TestCase):
    def test_topology_default_uses_puffalo_physical_core_count(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("corpus._available_cpu_count", return_value=48):
            self.assertEqual(corpus_validation_workers(24_576), 24)

    def test_topology_default_uses_m4_performance_core_count(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch("corpus._available_cpu_count", return_value=16):
            self.assertEqual(corpus_validation_workers(24_576), 12)

    def test_explicit_and_environment_workers_are_bounded_by_shards(self) -> None:
        self.assertEqual(corpus_validation_workers(3, 20), 3)
        with patch.dict(os.environ, {"V09_CORPUS_VALIDATION_WORKERS": "7"}, clear=True):
            self.assertEqual(corpus_validation_workers(100), 7)

    def test_invalid_worker_configuration_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive integer"):
            corpus_validation_workers(5, 0)
        with patch.dict(os.environ, {"V09_CORPUS_VALIDATION_WORKERS": "many"}, clear=True):
            with self.assertRaisesRegex(ValueError, "positive integer"):
                corpus_validation_workers(5)

    def test_parallel_validation_preserves_immutable_shard_order(self) -> None:
        observed: dict[str, object] = {}

        class InlineExecutor:
            def __init__(self, *, max_workers: int, initializer: object, initargs: tuple[object, ...]) -> None:
                observed["max_workers"] = max_workers
                self.initializer = initializer
                self.initargs = initargs

            def __enter__(self) -> "InlineExecutor":
                self.initializer(*self.initargs)  # type: ignore[operator]
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def map(self, function: object, paths: object, *, chunksize: int) -> list[object]:
                ordered_paths = list(paths)  # type: ignore[arg-type]
                observed["paths"] = ordered_paths
                observed["chunksize"] = chunksize
                return [function(path) for path in ordered_paths]  # type: ignore[operator]

        paths = [Path("shard-c.jsonl"), Path("shard-a.jsonl"), Path("shard-b.jsonl")]
        campaign = {"runFingerprint": "run"}
        ledger = {"schema": "ledger"}

        def validate(path: Path, actual_campaign: object, actual_ledger: object) -> Path:
            self.assertIs(actual_campaign, campaign)
            self.assertIs(actual_ledger, ledger)
            return path

        with (
            patch("corpus.concurrent.futures.ProcessPoolExecutor", InlineExecutor),
            patch("corpus.validate_shard", side_effect=validate),
            patch("corpus._validation_worker_campaign", None),
            patch("corpus._validation_worker_ledger", None),
        ):
            descriptors = corpus.validate_shards(paths, campaign, ledger, workers=2)

        self.assertEqual(descriptors, paths)
        self.assertEqual(observed["paths"], paths)
        self.assertEqual(observed["max_workers"], 2)
        self.assertGreaterEqual(observed["chunksize"], 1)


if __name__ == "__main__":
    unittest.main()
