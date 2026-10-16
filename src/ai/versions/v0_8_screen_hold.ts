/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import type { GameAction } from "../../engine/actions";
import { canWaitOnHourglass } from "../../engine/hourglass";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IDecisionContext } from "../ai_strategy";
import { isMindlessAiUnit } from "../unit_ai_overrides";

export interface IScreenHoldRisk {
    readonly wardId: string;
    readonly flyerId: string;
    readonly openedLandings: number;
}

const hash = (cell: XY): number => (cell.x << 4) | cell.y;
const adjacent = (left: readonly XY[], right: readonly XY[]): boolean =>
    left.some((a) => right.some((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1));

/**
 * Research candidate, never enabled by default. Detect a pure move that opens the first reachable melee
 * landing within two flight activations beside a currently unpinned shooter. The projected occupancy is detached: no Grid, Unit, RNG,
 * target memory, or battle state is changed. Flight uses the native eight-direction movement cost.
 * This is a one-move geometry check, not a claim that the enemy will choose that attack or that the
 * screen survives other intervening turns. Spells, strikes and productive move-attacks are preserved.
 */
export function openedV08FlyerScreen(
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): IScreenHoldRisk | undefined {
    const fp = context.fightProperties;
    if (
        !fp ||
        fp.getCurrentLap() > 3 ||
        context.grid.getSettings().getGridSize() !== 16 ||
        unit.isDead() ||
        isMindlessAiUnit(unit) ||
        unit.isRangeCapable() ||
        unit.getCanCastSpells() ||
        decision.some((a) => !["move_unit", "select_attack_type", "end_turn"].includes(a.type))
    )
        return undefined;
    const moves = decision.filter((a): a is Extract<GameAction, { type: "move_unit" }> => a.type === "move_unit");
    if (moves.length !== 1 || moves[0].unitId !== unit.getId()) return undefined;
    const destination = moves[0].path.at(-1);
    if (!destination) return undefined;
    const destinationCells = footprintCellsForAnchor(unit, destination);
    const destinationHashes = new Set(destinationCells.map(hash));
    if (unit.getCells().every((cell) => destinationHashes.has(hash(cell)))) return undefined;
    // Occupancy hides the terrain beneath a standing body. Do not project a vacated centre cell as
    // ordinary ground (a fire creature can stand over lava that another flyer cannot land on).
    const centre = new Set(context.grid.getCenterCells().map(hash));
    if (unit.getCells().some((cell) => centre.has(hash(cell)))) return undefined;
    const allies = context.unitsHolder.getAllAllies(unit.getTeam());
    const wards = allies.filter(
        (ward) =>
            ward.getId() !== unit.getId() &&
            !ward.isDead() &&
            !ward.hasBuffActive("Hidden") &&
            ward.getAmountAlive() > 1 &&
            ward.isRangeCapable() &&
            ward.getRangeShots() > 0 &&
            context.attackHandler?.canLandRangeAttack(ward, context.grid.getEnemyAggrMatrixByUnitId(ward.getId())),
    );
    if (!wards.length) return undefined;
    const enemies = context.unitsHolder.getAllEnemyUnits(unit.getTeam());
    const flyers = enemies.filter(
        (enemy) =>
            !enemy.isDead() && enemy.canFly() && enemy.getAttackRange() > 0 && !enemy.hasAbilityActive("No Melee"),
    );
    for (const flyer of flyers) {
        const origin = flyer.getBaseCell();
        if (!origin) continue;
        const width = flyer.getFootprintWidth(),
            height = flyer.getFootprintHeight();
        const landings: { cells: XY[]; before: boolean; after: boolean }[] = [];
        for (let x = width - 1; x < 16; x++) {
            for (let y = height - 1; y < 16; y++) {
                const dx = Math.abs(x - origin.x),
                    dy = Math.abs(y - origin.y);
                const cost = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
                if (cost > 2 * flyer.getSteps() + 1e-9) continue;
                const cells = footprintCellsForAnchor(flyer, { x, y });
                if (!wards.some((ward) => adjacent(cells, ward.getCells()))) continue;
                let before = true,
                    after = true;
                for (const cell of cells) {
                    const occupant = context.grid.getOccupantUnitId(cell);
                    const terrainAllowed =
                        !occupant ||
                        occupant === flyer.getId() ||
                        (occupant === "L" && flyer.canTraverseLava()) ||
                        (occupant === "W" && flyer.hasAbilityActive("Made of Water"));
                    before &&= terrainAllowed;
                    after &&= (terrainAllowed || occupant === unit.getId()) && !destinationHashes.has(hash(cell));
                }
                if (before || after) landings.push({ cells, before, after });
            }
        }
        for (const ward of wards) {
            const forcedTarget = context.unitsHolder.getAllUnits().get(flyer.getTarget());
            if (forcedTarget && forcedTarget.getId() !== ward.getId() && !forcedTarget.isDead()) continue;
            if (flyer.hasDebuffActive("Cowardice") && flyer.getCumulativeHp() < ward.getCumulativeHp()) continue;
            const nearby = landings.filter((landing) => adjacent(landing.cells, ward.getCells()));
            if (nearby.some((landing) => landing.before)) continue;
            const opened = nearby.filter((landing) => landing.after).length;
            if (opened) return { wardId: ward.getId(), flyerId: flyer.getId(), openedLandings: opened };
        }
    }
    return undefined;
}

/** Off-line callers choose whether an exhausted hourglass may become a defend; default is wait only. */
export function preserveV08ClosedRangedScreen(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    allowDefend = false,
): GameAction[] {
    if (!context.fightProperties || !openedV08FlyerScreen(unit, context, decision)) return decision;
    if (canWaitOnHourglass(unit, context.fightProperties, context.unitsHolder.getAllUnits()))
        return [{ type: "wait_turn", unitId: unit.getId() }];
    return allowDefend ? [{ type: "defend_turn", unitId: unit.getId() }] : decision;
}
