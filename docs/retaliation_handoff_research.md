# Retaliation handoff research

`retaliation-handoff-wait-v1` is an offline candidate. The adopted contextual draft, funded ranged setup,
native formation/support and A19 combat remain the control and the serving default. The preceding
[melee delivery trial](melee_delivery_diversity_research.md) failed; its result and gates remain closed.

## Fixed hypothesis

The active-challenger filter ordinarily discards a wait when the native action is a melee attack. This
candidate admits one legal wait when another adjacent, unacted ally could attack the same defender and
consume its still-available response. The full engine continuation decides whether waiting is useful.
It does not assume that the ally attacks, survives, hits, kills, or acts before the defender moves.

`src/simulation/retaliation_handoff_research.ts` reads only public root combat state. It uses the canonical
Hourglass and retaliation gates and checks hidden targets, attack type, ally readiness, forced target,
Cowardice, forbidden targets and footprint adjacency. Lightning Spin and skip-response attackers are
excluded. Focused tests include an engine-executed wait followed by an ally consuming the response and
verify that inspecting the opportunity changes neither state nor RNG.

Only a copied, offline SearchDriver admits the wait. One already-legal wait is retained within the normal
challenger limit, preserving the leading challenger; existing specialized reservations follow normally.
The incumbent stays present. There are no extra full-horizon rollouts, horizon changes, learned weights,
or changes to private rollout policies. One additional immediate leaf can be evaluated. Existing A19
scoring/arbitration decides; force-productive, dominant-finish and urgent-finish safeguards remain intact.
Neither the helper nor an enable switch is imported by serving code.

## Prospective protocol

Study `retaliation-handoff-20261115-v1`, registration SHA-256
`5ddde8da61d439d9e135c0393b2c7886da61210c8e2d7b61155b2d5869412ed6`, seals 2,553 files before the first
execution. Common source is `85d3ffc5819ac2e178fa3e986c5e4ae895e878ac`; the native server adapter freezes
`916e3ca3ccb14c093c7f550d880074640c5b9988`, with the documented offline hook and seeded runtime identity
overlays. The capsule owns its common package resolution and asserts shared RNG and fight singleton
identity. Every arm independently reconstructs its opening.

The fixed smoke bank reuses all 54 corrected compatibility cases from the preceding trial, across all
three maps and nine doctrine pairs. Off, observer and treatment execute 162 complete games. Admission
requires exact off/observer and prior corrected control traces, zero rejected/censored games or neural
errors, at least five eligible decisions across two unit types and two maps, at least one chosen wait,
and at least one changed complete trajectory. No win-rate inference is made from this screen.

Only after admission, all 162 already-opened development families run both draft assignments and both
physical seats: 648 cases per arm, 1,296 games. Arm execution order alternates. This reused population
is development, not independent confirmation. The fixed progression gate is at least +0.5 percentage
points in draw-aware score, a nonnegative mean for every own doctrine budget and zero quality errors.
The analysis includes a whole-family 20,000-resample bootstrap, fixed xorshift32 seed 2026111592, and
an exact two-sided family sign-flip test. No outcome masks or threshold retuning are allowed.

Future independent evaluation requires a separate prospective global seed exclusion audit and registration:
864 qualification families, then 1,512 confirmation families only after a pass. Each stage needs the fixed
gain and positive whole-family interval, nonnegative doctrine means and serial additional compute within
10%. A fixed contrasting opponent panel supplements those stages. No fresh channels have been allocated
by this development study, and no outcome automatically changes a default.

The local capsule is under the client's `game/core/tmp/retaliation-handoff-20261115`. It preserves frozen
sources, input cases, registration, runner, independent opening receipts, raw complete traces and analysis.

## Status

The screen passed: 32 admitted opportunities across 13 unit types and all three maps, 15 chosen waits,
and eight changed trajectories. All 54 off/observer pairs and corrected prior controls matched exactly;
nine additional cold-process controls also matched. No rejected action, missing neural start or model
error occurred.

The original analyzer incorrectly asserted that every helper opportunity must survive all native filters.
Four Angel waits were correctly vetoed before the experimental active-challenger return. The separately
preserved `analysis-correction.json` and `analyze-native-guards.py` permit these native vetoes, report them
separately and count only admitted treatment waits toward coverage. The original registration, failed
analysis, policy, cases, outcomes and thresholds remain unchanged; no strength aggregate was read before
this correction. This narrows the activation count from 36 inspected opportunities to 32 admitted waits.

## Completed development: no finalist

All 162 whole families / 1,296 games completed. The candidate scored **51.234568%** (326 wins, 12 draws,
310 losses), versus **51.003086%** (325 wins, 11 draws, 312 losses) for the adopted control. The paired
gain was **+0.231481 percentage points**, with whole-family 95% interval **−0.462963 to +0.925926 pp**
and exact two-sided sign-flip p = 0.6875. The fixed +0.5 pp development gate failed. No fresh qualification
or confirmation bank opened; no model was fitted or default changed.

The five-, six- and seven-point gains were respectively +0.231481, +0.462963 and 0 pp, with 216 cases per
arm in each budget. These nonnegative slices do not rescue the failed overall gate. Across development,
258 admitted opportunities covered 38 unit types and all three maps; 127 waits were chosen, changing
102 complete trajectories. Four cases improved and two worsened. All games reached terminal elimination
with zero action rejects or neural start/model errors. All 648 independently rebuilt controls reproduced
the preceding corrected study's complete traces. A separate TypeScript verifier reconstructed all family
deltas, bootstrap endpoints, sign-flip counts and the failed gate using integer arithmetic.

Aggregate parallel fight time rose 0.62%, and recorded rollout turns rose 0.50%. These observations are
not a serial production timing qualification. Preserve the helper and
[compact evidence](evidence/retaliation_handoff_20261115.json), including the original analyzer failure
and its correction. Do not enable the candidate, lower its threshold or claim a confirmed strength gain.
