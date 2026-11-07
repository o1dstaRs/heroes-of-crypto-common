"""Small, zero-initialized feature extension for research A19 policy fits.

The original representation stays frozen. A rank-limited path lets additional
public entity features affect the existing encoder. Export folds that path into
the ordinary first linear layer; no custom serving operator is required.
"""
from __future__ import annotations

import math
from typing import Any

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from a19_model import A19ProposalModel


class FeatureExtensionLinear(nn.Module):
    def __init__(self, base: nn.Linear, base_width: int, rank: int, seed: int) -> None:
        super().__init__()
        if type(rank) is not int or not 1 <= rank <= 32:
            raise ValueError("feature rank must be an integer in [1,32]")
        if not 0 < base_width < base.in_features:
            raise ValueError("feature extension must have new input columns")
        if bool(base.weight[:, base_width:].detach().ne(0).any()):
            raise ValueError("initial extension columns must be zero")
        self.base = base.requires_grad_(False)
        self.base_width = base_width
        # Only the output factor starts at zero: zeroing both disconnects gradients.
        generator = torch.Generator(device="cpu").manual_seed(seed)
        width = base.in_features - base_width
        self.down = nn.Parameter(torch.empty(rank, width, dtype=base.weight.dtype))
        nn.init.normal_(self.down, std=1 / math.sqrt(width), generator=generator)
        self.up = nn.Parameter(torch.zeros(base.out_features, rank, dtype=base.weight.dtype))

    def forward(self, value: Tensor) -> Tensor:
        return self.base(value) + F.linear(F.linear(value[..., self.base_width:], self.down), self.up)

    def folded_weight(self) -> Tensor:
        extension = self.base.weight.new_zeros(self.base.weight.shape)
        extension[:, self.base_width:] = self.up @ self.down
        return self.base.weight + extension


class A19FeatureAdapterModel(A19ProposalModel):
    @classmethod
    def from_artifact(cls, artifact: dict[str, Any], entity_width: int, candidate_width: int,
                      global_width: int, *, rank: int = 4, seed: int = 0,
                      base_width: int = 189) -> A19FeatureAdapterModel:
        if type(rank) is not int or not 0 <= rank <= 32:
            raise ValueError("rank0 is the frozen control; feature rank must be in [1,32]")
        if entity_width <= base_width:
            raise ValueError("rich entity width must extend the original representation")
        # Model construction must not perturb the caller's batch/random sequence.
        with torch.random.fork_rng(devices=[]):
            torch.manual_seed(seed)
            model = cls(entity_width, candidate_width, global_width)
        weights = artifact.get("weights")
        if not isinstance(weights, dict) or set(weights) != set(model.state_dict()):
            raise ValueError("initial model weight names do not match the original architecture")
        state = model.state_dict()
        for name, value in weights.items():
            old = torch.tensor(value, dtype=state[name].dtype)
            if not bool(torch.isfinite(old).all()):
                raise ValueError("nonfinite initial weights: " + name)
            if name == "entity.0.weight":
                if old.shape != (96, base_width):
                    raise ValueError("wrong initial entity width")
                state[name].zero_()
                state[name][:, :base_width].copy_(old)
            else:
                if old.shape != state[name].shape:
                    raise ValueError("initial weight shape mismatch: " + name)
                state[name].copy_(old)
        model.load_state_dict(state, strict=True)
        model.requires_grad_(False)
        model.policy.requires_grad_(True)
        model.base_width = base_width
        model.feature_rank = rank
        if rank:
            model.entity[0] = FeatureExtensionLinear(model.entity[0], base_width, rank, seed)
        model._initial_frozen = {name: value.detach().cpu().clone()
                                 for name, value in model.named_parameters() if not value.requires_grad}
        return model

    def check_frozen_parameters(self) -> None:
        actual = dict(self.named_parameters())
        for name, original in self._initial_frozen.items():
            if actual[name].requires_grad or not torch.equal(actual[name].detach().cpu(), original):
                raise ValueError("frozen parameter changed: " + name)

    def extension_parameters(self) -> tuple[nn.Parameter, ...]:
        first = self.entity[0]
        return (first.down, first.up) if isinstance(first, FeatureExtensionLinear) else ()

    def folded_state_dict(self) -> dict[str, Tensor]:
        self.check_frozen_parameters()
        state = {name: value.detach().cpu().clone() for name, value in self.state_dict().items()}
        first = self.entity[0]
        if isinstance(first, FeatureExtensionLinear):
            state["entity.0.weight"] = first.folded_weight().detach().cpu()
            state["entity.0.bias"] = state.pop("entity.0.base.bias")
            for name in ["entity.0.base.weight", "entity.0.down", "entity.0.up"]:
                del state[name]
        if not all(bool(torch.isfinite(value).all()) for value in state.values()):
            raise ValueError("nonfinite folded model")
        return state

    def folded_model(self) -> A19ProposalModel:
        first = self.entity[0]
        width = first.base.in_features if isinstance(first, FeatureExtensionLinear) else first.in_features
        # Fork to preserve the training RNG when validating/exporting checkpoints.
        with torch.random.fork_rng(devices=[]):
            torch.manual_seed(0)
            model = A19ProposalModel(width, self.candidate[0].in_features - 128 - 96,
                                     self.context[0].in_features - 96 * 5 - 64)
        model.load_state_dict(self.folded_state_dict(), strict=True)
        return model.eval()


