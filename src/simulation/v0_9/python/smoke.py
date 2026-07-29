#!/usr/bin/env python3
"""Tiny CPU smoke for finite padded loss, quantized export, and mid-epoch checkpoint resume metadata."""

from __future__ import annotations

import tempfile
from pathlib import Path

import torch

from learner import (
    Batch,
    CandidateRanker,
    EpochProgress,
    FEATURE_WIDTH,
    NormalizedRanker,
    export_layers,
    quantized_layer_parameters,
    ranking_loss,
    restore_epoch_progress,
    save_checkpoint,
)
from shard_order import (
    ordered_worker_paths,
    training_epoch_order_sha256,
    training_epoch_seed,
)


def main() -> None:
    shard_paths = [Path(f"/immutable/shard-{index}.jsonl") for index in range(17)]
    epoch_zero_seed = training_epoch_seed(7, 0)
    epoch_one_seed = training_epoch_seed(7, 1)
    if epoch_zero_seed == epoch_one_seed:
        raise RuntimeError("adjacent epochs reused one shard permutation seed")
    if training_epoch_seed(7, 0) != epoch_zero_seed:
        raise RuntimeError("epoch shard seed is not deterministic")
    epoch_zero = ordered_worker_paths(shard_paths, epoch_zero_seed)
    if epoch_zero != ordered_worker_paths(shard_paths, training_epoch_seed(7, 0)):
        raise RuntimeError("epoch shard permutation is not resume-reproducible")
    if epoch_zero[5:] != ordered_worker_paths(shard_paths, training_epoch_seed(7, 0))[5:]:
        raise RuntimeError("mid-epoch shard suffix changed on resume")
    partitions = [ordered_worker_paths(shard_paths, epoch_zero_seed, worker, 4) for worker in range(4)]
    flattened = [path for partition in partitions for path in partition]
    if len(flattened) != len(set(flattened)) or set(flattened) != set(shard_paths):
        raise RuntimeError("worker shard partitions overlap or omit data")
    if training_epoch_order_sha256(shard_paths, 7, 0) == training_epoch_order_sha256(shard_paths, 7, 1):
        raise RuntimeError("adjacent epochs reused one shard order")

    model = NormalizedRanker(
        CandidateRanker([8]),
        torch.zeros(FEATURE_WIDTH),
        torch.ones(FEATURE_WIDTH),
        8,
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    features = torch.zeros((2, 3, FEATURE_WIDTH))
    mask = torch.tensor([[True, True, False], [True, True, True]])
    batch = Batch(
        features=features,
        means=torch.tensor([[0.2, 0.8, 0.0], [0.5, 0.3, 0.1]]),
        mean_valid=mask,
        mask=mask,
        teacher=torch.tensor([1, 0]),
        confidence=torch.tensor([[2.0, 2.0, 1.0], [2.0, 2.0, 2.0]]),
    )
    loss = ranking_loss(model(features), batch)
    if not torch.isfinite(loss):
        raise RuntimeError("padded ranking loss is not finite")
    loss.backward()
    optimizer.step()
    layers = export_layers(model, 256)
    if len(layers) != 2 or layers[-1]["outputSize"] != 1:
        raise RuntimeError("quantized export has the wrong architecture")

    with tempfile.TemporaryDirectory(prefix="hoc-v09-smoke-") as directory:
        checkpoint = Path(directory) / "learner.pt"
        config = {"smoke": True}
        shifts = tuple(
            quantized_layer_parameters(layer, 256)[1]
            for layer in model.ranker.network
            if isinstance(layer, torch.nn.Linear)
        )
        progress = EpochProgress(
            epoch=3,
            next_batch=7,
            qat_layer_shifts=shifts,
            running_loss=8.75,
            batches=7,
            examples=14,
            active_elapsed_seconds=2.5,
        )
        save_checkpoint(
            checkpoint,
            3,
            7,
            model,
            optimizer,
            config,
            [{"epoch": 2}],
            progress,
            qat_layer_shifts=shifts,
        )
        saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
        restored = restore_epoch_progress(
            saved["epochProgress"],
            next_epoch=3,
            next_batch=7,
            expected_qat_layer_count=len(shifts),
        )
        if (
            saved["nextEpoch"] != 3
            or saved["nextBatch"] != 7
            or saved["history"] != [{"epoch": 2}]
            or restored != progress
        ):
            raise RuntimeError("checkpoint lost its mid-epoch resume cursor")
    print(
        '{"ok":true,"finiteLoss":true,"quantizedExport":true,'
        '"midEpochResume":true,"epochProgress":true,"epochShardReshuffle":true}'
    )


if __name__ == "__main__":
    main()
