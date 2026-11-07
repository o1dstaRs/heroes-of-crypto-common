"""Guard the automatic continuation's scope; no GPU or simulation process is started by these tests."""
from pathlib import Path
from types import SimpleNamespace
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

from a19_development_controller import DevelopmentContinuation, DevelopmentStages, cpu_environment, parse_args
from a19_pilot_controller import PilotController, windows


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
        scheduler.args = SimpleNamespace(processes=2, workers_per_process=4)
        original_args = scheduler.args
        def stage(instance, name):
            self.assertEqual(len(instance.manifest["stages"][name]), 192)
            self.assertEqual(windows(192, instance.args.processes), [(0, 96), (96, 96)])
            self.assertEqual(instance.args.workers_per_process, 4)
            raise RuntimeError("fixture child failure")
        with patch.object(PilotController, "stage", stage):
            with self.assertRaisesRegex(RuntimeError, "fixture child failure"):
                scheduler.stage("development")
        self.assertIs(scheduler.manifest, original)
        self.assertNotIn("stages", original)
        self.assertIs(scheduler.args, original_args)

    def test_smoke_uses_one_pool_and_restores_development_layout_after_failure(self):
        scheduler = object.__new__(DevelopmentStages)
        original = {"manifestSha256": "fixture", "registration": {"stages": {"development": [1] * 192}}}
        scheduler.manifest = original
        scheduler.args = SimpleNamespace(processes=2, workers_per_process=4)
        original_args = scheduler.args
        def stage(instance, name):
            self.assertEqual(name, "smoke")
            self.assertEqual((instance.args.processes, instance.args.workers_per_process), (1, 3))
            self.assertEqual(list(instance.manifest["stages"][name]), [0, 1, 2])
            raise RuntimeError("fixture interrupted smoke")
        with patch.object(PilotController, "stage", stage):
            with self.assertRaisesRegex(RuntimeError, "interrupted smoke"):
                scheduler.stage("smoke")
        self.assertIs(scheduler.args, original_args)
        self.assertIs(scheduler.manifest, original)

    def test_cpu_children_cannot_inherit_visible_gpus(self):
        with patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": "GPU-fixture", "OMP_NUM_THREADS": "24"}):
            env = cpu_environment()
            self.assertEqual(env["CUDA_VISIBLE_DEVICES"], "")
            self.assertEqual(env["BUN_JSC_numberOfGCMarkers"], "1")
            self.assertEqual(env["OMP_NUM_THREADS"], "2")
            self.assertEqual(env["OPENBLAS_NUM_THREADS"], "2")
            self.assertEqual(os.environ["CUDA_VISIBLE_DEVICES"], "GPU-fixture")

    def test_default_and_explicit_resource_limits(self):
        required = [arg for name in ("campaign", "repository", "actor-repository", "registration", "out", "protect-v08-root")
                    for arg in ("--" + name, ".")] + ["--python", "python3"]
        args = parse_args(required)
        self.assertEqual((args.processes, args.workers_per_process), (2, 4))
        for extra in (["--processes", "3"], ["--workers-per-process", "5"], ["--processes", "0"]):
            with self.subTest(extra=extra), patch("sys.stderr"), self.assertRaises(SystemExit):
                parse_args(required + extra)

    def test_programmatic_scheduler_cannot_bypass_worker_cap(self):
        scheduler = object.__new__(DevelopmentStages)
        original = {"manifestSha256": "fixture", "registration": {"stages": {"development": [1] * 192}}}
        scheduler.manifest = original
        scheduler.args = SimpleNamespace(processes=3, workers_per_process=4)
        with patch.object(PilotController, "stage") as launch:
            with self.assertRaisesRegex(ValueError, "eight simulation workers"):
                scheduler.stage("development")
            launch.assert_not_called()
        self.assertIs(scheduler.manifest, original)

    def test_native_children_get_disjoint_complete_ranges_and_cpu_only_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = {"manifestSha256": "fixture", "registration": {"stages": {"development": list(range(192))}}}
            (root / "manifest.json").write_text(json.dumps(manifest))
            scheduler = DevelopmentStages(SimpleNamespace(campaign=root, repository=root, bun="bun",
                processes=2, workers_per_process=4, max_hours=1))
            children = [Mock(pid=1001, returncode=0), Mock(pid=1002, returncode=0)]
            for child in children:
                child.poll.return_value = 0
            def finalize(command, **kwargs):
                self.assertEqual(command[2], "finalize")
                self.assertEqual(kwargs["env"]["CUDA_VISIBLE_DEVICES"], "")
                (root / "development").mkdir()
                (root / "development/summary.json").write_text(json.dumps({"complete": True}))
            with patch.object(scheduler, "wait_available"), \
                    patch("a19_pilot_controller.subprocess.Popen", side_effect=children) as launch, \
                    patch("a19_pilot_controller.subprocess.run", side_effect=finalize):
                self.assertTrue(scheduler.stage("development")["complete"])
            self.assertEqual(launch.call_count, 2)
            for call, first in zip(launch.call_args_list, (0, 96)):
                command = call.args[0]
                self.assertEqual(command[command.index("--first-board") + 1], str(first))
                self.assertEqual(command[command.index("--board-count") + 1], "96")
                self.assertEqual(command[command.index("--workers") + 1], "4")
                self.assertEqual(call.kwargs["env"]["CUDA_VISIBLE_DEVICES"], "")
                self.assertEqual(call.kwargs["env"]["BUN_JSC_numberOfGCMarkers"], "1")
            self.assertEqual(json.loads((root / "manifest.json").read_text()), manifest)

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
