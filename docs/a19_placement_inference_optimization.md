# Exact placement inference optimization

The v13 placement selector now caches a compiled predictor for each of its two
unchanged packed models. The compiler owns a private tensor snapshot. Each call
builds its nonzero-input indices afresh; no match, unit, feature mask or result
is cached. Both model identities, candidate proposals, reference choice and
strict 0.03 margin are unchanged.

Skip only zero-input products in the first affine layer, followed by its ReLU.
Weights are finite and nonzero products retain their original index order.
Omitting zero additions can affect a zero accumulator's sign; the ReLU normalizes
that sign. Single-layer outputs retain dense evaluation. Later layers use the
original evaluator. Do not regroup products, quantize inputs or extend the
shortcut to a linear output without a separate proof.

The [evidence](evidence/a19_placement_sparse_inference_20261119.json) records a
local serial, counterbalanced comparison of the actual serving adapter, including
input validation, eight proposals, both scoring stages and the output map. Across
72 balanced public input cases and 576 selections per arm, dense CPU was 6.806 s
and compiled CPU 4.596 s: **32.47% less warm selector CPU**. One-time compilation
added 5.803 ms of CPU for both cached predictors. The forward-only prototype was
92.09% cheaper; that narrower figure is not complete-selector or full-match speed.
These are reused, unscored inputs from the running learning corpus, not fresh
strength samples or production latency certification.

Every tested score and complete placement map matched exactly. Tests retain
binary64 strict-margin boundaries, ordered accumulation, signed zero, subnormal
products, finite overflow, model snapshots and nonfinite-weight rejection. Six
known complete native games, three dense and three compiled, have identical full
outcomes, traces, journals and search-decision counts across maps 1, 3 and 4.
Both compiled model accessors actually ran in every optimized control.

The initial native harness incorrectly compared a vanilla third case against its
saved forced-template-5 reference. That failed assertion and all completed dense
results remain preserved. The corrected comparison reused those three complete
vanilla baselines without replaying them; only the three unexecuted compiled
variants ran. The first two baselines also match their original Linux controls.
The third saved Linux fixture remains a different, unchanged forced formation.
This was a fixture mismatch, not an excluded case or a native-quality exemption.

The independent placement-learning source `a0263806` remains frozen and running
with its original dense implementation. Its data, final-80 recipe and strength /
confirmation / overall-average +10% CPU gates are unchanged. This optimization
adds no trained artifact or strength estimate and does not deploy the servers.
