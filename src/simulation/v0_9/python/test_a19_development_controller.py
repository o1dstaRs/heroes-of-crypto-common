"""Guard the automatic continuation's scope; no GPU or simulation process is started by these tests."""
from pathlib import Path
from types import SimpleNamespace
import json
import tempfile
import unittest
from unittest.mock import patch

from a19_development_controller import DevelopmentContinuation, DevelopmentStages
from a19_pilot_controller import PilotController


class DevelopmentControllerTests(unittest.TestCase):
    def test_scheduler_rejects_every_non_development_bank(self):
        scheduler = object.__new__(DevelopmentStages)
        for stage in ("confirmation_r2", "secondary_r4", "teacher_confirmation", "corpus_train"):
            with self.assertRaisesRegex(ValueError, "cannot consume"):
                scheduler.command("run", stage)
            with self.assertRaisesRegex(ValueError, "cannot consume"):
                scheduler.stage(stage)

    def test_count_adapter_preserves_the_complete_trial_manifest(self):
        scheduler = object.__new__(DevelopmentStages)
        original = {"manifestSha256": "fixture", "registration": {"stages": {"development": [1] * 192}}}
        scheduler.manifest = original
        def stage(instance, name):
            self.assertEqual(len(instance.manifest["stages"][name]), 192)
            raise RuntimeError("fixture child failure")
        with patch.object(PilotController, "stage", stage):
            with self.assertRaisesRegex(RuntimeError, "fixture child failure"):
                scheduler.stage("development")
        self.assertIs(scheduler.manifest, original)
        self.assertNotIn("stages", original)

    def test_failed_teacher_or_fit_cannot_start_export_or_student_games(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "campaign").mkdir()
            (root / "output").mkdir()
            (root / "campaign/manifest.json").write_text(json.dumps({"manifestSha256": "fixture"}))
            (root / "campaign/gpu-continuation-status.json").write_text(json.dumps({
                "manifestSha256": "fixture", "state": "stopped_cpu_gate"}))
            controller = DevelopmentContinuation(SimpleNamespace(campaign=root / "campaign", repository=root,
                out=root / "output", max_hours=1))
            with patch("a19_development_controller.platform.system", return_value="Linux"), \
                    patch("a19_development_controller.platform.machine", return_value="x86_64"), \
                    patch.object(controller, "command") as command:
                controller.run()
                command.assert_not_called()
            status = json.loads((root / "output/continuation-status.json").read_text())
            self.assertEqual(status["state"], "stopped_fit_gate")
            self.assertIs(status["promoted"], False)


if __name__ == "__main__":
    unittest.main()
