# Striker rush default adoption

> Since profile v18 the rush also covers an army with exactly four strikers and at least two shooters.
> Where this document says "at most three", read it as the rule of profile v15. See
> `docs/striker_rush_mixed_adoption.md`.

On November 20, 2026, the registered confirmation of `a19-striker-rush-v1` closed with a confirmed
strength gain and two failed gates. On November 19 the user had given a standing instruction for
this research: "always lock in wins and continue". Under it the A19-backed v0.8 production profile
now includes the policy, together with the Tier-2 [beneficiary rule](artifact_beneficiary_rule.md).
The profile schema advances from v14 to v15; the global wire version remains v0.8.

The registered strength, per-map and determinism gates passed. The registered quality and cost
gates **failed** and remain failed: neither was waived, re-run or relabeled, and adopting the
behavior does not turn either into a pass. Nothing was deployed by this adoption.

## Adopted behavior

**Draft.** After every earlier draft decision (the locked V3 choice, the contextual head and the
revealed-ranged delivery override), a default seat takes a fast striker when one is on offer: a
melee stack that is not a shooter, a damage caster or a buff caster, and that flies or has five
printed steps. With none on offer it takes any striker; with none of those either, the earlier
choice stands. The pool is ranked by the same draft policy. The opening bundle is the one with the
most strikers, fast ones first, and the earlier choice is kept on a tie. The one-use budgets of the
earlier layers are spent exactly as before.

**Setup.** Once both complete rosters are public, a seat with at least four drafted strikers facing
an army with at most three buys Placement 2 and Movement 2. They are paid for out of the plan the
seat would otherwise have bought: Sniper down to one level, then Empower, Might, Armor and the last
Sniper level. Every real striker stack then starts on the column of the zone nearest the enemy,
spread evenly over its rows in native row order. Casters, shooters, large support bodies and
one-model split children keep their native cells. Against an army with four or more strikers the
seat keeps its native setup: the same plan loses there.

**Artifact.** A seat with the draft head adds a striker at level 4, so its Tier-2 choice is made
for the army as it stands and never takes Farsight Quiver without a shooter or Giant's Maul without
a physical area attacker while another offered artifact works.

Nothing else changes. Doctrine choice, synergies, tactical splits, the A19 search, its weights,
models and budgets are untouched. A seat that is not eligible replays the previous setup exactly.

Code: `src/ai/setup/a19_striker_rush.ts` holds the rules, the plan and the formation; the server's
draft deciders and play session call them. The setup decision keeps no state: eligibility is
recomputed from the two public rosters wherever it is needed, so a restart or a Premium undo cannot
leave a stale marker. Premium advises a player with an eligible army the same plan and arranges the
same formation, but only for a player who actually bought Placement 2 and Movement 2.

`HOC_A19_STRIKER_RUSH=off` on the server restores the previous draft and setup for default seats.
`HOC_A19_CONTEXT_POLICY=off` disables it together with the older overlays. The two halves have one
switch on purpose. Native v0.9 and the lower difficulty tiers never had the policy. The profile
records the decision as `strikerRush`, with qualification
`strength-confirmed-quality-and-cost-gates-failed`. The server's strategy revision gains the suffix
`-striker-rush-v1`.

## Evidence

The [research record](striker_rush_research.md) explains how the rule was found. The
[registration](evidence/striker_rush_registration_20261120.json) (SHA-256
`d2786fd4acf80d1a02d59cd2ad733e0d78a23a420b54f457bf13d944b24a50b0`) was written before any
confirmation game, and the [results](evidence/striker_rush_confirmation_20261120.json) follow its
analysis script unchanged.

Each task is one draft seed, doctrine pair, map and pick order. The candidate seat plays one game
per arm against the unchanged v14 default, which drafts against what it sees. Score is 1 for a win,
0.5 for a draw. Intervals are 10,000 bootstrap resamples over tasks.

| Evidence, candidate seat | Tasks | Default | Striker rush | Difference |     95% interval |
| ------------------------ | ----: | ------: | -----------: | ---------: | ---------------: |
| Development              |   198 |   50.3% |        79.0% |      +28.8 |   +19.9 to +37.6 |
| **Registered, all maps** |   540 |   50.7% |        79.5% | **+28.80** | +23.52 to +34.07 |
| Registered, Normal       |   180 |   49.7% |        81.7% |     +31.94 | +22.78 to +41.11 |
| Registered, Lava         |   180 |   51.4% |        80.8% |     +29.44 | +20.28 to +38.61 |
| Registered, Block centre |   180 |   51.1% |        76.1% |     +25.00 | +15.56 to +34.17 |

The setup rule was eligible and the forward formation applied in all 540 candidate games. The seat
did better in 216 tasks and worse in 59.

| Registered gate                                          | Outcome                 |
| -------------------------------------------------------- | ----------------------- |
| G1 lower bound of the primary interval above zero        | Pass, +23.52            |
| G2 no map with a negative point estimate                 | Pass                    |
| G3 no quality error in a candidate game                  | **Fail**: 1 game of 540 |
| G4 second-host rerun of 30 candidate tasks, same digests | Pass, 30 of 30          |
| G5 candidate CPU per game at most 1.25 times the control | **Fail**: 1.2529 times  |

**G3.** One candidate game logged one declined melee proposal; so did one control game. In the
candidate game it came from the default opponent's one-model caster split: a move to one cell,
then a strike whose approach starts at the old cell. The engine refuses the strike and the turn
ends after the move. This is the construction bug of
[the coherent-approach study](coherent_melee_approach_research.md), whose repair is still inactive.
The rate is the same in both arms, but the gate was registered on the candidate arm alone and it
failed.

**G5.** Candidate games are shorter (5.75 laps against 6.79; 48.6 searched decisions against 53.8)
yet cost 6.79 CPU-seconds against 5.42. Each searched decision costs about 39% more: 139.8 ms
against 100.8 ms, both seats counted, most on the open map. Melee contact gives the search more
attack candidates. The arms ran one after the other on a shared workstation, so the last digits are
soft, but the direction is real. These are offline figures with deterministic work. **Live latency
under the 1,000 ms decision deadline was not measured**, and it is the first thing to check before a
deployment: a decision that runs out of time falls back to the degraded budget.

## Production port

The research measured the policy through a seam that replaced one seat's upgrade selection and its
final formation layer. The production implementation was then built at the evidence heads and the
30 determinism tasks were replayed through it with no seam: 30 of 30 digests are identical. Server
tests cover both physical seats, the rollback, a melee opponent, a hidden roster, a partial budget,
the draft head with its budgets, the artifact choice and the Premium advice.

The confirmation ran at common `bdb90084` and server `f77ae290` (profile v14). The adoption commit
sits on a later head that also contains a Battle Mage stat change. The games were not replayed
there.

## What this does not establish

- Strength against people. The only evidence about people is the live record that prompted the
  study, and it predates the change.
- Strength of the new default against itself. With both seats drafting strikers neither rushes;
  that pairing was run as a quality check only.
- A defence for a shooter army against the rush. The default now avoids fielding that army.
- A general win rate. The estimate is against the previous default, which fields shooters.
