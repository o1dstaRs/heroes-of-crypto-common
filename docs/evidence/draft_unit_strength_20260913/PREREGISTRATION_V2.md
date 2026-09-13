# Draft unit + synergy + map prior (v2) — preregistration

Written 2026-09-13 ~14:00, while the v1 weight selection was still running and before any v2 fit or v2 game.

## Why a v2

Exploratory analyses on the v1 TRAINING panel only (seed 97100001; no evaluation seed touched) showed:

- Synergy tiers carry value beyond individual units: each faction at tier >= 1 (2 distinct creatures) +5.2pp
  [3.2, 7.1]; each faction at tier >= 2 (4 distinct) a further +8.2pp [4.9, 12.2]. The live incumbent reaches
  tier 2 in 18 of 1000 drafts, because the server's faction-diversity tax charges the 3rd and 4th same-faction
  creature.
- Several units' effects depend strongly on the map (Abomination NORMAL -22.8pp vs LAVA -5.3pp; Dryad NORMAL
  +4.6pp vs BLOCK +30.0pp; Zena NORMAL +8.0pp vs BLOCK +25.1pp; Tsar Cannon NORMAL +20.2pp vs BLOCK +8.3pp). The
  live pick phase reveals the map immediately before the level-3 picks (server pick_phase_daemon), so L3/L4
  picks may use it fairly.
- Abomination is a liability even with >= 2 backline beneficiaries (-11.5pp), so the role gate does not explain
  it; flagged separately as a fight-AI / balance question.

These estimates motivated the design. The confirmatory test uses only fresh seeds.

## Candidate family `ranked-unit-synergy-a19-side-v2-w{1,2,4}`

Draft score contribution = w x (unit term + synergy term) / 100, through the same overlay channel as v1.

- Unit term: conservative lift. Level 1-2 creatures: map-independent. Level 3-4 creatures: the lift for the
  revealed map (the map is not used for bundle, L1 or L2 decisions).
- Synergy term for adding creature c of faction f to an army holding n distinct f creatures, with r creature
  picks remaining after this one: tier-1 value when n = 1; tier-2 value when n = 3; option value
  (1 - 0.5^r) x tier-1 when n = 0 and (1 - 0.5^r) x tier-2 when n = 2; nothing else. Tier values are the fit's
  conservative values. Bundles add both creatures' unit terms and the pair's synergy term (r = 4).
- Faction-diversity tax starts at the 5th same-faction creature instead of the 3rd.

## Fit (training panel 97100001, fitting only)

Ridge logistic, lambda 4, unpenalized battle-side, drafting-seat, tier-1 count difference and tier-2 count
difference; penalized creature presence differences with separate per-map columns for L3/L4 creatures. Offer
board bootstrap (200). Conservative = point shrunk toward 0 by one bootstrap SE.

## Incumbent for v2

If v1 passes all six gates: the selected v1 policy. If v1 fails: `ranked-live-incumbent`.

## Seeds (one use each)

| Stage | Seed | Size |
|---|---|---|
| Weight selection | 97500001 | 500 boards (2000 games) per weight vs the v2 incumbent |
| Confirmation (selected weight, once) | 97600001 | 2000 boards (8000 games) vs the v2 incumbent |
| Robustness | 97700001 | 500 boards per reference; candidate and v2 incumbent each |

Selection rule and the six gates are identical to PREREGISTRATION.md, with "incumbent" meaning the v2 incumbent.
Gate 6 additionally reports the tier-2 reach rate, informational only.
