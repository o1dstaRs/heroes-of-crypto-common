# Peasant attack-position conditional futures

Registered November 17, 2026 UTC as `peasant-position-futures-20261117`. This is a separate diagnostic
following the closed [post-movement coverage study](peasant_postmove_research.md). No serving policy,
model weights or Premium route changes. The earlier shortlist candidate and all failed gates remain closed.

The earlier forced comparison found one draw-to-win by attacking the same Squire from another square.
Both choices killed it, lost 13 HP and earned the same armor bonus. One realized continuation cannot
establish that the alternative is better on average. The present audit varies subsequent chance and
the future controller separately, without choosing another root action from the new outcomes.

## Fixed sample and interventions

Use **all 18 same-target roots** from the earlier registered 28-root audit, regardless of their historical
result. The native final action and earlier proposal are fixed. Each root receives **16 new matched
post-root combat seeds**, shared by both actions and two continuation controllers. These remain 18
reused position families, not 288 independent army families or a fresh full-policy strength bank.

Reseeding happens after the original final neural choice and before executing the registered action.
The complete prefix and original search decision stay fixed. Preserve the current UUID counter and
return the original native action-array reference when retaining the native action. Copies are used
only when actually changing the action; the engine uses reference identity to commit target memory.

Both armies subsequently use either full adopted A19 or plain v0.8 with the same rollout-origin context
fields used by simulated native decisions. The latter disables subsequent search only after the root
turn has committed. It is a **native-strategy ablation in the canonical complete engine**, not a claim
to reproduce every detail of private `SearchDriver.simPlayTurn` plumbing or special overrides.

## Registration and verification

Original registration SHA-256: `42a919766317eba95f1d141155f817f035fc025201ee6c7b8e341954ee1adf6d`.
Its batch is excluded after the recording correction below. Corrected registration:
`45e70305c10bc4a70bc7dfb78453188a7fc09831caf629ad943492d45f3f23ce`.
The active ignored client capsule is `game/core/tmp/peasant-position-futures-20261117-v2`. It references the prior
sealed runtime through a relative read-only link so historical prefixes can reproduce exactly. The
adopted A19 profile and search driver still match shared main at registration. The sole current tracked
source difference is legacy A13 environment clearing; it is recorded in `source-context.json` and excluded.
The parent source freeze, all runtime hashes and exact module identity are verified at every stage.

The fixed stages contain **1,230 executions**:

- 36 complete historical controls and six cold controls.
- 12 conditional admission executions: first same-target root per map, first future, all four arms.
- 1,152 main executions: 18 roots × 16 futures × two actions × two continuation controllers.
- 24 cold main replays: first root per map, futures 0 and 15, all four arms.

Controls must reproduce all prior inputs, actions, events, health and outcomes. All conditional arms
must retain the exact prefix and pre-action state. The same action must give the same post-root full
battle state, target memory, UUID sequence and consumed random draws under both continuation
controllers. Every committed root action, neural receipt, raw checksum, response-price bound and
health ledger is checked. The native ablation must make zero subsequent search calls. Cold results
must reproduce exactly. Errors stop the pipeline and preserve all partial output.

Two nice-19 local workers share the workstation with a peer campaign; no GPU is used. The original
hard cutoff is **2026-11-17 02:43:01 UTC**, with a 768 MiB free-disk floor and no automatic restart or
extension. No strength claim may come from an incomplete bank.

### Recording correction before outcome analysis

The original batch reproduced all 36 historical games and six cold controls, but subsequent manual
inspection found that its snapshot serializer used plain JSON on Maps and Sets. That omitted unit
snapshot and target-memory contents from the cross-controller state witness. Complete battle replay
parity does not repair that missing state check. The original 111 emitted executions (42 controls,
12 admission, 57 main) are preserved and excluded; no main outcome aggregate was inspected.

