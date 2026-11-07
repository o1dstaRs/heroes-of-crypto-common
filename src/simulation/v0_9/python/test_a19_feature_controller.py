"""Exercise process cleanup without touching another stage's process group."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from a19_feature_admission import GPU_UUID, sha
from a19_feature_controller import run_stage, stop_children


class FeatureControllerTests(unittest.TestCase):
    def registration(self, root, command, max_seconds=10):
        auth = root / "authorization.json"
        auth.write_text(json.dumps({"authorized": True, "approvedGpuUuid": GPU_UUID, "maximumGpus": 1,
                                    "promotionAllowed": False, "stopAtUnix": time.time() + 120}))
        source = root / "source.txt"
        source.write_text("sealed")
        reg = {"schema": "hoc.ai.a19.feature-cycle.v1", "promotionAllowed": False,
               "authorization": "authorization.json", "authorizationSha256": sha(auth),
               "files": {"source.txt": sha(source)}, "hostReserveBytes": 10, "minimumRunningHeadroomBytes": 5,
               "stages": {"fixture": {"commands": [command], "cpuOnly": True,
                    "estimatedSecondsWithReserve": 1, "estimatedPeakHostBytes": 10, "maximumWallSeconds": max_seconds}}}
        path = root / "registration.json"
        path.write_text(json.dumps(reg))
        return path

    def test_successful_cpu_child_has_no_gpu_visibility(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            command = [sys.executable, "-c", "import os;from pathlib import Path;Path('device.txt').write_text(os.environ['CUDA_VISIBLE_DEVICES'])"]
            reg = self.registration(root, command)
            with patch("a19_feature_controller.memory_snapshot", return_value={"hostAvailableBytes": 1000, "ancestorHeadrooms": [1000]}), \
                    patch("a19_feature_controller.cpu_ticks", return_value=(100, 90)):
                run_stage(reg, "fixture")
            self.assertEqual((root / "device.txt").read_text(), "")

    def test_failed_child_preserves_log_and_cannot_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            reg = self.registration(root, [sys.executable, "-c", "raise RuntimeError('fixture failure')"])
            with patch("a19_feature_controller.memory_snapshot", return_value={"hostAvailableBytes": 1000, "ancestorHeadrooms": [1000]}), \
                    patch("a19_feature_controller.cpu_ticks", return_value=(100, 90)), \
                    self.assertRaisesRegex(ValueError, "(Child failed|Incomplete stage)"):
                run_stage(reg, "fixture")
            self.assertTrue(any("fixture failure" in p.read_text() for p in root.glob("fixture-*.log")))

    def test_cleanup_continues_paused_child_and_preserves_unrelated_process(self):
        own = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
        try:
            os.killpg(own.pid, signal.SIGSTOP)
            stop_children([own])
            self.assertIsNotNone(own.poll())
            self.assertIsNone(unrelated.poll())
        finally:
            stop_children([own, unrelated])


if __name__ == "__main__":
    unittest.main(verbosity=2)
