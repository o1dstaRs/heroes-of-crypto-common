"""Native v0.9 dense ranker and canonical integer export. Importing starts no device."""
from copy import deepcopy
import math
import hashlib
import numpy as np
from tinygrad import Tensor, dtypes


def upload_native_feature_bank(raw, offsets, scales, *, device, chunk_rows=128, verify=False):
    """Normalize and fill resident storage without mapping a corpus-sized host allocation into KFD."""
    offsets = np.asarray(offsets, np.float32)
    scales = np.asarray(scales, np.float32)
    if (len(raw.shape) != 3 or raw.shape[0] < 1 or raw.shape[1] < 1 or raw.shape[2] != 166
            or offsets.shape != (166,) or scales.shape != (166,)
            or not np.isfinite(offsets).all() or not np.isfinite(scales).all()
            or not (scales > 0).all() or type(chunk_rows) is not int or chunk_rows < 1):
        raise ValueError('Declare a nonempty native feature bank and a positive upload chunk size')
    bank = Tensor.empty(*raw.shape, device=device, dtype=dtypes.float32).realize()
    digest = hashlib.sha256()
    maximum_host_chunk_bytes = 0
    for start in range(0, len(raw), chunk_rows):
        end = min(start + chunk_rows, len(raw))
        values = np.asarray(raw[start:end], np.float32)
        if not np.isfinite(values).all():
            raise ValueError('Native upload contains nonfinite observations')
        values = np.ascontiguousarray(((values - offsets) * scales).clip(-8, 8))
        digest.update(values.tobytes())
        maximum_host_chunk_bytes = max(maximum_host_chunk_bytes, values.nbytes)
        bank[start:end].assign(Tensor(values, device=device)).realize()
        bank = bank.realize().detach()
        if verify and not np.array_equal(bank[start:end].numpy(), values):
            raise ValueError('Native resident feature upload changed an input value')
    return bank, {
        'rows': len(raw), 'shape': list(raw.shape), 'normalizedFloat32Sha256': digest.hexdigest(),
        'maximumHostChunkBytes': maximum_host_chunk_bytes, 'chunkRows': chunk_rows,
        'readbackVerified': bool(verify),
    }


def select_native_candidates(scores, eligible, minimum_margin):
    """Batch the native selector, retaining exact ties, safety overrides and anchor fallback."""
    scores = np.asarray(scores)
    eligible = np.asarray(eligible)
    if (scores.ndim != 2 or not scores.shape[1] or eligible.shape != scores.shape
            or eligible.dtype != bool or not np.issubdtype(scores.dtype, np.integer)
            or (scores < -(2**31)).any() or (scores > 2**31 - 1).any()):
        raise ValueError('Aligned native int32 scores and boolean eligibility are required')
    if type(minimum_margin) is not int or not 1 <= minimum_margin <= 2**31 - 1:
        raise ValueError('Native override margin must be a positive int32')
    scores = scores.astype(np.int64, copy=False)
    best = np.where(eligible, scores, np.iinfo(np.int64).min).argmax(axis=-1)
    selected = np.where(
        (best != 0) & eligible[:, 0]
        & (scores[np.arange(len(scores)), best] - scores[:, 0] < minimum_margin),
        0, best,
    )
    return np.where(eligible.any(axis=-1), selected, 0)


class NativeMarginCalibration:
    """Select a predeclared margin from validation labels only; never consume battle outcomes."""

    def __init__(self, margins):
        margins = list(margins)
        if (not margins or len(set(margins)) != len(margins)
                or any(type(m) is not int or not 1 <= m <= 2**31 - 1 for m in margins)):
            raise ValueError('Declare unique positive int32 margins before calibration')
        self.margins = tuple(margins)
        self.rows = {margin: {'correct': 0, 'overrides': 0} for margin in margins}
        self.decisions = 0
        self.anchor_correct = 0

    def update(self, scores, eligible, teacher):
        scores = np.asarray(scores)
        eligible = np.asarray(eligible)
        teacher = np.asarray(teacher)
        selections = {m: select_native_candidates(scores, eligible, m) for m in self.margins}
        if (teacher.shape != (len(scores),) or not np.issubdtype(teacher.dtype, np.integer)
                or (teacher < 0).any() or (teacher >= scores.shape[1]).any()
                or not eligible[np.arange(len(scores)), teacher].all()):
            raise ValueError('Calibration requires exact eligible teacher labels')
        for margin, selected in selections.items():
            self.rows[margin]['correct'] += int((selected == teacher).sum())
            self.rows[margin]['overrides'] += int((selected != 0).sum())
        self.decisions += len(teacher)
        self.anchor_correct += int((teacher == 0).sum())

    def result(self):
        if not self.decisions:
            raise ValueError('No validation observations were calibrated')
        margin = max(self.margins, key=lambda m: (
            self.rows[m]['correct'], -self.rows[m]['overrides'], m,
        ))
        return {
            'minOverrideMargin': margin,
            'decisions': self.decisions,
            'servedAccuracy': self.rows[margin]['correct'] / self.decisions,
            'anchorAccuracy': self.anchor_correct / self.decisions,
            'overrides': self.rows[margin]['overrides'],
            'calibration': {m: dict(row) for m, row in self.rows.items()},
            'selection': 'validation agreement; ties prefer fewer overrides, then larger margin',
        }

