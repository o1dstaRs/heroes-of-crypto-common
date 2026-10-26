"""Research board-aware proposal model. Shared state encoding runs once per decision."""
from __future__ import annotations

import torch
from torch import Tensor, nn
from torch.nn import functional as F


class A19ProposalModel(nn.Module):
    def __init__(self, entity_width: int, candidate_width: int, global_width: int, hidden: int = 96) -> None:
        super().__init__()
        self.entity = nn.Sequential(nn.Linear(entity_width, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU())
        self.terrain = nn.Sequential(nn.Linear(16 * 16 * 5, 64), nn.ReLU())
        self.context = nn.Sequential(nn.Linear(hidden * 5 + global_width + 64, 128), nn.ReLU())
        self.candidate = nn.Sequential(nn.Linear(128 + hidden + candidate_width, 128), nn.ReLU(), nn.Linear(128, 64), nn.ReLU())
        self.policy = nn.Linear(64, 1)
        self.primary = nn.Linear(64, 1)
        self.value = nn.Sequential(nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1))

    @staticmethod
    def _pool(encoded: Tensor, mask: Tensor) -> Tensor:
        count = mask.sum(1, keepdim=True).clamp_min(1)
        mean = (encoded * mask[:, :, None]).sum(1) / count
        maximum = encoded.masked_fill(~mask[:, :, None], -torch.inf).amax(1)
        maximum = torch.where(mask.any(1, keepdim=True), maximum, torch.zeros_like(maximum))
        return torch.cat([mean, maximum], -1)

    def forward(self, entities: Tensor, entity_mask: Tensor, globals_: Tensor, terrain: Tensor,
                actor_index: Tensor, candidates: Tensor, target_index: Tensor) -> tuple[Tensor, Tensor, Tensor]:
        encoded = self.entity(entities)
        own = entity_mask & (entities[:, :, 0] > 0.5)
        enemy = entity_mask & ~own
        batch = torch.arange(entities.shape[0], device=entities.device)
        actor = encoded[batch, actor_index]
        terrain_embedding = self.terrain(F.one_hot(terrain.long(), 5).float().flatten(1))
        context = self.context(torch.cat([self._pool(encoded, own), self._pool(encoded, enemy), actor, globals_, terrain_embedding], -1))
        target = encoded[batch[:, None], target_index.clamp_min(0)]
        target = target * (target_index >= 0)[:, :, None]
        shared = context[:, None, :].expand(-1, candidates.shape[1], -1)
        features = self.candidate(torch.cat([shared, target, candidates], -1))
        return self.policy(features).squeeze(-1), self.value(context).squeeze(-1), self.primary(features).squeeze(-1)


def a19_proposal_loss(logits: Tensor, value_logits: Tensor, primary_logits: Tensor, teacher_samples: Tensor,
                      candidate_mask: Tensor, outcomes: Tensor, selected_indices: Tensor | None = None,
                      action_mask: Tensor | None = None) -> tuple[Tensor, dict[str, Tensor]]:
    """Fit action advantage, down-weight uncertain comparisons, and fit true completed-game outcomes.

    Samples are paired by rollout index. Unscored/illegal candidates use candidate_mask=False,
    never an invented losing score. Padding is replaced BEFORE arithmetic to avoid NaN gradients.
    """
    samples = torch.where(candidate_mask[:, :, None], teacher_samples, torch.zeros_like(teacher_samples))
    if not bool(candidate_mask[:, 0].all()):
        raise ValueError("every training decision needs a scored anchor")
    differences = samples - samples[:, :1]
    advantage = differences.mean(-1)
    stderr = differences.std(-1, correction=1) / (samples.shape[-1] ** 0.5)
    weights = (1 / (0.05 + stderr)).clamp(max=8) * candidate_mask
    # A19 uses secondary material and tactical guards when win estimates tie. The policy must be free
    # to learn that preference; regressing these same logits to zero advantage would flatten it away.
    predicted = primary_logits - primary_logits[:, :1]
    regression = (F.smooth_l1_loss(predicted, advantage, reduction="none") * weights).sum() / weights.sum().clamp_min(1)
    # A heuristic noise filter for the auxiliary ordering target; held-out games determine strength.
    decisive = candidate_mask & (advantage.abs() > torch.maximum(torch.full_like(stderr, 0.01), 1.64 * stderr))
    ordering = (F.softplus(-predicted * advantage.sign()) * decisive).sum() / decisive.sum().clamp_min(1)
    value = F.binary_cross_entropy_with_logits(value_logits, outcomes)
    policy = logits.sum() * 0
    if selected_indices is not None:
        if action_mask is None:
            raise ValueError("Policy distillation needs the full legal action mask")
        policy = F.cross_entropy(logits.masked_fill(~action_mask, -torch.inf), selected_indices)
    total = regression + 0.1 * ordering + 0.25 * value + policy
    return total, {"advantageLoss": regression.detach(), "orderingLoss": ordering.detach(), "valueLoss": value.detach(), "policyLoss": policy.detach()}
