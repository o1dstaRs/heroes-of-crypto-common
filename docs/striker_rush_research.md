# Striker rush research

This study started from a player's report, not from a search result. On November 19, 2026, the owner
wrote about a live game against the default AI: "current AI is way too easy to win, I just always
run on them. They never do placements nor split units to cover ranges", then "it needs to
understand who it is dealing with", and later "artifacts are good with certain units or against
certain units. Same for formations or units picks or augments. Also map makes sense. It is all
versatile. We cant just sort by winrate".

The registered result is in [the adoption record](striker_rush_adoption.md). This file keeps how the
rule was found, what was tried and failed, and what is still open.

## What the live games show

The test server held 64 finished human-versus-AI fights with a clear result. The AI won 31. Split
by the one thing the players did differently:

| Human bought Placement | Games | AI won |
| ---------------------- | ----: | -----: |
| No                     |    46 |     28 |
| Level 1 or 2           |    18 |      3 |

The AI itself had no Placement upgrade in 61 of the 64 games. Almost all of these games come from
one or two accounts, so this is a description of how the AI was being beaten, not a population
estimate.

## One game taken apart

In the reported game the player fielded Squire, Wandering Mage, Hyena, Manticore, Efreet and Magic
Dragon with Placement 2, Movement 2 and Armor 2, started the four melee stacks on the forward edge
of the deep zone, and won in five laps against five shooters and one melee stack.

The offline engine replayed that setup with the default AI playing **both** armies, so the fight
skill is the same on every row and only the player's army setup changes (20 seeds each):

| Setup of the player's army                                | That army wins |
| --------------------------------------------------------- | -------------: |
| As played: Placement 2, Movement 2, Armor 2, their cells  |            85% |
| Same, without the two one-model caster splits             |         80-85% |
| Same upgrades, the engine's own formation                 |             5% |
| Armor 2, Movement 2, Might 2, no Placement                |            30% |
| Armor 2, Might 2, Empower 2, no Placement and no Movement |             0% |

On the production lifecycle the default AI gives this army Armor 3 and Might 3 and loses 10 of 10.
With Placement 2, Movement 2, Armor 2 and the strikers spread along the front edge it wins 9 of 10.
The player's edge was the upgrades and the formation. The fight search already knew how to use them.

The mechanism is one engine rule: a shooter cannot fire while any enemy body stands next to it
(`AttackHandler.canLandRangeAttack`). Strikers that arrive on their first move switch the shooters
off.

## What does not work

- **A formation for the shooters.** 66 searched layouts of the shooter army inside its own zone:
  the best won 2 of 5. A corner block with the melee stack split three ways in front won 0 of 20;
  area damage punishes the clump and the blockers leave the wall to attack.
- **Other upgrades for the shooters.** Against the rush, Armor 3 with Might 2, Armor 3 with
  Sniper 2, Might 3 with Armor 2 and a guarded line with Placement 2 won 0 to 2 games in 10. That
  matchup is lost in the draft.
- **Scripted fights as a cheap judge of setups.** Without search the scripted strikers wait through
  the first lap and lose 6 of 6 with the very setup that wins 85% under search. A setup can only be
  judged with the search on, at 10 to 15 CPU-seconds a game.
- **The rush for every army.** On a 212-case bank of the AI's usual shooter-heavy drafts the same
  setup cost 16 points wherever it was applied.

## The rule

Rush setup against stock setup for the same seat, 371 paired lifecycle games on two banks (the
rosters of 57 real human-versus-AI games, and 212 cases of the AI's own drafts). Cell: paired
difference in score points, with the number of games.

| Own shooters | Enemy strikers 0-1 |          2 |          3 |  4 or more |
| ------------ | -----------------: | ---------: | ---------: | ---------: |
| 0            |          +50.0 (8) | +25.0 (12) | +46.4 (14) | -15.6 (48) |
| 1            |          -7.7 (13) |  -25.0 (4) |  +50.0 (2) | -27.8 (18) |
| 2            |         +14.3 (28) | -19.7 (33) |  -5.9 (17) | -40.6 (16) |
| 3 or more    |          -6.6 (53) | -25.0 (52) | -11.3 (31) | -15.9 (22) |

A striker is a melee stack that is not a shooter, a damage caster or a buff caster
(`isA19DeliveryMelee`). Read as rules:

| Rule on the development data              | Games | Difference |   95% interval | Better / worse |
| ----------------------------------------- | ----: | ---------: | -------------: | -------------: |
| Own strikers >= 4 and enemy strikers <= 3 |    51 |      +32.4 | +19.6 to +46.1 |         17 / 1 |
| Own shooters <= 1 and enemy strikers >= 4 |    66 |      -18.9 |  -29.9 to -8.2 |         4 / 18 |
| Own shooters >= 2, any enemy              |   252 |      -13.3 |  -20.3 to -6.3 |        31 / 64 |

So the three army types beat each other in a circle. A rushing melee army beats shooters. A melee
army that keeps Armor and Might beats a rushing one. Shooters beat a melee army that does not rush.
The AI's draft tables were fitted in games where nobody rushed, which is why they like shooters.

## The whole strategy

The AI's own drafts almost never produce four strikers, so a setup rule alone would rarely fire.
The draft head makes it fire: after every earlier draft decision it takes a fast striker when one
is on offer, otherwise any striker. 198 development tasks on fresh seeds, the candidate seat against
the unchanged default:

| Arm for the candidate seat        | Seat score | Against the default draft and setup |
| --------------------------------- | ---------: | ----------------------------------: |
| Default draft, default setup      |      50.3% |                                     |
| Striker draft head, default setup |      50.3% |            +0.0 (95% -9.6 to +10.1) |
| Striker draft head, rush setup    |      79.0% |          +28.8 (95% +19.9 to +37.6) |

The draft head alone is worth nothing. On the block-centre map it loses 16 points without the
setup rule. The two halves are one policy and ship under one switch.

## Limits and open questions

- Every number here is the AI against the AI. The live record is the only evidence about people
  and it predates this change.
- The new default against itself was run only as a quality check. Both seats draft strikers, so
  neither rushes the other.
- The defence for an army of shooters against a rush is not solved. The AI now avoids being that
  army; it does not yet know how to play it.
- Splits were not the lever in the reported game. One-model splits as blockers would need the fight
  search to offer "hold", which it does not.
- If rushing melee beats shooters this reliably, that is also a balance question for the game and
  not only an AI one.

## Reproducing

The research capsule keeps a read-only export of finished human-versus-AI fights (player identity
reduced to a salted hash on the server, nothing else leaves it), an offline replica that imposes
recorded formations, and a lifecycle runner that replaces one seat's upgrade selection and final
formation layer on the production server path without source edits. The registered inputs and
their hashes are in the [registration](evidence/striker_rush_registration_20261120.json).
