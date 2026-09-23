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
