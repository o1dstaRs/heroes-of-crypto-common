#!/usr/bin/env python3
"""Deterministic, resume-stable epoch shard ordering for the v0.9 learner."""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from typing import Sequence

TRAINING_SHARD_ORDER_SCHEMA = "hoc.ai.v0_9_training_shard_order.epoch_sha256_v1"


def training_epoch_seed(base_seed: int, epoch: int) -> int:
    if epoch < 0:
        raise ValueError("training epoch must be non-negative")
    payload = f"{TRAINING_SHARD_ORDER_SCHEMA}:{base_seed}:{epoch}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], byteorder="big", signed=False)


def ordered_worker_paths(
    paths: Sequence[Path],
    seed: int,
    worker_id: int = 0,
    worker_count: int = 1,
) -> list[Path]:
    if worker_count < 1 or worker_id < 0 or worker_id >= worker_count:
        raise ValueError("invalid shard-order worker partition")
    ordered = list(paths)
    random.Random(seed).shuffle(ordered)
    return ordered[worker_id::worker_count]


def training_epoch_order_sha256(paths: Sequence[Path], base_seed: int, epoch: int) -> str:
    ordered = ordered_worker_paths(paths, training_epoch_seed(base_seed, epoch))
    payload = json.dumps(
        [str(path.resolve()) for path in ordered],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
