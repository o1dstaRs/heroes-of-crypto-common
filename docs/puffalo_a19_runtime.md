# Puffalo A19 execution defaults

The CPU fight runtime uses Bun 1.4.4 or newer, six processes with four fight workers each,
two Bun GC markers per process, and nice level 10. The total simulation budget is 24 workers,
matching Puffalo's physical cores. The versioned defaults are in
[`scripts/puffalo_ai_meta_defaults.json`](../scripts/puffalo_ai_meta_defaults.json).

The default algorithm is **H64 / complementary R2 / shortlist 6 / max melee 10**, with uniform rollout allocation.
Use `a19-work` for cohort measurement: its finite work budget prevents machine load from silently
shortening a move through the live deadline. Complementary actor/lap-aligned sampling was adopted as the
general v0.8 default by explicit user instruction on October 25, accepting the remaining strength uncertainty.
Shorter horizons, plain independent R2, halving, and narrower/adaptive shortlists remain unadopted.

The complementary R2 candidate used **37.86% less elapsed time** than R4 in fresh offline fight timing.
Its separate 6,000-game comparison scored **48.91%**, with a 95% interval of **47.33–50.50%** against R4.
The interval does not establish the earlier 48% non-inferiority floor. That study used the material-tie
profile and offline certified bounds; the general-default integration preserves each caller's existing
arbitration and bound settings. The measured speed/strength result does not establish identical effects
in every cohort, live deadline mode, or deployment. Preserve this uncertainty in reports.

For explicit R4 rollback or historical comparison, set both `SEARCH_ROLLOUTS` to `"4"` and
`SEARCH_A19_COMPLEMENTARY_R2` to `"0"` through `V08_A19_SEARCH_ENV_OVERRIDES`. Ambient shell flags cannot
silently disable the sealed default. One-rollout deadline degradation uses the first actor-aligned stream, as in the measured candidate.
Higher-budget reference queries retain independent streams.

Future Puffalo jobs now use a clean published source containing the shared-aura rollback repair
(`6cb91b96d9b1b87daf47b006fd3813abebfa5522`). It restores shared object relationships during speculative
search; the general algorithm remains complementary R2. The runtime manifest and adoption receipt record
the precise published commit and source hash
(`105048137b3ff66079c6f2516d78b5daba5c587fa5061167ee3d1ee26651c178`). The clean published export passed
7,195 tests, TypeScript and lint; Linux bounds/chance/alias/default-profile tests and both launcher dry-runs
passed for this adoption. No cohort job or ranked deployment was started. Historical cohort and speed
results retain their original unrepaired-engine identities.

The separate [repaired-engine R8 reference](a19_r8_reference_research.md) scored 54.81% against R2 over
1,008 fresh games, with a whole-board 95% interval of 52.78–56.89%. That is a promising stronger teacher;
it does not change the default. Its single complete whole-job cost bank took 3.00 times R2's elapsed time
and 2.83 times its CPU; the second bank was interrupted by another campaign. Its follow-up pruning banks
remained unopened because that campaign occupied all 24 workers. These are separate from the historical
R2 cohort timings below. A live R8 promotion still requires held-out strength and deadline qualification.

The measured six-by-four layout reduced elapsed time by 27.16% against two-by-twelve in the
frozen 48-unique-fight benchmark, with exact action and outcome parity and 2.38% more CPU time.
This is a direct measurement of that fight workload, not a claim about every training pipeline.
The earlier repeated-corpus result was a separate 21.19% elapsed-time reduction.

On Puffalo, `hoc-a19-fights` selects the qualified fight runtime. `hoc-a19-meta` runs the canonical
`measure_ai_meta_cohorts.ts` pipeline through the AI meta report skill's process-sharded launcher,
using this config and the user-installed Bun. The launcher tiles globally seeded pair windows;
changing process layout must preserve the raw matchup records. It must refuse more than 24 total
workers and preserve failed output for diagnosis.

The canonical `a19-work` cohort path now enables certified, tight selection bounds. These skip only
rollout tails whose maximum possible score cannot change selection. H64, complementary R2, candidate
order, and the shortlisted actions stay the same. Live deadline profiles retain their existing settings;
full-score observers and other unsupported search modes remain excluded by the driver's guards.
The exact offline search overrides are recorded as `offlineSearchEnvironment` in report provenance.

On October 26, two fresh M4 Max banks replayed 168 distinct game instances in both arms (336 battles),
covering all seven cohorts, all three live maps, and both physical seats. All selected-turn traces,
committed events, and final results matched exactly, with zero rejected actions. Baseline/bounded wall
times were 147.77/108.39 seconds and 146.30/116.18 seconds: reductions of 26.65% and 20.59%.
Process CPU time decreased 2.21% and 2.67%, respectively. Orders were reversed between banks.
A separate 14-game comparison confirmed 9,309 versus 9,193 full-horizon rollouts, unchanged 6,586 leaf
probes, and exact traces. The elapsed gains are local measurements, not a Puffalo throughput claim;
the occupied node needs its own quiet calibration. The existing derived-board/aura cache was rejected:
it preserved 84 game traces but took 109.87 versus 97.72 seconds in its first valid bank. Ambient cache
flags are stripped before cohort workers initialize, so shell state cannot silently enable that arm.

The local timing protocol required at least 10% less elapsed time in both fresh banks, no more than
5% extra CPU time, exact full-game parity, and no rejected actions. An initial queue overlap affected
partial trials only; those files were retained and excluded before the two fresh deciding banks.
No new AI-strength gain is claimed from an optimization that retained the measured decisions.

For example, from the frozen, published common source:

```sh
hoc-a19-meta --games 1008 --seed 85000717 --out "$PWD/sim-out/meta-1008"
```

Use a fresh output directory. All seven cohorts include the three live maps and seat-swapped
matchup pairs. At 1,008 fights per cohort this is 7,056 fights, 3,528 pair clusters, and 336 fights
per map per cohort. This size measures throughput and exploratory rankings; it is too small to
establish close balance differences across all artifact and augment choices.

The HTML reports simulation wall time, total throughput, execution layout, overlapping cohort
spans, and accumulated process durations. Summed shard durations are neither elapsed wall time
nor measured CPU time. Preserve the runtime revision, source identity, seed, process layout,
GC setting, exact counts, and start/finish timestamps with every result. Keep generated outputs
outside Git.
