"""Trainer admission fails before CUDA/output; matched recipes stay comparable."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from a19_feature_admission import GPU_UUID, check_fit_design, check_pair_objective, sha, verify_files


class FeatureTrainerAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.design = {"maximumFits": 4, "useCachedOldFeatures": False, "minimumWorldsPerAction": 8,
                       "developmentGames": 768, "freshGames": 3072, "teacherCeTolerance": .03,
                       "minimumPairImprovement": .005, "recipes": [
                           {"ordinal": i, "rank": 0 if i % 2 == 0 else 4,
                            "learningRate": .003 if i < 2 else .01,
                            "klWeight": .2, "batchSeed": 2026110360 + i // 2, "seed": 2026110362 + i // 2}
                           for i in range(4)]}

    def test_matched_design_and_faults(self):
        check_fit_design(self.design)
        for field, value in [("useCachedOldFeatures", True), ("minimumWorldsPerAction", 4),
                             ("developmentGames", 192), ("freshGames", 768), ("teacherCeTolerance", .1)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_fit_design({**self.design, field: value})
        for field, value in [("rank", 0), ("learningRate", .02), ("batchSeed", 17), ("ordinal", 0)]:
            changed = copy.deepcopy(self.design)
            changed["recipes"][1][field] = value
            with self.subTest(recipeField=field), self.assertRaises(ValueError):
                check_fit_design(changed)

    def test_pair_objective_defaults_and_registered_score_scale(self):
        self.assertEqual(check_pair_objective({}), {"weighting": "comparisons", "payoffWeighting": "sign",
                                                  "objective": "paired-preference", "scoreScale": None})
        self.assertEqual(check_pair_objective({"pairLossWeighting": "roots", "pairPayoffWeighting": "magnitude"})["objective"], "paired-preference")
        config = {"pairLossWeighting": "roots", "pairLossObjective": "score-difference", "pairScoreScale": .1}
        self.assertEqual(check_pair_objective(config)["scoreScale"], .1)
        for field, value in [("pairLossObjective", "unknown"), ("pairScoreScale", None), ("pairScoreScale", 0),
                             ("pairScoreScale", -1), ("pairScoreScale", float("nan")), ("pairScoreScale", float("inf")),
                             ("pairScoreScale", True), ("pairScoreScale", ".1"), ("pairLossWeighting", "comparisons"),
                             ("pairPayoffWeighting", "magnitude")]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                check_pair_objective({**config, field: value})
        with self.assertRaises(ValueError):
            check_pair_objective({"pairScoreScale": .1})

    def test_mutated_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "module.py"
            path.write_text("original")
            files = {"module.py": sha(path)}
            verify_files(root, files)
            path.write_text("changed")
            with self.assertRaisesRegex(ValueError, "Source/input changed"):
                verify_files(root, files)

    def test_unbound_gpu_refused_without_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("a19_feature_train.py")),
                                     "--registration", str(root / "absent.json")], text=True, capture_output=True,
                                    env={**os.environ, "CUDA_VISIBLE_DEVICES": ""}, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("approved RTX 5090 UUID", result.stderr)
            self.assertEqual(list(root.iterdir()), [])

    def test_expired_window_rejected_before_torch_or_outputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            auth = root / "authorization.json"
            auth.write_text(json.dumps({"authorized": True, "approvedGpuUuid": GPU_UUID,
                                        "maximumGpus": 1, "promotionAllowed": False, "stopAtUnix": 1}))
            reg = root / "registration.json"
            reg.write_text(json.dumps({"schema": "hoc.ai.a19.feature-cycle.v1", "promotionAllowed": False,
                                       "authorization": "authorization.json", "authorizationSha256": sha(auth),
                                       "fitBudgetSeconds": 900, "files": {}}))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("a19_feature_train.py")),
                                     "--registration", str(reg)], text=True, capture_output=True,
                                    env={**os.environ, "CUDA_VISIBLE_DEVICES": GPU_UUID}, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("remaining authorization", result.stderr)
            self.assertNotIn("torch", result.stderr)
            self.assertEqual({p.name for p in root.iterdir()}, {"authorization.json", "registration.json"})

    def test_unscaled_score_objective_refused_before_torch_or_lease_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            auth = root / "authorization.json"
            auth.write_text(json.dumps({"authorized": True, "approvedGpuUuid": GPU_UUID,
                                        "maximumGpus": 1, "promotionAllowed": False, "stopAtUnix": time.time() + 3600}))
            trainer = Path(__file__).with_name("a19_feature_train.py")
            reg = root / "registration.json"
            reg.write_text(json.dumps({**self.design, "schema": "hoc.ai.a19.feature-cycle.v1", "promotionAllowed": False,
                                       "authorization": auth.name, "authorizationSha256": sha(auth), "fitBudgetSeconds": 900,
                                       "files": {auth.name: sha(auth)}, "trainerSha256": sha(trainer), "gpuLease": "gpu.lock",
                                       "pairLossWeighting": "roots", "pairLossObjective": "score-difference"}))
            result = subprocess.run([sys.executable, str(trainer), "--registration", str(reg)], text=True, capture_output=True,
                                    env={**os.environ, "CUDA_VISIBLE_DEVICES": GPU_UUID}, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Register a finite positive", result.stderr)
            self.assertNotIn("torch", result.stderr)
            self.assertEqual({p.name for p in root.iterdir()}, {auth.name, reg.name})


if __name__ == "__main__":
    unittest.main(verbosity=2)
