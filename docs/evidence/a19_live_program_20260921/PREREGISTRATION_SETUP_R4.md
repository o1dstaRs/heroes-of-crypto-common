# Preregistration — ranked setup policy re-gate on the r4 armies (P6)

Written 2026-09-23 before any deciding game. Base: common 6f67b22 (= c3bdc78, r4 shipped, + docs).

## Why
Every ranked setup policy was chosen when the bot drafted ~1 shooter; r4 armies hold 2.88. The live spec
(`v07-nonfight-4eda84635fe7`, server DEFAULT_RANKED_SETUP_POLICY_SPEC) is composition-aware but was never measured on
armies like these. Live replays: humans took Sniper 3 in 14/26 fights and Placement 1-2 in 13/26; the bot never took
Placement. The server keeps `ranked-replay-tactics-v1` (distilled from four human ranked games) as an explicit
experiment "until its ranked validation gate passes". This is that gate, on the current armies.

## What the arms change (draft-only census, 1000 r4 boards, context-free setup path)
- incumbent v07-nonfight: Armor 2 / Might 2 / Sniper 3 on 80% of r4 armies, Armor 3 / Might 1 / Sniper 3 on 20%.
- A `ranked-replay-tactics-v1`: Armor 2 / Placement 2 / Sniper 3 on 99%; synergies and tier-2 artifact identical to the
  incumbent. A clean single-lever test: two points of Might become two points of Placement (a deeper deployment zone).
- B `conditional-v1`: Armor 3 / Might 1 / Sniper 3 on 99%, setup-v0 synergy table (differs on 54% of armies), tier-2
  from the composition table (differs on 4%). Prior evidence (2026-07-15, v0.7, square board): Armor must stay the
  second pick — Sniper3/Armor3/Might1 beat Sniper3/Might3/Armor1 78-22.
- Dropped as no-ops or known-worse: `ranked-a19-caster-empower-v1` (differs on 1%), `setup-v0` (composition-blind).
- Excluded as unmeasurable in this harness: the two public-roster specs, because `ranked_draft_eval` calls
  pickAugments without the opponent/map context and never arms the server's public-roster placement.

## Design
`ranked_draft_eval.ts`, both drafts `ranked-unit-strength-a19-side-v1-w4-r4` (mirror), `--candidate-setup <arm>
--opponent-setup v07-nonfight-4eda84635fe7`, live draft rules, side board, deterministic a19 both seats. Offer boards
are played in both pick seats and both battle mirrors, so seat and side luck cancel.
- Selection: A 2000 games seed 99610001; B 2000 games seed 99620001. Best draw-aware continues only if > 0.505.
- Confirmation: best arm, 8000 games, seed 99630001.
- Robustness: best arm and the incumbent setup, each on r4 drafts vs pool `reference` (opponent setup = incumbent),
  2000 games each, seed 99640001.
Gates (the draft protocol's, same verdict.py): draw-aware > 0.50, clustered LCB > 0.50, 0 rejections, worst map >= 0.49,
each robustness cell >= incumbent - 2pp; the diversity gates pass trivially because both drafts are identical.
PASS -> propose flipping DEFAULT_RANKED_SETUP_POLICY_SPEC (server) — a one-constant change with HOC_SETUP_POLICY
rollback. Seeds are never re-rolled.

## RESULT — selection A `ranked-replay-tactics-v1` vs the live setup (seed 99610001, 2000 games, both drafts r4):
decisive 45.53% [41.21, 49.91], draw-aware 45.57%, LCB 41.21, 0 rejections; maps NORMAL 45.9 / LAVA 44.3 / BLOCK 46.4.
Trading two points of Might for Placement 2 costs r4 armies ~4.5pp on every map. The human pattern (Placement on
13/26 live armies) does not transfer to a19: its placement does not exploit a deeper zone, while the lost damage is felt
every turn. Arm A is out; the server's "explicit experiment" status for replay tactics can end here as a measured loss.

## RESULT — selection B `conditional-v1` vs the live setup (seed 99620001, 2000 games, both drafts r4): decisive
55.59% [51.21, 59.89], draw-aware 55.53%, LCB 51.21, 0 rejections; maps NORMAL 55.8 / LAVA 54.8 / BLOCK 56.2, every
map above 54. Selected (A lost). Confirmation 99630001 (8000 games) and both robustness cells 99640001 started
2026-09-23 06:12:45Z. Consistent with the 2026-07-15 evidence that Armor must be the second pick after Sniper 3.

## RESULT — confirmation `conditional-v1` vs the live setup (seed 99630001, 8000 games, both drafts r4): decisive
55.58% [53.39, 57.74], draw-aware 55.53%, clustered LCB 53.39, 0 rejections; maps NORMAL 55.59 (LCB 51.79) / LAVA 57.03
(53.24) / BLOCK 54.12 (50.32). Gates 1-4 PASS (6a/6b trivially: the drafts are identical). Gate 5 pending.

## VERDICT (verdict.py over confirm_setup + robust_setup_candidate + robust_setup_incumbent): PASS on all 8 gates
Gate 5 (seed 99640001): vs untrained-heuristic 57.21% vs the live setup's 52.34% (+4.87pp); vs round-3 exploiter
85.20% vs 83.91% (+1.30pp); 0 rejections. Diversity identical (same drafts): 51 vs 51 distinct, top share 38.0%.

## How it ships — scoped to v0.8 seats (decided after reading the server path)
The server resolves setup per seat: persistent AI seats use `getRankedAiProfile(version).setupPolicy`, humans the
global RANKED_SETUP_POLICY. The vs-AI tiers are easy v0.4 / normal v0.6 / hard v0.7 / brutal v0.8, so flipping the
global default would also change the lower tiers' setups and — for v0.7 — switch off reveal placement (conditional-v1
leaves placementOverride undefined and v0.7 then reads the legacy env gate). Neither effect was measured. For v0.8 the
override is harmless: StrategyV0_8.placeArmy fills an unset setupPlacementPolicy with "public-roster", and
autoPlaceTeam always runs the strategy's placeArmy for AI-controlled seats, so the bot deploys exactly as in the
harness. The ship therefore gives ONLY the v0.8 profile conditional-v1 (V08_RANKED_SETUP_POLICY, its own override env
HOC_V08_SETUP_POLICY); the global default, the lower tiers and absent-human auto-setup are unchanged. The test server
sets HOC_SETUP_POLICY=v07-nonfight-4eda84635fe7 explicitly, which is why v0.8 must not defer to that variable.
