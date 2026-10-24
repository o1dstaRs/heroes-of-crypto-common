# A19 research results — 2026-10-24

No candidate in this study is qualified for a default change. Correctness tests and positive tactical
examples are not evidence of an overall win-rate gain. See the registered protocols beside this file.

## S: layered ranged shields — do not promote

Frozen common source SHA-256:
`112efee8a74ca355e47c97340049259892d69da1ad9ebc3b99b54ff25c376183`.
Both seats used the captured current server A19 defaults, including material arbitration in ties and
certified tight selection bounds. Only the candidate seat enabled the research shield estimator.

- A/A: 24 offer boards / 96 games, seed 2026102400; exactly 50% score, zero rejected actions.
- Screen: 300 offer boards / 1,200 games, seed 2026102401; 591 wins, 591 losses, 18 draws.
- Draw-aware and decisive-only scores: both 50.00%. Normal, Lava and Block each scored 50.00% over
  100 independent boards. Zero rejected actions on either seat.
- Every four-game cluster scored 50%; the registered clustered bootstrap interval consequently collapsed
  to [50%, 50%]. This describes the sampled pairs, not certainty about unsampled populations.
- Exact two-sided cluster sign-flip p = 1. No cluster changed a mirrored trajectory hash.

S fails the promotion screen. Do not spend confirmation games on it or enable its production flag.
Its real-engine shield correctness tests pass, but this population provides no measured strength gain.

## M: Fire Breath whole-impact ranking — withdrawn before its screen

Frozen common source SHA-256:
`34f5109e7a71c8d310cc8341b6f91031b10424643285497c1c4c2494f2bed2b9`.
M passed its focused correctness tests, a 12-game smoke check and a 96-game A/A at 50% with zero rejected
actions. These checks do not measure strength.

The completed S screen's normal drafts selected zero Hydras and zero Black Dragons. Replaying its draft
seeds found Hydra banned in 135/300 boards and Black Dragon banned in 129/300; each was legal in more
than half of the boards but never chosen. M's prespecified deciding population therefore had no native
Black Dragon to exercise its intended change. M was withdrawn before its deciding screen, rather than
replacing the population after observing a favorable result. Its production flag remains disabled.

## D: legal Hydra draft preference — do not promote

See `DRAFT_HYDRA_PROTOCOL.md`. This is a separately identified hypothesis with new seeds, a stricter
98.75% clustered interval, an exact sign-flip gate and fresh confirmation. It does not inherit any claim
of strength from the shield tests or the draft census.

Frozen source SHA-256:
`07a2affc72b54215b4b909f02e982f5745b2222c73306bd0487b2e8baa32bc60`.
The 12-game smoke exercised Hydra on the candidate seat only. Its A/A completed 24 boards / 96 games,
seed 2026102410, at exactly 50% with zero rejected actions.

The fixed screen completed 300 fresh offer boards / 1,200 games, seed 2026102411:

- 532 wins, 659 losses, 9 draws; draw-aware score **44.7083%**, decisive-only win rate **44.6683%**.
- Delta from the 50% paired null: **-5.2917 percentage points**.
- Registered 98.75% whole-cluster bootstrap interval: **[41.8750%, 47.5417%]**.
- Exact two-sided cluster sign-flip p = **0.00000452235**, in the unfavorable direction.
- Normal: 50.00%; Lava: 46.00%; Block: 38.125%; each map has 100 independent boards / 400 games.
- Zero rejected actions. Hydra appeared in 700 candidate games and zero opponent games. Unlike S,
  D changed trajectories on 175/300 clusters; 103 clusters had a nonzero score difference from 50%.

D fails its screen and is inferior in this sampled population. Do not launch confirmation or enable a
Hydra preference. The result concerns the complete legal-preference policy against the frozen A19
control; it is not an isolated creature-balance estimate. Do not turn the neutral Normal-map subgroup
into a qualified conditional policy. Any new rule needs its own registration and fresh data.

Raw `boards.jsonl` SHA-256:
`f05949c495d1261175032f8f31b493348c73c7b18d5a4538480547594ead75ba`.

## Reproducibility and exclusions

Generated frozen sources, server-profile captures, runner scripts, manifests and per-game records are
kept outside Git under the client research-output directories `game/core/tmp/a19-combat-20261024`,
`game/core/tmp/a19-combat-M-20261024` and `game/core/tmp/a19-draft-hydra-20261024`. The runners verify the
frozen source digest before and after each stage and refuse to overwrite a stage directory.

The S 12-game smoke run matched all trajectory hashes, setups and outcomes across macOS arm64 and
Linux x64 using Bun 1.4.4. All 96 M remote A/A trajectory hashes also matched the corresponding
local S A/A hashes, verifying disabled-candidate parity across both source snapshots. A slower remote
S A/A was stopped and retained as incomplete; it contributes no strength evidence. An M smoke attempt with invalid dependency resolution was also retained and
excluded; the corrected smoke completed. No partial run or failed setup is pooled into a qualifying
sample. The exact cluster sign-flip analysis for S/M was registered before their screen outcomes.


## Validation and limits

The common build passed 7,111 tests, formatting and TypeScript before later concurrent mainline edits.
All 20 focused tests for S, M, the research baseline seam and legal/seat-scoped D preferences also passed
on the shared checkout after the screen. Both combat flags remain sealed to zero; D exists only as an
explicit simulation override. No experiment in this report is enabled or deployed.

The broader client check passed lint and type checks. Its first core run had one Unicorn timing failure;
that test passed in isolation and the full repeated core stage passed 5,235 tests. The repeated workspace
gate then encountered concurrent Mage export/profile edits in common, so it did not finish green. Those
failures must not be represented as a passing full gate or repaired by discarding peer edits. Research
outcomes use the independently hashed frozen snapshot, not that changing checkout. If a future candidate
qualifies, validate against the then-current engine and complete all required gates before promotion.
