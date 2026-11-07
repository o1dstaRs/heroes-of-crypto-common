"""CPU functional tests; no campaign data fitting, games or GPU allocation."""
import copy
import unittest

import torch
from torch.nn import functional as F

from a19_model import A19ProposalModel
from a19_feature_adapter import (A19FeatureAdapterModel, paired_gate_gain, paired_root_loss, roots_with_terminal_contrast,
                                 served_gate_choices, served_policy)

torch.set_num_threads(2)


class FeatureAdapterTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(62)
        self.old = A19ProposalModel(9, 7, 6).eval()
        self.artifact = {"weights": {k: v.tolist() for k, v in self.old.state_dict().items()}}
        self.entities = torch.randn(2, 5, 17)
        self.entities[:, :, 0] = torch.tensor([1, 1, 0, 0, 0])
        self.mask = torch.tensor([[True, True, True, True, False], [True, True, True, True, False]])
        self.inputs = [self.entities, self.mask, torch.randn(2, 6), torch.zeros(2, 256, dtype=torch.long),
                       torch.tensor([0, 1]), torch.randn(2, 3, 7),
                       torch.tensor([[2, -1, 3], [0, -1, 1]])]
        self.legal = torch.ones(2, 3, dtype=torch.bool)

    def model(self, rank=4):
        return A19FeatureAdapterModel.from_artifact(self.artifact, 17, 7, 6, rank=rank, seed=19, base_width=9)

    def update(self, model):
        partner = self.old(self.entities[:, :, :9], *self.inputs[1:])[0].detach()
        optimizer = torch.optim.SGD([p for p in model.parameters() if p.requires_grad], lr=2)
        loss = F.nll_loss(served_policy(model(*self.inputs)[0], partner, self.legal), torch.tensor([1, 2]))
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

    def test_exact_zero_extension_and_control(self):
        expected = self.old(self.entities[:, :, :9], *self.inputs[1:])
        for rank in [0, 4]:
            model = self.model(rank)
            actual = model(*self.inputs)
            for a, b in zip(expected, actual):
                torch.testing.assert_close(a, b, atol=2e-6, rtol=2e-6)
            self.assertEqual(sum(p.numel() for p in model.parameters() if p.requires_grad),
                             65 if rank == 0 else 65 + 4 * (8 + 96))

    def test_extension_receives_gradient_and_changes_predictions(self):
        model = self.model()
        before = [x.detach().clone() for x in model(*self.inputs)]
        changed = [x.clone() for x in self.inputs]
        changed[0][:, :, 9:] += 7
        for a, b in zip(before, model(*changed)):
            self.assertTrue(torch.equal(a, b), "zero adapter must initially ignore extension")
        self.update(model)
        self.assertGreater(float(model.entity[0].up.grad.abs().sum()), 0)
        self.assertTrue(torch.isfinite(model.entity[0].up.grad).all())
        self.assertTrue(model.entity[0].down.grad.eq(0).all(), "input factor learns after output wakes up")
        after = model(*self.inputs)[0]
        self.assertGreater(float((after - model(*changed)[0]).abs().max().detach()), 1e-7)
        self.update(model)
        self.assertGreater(float(model.entity[0].down.grad.abs().sum()), 0)

    def test_only_declared_parameters_can_change(self):
        model = self.model()
        before = {k: v.clone() for k, v in model.named_parameters() if not v.requires_grad}
        self.update(model)
        model.check_frozen_parameters()
        for name, value in model.named_parameters():
            if name in before:
                self.assertTrue(torch.equal(value, before[name]))
        with torch.no_grad():
            model.context[0].bias.add_(.1)
        with self.assertRaisesRegex(ValueError, "frozen parameter changed"):
            model.folded_state_dict()

    def test_fold_export_has_original_architecture_and_predictions(self):
        model = self.model()
        for _ in range(3):
            self.update(model)
        folded = model.folded_model()
        self.assertEqual(set(folded.state_dict()), set(self.old.state_dict()))
        self.assertGreater(int(folded.entity[0].weight[:, 9:].ne(0).sum()), 0)
        for a, b in zip(model(*self.inputs), folded(*self.inputs)):
            torch.testing.assert_close(a, b, atol=2e-6, rtol=2e-5)

    def test_model_construction_and_export_preserve_batch_rng(self):
        before = torch.random.get_rng_state().clone()
        model = self.model()
        self.assertTrue(torch.equal(before, torch.random.get_rng_state()))
        model.folded_model()
        self.assertTrue(torch.equal(before, torch.random.get_rng_state()))

    def test_entity_permutation_and_padding_do_not_change_predictions(self):
        model = self.model()
        self.update(model)
        expected = model(*self.inputs)
        perm = torch.tensor([3, 0, 4, 1, 2])
        inverse = perm.argsort()
        columns = [x.clone() for x in self.inputs]
        columns[0] = columns[0][:, perm]
        columns[1] = columns[1][:, perm]
        columns[4] = inverse[columns[4]]
        columns[6] = torch.where(columns[6] >= 0, inverse[columns[6].clamp_min(0)], -1)
        for a, b in zip(expected, model(*columns)):
            torch.testing.assert_close(a, b, atol=2e-6, rtol=2e-5)
        columns = [x.clone() for x in self.inputs]
        columns[0][~columns[1]] = 10000
        for a, b in zip(expected, model(*columns)):
            torch.testing.assert_close(a, b)

    def test_invalid_initialization_fails_closed(self):
        for rank in [-1, 33, True]:
            with self.subTest(rank=rank), self.assertRaises(ValueError):
                self.model(rank)
        artifact = copy.deepcopy(self.artifact)
        artifact["weights"]["policy.bias"][0] = float("nan")
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            A19FeatureAdapterModel.from_artifact(artifact, 17, 7, 6, base_width=9)
        artifact = copy.deepcopy(self.artifact)
        del artifact["weights"]["policy.bias"]
        with self.assertRaisesRegex(ValueError, "weight names"):
            A19FeatureAdapterModel.from_artifact(artifact, 17, 7, 6, base_width=9)

    def test_probability_ensemble_masks_illegal_catalog_actions(self):
        student = torch.tensor([[0., 1., 100.]], requires_grad=True)
        partner = torch.tensor([[2., 0., 100.]])
        legal = torch.tensor([[True, True, False]])
        policy = served_policy(student, partner, legal)
        expected = (student[:, :2].softmax(-1) + partner[:, :2].softmax(-1)) / 2
        torch.testing.assert_close(policy[:, :2].exp(), expected)
        self.assertEqual(float(policy[:, 2].exp().detach()), 0)
        with self.assertRaises(ValueError):
            served_policy(student, partner, torch.zeros_like(legal))

    def test_complete_ties_do_not_invent_action_preferences(self):
        policy = torch.randn(2, 4, requires_grad=True).log_softmax(-1)
        policy.retain_grad()
        loss, details = paired_root_loss(policy, torch.tensor([[0, 1], [0, 2]]),
                                         torch.full((2, 2, 8), .5), torch.ones(2, 2, dtype=torch.bool))
        self.assertEqual(float(loss.detach()), 0)
        self.assertEqual(int(details["informativeRoots"]), 0)
        loss.backward()
        self.assertTrue(policy.grad.eq(0).all())

    def test_padding_is_not_a_negative_and_cannot_introduce_nan(self):
        policy = torch.tensor([[.1, .9, -20.]], requires_grad=True)
        actions = torch.tensor([[0, 1, 999]])
        returns = torch.tensor([[[0.] * 8, [1.] * 8, [float("nan")] * 8]])
        mask = torch.tensor([[True, True, False]])
        loss, info = paired_root_loss(policy, actions, returns, mask)
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(torch.isfinite(policy.grad).all())
        self.assertEqual(float(policy.grad[0, 2]), 0)
        self.assertEqual(int(info["nonTiedComparisons"]), 8)

    def test_diagnostics_keep_root_and_world_counts_distinct(self):
        policy = torch.tensor([[0., 1.], [2., 0.]])
        actions = torch.tensor([[0, 1], [0, 1]])
        returns = torch.tensor([[[0.] * 8, [1.] * 8], [[0.] * 8, [.5] + [0.] * 7]])
        loss, info = paired_root_loss(policy, actions, returns, torch.ones(2, 2, dtype=torch.bool))
        self.assertEqual(int(info["informativeRoots"]), 2)
        self.assertEqual(int(info["nonTiedComparisons"]), 9)
        self.assertNotAlmostEqual(float(loss), float(info["equalInformativeRootLoss"]), places=3)

    def test_equal_root_objective_and_gradient_do_not_reweight_repeated_worlds(self):
        actions = torch.tensor([[0, 1], [0, 1]])
        mask = torch.ones(2, 2, dtype=torch.bool)
        outcomes = torch.tensor([[[0.] * 8, [1.] * 8], [[0.] * 8, [.5] + [0.] * 7]])
        policy = torch.tensor([[0., 1.], [2., 0.]], requires_grad=True)
        balanced, info = paired_root_loss(policy, actions, outcomes, mask, weighting="roots")
        expected = (F.softplus(policy[0, 0] - policy[0, 1]) + F.softplus(policy[1, 0] - policy[1, 1])) / 2
        torch.testing.assert_close(balanced, expected)
        first_gradient = torch.autograd.grad(balanced, policy)[0]
        repeated = outcomes.clone()
        repeated[1, 1] = .5
        balanced_again, _ = paired_root_loss(policy, actions, repeated, mask, weighting="roots")
        torch.testing.assert_close(balanced_again, balanced)
        torch.testing.assert_close(torch.autograd.grad(balanced_again, policy)[0], first_gradient)
        original, _ = paired_root_loss(policy, actions, outcomes, mask)
        original_repeated, _ = paired_root_loss(policy, actions, repeated, mask)
        self.assertNotAlmostEqual(float(original.detach()), float(original_repeated.detach()), places=3)
        torch.testing.assert_close(info["comparisonWeightedLoss"], original.detach())

    def test_root_objective_has_zero_gradient_without_terminal_contrast(self):
        policy = torch.randn(2, 3, requires_grad=True)
        loss, info = paired_root_loss(policy, torch.tensor([[0, 1], [1, 2]]),
                                     torch.zeros(2, 2, 8), torch.ones(2, 2, dtype=torch.bool), weighting="roots")
        loss.backward()
        self.assertEqual(int(info["informativeRoots"]), 0)
        self.assertEqual(float(loss.detach()), 0)
        self.assertTrue(policy.grad.eq(0).all())
        with self.assertRaisesRegex(ValueError, "unknown paired-root"):
            paired_root_loss(policy, torch.tensor([[0, 1], [1, 2]]),
                             torch.zeros(2, 2, 8), torch.ones(2, 2, dtype=torch.bool), weighting="auto")
        with self.assertRaisesRegex(ValueError, "unknown paired-root payoff"):
            paired_root_loss(policy, torch.tensor([[0, 1], [1, 2]]),
                             torch.zeros(2, 2, 8), torch.ones(2, 2, dtype=torch.bool), payoff_weighting="auto")

    def test_served_paired_gain_requires_observed_action_and_baseline(self):
        actions = torch.tensor([[4, 2, -1], [1, 3, -1]])
        returns = torch.tensor([[[0.] * 8, [1.] * 8, [float("nan")] * 8],
                                [[1.] * 8, [.5] * 8, [float("nan")] * 8]])
        mask = torch.tensor([[True, True, False]] * 2)
        gains, known = paired_gate_gain(torch.tensor([2, 9]), torch.tensor([4, 3]), actions, returns, mask)
        self.assertEqual(known.tolist(), [True, False])
        self.assertEqual(gains[known].tolist(), [1.])
        self.assertTrue(torch.isfinite(gains).all())
        with self.assertRaisesRegex(ValueError, "baseline must have exactly one"):
            paired_gate_gain(torch.tensor([2, 9]), torch.tensor([4, 8]), actions, returns, mask)
        zero, known = paired_gate_gain(torch.tensor([4, 3]), torch.tensor([4, 3]), actions, returns, mask)
        self.assertTrue(known.all())
        self.assertTrue(zero.eq(0).all())

    def test_draw_aware_utility_can_reverse_a_majority_of_pairwise_wins(self):
        # A wins four worlds by .5 and loses three worlds by1. Its expected
        # score is worse, despite winning a majority of the seven comparisons.
        returns = torch.tensor([[[.5, .5, .5, .5, 0., 0., 0., .5],
                                 [0., 0., 0., 0., 1., 1., 1., .5]]])
        policy = torch.zeros(1, 2, requires_grad=True)
        actions, mask = torch.tensor([[0, 1]]), torch.ones(1, 2, dtype=torch.bool)
        sign, _ = paired_root_loss(policy, actions, returns, mask)
        sign_gradient = torch.autograd.grad(sign, policy)[0]
        utility, details = paired_root_loss(policy, actions, returns, mask, payoff_weighting="magnitude")
        utility_gradient = torch.autograd.grad(utility, policy)[0]
        self.assertLess(float(returns[0, 0].mean()), float(returns[0, 1].mean()))
        self.assertLess(float(sign_gradient[0, 0]), 0, "count preference incorrectly raises A")
        self.assertGreater(float(utility_gradient[0, 0]), 0, "utility preference correctly lowers A")
        self.assertEqual(int(details["nonTiedComparisons"]), 7)
        self.assertEqual(float(details["effectiveComparisonWeight"]), 5)

    def test_single_half_score_contrast_retains_one_full_root_weight(self):
        policy = torch.tensor([[0., 2.]], requires_grad=True)
        returns = torch.tensor([[[0.] * 8, [.5] + [0.] * 7]])
        loss, details = paired_root_loss(policy, torch.tensor([[0, 1]]), returns,
            torch.ones(1, 2, dtype=torch.bool), weighting="roots", payoff_weighting="magnitude")
        torch.testing.assert_close(loss, F.softplus(policy[0, 0] - policy[0, 1]))
        self.assertEqual(int(details["nonTiedComparisons"]), 1)
        self.assertEqual(float(details["effectiveComparisonWeight"]), .5)

    def test_binary_terminal_scores_preserve_the_original_loss_and_gradient(self):
        policy = torch.tensor([[0., 2.], [1., 0.]], requires_grad=True)
        returns = torch.tensor([[[0.] * 8, [1., 0.] * 4], [[1.] * 8, [0., 1.] * 4]])
        for weighting in ["comparisons", "roots"]:
            original, _ = paired_root_loss(policy, torch.tensor([[0, 1]] * 2), returns,
                torch.ones(2, 2, dtype=torch.bool), weighting=weighting)
            corrected, _ = paired_root_loss(policy, torch.tensor([[0, 1]] * 2), returns,
                torch.ones(2, 2, dtype=torch.bool), weighting=weighting, payoff_weighting="magnitude")
            self.assertTrue(torch.equal(original, corrected))
            self.assertTrue(torch.equal(torch.autograd.grad(original, policy)[0],
                                        torch.autograd.grad(corrected, policy)[0]))

    def test_arithmetic_pool_pair_loss_can_reward_an_unlabeled_action(self):
        student = torch.zeros(1, 3, requires_grad=True)
        partner = torch.tensor([[4., 0., -10.]])
        actions = torch.tensor([[0, 1]])
        returns = torch.tensor([[[1.] * 8, [0.] * 8]])
        mask = torch.ones(1, 2, dtype=torch.bool)
        loss, _ = paired_root_loss(served_policy(student, partner, torch.ones(1, 3, dtype=torch.bool)),
                                   actions, returns, mask)
        self.assertLess(float(torch.autograd.grad(loss, student)[0][0, 2]), 0)
        increased = student.detach().clone()
        increased[0, 2] = 10
        lower, _ = paired_root_loss(served_policy(increased, partner, torch.ones(1, 3, dtype=torch.bool)),
                                    actions, returns, mask)
        self.assertLess(float(lower), float(loss.detach()))
        # Mean-logit differences remove this partition-function shortcut.
        logits = (student + partner) / 2
        geometric, _ = paired_root_loss(logits, actions, returns, mask)
        self.assertEqual(float(torch.autograd.grad(geometric, student)[0][0, 2]), 0)

    def test_readiness_ignores_padding_and_shared_world_randomness(self):
        returns = torch.tensor([[[.5, .5], [.5, .5], [0., 0.]],
                                [[1., 0.], [1., 0.], [0., 0.]],
                                [[1., 0.], [0., 0.], [0., 0.]]])
        mask = torch.tensor([[True, True, False]] * 3)
        self.assertEqual(roots_with_terminal_contrast(returns, mask).tolist(), [False, False, True])

    def test_serving_gate_preserves_margin_boundary_and_bank_tie_order(self):
        policy = torch.tensor([[0., 1., 1.], [0., .999999, .999999], [0., 1.000001, 1.000001]])
        native = torch.tensor([0, 0, 0])
        eligible = torch.tensor([[2, 1, 0]] * 3)
        self.assertEqual(served_gate_choices(policy, native, eligible).tolist(), [2, 0, 2])
        with self.assertRaises(ValueError):
            served_gate_choices(policy, torch.tensor([-1, 0, 0]), eligible)
        with self.assertRaises(ValueError):
            served_gate_choices(policy, native, torch.tensor([[2, 1]] * 3))


if __name__ == "__main__":
    unittest.main(verbosity=2)
