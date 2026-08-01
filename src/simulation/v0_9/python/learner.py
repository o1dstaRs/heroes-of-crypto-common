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
import multiprocessing
import os
import random
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator, Sequence

import torch
from torch import Tensor, nn
from torch.utils.data import DataLoader, IterableDataset, get_worker_info

from corpus import descriptor_fingerprint, validate_corpus
from learner_input import (
    NORMALIZATION_CACHE_SCHEMA,
    NormalizationCache,
    eligible_in_order,
    normalization_cache_path,
    read_normalization_cache,
    split_eligible_paths,
    write_normalization_cache,
)
from learner_receipt import LEARNER_REJECTION_SCHEMA, seal_learner_rejection
from packed_input import (
    FEATURE_WIDTH,
    FULL_FEATURE_SHA256,
    PACKED_CACHE_SCHEMA,
    Decision,
    PackedCache,
    PackedDecisionStore,
    collate_numpy,
    iter_json_decisions,
    load_or_build_packed_cache,
)
from shard_order import (
    TRAINING_SHARD_ORDER_SCHEMA,
    ordered_worker_paths,
    training_epoch_order_sha256,
    training_epoch_seed,
)

MODEL_SCHEMA = "hoc.ai.v0_9_model.v1"
MODEL_HASH_ALGORITHM = "sha256-canonical-inference-json-v1"
FEATURE_SCHEMA = "hoc.ai.v0_9_features.il_v4.v1"
EPOCH_PROGRESS_SCHEMA = "hoc.ai.v0_9_learner_epoch_progress.v1"
CHECKPOINT_SCHEMA = "hoc.ai.v0_9_learner_checkpoint.v2"
QAT_CANDIDATE_SCHEMA = "hoc.ai.v0_9_qat_candidate.v1"
QUANTIZATION_SEMANTICS = "fp32-frozen-shift-half-away-v1"


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


class DecisionDataset(IterableDataset[Decision]):
    def __init__(
        self,
        paths: Sequence[Path],
        split: str,
        seed: int | Any,
        eligible_paths: frozenset[Path],
        packed_cache: PackedCache,
    ):
        super().__init__()
        self.paths = tuple(paths)
        self.split = split
        self.seed = seed
        self.eligible_paths = eligible_paths
        self.packed_cache = packed_cache

    def __iter__(self) -> Iterator[Decision]:
        worker = get_worker_info()
        # Training keeps its loader workers alive across epochs so the pinned-memory pipeline and packed mmap
        # stay hot. A synchronized value carries the immutable epoch seed into those existing processes before
        # each fresh iterator starts; validation simply receives a plain integer. Reading it once makes one
        # iterator internally consistent even if its parent has already prepared the next epoch.
        seed = int(self.seed.value) if hasattr(self.seed, "value") else int(self.seed)
        # Every worker must stride the same permutation. Per-worker permutations can overlap after striding,
        # duplicating some shards while silently omitting others.
        paths = ordered_worker_paths(
            self.paths,
            seed,
            worker.id if worker else 0,
            worker.num_workers if worker else 1,
        )
        # Filter only after reproducing the old full-corpus permutation and worker stride. This avoids touching
        # the opposite split while preserving every selected shard's exact epoch order and worker assignment.
        path_indices = {path: index for index, path in enumerate(self.paths)}
        store = PackedDecisionStore(self.packed_cache)
        # Do not explicitly close here: an incomplete final DataLoader batch can exhaust this generator before
        # collate consumes its already-yielded mmap slices. Their NumPy owners release the mapping after collation.
        for path in eligible_in_order(paths, self.eligible_paths):
            yield from store.iter_shard(path_indices[path])


@dataclass
class Batch:
    features: Tensor
    means: Tensor
    mean_valid: Tensor
    mask: Tensor
    teacher: Tensor
    confidence: Tensor


@dataclass(frozen=True)
class EpochProgress:
    epoch: int
    next_batch: int
    qat_layer_shifts: tuple[int, ...]
    running_loss: float
    batches: int
    examples: int
    active_elapsed_seconds: float


