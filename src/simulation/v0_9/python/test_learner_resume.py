#!/usr/bin/env python3
"""Exact regression tests for v0.9 mid-epoch learner resume state."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

import torch
from torch import Tensor, nn

from learner import (
    Batch,
    CandidateRanker,
    EpochProgress,
    FEATURE_WIDTH,
    NormalizedRanker,
    qat_forward,
    quantized_layer_parameters,
    ranking_loss,
    restore_epoch_progress,
    save_checkpoint,
)


def qat_shifts(model: NormalizedRanker) -> tuple[int, ...]:
    return tuple(
        quantized_layer_parameters(layer, 256)[1]
        for layer in model.ranker.network
        if isinstance(layer, nn.Linear)
    )


def threshold_model() -> NormalizedRanker:
    model = NormalizedRanker(
        CandidateRanker([1]),
        torch.zeros(FEATURE_WIDTH),
        torch.ones(FEATURE_WIDTH),
        8,
    )
    threshold = 127.0 / (2**10)
    linear = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.zero_()
        linear[0].weight[0, 0] = threshold * 0.999
        linear[1].weight[0, 0] = 0.5
    return model


def training_batch() -> Batch:
    features = torch.zeros((2, 2, FEATURE_WIDTH))
    # The model's clip limit amplifies the one-step weight-grid difference into distinct QAT activations.
    features[0, 1, 0] = 8
    features[1, 0, 0] = 8
    mask = torch.ones((2, 2), dtype=torch.bool)
    return Batch(
        features=features,
        means=torch.tensor([[0.0, 1.0], [1.0, 0.0]]),
        mean_valid=mask,
        mask=mask,
        teacher=torch.tensor([1, 0]),
        confidence=torch.ones((2, 2)),
    )


def train_one_qat_batch(
    model: NormalizedRanker,
    optimizer: torch.optim.Optimizer,
    batch: Batch,
    shifts: tuple[int, ...],
) -> float:
    optimizer.zero_grad(set_to_none=True)
    loss = ranking_loss(qat_forward(model, batch.features, 256, shifts), batch)
    loss.backward()
    nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    optimizer.step()
    return float(loss.detach())


class LearnerResumeTest(unittest.TestCase):
    def assert_nested_exact(self, left: Any, right: Any) -> None:
        if isinstance(left, Tensor):
            self.assertIsInstance(right, Tensor)
            self.assertTrue(torch.equal(left, right))
        elif isinstance(left, dict):
            self.assertIsInstance(right, dict)
            self.assertEqual(set(left), set(right))
            for key in left:
                self.assert_nested_exact(left[key], right[key])
        elif isinstance(left, (list, tuple)):
            self.assertIsInstance(right, type(left))
            self.assertEqual(len(left), len(right))
            for left_value, right_value in zip(left, right):
                self.assert_nested_exact(left_value, right_value)
        else:
            self.assertEqual(left, right)

    def test_mid_qat_resume_restores_frozen_shifts_and_partial_epoch_metrics(self) -> None:
        model = threshold_model()
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-2, weight_decay=0)
        frozen_shifts = qat_shifts(model)
        first_linear = next(layer for layer in model.ranker.network if isinstance(layer, nn.Linear))
        threshold = 127.0 / (2**10)
        with torch.no_grad():
            # Simulate an earlier batch crossing the exact boundary after the epoch's QAT schedule was frozen.
            first_linear.weight[0, 0] = threshold * 1.001
        recomputed_shifts = qat_shifts(model)
        self.assertNotEqual(frozen_shifts, recomputed_shifts)
        self.assertEqual(frozen_shifts[0], 10)
        self.assertEqual(recomputed_shifts[0], 9)

        prefix = EpochProgress(
            epoch=4,
            next_batch=1,
            qat_layer_shifts=frozen_shifts,
            running_loss=1.25,
            batches=1,
            examples=2,
            active_elapsed_seconds=3.5,
        )
        batch = training_batch()
        with tempfile.TemporaryDirectory(prefix="hoc-v09-resume-exact-") as directory:
            checkpoint = Path(directory) / "learner.pt"
            save_checkpoint(checkpoint, 4, 1, model, optimizer, {"test": True}, [], prefix)
            saved = torch.load(checkpoint, map_location="cpu", weights_only=False)

            uninterrupted_suffix_loss = train_one_qat_batch(model, optimizer, batch, frozen_shifts)

            resumed_model = threshold_model()
            resumed_optimizer = torch.optim.AdamW(resumed_model.parameters(), lr=1e-2, weight_decay=0)
            resumed_model.load_state_dict(saved["model"])
            resumed_optimizer.load_state_dict(saved["optimizer"])
            restored = restore_epoch_progress(
                saved["epochProgress"],
                next_epoch=saved["nextEpoch"],
                next_batch=saved["nextBatch"],
                expected_qat_layer_count=2,
            )
            self.assertEqual(restored, prefix)
            assert restored is not None
            resumed_suffix_loss = train_one_qat_batch(
                resumed_model,
                resumed_optimizer,
                batch,
                restored.qat_layer_shifts,
            )

            self.assertEqual(uninterrupted_suffix_loss, resumed_suffix_loss)
            self.assert_nested_exact(model.state_dict(), resumed_model.state_dict())
            self.assert_nested_exact(optimizer.state_dict(), resumed_optimizer.state_dict())
            self.assertEqual(restored.running_loss + resumed_suffix_loss, 1.25 + uninterrupted_suffix_loss)
            self.assertEqual(restored.batches + 1, 2)
            self.assertEqual(restored.examples + batch.features.shape[0], 4)
            self.assertEqual(restored.active_elapsed_seconds + 0.75, 4.25)

            wrong_model = threshold_model()
            wrong_optimizer = torch.optim.AdamW(wrong_model.parameters(), lr=1e-2, weight_decay=0)
            wrong_model.load_state_dict(saved["model"])
            wrong_optimizer.load_state_dict(saved["optimizer"])
            train_one_qat_batch(wrong_model, wrong_optimizer, batch, recomputed_shifts)
            self.assertTrue(
                any(
                    not torch.equal(expected, wrong)
                    for expected, wrong in zip(model.state_dict().values(), wrong_model.state_dict().values())
                ),
                "regression setup must diverge when resume incorrectly recomputes QAT shifts",
            )

    def test_mid_epoch_checkpoint_requires_complete_progress(self) -> None:
        model = threshold_model()
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-2)
        with tempfile.TemporaryDirectory(prefix="hoc-v09-resume-required-") as directory:
            with self.assertRaisesRegex(ValueError, "in-progress epoch state"):
                save_checkpoint(Path(directory) / "learner.pt", 1, 1, model, optimizer, {}, [])


if __name__ == "__main__":
    unittest.main()
