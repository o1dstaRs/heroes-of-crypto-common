#!/usr/bin/env python3
"""Regression tests for exact v0.9 QAT and fixed-point export semantics."""

from __future__ import annotations

import contextlib
import math
import tempfile
import unittest
from pathlib import Path

import torch
from torch import Tensor, nn

from learner import (
    Batch,
    CandidateRanker,
    CHECKPOINT_SCHEMA,
    EpochProgress,
    FEATURE_WIDTH,
    FixedPointRanker,
    NormalizedRanker,
    enforce_fixed_point_gates,
    export_layers,
    load_qat_candidate,
    qat_candidate_key,
    qat_candidate_passes,
    qat_forward,
    quantized_layer_parameters,
    restore_qat_checkpoint_state,
    restore_layer_shifts,
    restore_qat_candidate,
    round_half_away_tensor,
    save_checkpoint,
    select_best_qat_candidate,
    snapshot_qat_candidate,
    training_forward_loss,
)


def small_model(hidden: list[int] | None = None) -> NormalizedRanker:
    torch.manual_seed(19)
    return NormalizedRanker(
        CandidateRanker(hidden or [4]),
        torch.zeros(FEATURE_WIDTH),
        torch.ones(FEATURE_WIDTH),
        8,
    )


def layer_shifts(model: NormalizedRanker) -> tuple[int, ...]:
    return tuple(
        quantized_layer_parameters(layer, 256)[1]
        for layer in model.ranker.network
        if isinstance(layer, nn.Linear)
    )


def training_batch(device: torch.device = torch.device("cpu")) -> Batch:
    torch.manual_seed(23)
    features = torch.randn((4, 5, FEATURE_WIDTH), device=device) / 4
    mask = torch.tensor(
        [
            [True, True, True, False, False],
            [True, True, True, True, False],
            [True, True, True, True, True],
            [True, True, False, False, False],
        ],
        device=device,
    )
    means = torch.randn((4, 5), device=device)
    return Batch(
        features=features,
        means=means,
        mean_valid=mask,
        mask=mask,
        teacher=torch.tensor([1, 2, 4, 0], device=device),
        confidence=torch.ones((4, 5), device=device),
    )


def candidate_metrics(
    *,
    epoch: int = 25,
    agreement: float = 1.0,
    fixed_accuracy: float = 0.34,
    reference_accuracy: float = 0.345,
    loss: float = 3.5,
) -> dict[str, object]:
    return {
        "schema": "hoc.ai.v0_9_qat_candidate.v1",
        "epoch": epoch,
        "stage": "epoch",
        "model": {},
        "layerShifts": [7, 6],
        "floatValidation": {"loss": loss, "top1Accuracy": fixed_accuracy},
        "fixedValidation": {
            "top1Accuracy": fixed_accuracy,
            "qatFixedTop1Agreement": agreement,
            "floatFixedTop1Agreement": 0.936002,
        },
        "referenceValidation": {"top1Accuracy": reference_accuracy},
        "fidelityAccuracyDrop": reference_accuracy - fixed_accuracy,
    }