def collate(decisions: Sequence[Decision]) -> Batch:
    # Build each dense buffer once in NumPy. Constructing six tiny torch tensors per decision made the
    # JSONL/collation side dominate a very small MLP and left the 5090 waiting between bursts.
    batch = collate_numpy(decisions)
    return Batch(
        torch.from_numpy(batch.features),
        torch.from_numpy(batch.means),
        torch.from_numpy(batch.mean_valid),
        torch.from_numpy(batch.mask),
        torch.from_numpy(batch.teacher),
        torch.from_numpy(batch.confidence),
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


class NormalizationAccumulator:
    """Exact source-order Welford accumulator used by both JSON fallback and cache construction."""

    def __init__(self) -> None:
        self.count = 0
        self.mean = torch.zeros(FEATURE_WIDTH, dtype=torch.float64)
        self.m2 = torch.zeros(FEATURE_WIDTH, dtype=torch.float64)

    def observe(self, decision: Decision) -> None:
        for values in decision.features:
            vector = torch.tensor(values, dtype=torch.float64)
            self.count += 1
            delta = vector - self.mean
            self.mean += delta / self.count
            self.m2 += delta * (vector - self.mean)

    def finish(self) -> tuple[Tensor, Tensor, int]:
        if self.count < 2:
            raise ValueError("training corpus has fewer than two candidate observations")
        variance = self.m2 / (self.count - 1)
        scale = torch.rsqrt(torch.clamp(variance, min=1e-12))
        # Constant/binary-never-observed features stay numerically inert.
        scale = torch.where(variance < 1e-12, torch.ones_like(scale), scale)
        return self.mean.float(), scale.float(), self.count


def estimate_normalization(
    paths: Sequence[Path],
    eligible_paths: frozenset[Path],
    expected_file_sha256: dict[Path, str],
) -> tuple[Tensor, Tensor, int]:
    accumulator = NormalizationAccumulator()
    for decision in iter_json_decisions(
        eligible_in_order(paths, eligible_paths),
        "train",
        expected_file_sha256,
    ):
        accumulator.observe(decision)
    return accumulator.finish()


def prepare_input_caches(
    paths: Sequence[Path],
    descriptors: Sequence[Any],
    eligible_paths: dict[str, frozenset[Path]],
    campaign: dict[str, Any],
    corpus_sha256: str,
    campaign_directory: Path,
) -> tuple[Tensor, Tensor, int, NormalizationCache, PackedCache]:
    cache_arguments = {
        "run_fingerprint": campaign["runFingerprint"],
        "source_commit": campaign["identity"]["sourceCommit"],
        "corpus_sha256": corpus_sha256,
        "feature_schema_sha256": FULL_FEATURE_SHA256,
        "feature_width": FEATURE_WIDTH,
    }
    cache_path = normalization_cache_path(
        campaign_directory,
        run_fingerprint=cache_arguments["run_fingerprint"],
        source_commit=cache_arguments["source_commit"],
        corpus_sha256=cache_arguments["corpus_sha256"],
        feature_schema_sha256=cache_arguments["feature_schema_sha256"],
    )
    normalization_cache: NormalizationCache | None = None
    if cache_path.exists():
        normalization_cache = read_normalization_cache(cache_path, **cache_arguments)

    expected_file_sha256 = {
        Path(descriptor.path).resolve(): descriptor.fileSha256 for descriptor in descriptors
    }
    accumulator = NormalizationAccumulator() if normalization_cache is None else None
    packed_cache, packed_built = load_or_build_packed_cache(
        paths,
        descriptors,
        campaign_directory,
        run_fingerprint=cache_arguments["run_fingerprint"],
        source_commit=cache_arguments["source_commit"],
        corpus_sha256=cache_arguments["corpus_sha256"],
        feature_schema_sha256=cache_arguments["feature_schema_sha256"],
        observer=(
            lambda decision, split: accumulator.observe(decision)
            if accumulator is not None and split == "train"
            else None
        )
    )
    if normalization_cache is None:
        offset, scale, observations = (
            accumulator.finish()
            if packed_built and accumulator is not None
            else estimate_normalization(
                paths,
                eligible_paths["train"],
                expected_file_sha256,
            )
        )
        normalization_cache = write_normalization_cache(
            cache_path,
            run_fingerprint=cache_arguments["run_fingerprint"],
            source_commit=cache_arguments["source_commit"],
            corpus_sha256=cache_arguments["corpus_sha256"],
            feature_schema_sha256=cache_arguments["feature_schema_sha256"],
            offsets=[float(value) for value in offset],
            scales=[float(value) for value in scale],
            observations=observations,
        )
    else:
        offset = torch.tensor(normalization_cache.offsets, dtype=torch.float32)
        scale = torch.tensor(normalization_cache.scales, dtype=torch.float32)
        observations = normalization_cache.observations
    return offset, scale, observations, normalization_cache, packed_cache


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


def round_half_away_tensor(value: Tensor) -> Tensor:
    return torch.sign(value) * torch.floor(torch.abs(value) + 0.5)


def ste_replace(value: Tensor, quantized_value: Tensor) -> Tensor:
    return value + (quantized_value - value).detach()


def round_half_away(value: float) -> int:
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def quantized_weight(weight: Tensor, shift: int | None = None) -> tuple[Tensor, int]:
    detached = weight.detach().to(device="cpu", dtype=torch.float64)
    if not bool(torch.isfinite(detached).all()):
        raise ValueError("quantized weight contains a non-finite value")
    if shift is None:
        maximum = float(detached.abs().max())
        shift = 0 if maximum == 0 else max(0, min(24, math.floor(math.log2(127.0 / maximum))))
    if type(shift) is not int or shift < 0 or shift > 24:
        raise ValueError("quantized weight shift must be an integer in [0, 24]")
    quantized = round_half_away_tensor(detached * (2**shift)).clamp(-127, 127).to(torch.int8)
    return quantized, shift


def quantized_layer_parameters(
    layer: nn.Linear,
    input_scale: int,
    frozen_shift: int | None = None,
) -> tuple[Tensor, int, list[int]]:
    weights, shift = quantized_weight(layer.weight, frozen_shift)
    while True:
        bias_multiplier = input_scale * (2**shift)
        bias_values = layer.bias.detach().to(device="cpu", dtype=torch.float64)
        if not bool(torch.isfinite(bias_values).all()):
            raise ValueError("quantized bias contains a non-finite value")
        biases = [round_half_away(float(value) * bias_multiplier) for value in bias_values]
        rows = weights.to(torch.int64).abs().sum(dim=1).cpu().tolist()
        safe = all(
            -(2**31) <= bias <= 2**31 - 1
            and 32767 * int(row_weight_sum) + abs(bias) <= 2**31 - 1
            for bias, row_weight_sum in zip(biases, rows)
        )
        if safe:
            return weights, shift, biases
        if frozen_shift is not None:
            raise OverflowError("frozen quantized layer shift can overflow the signed int32 accumulator")
        if shift == 0:
            raise OverflowError("quantized layer can overflow the signed int32 accumulator")
        shift -= 1
        weights, _ = quantized_weight(layer.weight, shift)


def qat_forward(
    model: NormalizedRanker,
    raw: Tensor,
    input_scale: int,
    layer_shifts: Sequence[int],
) -> Tensor:
    # Fake-quantized matrix products model the exact integer runtime. BF16 changes enough accumulated values to
    # train a materially different function, so QAT must remain FP32 even when its caller enables AMP.
    autocast = (
        torch.autocast(device_type=raw.device.type, enabled=False)
        if raw.device.type in {"cpu", "cuda"}
        else contextlib.nullcontext()
    )
    with autocast:
        normalized = ((raw.float() - model.offset.float()) * model.scale.float()).clamp(
            -model.clip,
            model.clip,
        )
        input_integer = round_half_away_tensor(normalized * input_scale).clamp(-32767, 32767)
        value = ste_replace(normalized, input_integer / input_scale)
        linear_layers = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
        if len(layer_shifts) != len(linear_layers):
            raise ValueError("QAT layer-shift schedule does not match the dense network")
        for index, (layer, shift) in enumerate(zip(linear_layers, layer_shifts)):
            # Keep fake quantization on-device. Exact int32 overflow analysis and Python-list export happen once
            # per validation/artifact, never in the hot batch loop.
            weight = layer.weight.float()
            bias = layer.bias.float()
            weight_integer = round_half_away_tensor(weight * (2**shift)).clamp(-127, 127)
            restored_weight = weight_integer / (2**shift)
            bias_integer = round_half_away_tensor(bias * (input_scale * (2**shift)))
            restored_bias = bias_integer / (input_scale * (2**shift))
            value = nn.functional.linear(
                value,
                ste_replace(weight, restored_weight),
                ste_replace(bias, restored_bias),
            )
            value_integer = round_half_away_tensor(value * input_scale)
            if index < len(linear_layers) - 1:
                value_integer = value_integer.clamp(0, 32767)
            else:
                value_integer = value_integer.clamp(-(2**31), 2**31 - 1)
            value = ste_replace(value, value_integer / input_scale)
        return value.squeeze(-1)


def training_forward_loss(
    model: NormalizedRanker,
    batch: Batch,
    input_scale: int,
    layer_shifts: Sequence[int],
    qat: bool,
    amp: str,
) -> tuple[Tensor, Tensor]:
    device_type = batch.features.device.type
    autocast = (
        torch.autocast(device_type=device_type, enabled=False)
        if qat and device_type in {"cpu", "cuda"}
        else (
            torch.autocast(device_type="cuda", dtype=torch.bfloat16)
            if device_type == "cuda" and amp == "bf16"
            else contextlib.nullcontext()
        )
    )
    with autocast:
        scores = (
            qat_forward(model, batch.features, input_scale, layer_shifts)
            if qat
            else model(batch.features)
        )
        return scores, ranking_loss(scores, batch)


def export_layers(
    model: NormalizedRanker,
    input_scale: int,
    layer_shifts: Sequence[int] | None = None,
) -> list[dict[str, Any]]:
    layers: list[dict[str, Any]] = []
    linear_layers = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
    if layer_shifts is not None and len(layer_shifts) != len(linear_layers):
        raise ValueError("export layer-shift schedule does not match the dense network")
    for index, layer in enumerate(linear_layers):
        weights, shift, biases = quantized_layer_parameters(
            layer,
            input_scale,
            None if layer_shifts is None else layer_shifts[index],
        )
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

    def __init__(
        self,
        model: NormalizedRanker,
        input_scale: int,
        device: torch.device,
        layer_shifts: Sequence[int] | None = None,
    ):
        self.offset = model.offset.detach().to(device=device, dtype=torch.float64)
        self.scale = model.scale.detach().to(device=device, dtype=torch.float64)
        self.clip = model.clip
        self.input_scale = input_scale
        self.layers: list[tuple[Tensor, int, Tensor, bool]] = []
        linear_layers = [layer for layer in model.ranker.network if isinstance(layer, nn.Linear)]
        if layer_shifts is not None and len(layer_shifts) != len(linear_layers):
            raise ValueError("fixed-point layer-shift schedule does not match the dense network")
        for index, layer in enumerate(linear_layers):
            weights, shift, biases = quantized_layer_parameters(
                layer,
                input_scale,
                None if layer_shifts is None else layer_shifts[index],
            )
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
    layer_shifts: Sequence[int],
) -> dict[str, float]:
    model.eval()
    # The deployable ranker is an integer CPU runtime. CUDA does not implement signed-int64 matrix
    # multiplication, and evaluating there would not exercise the production execution domain anyway.
    fixed_device = torch.device("cpu")
    fixed = FixedPointRanker(model, input_scale, fixed_device, layer_shifts)
    decisions = 0
    teacher_correct = 0
    float_fixed_agreement = 0
    qat_fixed_agreement = 0
    score_values = 0
    exact_score_values = 0
    maximum_score_delta = 0
    with torch.no_grad():
        for batch_index, batch in enumerate(loader):
            if batch_index >= maximum_batches:
                break
            model_batch = move_batch(batch, device)
            float_scores = model(model_batch.features).masked_fill(~model_batch.mask, -torch.inf)
            unmasked_qat_scores = qat_forward(
                model,
                model_batch.features,
                input_scale,
                layer_shifts,
            )
            qat_scores = unmasked_qat_scores.masked_fill(~model_batch.mask, -torch.inf)
            fixed_scores = fixed(batch.features).masked_fill(~batch.mask, -(2**63))
            float_choice = float_scores.argmax(dim=1).to(fixed_device)
            qat_choice = qat_scores.argmax(dim=1).to(fixed_device)
            fixed_choice = fixed_scores.argmax(dim=1)
            decisions += len(fixed_choice)
            teacher_correct += int((fixed_choice == batch.teacher).sum())
            float_fixed_agreement += int((fixed_choice == float_choice).sum())
            qat_fixed_agreement += int((fixed_choice == qat_choice).sum())
            qat_integer_scores = round_half_away_tensor(
                unmasked_qat_scores.to(fixed_device) * input_scale
            ).to(torch.int64)
            valid_delta = (qat_integer_scores[batch.mask] - fixed_scores[batch.mask]).abs()
            score_values += valid_delta.numel()
            exact_score_values += int((valid_delta == 0).sum())
            if valid_delta.numel():
                maximum_score_delta = max(maximum_score_delta, int(valid_delta.max()))
    return {
        "decisions": float(decisions),
        "top1Accuracy": teacher_correct / max(1, decisions),
        "floatFixedTop1Agreement": float_fixed_agreement / max(1, decisions),
        "qatFixedTop1Agreement": qat_fixed_agreement / max(1, decisions),
        "qatFixedScoreAgreement": exact_score_values / max(1, score_values),
        "qatFixedMaximumScoreDelta": float(maximum_score_delta),
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
    layer_shifts: Sequence[int],
) -> dict[str, Any]:
    layers = export_layers(model, input_scale, layer_shifts)
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


