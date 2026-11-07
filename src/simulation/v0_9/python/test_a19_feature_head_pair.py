"""Joint-head capability, atomic restoration and complete pair identity checks."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

import torch

from a19_model import A19ProposalModel
from a19_feature_adapter import paired_score_difference_loss, served_gate_choices, served_policy
from a19_feature_head_pair import A19PolicyHeadPair, export_head_pair
from a19_feature_pair_format import make_head_pair_finalist_lock, policy_head_sha256

torch.set_num_threads(2)


class HeadPairTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(41)
        self.artifacts = [{"weights": {name: p.tolist() for name, p in A19ProposalModel(9, 2, 1).state_dict().items()}}
                          for _ in range(2)]
        self.inputs = [torch.randn(1, 3, 9), torch.ones(1, 3, dtype=torch.bool), torch.randn(1, 1),
                       torch.zeros(1, 256, dtype=torch.long), torch.tensor([0]),
                       torch.tensor([[[1., 0.], [0., 1.]]]), torch.tensor([[-1, -1]])]
        self.legal = torch.ones(1, 2, dtype=torch.bool)

    def pair(self, mode="joint"):
        return A19PolicyHeadPair(*self.artifacts, 9, 2, 1, train_members=mode)

    def step(self, pair):
        returns = torch.tensor([[[0.] * 8, [1.] * 8]])
        loss, _ = paired_score_difference_loss(pair.served(self.inputs, self.legal), torch.tensor([[0, 1]]),
                                              returns, self.legal, score_scale=.1)
        optimizer = torch.optim.SGD([p for p in pair.parameters() if p.requires_grad], lr=.001)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        return loss

    def test_exact_initialization_and_only_declared_heads_train(self):
        rng = torch.random.get_rng_state().clone()
        with patch.object(torch.cuda, "manual_seed_all", side_effect=AssertionError("CPU construction touched CUDA RNG")):
            pair = self.pair()
        self.assertTrue(torch.equal(rng, torch.random.get_rng_state()))
        self.assertEqual(sum(p.numel() for p in pair.parameters() if p.requires_grad), 130)
        self.assertEqual(sum(p.numel() for p in self.pair("student").parameters() if p.requires_grad), 65)
        self.assertEqual(sum(p.numel() for p in self.pair("frozen").parameters() if p.requires_grad), 0)
        frozen = self.pair("frozen")
        self.assertTrue(torch.equal(pair.served(self.inputs, self.legal), frozen.served(self.inputs, self.legal)))
        self.assertNotEqual(pair.student.policy.weight.data_ptr(), pair.partner.policy.weight.data_ptr())
        self.step(pair)
        for role, model in pair.members():
            self.assertGreater(float(model.policy.weight.grad.abs().sum()), 0, role)
            self.assertNotEqual(policy_head_sha256({k: v.tolist() for k, v in model.state_dict().items()}), pair._initial_heads[role])
        pair.check_frozen_parameters()

    def test_complete_checkpoint_restores_both_heads_and_is_independent(self):
        pair = self.pair()
        self.step(pair)
        snapshot = pair.checkpoint()
        expected = pair.served(self.inputs, self.legal).detach().clone()
        self.step(pair)
        self.assertFalse(torch.equal(expected, pair.served(self.inputs, self.legal)))
        pair.restore(snapshot)
        self.assertTrue(torch.equal(expected, pair.served(self.inputs, self.legal)))
        wrong = copy.deepcopy(snapshot)
        wrong["partner.entity.0.bias"][0] += 1
        with self.assertRaisesRegex(ValueError, "frozen"):
            pair.restore(wrong)
        self.assertTrue(torch.equal(expected, pair.served(self.inputs, self.legal)))
        with self.assertRaisesRegex(ValueError, "incomplete"):
            pair.restore({k: v for k, v in snapshot.items() if not k.startswith("partner.")})
        self.assertTrue(torch.equal(expected, pair.served(self.inputs, self.legal)))

    def test_student_control_keeps_partner_exact_and_detects_frozen_mutations(self):
        pair = self.pair("student")
        initial = {k: v.clone() for k, v in pair.partner.state_dict().items()}
        self.step(pair)
        self.assertTrue(all(torch.equal(initial[k], v) for k, v in pair.partner.state_dict().items()))
        pair.check_frozen_parameters()
        with torch.no_grad():
            pair.partner.policy.bias.add_(1)
        with self.assertRaisesRegex(ValueError, "frozen"):
            pair.check_frozen_parameters()

    def test_both_heads_can_cross_a_gate_that_one_head_cannot_reach(self):
        for artifact in self.artifacts:
            for name, value in artifact["weights"].items():
                artifact["weights"][name] = torch.zeros_like(torch.tensor(value)).tolist()
            artifact["weights"]["candidate.0.weight"][0][-2] = 1.
            artifact["weights"]["candidate.0.weight"][1][-1] = 1.
            artifact["weights"]["candidate.2.weight"][0][0] = 1.
            artifact["weights"]["candidate.2.weight"][1][1] = 1.
        self.artifacts[1]["weights"]["policy.weight"][0][0] = 4.
        feature = torch.zeros(1, 2, 64)
        feature[0, 0, 0] = feature[0, 1, 1] = 1
        final = {}
        for mode in ["student", "joint"]:
            pair = self.pair(mode)
            with torch.no_grad():
                expected = served_policy(pair.student.policy(feature).squeeze(-1), pair.partner.policy(feature).squeeze(-1), self.legal)
                self.assertTrue(torch.equal(expected, pair.served(self.inputs, self.legal)))
            optimizer = torch.optim.Adam([p for p in pair.parameters() if p.requires_grad], lr=.05)
            for _ in range(160):
                logits = served_policy(pair.student.policy(feature).squeeze(-1), pair.partner.policy(feature).squeeze(-1), self.legal)
                loss, _ = paired_score_difference_loss(logits, torch.tensor([[0, 1]]),
                    torch.tensor([[[0.] * 8, [1.] * 8]]), self.legal, score_scale=.1)
                optimizer.zero_grad(); loss.backward(); optimizer.step()
            final[mode] = int(served_gate_choices(pair.served(self.inputs, self.legal), torch.tensor([0]), torch.tensor([[0, 1]]))[0])
            pair.check_frozen_parameters()
        self.assertEqual(final, {"student": 0, "joint": 1})

    def test_export_binds_both_files_and_legacy_consumers_cannot_use_one(self):
        pair = self.pair()
        self.step(pair)
        bundle = export_head_pair(pair, registration_sha256="a" * 64, trainer_sha256="b" * 64,
                                  observation_sha256="c" * 64, initial_student_sha256="d" * 64,
                                  initial_partner_sha256="e" * 64, recipe_ordinal=2, checkpoint_epoch=7,
                                  functional_fixture=True)
        manifest = json.loads(bundle["pair-manifest.json"])
        for role, member in manifest["members"].items():
            raw = json.loads(bundle[member["file"]])
            self.assertEqual(hashlib.sha256(bundle[member["file"]]).hexdigest(), member["sha256"])
            self.assertEqual(policy_head_sha256(raw["weights"]), member["headSha256"])
            self.assertNotEqual(member["initialHeadSha256"], member["headSha256"])
            self.assertEqual((raw["pairRole"], raw["recipeOrdinal"], raw["checkpointEpoch"]), (role, 2, 7))
        proof = {"weightsUpdated": True, "recipe": {"ordinal": 2, "trainingMembers": "joint"},
                 "pairManifestSha256": "f" * 64, "studentModelSha256": manifest["members"]["student"]["sha256"],
                 "partnerModelSha256": manifest["members"]["partner"]["sha256"]}
        lock = make_head_pair_finalist_lock(proof, {"kind": "score-difference", "scoreScale": .1})
        self.assertNotIn("modelSha256", lock)
        with self.assertRaises(KeyError):
            _ = lock["modelSha256"]
        with self.assertRaises(ValueError):
            make_head_pair_finalist_lock({**proof, "partnerModelSha256": "missing"}, {})


if __name__ == "__main__":
    unittest.main()
