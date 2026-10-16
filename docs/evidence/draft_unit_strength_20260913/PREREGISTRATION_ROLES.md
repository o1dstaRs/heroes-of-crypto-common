# v0.8 unit role router releases (Blacksmith, Healer, Wandering Mage) — preregistration

Written 2026-09-13 ~17:40, before any release game for these units was played.

## Motivation (exploratory; training panel 97100001 and test-server replays only)

Fitted draft lifts (v1 prior, within level): Wandering Mage -12.8pp, Healer -10.8pp, Blacksmith -9.1pp. v0.8 routes
each of these units through a hand-written rule that replaces the search's incumbent decision:

- Blacksmith: `prioritizeV08BlacksmithCraft` makes Craft (one charge; per ally 40% double attack, 40% nothing,
  10% frozen weapon, 10% stun at luck 0) the decision whenever a 2x2 reaches two allies, and
  `v08BlacksmithCraftPlacement` packs up to four allies into a 2x2 at deployment. Training replays: Craft
  0.96/game, Weapon + Armor Rune 0.52/game, army win 45%. Test server (111 replays): AI Blacksmith cast Craft 13
  times and runes once; human Blacksmiths cast runes 23 times and Craft 10.
- Healer: `prioritizeV08HealerSustain` makes the best single Heal, Mass Heal, or Spiritual Armor the decision
  whenever one exists. Training replays: 80% of turns are spells, 203 HP healed/game, army win 37%.
- Wandering Mage: `prioritizeV08WanderingMageSmoke` makes any net-positive Smoke cloud the decision. Training
  replays: Smoke 0.33/game, melee 33% / move 32% / wait 19%, dies 88% at lap 3.9, army win 34%.

The Abomination protector release passed twice (+4.20pp, +5.35pp); the Queen/Angel release and the melee-flyer
target override failed. These three are separate hypotheses tested one at a time.

## Treatment

Research seam `V08_ROLE_RELEASE_<LEFT|RIGHT>` = comma list of `blacksmith_craft`, `healer_sustain`,
`wandering_mage_smoke`; a listed role's router returns the incoming decision unchanged for that seat
(`blacksmith_craft` also skips the Craft opening cluster). Default off. Each run treats exactly one role.

## Design (paired, identical for each run)

- Boards: ranked draft harness, deployed draft genome under live draft rules in both seats, live setup, side
  board, deterministic a19, live map rotation. Boards scanned in index order (up to 4000); the first 450 where
  exactly one army fields the target unit are used; that army is treated.
- Each board: both battle mirrors, each game played twice (baseline, treatment). Nothing else differs.
- Primary metric: the treated army's decisive win rate, treatment minus baseline, over the game pairs; 95% interval
  by resampling boards (2000 resamples).

| Run | Target unit    | Treatment list         | Primary seed | Confirmation seed |
| --- | -------------- | ---------------------- | ------------ | ----------------- |
| 1   | Blacksmith     | `blacksmith_craft`     | 98200001     | 98210001          |
| 2   | Healer         | `healer_sustain`       | 98300001     | 98310001          |
| 3   | Wandering Mage | `wandering_mage_smoke` | 98400001     | 98410001          |

Runs go in the order above; a run's outcome does not change the next run's design.

## Gates (per run)

1. PASS if the lower bound of the paired difference is > 0 and the treatment adds 0 engine rejections.
2. Per-map differences are exploratory.
3. On PASS, the same design on the run's confirmation seed must also have a positive point estimate before the
   release is proposed as a default. On FAIL, report it; no re-roll.
