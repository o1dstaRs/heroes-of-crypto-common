# test.heroesofcrypto.io replay analysis — 2026-09-21

Source: the 125 terminal match reports in the test server's journal (`FIGHT_FINISHED` rows of `JournalEntriesTest1`),
exported 2026-09-21 03:46Z and joined by row order to the per-action actorType / aiVersion rows. At export time the
test server ran common 0552017 (a19 before the deep search budget) with the ranked draft default v1-w4 (since
2026-09-14; earlier games used the older versatile draft).

Reproduce: `scripts/export_testserver.py` on the test host, then `python3 scripts/live_report.py <export-dir>`. Every
number below is that script's output on this export.

## Correction (2026-09-23)

The first pass, which the preregistrations' "Why" sections and the commit messages of common 832f8fc and server
6e00ef0 quote, counted split stacks as separate shooters and attributed one human-drafted army that the bot finished
playing to the AI. Counting distinct creatures, and treating a seat as the bot only when the bot both set it up and
fought it: **26** decisive human-vs-AI fights (not 27), the AI won **11 (42%, not 39%)**, it fielded no shooter in
**23 of 26** (not 22 of 27), and humans fielded at least one shooter in **16 of 26** and two or more in **11** (not
"2–5"). The behavioural contrast is unchanged. None of the ship decisions rest on these counts: they rest on the
paired simulation measurements in the preregistrations.

## Outcomes

| fights (decisive) | n | note |
|---|---|---|
| human vs AI | 26 | AI won 11 (42%): July 2/7, August 9/16, September 0/3 |
| human vs human | 55 | |
| AI vs AI | 12 | |

AI wins by map: NORMAL 4/11, LAVA 6/10, BLOCK 1/5. As LEFT 7/15, as RIGHT 4/11.

## Composition (distinct natively ranged creatures)

- The AI army had no shooter in 23 of 26 fights. On live draft rules the old draft fields none 84% of the time.
- Human armies: no shooter 10, one 5, two 6, three 5.
- AI wins when the human had more shooters 7/16, at equal counts 4/8, when the AI had more 0/2, against three
  shooters 1/5. At n = 26 this split is weak evidence on its own. The composition case was carried by paired
  simulation: in P1's cohort B the then-live v1-w4 army beat the untrained ranged stack only 30.8% over 900 pairs.
- Shooters per army, draft only on live rules (1,500 boards each): old live 0.17, v1-w4 1.01, r2 1.46, r3 2.12,
  v1-w12 2.58, r4 2.88, r5 3.14, r6 3.15, untrained heuristic 4.21.

## Behaviour (per unit turn: a unit's actions within a lap, closed by end/wait/defend/attack/cast)

| driver | turns | melee in place | move + melee | move only | wait | ranged | spell | skip | defend |
|---|---|---|---|---|---|---|---|---|---|
| AI (vs humans) | 782 | 16.4% | 27.9% | 27.4% | 17.9% | 1.9% | 4.5% | 2.7% | 0.5% |
| humans (vs AI) | 850 | 31.8% | 5.6% | 16.6% | 15.6% | 15.4% | 8.7% | 4.0% | 2.0% |
| humans (vs humans) | 3,088 | 35.3% | 3.8% | 17.1% | 15.6% | 12.3% | 9.1% | 2.6% | 2.6% |
| AI vs AI | 653 | 19.3% | 37.1% | 17.3% | 16.8% | 0.5% | 4.3% | 1.5% | 1.1% |

- Melee attacks that were charges (the unit moved that turn): AI 63% against humans and 66% against itself; humans
  15% against the AI and 10% against each other. Humans strike from where they stand and let the enemy walk in.
- Move-only turns that end within three cells of an enemy: AI melee 55%, human melee 44%. Human-vs-human melee stacks
  that end adjacent are struck before they act again 31 times out of 49, which is why humans avoid it.
- Army HP share at lap start, AI wins against AI losses: level through lap 2, then the losses fall behind (lap 3:
  53% vs 75% of the human army, against 59% vs 62% in wins).
- Setup: the AI took Placement 0 in 26/26 fights, Sniper 0 in 23/26, Armor 3 in 25/26 and Might 3 in 24/26. Humans
  took Sniper 3 in 14/26 and Placement 1–2 in 13/26.

## Mechanism in a19

a19 inherits a13's `maxMoves: 1`, so the search enumerates only the destination nearest an enemy, and
`SEARCH_ACTIVE_CHALLENGERS=1` drops every generated wait and defend challenger. The search therefore arbitrates only
among charges and that nearest advance: "hold and receive the charge" is not a candidate it can score. P1 and P2
added exactly those candidates and both measured null (see README.md).

## Does a19 play the new ranged armies well?

Common's `src/simulation/measure_unit_turn_mix.ts`, 10 mirrored deterministic a19 games per unit with the unit forced
into both rosters (2026-09-22):

| unit | turns/stack | attack share | move | wait | defend | damage/turn | died |
|---|---|---|---|---|---|---|---|
| Medusa (L2 ranged) | 4.1 | 90% | 10% | 0% | 0% | 141 | 91% at lap 4.3 |
| Beholder (L2 ranged) | 5.5 | 84% | 15% | 1% | 0% | 117 | 55% at lap 4.7 |
| Dryad (L1 ranged) | 3.0 | 85% | 14% | 1% | 0% | 74 | 58% at lap 3.1 |
| Peasant (L1 melee control) | 2.0 | 29% | 51% | 20% | 0% | 14 | 75% at lap 1.9 |

The shooters the r4 draft adds attack on 84–90% of their turns and convert five to ten times the melee control's
damage per turn, in line with the live human benchmark (humans' ranged units took a ranged action on 63–88% of their
turns). Composition, not tactics, was where the live losses lived.