class LearnerQuantizationTest(unittest.TestCase):
    def _qat_loss_and_gradients(
        self,
        state: dict[str, Tensor],
        outer_autocast: bool,
    ) -> tuple[Tensor, Tensor, dict[str, Tensor]]:
        model = small_model()
        model.load_state_dict(state)
        batch = training_batch()
        outer = (
            torch.autocast(device_type="cpu", dtype=torch.bfloat16)
            if outer_autocast
            else contextlib.nullcontext()
        )
        with outer:
            scores, loss = training_forward_loss(model, batch, 256, layer_shifts(model), True, "bf16")
        loss.backward()
        gradients = {
            name: parameter.grad.detach().clone()
            for name, parameter in model.named_parameters()
            if parameter.grad is not None
        }
        return scores.detach(), loss.detach(), gradients

    def test_qat_forward_and_loss_ignore_outer_bf16_autocast(self) -> None:
        state = small_model().state_dict()
        plain_scores, plain_loss, plain_gradients = self._qat_loss_and_gradients(state, False)
        amp_scores, amp_loss, amp_gradients = self._qat_loss_and_gradients(state, True)

        self.assertEqual(plain_scores.dtype, torch.float32)
        self.assertEqual(amp_scores.dtype, torch.float32)
        self.assertTrue(torch.equal(plain_scores, amp_scores))
        self.assertTrue(torch.equal(plain_loss, amp_loss))
        self.assertEqual(set(plain_gradients), set(amp_gradients))
        for name in plain_gradients:
            self.assertTrue(torch.equal(plain_gradients[name], amp_gradients[name]), name)

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA is required for the GPU autocast regression")
    def test_cuda_qat_forward_and_loss_ignore_outer_bf16_autocast(self) -> None:
        device = torch.device("cuda")
        base = small_model().to(device)
        state = base.state_dict()
        batch = training_batch(device)

        def run(outer_autocast: bool) -> tuple[Tensor, Tensor, list[Tensor]]:
            model = small_model().to(device)
            model.load_state_dict(state)
            outer = (
                torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                if outer_autocast
                else contextlib.nullcontext()
            )
            with outer:
                scores, loss = training_forward_loss(model, batch, 256, layer_shifts(model), True, "bf16")
            loss.backward()
            return (
                scores.detach().cpu(),
                loss.detach().cpu(),
                [parameter.grad.detach().cpu() for parameter in model.parameters()],
            )

        plain_scores, plain_loss, plain_gradients = run(False)
        amp_scores, amp_loss, amp_gradients = run(True)
        self.assertTrue(torch.equal(plain_scores, amp_scores))
        self.assertTrue(torch.equal(plain_loss, amp_loss))
        for plain, amp in zip(plain_gradients, amp_gradients):
            self.assertTrue(torch.equal(plain, amp))

    def test_export_rounds_weight_and_bias_ties_half_away(self) -> None:
        layer = nn.Linear(4, 2)
        with torch.no_grad():
            layer.weight.copy_(
                torch.tensor(
                    [
                        [1.0, 1 / 128, -1 / 128, 0.0],
                        [-1.0, -1 / 128, 1 / 128, 0.0],
                    ]
                )
            )
            half_bias_quantum = 0.5 / (256 * 64)
            layer.bias.copy_(torch.tensor([half_bias_quantum, -half_bias_quantum]))
        weights, shift, biases = quantized_layer_parameters(layer, 256, 6)
        self.assertEqual(shift, 6)
        self.assertEqual(weights.tolist(), [[64, 1, -1, 0], [-64, -1, 1, 0]])
        self.assertEqual(biases, [1, -1])

    def test_fp32_qat_projection_matches_fixed_ranker_on_frozen_grid(self) -> None:
        model = small_model([3])
        linear = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
        with torch.no_grad():
            for parameter in model.parameters():
                parameter.zero_()
            linear[0].weight[0, 0] = 0.5
            linear[0].weight[1, 1] = -0.25
            linear[0].weight[2, 2] = 0.125
            linear[1].weight[0] = torch.tensor([0.5, -0.25, 0.125])
        shifts = layer_shifts(model)
        raw = torch.zeros((3, 4, FEATURE_WIDTH))
        raw[:, :, :3] = torch.tensor(
            [
                [[0, 0, 0], [1, 0, 0], [2, -1, 0], [3, -2, 1]],
                [[-1, -2, 1], [0, 2, 2], [1, 1, 3], [2, 0, 4]],
                [[4, -4, 0], [3, -3, 1], [2, -2, 2], [1, -1, 3]],
            ],
            dtype=torch.float32,
        ) / 256
        qat_scores = qat_forward(model, raw, 256, shifts)
        fixed_scores = FixedPointRanker(model, 256, torch.device("cpu"), shifts)(raw)
        qat_integer = round_half_away_tensor(qat_scores * 256).to(torch.int64)
        self.assertTrue(torch.equal(qat_integer, fixed_scores))
        self.assertTrue(torch.equal(qat_integer.argmax(dim=1), fixed_scores.argmax(dim=1)))

    def test_export_and_fixed_ranker_keep_frozen_shift_after_weight_drift(self) -> None:
        model = small_model([1])
        linear = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
        threshold = 127.0 / (2**10)
        with torch.no_grad():
            for parameter in model.parameters():
                parameter.zero_()
            linear[0].weight[0, 0] = threshold * 0.999
            linear[1].weight[0, 0] = 0.5
        frozen = layer_shifts(model)
        self.assertEqual(frozen[0], 10)
        with torch.no_grad():
            linear[0].weight[0, 0] = threshold * 1.001
        recomputed = layer_shifts(model)
        self.assertEqual(recomputed[0], 9)

        exported = export_layers(model, 256, frozen)
        fixed = FixedPointRanker(model, 256, torch.device("cpu"), frozen)
        self.assertEqual(tuple(layer["scaleShift"] for layer in exported), frozen)
        self.assertEqual(tuple(layer[1] for layer in fixed.layers), frozen)
        raw = torch.zeros((1, 2, FEATURE_WIDTH))
        raw[0, 1, 0] = 4 / 256
        frozen_choice = FixedPointRanker(model, 256, torch.device("cpu"), frozen)(raw).argmax(dim=1)
        recomputed_choice = FixedPointRanker(model, 256, torch.device("cpu"), recomputed)(raw).argmax(dim=1)
        self.assertEqual(int(frozen_choice), 0)
        self.assertEqual(int(recomputed_choice), 1)

    def test_parity_and_fidelity_gates_are_independent(self) -> None:
        passing = candidate_metrics(agreement=1.0, fixed_accuracy=0.34, reference_accuracy=0.345)
        self.assertTrue(qat_candidate_passes(passing, 0.99, 0.01))
        # The undeployed raw/fixed agreement from the failed campaign remains diagnostic only.
        self.assertEqual(passing["fixedValidation"]["floatFixedTop1Agreement"], 0.936002)

        bad_parity = candidate_metrics(agreement=0.98, fixed_accuracy=0.35, reference_accuracy=0.345)
        self.assertFalse(qat_candidate_passes(bad_parity, 0.99, 0.01))
        bad_fidelity = candidate_metrics(agreement=1.0, fixed_accuracy=0.33, reference_accuracy=0.345)
        self.assertFalse(qat_candidate_passes(bad_fidelity, 0.99, 0.01))
        self.assertGreater(qat_candidate_key(passing, 0.99, 0.01), qat_candidate_key(bad_parity, 0.99, 0.01))
        self.assertGreater(qat_candidate_key(passing, 0.99, 0.01), qat_candidate_key(bad_fidelity, 0.99, 0.01))

        boundary = candidate_metrics(agreement=0.99, fixed_accuracy=0.335, reference_accuracy=0.345)
        self.assertTrue(qat_candidate_passes(boundary, 0.99, 0.01))
        self.assertAlmostEqual(enforce_fixed_point_gates(
            boundary["fixedValidation"],
            boundary["referenceValidation"],
            0.99,
            0.01,
        ), 0.01)
        just_below_agreement = candidate_metrics(
            agreement=math.nextafter(0.99, 0),
            fixed_accuracy=0.34,
            reference_accuracy=0.345,
        )
        with self.assertRaisesRegex(RuntimeError, "agreement"):
            enforce_fixed_point_gates(
                just_below_agreement["fixedValidation"],
                just_below_agreement["referenceValidation"],
                0.99,
                0.01,
            )
        just_above_drop = candidate_metrics(
            agreement=1.0,
            fixed_accuracy=0.345 - math.nextafter(0.01, 1),
            reference_accuracy=0.345,
        )
        with self.assertRaisesRegex(RuntimeError, "accuracy drop"):
            enforce_fixed_point_gates(
                just_above_drop["fixedValidation"],
                just_above_drop["referenceValidation"],
                0.99,
                0.01,
            )

        # The fidelity baseline is frozen before QAT, not taken from a final raw model that degraded in lockstep.
        collapsed = candidate_metrics(agreement=1.0, fixed_accuracy=0.10, reference_accuracy=0.345)
        collapsed["floatValidation"]["top1Accuracy"] = 0.10
        self.assertFalse(qat_candidate_passes(collapsed, 0.99, 0.01))
        with self.assertRaisesRegex(RuntimeError, "accuracy drop"):
            enforce_fixed_point_gates(
                collapsed["fixedValidation"],
                collapsed["referenceValidation"],
                0.99,
                0.01,
            )

    def test_best_qat_selection_and_load_keep_the_earlier_stronger_epoch(self) -> None:
        model = small_model()
        shifts = layer_shifts(model)
        reference = {"top1Accuracy": 0.345, "loss": 3.4}
        early = snapshot_qat_candidate(
            25,
            model,
            shifts,
            {"top1Accuracy": 0.341, "loss": 3.5},
            {
                "top1Accuracy": 0.34,
                "qatFixedTop1Agreement": 0.995,
                "floatFixedTop1Agreement": 0.94,
            },
            reference,
            stage="entry",
        )
        with torch.no_grad():
            next(model.parameters()).add_(0.125)
        later = snapshot_qat_candidate(
            25,
            model,
            shifts,
            {"top1Accuracy": 0.34, "loss": 3.5},
            {
                "top1Accuracy": 0.339,
                "qatFixedTop1Agreement": 1.0,
                "floatFixedTop1Agreement": 0.95,
            },
            reference,
        )
        selected = select_best_qat_candidate(early, later, 0.99, 0.01)
        self.assertIs(selected, early)

        equal_later = dict(early)
        equal_later["stage"] = "epoch"
        equal_later["model"] = later["model"]
        self.assertIs(select_best_qat_candidate(early, equal_later, 0.99, 0.01), early)

        restored_shifts, restored_reference, restored_epoch, restored_stage = load_qat_candidate(
            model,
            selected,
            shifts,
        )
        self.assertEqual(restored_shifts, shifts)
        self.assertEqual(restored_reference, reference)
        self.assertEqual(restored_epoch, 25)
        self.assertEqual(restored_stage, "entry")
        for key, value in model.state_dict().items():
            self.assertTrue(torch.equal(value.cpu(), early["model"][key]), key)
        expected = small_model()
        expected.load_state_dict(early["model"])
        self.assertEqual(export_layers(model, 256, shifts), export_layers(expected, 256, shifts))

    def test_checkpoint_preserves_frozen_grid_reference_and_best_candidate(self) -> None:
        model = small_model()
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        shifts = layer_shifts(model)
        reference = {"top1Accuracy": 0.345, "loss": 3.4}
        fixed = {
            "top1Accuracy": 0.34,
            "qatFixedTop1Agreement": 1.0,
            "floatFixedTop1Agreement": 0.94,
        }
        float_validation = {"top1Accuracy": 0.339, "loss": 3.5}
        best = snapshot_qat_candidate(25, model, shifts, float_validation, fixed, reference)

        history = [{"epoch": 25, "qat": True, "loss": 3.5}]
        with tempfile.TemporaryDirectory(prefix="hoc-v09-quantization-checkpoint-") as directory:
            for next_epoch in (26, 30):
                path = Path(directory) / f"learner-{next_epoch}.pt"
                save_checkpoint(
                    path,
                    next_epoch,
                    0,
                    model,
                    optimizer,
                    {"test": True},
                    history,
                    qat_layer_shifts=shifts,
                    qat_reference_validation=reference,
                    best_qat_candidate=best,
                )
                saved = torch.load(path, map_location="cpu", weights_only=False)
                self.assertEqual(saved["schema"], CHECKPOINT_SCHEMA)
                restored_shifts, restored_reference, restored = restore_qat_checkpoint_state(
                    saved,
                    model,
                    require_frozen_state=True,
                    require_best_candidate=True,
                )
                self.assertEqual(restored_shifts, shifts)
                self.assertEqual(restored_reference, reference)
                self.assertIsNotNone(restored)
                assert restored is not None
                self.assertEqual(restored["epoch"], 25)
                self.assertEqual(restored["referenceValidation"], reference)

                missing_best = dict(saved)
                missing_best["bestQatCandidate"] = None
                with self.assertRaisesRegex(ValueError, "best validated candidate"):
                    restore_qat_checkpoint_state(
                        missing_best,
                        model,
                        require_frozen_state=True,
                        require_best_candidate=True,
                    )

    def test_first_qat_mid_batch_checkpoint_restores_entry_candidate(self) -> None:
        model = small_model()
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        shifts = layer_shifts(model)
        reference = {"top1Accuracy": 0.345, "loss": 3.4}
        entry = snapshot_qat_candidate(
            25,
            model,
            shifts,
            reference,
            {
                "top1Accuracy": 0.34,
                "qatFixedTop1Agreement": 1.0,
                "floatFixedTop1Agreement": 0.94,
            },
            reference,
            stage="entry",
        )
        progress = EpochProgress(
            epoch=25,
            next_batch=1,
            qat_layer_shifts=shifts,
            running_loss=3.5,
            batches=1,
            examples=4,
            active_elapsed_seconds=0.5,
        )
        with tempfile.TemporaryDirectory(prefix="hoc-v09-entry-checkpoint-") as directory:
            path = Path(directory) / "learner.pt"
            save_checkpoint(
                path,
                25,
                1,
                model,
                optimizer,
                {"epochs": 30, "qatEpochs": 5},
                [],
                progress,
                qat_layer_shifts=shifts,
                qat_reference_validation=reference,
                best_qat_candidate=entry,
            )
            saved = torch.load(path, map_location="cpu", weights_only=False)
        restored_shifts, restored_reference, restored = restore_qat_checkpoint_state(
            saved,
            model,
            require_frozen_state=True,
            require_best_candidate=True,
        )
        self.assertEqual(restored_shifts, shifts)
        self.assertEqual(restored_reference, reference)
        self.assertIsNotNone(restored)
        assert restored is not None
        self.assertEqual(restored["stage"], "entry")

        missing_best = dict(saved)
        missing_best["bestQatCandidate"] = None
        with self.assertRaisesRegex(ValueError, "best validated candidate"):
            restore_qat_checkpoint_state(
                missing_best,
                model,
                require_frozen_state=True,
                require_best_candidate=True,
            )

    def test_qat_uses_half_away_weight_ties(self) -> None:
        model = small_model([1])
        linear = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
        with torch.no_grad():
            for parameter in model.parameters():
                parameter.zero_()
            # With frozen shift 6 this is exactly +0.5 and must become +1, not banker's zero.
            linear[0].weight[0, 0] = 1 / 128
            linear[0].weight[0, 1] = 1.0
            linear[1].weight[0, 0] = 1.0
        shifts = (6, 6)
        raw = torch.zeros((1, 2, FEATURE_WIDTH))
        raw[0, 1, 0] = 1.0
        qat_scores = qat_forward(model, raw, 256, shifts)
        fixed_scores = FixedPointRanker(model, 256, torch.device("cpu"), shifts)(raw)
        self.assertEqual(int(fixed_scores[0, 1]), 4)
        self.assertEqual(int(round_half_away_tensor(qat_scores[0, 1] * 256)), 4)


if __name__ == "__main__":
    unittest.main()
