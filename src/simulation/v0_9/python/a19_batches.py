"""Prepare A19 tensors once, preserving the reference collator's batch shapes and strides."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import torch


DEFAULT_STAGING_MAX_BYTES = 4 * 1024**3


def batch_layout(rows: list[dict]) -> dict:
    """Estimate the complete allocation before calling the collator or moving tensors."""
    if not rows:
        raise ValueError("Cannot stage an empty decision phase")
    observations = [row["observation"] for row in rows]
    shapes = [(len(obs["entities"]), len(obs["candidates"])) for obs in observations]
    if any(not 1 <= n <= 64 or not 1 <= c <= 256 for n, c in shapes):
        raise ValueError("Staged observation exceeds the A19 shape contract")
    n, c = max(x[0] for x in shapes), max(x[1] for x in shapes)
    e = len(observations[0]["entities"][0])
    f = len(observations[0]["candidates"][0]["features"])
    g = len(observations[0]["globals"])
    rollouts = len(rows[0]["samples"][0])
    if e < 1 or f < 1 or g < 1 or rollouts not in (4, 8):
        raise ValueError("Invalid staged feature or rollout width")
    for row, obs in zip(rows, observations):
        if (any(len(entity) != e for entity in obs["entities"])
                or any(len(candidate["features"]) != f for candidate in obs["candidates"])
                or len(obs["globals"]) != g or len(obs["terrain"]) != 256
                or len(row["samples"]) != len(obs["candidates"])
                or any(bank is not None and len(bank) != rollouts for bank in row["samples"])):
            raise ValueError("Mixed staged feature shapes or independent rollout banks")
    # Seven model inputs followed by samples, scored mask, outcome, teacher and legal mask.
    bytes_per_row = (4*n*e + n + 4*g + 8*256 + 8 + 4*c*f + 8*c
                     + 4*c*rollouts + c + 4 + 8 + c)
    return {"rows": len(rows), "entities": n, "candidates": c, "rollouts": rollouts,
            "shapes": shapes, "tensorBytes": len(rows)*bytes_per_row,
            "shapeBytes": 16*len(rows)}


@dataclass(frozen=True)
class StagedBatches:
    columns: tuple[torch.Tensor, ...]
    shapes: torch.Tensor

    def get(self, indices):
        if isinstance(indices, torch.Tensor):
            if indices.device.type != "cpu" or indices.dtype != torch.long:
                raise ValueError("Use explicit CPU integer row indices")
            chosen = indices
        else:
            values = list(indices)
            if any(type(value) is not int for value in values):
                raise ValueError("Row indices must be literal integers")
            chosen = torch.tensor(values, dtype=torch.long)
        if (chosen.ndim != 1 or chosen.numel() == 0
                or bool(((chosen < 0) | (chosen >= len(self.shapes))).any())):
            raise ValueError("Choose nonempty, in-range ordered rows")
        device = self.columns[0].device
        device_indices = chosen.to(device)
        columns = [tensor.index_select(0, device_indices) for tensor in self.columns]
        n, c = self.shapes.index_select(0, chosen).max(0).values.tolist()
        columns[0], columns[1] = columns[0][:, :n], columns[1][:, :n]
        for index in (5, 6, 7, 8, 11):
            columns[index] = columns[index][:, :c]
        exact = []
        for tensor in columns:
            # contiguous() alone preserves a larger batch stride on singleton batches.
            stride, expected = 1, []
            for size in reversed(tensor.shape):
                expected.append(stride)
                stride *= size
            if tensor.stride() != tuple(reversed(expected)):
                canonical = torch.empty(tensor.shape, dtype=tensor.dtype, device=tensor.device)
                canonical.copy_(tensor)
                tensor = canonical
            exact.append(tensor)
        return tuple(exact[:7]), *exact[7:]


def prepare_staged_batches(phases: dict[str, list[dict]], device: torch.device,
                           collate: Callable, *, mode: str = "auto",
                           maximum_bytes: int = DEFAULT_STAGING_MAX_BYTES):
    """Auto stages when admitted; legacy is the explicit original implementation control."""
    if mode not in ("auto", "staged", "legacy") or type(maximum_bytes) is not int or maximum_bytes < 1:
        raise ValueError("Invalid staged batch mode or memory limit")
    if mode == "legacy":
        return {}, {"requestedMode": mode, "actualMode": "legacy", "reason": "explicit_reference"}
    layouts = {name: batch_layout(rows) for name, rows in phases.items()}
    required = sum(x["tensorBytes"] + x["shapeBytes"] for x in layouts.values())
    limit = maximum_bytes
    if device.type == "cuda":
        # Keep at least three quarters of currently free device memory for training and temporaries.
        free, _total = torch.cuda.mem_get_info(device)
        limit = min(limit, free // 4)
    receipt = {"requestedMode": mode, "requiredBytes": required, "admittedMaximumBytes": limit,
               "phases": {name: {k: v for k, v in layout.items() if k != "shapes"}
                          for name, layout in layouts.items()}}
    if required > limit:
        if mode == "staged":
            raise ValueError("Staged corpus exceeds the admitted memory limit before allocation")
        return {}, {**receipt, "actualMode": "legacy", "reason": "staging_memory_limit"}
    prepared = {}
    for name, rows in phases.items():
        batch = collate(rows, torch.device("cpu"))
        columns = (*batch[0], *batch[1:])
        layout = layouts[name]
        if (len(columns) != 12 or any(t.device.type != "cpu" or not t.is_contiguous() for t in columns)
                or sum(t.numel()*t.element_size() for t in columns) != layout["tensorBytes"]):
            raise ValueError("Reference collator layout differs from the admitted staging allocation")
        prepared[name] = StagedBatches(tuple(t.to(device) for t in columns),
                                      torch.tensor(layout["shapes"], dtype=torch.long))
    return prepared, {**receipt, "actualMode": "staged", "reason": "admitted"}