def _epoch_progress_payload(progress: EpochProgress) -> dict[str, Any]:
    return {
        "schema": EPOCH_PROGRESS_SCHEMA,
        "epoch": progress.epoch,
        "nextBatch": progress.next_batch,
        "qatLayerShifts": list(progress.qat_layer_shifts),
        "runningLoss": progress.running_loss,
        "batches": progress.batches,
        "examples": progress.examples,
        "activeElapsedSeconds": progress.active_elapsed_seconds,
    }


def restore_epoch_progress(
    value: Any,
    *,
    next_epoch: int,
    next_batch: int,
    expected_qat_layer_count: int,
) -> EpochProgress | None:
    if next_batch == 0:
        if value is not None:
            raise ValueError("epoch-boundary checkpoint must not retain in-progress epoch state")
        return None
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schema",
            "epoch",
            "nextBatch",
            "qatLayerShifts",
            "runningLoss",
            "batches",
            "examples",
            "activeElapsedSeconds",
        }
        or value.get("schema") != EPOCH_PROGRESS_SCHEMA
        or type(value.get("epoch")) is not int
        or value["epoch"] != next_epoch
        or type(value.get("nextBatch")) is not int
        or value["nextBatch"] != next_batch
        or not isinstance(value.get("qatLayerShifts"), list)
        or len(value["qatLayerShifts"]) != expected_qat_layer_count
        or any(type(shift) is not int or shift < 0 or shift > 24 for shift in value["qatLayerShifts"])
        or isinstance(value.get("runningLoss"), bool)
        or not isinstance(value.get("runningLoss"), (int, float))
        or not math.isfinite(value["runningLoss"])
        or value["runningLoss"] < 0
        or type(value.get("batches")) is not int
        or value["batches"] != next_batch
        or type(value.get("examples")) is not int
        or value["examples"] < value["batches"]
        or isinstance(value.get("activeElapsedSeconds"), bool)
        or not isinstance(value.get("activeElapsedSeconds"), (int, float))
        or not math.isfinite(value["activeElapsedSeconds"])
        or value["activeElapsedSeconds"] < 0
    ):
        raise ValueError("checkpoint in-progress epoch state is malformed or inconsistent")
    return EpochProgress(
        epoch=value["epoch"],
        next_batch=value["nextBatch"],
        qat_layer_shifts=tuple(value["qatLayerShifts"]),
        running_loss=float(value["runningLoss"]),
        batches=value["batches"],
        examples=value["examples"],
        active_elapsed_seconds=float(value["activeElapsedSeconds"]),
    )