V2 preserves all Map/Set entries and asserts the complete unit inventory before and after serialization.
Two regression tests with eight assertions cover nested unit/effect maps, target memory, grid and fight
containers, nonmutation, and rejection of already-lost maps or mismatched unit inventories. The entire
fixed sample is rerun in the separate corrected capsule. Roots, actions, seeds, future controllers,
source engine, analysis, resource limits and the original hard cutoff are unchanged. This corrects a
measurement witness, not an AI policy or observed result.

The new namespace is `peasant-position-futures-20261117-postroot-v1`. Its 288 used streams were checked
against 152 prior ledgers, including compact raw/permuted expansions. Python allocation and independent
Bun verification agree. Reserve **every one of the 2,048 scanned preimages**, including rejected and
unused candidates: for each preimage reserve 32 raw channels and their canonical
`permuteRankedDraftSeed` values, **131,072 distinct channels** in total. The compact evidence fixture
retains these preimages. Earlier Peasant reservations also stay excluded.

## Analysis fixed before execution

Win/draw/loss score is 1/0.5/0. Retain every native result and report non-elimination outcomes separately.
Average each root's 16 paired differences, then weight the 18 roots equally. The 20,000-draw
whole-position bootstrap is descriptive for these reused conditional roots. Exact paired sign-flip
tests are adjusted with Holm across all 36 root/controller comparisons. Report both eight-future
halves without selecting a replacement action or a favorable subset.

The analysis compares the two continuation controllers from identical post-root states and random
streams. It does not turn the simpler controller into a new default. Conditional action returns can
inform a later hypothesis, but a useful new selector still needs a distinct candidate, representative
whole-game evaluation, fresh qualification/confirmation and serving-cost evidence.

## Completed result: no qualified improvement

All **1,230 registered study executions** completed and verified. A separate 21-execution input export
below also passed, bringing the valid total to **1,251**. The original 111 excluded executions remain
preserved separately. The complete source, inputs, prefixes, committed actions, health records, random
streams and cold replays passed their checks. No default, model weights or Premium route changed.

| Future controller    | Native action score | Alternate action score |     Difference | Descriptive 95% interval |
| -------------------- | ------------------: | ---------------------: | -------------: | -----------------------: |
| Adopted A19          |            88.7153% |               88.0208% | **−0.6944 pp** |    −3.9931 to +1.5625 pp |
| Native v0.8 ablation |            85.7639% |               86.1111% |     +0.3472 pp |    −1.0417 to +2.0833 pp |

Each row contains 288 paired conditional worlds across the same 18 reused positions. These high
absolute scores describe this selected position set, not overall ranked strength. Under A19 there were
seven improved pairs, six regressions and 275 unchanged pairs; the regressions cost more score than
the improvements gained. All games ended by elimination, with simultaneous-elimination draws retained.
Neither interval supports a gain, and none of the 36 root/controller comparisons survives the fixed
Holm adjustment. Changing both armies' future controller does not compare the strength of A19 with v0.8.

All nonzero position means are shown below. The other 13 positions had zero difference under both
controllers. Their complete outcomes, including the all-loss position `f15`, remain in the evidence.

| Position / target | A19 difference | Native ablation difference | A19 first eight / last eight |
| ----------------- | -------------: | -------------------------: | ---------------------------: |
| f19 / Squire      |      +6.250 pp |                  −6.250 pp |           +6.250 / +6.250 pp |
| f20 / Elf         |      −3.125 pp |                 +12.500 pp |                0 / −6.250 pp |
| f21 / Centaur     |      +3.125 pp |                          0 |                0 / +6.250 pp |
| f24 / Wyvern      |     −25.000 pp |                          0 |         −37.500 / −12.500 pp |
| f27 / Elf         |      +6.250 pp |                          0 |               0 / +12.500 pp |