def round_away_np(value):
    value = np.asarray(value, np.float64)
    return np.sign(value) * np.floor(np.abs(value) + 0.5)

def round_away(value):
    return value.sign() * (value.abs() + 0.5).floor()

def ste(value, quantized):
    return value + (quantized - value).detach()

def native_ranking_loss(scores, eligible, teacher_hot, override):
    logp = eligible.where(scores, -10000).log_softmax(axis=-1)
    classification = -(logp * teacher_hot).sum(axis=-1).mean()
    chosen = (scores * teacher_hot).sum(axis=-1)
    negative = -(chosen - scores[:, 0])
    softplus = negative.maximum(0) + (1 + (-negative.abs()).exp()).log()
    pairwise = (softplus * override).sum() / override.sum().maximum(1)
    return classification + 0.5 * pairwise

def quantize_layer(weight, bias, input_scale=256, frozen_shift=None):
    weight = np.asarray(weight, np.float64)
    bias = np.asarray(bias, np.float64)
    if weight.ndim != 2 or bias.shape != (weight.shape[0],) or (not np.isfinite(weight).all()) or (not np.isfinite(bias).all()):
        raise ValueError('Invalid native layer')
    maximum = float(np.max(np.abs(weight)))
    shift = (0 if maximum == 0 else max(0, min(24, math.floor(math.log2(127 / maximum))))) if frozen_shift is None else frozen_shift
    if type(shift) is not int or not 0 <= shift <= 24:
        raise ValueError('Invalid native quantization shift')
    while True:
        w = round_away_np(weight * 2 ** shift).clip(-127, 127).astype(np.int64)
        b = round_away_np(bias * (input_scale * 2 ** shift))
        safe = bool(((b >= -2 ** 31) & (b <= 2 ** 31 - 1)).all())
        safe = safe and bool((np.abs(w).sum(-1) * 32767 + np.abs(b) <= 2 ** 31 - 1).all())
        if safe:
            return (w, b.astype(np.int64), shift)
        if frozen_shift is not None or shift == 0:
            raise OverflowError('Native signed-int32 accumulator can overflow')
        shift -= 1

