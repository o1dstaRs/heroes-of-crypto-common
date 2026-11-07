"""Reject incomplete/biased batches while admitting fixed all-tie validation."""
import copy
import unittest

from a19_feature_data import admit_batch, collate_roots, paired_future_seed, permute_seed, validate_scenarios
from a19_feature_admission import GPU_UUID, PEER_GPU_UUID, classify_gpu_admission, check_memory, check_window


class FeatureDataTests(unittest.TestCase):
    def setUp(self):
        self.task = {"family": "validation/keykits/0", "phase": "validation", "seed": 105063,
                     "index": 0, "map": 1, "focal": "Zena", "rootPhase": 1}
        self.namespace = "feature-cycle-test-v1"
        self.position = {"actor": "Zena", "team": 1, "lap": 3, "focalPresentAtRoot": True,
                         "signatures": ["a", "b"], "eligibleSignatures": ["a", "b", "unknown"],
                         "baselineSignature": "a", "nativeSignature": "a",
                         "observation": {"contractSha256": "contract", "candidates":
                                         [{"signature": v} for v in ["a", "b", "unknown"]]},
                         "baselinePrediction": {"policy": [-1., -1., -1.]}}
        self.root = {"task": self.task, "selected": self.position, "labelRootUsable": True,
                     "strengthEvaluation": False, "trainingUseAllowed": False, "targetTeam": 1,
                     "captureDiagnostics": {"requestedPhase": 1, "selectedPhase": 1, "missingRootReason": None},
                     "record": {"endReason": "elimination", "rejectedCandidate": 0, "rejectedOpponent": 0,
                                "gridType": 1, "game": 0,
                                **{k: permute_seed(self.task["seed"] + i) for i, k in enumerate(
                                    ["pairSeed", "pickSeed", "battleSeed"])}},
                     "statistics": {"rootRestorationChecks": 9}}
        self.branches = {}
        for action in range(2):
            for world in range(8):
                self.branches[(self.task["family"], action, world)] = {
                    "task": {"stage": "returns", "task": self.task, "action": action, "world": world},
                    "rootFileSha256": "root-hash", "strengthEvaluation": False, "score": .5,
                    "futureSeed": paired_future_seed(self.namespace, self.task["seed"], 0, world),
                    "statistics": {"interventionApplied": 1, "interventionExecuted": 1, "rootRestorationChecks": 9}}

    def admit(self, root=None, branches=None, tasks=None):
        return admit_batch([self.task] if tasks is None else tasks,
                           {self.task["family"]: self.root if root is None else root},
                           self.branches if branches is None else branches, {self.task["family"]: "root-hash"},
                           namespace=self.namespace, contract_sha256="contract")

    def test_zero_contrast_validation_is_admitted_without_refills(self):
        result = self.admit()
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["returns"], [[.5] * 8, [.5] * 8])
        self.assertFalse(result["validationOutcomeFiltering"])
        self.assertEqual(result["rows"][0]["actions"], [0, 1], "unlabeled action is not a negative")

    def test_missing_world_and_foreign_world_are_rejected(self):
        changed = copy.deepcopy(self.branches)
        del changed[(self.task["family"], 1, 7)]
        with self.assertRaisesRegex(ValueError, "Incomplete paired"):
            self.admit(branches=changed)
        changed = copy.deepcopy(self.branches)
        changed[(self.task["family"], 2, 0)] = next(iter(changed.values()))
        with self.assertRaisesRegex(ValueError, "Foreign/unused"):
            self.admit(branches=changed)

    def test_false_phase_root_and_wrong_actor_rejected(self):
        for field, value in [("lap", 1), ("actor", "Magic Dragon"), ("team", 2)]:
            changed = copy.deepcopy(self.root)
            changed["selected"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.admit(root=changed)

    def test_branch_faults(self):
        for field, value in [("score", True), ("score", float("nan")), ("futureSeed", 1),
                             ("rootFileSha256", "foreign"), ("strengthEvaluation", True)]:
            changed = copy.deepcopy(self.branches)
            changed[(self.task["family"], 0, 0)][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.admit(branches=changed)

    def test_cannot_drop_or_replace_validation_case(self):
        other = {**self.task, "family": "validation/keykits/replacement", "seed": 205063}
        with self.assertRaisesRegex(ValueError, "Missing/foreign registered root"):
            self.admit(tasks=[self.task, other])

    def test_missing_case_is_retained_without_a_synthetic_label(self):
        changed = copy.deepcopy(self.root)
        changed["selected"] = None
        changed["labelRootUsable"] = False
        changed["captureDiagnostics"].update(selectedPhase=None, missingRootReason="no_focal_turn")
        result = self.admit(root=changed, branches={})
        self.assertEqual(result["registeredScenarios"], 1)
        self.assertEqual(result["rows"], [])
        self.assertEqual(result["missing"], {"no_focal_turn": 1})
        changed["record"]["endReason"] = "max_laps"
        with self.assertRaisesRegex(ValueError, "Incomplete/invalid"):
            self.admit(root=changed, branches={})

    def test_seed_overlap_and_strength_filtering_rejected(self):
        for other in [{**self.task, "family": "other"},
                      {**self.task, "family": "other", "seed": self.task["seed"] + 1},
                      {**self.task, "family": "other", "phase": "fresh", "seed": 205063}]:
            with self.subTest(other=other), self.assertRaises(ValueError):
                validate_scenarios([self.task, other], set())

    def test_runtime_requires_funded_new_window(self):
        auth = {"authorized": True, "approvedGpuUuid": GPU_UUID, "maximumGpus": 1,
                "promotionAllowed": False, "stopAtUnix": 1000}
        check_window(auth, 300, now=500)
        for changed, work in [({**auth, "authorized": False}, 300), ({**auth, "stopAtUnix": 499}, 1),
                              (auth, 450), ({**auth, "maximumGpus": 2}, 1), (auth, float("nan"))]:
            with self.subTest(changed=changed, work=work), self.assertRaises(ValueError):
                check_window(changed, work, now=500)

    def test_restrictive_ancestor_cgroup_is_not_an_idle_gpu_wait(self):
        check_memory(160, [None, 23], 6, 18)
        with self.assertRaisesRegex(ValueError, "ancestor"):
            check_memory(160, [5, 23], 6, 18)
        with self.assertRaisesRegex(ValueError, "Host memory"):
            check_memory(23, [23], 6, 18)

    def test_tensor_pack_preserves_unknown_actions_and_masks_padding(self):
        observation = self.position["observation"]
        observation.update(entities=[[1.] + [0.] * 16, [0.] * 17], globals=[0.] * 6,
                           terrain=[0] * 256, actorIndex=0)
        for candidate in observation["candidates"]:
            candidate.update(features=[0.] * 7, targetIndex=-1)
        rows = self.admit()["rows"]
        second = copy.deepcopy(rows[0])
        second["family"] = "second-root"
        second["observation"]["entities"].append([0.] * 17)
        second["observation"]["candidates"].pop()
        second["baseline"] = [-1., -1.]
        second["eligibleOrder"] = [0, 1]
        pack = collate_roots(rows + [second])
        self.assertEqual(tuple(pack["inputs"][0].shape), (2, 3, 17))
        self.assertEqual(pack["legal"].tolist(), [[True, True, True], [True, True, False]])
        self.assertEqual(pack["mask"].tolist(), [[True, True, False]] * 2)
        self.assertEqual(pack["eligibleOrder"].tolist(), [[0, 1, 2], [0, 1, -1]])
        self.assertEqual(pack["returns"][0, :2].tolist(), [[.5] * 8, [.5] * 8])

    def test_wsl_mirrored_pid_requires_two_actually_idle_target_samples(self):
        sample = {"devices": {GPU_UUID: {"memoryMiB": 0, "utilization": 0, "temperature": 32},
                              PEER_GPU_UUID: {"memoryMiB": 1256, "utilization": 30, "temperature": 36}},
                  "processes": [{"gpuUuid": GPU_UUID, "pid": 123}, {"gpuUuid": PEER_GPU_UUID, "pid": 123}]}
        result = classify_gpu_admission([sample, copy.deepcopy(sample)], wsl=True)
        self.assertEqual(result["knownWslMirroredPids"], [123])
        for field, value in [("memoryMiB", 1), ("utilization", 1), ("temperature", 80)]:
            changed = copy.deepcopy(sample)
            changed["devices"][GPU_UUID][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                classify_gpu_admission([sample, changed], wsl=True)
        with self.assertRaises(ValueError):
            classify_gpu_admission([sample], wsl=True)
        with self.assertRaises(ValueError):
            classify_gpu_admission([sample, sample], wsl=False)
        changed = copy.deepcopy(sample)
        changed["processes"].pop()
        with self.assertRaises(ValueError):
            classify_gpu_admission([changed, changed], wsl=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