def restore_layer_shifts(value: Any, expected_count: int) -> tuple[int, ...] | None:
    if value is None:
        return None
    if (
        not isinstance(value, (list, tuple))
        or len(value) != expected_count
        or any(type(shift) is not int or shift < 0 or shift > 24 for shift in value)
    ):
        raise ValueError("checkpoint frozen QAT layer shifts are malformed")
    return tuple(value)


def _validated_metric(metrics: Any, key: str, label: str) -> float:
    if not isinstance(metrics, dict):
        raise ValueError(f"{label} metrics are missing")
    value = metrics.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} metric {key} is invalid")
    return float(value)


def _validated_ratio(metrics: Any, key: str, label: str) -> float:
    value = _validated_metric(metrics, key, label)
    if value < 0 or value > 1:
        raise ValueError(f"{label} metric {key} is outside [0, 1]")
    return value


def fixed_point_gate_status(
    fixed_validation: dict[str, Any],
    reference_validation: dict[str, Any],
    minimum_qat_fixed_agreement: float,
    maximum_fixed_accuracy_drop: float,
) -> tuple[bool, float]:
    agreement = _validated_ratio(fixed_validation, "qatFixedTop1Agreement", "fixed validation")
    fixed_accuracy = _validated_ratio(fixed_validation, "top1Accuracy", "fixed validation")
    reference_accuracy = _validated_ratio(reference_validation, "top1Accuracy", "QAT reference")
    fidelity_accuracy_drop = reference_accuracy - fixed_accuracy
    return (
        agreement >= minimum_qat_fixed_agreement
        and fidelity_accuracy_drop <= maximum_fixed_accuracy_drop,
        fidelity_accuracy_drop,
    )


def enforce_fixed_point_gates(
    fixed_validation: dict[str, Any],
    reference_validation: dict[str, Any],
    minimum_qat_fixed_agreement: float,
    maximum_fixed_accuracy_drop: float,
) -> float:
    agreement = _validated_ratio(fixed_validation, "qatFixedTop1Agreement", "fixed validation")
    passes, fidelity_accuracy_drop = fixed_point_gate_status(
        fixed_validation,
        reference_validation,
        minimum_qat_fixed_agreement,
        maximum_fixed_accuracy_drop,
    )
    if agreement < minimum_qat_fixed_agreement:
        raise RuntimeError(
            "QAT/fixed-point top-1 agreement "
            f"{agreement:.6f} is below {minimum_qat_fixed_agreement:.6f}"
        )
    if not passes:
        raise RuntimeError(
            "fixed-point validation accuracy drop from the pre-QAT reference "
            f"{fidelity_accuracy_drop:.6f} exceeds {maximum_fixed_accuracy_drop:.6f}"
        )
    return fidelity_accuracy_drop


def qat_candidate_passes(
    candidate: dict[str, Any],
    minimum_qat_fixed_agreement: float,
    maximum_fixed_accuracy_drop: float,
) -> bool:
    passes, drop = fixed_point_gate_status(
        candidate.get("fixedValidation"),
        candidate.get("referenceValidation"),
        minimum_qat_fixed_agreement,
        maximum_fixed_accuracy_drop,
    )
    recorded_drop = _validated_metric(candidate, "fidelityAccuracyDrop", "QAT candidate")
    if recorded_drop != drop:
        raise ValueError("QAT candidate fidelity drop does not match its frozen reference")
    return passes


def qat_candidate_key(
    candidate: dict[str, Any],
    minimum_qat_fixed_agreement: float,
    maximum_fixed_accuracy_drop: float,
) -> tuple[float, ...]:
    fixed_validation = candidate.get("fixedValidation")
    float_validation = candidate.get("floatValidation")
    agreement = _validated_metric(fixed_validation, "qatFixedTop1Agreement", "fixed validation")
    fixed_accuracy = _validated_ratio(fixed_validation, "top1Accuracy", "fixed validation")
    float_agreement = _validated_ratio(fixed_validation, "floatFixedTop1Agreement", "fixed validation")
    _, drop = fixed_point_gate_status(
        fixed_validation,
        candidate.get("referenceValidation"),
        minimum_qat_fixed_agreement,
        maximum_fixed_accuracy_drop,
    )
    recorded_drop = _validated_metric(candidate, "fidelityAccuracyDrop", "QAT candidate")
    if recorded_drop != drop:
        raise ValueError("QAT candidate fidelity drop does not match its frozen reference")
    loss = _validated_metric(float_validation, "loss", "float validation")
    epoch = candidate.get("epoch")
    if type(epoch) is not int or epoch < 0:
        raise ValueError("QAT candidate epoch is invalid")
    stage = candidate.get("stage")
    if stage not in {"entry", "epoch"}:
        raise ValueError("QAT candidate stage is invalid")
    violation = max(0.0, minimum_qat_fixed_agreement - agreement) + max(
        0.0,
        drop - maximum_fixed_accuracy_drop,
    )
    return (
        float(qat_candidate_passes(candidate, minimum_qat_fixed_agreement, maximum_fixed_accuracy_drop)),
        -violation,
        fixed_accuracy,
        agreement,
        float_agreement,
        -loss,
        -float(epoch),
        float(stage == "entry"),
    )


def snapshot_qat_candidate(
    epoch: int,
    model: NormalizedRanker,
    layer_shifts: Sequence[int],
    float_validation: dict[str, Any],
    fixed_validation: dict[str, Any],
    reference_validation: dict[str, Any],
    stage: str = "epoch",
) -> dict[str, Any]:
    if stage not in {"entry", "epoch"}:
        raise ValueError("QAT candidate stage is invalid")
    reference_accuracy = _validated_ratio(reference_validation, "top1Accuracy", "QAT reference")
    fixed_accuracy = _validated_ratio(fixed_validation, "top1Accuracy", "fixed validation")
    return {
        "schema": QAT_CANDIDATE_SCHEMA,
        "epoch": epoch,
        "stage": stage,
        "model": {
            key: value.detach().to(device="cpu").clone()
            for key, value in model.state_dict().items()
        },
        "layerShifts": list(layer_shifts),
        "floatValidation": dict(float_validation),
        "fixedValidation": dict(fixed_validation),
        "referenceValidation": dict(reference_validation),
        "fidelityAccuracyDrop": reference_accuracy - fixed_accuracy,
    }


