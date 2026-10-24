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

## D: legal Hydra draft preference — pending

See `DRAFT_HYDRA_PROTOCOL.md`. This is a separately identified hypothesis with new seeds, a stricter
98.75% clustered interval, an exact sign-flip gate and fresh confirmation. It does not inherit any claim
of strength from the shield tests or the draft census.

## Reproducibility and exclusions

Generated frozen sources, server-profile captures, runner scripts, manifests and per-game records are
kept outside Git under the client research-output directories `game/core/tmp/a19-combat-20261024`,
`game/core/tmp/a19-combat-M-20261024` and `game/core/tmp/a19-draft-hydra-20261024`. The runners verify the
frozen source digest before and after each stage and refuse to overwrite a stage directory.

The S 12-game smoke run matched all trajectory hashes, setups and outcomes across macOS arm64 and
Linux x64 using Bun 1.4.4. A slower remote S A/A was stopped and retained as incomplete; it contributes
no strength evidence. An M smoke attempt with invalid dependency resolution was also retained and
excluded; the corrected smoke completed. No partial run or failed setup is pooled into a qualifying
sample. The exact cluster sign-flip analysis for S/M was registered before their screen outcomes.