class NativeRanker:

    def __init__(self, hidden, offsets, scales, *, seed, device):
        self.hidden = tuple(hidden)
        self.offsets = np.asarray(offsets, np.float32)
        self.scales = np.asarray(scales, np.float32)
        if self.offsets.shape != (166,) or self.scales.shape != (166,) or (not np.isfinite(self.offsets).all()) or (not np.isfinite(self.scales).all()) or (not (self.scales > 0).all()):
            raise ValueError('Native normalization must have 166 finite features')
        self.device = device
        self.weights = []
        self.biases = []
        self.parameters = []
        rng = np.random.default_rng(seed)
        widths = [166, *hidden, 1]
        for fan_in, fan_out in zip(widths, widths[1:]):
            bound = 1 / math.sqrt(fan_in)
            w = Tensor(rng.uniform(-bound, bound, (fan_out, fan_in)).astype(np.float32), device=device).is_param_(True)
            b = Tensor(rng.uniform(-bound, bound, (fan_out,)).astype(np.float32), device=device).is_param_(True)
            self.weights.append(w)
            self.biases.append(b)
            self.parameters.extend([w, b])

    def normalize(self, raw):
        return ((np.asarray(raw, np.float32) - self.offsets) * self.scales).clip(-8, 8).astype(np.float32)

    def forward(self, normalized, *, qat=False, shifts=None):
        shape = normalized.shape[:-1]
        value = normalized.reshape(-1, 166)
        if qat:
            if shifts is None or len(shifts) != len(self.weights):
                raise ValueError('Missing frozen native QAT shifts')
            value = ste(value, round_away(value * 256).clip(-32767, 32767) / 256)
        for index, (weight, bias) in enumerate(zip(self.weights, self.biases)):
            if qat:
                shift = shifts[index]
                multiplier = 2 ** shift
                weight = ste(weight, round_away(weight * multiplier).clip(-127, 127) / multiplier)
                bias = ste(bias, round_away(bias * (256 * multiplier)) / (256 * multiplier))
            value = value.matmul(weight.T) + bias
            if index < len(self.weights) - 1:
                if qat:
                    value = ste(value, round_away(value * 256).clip(0, 32767) / 256)
                else:
                    value = value.relu()
            elif qat:
                value = ste(value, round_away(value * 256).clip(-2 ** 31, 2 ** 31 - 1) / 256)
        return value.reshape(shape)

    def snapshot(self):
        return [p.numpy().copy() for p in self.parameters]

    def restore(self, snapshot):
        if len(snapshot) != len(self.parameters):
            raise ValueError('Incomplete native snapshot')
        for p, value in zip(self.parameters, snapshot):
            if value.shape != p.shape or value.dtype != np.float32 or (not np.isfinite(value).all()):
                raise ValueError('Invalid native snapshot')
        for p, value in zip(self.parameters, snapshot):
            p.assign(Tensor(value.copy(), device=self.device)).realize()

    def layer_shifts(self):
        return tuple((quantize_layer(w.numpy(), b.numpy())[2] for w, b in zip(self.weights, self.biases)))

    def export(self, template, identity, *, margin=64, shifts=None):
        if template['architecture']['inputSize'] != 166 or len(template['features']['inputFeatureNames']) != 166:
            raise ValueError('Incompatible native template')
        artifact = deepcopy(template)
        layers = []
        if shifts is not None and len(shifts) != len(self.weights):
            raise ValueError('Incomplete native export shifts')
        for i, (w, b) in enumerate(zip(self.weights, self.biases)):
            wi, bi, shift = quantize_layer(w.numpy(), b.numpy(), frozen_shift=None if shifts is None else shifts[i])
            layers.append(dict(inputSize=wi.shape[1], outputSize=wi.shape[0], activation='linear' if i == len(self.weights) - 1 else 'relu', scaleShift=shift, weights=wi.reshape(-1).tolist(), biases=bi.tolist()))
        artifact.update(status='trained', promoted=False, qualification=None, modelId='native-v0.9-tinygrad-unsealed', modelSha256=None, source=deepcopy(identity), normalization={'offsets': self.offsets.tolist(), 'scales': self.scales.tolist()}, minOverrideMargin=margin, architecture={'kind': 'dense_candidate_ranker', 'inputSize': 166, 'hiddenSizes': list(self.hidden), 'outputSize': 1}, layers=layers, notes='UNPROMOTED native v0.9 fixed-point combat ranker. Tinygrad RDNA research; no A19 search at inference.')
        return artifact

def fixed_point_scores(artifact, raw):
    raw = np.asarray(raw, np.float64)
    shape = raw.shape[:-1]
    if raw.shape[-1] != 166 or not np.isfinite(raw).all():
        raise ValueError('Invalid native inference features')
    norm = artifact['normalization']
    fixed = artifact['fixedPoint']
    input_scale = fixed['inputScale']
    value = ((raw - np.asarray(norm['offsets'], np.float64)) * np.asarray(norm['scales'], np.float64)).clip(-fixed['inputClip'], fixed['inputClip'])
    value = round_away_np(value * input_scale).clip(-32767, 32767).astype(np.int64).reshape(-1, 166)
    for i, layer in enumerate(artifact['layers']):
        w = np.asarray(layer['weights'], np.int64).reshape(layer['outputSize'], layer['inputSize'])
        b = np.asarray(layer['biases'], np.int64)
        if (np.abs(w) > 127).any() or (np.abs(w).sum(-1) * 32767 + np.abs(b) > 2 ** 31 - 1).any():
            raise OverflowError('Unsafe native inference accumulator')
        acc = value @ w.T + b
        shift = layer['scaleShift']
        if shift:
            magnitude = (np.abs(acc) + (1 << shift - 1)) // (1 << shift)
            value = np.where(acc < 0, -magnitude, magnitude)
        else:
            value = acc
        if i < len(artifact['layers']) - 1:
            value = value.clip(0, 32767)
        else:
            value = value.clip(-2 ** 31, 2 ** 31 - 1)
    return value.reshape(shape)