def restore_qat_candidate(
    value: Any,
    model: NormalizedRanker,
    expected_layer_shifts: Sequence[int] | None,
) -> dict[str, Any] | None:
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or value.get("schema") != QAT_CANDIDATE_SCHEMA
        or type(value.get("epoch")) is not int
        or value["epoch"] < 0
        or value.get("stage") not in {"entry", "epoch"}
        or not isinstance(value.get("model"), dict)
        or set(value["model"]) != set(model.state_dict())
    ):
        raise ValueError("checkpoint best QAT candidate is malformed")
    shifts = restore_layer_shifts(
        value.get("layerShifts"),
        sum(isinstance(layer, nn.Linear) for layer in model.ranker.network),
    )
    if shifts is None or (expected_layer_shifts is not None and shifts != tuple(expected_layer_shifts)):
        raise ValueError("checkpoint best QAT candidate shifts do not match the frozen schedule")
    for key, expected in model.state_dict().items():
        saved = value["model"][key]
        if not isinstance(saved, Tensor) or saved.shape != expected.shape or saved.dtype != expected.dtype:
            raise ValueError("checkpoint best QAT candidate model state is incompatible")
        if not bool(torch.isfinite(saved).all()):
            raise ValueError("checkpoint best QAT candidate model state is non-finite")
    _validated_metric(value.get("floatValidation"), "loss", "float validation")
    _validated_ratio(value.get("fixedValidation"), "top1Accuracy", "fixed validation")
    _validated_ratio(value.get("fixedValidation"), "qatFixedTop1Agreement", "fixed validation")
    _validated_ratio(value.get("fixedValidation"), "floatFixedTop1Agreement", "fixed validation")
    reference_accuracy = _validated_ratio(value.get("referenceValidation"), "top1Accuracy", "QAT reference")
    fixed_accuracy = _validated_ratio(value.get("fixedValidation"), "top1Accuracy", "fixed validation")
    recorded_drop = _validated_metric(value, "fidelityAccuracyDrop", "QAT candidate")
    if recorded_drop != reference_accuracy - fixed_accuracy:
        raise ValueError("checkpoint QAT candidate fidelity drop does not match its metrics")
    return value


def select_best_qat_candidate(
    current: dict[str, Any] | None,
    candidate: dict[str, Any],
    minimum_qat_fixed_agreement: float,
    maximum_fixed_accuracy_drop: float,
) -> dict[str, Any]:
    if current is None:
        return candidate
    return (
        candidate
        if qat_candidate_key(
            candidate,
            minimum_qat_fixed_agreement,
            maximum_fixed_accuracy_drop,
        )
        > qat_candidate_key(
            current,
            minimum_qat_fixed_agreement,
            maximum_fixed_accuracy_drop,
        )
        else current
    )


def load_qat_candidate(
    model: NormalizedRanker,
    value: Any,
    expected_layer_shifts: Sequence[int] | None,
) -> tuple[tuple[int, ...], dict[str, Any], int, str]:
    candidate = restore_qat_candidate(value, model, expected_layer_shifts)
    if candidate is None:
        raise ValueError("best QAT candidate is missing")
    model.load_state_dict(candidate["model"])
    shifts = restore_layer_shifts(
        candidate["layerShifts"],
        sum(isinstance(layer, nn.Linear) for layer in model.ranker.network),
    )
    if shifts is None:
        raise ValueError("best QAT candidate is missing its frozen layer shifts")
    return shifts, dict(candidate["referenceValidation"]), int(candidate["epoch"]), str(candidate["stage"])


def restore_qat_checkpoint_state(
    saved: dict[str, Any],
    model: NormalizedRanker,
    *,
    require_frozen_state: bool,
    require_best_candidate: bool,
) -> tuple[tuple[int, ...] | None, dict[str, Any] | None, dict[str, Any] | None]:
    shifts = restore_layer_shifts(
        saved.get("qatLayerShifts"),
        sum(isinstance(layer, nn.Linear) for layer in model.ranker.network),
    )
    reference = saved.get("qatReferenceValidation")
    if reference is not None:
        _validated_ratio(reference, "top1Accuracy", "QAT reference")
    if require_frozen_state and (shifts is None or reference is None):
        raise ValueError("QAT checkpoint is missing its frozen quantization state")
    candidate = restore_qat_candidate(saved.get("bestQatCandidate"), model, shifts)
    if require_best_candidate and candidate is None:
        raise ValueError("QAT checkpoint is missing its best validated candidate")
    if candidate is not None:
        if reference != candidate["referenceValidation"]:
            raise ValueError("QAT checkpoint candidate reference differs from its frozen reference")
        next_epoch = saved.get("nextEpoch")
        if type(next_epoch) is not int or (
            candidate["stage"] == "epoch" and candidate["epoch"] >= next_epoch
        ) or (
            candidate["stage"] == "entry" and candidate["epoch"] > next_epoch
        ):
            raise ValueError("QAT checkpoint candidate epoch is inconsistent with its cursor")
        if candidate["stage"] == "epoch":
            if not any(
                isinstance(entry, dict)
                and entry.get("qat") is True
                and entry.get("epoch") == candidate["epoch"]
                for entry in saved.get("history", [])
            ):
                raise ValueError("QAT checkpoint candidate epoch is absent from its validation history")
        else:
            config = saved.get("config")
            if (
                not isinstance(config, dict)
                or type(config.get("epochs")) is not int
                or type(config.get("qatEpochs")) is not int
                or candidate["epoch"] != config["epochs"] - config["qatEpochs"]
            ):
                raise ValueError("QAT-entry candidate does not match the configured transition epoch")
    return shifts, reference, candidate


