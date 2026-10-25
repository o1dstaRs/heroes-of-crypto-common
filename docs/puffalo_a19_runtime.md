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

The measured six-by-four layout reduced elapsed time by 27.16% against two-by-twelve in the
frozen 48-unique-fight benchmark, with exact action and outcome parity and 2.38% more CPU time.
This is a direct measurement of that fight workload, not a claim about every training pipeline.
The earlier repeated-corpus result was a separate 21.19% elapsed-time reduction.

On Puffalo, `hoc-a19-fights` selects the qualified fight runtime. `hoc-a19-meta` runs the canonical
`measure_ai_meta_cohorts.ts` pipeline through the AI meta report skill's process-sharded launcher,
using this config and the user-installed Bun. The launcher tiles globally seeded pair windows;
changing process layout must preserve the raw matchup records. It must refuse more than 24 total
workers and preserve failed output for diagnosis.

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
