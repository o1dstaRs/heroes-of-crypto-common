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
