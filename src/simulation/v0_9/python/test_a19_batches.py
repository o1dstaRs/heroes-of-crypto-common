"""Exact CPU controls for the default staged A19 learner path; no CUDA admission or training."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import torch

import a19_train as learner
from a19_batches import batch_layout, prepare_staged_batches
from a19_cpu_rehearsal import CpuOs, CpuTorch, SimulatedInterruption
from a19_model import A19ProposalModel, a19_proposal_loss

torch.set_num_threads(1)


def decisions(count=13, rollouts=8):
    rng = random.Random(17)
    rows = []
    for i in range(count):
        n, c = 1 + i % 7, 2 + i % 5
        observation = {
            "contractSha256": "c" * 64,
            "entities": [[float(j % 2 == 0), *[rng.uniform(-1, 1) for _ in range(8)]] for j in range(n)],
            "globals": [rng.uniform(-1, 1) for _ in range(6)],
            "terrain": [(j + i) % 5 for j in range(256)], "actorIndex": i % n,
            "candidates": [{"features": [rng.uniform(-1, 1) for _ in range(7)],
                            "targetIndex": -1 if j % 2 else j % n} for j in range(c)],
        }
        rows.append({"observation": observation, "outcome": [0, .5, 1][i % 3], "selectedIndex": 1,
                     "samples": [None if j > 1 and j == c - 1 else
                                 [{"index": k, "value": [0, .5, 1][(i + j + k) % 3], "material": .4}
                                  for k in range(rollouts)] for j in range(c)]})
    return rows


def flat(batch):
    return (*batch[0], *batch[1:])


def assert_nested_equal(test, left, right):
    if isinstance(left, torch.Tensor):
        test.assertTrue(torch.equal(left, right))
    elif isinstance(left, dict):
        test.assertEqual(left.keys(), right.keys())
        for key in left:
            assert_nested_equal(test, left[key], right[key])
    elif isinstance(left, (tuple, list)):
        test.assertEqual(len(left), len(right))
        for a, b in zip(left, right):
            assert_nested_equal(test, a, b)
    else:
        test.assertEqual(left, right)


class StagedBatchTests(unittest.TestCase):
    def test_shuffled_duplicate_and_singleton_batches_keep_all_values_shapes_and_strides(self):
        for rollouts in (4, 8):
            rows = decisions(rollouts=rollouts)
            state = torch.get_rng_state().clone()
            phases, receipt = prepare_staged_batches({"train": rows}, torch.device("cpu"), learner.collate)
            self.assertEqual(receipt["actualMode"], "staged")
            self.assertTrue(torch.equal(state, torch.get_rng_state()))
            expected_bytes = sum(x.numel()*x.element_size() for x in flat(learner.collate(rows, torch.device("cpu"))))
            self.assertEqual(batch_layout(rows)["tensorBytes"], expected_bytes)
            for indices in ([0], [1], [2, 0], [10, 2, 2, 5], list(reversed(range(len(rows))))):
                reference = learner.collate([rows[i] for i in indices], torch.device("cpu"))
                actual = phases["train"].get(indices)
                for a, b in zip(flat(reference), flat(actual)):
                    self.assertTrue(torch.equal(a, b))
                    self.assertEqual(a.dtype, b.dtype)
                    self.assertEqual(a.shape, b.shape)
                    self.assertEqual(a.stride(), b.stride())
            # A caller mutating a returned batch cannot mutate the resident corpus.
            phases["train"].get([0])[0][0].fill_(999)
            self.assertTrue(torch.equal(phases["train"].get([0])[0][0],
                                        learner.collate(rows[:1], torch.device("cpu"))[0][0]))

    def test_memory_fallback_and_forced_staging_refuse_before_collation(self):
        rows = decisions()
        def unexpected(*_args):
            raise AssertionError("Over-budget staging allocated corpus tensors")
        sources, receipt = prepare_staged_batches({"train": rows}, torch.device("cpu"), unexpected,
                                                   maximum_bytes=1)
        self.assertEqual(sources, {})
        self.assertEqual(receipt["actualMode"], "legacy")
        self.assertEqual(receipt["reason"], "staging_memory_limit")
        with self.assertRaisesRegex(ValueError, "before allocation"):
            prepare_staged_batches({"train": rows}, torch.device("cpu"), unexpected,
                                   mode="staged", maximum_bytes=1)
        sources, receipt = prepare_staged_batches({"train": rows}, torch.device("cpu"), unexpected, mode="legacy")
        self.assertEqual(sources, {})
        self.assertEqual(receipt["reason"], "explicit_reference")

    def test_cuda_budget_is_admitted_before_any_transfer(self):
        with patch.object(torch.cuda, "mem_get_info", return_value=(4, 100)) as memory:
            sources, receipt = prepare_staged_batches({"train": decisions()}, torch.device("cuda:0"),
                                                       lambda *_: self.fail("Unexpected allocation"))
        self.assertEqual(sources, {})
        self.assertEqual(receipt["admittedMaximumBytes"], 1)
        memory.assert_called_once()

    def test_invalid_shapes_rollout_banks_and_indices_are_rejected(self):
        for change in (lambda x: x[0]["observation"].update(entities=[]),
                       lambda x: x[0]["observation"].update(terrain=[]),
                       lambda x: x[0]["samples"][1].pop()):
            rows = decisions()
            change(rows)
            with self.assertRaises(ValueError):
                prepare_staged_batches({"train": rows}, torch.device("cpu"), learner.collate)
        phases, _ = prepare_staged_batches({"train": decisions()}, torch.device("cpu"), learner.collate)
        for indices in ([], [-1], [13], [True], [1.0], torch.tensor([1.])):
            with self.assertRaises(ValueError):
                phases["train"].get(indices)

    def test_full_optimizer_trajectory_validation_and_checkpoint_recovery_are_bit_exact(self):
        rows = decisions()
        phases, _ = prepare_staged_batches({"train": rows}, torch.device("cpu"), learner.collate)
        torch.manual_seed(123)
        base = A19ProposalModel(9, 7, 6, hidden=8)
        def fit(staged, recover=False):
            model = copy.deepcopy(base)
            optimizer = torch.optim.AdamW(model.parameters(), lr=.001, weight_decay=.0001)
            history = []
            for epoch in range(3):
                order = list(range(len(rows)))
                random.Random(90 + epoch).shuffle(order)
                model.train()
                for first in range(0, len(order), 4):
                    indices = order[first:first+4]
                    batch = phases["train"].get(indices) if staged else learner.collate([rows[i] for i in indices], torch.device("cpu"))
                    inputs, samples, mask, outcomes, selected, legal = batch
                    optimizer.zero_grad(set_to_none=True)
                    policy, value, primary = model(*inputs)
                    loss, _ = a19_proposal_loss(policy, value, primary, samples, mask, outcomes, selected, legal)
                    loss.backward()
                    self.assertTrue(all(p.grad is not None and torch.isfinite(p.grad).all() for p in model.parameters()))
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.)
                    optimizer.step()
                    history.append(float(loss.detach()))
                if recover and epoch == 0:
                    buffer = io.BytesIO()
                    torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "rng": torch.get_rng_state()}, buffer)
                    buffer.seek(0)
                    checkpoint = torch.load(buffer, weights_only=True)
                    model = copy.deepcopy(base)
                    optimizer = torch.optim.AdamW(model.parameters(), lr=.001, weight_decay=.0001)
                    model.load_state_dict(checkpoint["model"])
                    optimizer.load_state_dict(checkpoint["optimizer"])
                    torch.set_rng_state(checkpoint["rng"])
            return model, optimizer, history
        a, ao, ah = fit(False)
        b, bo, bh = fit(True, recover=True)
        self.assertEqual(ah, bh)
        assert_nested_equal(self, a.state_dict(), b.state_dict())
        assert_nested_equal(self, ao.state_dict(), bo.state_dict())
        self.assertEqual(learner.evaluate(a, rows, torch.device("cpu"), 4),
                         learner.evaluate(b, rows, torch.device("cpu"), 4, phases["train"]))

    def test_actual_learner_defaults_to_staging_and_resumes_exactly_across_storage_modes(self):
        with tempfile.TemporaryDirectory() as folder:
            campaign = Path(folder)
            contract = {"entities": list(range(9)), "candidates": list(range(7)), "globals": list(range(6)),
                        "contractSha256": "c" * 64}
            (campaign / "feature-contract.json").write_text(json.dumps(contract))
            receipts = {}
            for phase, rows in [("corpus_train", decisions(7)), ("corpus_validation", decisions(4))]:
                path = campaign / f"{phase}.json"
                path.write_text(json.dumps({"manifestSha256": "a" * 64, "stage": phase,
                    "games": [{"record": {"candidateResult": {0: "loss", .5: "draw", 1: "win"}[row["outcome"]]},
                               "training": {"decisions": [row]}} for row in rows]}))
                receipts[phase] = {"manifestSha256": "a" * 64, "sourceSha256": "b" * 64, "stage": phase,
                    "observationSha256": "c" * 64, "summary": {"teacherRollouts": 8},
                    "files": [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]}
            def fit(name, mode=None, resume=False, interrupt=None):
                output = campaign / "models" / name
                argv = [str(Path(learner.__file__)), "--campaign", str(campaign), "--repository",
                        str(Path(learner.__file__).resolve().parents[4]), "--out", str(output),
                        "--epochs", "3", "--batch-size", "4", "--seed", "42"]
                if mode:
                    argv += ["--batch-mode", mode]
                if resume:
                    argv += ["--resume"]
                def hardware(command, *args, **kwargs):
                    self.assertEqual(Path(command[1]).name, "preflight.py")
                    return subprocess.CompletedProcess(command, 0, "CPU test only; no GPU admission", "")
                try:
                    with patch.object(sys, "argv", argv), patch.object(learner, "torch", CpuTorch(interrupt)), \
                            patch.object(learner, "os", CpuOs()), patch.object(learner, "verify_stage",
                                side_effect=lambda _c, _r, stage, _b: receipts[stage]), \
                            patch.object(subprocess, "run", side_effect=hardware), \
                            patch.object(subprocess, "check_output", return_value=""), patch("builtins.print"):
                        learner.main()
                finally:
                    lease = output / "learner-lease.json"
                    if lease.exists():
                        self.assertEqual(json.loads(lease.read_text())["pid"], os.getpid())
                        lease.unlink()
                return output
            legacy = fit("legacy", "legacy")
            staged = fit("staged")
            log = json.loads(next(staged.glob("batching-*.json")).read_text())
            self.assertEqual(log["requestedMode"], "auto")
            self.assertEqual(log["actualMode"], "staged")
            with self.assertRaises(SimulatedInterruption):
                fit("resumed", interrupt=1)
            resumed = fit("resumed", "legacy", resume=True)
            for output in (staged, resumed):
                self.assertEqual((legacy / "research-model.json").read_bytes(), (output / "research-model.json").read_bytes())
                left = torch.load(legacy / "checkpoint.pt", map_location="cpu", weights_only=True)
                right = torch.load(output / "checkpoint.pt", map_location="cpu", weights_only=True)
                assert_nested_equal(self, left, right)


if __name__ == "__main__":
    unittest.main()
