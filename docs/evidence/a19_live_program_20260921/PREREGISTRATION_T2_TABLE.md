# Preregistration — a Tier-2 artifact table measured for the v0.8 bot (P9)

Written 2026-09-23 ~11:30Z, before any P9 game. Base: common e00e27a plus the harness option `--candidate-t2 <id>`
(ranked_draft_eval.ts: the candidate's Tier-2 artifact is replaced after the draft; with it, each recorded candidate
army also carries the three offered artifacts and the setup policy's own pick).

## Why
- The v0.8 bot picks its Tier-2 artifact with conditional-v1's rule "t2": the argmax of
  TIER2_ARTIFACT_WINRATE_RANGED when the army holds >= 2 ranged stacks, else TIER2_ARTIFACT_WINRATE_MELEE. Both tables
  were measured 2026-07-15 with v0.7 on both seats, on the classic board, with LiveTwin rosters.
- Three of the 12 live Tier-2 artifacts changed since. Tome of Amplification was reworked 2026-07-19 (6ef7f09): its
  74.7 / 71.3 rows came from amplifying the always-on Armor/Might augments, and it now amplifies only non-healing buffs
  that allied units cast; the source says the rows "must be remeasured before they are treated as current evidence".
  Archmage's Ring joined the pool 2026-07-29 (3f4eb4c) with no row, so the bot never takes it. Berserker's Bond
  became +3 attack / −1 defense on 2026-09-13 (d3a180b).
- On r4 drafts 99.5% of the bot's armies fall in the ranged cohort (P6 confirmation, 4,000 drafts), so the ranged
  table is the one that matters. There the bot took Farsight Quiver 24.8%, Tome 19.5%, Titan Plate 16.2%, Clover
  13.7%, Warlord's Edge 9.9%, Rime Charm 6.3%, Giant's Maul 4.6%, Lava Striders 3.1%, Crown 1.2%, Pendant 0.6%,
  Berserker's Bond 0.0%, Archmage's Ring 0.0%.

## Stage 1 — measurement (not a gate)
Twelve arms, one per live Tier-2 artifact X (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13): `--candidate-t2 X`, both seats
draft `ranked-unit-strength-a19-side-v1-w4-r4` and set up with `conditional-v1`, both doctrines see-none, live draft
rules, side board, deterministic a19. 2000 games per arm, ALL arms on seed 99970001, so every arm plays the same
boards, drafts, opponents and battle seeds and differs only in the candidate's artifact: the arms are paired.

## Stage 2 — derivation (mechanical)
- Ranged table: for each X, the draw-aware score of arm X over the games whose candidate army is in the ranged cohort
  (`ownComposition(...).ranged >= T2_RANGED_TABLE_MIN_RANGED`, the runtime's own test). The melee table is left as it
  is: r4 drafts almost never reach it, so it cannot be measured here.
- New rule "t2a19": in the ranged cohort, the offered artifact with the highest measured score; otherwise the old rule.
- Predicted effect, cross-fitted: fit the table on even offer boards and score the odd ones, then the reverse. On a
  scored game the new rule's pick and the policy's recorded pick each have an arm whose game is identical except for
  that artifact, so the effect is the mean paired difference between those two arms' results (draw-aware).

## Stage 3 — confirmation (gated)
Runs only if the cross-fitted predicted effect is >= +1.0pp; below that P9 stops as "no confirmable gain". 8000 games
if the prediction is >= +2.5pp, else 16000. New rule vs `conditional-v1` on r4 drafts, seed 99980001. Robustness:
both setups vs pool `reference`, 2000 games per opponent, seed 99990001.
Gates (verdict.py, unchanged): draw-aware > 0.50, clustered 95% LCB > 0.50, 0 candidate rejections, worst map >= 0.49,
each robustness cell >= incumbent − 2pp; the diversity gates pass trivially because the drafts are identical.

PASS -> the v0.8 setup spec becomes `conditional-v1:sniper+t2a19`, with `HOC_V08_SETUP_POLICY=conditional-v1` as the
rollback; bare `conditional-v1` keeps meaning sniper + t2. Seeds are never re-rolled.

Prediction, written down so it can be wrong: Tome measures near the bottom of the table on these armies, and the
predicted effect lands between +1 and +3pp.
