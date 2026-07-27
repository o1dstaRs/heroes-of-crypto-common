#!/usr/bin/env python3
"""Train and export the Heroes of Crypto v0.9 fixed-point candidate ranker.

The game simulation remains authoritative TypeScript running on CPUs. This process consumes immutable
IL-v4 JSONL teacher shards, trains batched PyTorch tensors on the selected GPU, and writes an unpromoted
research artifact. It never edits the committed runtime artifact.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import random
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

import numpy as np
import torch
from torch import Tensor, nn
from torch.utils.data import DataLoader, IterableDataset, get_worker_info

from corpus import descriptor_fingerprint, validate_corpus
from shard_order import (
    TRAINING_SHARD_ORDER_SCHEMA,
    ordered_worker_paths,
    training_epoch_order_sha256,
    training_epoch_seed,
)

IL_SCHEMA = "hoc.ai.v0_9_il.v4"
IL_TYPE = "v09_il_decision"
IL_VERSION = 4
MODEL_SCHEMA = "hoc.ai.v0_9_model.v1"
MODEL_HASH_ALGORITHM = "sha256-canonical-inference-json-v1"
FEATURE_SCHEMA = "hoc.ai.v0_9_features.il_v4.v1"
FEATURE_WIDTH = 166
FULL_FEATURE_SHA256 = "01d5d1fdb32edb31add64201da4d37443f0e8a54379f2f50763da83c1ca3d18e"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
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


def feature_contract(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    names = value.get("inputFeatureNames")
    payload = {"schema": value.get("schema"), "inputFeatureNames": names}
    fingerprint = sha256_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    if (
        value.get("schema") != FEATURE_SCHEMA
        or not isinstance(names, list)
        or len(names) != FEATURE_WIDTH
        or fingerprint != FULL_FEATURE_SHA256
        or value.get("featureSchemaSha256") != fingerprint
    ):
        raise ValueError("feature contract does not match the v0.9 runtime")
    return value


@dataclass(frozen=True)
class Decision:
    features: list[list[float]]
    means: list[float]
    mean_valid: list[bool]
    teacher_index: int
    incumbent_index: int
    weights: list[float]


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
            (mean is not None and (not isinstance(mean, (int, float)) or not math.isfinite(mean)))
            or not isinstance(visits, int)
            or visits < 1
            or (
                stderr is not None
                and (not isinstance(stderr, (int, float)) or not math.isfinite(stderr) or stderr < 0)
            )
        ):
            raise ValueError("invalid IL-v4 teacher observation")
        features.append([float(value) for value in vector])
        means.append(float(mean) if mean is not None else 0.0)
        mean_valid.append(mean is not None)
        # Exact visits are always known. Standard error only tightens confidence when the teacher retained it.
        confidence = math.sqrt(float(visits))
        if stderr is not None:
            confidence /= max(0.02, 1.0 + float(stderr))
        weights.append(confidence)
    if not mean_valid[teacher_index]:
        raise ValueError("teacherIndex points at an engine-rejected candidate")
    return Decision(features, means, mean_valid, teacher_index, 0, weights)


def iter_decisions(paths: Sequence[Path], split: str | None) -> Iterator[Decision]:
    for path in paths:
        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                    decision = decision_from_row(value, split)
                except Exception as error:
                    raise ValueError(f"{path}:{line_number}: {error}") from error
                if decision is not None:
                    yield decision


class DecisionDataset(IterableDataset[Decision]):
    def __init__(self, paths: Sequence[Path], split: str, seed: int):
        super().__init__()
        self.paths = tuple(paths)
        self.split = split
        self.seed = seed

    def __iter__(self) -> Iterator[Decision]:
        worker = get_worker_info()
        # Every worker must stride the same permutation. Per-worker permutations can overlap after striding,
        # duplicating some shards while silently omitting others.
        paths = ordered_worker_paths(
            self.paths,
            self.seed,
            worker.id if worker else 0,
            worker.num_workers if worker else 1,
        )
        yield from iter_decisions(paths, self.split)


@dataclass
class Batch:
    features: Tensor
    means: Tensor
    mean_valid: Tensor
    mask: Tensor
    teacher: Tensor
    confidence: Tensor


def collate(decisions: Sequence[Decision]) -> Batch:
    maximum = max(len(decision.features) for decision in decisions)
    batch = len(decisions)
    # Build each dense buffer once in NumPy. Constructing six tiny torch tensors per decision made the
    # JSONL/collation side dominate a very small MLP and left the 5090 waiting between bursts.
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
    return Batch(
        torch.from_numpy(features),
        torch.from_numpy(means),
        torch.from_numpy(mean_valid),
        torch.from_numpy(mask),
        torch.from_numpy(teacher),
        torch.from_numpy(confidence),
    )


class CandidateRanker(nn.Module):
    def __init__(self, hidden: Sequence[int]):
        super().__init__()
        widths = [FEATURE_WIDTH, *hidden, 1]
        layers: list[nn.Module] = []
        for index, (input_size, output_size) in enumerate(zip(widths, widths[1:])):
            layers.append(nn.Linear(input_size, output_size))
            if index < len(widths) - 2:
                layers.append(nn.ReLU())
        self.network = nn.Sequential(*layers)

    def forward(self, features: Tensor) -> Tensor:
        return self.network(features).squeeze(-1)


class NormalizedRanker(nn.Module):
    def __init__(self, ranker: CandidateRanker, offset: Tensor, scale: Tensor, clip: float):
        super().__init__()
        self.ranker = ranker
        self.register_buffer("offset", offset)
        self.register_buffer("scale", scale)
        self.clip = clip

    def forward(self, raw: Tensor) -> Tensor:
        normalized = ((raw - self.offset) * self.scale).clamp(-self.clip, self.clip)
        return self.ranker(normalized)


def estimate_normalization(paths: Sequence[Path]) -> tuple[Tensor, Tensor, int]:
    count = 0
    mean = torch.zeros(FEATURE_WIDTH, dtype=torch.float64)
    m2 = torch.zeros(FEATURE_WIDTH, dtype=torch.float64)
    for decision in iter_decisions(paths, "train"):
        for values in decision.features:
            vector = torch.tensor(values, dtype=torch.float64)
            count += 1
            delta = vector - mean
            mean += delta / count
            m2 += delta * (vector - mean)
    if count < 2:
        raise ValueError("training corpus has fewer than two candidate observations")
    variance = m2 / (count - 1)
    scale = torch.rsqrt(torch.clamp(variance, min=1e-12))
    # Constant/binary-never-observed features stay numerically inert.
    scale = torch.where(variance < 1e-12, torch.ones_like(scale), scale)
    return mean.float(), scale.float(), count


def ranking_loss(scores: Tensor, batch: Batch) -> Tensor:
    masked_scores = scores.masked_fill(~batch.mask, -torch.inf)
    classification = nn.functional.cross_entropy(masked_scores, batch.teacher)

    teacher_score = scores.gather(1, batch.teacher[:, None]).squeeze(1)
    incumbent_score = scores[:, 0]
    # Search can choose a productive/urgent action lexicographically even when rollout means tie or are slightly
    # lower. Never train the opposite ordering: every explicit teacher override must outrank candidate zero.
    override = batch.teacher != 0
    pairwise = (
        nn.functional.softplus(-(teacher_score[override] - incumbent_score[override])).mean()
        if override.any()
        else classification.new_zeros(())
    )

    temperature = 0.15
    valid_means = batch.mask & batch.mean_valid
    masked_means = (batch.means / temperature).masked_fill(~valid_means, -torch.inf)
    mean_best = masked_means.argmax(dim=1)
    # Mean distillation is valid only when rollout argmax and the priority-aware teacher label agree. Otherwise
    # classification/pairwise preserve the teacher's intentional lexicographic choice.
    distill_rows = mean_best == batch.teacher
    teacher_distribution = torch.softmax(masked_means, dim=1)
    student_log_distribution = torch.log_softmax(masked_scores, dim=1)
    distillation_terms = torch.where(
        valid_means,
        teacher_distribution * student_log_distribution,
        torch.zeros_like(student_log_distribution),
    )
    mask_count = valid_means.sum(dim=1).clamp(min=1)
    confidence = batch.confidence.masked_fill(~valid_means, 0).sum(dim=1) / mask_count
    confidence = confidence.clamp(0.5, 8)
    distillation = (
        (-(distillation_terms.sum(dim=1))[distill_rows] * confidence[distill_rows] / confidence[distill_rows].mean()).mean()
        if distill_rows.any()
        else classification.new_zeros(())
    )
    return classification + 0.5 * pairwise + 0.5 * distillation


def evaluate(model: nn.Module, loader: DataLoader[Decision], device: torch.device, maximum_batches: int) -> dict[str, float]:
    model.eval()
    decisions = 0
    correct = 0
    incumbent_decisions = 0
    incumbent_correct = 0
    override_decisions = 0
    override_correct = 0
    loss_sum = 0.0
    with torch.no_grad():
        for batch_index, batch in enumerate(loader):
            if batch_index >= maximum_batches:
                break
            batch = move_batch(batch, device)
            scores = model(batch.features)
            loss_sum += float(ranking_loss(scores, batch))
            predicted = scores.masked_fill(~batch.mask, -torch.inf).argmax(dim=1)
            matches = predicted == batch.teacher
            decisions += len(predicted)
            correct += int(matches.sum())
            incumbent = batch.teacher == 0
            incumbent_decisions += int(incumbent.sum())
            incumbent_correct += int((matches & incumbent).sum())
            override = ~incumbent
            override_decisions += int(override.sum())
            override_correct += int((matches & override).sum())
    return {
        "decisions": float(decisions),
        "loss": loss_sum / max(1, min(maximum_batches, math.ceil(decisions / max(1, loader.batch_size or 1)))),
        "top1Accuracy": correct / max(1, decisions),
        "incumbentAccuracy": incumbent_correct / max(1, incumbent_decisions),
        "overrideAccuracy": override_correct / max(1, override_decisions),
    }


def move_batch(batch: Batch, device: torch.device) -> Batch:
    return Batch(
        features=batch.features.to(device, non_blocking=True),
        means=batch.means.to(device, non_blocking=True),
        mean_valid=batch.mean_valid.to(device, non_blocking=True),
        mask=batch.mask.to(device, non_blocking=True),
        teacher=batch.teacher.to(device, non_blocking=True),
        confidence=batch.confidence.to(device, non_blocking=True),
    )


def quantized_weight(weight: Tensor) -> tuple[Tensor, int]:
    maximum = float(weight.detach().abs().max())
    shift = 0 if maximum == 0 else max(0, min(24, math.floor(math.log2(127.0 / maximum))))
    return torch.clamp(torch.round(weight.detach() * (2**shift)), -127, 127).to(torch.int8), shift


def round_half_away_tensor(value: Tensor) -> Tensor:
    return torch.sign(value) * torch.floor(torch.abs(value) + 0.5)


def ste_replace(value: Tensor, quantized_value: Tensor) -> Tensor:
    return value + (quantized_value - value).detach()


def round_half_away(value: float) -> int:
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def quantized_layer_parameters(layer: nn.Linear, input_scale: int) -> tuple[Tensor, int, list[int]]:
    weights, shift = quantized_weight(layer.weight)
    while True:
        bias_multiplier = input_scale * (2**shift)
        biases = [round_half_away(float(value) * bias_multiplier) for value in layer.bias.detach().cpu()]
        rows = weights.to(torch.int64).abs().sum(dim=1).cpu().tolist()
        safe = all(
            -(2**31) <= bias <= 2**31 - 1
            and 32767 * int(row_weight_sum) + abs(bias) <= 2**31 - 1
            for bias, row_weight_sum in zip(biases, rows)
        )
        if safe:
            return weights, shift, biases
        if shift == 0:
            raise OverflowError("quantized layer can overflow the signed int32 accumulator")
        shift -= 1
        weights = torch.clamp(torch.round(layer.weight.detach() * (2**shift)), -127, 127).to(torch.int8)


def qat_forward(
    model: NormalizedRanker,
    raw: Tensor,
    input_scale: int,
    layer_shifts: Sequence[int],
) -> Tensor:
    normalized = ((raw - model.offset) * model.scale).clamp(-model.clip, model.clip)
    input_integer = round_half_away_tensor(normalized * input_scale).clamp(-32767, 32767)
    value = ste_replace(normalized, input_integer / input_scale)
    linear_layers = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
    if len(layer_shifts) != len(linear_layers):
        raise ValueError("QAT layer-shift schedule does not match the dense network")
    for index, (layer, shift) in enumerate(zip(linear_layers, layer_shifts)):
        # Keep fake quantization on-device. Exact int32 overflow analysis and Python-list export happen once per
        # epoch/final artifact, never in the hot batch loop.
        weight_integer = round_half_away_tensor(layer.weight * (2**shift)).clamp(-127, 127)
        restored_weight = weight_integer / (2**shift)
        bias_integer = round_half_away_tensor(layer.bias * (input_scale * (2**shift)))
        restored_bias = bias_integer / (input_scale * (2**shift))
        value = nn.functional.linear(
            value,
            ste_replace(layer.weight, restored_weight),
            ste_replace(layer.bias, restored_bias),
        )
        value_integer = round_half_away_tensor(value * input_scale)
        if index < len(linear_layers) - 1:
            value_integer = value_integer.clamp(0, 32767)
        else:
            value_integer = value_integer.clamp(-(2**31), 2**31 - 1)
        value = ste_replace(value, value_integer / input_scale)
    return value.squeeze(-1)


def export_layers(model: NormalizedRanker, input_scale: int) -> list[dict[str, Any]]:
    layers: list[dict[str, Any]] = []
    linear_layers = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
    for index, layer in enumerate(linear_layers):
        weights, shift, biases = quantized_layer_parameters(layer, input_scale)
        layers.append(
            {
                "inputSize": layer.in_features,
                "outputSize": layer.out_features,
                "activation": "linear" if index == len(linear_layers) - 1 else "relu",
                "scaleShift": shift,
                "weights": weights.cpu().reshape(-1).tolist(),
                "biases": biases,
            }
        )
    return layers


class FixedPointRanker:
    """Vectorized reference for the exact integer operations used by scoreV09FixedPoint."""

    def __init__(self, model: NormalizedRanker, input_scale: int, device: torch.device):
        self.offset = model.offset.detach().to(device=device, dtype=torch.float64)
        self.scale = model.scale.detach().to(device=device, dtype=torch.float64)
        self.clip = model.clip
        self.input_scale = input_scale
        self.layers: list[tuple[Tensor, int, Tensor, bool]] = []
        linear_layers = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
        for index, layer in enumerate(linear_layers):
            weights, shift, biases = quantized_layer_parameters(layer, input_scale)
            self.layers.append(
                (
                    weights.to(device=device, dtype=torch.int64),
                    shift,
                    torch.tensor(biases, device=device, dtype=torch.int64),
                    index < len(linear_layers) - 1,
                )
            )

    @staticmethod
    def _divide_half_away(value: Tensor, shift: int) -> Tensor:
        if shift == 0:
            return value
        divisor = 2**shift
        return torch.sign(value) * ((torch.abs(value) + divisor // 2) // divisor)

    def __call__(self, raw: Tensor) -> Tensor:
        normalized = ((raw.to(torch.float64) - self.offset) * self.scale).clamp(-self.clip, self.clip)
        value = round_half_away_tensor(normalized * self.input_scale).clamp(-32767, 32767).to(torch.int64)
        for weights, shift, biases, relu in self.layers:
            accumulator = torch.matmul(value, weights.transpose(0, 1)) + biases
            value = self._divide_half_away(accumulator, shift)
            if relu:
                value = value.clamp(0, 32767)
            else:
                value = value.clamp(-(2**31), 2**31 - 1)
        return value.squeeze(-1)


def evaluate_fixed(
    model: NormalizedRanker,
    loader: DataLoader[Decision],
    device: torch.device,
    input_scale: int,
    maximum_batches: int,
) -> dict[str, float]:
    model.eval()
    fixed = FixedPointRanker(model, input_scale, device)
    decisions = 0
    teacher_correct = 0
    float_fixed_agreement = 0
    with torch.no_grad():
        for batch_index, batch in enumerate(loader):
            if batch_index >= maximum_batches:
                break
            batch = move_batch(batch, device)
            float_scores = model(batch.features).masked_fill(~batch.mask, -torch.inf)
            fixed_scores = fixed(batch.features).masked_fill(~batch.mask, -(2**63))
            float_choice = float_scores.argmax(dim=1)
            fixed_choice = fixed_scores.argmax(dim=1)
            decisions += len(fixed_choice)
            teacher_correct += int((fixed_choice == batch.teacher).sum())
            float_fixed_agreement += int((fixed_choice == float_choice).sum())
    return {
        "decisions": float(decisions),
        "top1Accuracy": teacher_correct / max(1, decisions),
        "floatFixedTop1Agreement": float_fixed_agreement / max(1, decisions),
    }


def build_research_artifact(
    model: NormalizedRanker,
    contract: dict[str, Any],
    campaign: dict[str, Any],
    hidden: Sequence[int],
    input_scale: int,
    input_clip: float,
    min_override_margin: float,
    metrics: dict[str, Any],
) -> dict[str, Any]:
    layers = export_layers(model, input_scale)
    normalization = {
        "offsets": [float(value) for value in model.offset.cpu()],
        "scales": [float(value) for value in model.scale.cpu()],
    }
    fixed_point = {
        "inputScale": input_scale,
        "inputClip": input_clip,
        "weightDtype": "int8",
        "biasDtype": "int32",
        "activationDtype": "int16",
        "accumulatorDtype": "int32",
        "rounding": "half_away_from_zero",
        "saturation": "symmetric_int16",
    }
    integer_margin = max(1, round_half_away(min_override_margin * input_scale))
    identity = campaign["identity"]
    return {
        "schema": MODEL_SCHEMA,
        "status": "trained",
        "promoted": False,
        "qualification": None,
        "modelId": "v0.9-research-unsealed",
        "modelSha256": None,
        "hashAlgorithm": MODEL_HASH_ALGORITHM,
        "source": {
            "commonCommit": identity["sourceCommit"],
            "rulesSha256": identity["rulesFingerprint"],
            "rosterSha256": identity["rosterFingerprint"],
            "trainingRunId": campaign["runFingerprint"],
        },
        "features": {
            "schema": FEATURE_SCHEMA,
            "schemaSha256": FULL_FEATURE_SHA256,
            "inputFeatureNames": contract["inputFeatureNames"],
            "blocks": [
                {"name": "state", "offset": 0, "length": 60},
                {"name": "candidate", "offset": 60, "length": 11},
                {"name": "action", "offset": 71, "length": 50},
                {"name": "rich", "offset": 121, "length": 45},
            ],
        },
        "normalization": normalization,
        "architecture": {
            "kind": "dense_candidate_ranker",
            "inputSize": FEATURE_WIDTH,
            "hiddenSizes": list(hidden),
            "outputSize": 1,
        },
        "fixedPoint": fixed_point,
        "minOverrideMargin": integer_margin,
        "layers": layers,
        "notes":
            "UNPROMOTED RTX 5090 research artifact. Runtime activation requires independent qualification "
            f"and a reviewed promoted=true transition. Validation top-1={metrics['finalValidation']['top1Accuracy']:.6f}.",
    }


def save_checkpoint(
    path: Path,
    next_epoch: int,
    next_batch: int,
    model: NormalizedRanker,
    optimizer: torch.optim.Optimizer,
    config: dict[str, Any],
    history: list[dict[str, Any]],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    torch.save(
        {
            "nextEpoch": next_epoch,
            "nextBatch": next_batch,
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "config": config,
            "history": history,
            "pythonRandomState": random.getstate(),
            "torchRandomState": torch.random.get_rng_state(),
            "cudaRandomState": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
        },
        temporary,
    )
    os.replace(temporary, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", action="append", required=True, help="JSONL path/glob; repeatable")
    parser.add_argument("--feature-contract", type=Path, required=True)
    parser.add_argument("--campaign-manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--qat-epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--hidden", default="64,32")
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-5)
    parser.add_argument("--seed", type=int, default=9005090)
    parser.add_argument("--input-clip", type=float, default=8.0)
    parser.add_argument("--input-scale", type=int, default=256)
    parser.add_argument("--min-override-margin", type=float, default=0.05)
    parser.add_argument("--validation-batches", type=int, default=512)
    parser.add_argument("--checkpoint-seconds", type=int, default=600)
    parser.add_argument("--amp", choices=("bf16", "off"), default="bf16")
    parser.add_argument("--minimum-fixed-agreement", type=float, default=0.99)
    parser.add_argument("--maximum-fixed-accuracy-drop", type=float, default=0.01)
    parser.add_argument(
        "--allow-partial-corpus",
        action="store_true",
        help="Development smoke only: permit a deterministic prefix instead of exact stream coverage.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.epochs < 1 or args.qat_epochs < 0 or args.qat_epochs > args.epochs:
        raise ValueError("epochs must be positive and qat-epochs must be in [0, epochs]")
    if args.input_scale < 1 or args.input_scale > 32767:
        raise ValueError("input-scale must fit the runtime int16 contract")
    hidden = [int(value) for value in args.hidden.split(",") if value]
    if not hidden or any(value < 1 for value in hidden):
        raise ValueError("hidden must contain positive comma-separated widths")

    contract_path = args.feature_contract.resolve()
    manifest_path = args.campaign_manifest.resolve()
    contract = feature_contract(contract_path)
    campaign, paths, descriptors = validate_corpus(
        args.data,
        manifest_path,
        allow_partial=args.allow_partial_corpus,
    )

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA learner requested but PyTorch cannot see a CUDA device")

    offset, scale, observations = estimate_normalization(paths)
    model = NormalizedRanker(CandidateRanker(hidden), offset, scale, args.input_clip).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    checkpoint = args.checkpoint or args.out.with_suffix(".checkpoint.pt")
    config = {
        "featureSchemaSha256": FULL_FEATURE_SHA256,
        "runFingerprint": campaign["runFingerprint"],
        "manifestSha256": campaign["manifestSha256"],
        "featureContractSha256": hashlib.sha256(contract_path.read_bytes()).hexdigest(),
        "corpusSha256": descriptor_fingerprint(descriptors),
        "shards": [asdict(descriptor) for descriptor in descriptors],
        "hidden": hidden,
        "seed": args.seed,
        "epochs": args.epochs,
        "qatEpochs": args.qat_epochs,
        "batchSize": args.batch_size,
        "workers": args.workers,
        "learningRate": args.learning_rate,
        "weightDecay": args.weight_decay,
        "inputClip": args.input_clip,
        "inputScale": args.input_scale,
        "minimumOverrideMargin": args.min_override_margin,
        "validationBatches": args.validation_batches,
        "minimumFixedAgreement": args.minimum_fixed_agreement,
        "maximumFixedAccuracyDrop": args.maximum_fixed_accuracy_drop,
        "allowPartialCorpus": args.allow_partial_corpus,
        "trainingShardOrderSchema": TRAINING_SHARD_ORDER_SCHEMA,
        "amp": args.amp,
        "device": str(device),
        "torchVersion": torch.__version__,
        "cudaVersion": torch.version.cuda,
        "cudaDevice": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        "cudaCapability": list(torch.cuda.get_device_capability(device)) if device.type == "cuda" else None,
    }
    first_epoch = 0
    resume_batch = 0
    history: list[dict[str, Any]] = []
    if args.resume:
        saved = torch.load(checkpoint, map_location=device, weights_only=False)
        if saved.get("config") != config:
            raise ValueError("checkpoint configuration does not match this training run")
        model.load_state_dict(saved["model"])
        optimizer.load_state_dict(saved["optimizer"])
        first_epoch = int(saved["nextEpoch"])
        resume_batch = int(saved["nextBatch"])
        history = list(saved.get("history", []))
        random.setstate(saved["pythonRandomState"])
        torch.random.set_rng_state(saved["torchRandomState"])
        if torch.cuda.is_available() and saved["cudaRandomState"]:
            torch.cuda.set_rng_state_all(saved["cudaRandomState"])

    validation = DataLoader(
        DecisionDataset(paths, "validation", args.seed + 1),
        batch_size=args.batch_size,
        num_workers=args.workers,
        collate_fn=collate,
        pin_memory=device.type == "cuda",
        persistent_workers=args.workers > 0,
        prefetch_factor=4 if args.workers > 0 else None,
    )

    last_checkpoint = time.monotonic()
    for epoch in range(first_epoch, args.epochs):
        epoch_seed = training_epoch_seed(args.seed, epoch)
        loader_generator = torch.Generator()
        loader_generator.manual_seed(epoch_seed)
        # Rebuild the loader so every epoch receives a different domain-separated shard permutation. The epoch
        # and base seed fully determine that permutation, so a mid-epoch resume recreates it before skipping the
        # checkpointed batch cursor. A dedicated generator keeps worker initialization from perturbing the model
        # RNG when that loader is reconstructed during resume.
        training = DataLoader(
            DecisionDataset(paths, "train", epoch_seed),
            batch_size=args.batch_size,
            num_workers=args.workers,
            collate_fn=collate,
            pin_memory=device.type == "cuda",
            persistent_workers=False,
            prefetch_factor=4 if args.workers > 0 else None,
            generator=loader_generator,
        )
        model.train()
        running_loss = 0.0
        batches = 0
        examples = 0
        epoch_started = time.monotonic()
        if device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(device)
        qat = epoch >= args.epochs - args.qat_epochs
        qat_layer_shifts = (
            [
                quantized_layer_parameters(layer, args.input_scale)[1]
                for layer in model.ranker.network
                if isinstance(layer, nn.Linear)
            ]
            if qat
            else []
        )
        for batch_index, batch in enumerate(training):
            if epoch == first_epoch and batch_index < resume_batch:
                continue
            batch = move_batch(batch, device)
            optimizer.zero_grad(set_to_none=True)
            autocast = (
                torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                if device.type == "cuda" and args.amp == "bf16"
                else contextlib.nullcontext()
            )
            with autocast:
                scores = (
                    qat_forward(model, batch.features, args.input_scale, qat_layer_shifts)
                    if qat
                    else model(batch.features)
                )
                loss = ranking_loss(scores, batch)
            if not torch.isfinite(loss):
                raise RuntimeError(f"non-finite training loss at epoch {epoch}, batch {batch_index}")
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            running_loss += float(loss.detach())
            batches += 1
            examples += batch.features.shape[0]
            if time.monotonic() - last_checkpoint >= args.checkpoint_seconds:
                save_checkpoint(checkpoint, epoch, batch_index + 1, model, optimizer, config, history)
                last_checkpoint = time.monotonic()
        training_elapsed = time.monotonic() - epoch_started
        metrics = evaluate(model, validation, device, args.validation_batches)
        metrics.update(
            {
                "epoch": epoch,
                "qat": qat,
                "trainingLoss": running_loss / max(1, batches),
                "trainingBatches": batches,
                "trainingExamples": examples,
                "trainingElapsedSeconds": training_elapsed,
                "examplesPerSecond": examples / max(1e-9, training_elapsed),
                "gpuPeakMemoryGiB":
                    torch.cuda.max_memory_allocated(device) / (1024**3) if device.type == "cuda" else 0,
                "amp": args.amp if device.type == "cuda" else "off",
                "trainingShardEpochSeed": epoch_seed,
                "trainingShardOrderSha256": training_epoch_order_sha256(paths, args.seed, epoch),
            }
        )
        history.append(metrics)
        print(json.dumps(metrics, sort_keys=True), flush=True)
        save_checkpoint(checkpoint, epoch + 1, 0, model, optimizer, config, history)
        resume_batch = 0

    final_validation = evaluate(model, validation, device, args.validation_batches)
    fixed_validation = evaluate_fixed(model, validation, device, args.input_scale, args.validation_batches)
    if fixed_validation["floatFixedTop1Agreement"] < args.minimum_fixed_agreement:
        raise RuntimeError(
            "fixed-point top-1 agreement "
            f"{fixed_validation['floatFixedTop1Agreement']:.6f} is below {args.minimum_fixed_agreement:.6f}"
        )
    if final_validation["top1Accuracy"] - fixed_validation["top1Accuracy"] > args.maximum_fixed_accuracy_drop:
        raise RuntimeError(
            "fixed-point validation accuracy drop "
            f"{final_validation['top1Accuracy'] - fixed_validation['top1Accuracy']:.6f} exceeds "
            f"{args.maximum_fixed_accuracy_drop:.6f}"
        )
    final_metrics = {
        "normalizationObservations": observations,
        "corpusSha256": config["corpusSha256"],
        "hardware": {
            "device": config["device"],
            "torchVersion": config["torchVersion"],
            "cudaVersion": config["cudaVersion"],
            "cudaDevice": config["cudaDevice"],
            "cudaCapability": config["cudaCapability"],
        },
        "history": history,
        "finalValidation": final_validation,
        "fixedValidation": fixed_validation,
    }
    artifact = build_research_artifact(
        model,
        contract,
        campaign,
        hidden,
        args.input_scale,
        args.input_clip,
        args.min_override_margin,
        final_metrics,
    )
    staging_artifact = args.out.with_suffix(".unsealed.json").resolve()
    atomic_json(staging_artifact, artifact)
    sealer = Path(__file__).resolve().parents[1] / "seal_artifact.ts"
    subprocess.run(
        ["bun", str(sealer), "--input", str(staging_artifact), "--output", str(args.out.resolve())],
        check=True,
    )
    sealed = json.loads(args.out.resolve().read_text(encoding="utf-8"))
    atomic_json(args.out.with_suffix(".metrics.json").resolve(), final_metrics)
    staging_artifact.unlink()
    print(json.dumps({"artifact": str(args.out.resolve()), "modelSha256": sealed["modelSha256"]}, sort_keys=True))


if __name__ == "__main__":
    main()