def served_policy(student_logits: Tensor, partner_logits: Tensor, legal: Tensor) -> Tensor:
    if student_logits.shape != partner_logits.shape or legal.shape != student_logits.shape:
        raise ValueError("student/partner/legal shape mismatch")
    if legal.dtype != torch.bool or not bool(legal.any(-1).all()):
        raise ValueError("each root needs a legal action")
    left = F.log_softmax(student_logits.masked_fill(~legal, -1e9), -1)
    right = F.log_softmax(partner_logits.masked_fill(~legal, -1e9), -1)
    return torch.logaddexp(left, right) - math.log(2)


def served_gate_choices(policy: Tensor, native: Tensor, eligible_order: Tensor,
                        minimum_gain: float = 1.) -> Tensor:
    """Same strict tie order and margin as selectV09A19Correction on eligible roots."""
    if not math.isfinite(minimum_gain) or minimum_gain <= 0:
        raise ValueError("invalid deployed gate margin")
    if eligible_order.shape[0] != policy.shape[0] or native.shape != policy.shape[:1]:
        raise ValueError("gate root shape mismatch")
    if not bool(((native >= 0) & (native < policy.shape[1])).all()):
        raise ValueError("native action outside catalog")
    valid = eligible_order >= 0
    if not bool(valid.any(-1).all()) or not bool(((eligible_order[valid] < policy.shape[1])).all()):
        raise ValueError("invalid eligible catalog indices")
    indices = eligible_order.clamp_min(0)
    if not bool(((eligible_order == native[:, None]) & valid).any(-1).all()):
        raise ValueError("native action is not an eligible primary tie")
    ordered_scores = policy.gather(1, indices).masked_fill(~valid, -torch.inf)
    best = indices.gather(1, ordered_scores.argmax(-1)[:, None]).squeeze(1)
    gain = policy.gather(1, best[:, None]).squeeze(1) - policy.gather(1, native[:, None]).squeeze(1)
    return torch.where(gain >= minimum_gain, best, native)


def roots_with_terminal_contrast(returns: Tensor, mask: Tensor) -> Tensor:
    """Compare actions within the SAME world; ignore padded/unlabeled actions."""
    maximum = returns.masked_fill(~mask[:, :, None], -torch.inf).amax(1)
    minimum = returns.masked_fill(~mask[:, :, None], torch.inf).amin(1)
    return ((maximum - minimum) > 0).any(-1)


