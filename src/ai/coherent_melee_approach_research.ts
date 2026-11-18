/*
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
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

export const COHERENT_MELEE_APPROACH_RESEARCH_ID = "a19-coherent-melee-approach-v1";

export interface ICoherentMeleeApproachResult {
    actions: GameAction[];
    reason: "unchanged" | "aligned-approach" | "stationary-strike" | "unavailable-approach" | "movement-blocks-strike";
}

/**
 * Offline only. A final policy rewrite can leave an old move before a melee whose new approach starts at
 * the original anchor. Rebuild that ONE move and make its suffix stationary; never execute both routes.
 * Keep ordinary decisions by reference and use native reachability, body cells and terrain metadata.
 * Movement remains explicit so Fire Wall, Water Shield, vines, smoke and movement events still run.
 */
export function coherentMeleeApproachResearch(
    unit: Unit,
    context: IDecisionContext,
    actions: GameAction[],
): ICoherentMeleeApproachResult {
    const unchanged: ICoherentMeleeApproachResult = { actions, reason: "unchanged" };
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

    const preserveMove = (): ICoherentMeleeApproachResult => ({
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