def save_checkpoint(
    path: Path,
    next_epoch: int,
    next_batch: int,
    model: NormalizedRanker,
    optimizer: torch.optim.Optimizer,
    config: dict[str, Any],
    history: list[dict[str, Any]],
    epoch_progress: EpochProgress | None = None,
    qat_layer_shifts: Sequence[int] | None = None,
    qat_reference_validation: dict[str, Any] | None = None,
    best_qat_candidate: dict[str, Any] | None = None,
) -> None:
    progress_payload = _epoch_progress_payload(epoch_progress) if epoch_progress is not None else None
    expected_qat_layer_count = len(epoch_progress.qat_layer_shifts) if epoch_progress is not None else 0
    restore_epoch_progress(
        progress_payload,
        next_epoch=next_epoch,
        next_batch=next_batch,
        expected_qat_layer_count=expected_qat_layer_count,
    )
    frozen_shifts = restore_layer_shifts(
        qat_layer_shifts,
        sum(isinstance(layer, nn.Linear) for layer in model.ranker.network),
    )
    if epoch_progress is not None and epoch_progress.qat_layer_shifts:
        if frozen_shifts is None or tuple(epoch_progress.qat_layer_shifts) != frozen_shifts:
            raise ValueError("in-progress QAT shifts do not match the checkpoint frozen schedule")
    if qat_reference_validation is not None:
        _validated_ratio(qat_reference_validation, "top1Accuracy", "QAT reference")
    restore_qat_candidate(best_qat_candidate, model, frozen_shifts)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    torch.save(
        {
            "schema": CHECKPOINT_SCHEMA,
            "nextEpoch": next_epoch,
            "nextBatch": next_batch,
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "config": config,
            "history": history,
            "epochProgress": progress_payload,
            "qatLayerShifts": list(frozen_shifts) if frozen_shifts is not None else None,
            "qatReferenceValidation": qat_reference_validation,
            "bestQatCandidate": best_qat_candidate,
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
    parser.add_argument(
        "--minimum-qat-fixed-agreement",
        "--minimum-fixed-agreement",
        dest="minimum_qat_fixed_agreement",
        type=float,
        default=0.99,
        help="minimum FP32 projected-QAT versus exact fixed-runtime top-1 agreement",
    )
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
    if (
        not math.isfinite(args.minimum_qat_fixed_agreement)
        or args.minimum_qat_fixed_agreement < 0
        or args.minimum_qat_fixed_agreement > 1
        or not math.isfinite(args.maximum_fixed_accuracy_drop)
        or args.maximum_fixed_accuracy_drop < 0
        or args.maximum_fixed_accuracy_drop > 1
    ):
        raise ValueError("fixed-point gates must be finite ratios in [0, 1]")
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
    eligible_paths = split_eligible_paths(paths, descriptors)
    corpus_sha256 = descriptor_fingerprint(descriptors)

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA learner requested but PyTorch cannot see a CUDA device")
    if device.type == "cuda":
        # QAT models exact integer arithmetic closely enough that TF32's shortened mantissa is not acceptable.
        torch.set_float32_matmul_precision("highest")
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False

    offset, scale, observations, normalization_cache, packed_cache = prepare_input_caches(
        paths,
        descriptors,
        eligible_paths,
        campaign,
        corpus_sha256,
        manifest_path.parent,
    )
    model = NormalizedRanker(CandidateRanker(hidden), offset, scale, args.input_clip).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    checkpoint = args.checkpoint or args.out.with_suffix(".checkpoint.pt")
    config = {
        "featureSchemaSha256": FULL_FEATURE_SHA256,
        "runFingerprint": campaign["runFingerprint"],
        "manifestSha256": campaign["manifestSha256"],
        "featureContractSha256": hashlib.sha256(contract_path.read_bytes()).hexdigest(),
        "corpusSha256": corpus_sha256,
        "normalizationCacheSchema": NORMALIZATION_CACHE_SCHEMA,
        "normalizationCacheSha256": normalization_cache.cache_sha256,
        "packedCacheSchema": PACKED_CACHE_SCHEMA,
        "packedCacheSha256": packed_cache.cache_sha256,
        "packedCachePathOrderSha256": packed_cache.path_order_sha256,
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
        "minimumQatFixedAgreement": args.minimum_qat_fixed_agreement,
        "maximumFixedAccuracyDrop": args.maximum_fixed_accuracy_drop,
        "quantizationSemantics": QUANTIZATION_SEMANTICS,
        "checkpointSchema": CHECKPOINT_SCHEMA,
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
    resume_epoch_progress: EpochProgress | None = None
    history: list[dict[str, Any]] = []
    qat_layer_shifts: tuple[int, ...] | None = None
    qat_reference_validation: dict[str, Any] | None = None
    best_qat_candidate: dict[str, Any] | None = None
    if args.resume:
        saved = torch.load(checkpoint, map_location=device, weights_only=False)
        if saved.get("schema") != CHECKPOINT_SCHEMA:
            raise ValueError("checkpoint predates the exact FP32/frozen-shift QAT semantics")
        if saved.get("config") != config:
            raise ValueError("checkpoint configuration does not match this training run")
        model.load_state_dict(saved["model"])
        optimizer.load_state_dict(saved["optimizer"])
        first_epoch = int(saved["nextEpoch"])
        resume_batch = int(saved["nextBatch"])
        if (
            first_epoch < 0
            or first_epoch > args.epochs
            or resume_batch < 0
            or (resume_batch > 0 and first_epoch >= args.epochs)
        ):
            raise ValueError("checkpoint epoch/batch cursor is outside this training run")
        resume_qat = first_epoch < args.epochs and first_epoch >= args.epochs - args.qat_epochs
        resume_epoch_progress = restore_epoch_progress(
            saved.get("epochProgress"),
            next_epoch=first_epoch,
            next_batch=resume_batch,
            expected_qat_layer_count=(
                sum(isinstance(layer, nn.Linear) for layer in model.ranker.network)
                if resume_qat
                else 0
            ),
        )
        has_qat_history = any(
            isinstance(entry, dict) and bool(entry.get("qat"))
            for entry in saved.get("history", [])
        )
        completed_qat = first_epoch == args.epochs and args.qat_epochs > 0
        resumed_qat_work = resume_batch > 0 or has_qat_history
        qat_layer_shifts, qat_reference_validation, best_qat_candidate = restore_qat_checkpoint_state(
            saved,
            model,
            require_frozen_state=(resume_qat and resumed_qat_work) or completed_qat,
            require_best_candidate=(resume_qat and resumed_qat_work) or completed_qat,
        )
        if (
            resume_epoch_progress is not None
            and resume_epoch_progress.qat_layer_shifts
            and tuple(resume_epoch_progress.qat_layer_shifts) != qat_layer_shifts
        ):
            raise ValueError("QAT checkpoint epoch shifts differ from its frozen schedule")
        history = list(saved.get("history", []))
        random.setstate(saved["pythonRandomState"])
        torch.random.set_rng_state(saved["torchRandomState"])
        if torch.cuda.is_available() and saved["cudaRandomState"]:
            torch.cuda.set_rng_state_all(saved["cudaRandomState"])

    validation = DataLoader(
        DecisionDataset(
            paths,
            "validation",
            args.seed + 1,
            eligible_paths["validation"],
            packed_cache,
        ),
        batch_size=args.batch_size,
        num_workers=args.workers,
        collate_fn=collate,
        pin_memory=device.type == "cuda",
        persistent_workers=args.workers > 0,
        prefetch_factor=4 if args.workers > 0 else None,
    )

    # The training corpus's order is epoch-specific but entirely determined by this synchronized seed. Keeping
    # workers alive avoids respawning the eight mmap/pinned-memory producers thirty times per architecture,
    # which otherwise leaves the 5090 idle at the beginning of every epoch. The seed is set before each new
    # iterator, so the exact old `training_epoch_seed` permutation and mid-epoch resume semantics remain.
    training_epoch_seed_shared = multiprocessing.Value("q", 0)
    training = DataLoader(
        DecisionDataset(
            paths,
            "train",
            training_epoch_seed_shared,
            eligible_paths["train"],
            packed_cache,
        ),
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
        with training_epoch_seed_shared.get_lock():
            training_epoch_seed_shared.value = epoch_seed
        qat = epoch >= args.epochs - args.qat_epochs
        if qat and qat_layer_shifts is None:
            qat_reference_validation = evaluate(model, validation, device, args.validation_batches)
            qat_layer_shifts = tuple(
                quantized_layer_parameters(layer, args.input_scale)[1]
                for layer in model.ranker.network
                if isinstance(layer, nn.Linear)
            )
            qat_entry_fixed_validation = evaluate_fixed(
                model,
                validation,
                device,
                args.input_scale,
                args.validation_batches,
                qat_layer_shifts,
            )
            qat_entry_candidate = snapshot_qat_candidate(
                epoch,
                model,
                qat_layer_shifts,
                qat_reference_validation,
                qat_entry_fixed_validation,
                qat_reference_validation,
                stage="entry",
            )
            best_qat_candidate = select_best_qat_candidate(
                best_qat_candidate,
                qat_entry_candidate,
                args.minimum_qat_fixed_agreement,
                args.maximum_fixed_accuracy_drop,
            )
        if qat and qat_reference_validation is None:
            raise RuntimeError("QAT started without a frozen reference validation")
        model.train()
        resumed_progress = (
            resume_epoch_progress
            if epoch == first_epoch and resume_batch > 0
            else None
        )
        running_loss = resumed_progress.running_loss if resumed_progress is not None else 0.0
        batches = resumed_progress.batches if resumed_progress is not None else 0
        examples = resumed_progress.examples if resumed_progress is not None else 0
        active_elapsed_seconds = (
            resumed_progress.active_elapsed_seconds if resumed_progress is not None else 0.0
        )
        active_segment_started = time.monotonic()
        if device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(device)
        epoch_qat_layer_shifts = qat_layer_shifts if qat_layer_shifts is not None and qat else ()
        if resumed_progress is not None and resumed_progress.qat_layer_shifts != epoch_qat_layer_shifts:
            raise ValueError("resumed epoch QAT shifts differ from the frozen run schedule")
        last_batch_cursor = 0
        for batch_index, batch in enumerate(training):
            last_batch_cursor = batch_index + 1
            if epoch == first_epoch and batch_index < resume_batch:
                if batch_index + 1 == resume_batch:
                    # Replaying the deterministic loader cursor is not active learner work and must not inflate
                    # resumed throughput time. Start the new active segment after the final skipped batch.
                    active_segment_started = time.monotonic()
                continue
            batch = move_batch(batch, device)
            optimizer.zero_grad(set_to_none=True)
            scores, loss = training_forward_loss(
                model,
                batch,
                args.input_scale,
                epoch_qat_layer_shifts,
                qat,
                args.amp,
            )
            if not torch.isfinite(loss):
                raise RuntimeError(f"non-finite training loss at epoch {epoch}, batch {batch_index}")
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            running_loss += float(loss.detach())
            batches += 1
            examples += batch.features.shape[0]
            if time.monotonic() - last_checkpoint >= args.checkpoint_seconds:
                active_elapsed_seconds += time.monotonic() - active_segment_started
                save_checkpoint(
                    checkpoint,
                    epoch,
                    batch_index + 1,
                    model,
                    optimizer,
                    config,
                    history,
                    EpochProgress(
                        epoch=epoch,
                        next_batch=batch_index + 1,
                        qat_layer_shifts=epoch_qat_layer_shifts,
                        running_loss=running_loss,
                        batches=batches,
                        examples=examples,
                        active_elapsed_seconds=active_elapsed_seconds,
                    ),
                    qat_layer_shifts=qat_layer_shifts,
                    qat_reference_validation=qat_reference_validation,
                    best_qat_candidate=best_qat_candidate,
                )
                active_segment_started = time.monotonic()
                last_checkpoint = active_segment_started
        if epoch == first_epoch and resume_batch > last_batch_cursor:
            raise ValueError("checkpoint batch cursor exceeds the deterministic epoch length")
        training_elapsed = active_elapsed_seconds + (time.monotonic() - active_segment_started)
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
                "amp": "off" if qat else (args.amp if device.type == "cuda" else "off"),
                "requestedAmp": args.amp if device.type == "cuda" else "off",
                "trainingShardEpochSeed": epoch_seed,
                "trainingShardOrderSha256": training_epoch_order_sha256(paths, args.seed, epoch),
            }
        )
        if qat:
            if qat_layer_shifts is None or qat_reference_validation is None:
                raise RuntimeError("QAT validation is missing its frozen run state")
            try:
                fixed_epoch_validation = evaluate_fixed(
                    model,
                    validation,
                    device,
                    args.input_scale,
                    args.validation_batches,
                    qat_layer_shifts,
                )
            except OverflowError as error:
                # A late candidate may leave the grid frozen at QAT entry. Preserve an earlier validated best
                # instead of letting this one architecture lose its already-safe checkpoint.
                metrics.update(
                    {
                        "fixedValidationError": str(error),
                        "qatReferenceTop1Accuracy": qat_reference_validation["top1Accuracy"],
                        "passesFixedPointGates": False,
                        "selectedAsBestQat": False,
                        "qatLayerShifts": list(qat_layer_shifts),
                    }
                )
            else:
                candidate = snapshot_qat_candidate(
                    epoch,
                    model,
                    qat_layer_shifts,
                    metrics,
                    fixed_epoch_validation,
                    qat_reference_validation,
                )
                selected = select_best_qat_candidate(
                    best_qat_candidate,
                    candidate,
                    args.minimum_qat_fixed_agreement,
                    args.maximum_fixed_accuracy_drop,
                )
                selected_as_best_qat = selected is candidate
                best_qat_candidate = selected
                metrics.update(
                    {
                        "fixedValidation": fixed_epoch_validation,
                        "qatReferenceTop1Accuracy": qat_reference_validation["top1Accuracy"],
                        "fidelityAccuracyDrop": candidate["fidelityAccuracyDrop"],
                        "passesFixedPointGates": qat_candidate_passes(
                            candidate,
                            args.minimum_qat_fixed_agreement,
                            args.maximum_fixed_accuracy_drop,
                        ),
                        "selectedAsBestQat": selected_as_best_qat,
                        "qatLayerShifts": list(qat_layer_shifts),
                    }
                )
        history.append(metrics)
        print(json.dumps(metrics, sort_keys=True), flush=True)
        save_checkpoint(
            checkpoint,
            epoch + 1,
            0,
            model,
            optimizer,
            config,
            history,
            qat_layer_shifts=qat_layer_shifts,
            qat_reference_validation=qat_reference_validation,
            best_qat_candidate=best_qat_candidate,
        )
        resume_batch = 0
        resume_epoch_progress = None

    selected_qat_epoch: int | None = None
    selected_qat_stage: str | None = None
    if args.qat_epochs > 0 and best_qat_candidate is None:
        raise RuntimeError("no QAT epoch produced a fixed-point-safe validation candidate")
    if best_qat_candidate is not None:
        (
            qat_layer_shifts,
            qat_reference_validation,
            selected_qat_epoch,
            selected_qat_stage,
        ) = load_qat_candidate(model, best_qat_candidate, qat_layer_shifts)
    if qat_layer_shifts is None:
        qat_layer_shifts = tuple(
            quantized_layer_parameters(layer, args.input_scale)[1]
            for layer in model.ranker.network
            if isinstance(layer, nn.Linear)
        )
    final_validation = evaluate(model, validation, device, args.validation_batches)
    if qat_reference_validation is None:
        qat_reference_validation = dict(final_validation)
    fixed_validation = evaluate_fixed(
        model,
        validation,
        device,
        args.input_scale,
        args.validation_batches,
        qat_layer_shifts,
    )
    rejection_reason: str | None = None
    try:
        fidelity_accuracy_drop = enforce_fixed_point_gates(
            fixed_validation,
            qat_reference_validation,
            args.minimum_qat_fixed_agreement,
            args.maximum_fixed_accuracy_drop,
        )
    except RuntimeError as error:
        # Projected-QAT/runtime disagreement is systemic and must abort the campaign. A model-quality miss is
        # architecture-specific during the preregistered initial sweep and is published as a sealed rejection.
        if fixed_validation["qatFixedTop1Agreement"] < args.minimum_qat_fixed_agreement:
            raise
        _, fidelity_accuracy_drop = fixed_point_gate_status(
            fixed_validation,
            qat_reference_validation,
            args.minimum_qat_fixed_agreement,
            args.maximum_fixed_accuracy_drop,
        )
        rejection_reason = str(error)
    final_metrics = {
        "normalizationObservations": observations,
        "normalizationCache": {
            "schema": NORMALIZATION_CACHE_SCHEMA,
            "sha256": normalization_cache.cache_sha256,
        },
        "packedCache": {
            "schema": PACKED_CACHE_SCHEMA,
            "sha256": packed_cache.cache_sha256,
            "pathOrderSha256": packed_cache.path_order_sha256,
            "shards": packed_cache.shards,
            "decisions": packed_cache.decisions,
            "candidates": packed_cache.candidates,
            "dataBytes": packed_cache.data_bytes,
        },
        "corpusSha256": config["corpusSha256"],
        "hardware": {
            "device": config["device"],
            "torchVersion": config["torchVersion"],
            "cudaVersion": config["cudaVersion"],
            "cudaDevice": config["cudaDevice"],
            "cudaCapability": config["cudaCapability"],
        },
        "history": history,
        "quantization": {
            "semantics": QUANTIZATION_SEMANTICS,
            "layerShifts": list(qat_layer_shifts),
            "selectedQatEpoch": selected_qat_epoch,
            "selectedQatStage": selected_qat_stage,
            "qatReferenceValidation": qat_reference_validation,
            "fidelityAccuracyDrop": fidelity_accuracy_drop,
        },
        "finalValidation": final_validation,
        "fixedValidation": fixed_validation,
    }
    metrics_path = args.out.with_suffix(".metrics.json").resolve()
    atomic_json(metrics_path, final_metrics)
    if rejection_reason is not None:
        rejection_unsigned = {
            "schema": LEARNER_REJECTION_SCHEMA,
            "reason": "fixed_accuracy_drop",
            "message": rejection_reason,
            "runFingerprint": campaign["runFingerprint"],
            "sourceCommit": campaign["identity"]["sourceCommit"],
            "corpusSha256": config["corpusSha256"],
            "hidden": hidden,
            "minimumQatFixedAgreement": args.minimum_qat_fixed_agreement,
            "maximumFixedAccuracyDrop": args.maximum_fixed_accuracy_drop,
            "selectedQatEpoch": selected_qat_epoch,
            "selectedQatStage": selected_qat_stage,
            "fixedValidation": fixed_validation,
            "qatReferenceValidation": qat_reference_validation,
            "fidelityAccuracyDrop": fidelity_accuracy_drop,
            "metricsSha256": hashlib.sha256(metrics_path.read_bytes()).hexdigest(),
        }
        rejection = seal_learner_rejection(rejection_unsigned)
        rejection_path = args.out.with_suffix(".rejection.json").resolve()
        atomic_json(rejection_path, rejection)
        print(json.dumps({"rejected": str(rejection_path), "reason": rejection["reason"]}, sort_keys=True))
        return
    artifact = build_research_artifact(
        model,
        contract,
        campaign,
        hidden,
        args.input_scale,
        args.input_clip,
        args.min_override_margin,
        final_metrics,
        qat_layer_shifts,
    )
    staging_artifact = args.out.with_suffix(".unsealed.json").resolve()
    # Publish metrics before the model. The orchestrator treats a sealed artifact as the completion marker, so
    # this ordering makes every crash point resumable: metrics-only reruns sealing, artifact implies both exist.
    atomic_json(staging_artifact, artifact)
    sealer = Path(__file__).resolve().parents[1] / "seal_artifact.ts"
    subprocess.run(
        ["bun", str(sealer), "--input", str(staging_artifact), "--output", str(args.out.resolve())],
        check=True,
    )
    sealed = json.loads(args.out.resolve().read_text(encoding="utf-8"))
    staging_artifact.unlink()
    print(json.dumps({"artifact": str(args.out.resolve()), "modelSha256": sealed["modelSha256"]}, sort_keys=True))


if __name__ == "__main__":
    main()
