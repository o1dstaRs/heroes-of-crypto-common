# Rejection fixes — adopted as A19 profile v22

Adopted on November 21, 2026 at the owner's request. On the same day the owner asked: “Need to fix all rejection
causes”. Policy id `a19-rejection-fixes-v1`. Nothing was deployed by the adoption.

## The three causes

Every AI quality error was one of three causes, in 127,643 simulated games from three days of confirmation and
research arms. The census found 199 declined melee strikes, 37 refused moves, 32 mindless no-action closeouts that
followed those refusals, and 5 turn-engine wedges. All 21 games with a refusal in that day's production-code arms
reproduced on production code. The test server's logs for November 16–21 held no refusals, in 14 live fights.

1. **A strike from the cell the unit had just left** (`attack_not_available`). The native v0.8 decision was
   `[move_unit to X, melee_attack whose own route starts at the old cell]`. A policy layer had rewritten the strike
   without its move: v0.4's Rapid Charge repositioning, or the inherited aura positioning. The engine refused the
   strike. Rollouts skip a refused action, so the search kept the move, and the unit stood next to the enemy
   without attacking. This is the declined scripted melee proposal behind the failed quality gates of profiles
   v15, v18, v19 and v20.
2. **A mindless unit's route through a zone of control** (`invalid_move`). The Berserker and the Frenzied Boar play
   exact v0.1. Their `findTarget` approach comes from a wider search than the engine's step-limited,
   zone-of-control-aware known paths. The engine refused the move and the strike after it, and the unit lost its
   turn to the no-action closeout.
3. **A turn-engine wedge after consecutive skips** (server). Stun, Blindness, Freeze and Whirlpool complete a
   turn at once. With two stacks alive, one advance went skip, skip, lap flip, skip, then hit its retry cap. The
   recovery then took the waiting unit's turn away.

## The fixes

- `a19-coherent-melee-approach-v1` (`src/ai/coherent_melee_approach.ts`) is the last step of
  `StrategyV0_8.decideTurn`, so it applies live, in rollouts and in simulations. It rebuilds that one move to the
  strike's stand cell and makes the strike stationary. A strike from the current cell drops the stale move. An
  approach the engine would not allow keeps the original move and drops the strike. Consistent decisions keep
  their array reference.
- `a19-engine-reachable-routes-v1` (`StrategyV0_1.isLegalMoveRoute`, inherited by v0.2–v0.8): a route is legal only
  when its destination is in the engine-equivalent known paths. These are built from the same arguments as the
  server's `currentActiveKnownPaths`, once per decision context, inside a private random stream.
- The server's `turnAdvanceAttempts` allows four laps of activations and is shared with the replay checker (server
  `dbb41ce`). The common rollout, lookahead and battle-engine loops already allowed one more attempt than the
  server; they are unchanged.

Both common fixes are on unless a seat switch is `"0"`: `A19_COHERENT_MELEE_APPROACH_<LEFT|RIGHT>`,
`A19_ENGINE_REACHABLE_ROUTES_<LEFT|RIGHT>`.

## Evidence

Registered before any game of its bank was played:
`docs/evidence/rejection_fixes_registration_20261121.json` (sha256 `0613b1987e120e72cb874aae41fb01b781c3acbb46382d3fed41d960620bbea0`). Results:
`docs/evidence/rejection_fixes_confirmation_20261121.json`. Two execution deviations were recorded before any row they
affect. The owner arms ran on the Mac instead of the second host, on the same tree. The second-host rerun started
alongside another study instead of after it.

The bank is fresh: namespace `rejection-fixes-20261121-v1`, 171 families, 1,539 tasks per population. It was audited
against 869 ledgers before any bank file was written, with 0 intersections. The candidate ran on the entrant seat of
the production tree: server `dbb41ce`, common `1715a218` (profile v21), plus the fixes. The opponent kept them off.
With both fixes off, the tree reproduces production v21 exactly (6/6 games).

| Primary: mirror (both seats the v21 default) | Games | Difference | 95% interval   |
| -------------------------------------------- | ----: | ---------: | -------------- |
| **All**                                      | 1,539 |  **+0.06** | −0.94 to +1.07 |
| Normal                                       |   513 |      −1.36 | −3.70 to +0.78 |
| Lava                                         |   513 |      +1.85 | +0.19 to +3.61 |
| Block centre                                 |   513 |      −0.29 | −1.27 to +0.58 |
| Owner-shaped opponent (guard), all tasks     | 1,539 |      +0.10 | −0.65 to +0.81 |

| Behaviour                                       | Control | Fixes |
| ----------------------------------------------- | ------: | ----: |
| Entrant-seat refused actions (both populations) |       5 |     0 |
| Games with any quality error (either seat)      |       6 |     2 |

Turn-engine wedges in either arm: 0. Both arms ran with the server's advance-cap fix.

| Gate                                                                      | Result |
| ------------------------------------------------------------------------- | ------ |
| N1 non-inferiority: primary 95% lower bound at least −2                   | passed |
| N2 no map of the mirror below −2                                          | passed |
| N3 owner guard: difference over all owner tasks at least −2               | passed |
| N4 entrant refusals at most 10% of control (zero when control is below 5) | passed |
| N5 no turn-engine wedge in either arm                                     | passed |
| N6 thirty candidate mirror tasks reproduce their digests on a second host | passed |

The registered analysis ran unamended. No strength gain is claimed: the primary interval crosses zero.
With the fixes on one seat, 20% of the mirror games play out differently, because the rollouts
play the repaired decisions too.

## What it is and is not

- It removes the refused actions of the seat that has the fixes. In both arms the opponent kept them off, so the
  remaining refusals counted for "either seat" are the opponent's.
- It is not a win rate against people.
- Research trees with older common logged five more v0.8 `invalid_move` refusals, in rush-plan, fort-placement and
  deep-fit sequential arms. No production-code arm showed one.
