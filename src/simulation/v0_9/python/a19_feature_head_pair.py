"""Research policy-head pair with atomic checkpoints and unchanged serving layers."""
from __future__ import annotations

from typing import Any

import torch
from torch import Tensor, nn

from a19_model import A19ProposalModel
from a19_feature_adapter import served_policy
from a19_feature_pair_format import encode_head_pair, policy_head_sha256


class A19PolicyHeadPair(nn.Module):
    def __init__(self, student: dict[str, Any], partner: dict[str, Any],
                 entity_width: int, candidate_width: int, global_width: int,
                 *, train_members: str = "joint") -> None:
        super().__init__()
        if train_members not in ["frozen", "student", "joint"]:
            raise ValueError("unknown head-pair training members")
        self.train_members = train_members
        self.widths = (entity_width, candidate_width, global_width)
        with torch.device("cpu"), torch.random.fork_rng(devices=[]):
            torch.set_rng_state(torch.Generator(device="cpu").manual_seed(0).get_state())
            self.student = A19ProposalModel(*self.widths)
            self.partner = A19ProposalModel(*self.widths)
        for model, artifact in [(self.student, student), (self.partner, partner)]:
            weights = artifact.get("weights")
            if not isinstance(weights, dict) or set(weights) != set(model.state_dict()):
                raise ValueError("head-pair initialization has incompatible parameter names")
            state = {}
            for name, expected in model.state_dict().items():
                value = torch.tensor(weights[name], dtype=expected.dtype, device="cpu")
                if value.shape != expected.shape or not bool(torch.isfinite(value).all()):
                    raise ValueError("head-pair initialization has invalid parameter: " + name)
                state[name] = value
            model.load_state_dict(state, strict=True)
        self.eval().requires_grad_(False)
        if train_members != "frozen":
            self.student.policy.requires_grad_(True)
        if train_members == "joint":
            self.partner.policy.requires_grad_(True)
        self._trainable = {name for name, p in self.named_parameters() if p.requires_grad}
        self._frozen = {name: p.detach().cpu().clone() for name, p in self.named_parameters() if not p.requires_grad}
        self._initial_heads = {role: head_sha256(model) for role, model in self.members()}

    def members(self) -> tuple[tuple[str, A19ProposalModel], ...]:
        return (("student", self.student), ("partner", self.partner))

    def forward(self, entities: Tensor, entity_mask: Tensor, globals_: Tensor, terrain: Tensor,
                actor_index: Tensor, candidates: Tensor, target_index: Tensor) -> tuple[tuple[Tensor, ...], ...]:
        if entities.shape[-1] != self.widths[0] or candidates.shape[-1] != self.widths[1] or globals_.shape[-1] != self.widths[2]:
            raise ValueError("head-only pair requires the declared original feature widths")
        inputs = (entities, entity_mask, globals_, terrain, actor_index, candidates, target_index)
        return self.student(*inputs), self.partner(*inputs)

    def served(self, inputs: list[Tensor], legal: Tensor) -> Tensor:
        left, right = self(*inputs)
        return served_policy(left[0], right[0], legal)

    def check_frozen_parameters(self) -> None:
        actual = dict(self.named_parameters())
        if {name for name, p in actual.items() if p.requires_grad} != self._trainable:
            raise ValueError("head-pair trainable parameter set changed")
        for name, expected in self._frozen.items():
            if not torch.equal(actual[name].detach().cpu(), expected):
                raise ValueError("head-pair frozen parameter changed: " + name)

    def checkpoint(self) -> dict[str, Tensor]:
        """One independent snapshot always includes both complete members."""
        self.check_frozen_parameters()
        return {name: value.detach().cpu().clone() for name, value in self.state_dict().items()}

    def restore(self, checkpoint: dict[str, Tensor]) -> None:
        actual = self.state_dict()
        if set(checkpoint) != set(actual):
            raise ValueError("incomplete head-pair checkpoint")
        for name, value in checkpoint.items():
            if not isinstance(value, Tensor) or value.shape != actual[name].shape or value.dtype != actual[name].dtype or not bool(torch.isfinite(value).all()):
                raise ValueError("invalid head-pair checkpoint parameter: " + name)
            if name in self._frozen and not torch.equal(value.detach().cpu(), self._frozen[name]):
                raise ValueError("head-pair checkpoint changed a frozen parameter: " + name)
        self.load_state_dict(checkpoint, strict=True)
        self.check_frozen_parameters()


def head_sha256(model: A19ProposalModel) -> str:
    """Portable little-endian float32 identity, independent of JSON number spelling."""
    return policy_head_sha256({"policy.weight": model.policy.weight.detach().cpu().tolist(),
                               "policy.bias": model.policy.bias.detach().cpu().tolist()})


def export_head_pair(pair: A19PolicyHeadPair, *, registration_sha256: str, trainer_sha256: str,
                     observation_sha256: str, initial_student_sha256: str, initial_partner_sha256: str,
                     recipe_ordinal: int, checkpoint_epoch: int, functional_fixture: bool = False) -> dict[str, bytes]:
    pair.check_frozen_parameters()
    weights = [{name: value.detach().cpu().tolist() for name, value in model.state_dict().items()}
               for _, model in pair.members()]
    return encode_head_pair(*weights, initial_heads=pair._initial_heads, train_members=pair.train_members,
                            registration_sha256=registration_sha256, trainer_sha256=trainer_sha256,
                            observation_sha256=observation_sha256, initial_student_sha256=initial_student_sha256,
                            initial_partner_sha256=initial_partner_sha256, recipe_ordinal=recipe_ordinal,
                            checkpoint_epoch=checkpoint_epoch, functional_fixture=functional_fixture)
