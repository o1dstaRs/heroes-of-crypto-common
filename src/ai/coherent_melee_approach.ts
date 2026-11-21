/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import type { GameAction } from "../engine/actions";
import {
    moveCellsMatchAsSet,
    repairUnavailableMovePrefixedAttack,
    resolveMoveTargetCells,
} from "../engine/post_move_actor_availability";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { IDecisionContext } from "./ai_strategy";
import { decisionFireWalls } from "./decision_fight_state";
import { decisionPathSource } from "./decision_path_catalog";
import { assertNoLegacySeatEnv, seatEnvName } from "./seat_env";

export const A19_COHERENT_MELEE_APPROACH_ID = "a19-coherent-melee-approach-v1";

/** Per-seat switch (seat_env): on unless `A19_COHERENT_MELEE_APPROACH_<LEFT|RIGHT>=0`. */
export const A19_COHERENT_MELEE_APPROACH_ENV = "A19_COHERENT_MELEE_APPROACH";

export function a19CoherentMeleeApproachEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_COHERENT_MELEE_APPROACH_ENV);
    return process.env[seatEnvName(A19_COHERENT_MELEE_APPROACH_ENV, team)] !== "0";
}

export interface IA19CoherentMeleeApproachResult {
    actions: GameAction[];
    reason: "unchanged" | "aligned-approach" | "stationary-strike" | "unavailable-approach" | "movement-blocks-strike";
}

/**
 * a19-coherent-melee-approach-v1 (production). Some policy layers (the inherited aura positioning, Rapid Charge
 * repositioning) replace a melee approach without replacing the explicit move before it, so the turn moves to one
 * cell and then proposes a strike whose route starts at the old cell; the engine refuses the strike and the unit
 * stands next to the enemy without attacking. This rebuilds that ONE move to the strike's stand cell and makes the
 * strike stationary; a strike from the current cell drops the stale move; an approach the engine would not allow
 * keeps the original move and drops the strike. Consistent decisions keep their array reference. Movement stays
 * explicit, so Fire Wall, Water Shield, vines, smoke and movement events still run.
 */
export function a19CoherentMeleeApproach(
    unit: Unit,
    context: IDecisionContext,
    actions: GameAction[],
): IA19CoherentMeleeApproachResult {
    const unchanged: IA19CoherentMeleeApproachResult = { actions, reason: "unchanged" };
    const strikeIndex = actions.findIndex(
        (action) => action.type === "melee_attack" && action.attackerId === unit.getId(),
    );
    if (strikeIndex < 0) return unchanged;
    const moveIndex = actions.findIndex(
        (action, index) => index < strikeIndex && action.type === "move_unit" && action.unitId === unit.getId(),
    );
    if (moveIndex < 0) return unchanged;
    const move = actions[moveIndex] as Extract<GameAction, { type: "move_unit" }>;
    const strike = actions[strikeIndex] as Extract<GameAction, { type: "melee_attack" }>;
    const desiredCells = unit.getFootprintCellsForAnchor(strike.attackFrom);
    const oldCells = resolveMoveTargetCells(
        unit.isSmallSize(),
        move.path,
        move.targetCells,
        unit.getFootprintWidth(),
        unit.getFootprintHeight(),
    );
    if (moveCellsMatchAsSet(oldCells, desiredCells)) return unchanged;

    const preserveMove = (): IA19CoherentMeleeApproachResult => ({
        actions: actions.slice(0, moveIndex + 1),
        reason: "unavailable-approach",
    });
    const target = context.unitsHolder.getAllUnits().get(strike.targetId);
    const forced = context.unitsHolder.getAllUnits().get(unit.getTarget());
    if (
        !target ||
        target.isDead() ||
        target.getTeam() === unit.getTeam() ||
        target.hasBuffActive("Hidden") ||
        unit.hasAbilityActive("No Melee") ||
        unit.cannotAttackUnitId(target.getId()) ||
        (forced && !forced.isDead() && forced.getId() !== target.getId()) ||
        !context.grid.areCellsAdjacent(desiredCells, target.getCells())
    )
        return preserveMove();

    const stationary: Extract<GameAction, { type: "melee_attack" }> = {
        type: "melee_attack",
        attackerId: strike.attackerId,
        targetId: strike.targetId,
        attackFrom: { ...strike.attackFrom },
    };
    const base = unit.getBaseCell();
    if (base.x === strike.attackFrom.x && base.y === strike.attackFrom.y) {
        if (unit.hasStatusApplied("Cowardice") && unit.getCumulativeHp() < target.getCumulativeHp())
            return preserveMove();
        return {
            actions: actions.flatMap((action, index) =>
                index === moveIndex ? [] : [index === strikeIndex ? stationary : action],
            ),
            reason: "stationary-strike",
        };
    }
    if (!unit.canMove()) return preserveMove();
    const enemy = unit.getTeam() === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const paths = decisionPathSource(context).getMovePath(
        base,
        context.matrix,
        unit.getSteps(),
        context.grid.getAggrMatrixByTeam(enemy),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("In Its Own World"),
        unit.getFootprintWidth(),
        unit.getFootprintHeight(),
    );
    const route = paths.knownPaths.get((strike.attackFrom.x << 4) | strike.attackFrom.y)?.[0];
    if (
        !route?.route.length ||
        !(
            context.grid.areAllCellsEmpty(desiredCells, unit.getId()) ||
            context.grid.canOccupyCells(
                desiredCells,
                unit.canTraverseLava(),
                unit.hasAbilityActive("Made of Water"),
                unit.getId(),
            )
        )
    )
        return preserveMove();

    const aligned = [...actions];
    aligned[moveIndex] = {
        ...move,
        path: route.route.map((cell) => ({ ...cell })),
        targetCells: desiredCells.map((cell) => ({ ...cell })),
        hasLavaCell: route.hasLavaCell,
        hasWaterCell: route.hasWaterCell,
    };
    aligned[strikeIndex] = stationary;
    const available = repairUnavailableMovePrefixedAttack(unit, decisionFireWalls(context), aligned, (targetId) =>
        context.unitsHolder.getAllUnits().get(targetId),
    );
    return { actions: available, reason: available === aligned ? "aligned-approach" : "movement-blocks-strike" };
}
