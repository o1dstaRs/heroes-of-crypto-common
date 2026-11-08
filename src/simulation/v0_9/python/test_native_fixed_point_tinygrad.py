import json, unittest
from pathlib import Path
import numpy as np
from tinygrad import Tensor
from native_fixed_point_tinygrad import NativeRanker, fixed_point_scores, native_ranking_loss, quantize_layer, round_away, round_away_np
from parity import score as scalar_fixed_point_score
from native_fixed_point_tinygrad import NativeMarginCalibration, select_native_candidates
from native_fixed_point_tinygrad import upload_native_feature_bank

def template_fixture():
    return {'schema': 'hoc.ai.v0_9_model.v1', 'architecture': {'inputSize': 166}, 'features': {'inputFeatureNames': [f'feature-{i}' for i in range(166)]}, 'fixedPoint': {'inputScale': 256, 'inputClip': 8}, 'status': 'anchor_only', 'promoted': False}

class NativeBackendTests(unittest.TestCase):

    def test_bounded_upload_preserves_every_value_and_partial_tail(self):
        import hashlib
        rng = np.random.default_rng(71811)
        raw = rng.uniform(-20, 20, (5, 3, 166)).astype(np.float32)
        offsets = rng.uniform(-1, 1, 166).astype(np.float32)
        scales = rng.uniform(.1, 2, 166).astype(np.float32)
        expected = ((raw - offsets) * scales).clip(-8, 8)
        bank, receipt = upload_native_feature_bank(raw, offsets, scales, device='CPU', chunk_rows=2, verify=True)
        np.testing.assert_array_equal(bank.numpy(), expected)
        self.assertEqual(receipt['normalizedFloat32Sha256'], hashlib.sha256(expected.tobytes()).hexdigest())
        self.assertEqual(receipt['maximumHostChunkBytes'], 2 * 3 * 166 * 4)
        self.assertTrue(receipt['readbackVerified'])

    def test_bounded_upload_rejects_invalid_shapes_and_normalization(self):
        raw = np.zeros((2, 3, 166), np.float32)
        for rows in [0, -1, True]:
            with self.assertRaises(ValueError):
                upload_native_feature_bank(raw, np.zeros(166), np.ones(166), device='CPU', chunk_rows=rows)
        with self.assertRaises(ValueError):
            upload_native_feature_bank(raw, np.zeros(166), np.zeros(166), device='CPU')
        with self.assertRaises(ValueError):
            upload_native_feature_bank(raw[:, :, :165], np.zeros(166), np.ones(166), device='CPU')

    def test_selection_preserves_safety_ties_and_all_guarded_fallback(self):
        scores = np.asarray([[10, 10, 100], [7, 6, 5], [0, -2, 5], [0, 19, 20]], np.int64)
        eligible = np.asarray([[True, True, False], [False, True, True],
                               [False, False, False], [True, True, True]])
        np.testing.assert_array_equal(select_native_candidates(scores, eligible, 20), [0, 1, 0, 2])
        with self.assertRaises(ValueError):
            select_native_candidates(scores.astype(np.float64), eligible, 20)
        with self.assertRaises(ValueError):
            select_native_candidates(scores, eligible, 0)

    def test_validation_margin_calibration_is_streamable_and_conservative(self):
        scores = np.asarray([[0, 30], [0, 15], [0, 1]], np.int64)
        eligible = np.ones(scores.shape, bool)
        teacher = np.asarray([1, 0, 0], np.int64)
        full = NativeMarginCalibration([1, 16, 32])
        full.update(scores, eligible, teacher)
        stream = NativeMarginCalibration([1, 16, 32])
        stream.update(scores[:1], eligible[:1], teacher[:1])
        stream.update(scores[1:], eligible[1:], teacher[1:])
        self.assertEqual(full.result(), stream.result())
        self.assertEqual(full.result()['minOverrideMargin'], 16)
        self.assertEqual(full.result()['servedAccuracy'], 1.)
        tie = NativeMarginCalibration([32, 64])
        tie.update(scores, eligible, teacher)
        self.assertEqual(tie.result()['minOverrideMargin'], 64)

    def test_margin_calibration_rejects_missing_or_guarded_teacher_labels(self):
        calibration = NativeMarginCalibration([1, 16])
        with self.assertRaises(ValueError):
            calibration.result()
        with self.assertRaises(ValueError):
            calibration.update(np.asarray([[0, 2]]), np.asarray([[True, False]]), np.asarray([1]))
        self.assertEqual(calibration.decisions, 0)
        with self.assertRaises(ValueError):
            NativeMarginCalibration([1, 1])

    def test_integer_batch_matches_existing_scalar_reference(self):
        rng = np.random.default_rng(7108)
        offsets = rng.uniform(-2, 2, 166).astype(np.float32)
        scales = rng.uniform(.1, 2, 166).astype(np.float32)
        model = NativeRanker([8, 4], offsets, scales, seed=117, device='CPU')
        identity = {'commonCommit': '1' * 40, 'rulesSha256': '2' * 64,
                    'rosterSha256': '3' * 64, 'trainingRunId': '4' * 64}
        artifact = model.export(template_fixture(), identity)
        values = rng.uniform(-100, 100, (20, 166))
        values[0] = offsets
        actual = fixed_point_scores(artifact, values)
        expected = [scalar_fixed_point_score(artifact, row.tolist()) for row in values]
        np.testing.assert_array_equal(actual, expected)

    def test_half_away_signed_boundaries(self):
        values = np.asarray([-2.5, -1.5, -0.5, -0.499, 0, 0.499, 0.5, 1.5, 2.5], np.float32)
        expected = np.asarray([-3, -2, -1, 0, 0, 0, 1, 2, 3], np.float32)
        np.testing.assert_array_equal(round_away_np(values), expected)
        np.testing.assert_array_equal(round_away(Tensor(values, device='CPU')).numpy(), expected)

    def test_loss_gradient_keeps_guarded_candidates_out(self):
        values = np.asarray([[0.1, 0.5, 200], [1, 0.3, -100]], np.float32)
        mask = np.asarray([[True, True, False], [True, True, False]])
        labels = np.asarray([[0, 1, 0], [1, 0, 0]], np.float32)
        scores = Tensor(values, device='CPU').is_param_(True)
        loss = native_ranking_loss(scores, Tensor(mask, device='CPU'), Tensor(labels, device='CPU'), Tensor([1.0, 0.0], device='CPU'))
        gradient = loss.gradient(scores)[0].numpy()
        self.assertTrue(np.isfinite(gradient).all())
        np.testing.assert_array_equal(gradient[:, 2], 0)
        self.assertLess(gradient[0, 1], 0)
        self.assertLess(gradient[1, 0], 0)
        for row, col in [(0, 0), (0, 1), (1, 0), (1, 1)]:
            outputs = []
            for delta in [-0.001, 0.001]:
                changed = values.copy()
                changed[row, col] += delta
                result = native_ranking_loss(Tensor(changed, device='CPU'), Tensor(mask, device='CPU'), Tensor(labels, device='CPU'), Tensor([1.0, 0.0], device='CPU'))
                outputs.append(float(result.item()))
            self.assertAlmostEqual(float(gradient[row, col]), (outputs[1] - outputs[0]) / 0.002, delta=0.0001)

    def test_no_override_rows_have_finite_loss(self):
        scores = Tensor([[0.1, 0.2]], device='CPU').is_param_(True)
        loss = native_ranking_loss(scores, Tensor([[True, True]], device='CPU'), Tensor([[1.0, 0.0]], device='CPU'), Tensor([0.0], device='CPU'))
        self.assertTrue(np.isfinite(loss.gradient(scores)[0].numpy()).all())

    def test_quantization_checks_integer_accumulators(self):
        weights = np.asarray([[0.5, -0.5], [0.25, -0.25]], np.float32)
        bias = np.asarray([0.125, -0.125], np.float32)
        w, b, shift = quantize_layer(weights, bias, frozen_shift=1)
        np.testing.assert_array_equal(w, [[1, -1], [1, -1]])
        np.testing.assert_array_equal(b, [64, -64])
        self.assertEqual(shift, 1)
        with self.assertRaises(OverflowError):
            quantize_layer(weights, np.asarray([10000000000.0, 0]), frozen_shift=1)
        with self.assertRaises(ValueError):
            quantize_layer(weights, bias, frozen_shift=-1)

    def test_export_retains_anchor_template_and_research_status(self):
        template = template_fixture()
        before = json.dumps(template, sort_keys=True)
        model = NativeRanker([8, 4], np.zeros(166), np.ones(166), seed=117, device='CPU')
        identity = {'commonCommit': '1' * 40, 'rulesSha256': '2' * 64, 'rosterSha256': '3' * 64, 'trainingRunId': '4' * 64}
        artifact = model.export(template, identity)
        self.assertEqual(json.dumps(template, sort_keys=True), before)
        self.assertEqual(artifact['status'], 'trained')
        self.assertFalse(artifact['promoted'])
        self.assertIsNone(artifact['qualification'])
        self.assertIsNone(artifact['modelSha256'])
        self.assertEqual(artifact['architecture']['hiddenSizes'], [8, 4])
        self.assertEqual(len(artifact['layers']), 3)

    def test_qat_forward_matches_integer_export_on_exact_inputs(self):
        template = template_fixture()
        model = NativeRanker([4], np.zeros(166), np.ones(166), seed=117, device='CPU')
        w = np.zeros((4, 166), np.float32)
        w[0, 0] = 0.5
        w[1, 1] = -0.5
        w[2, 2] = 0.25
        w[3, 3] = 0.75
        b = np.asarray([0.125, -0.125, 0, 0.25], np.float32)
        out = np.asarray([[0.5, -0.25, 0.75, 0.125]], np.float32)
        out_bias = np.asarray([0.125], np.float32)
        for parameter, value in zip(model.parameters, [w, b, out, out_bias]):
            parameter.assign(Tensor(value, device='CPU')).realize()
        values = np.zeros((5, 166), np.float32)
        values[:, :4] = np.asarray([[1, -1, 2, 1], [-1, 1, -2, -1], [0, 0, 0, 0], [0.5, -0.5, 0.25, 0.75], [8, -8, 8, 8]], np.float32)
        shifts = (4, 4)
        artifact = model.export(template, {'commonCommit': '1' * 40, 'rulesSha256': '2' * 64, 'rosterSha256': '3' * 64, 'trainingRunId': '4' * 64}, shifts=shifts)
        actual = model.forward(Tensor(values, device='CPU'), qat=True, shifts=shifts).numpy() * 256
        np.testing.assert_array_equal(actual, fixed_point_scores(artifact, values))

    def test_snapshot_restores_all_trained_parameters(self):
        model = NativeRanker([8], np.zeros(166), np.ones(166), seed=117, device='CPU')
        snapshot = model.snapshot()
        model.parameters[0].assign(model.parameters[0] + 0.1).realize()
        model.restore(snapshot)
        for a, b in zip(snapshot, model.snapshot()):
            np.testing.assert_array_equal(a, b)
        with self.assertRaises(ValueError):
            model.restore(snapshot[:-1])
if __name__ == '__main__':
    unittest.main()