The original Squire example `f19` remained positive in the A19 sample: 13 wins, one draw and two losses
became 14 wins, one draw and one loss. However, its paired sign-flip p-value is 0.75 before adjustment,
and its direction reverses with the native continuation ablation. The earlier single draw-to-win is
therefore still a hypothesis, not a reliable tactical rule. In `f24`, moving from (7,14) to (8,15) before
killing the same Wyvern changed four wins into losses across 16 futures; neither arm won under the
native ablation. Preserve both examples rather than selecting only the Squire improvement.

Independent Bun verification reconstructed all 36 sign-flip distributions by exhaustive enumeration,
the Holm family and both eight-future halves. It also computed the exact discrete whole-position
bootstrap over all 18^18 resampling sequences; both endpoints match the registered 20,000-draw Python
analysis. All 1,152 main executions retain exactly the historical root predictions and pre-action state.
Reconstructing each seeded RNG reproduces its complete recorded draw-stream hash and root prefix.

## What this diagnoses

A supplemental read-only mechanism audit covers every root and future. For **all five positions with
nonzero score differences**, both actions leave identical immediate Peasant HP, stack count, armor,
steps and Bitter Experience stacks, kill the same target, and consume identical root random draws
in all 16 futures. The final attack square and subsequent play differ. A generic bonus for earning
cheap armor cannot distinguish the observed improvement from the observed regression.

This equivalence is not assumed for every other root: `f12`, `f15` and `f16` change the immediate actor
summary, and `f05` changes root RNG consumption. All 18 remain in the fixed analysis. Equal random seeds
do not mean later stochastic events remain aligned after the strategies choose different actions.

The model already receives current unit positions, movement paths and final attack-square coordinates.
The historical Squire and Wyvern alternatives have similar movement-associated logit gaps (−0.4603
and −0.4534), despite opposite sampled A19 returns. Logits are not win probabilities, and these examples
do not justify removing a movement penalty or relaxing the existing neural margin.

A separate future hypothesis could learn positional value from actual A19 continuations using legal
pre-decision inputs. It needs representative new positions, retained null/loss examples, explicit handling
of controller-dependent labels, independent whole-policy qualification and confirmation, and serving-cost
evidence. This small reused corpus is development material only. Do not fit or activate a rule from its
favorable cases, reopen earlier failed candidates, or treat deeper native forecasts as a demonstrated fix.

## Development input export

A separate read-only export was registered before the main analysis completed, SHA-256
`d439239b8b30e0dd165bf39e4853e891c4cc048218a126d047cbd5c8de05f4ac`. It replays all 18 native
historical controls plus the first root per map cold, after the main pipeline finishes. The observer
copies the complete observation already consumed by the existing neural prediction, including terrain;
it makes no additional model calls. The first diagnostic observer retained only part of that observation,
which is sufficient for its checks but not a complete model-training input.

The export must reproduce every control action, event, health record, neural receipt and outcome,
including the three cold replays. Inputs and measured future labels are stored separately in
`development-corpus.jsonl.gz` in the corrected capsule. All 18 roots remain present, including losing
and null comparisons. These are development examples from reused positions, not fresh validation,
and exporting them neither fits weights nor qualifies a new policy. The same two-worker limit,
original cutoff and disk floor apply.

The export completed all 18 exact controls and three exact cold replays with **zero additional
predictions**. The corpus contains 18 complete pre-decision observations, 576 paired action-world labels
across the two controllers and 1,152 individual outcome labels. Future seeds and outcomes are outside
the input object. Corpus SHA-256 is
`71ddbb1f102fe9859b4871e4a127a895e851432ec1b82227c051fabab8bada10`; decompressed SHA-256 is
`b1674a27f463f3d8d29387f12439191020553a64c359d6fb8f9b3e0ed1bbb5dd`.

The compact tracked [evidence fixture](evidence/peasant_position_futures_20261117.json) retains all paired
scores, seed reservations, input audits, original/corrected registrations and artifact hashes. The ignored
capsule retains full battles, model inputs, scripts and raw-byte receipts; start with `HANDOFF.txt`.
