# A19 combat candidates — registered 2026-10-24

Status: research only. No candidate is enabled in a shipped profile by this protocol.

The objective is a full-match win-rate gain over current ranked A19, rather than more projected damage,
more attacks, or a favorable selected matchup. Draft and setup stay fixed.

## Candidates and frozen controls

- S: range-candidate ranking that distinguishes the shared Ember Covenant from individual Water Shields,
  including their interaction across native volleys and Echo. Unsupported damage sequences retain the control.
- M: whole-impact melee candidate ranking for non-Hydra sweeping attacks. Its exact implementation must be
  frozen before its screen starts. It is a separate arm, not a package with S.

Both use the current server's A19 environment, default ranked draft and setup, live synergies, funded augments,
side boards and tactical splits. Read the three server defaults as source data using `readA19AuditProfile`.
Record those sources and hashes with the common source, runtime, candidate patch, runner and invocation.
If a rule changes after outcomes are inspected, give it a new identity and new seeds.

Reuse `playRankedDraftGame` and its existing four-game army/seat crossover. Each independent offer-board
cluster contains both draft-arm assignments and both physical seats at the same combat seed. Maps are Normal,
Lava and Block in equal numbers. Wins score 1, draws 0.5, losses 0; decisive-only rates are supplementary.
Confidence resampling and sign-flip tests use whole four-game army clusters, never individual fights.

## Fixed stages

- A/A calibration: 24 offer boards / 96 games, seed 2026102400; candidate disabled. Require exactly 50%
  score, zero rejected actions, and reproducible trajectories on a fixed subset.
- Screen: 300 fresh offer boards / 1,200 games per candidate, seed 2026102401. No optional stopping.
  A candidate qualifies only if its army-clustered two-sided 97.5% interval is wholly above 50%.
  This Bonferroni adjustment reserves a family of two candidates. Null or negative screens do not ship.
- Confirmation: 2,016 fresh offer boards / 8,064 games, seed 2026102402, for qualifying candidates only.
  No retuning on these results. Require a two-sided 97.5% clustered lower bound above 50%, a draw-aware
  point score at least 51%, no map below 49% point score, and zero rejected actions on either seat.

Publish all completed arm results, including negative differences. Keep outcomes independent of source
changes by running a frozen research source copy. The shared main checkout is not the study's runtime.
An incomplete or changed-source run is invalid, not a favorable partial result.

After a passing confirmation, run normal common/client/server checks and a production-budget latency panel
before any default change. Verify both seats and no increased deadline-fallback rate beyond 1 percentage
point on that fixed panel. Remote CPU simulation capacity is limited to 24 workers at nice 10; local uses 12.
Do not change services or interrupt other work to obtain resources. No deployment is authorized by a partial
screen, tactical correctness test, or this registration alone.

Artifact and draft re-fits are separate future experiments; they cannot borrow these confirmation seeds.
Generated records and reports remain outside Git.