def paired_root_loss(policy: Tensor, actions: Tensor, returns: Tensor, mask: Tensor,
                     *, weighting: str = "comparisons", payoff_weighting: str = "sign"
                     ) -> tuple[Tensor, dict[str, Tensor]]:
    """Registered comparison- or equal-root-weighted loss, with both diagnostics.

    All paired worlds remain nested inside the root. Observed ties contribute no
    invented action preference. Unknown/unlabeled catalog actions are not negatives.
    Equal-root research prevents more non-tied futures from increasing a root's
    training/validation weight. The original objective remains the default.
    Magnitude weighting aligns pair preferences with expected draw-aware score:
    a win-versus-loss difference carries twice a draw-versus-loss difference.
    """
    if weighting not in ["comparisons", "roots"]:
        raise ValueError("unknown paired-root loss weighting")
    if payoff_weighting not in ["sign", "magnitude"]:
        raise ValueError("unknown paired-root payoff weighting")
    if returns.ndim != 3 or returns.shape[:2] != actions.shape or mask.shape != actions.shape:
        raise ValueError("paired root shape mismatch")
    if mask.dtype != torch.bool or not bool((mask.sum(-1) >= 2).all()):
        raise ValueError("each root needs two labeled actions")
    if not bool(torch.isfinite(returns[mask]).all()) or not bool(
            ((returns[mask] == 0) | (returns[mask] == .5) | (returns[mask] == 1)).all()):
        raise ValueError("returns must be completed-game scores")
    if not bool(((actions[mask] >= 0) & (actions[mask] < policy.shape[1])).all()):
        raise ValueError("labeled action outside legal catalog")
    safe_actions = torch.where(mask, actions, torch.zeros_like(actions))
    chosen = policy.gather(1, safe_actions)
    logits = chosen[:, :, None] - chosen[:, None, :]
    # Replace padding before arithmetic so masked NaNs cannot poison a fit.
    safe_returns = torch.where(mask[:, :, None], returns, torch.zeros_like(returns))
    difference = safe_returns[:, :, None, :] - safe_returns[:, None, :, :]
    valid = (mask[:, :, None] & mask[:, None, :]).triu(1)
    wins = (difference > 0).to(policy.dtype).sum(-1)
    losses = (difference < 0).to(policy.dtype).sum(-1)
    non_tied = ((wins + losses) * valid).sum()
    if payoff_weighting == "magnitude":
        wins = difference.clamp_min(0).sum(-1)
        losses = (-difference).clamp_min(0).sum(-1)
    weight = (wins + losses) * valid
    mass = wins + losses
    target = wins / torch.where(mass > 0, mass, torch.ones_like(mass))
    losses_ = F.binary_cross_entropy_with_logits(logits, target, reduction="none") * weight
    root_weight = weight.sum((-1, -2))
    root_loss = losses_.sum((-1, -2)) / torch.where(root_weight > 0, root_weight, torch.ones_like(root_weight))
    total_weight = root_weight.sum()
    total = losses_.sum() / torch.where(total_weight > 0, total_weight, torch.ones_like(total_weight))
    equal_root = root_loss.sum() / (root_weight > 0).sum().clamp_min(1)
    return (equal_root if weighting == "roots" else total), {"nonTiedComparisons": non_tied.detach(),
                   "effectiveComparisonWeight": total_weight.detach(),
                   "informativeRoots": (root_weight > 0).sum().detach(),
                   "comparisonWeightedLoss": total.detach(),
                   "equalInformativeRootLoss": equal_root.detach(),
                   "perRootLoss": root_loss.detach(), "perRootComparisonWeight": root_weight.detach()}


def paired_gate_gain(choices: Tensor, baseline: Tensor, actions: Tensor,
                     returns: Tensor, mask: Tensor) -> tuple[Tensor, Tensor]:
    """Paired terminal gain for known served actions; never label unknown actions.

    The boolean result is the set of roots whose selected action was actually
    continued. Missing choices carry zero only as masked storage, not as evidence.
    """
    if choices.dtype != torch.int64 or baseline.dtype != torch.int64 or choices.ndim != 1 or baseline.shape != choices.shape or actions.ndim != 2 or actions.shape[0] != len(choices):
        raise ValueError("invalid served-choice shape")
    if mask.dtype != torch.bool or mask.shape != actions.shape or returns.ndim != 3 or returns.shape[:2] != actions.shape or returns.shape[-1] == 0:
        raise ValueError("invalid paired-gain shape")
    if not bool(torch.isfinite(returns[mask]).all()) or not bool(
            ((returns[mask] == 0) | (returns[mask] == .5) | (returns[mask] == 1)).all()):
        raise ValueError("paired gains require completed-game scores")
    incumbent = (actions == baseline[:, None]) & mask
    selected = (actions == choices[:, None]) & mask
    if not bool((incumbent.sum(-1) == 1).all()) or bool((selected.sum(-1) > 1).any()):
        raise ValueError("baseline must have exactly one paired label")
    rows = torch.arange(len(choices), device=actions.device)
    known = selected.any(-1)
    safe_returns = torch.where(mask[:, :, None], returns, torch.zeros_like(returns))
    gain = safe_returns[rows, selected.to(torch.int64).argmax(-1)] - safe_returns[rows, incumbent.to(torch.int64).argmax(-1)]
    return torch.where(known, gain.mean(-1), torch.zeros_like(choices, dtype=returns.dtype)), known
