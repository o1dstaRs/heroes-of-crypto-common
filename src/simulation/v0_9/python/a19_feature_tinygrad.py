"""Optional Tinygrad 0.14 policy-head backend; no device or job starts on import.

The original backbones stay frozen. Cache their exact candidate-head inputs once,
then optimize the existing two 64-to-1 heads. Export retains the ordinary A19 CPU
architecture. Hardware admission and strength qualification belong to the caller.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from tinygrad import Tensor, dtypes

from a19_feature_pair_format import encode_head_pair, policy_head_sha256


def pack_observations(observations: list[dict], widths: tuple[int, int, int]) -> dict[str, np.ndarray]:
    if not observations:
        raise ValueError("empty Tinygrad observation bank")
    ew, cw, gw = widths
    batch, entities, candidates = len(observations), max(len(o["entities"]) for o in observations), max(len(o["candidates"]) for o in observations)
    if entities < 1 or candidates < 1:
        raise ValueError("empty Tinygrad legal catalog")
    x = np.zeros((batch, entities, ew), np.float32)
    mask = np.zeros((batch, entities), bool)
    globals_ = np.zeros((batch, gw), np.float32)
    terrain = np.zeros((batch, 256, 5), np.float32)
    actor = np.zeros((batch, entities), np.float32)
    target = np.zeros((batch, candidates, entities), np.float32)
    features = np.zeros((batch, candidates, cw), np.float32)
    legal = np.zeros((batch, candidates), bool)
    for row, o in enumerate(observations):
        n, c = len(o["entities"]), len(o["candidates"])
        if n < 1 or c < 1 or not 0 <= o["actorIndex"] < n or len(o["globals"]) != gw or len(o["terrain"]) != 256:
            raise ValueError("invalid Tinygrad observation shape")
        x[row, :n] = np.asarray(o["entities"], np.float32)
        mask[row, :n] = True
        globals_[row] = np.asarray(o["globals"], np.float32)
        tiles = np.asarray(o["terrain"])
        if not np.issubdtype(tiles.dtype, np.integer) or not np.isin(tiles, np.arange(5)).all():
            raise ValueError("invalid Tinygrad terrain")
        terrain[row, np.arange(256), tiles] = 1
        actor[row, o["actorIndex"]] = 1
        for index, candidate in enumerate(o["candidates"]):
            if len(candidate["features"]) != cw or not -1 <= candidate["targetIndex"] < n:
                raise ValueError("invalid Tinygrad candidate")
            features[row, index] = candidate["features"]
            legal[row, index] = True
            if candidate["targetIndex"] >= 0:
                target[row, index, candidate["targetIndex"]] = 1
    result = {"entities": x, "mask": mask, "globals": globals_, "terrain": terrain.reshape(batch, -1),
              "actor": actor, "target": target, "candidates": features, "legal": legal}
    if not all(np.isfinite(array).all() for array in result.values()):
        raise ValueError("nonfinite Tinygrad observation")
    return result


def served_log_policy(left: Tensor, right: Tensor, legal: Tensor) -> Tensor:
    a = legal.where(left, -1e9).log_softmax(axis=-1)
    b = legal.where(right, -1e9).log_softmax(axis=-1)
    maximum = a.maximum(b).detach()
    return maximum + ((a - maximum).exp() + (b - maximum).exp()).log() - math.log(2)


def clipped_parameter_gradients(loss: Tensor, parameters: list[Tensor], *, maximum_norm: float = 1.,
                                epsilon: float = 1e-6) -> Tensor:
    """Overwrite only selected FP32 gradients and clip on their device, without host copies.

    Tinygrad 0.14 backward() targets all live floating tensors, including board
    inputs. Explicit targets avoid unused input gradients and boolean-mask paths.
    The returned norm is lazy; realize diagnostics together with optimizer updates.
    This does not accumulate gradients or choose a training/promotion recipe.
    """
    if not parameters or len({id(p) for p in parameters}) != len(parameters):
        raise ValueError("declare unique trainable Tinygrad parameters")
    if any(not p.is_param or p.dtype != dtypes.float32 or p.device != parameters[0].device for p in parameters):
        raise ValueError("clipping requires trainable float32 parameters on one device")
    if not math.isfinite(maximum_norm) or maximum_norm <= 0 or not math.isfinite(epsilon) or epsilon <= 0:
        raise ValueError("invalid Tinygrad gradient-clipping bounds")
    gradients = loss.gradient(*parameters)
    norm = Tensor.stack(*[gradient.square().sum() for gradient in gradients]).sum().sqrt()
    coefficient = (maximum_norm / (norm + epsilon)).minimum(1)
    for parameter, gradient in zip(parameters, gradients):
        parameter.grad = gradient * coefficient
    return norm


class TinyA19HeadPair:
    def __init__(self, student: dict[str, Any], partner: dict[str, Any], widths: tuple[int, int, int],
                 *, device: str, train_members: str = "joint") -> None:
        if not device or train_members not in ["student", "joint"]:
            raise ValueError("declare a Tinygrad device and head-pair training mode")
        self.device, self.train_members, self.widths = device, train_members, widths
        ew, cw, gw = widths
        shapes = {"entity.0": (96, ew), "entity.2": (96, 96), "terrain.0": (64, 1280),
                  "context.0": (128, 96 * 5 + gw + 64), "candidate.0": (128, 128 + 96 + cw),
                  "candidate.2": (64, 128), "policy": (1, 64), "primary": (1, 64),
                  "value.0": (64, 128), "value.2": (1, 64)}
        self.models, self.initial, self.parameters = {}, {}, []
        for role, raw in [("student", student), ("partner", partner)]:
            weights = raw["weights"]
            if set(weights) != {name + suffix for name in shapes for suffix in [".weight", ".bias"]}:
                raise ValueError("Tinygrad parameter names do not match original A19")
            self.models[role], self.initial[role] = {}, {}
            for name, (output, input_) in shapes.items():
                for suffix, shape in [(".weight", (output, input_)), (".bias", (output,))]:
                    key = name + suffix
                    array = np.asarray(weights[key], np.float32)
                    if array.shape != shape or not np.isfinite(array).all():
                        raise ValueError("invalid Tinygrad A19 layer: " + key)
                    self.initial[role][key] = array.copy()
                    parameter = name == "policy" and (role == "student" or train_members == "joint")
                    tensor = Tensor(array.copy(), device=device).is_param_(parameter)
                    self.models[role][key] = tensor
                    if parameter:
                        self.parameters.append(tensor)
        self.initial_heads = {role: policy_head_sha256({k: v.tolist() for k, v in weights.items()})
                              for role, weights in self.initial.items()}

    def _dense(self, role: str, name: str, value: Tensor, relu: bool = False) -> Tensor:
        weights = self.models[role]
        result = value.matmul(weights[name + ".weight"].T) + weights[name + ".bias"]
        return result.relu() if relu else result

    @staticmethod
    def _pool(encoded: Tensor, mask: Tensor) -> Tensor:
        count = mask.cast(dtypes.float32).sum(axis=1, keepdim=True)
        mean = (encoded * mask.unsqueeze(-1)).sum(axis=1) / count.maximum(1)
        maximum = mask.unsqueeze(-1).where(encoded, -1e9).max(axis=1)
        maximum = (count > 0).where(maximum, 0)
        return Tensor.cat(mean, maximum, dim=-1)

    def cache(self, observations: list[dict]) -> dict[str, Any]:
        arrays = pack_observations(observations, self.widths)
        x = {name: Tensor(array.copy(), device=self.device) for name, array in arrays.items()}
        own = x["mask"] & (x["entities"][:, :, 0] > .5)
        enemy = x["mask"] & ~own
        batch, count = arrays["legal"].shape
        features, contexts = [], []
        for role in ["student", "partner"]:
            encoded = self._dense(role, "entity.2", self._dense(role, "entity.0", x["entities"], True), True)
            actor = (encoded * x["actor"].unsqueeze(-1)).sum(axis=1)
            terrain = self._dense(role, "terrain.0", x["terrain"], True)
            context = self._dense(role, "context.0", Tensor.cat(self._pool(encoded, own), self._pool(encoded, enemy), actor, x["globals"], terrain, dim=-1), True)
            target = x["target"].matmul(encoded)
            candidate = Tensor.cat(context.reshape(batch, 1, 128).expand(batch, count, 128), target, x["candidates"], dim=-1)
            feature = self._dense(role, "candidate.2", self._dense(role, "candidate.0", candidate, True), True)
            features.append(feature.realize().detach())
            contexts.append(context.realize().detach())
        return {"features": features, "contexts": contexts, "legal": x["legal"], "legalArray": arrays["legal"]}

    def policy(self, cache: dict[str, Any]) -> Tensor:
        left, right = [self._dense(role, "policy", feature).squeeze(-1)
                       for role, feature in zip(["student", "partner"], cache["features"])]
        return served_log_policy(left, right, cache["legal"])

    def predictions(self, cache: dict[str, Any]) -> list[dict[str, np.ndarray]]:
        result = []
        for role, feature, context in zip(["student", "partner"], cache["features"], cache["contexts"]):
            result.append({"policy": self._dense(role, "policy", feature).squeeze(-1).numpy(),
                           "primary": self._dense(role, "primary", feature).squeeze(-1).numpy(),
                           "valueLogit": self._dense(role, "value.2", self._dense(role, "value.0", context, True)).squeeze(-1).numpy()})
        return result

    def score_loss(self, cache: dict[str, Any], actions: np.ndarray, returns: np.ndarray, mask: np.ndarray,
                   *, score_scale: float) -> Tensor:
        if not math.isfinite(score_scale) or score_scale <= 0 or actions.shape != mask.shape or returns.shape[:2] != mask.shape or returns.shape[-1] == 0:
            raise ValueError("invalid Tinygrad score-difference targets")
        if mask.dtype != bool or not (mask.sum(-1) >= 2).all() or not np.isin(returns[mask], [0, .5, 1]).all():
            raise ValueError("Tinygrad score differences need complete labeled actions")
        batch, count = cache["legalArray"].shape
        if actions.shape[0] != batch or not ((actions[mask] >= 0) & (actions[mask] < count)).all():
            raise ValueError("Tinygrad action outside catalog")
        selector = np.zeros((batch, actions.shape[1], count), np.float32)
        for row, column in zip(*np.where(mask)):
            index = actions[row, column]
            if not cache["legalArray"][row, index]:
                raise ValueError("Tinygrad target is not a legal action")
            selector[row, column, index] = 1
        means = np.where(mask[:, :, None], returns, 0).astype(np.float32).mean(-1)
        informative = np.where(mask, means, -np.inf).max(-1) > np.where(mask, means, np.inf).min(-1)
        included = (mask[:, :, None] & mask[:, None, :]) & np.triu(np.ones((actions.shape[1], actions.shape[1]), bool), 1)
        included &= informative[:, None, None]
        target = (means[:, :, None] - means[:, None, :]) / score_scale
        if not np.isfinite(target).all():
            raise ValueError("Tinygrad score targets overflowed")
        chosen = (self.policy(cache).unsqueeze(1) * Tensor(selector, device=self.device)).sum(axis=-1)
        errors = (chosen.unsqueeze(2) - chosen.unsqueeze(1) - Tensor(target, device=self.device)).square()
        per_root = (errors * Tensor(included, device=self.device)).sum(axis=(1, 2)) / Tensor(included.sum((1, 2)).clip(1).astype(np.float32), device=self.device)
        return per_root.sum() / max(1, int(informative.sum()))

    def check_frozen_parameters(self) -> None:
        for role, weights in self.models.items():
            for name, tensor in weights.items():
                trainable = name.startswith("policy.") and (role == "student" or self.train_members == "joint")
                if bool(tensor.is_param) != trainable:
                    raise ValueError("Tinygrad trainable parameter set changed")
                if not trainable and not np.array_equal(tensor.numpy(), self.initial[role][name]):
                    raise ValueError("Tinygrad frozen parameter changed: " + role + "/" + name)

    def export(self, **identity) -> dict[str, bytes]:
        self.check_frozen_parameters()
        weights = [{name: tensor.numpy().tolist() for name, tensor in self.models[role].items()}
                   for role in ["student", "partner"]]
        return encode_head_pair(*weights, initial_heads=self.initial_heads, train_members=self.train_members, **identity)
