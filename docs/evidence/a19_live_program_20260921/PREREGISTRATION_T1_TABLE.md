# Preregistration — the Tier-1 artifact table on the new 3-archer armies (P12)

Written 2026-09-23 ~17:20Z before any deciding game. Base: common 1213b17 (ranked default v4-w8-r4, conditional-v1
setup for v0.8 seats, SEE-NONE doctrine) plus the Tier-1 override instrument below. A parallel agent's P9 covers
Tier-TWO; Tier-ONE is untouched by any program.

## Why
`TIER1_ARTIFACT_WINRATE` was measured in 2026-07, when ranked armies held ~0.2 natively ranged creatures. Three facts
make it suspect now that the shipped draft fields 2.88:
1. **Hunter's Longbow (id 10) grants ranged units +1 flat attack PER ARCHER in the army** — its value scales with the
   exact quantity the draft just tripled — and it is rated **45.0**, below the table's midpoint.
2. **Mage's Ring (id 13) is absent from the table entirely** and falls back to 50, yet it is picked on 9.1% of boards.
3. Eleven of twelve rated artifacts sit in a narrow 42.8-51.5 band; only Cursed Ward (id 9) is an outlier at 79.8.
Measured on the current default drafts (800 boards): the Tier-1 pick distribution is nearly FLAT (5.8-10.6% per
artifact), the creature-score spread between offered bundles averages 92.0 against an artifact spread of 6.7, and
the artifact term changes the bundle pick on only **2% of boards**. So Tier-1 is effectively inert in the draft: if
one artifact is genuinely strong in this regime, the bot is leaving it on the table.

## Instrument (common, research-only)
`candidateTier1Override` / `--candidate-t1 <id>` in `ranked_draft_eval`, mirroring the peer's `candidateTier2Override`:
it replaces the candidate seat's drafted Tier-1 artifact AFTER the draft, so creature picks, setup and opponent are
untouched and the arm isolates the artifact. Smoke-verified: forcing id 10 moved the recorded artifact 5 -> 10 and
changed the behaviour digest. Nothing in production sets it.

## Design — stage 1 (value), 2000 games per arm, seed 99830001, both seats drafting v4-w8-r4 with conditional-v1
Each arm forces ONE artifact on the candidate; the opponent keeps the policy's own pick. An arm above 50% means
"always taking this artifact beats the live policy's Tier-1 choice".
- control: no override (must read ~50%, harness integrity)
- arm 10 Hunter's Longbow (the composition hypothesis)
- arm 9 Cursed Ward (is the 79.8 rating real in this regime?)
- arm 13 Mage's Ring (unrated)
- arm 6 Winged Boots (low-band reference, 44.5)
Promotion bar: draw-aware >= 52% and the control within 48-52%.

## Design — stage 2 (capture), decided now
A winning arm is NOT shippable as a forced pick: the draft can only take what a bundle offers, and the artifact term
currently flips 2% of bundles. Capture = raise that artifact's entry in `TIER1_ARTIFACT_WINRATE` to its measured
value so `pickCoherentDraftBundle` prefers bundles carrying it, then measure the POOLED effect with no override:
8000 games, seed 99840001, gates as the draft protocol (draw-aware > 50, clustered LCB > 50, worst map >= 0.49,
0 rejections, diversity guards) plus a robustness cell vs pool `reference` (seed 99850001). Pooled impact is bounded
by how often the artifact is offered, so stage 2 is reported in pp even if stage 1 is large. Seeds never re-rolled.

## STAGE 1 RESULTS (seed 99830001, 2000 games per arm, both seats drafting v4-w8-r4 with conditional-v1)
- `control_no_override`: **50.00%** decisive (992W 992L 16D), draw-aware 50.00%, 0 rejections. The two seats are
  identical by construction, so this exactness is the harness proving it adds no bias; any arm's deviation is
  attributable to the forced artifact alone. Integrity gate PASS.
- `arm10_hunters_longbow` (id 10, rated 45.0, +1 flat attack per archer): **53.47%** decisive
  [49.09, 57.80], draw-aware 53.42%, 1056W 919L 25D, 0 rejections; NORMAL 55.52 / LAVA 50.38 / BLOCK 54.49.
  Clears the 52% promotion bar. The interval still includes 50, so this is directional at 2000 games, not
  established — consistent with the composition hypothesis (its rating was fixed when armies held ~0.2 archers).
- `arm09_cursed_ward` (id 9, rated **79.8** — the table's top entry): **46.32%** decisive [42.00, 50.70],
  draw-aware 46.38%, 913W 1058L 29D, 0 rejections. Forcing the table's own favourite LOSES to the policy's mix.

### The table is mis-ranked, and inverted at its extremes
Against the same seed, opponent and boards, the artifact the table rates best (79.8) measures 46.32% while the one
it rates near the bottom (45.0) measures 53.47% — a 7.15pp gap in the OPPOSITE direction to the ranking. Each arm's
own interval touches 50 at 2000 games, so the individual claims are directional; the ORDERING between the two arms
is the robust part, and it is backwards.
This matters more than the flat pick distribution suggested. Cursed Ward is rated so far above the 42.8-51.5 band
that every other artifact occupies that the bundle pick takes it whenever it is offered, which is exactly why id 9
is the most-picked Tier-1 artifact (10.6% of boards). The table's single largest error is therefore the one the
draft acts on hardest, and correcting that entry is a capture with real incidence rather than a tie-break.
- `arm13_mages_ring` (id 13, ABSENT from the table, so scored 50 by fallback): **47.25%** [42.91, 51.63],
  draw-aware 47.30%. Its omission costs nothing — the fallback already treats it about as well as it deserves.
- `arm06_winged_boots` (id 6, rated 44.5, the low-band reference): **49.26%** [44.90, 53.63], draw-aware 49.28%.
  Taking a low-rated artifact always is roughly par with the policy's mix, so the low band is about right.

### STAGE 1 VERDICT (2026-09-24 17:06Z)
Only `arm10_hunters_longbow` clears the preregistered promotion bar (draw-aware >= 52%) with the control inside
48-52% (it read exactly 50.00%). The defect is specific, not general: the mid and low band are approximately
correct, the missing entry is harmless, and the table has exactly one large error — Cursed Ward at 79.8.

### STAGE 2 CAPTURE TABLE, fixed now before any stage-2 game
Two entries change in `TIER1_ARTIFACT_WINRATE`, each set to the value this program measured, and nothing else:
    Tier1Artifact.CURSED_WARD      79.8 -> 46.3   (measured 46.32%)
    Tier1Artifact.HUNTERS_LONGBOW  45.0 -> 53.5   (measured 53.47%)
Rationale for correcting BOTH rather than only the arm that passed: the promotion bar governs which artifact is
worth preferring, while these are the two values the arms actually measured, and Cursed Ward's inflated entry is
what currently makes the bot take a losing artifact whenever it is offered (it is the most-picked Tier-1 at 10.6%
of boards). Every other entry is left untouched, including the absent Mage's Ring.
Because the bundle pick reads a module-level table for both seats, the A/B needs a per-seat seam: a registered
policy id carrying the corrected table, armed on the candidate only. Stage 2 then runs 8000 games at seed 99840001
with a robustness cell at 99850001, under the same gates as the draft protocol. Expected pooled effect is about
+0.5 to +1pp — bounded by how often these two artifacts are offered — and it is reported in pooled terms whatever
the in-cohort arms showed.
