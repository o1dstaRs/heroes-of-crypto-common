# Preregistration — synergy options for the v0.8 bot (P10)

Written 2026-09-23 ~11:20Z, before any P10 game. Base: common cee6399 plus the harness option
`--candidate-synergy FACTION:OPTION[,…]` (ranked_draft_eval.ts: the candidate's synergy option is replaced wherever its
army qualifies for that faction; the level still follows the unit count; with it, each recorded candidate army
carries the synergies it fought with and the ones its setup policy took).

## Why
- conditional-v1 delegates synergies to setup-v0's BEST_SYNERGY_BY_FACTION, measured head-to-head in v0.5 self-play
  (15k games per faction) and re-confirmed 2026-07-15 with v0.7: Life supply %, Chaos movement, Might stack-ability
  power, Nature fly armor.
- The factions' synergies were rebalanced since: Chaos break-on-attack chances lowered (2026-07-31); Nature board-unit
  slots +2/+3/+4 and fly armor 15/30/50% (2026-08-09), fly armor eased to 15/24/35% (2026-08-29). No measurement has
  looked at the choice with a19, on the side board, or on armies holding ~2.9 shooters.
- Incidence on r4 armies (P6 confirmation, 4,000 drafts, >= 2 creatures of the faction): Might 57.2%, Nature 56.4%,
  Life 45.2%, Chaos 44.2%. Every faction's choice touches close to half of the bot's games.

## Stage 1 — measurement (not a gate)
Four arms, each flipping ONE faction's option for the candidate: `LIFE:2` (morale and luck), `CHAOS:2` (break on
attack), `MIGHT:1` (aura range), `NATURE:1` (board units). Both seats draft `ranked-unit-strength-a19-side-v1-w4-r4`
and set up with `conditional-v1`, both doctrines see-none, live draft rules, side board, deterministic a19. 2000
games per arm, all four arms on seed 99870001 (paired: the same boards, drafts, opponents and battle seeds).

## Stage 2 — derivation (mechanical)
For each faction, the arm's draw-aware score over the games whose candidate army qualifies for that faction's synergy
(the recorded synergies differ from the policy's). Flip the faction's option only if that score is above 0.50 and its
95% interval (clustered by offer board) excludes 0.50. No flip qualifies -> P10 stops as "the table holds".

## Stage 3 — confirmation (gated)
The flipped options as one synergy table vs `conditional-v1`, both seats on r4 drafts, 8000 games, seed 99880001;
robustness vs pool `reference`, 2000 games per opponent, seed 99890001. Gates (verdict.py, unchanged): draw-aware
> 0.50, clustered 95% LCB > 0.50, 0 candidate rejections, worst map >= 0.49, each robustness cell >= incumbent − 2pp;
the diversity gates pass trivially because the drafts are identical.
PASS -> the v0.8 setup spec gains the new synergy rule (named, never part of "all"), with the previous spec as the
rollback. Seeds are never re-rolled.

Prediction, written down so it can be wrong: Nature's board units now beat fly armor on these armies; the other three
factions hold.

## Amendment 2026-09-23 13:15Z, before any P10 game
P7 shipped v4-w8-r4 as the ranked draft default (common 993078e, server 304b333) after this was written, and it
changes which factions qualify: on v4 armies Nature's synergy applies to 54.2%, Life's 49.9%, Chaos's 49.0% and
Might's 38.9% (r4: 56.4 / 45.2 / 44.2 / 57.2). Every P10 cell now drafts `ranked-unit-strength-a19-side-v4-w8-r4` on
both seats: the four stage-1 arms, the stage-3 confirmation and both robustness cells. Everything else is unchanged,
seeds included.

## RESULT — stage 1 (4 arms × 2000 games, seed 99870001, v4-w8-r4 drafts) and stage 2 (p10_synergy_table.ts)
Over the games where each flip changed the candidate's synergies (95% interval clustered by offer board):
LIFE:2 morale and luck 49.01% [45.97, 52.04] (1,058 games) → keep; CHAOS:2 break on attack 53.60% [50.26, 56.93]
(904) → FLIP; MIGHT:1 aura range 40.26% [36.70, 43.82] (806) → keep; NATURE:1 board units 51.48% [48.41, 54.54]
(1,048) → keep. The prediction above was wrong about Nature. Stage-3 candidate: Chaos takes break on attack, every
other faction keeps its option.

## Amendment 2026-09-23 20:50Z, before any stage-3 game
The flip applies to 45% of armies at about +3.6pp, which predicts about +1.6pp overall — an effect 8,000 games cannot
separate from even (clustered SE ~1.1pp). The confirmation therefore uses P9's preregistered sizing rule on this
stage-1 prediction (1.0 <= prediction < 2.5pp → 16,000 games), decided from stage-1 data only. With 16,000 games the
confirmation's seeds (99880001, 12,000 preimages) would reach into the robustness seed, so robustness moves to the
fresh 99895001. Gates and everything else unchanged.

## RESULT — stage 3 confirmation (seed 99880001, 16,000 games) and robustness (seed 99895001)
conditional-v1:sniper+t2+syn-a19 vs conditional-v1, both seats v4-w8-r4 + SEE_NONE: 7632W 8116L 252D; decisive 48.46%
[46.92, 50.01], draw-aware 48.49%, clustered LCB 46.92, 0 rejections; maps NORMAL 48.03 / LAVA 48.60 / BLOCK 48.76.
Robustness: 60.74% against the untrained ranged stack and 89.53% against the round-3 exploiter (conditional-v1:
62.82% and 89.42%).

## VERDICT (verdict.py): FAIL — gates 1, 2, 4 and 5 (untrained heuristic, −2.08pp) fail
The Chaos flip is not better; if anything it is worse (about −3.4pp in the games where it applies). Stage 1 tested
four flips at a nominal 95% each, so about one time in five one of them clears by luck; Chaos cleared by 0.26pp and
the confirmation reversed it. The synergy table holds for all four factions: this lever is closed on these armies.
The syn-a19 rule was never pushed. For the stack check, variant (a) — without P10 — is the one that counts.
