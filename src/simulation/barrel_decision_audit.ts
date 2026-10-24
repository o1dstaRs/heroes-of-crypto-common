import type { IDecisionContext } from "../ai/ai_strategy";
import { projectBarrelShotTradeoff } from "../ai/artifact_barrel_tactics";
import { enumerateCandidates } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import { getCellForPosition } from "../grid/grid_math";
import type { Unit } from "../units/unit";

/** Observational, opt-in evidence for an owned barrel decision; never selects or executes an action. */
export function auditOwnBarrelDecision(
    unit: Unit,
    context: IDecisionContext,
    incumbent: readonly GameAction[],
    chosen: readonly GameAction[],
) {
    const strike = chosen.find((action) => action.type === "obstacle_attack");
    if (!strike || strike.attackerId !== unit.getId()) return undefined;
    const cell = getCellForPosition(context.grid.getSettings(), strike.targetPosition);
    if (
        !context.grid
            .getArtifactBarrels(unit.getTeam())
            .some((barrel) => barrel.cell.x === cell.x && barrel.cell.y === cell.y)
    )
        return undefined;

    const candidates = enumerateCandidates(unit, context, [...incumbent], {
        includeArtifactBarrelAttackCoverage: true,
        maxMeleePairs: 4,
        maxMoveDestinations: 4,
        maxShotAims: 4,
        maxAreaThrowCells: 4,
    }).candidates;
    const roster = [...context.unitsHolder.getAllUnits().values()].filter((other) => !other.isDead());
    return structuredClone({
        lap: context.fightProperties?.getCurrentLap() ?? 0,
        actorId: unit.getId(),
        actor: unit.getName(),
        team: unit.getTeam(),
        actorCells: unit.getCells(),
        selectedAttackType: unit.getAttackTypeSelection(),
        barrel: cell,
        incumbent,
        chosen,
        keptIncumbent: JSON.stringify(incumbent) === JSON.stringify(chosen),
        alternatives: candidates
            .filter((candidate) => candidate.kind !== "incumbent")
            .map((candidate) => ({
                kind: candidate.kind,
                expectedDamage: candidate.features.expectedDamage,
                expectedKill: candidate.features.expectedKill,
                spellName: candidate.spellName,
                target: roster.find((other) => other.getId() === candidate.targetId)?.getName(),
                actions: candidate.actions,
            }))
            .sort((left, right) => right.expectedDamage - left.expectedDamage),
        shots: projectBarrelShotTradeoff(context, cell)?.map((row) => ({
            ...row,
            creature: roster.find((other) => other.getId() === row.unitId)?.getName(),
        })),
        roster: roster.map((other) => ({
            id: other.getId(),
            creature: other.getName(),
            team: other.getTeam(),
            cells: other.getCells(),
            alive: other.getAmountAlive(),
            hp: other.getCumulativeHp(),
        })),
    });
}

export type IBarrelDecisionAudit = NonNullable<ReturnType<typeof auditOwnBarrelDecision>>;
