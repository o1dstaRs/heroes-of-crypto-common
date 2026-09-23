# Preregistration — the v0.8 bot's scouting doctrine (P8)

Written 2026-09-23 ~10:40Z, before any deciding game. Base: common 59a1de0 plus the harness option
`--candidate-doctrine` / `--opponent-doctrine` (ranked_draft_eval.ts; default `see-none` keeps every earlier panel
byte-identical).

## Why
- The live bot has picked its doctrine with `pickRankedAIDoctrine` since common 96f57fc (2026-08-11, "Vary ranked AI
  scouting doctrines"): a stable hash of (match id, team, AI version) chooses uniformly among THREE_REVEALS (6 upgrade
  points), SEE_ALL (5) and SEE_NONE (7). The commit gives no strength rationale and no owner decision is recorded.
- Every measurement in this program (P3–P7), and every ranked_draft_eval panel before it, gave both seats
  `SETUP_POLICY_V0.pickDoctrine()` = SEE_NONE. The draft, the setup and the a19 fight were tuned and gated at 7 points;
  two thirds of live bot games since 2026-08-11 are played at 5 or 6.
- Live test-server replays (decisive human-vs-AI): the bot took SEE_NONE in all 20 fights before 2026-08-11; after it,
  NONE / ALL / THREE / NONE / NONE / THREE. Humans took SEE_NONE in 21 of 26; in human-vs-human, SEE_NONE 57, SEE_ALL 48,
  THREE_REVEALS 5.
- What sight buys the bot is small: a collision is a free re-pick (pick_sim reveals the colliding slot and the team
  picks again, no pick is lost); setup (`pickAugments(budget, creatures)`) never reads the reveals; placement sees the
  whole enemy army whatever the doctrine. Only the draft's opponent-aware overlays (role fit, backline protector) use
  the known opponent creatures.

## Candidate (chosen a priori, no selection stage)
The v0.8 bot always takes SEE_NONE. Incumbent: `ranked-variety` (the live per-match hash, with the board's pick seed
standing in for the match id).

## Design
`ranked_draft_eval.ts`, both seats draft `ranked-unit-strength-a19-side-v1-w4-r4` (the server default) and set up with
`conditional-v1` (the v0.8 setup since server 13bca49), live draft rules, side board, deterministic a19 on both seats.
Every offer board is played in both pick seats and both battle mirrors.
- Confirmation: `--candidate-doctrine see-none --opponent-doctrine ranked-variety`, 8000 games, seed 99910001.
- Robustness: candidate (see-none) and incumbent (ranked-variety) each vs pool `reference` (opponents take see-none
  and conditional-v1), 2000 games per opponent, same seed 99920001 for both cells.
- Informational, not gating: see-none vs see-all (seed 99940001) and see-none vs three-reveals (seed 99950001), 2000
  games each. Together with the mirror they decompose the confirmation, and they say whether a fixed doctrine other
  than SEE_NONE is worth a later proposal.
- Conditional replication: if P7 (v4-w8-r4) ships before P8 is decided, the confirmation's arms are replayed with both
  seats drafting v4-w8-r4, 2000 games, seed 99960001. Expectation: draw-aware > 0.50. If it comes in below, P8 is not
  shipped until the difference is explained.

Gates (verdict.py, unchanged): draw-aware head-to-head > 0.50; clustered 95% LCB > 0.50; 0 candidate rejections;
worst map >= 0.49; each robustness cell >= incumbent − 2pp; distinct creatures >= 80% of the incumbent's; top creature
share <= incumbent + 10pp.

PASS -> the v0.8 AI profile (ranked bot and vs-AI brutal) takes SEE_NONE, with a server env override for rollback;
the easy/normal/hard tiers (v0.4/v0.6/v0.7) keep the variety, which is the only place its flavour costs nothing that
was measured. FAIL -> record it; the variety stays. Seeds are never re-rolled.

Prediction, written down so it can be wrong: 53–57% draw-aware, i.e. about +4pp per upgrade point against the two
non-mirror thirds, with SEE_ALL the weakest doctrine for this bot.
