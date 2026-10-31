# Default staged batches for the A19 learner

The mainline `src/simulation/v0_9/python/a19_train.py` now prepares corpus tensors once and gathers
ordered batches from resident storage. `--batch-mode auto` is the default, so the existing guarded
GPU continuation selects this path without a new launch argument when the dataset fits.

The optimization changes input preparation, not the network, loss, labels, shuffled row order,
checkpoint identity, best-validation selection or export format. It does not change the shipped
H64/complementary-R2 game AI or qualify a learned serving policy.

## Memory and reference controls

The aggregate staging limit is 4 GiB by default. Before allocating corpus tensors, the learner
estimates both phases from their actual dimensions and rollout widths. CUDA staging also stays below
one quarter of currently free device memory. The remaining device memory is available for model,
optimizer and batch temporaries.

- `--batch-mode auto`: stage if admitted; otherwise use the original collator and record why.
- `--batch-mode staged`: require staging; reject an over-budget corpus before allocation.
- `--batch-mode legacy`: use the original per-batch collator for exact comparisons.
- `--staging-max-mib N`: change the aggregate cap within the bounded CLI range.

Each learner invocation writes `batching-<timestamp>.json` beside its checkpoints, recording the
requested/actual mode, phase sizes, admitted allocation and preparation time. Resume may use either
storage path because the returned batch values, local padded shapes and strides agree exactly.
Both four- and eight-rollout targets retain their original width. Unscored actions retain their
mask and zero padding; they do not become fabricated losses.

The source-bound teacher/corpus checks, approved GPU UUID, competing-workload check, hardware
preflight, epoch/fit limits and student strength gates still apply. Existing frozen research
capsules are immutable and do not pick up this mainline change. A new capsule must pass its own
source-bound CPU/software admission before fitting.

## Evidence and limits

The original isolated Puffalo benchmark used original/staged/staged/original one-epoch arms.
Each arm resets model and optimizer, trains a full epoch and evaluates the full validation set.
Per-arm elapsed includes setup/transfer:

| Pair | Original | Staged | Ratio | Reduction |
| ---- | -------: | -----: | ----: | --------: |
| Original first | 16.565755 s | 3.784474 s | 4.377294× | 77.1548% |
| Staged first | 13.947160 s | 3.885175 s | 3.589841× | 72.1436% |

Shared CPU loading took another 19.161832 seconds before those arms. The complete four-arm worker
took 64.823092 seconds. These measurements establish faster epoch processing on that admitted
corpus; they do not measure a full 20-epoch fit, corpus generation or live-game latency.

All training losses and six validation metrics agree exactly. An independent CPU reload also finds
all 258,595 model values bit exact across the four saved dictionaries. The benchmark's identity is
`a66cf5621412cd4cc490e07196fe98267e90bcb3e83da603d47c7023410ad42a`.

The mainline implementation uses the reference collator for the one-time pack. Its CPU controls
check shuffled/repeated indices, singleton strides, both rollout widths, output isolation, memory
fallback before allocation, finite gradients, exact optimizer trajectories and all validation
metrics. A complete learner invocation verifies the new default and interruption/resume across
storage modes, comparing the entire final checkpoint and JSON export with the legacy path.

The source-bound full-corpus CPU check also passes all 13,846 existing train/validation decisions,
including every shuffled batch's values/strides, four singleton checks and the actual maximum-batch
gradients. One-time staging takes 8.900018 seconds on that check, with 537,485,074 admitted bytes;
verification/loading plus the complete control pass takes 34.569748 seconds. CUDA visibility stays
empty. These are preparation/parity receipts, not a new GPU timing or strength result.

Run these controls in the admitted PyTorch environment with an empty CUDA visibility mask:

```bash
cd src/simulation/v0_9/python
CUDA_VISIBLE_DEVICES='' python -m unittest -v test_a19_batches test_a19_model test_a19_prepare_fit test_a19_gpu_continuation
```

CPU checks do not substitute for source-bound GPU throughput admission. Preserve the existing
120-second first-epoch and 1,200-second active-fit limits when using a new capsule.
