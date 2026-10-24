# F1: Mage lethal Fireball priority — 2026-10-24

The primary question is whether preserving an immediately lethal Fireball instead of replacing it with
Smoke improves full-match performance. More casts or damage alone do not qualify the policy.

Freeze common source, the one-line research toggle, server A19 defaults, setup defaults, runtime,
dependencies and runner hashes before outcomes. The toggle enables the exact proposed rule only for
one physical team, including that team's root decisions and all rollout decisions. Missing toggle is
the pre-change behavior. No placement, candidate catalog, damage, spell gate or search budget changes.

Use the canonical buildRoster (expBudget), resolveSetupPolicy, runMatch and PersistentWorkerPool.
Force one Wandering Mage into each army; the other five slots vary. This is a conditional Mage combat
population, not a ranked draft-strength estimate. Use three equally weighted compositions (at most one
shooter, unrestricted mixed, three to four shooters) crossed with Normal, Lava and Block. Both armies
are independently generated. Sample current live artifacts uniformly; retain the same setup and artifacts
within each comparison. Use full deterministic A19 H64/R4 search and current server material/tie settings.

Each independent roster pair is played twice, with identical armies, physical placements, artifacts and
combat seed. Candidate plays Green once and Red once. Analyze the average draw-aware candidate score
over the two games as one independent cluster. Wins score 1, draws 0.5 and losses 0.

Fixed stages, with no optional stopping or pooling of incomplete runs:

- Smoke: 9 roster pairs / 18 games, seed 1024202699; validate mechanics and remote portability only.
- A/A: 36 roster pairs / 72 games, seed 1024202600; rule disabled for both. Require exactly 50% score,
  identical within-pair action hashes and zero rejections.
- Screen: 630 fresh roster pairs / 1,260 games, seed 1024202601; 70 pairs in each composition/map cell.
  Require the two-sided 95% stratified cluster-bootstrap interval wholly above 50%, exact two-sided
  cluster sign-flip p <= 0.05 and zero rejections. A null or negative screen does not qualify.
- Confirmation, only if the screen passes: 3,150 new roster pairs / 6,300 games, seed 1024202602;
  350 pairs per cell. Require the same statistical gates, at least 51% mean score, no map below 49%,
  and zero rejections. Report confirmation independently of the screen.

Retain per-pair results, rosters, artifacts, outcomes, Mage casts and action hashes. Report both decisive
win rate and draw-aware score, confidence intervals, distinct roster counts and map/composition results.
Preserve failures and source changes as excluded runs. A failing screen leaves the candidate unqualified;
do not silently change the population or extend the sample until a favorable result appears.

Before enabling a qualified change, also pass client/common/server correctness checks and a bounded
sandbox timing check. No production deployment is part of this study.

Source: common `ab162d2768ee73ee3b7829e3e4a4592104d71073`, with the frozen research-only team toggle.
Frozen source SHA-256: `c38bebf008f69e86f9e4901ecb5a1aa3c606279c0e60e2933725775902943e40`.
The shipped Mage-priority gate remains off pending qualification. Generated data and frozen sources are
kept outside Git under `game/core/tmp/mage-fireball-study-20261024` and the matching research-host folder.
