"""Check the stop-rule replay without fitting, loading Torch or consuming game banks."""
import copy
import unittest

from a19_early_stop_replay import analyze, choose, controls


def fixture(losses, identity="fixture"):
    recipe = {"recipeSha256": identity, "ordinal": 0, "width": 256,
              "minimumEpochsBeforeEarlyStop": len(losses), "patienceEpochs": len(losses),
              "minimumValidationImprovement": 0.0001}
    history = [{"epoch": n, "validation": {"policyLogLoss": loss}, "activeSeconds": n + 1}
               for n, loss in enumerate(losses)]
    _, best_epoch, best = choose(history, len(losses), len(losses), 0.0001)
    fit = {"complete": True, "recipeSha256": identity, "recipe": recipe, "history": history,
           "completedEpochs": len(losses), "bestEpoch": best_epoch, "validation": {"policyLogLoss": best},
           "activeSeconds": len(losses), "bestCheckpointSha256": "checkpoint", "historyMalformedLines": []}
    return {"registration": {"recipes": [recipe]}, "teachers": [fit]}


RULE = {"minimumEpochs": 3, "patienceEpochs": 2, "minimumValidationImprovement": 0.0001}


class EarlyStopReplayTests(unittest.TestCase):
    def test_plateau_saves_time_without_changing_selected_epoch(self):
        result = analyze(fixture([3, 2, 2, 2, 2, 2]), RULE)
        self.assertTrue(result["allSelectedCheckpointsPreserved"])
        self.assertEqual(result["cases"][0]["proposedEpochs"], 4)
        self.assertEqual(result["estimatedPrefixActiveSeconds"], 4)
        self.assertAlmostEqual(result["estimatedActiveTimeReduction"], 1 / 3)
        self.assertFalse(result["gpuWorkPerformed"])

    def test_late_improvement_rejects_a_faster_but_worse_rule(self):
        result = analyze(fixture([3, 2, 2, 2, 1]), RULE)
        self.assertFalse(result["allSelectedCheckpointsPreserved"])
        self.assertEqual(result["changedSelectedCheckpoints"], 1)
        self.assertEqual(result["maximumValidationLossIncrease"], 1)

    def test_minimum_delta_and_minimum_epochs_match_training(self):
        self.assertTrue(controls()["passed"])

    def test_missing_epochs_cannot_report_preservation_for_the_remaining_fits(self):
        evidence = fixture([3, 2, 2, 2])
        other = fixture([3, 2, 2, 2], "missing")
        other["teachers"][0]["history"].pop(2)
        evidence["registration"]["recipes"] += other["registration"]["recipes"]
        evidence["teachers"] += other["teachers"]
        result = analyze(evidence, RULE)
        self.assertEqual(result["analyzedFits"], 1)
        self.assertEqual(len(result["rejectedHistories"]), 1)
        self.assertFalse(result["allSelectedCheckpointsPreserved"])

    def test_resume_duplicates_are_allowed_only_when_non_timing_values_match(self):
        evidence = fixture([3, 2, 2, 2])
        duplicate = copy.deepcopy(evidence["teachers"][0]["history"][1])
        duplicate["activeSeconds"] += 0.1
        evidence["teachers"][0]["history"].append(duplicate)
        self.assertTrue(analyze(evidence, RULE)["allSelectedCheckpointsPreserved"])
        duplicate["validation"]["policyLogLoss"] = 7
        result = analyze(evidence, RULE)
        self.assertEqual(len(result["rejectedHistories"]), 1)
        self.assertFalse(result["allSelectedCheckpointsPreserved"])

    def test_receipt_must_match_original_checkpoint_selection(self):
        evidence = fixture([3, 2, 2, 2])
        evidence["teachers"][0]["bestEpoch"] = 0
        with self.assertRaisesRegex(ValueError, "Recorded checkpoint"):
            analyze(evidence, RULE)

    def test_reject_duplicate_unregistered_or_incomplete_fits(self):
        evidence = fixture([3, 2, 2, 2])
        evidence["teachers"].append(copy.deepcopy(evidence["teachers"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            analyze(evidence, RULE)
        for field, value in [("complete", False), ("recipeSha256", "unknown")]:
            evidence = fixture([3, 2, 2, 2])
            evidence["teachers"][0][field] = value
            with self.assertRaises(ValueError):
                analyze(evidence, RULE)

    def test_nonfinite_loss_or_timing_cannot_pass(self):
        for value in (float("nan"), float("inf")):
            evidence = fixture([3, 2, 2, 2])
            evidence["teachers"][0]["history"][2]["validation"]["policyLogLoss"] = value
            with self.assertRaisesRegex(ValueError, "finite validation"):
                analyze(evidence, RULE)
            evidence = fixture([3, 2, 2, 2])
            evidence["teachers"][0]["activeSeconds"] = value
            with self.assertRaisesRegex(ValueError, "active fit timing"):
                analyze(evidence, RULE)

    def test_empty_evidence_is_not_a_success(self):
        result = analyze({"registration": {"recipes": []}, "teachers": []}, RULE)
        self.assertFalse(result["allSelectedCheckpointsPreserved"])
        self.assertIsNone(result["estimatedActiveTimeReduction"])
        with self.assertRaises(ValueError):
            choose([], 3, 2, 0.0001)

    def test_invalid_rules_are_rejected(self):
        rows = fixture([3, 2, 2, 2])["teachers"][0]["history"]
        for rule in [(0, 2, 0.0001), (3, 0, 0.0001), (3, 2, -1), (3, 2, float("nan"))]:
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                choose(rows, *rule)


if __name__ == "__main__":
    unittest.main()
