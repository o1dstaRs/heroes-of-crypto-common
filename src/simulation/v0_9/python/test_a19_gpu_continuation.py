"""CPU-only checks for GPU admission and paid-compute bounds."""
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from a19_gpu_continuation import Continuation, fit_budget_problem, validate_readiness


class GpuBudgetTests(unittest.TestCase):
    def test_initial_epoch_and_total_active_time_are_bounded(self):
        self.assertIsNone(fit_budget_problem(119, [], 1200, 120))
        self.assertIn("first epoch", fit_budget_problem(120, [], 1200, 120))
        self.assertIn("time limit", fit_budget_problem(1200, [], 1200, 120))

    def test_measured_slow_or_invalid_epochs_stop_before_spending_more(self):
        record = {"epoch": 0, "elapsedSeconds": 1, "trainingLoss": 1, "validation": {"policyLogLoss": 1}}
        self.assertIsNone(fit_budget_problem(5, [record], 1200, 120))
        self.assertIn("projects", fit_budget_problem(100, [{**record, "elapsedSeconds": 60}], 1200, 120))
        self.assertIn("Non-finite", fit_budget_problem(5, [{**record, "trainingLoss": float("nan")}], 1200, 120))
        self.assertIn("Non-finite", fit_budget_problem(5, [{**record, "validation": {"policyLogLoss": -1}}], 1200, 120))

    def test_no_readiness_report_can_query_or_start_a_gpu(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = {"manifestSha256": "fixture"}
            (root / "manifest.json").write_text(json.dumps(manifest))
            (root / "controller-status.json").write_text(json.dumps({"state": "ready_for_5090", **manifest}))
            controller = Continuation(SimpleNamespace(campaign=root, repository=root, max_hours=1,
                                                     readiness=root / "missing.json"))
            with patch.object(controller, "cpu_available", return_value=True), \
                    patch.object(controller, "gpu") as gpu, patch("a19_gpu_continuation.time.sleep", side_effect=RuntimeError("fixture stop")):
                with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                    controller.run()
                gpu.assert_not_called()
            self.assertFalse((root / "learner.log").exists())

    def test_full_data_admission_rejects_missing_checks_and_changed_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = {"manifestSha256": "fixture", "source": {"sha256": "source",
                "files": {"src/simulation/v0_9/python/a19_train.py": "learner"}}}
            names = ("teacherQualified", "allCorpusRowsCheckedOnCpu", "trainValidationIndependent",
                     "exactLearnerCpuRehearsal", "checkpointResumeExact", "cpuExportParity", "activeEngineSmoke",
                     "maximumShapeBatchChecked", "currentEngineAdmitted")
            report = {"schema": "hoc.ai.v0_9_a19_gpu_readiness.v1", "readyForGpu": True, "promoted": False,
                      "manifestSha256": "fixture", "sourceSha256": "source", "learnerSourceSha256": "learner",
                      "checks": dict.fromkeys(names, True), "corpus": {}}
            for stage, count in (("corpus_train", 510), ("corpus_validation", 96)):
                (root / stage).mkdir()
                files = []
                for index in range(count):
                    path = root / stage / f"board-{index:06}.json"
                    path.write_text("{}")
                    files.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
                report["corpus"][stage] = {"files": files, "decisions": 100, "manifestSha256": "fixture"}
            validate_readiness(report, manifest, root)
            report["checks"]["activeEngineSmoke"] = False
            with self.assertRaisesRegex(ValueError, "CPU readiness"):
                validate_readiness(report, manifest, root)
            report["checks"]["activeEngineSmoke"] = True
            (root / "corpus_train/board-000000.json").write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, "changed after"):
                validate_readiness(report, manifest, root)


if __name__ == "__main__":
    unittest.main()
