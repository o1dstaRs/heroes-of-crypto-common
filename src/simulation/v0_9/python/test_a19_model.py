"""CPU tensor checks only; the actual campaign learner must pass the exact RTX 5090 preflight."""
import unittest
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import torch

from a19_model import A19ProposalModel, a19_proposal_loss
from a19_train import collate, evaluate

torch.set_num_threads(1)


class A19ModelTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(1)
        self.model = A19ProposalModel(9, 7, 6, hidden=8)
        self.entities = torch.randn(2, 5, 9)
        self.entities[:, :, 0] = torch.tensor([1, 1, 0, 0, 0])
        self.mask = torch.tensor([[True, True, True, True, False], [True, True, False, False, False]])
        self.globals = torch.randn(2, 6)
        self.terrain = torch.zeros(2, 256, dtype=torch.int64)
        self.actor = torch.tensor([0, 1])
        self.candidates = torch.randn(2, 3, 7)
        self.targets = torch.tensor([[2, -1, 3], [0, -1, 1]])

    def forward(self, entities=None, mask=None, actor=None, targets=None):
        return self.model(self.entities if entities is None else entities,
                          self.mask if mask is None else mask, self.globals, self.terrain,
                          self.actor if actor is None else actor, self.candidates,
                          self.targets if targets is None else targets)

    def test_permutation_and_padding_do_not_change_decisions(self):
        scores, value, primary = self.forward()
        permutation = torch.tensor([3, 0, 4, 1, 2])
        inverse = permutation.argsort()
        target = torch.where(self.targets >= 0, inverse[self.targets.clamp_min(0)], -1)
        permuted, permuted_value, permuted_primary = self.forward(self.entities[:, permutation], self.mask[:, permutation], inverse[self.actor], target)
        torch.testing.assert_close(scores, permuted)
        torch.testing.assert_close(value, permuted_value)
        torch.testing.assert_close(primary, permuted_primary)
        changed = self.entities.clone()
        changed[~self.mask] = 10000
        # Padding must not be referenced as a real action target.
        masked_scores, masked_value, masked_primary = self.forward(changed)
        torch.testing.assert_close(scores, masked_scores)
        torch.testing.assert_close(value, masked_value)
        torch.testing.assert_close(primary, masked_primary)

    def test_masked_nan_targets_have_finite_loss_and_gradients(self):
        scores, value, primary = self.forward()
        valid = torch.tensor([[True, True, False], [True, True, False]])
        samples = torch.tensor([[[0.5, 0.5, 0.5, 0.5], [1, 1, 1, 1], [float("nan")] * 4]] * 2)
        loss, _ = a19_proposal_loss(scores, value, primary, samples, valid, torch.tensor([1.0, 0.5]), torch.ones(2, dtype=torch.long), valid)
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertTrue(all(parameter.grad is not None and torch.isfinite(parameter.grad).all() for parameter in self.model.parameters()))

    def test_fits_a_reliable_action_advantage(self):
        optimizer = torch.optim.Adam(self.model.parameters(), lr=0.01)
        valid = torch.ones(2, 3, dtype=torch.bool)
        samples = torch.tensor([[[0.5] * 4, [1.0] * 4, [0.0] * 4]] * 2)
        for _ in range(40):
            optimizer.zero_grad()
            logits, value, primary = self.forward()
            loss, _ = a19_proposal_loss(logits, value, primary, samples, valid, torch.ones(2))
            loss.backward()
            optimizer.step()
        _, _, logits = self.forward()
        self.assertTrue((logits[:, 1] > logits[:, 0]).all())
        self.assertTrue((logits[:, 0] > logits[:, 2]).all())

    def test_campaign_learner_refuses_unbound_gpu_without_creating_output(self):
        with tempfile.TemporaryDirectory() as folder:
            campaign = Path(folder) / "campaign"
            output = campaign / "models" / "run"
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("a19_train.py")),
                                     "--campaign", str(campaign), "--repository", folder, "--out", str(output)],
                                    text=True, capture_output=True, env={**os.environ, "CUDA_VISIBLE_DEVICES": ""})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("approved RTX 5090 UUID", result.stderr)
            self.assertFalse(output.exists())

    def test_integer_json_outcomes_and_unscored_catalog_actions_survive_the_full_batch_path(self):
        rows = []
        for i, outcome in enumerate([0, 1]):
            rows.append({"outcome": outcome, "selectedIndex": 1,
                         "observation": {"entities": self.entities[i, :3].tolist(), "globals": [0] * 6,
                                         "terrain": self.terrain[i].tolist(), "actorIndex": 0,
                                         "candidates": [{"features": self.candidates[i, j].tolist(), "targetIndex": -1}
                                                        for j in range(3)]},
                         "samples": [[{"index": k, "value": value} for k in range(4)]
                                     for value in [0.5, 1.0]] + [None]})
        rows = json.loads(json.dumps(rows))
        inputs, samples, mask, outcomes, selected, action_mask = collate(rows, torch.device("cpu"))
        self.assertEqual(outcomes.dtype, torch.float32)
        self.assertTrue(action_mask.all())
        self.assertFalse(mask[:, 2].any())
        logits, value, primary = self.model(*inputs)
        loss, _ = a19_proposal_loss(logits, value, primary, samples, mask, outcomes, selected, action_mask)
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertTrue(all(p.grad is not None and torch.isfinite(p.grad).all() for p in self.model.parameters()))
        metrics = evaluate(self.model, rows, torch.device("cpu"), 2)
        self.assertEqual(metrics["decisions"], 2)
        self.assertTrue(all(math.isfinite(value) for value in metrics.values()))

        # The same real-data path must accept the new eight-sample teacher without truncation.
        for row in rows:
            for bank in row["samples"]:
                if bank is not None:
                    bank.extend({"index": k, "value": bank[0]["value"]} for k in range(4, 8))
        self.assertEqual(collate(rows, torch.device("cpu"))[1].shape[-1], 8)

    def test_tied_win_estimates_do_not_penalize_the_teachers_policy_preference(self):
        policy = torch.zeros(2, 3, requires_grad=True)
        primary = torch.zeros(2, 3, requires_grad=True)
        values = torch.zeros(2, requires_grad=True)
        samples = torch.full((2, 3, 8), 0.5)
        mask = torch.ones(2, 3, dtype=torch.bool)
        loss, terms = a19_proposal_loss(policy, values, primary, samples, mask, torch.ones(2),
                                        torch.ones(2, dtype=torch.long), mask)
        loss.backward()
        self.assertEqual(float(terms["advantageLoss"]), 0)
        self.assertTrue((primary.grad == 0).all())
        self.assertTrue((policy.grad[:, 1] < 0).all())
        self.assertTrue((policy.grad[:, 0] > 0).all())


if __name__ == "__main__":
    unittest.main()
