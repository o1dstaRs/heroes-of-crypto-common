/** Offline coverage experiment. No serving profile imports this module. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import { isCellWithinGrid } from "../grid/grid_math";
import { FIRE_WALL_ORIENTATIONS, fireWallCells, fireWallLitCells, isFireWallableCell } from "../spells/fire_walls";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { hasBacklineApproachTargetOutput } from "./backline_approach_move_research";

export const NIGHTMARE_GROUND_WALL_RESEARCH_ID = "nightmare-ground-wall-coverage-v1";

/**
 * One additional wall using the incumbent geometry recipe, restricted to visible ground units with
 * no remaining ranged/damaging-spell output. This eligibility is a heuristic, not a prediction of their
 * next route. Keep all ordinary alternatives; complete engine search decides whether to spend a turn.
 * No RNG, forecast outcome, extra path search, board mutation or fabricated immediate damage.
 */
export function proposeNightmareGroundWall(
    unit: Unit,
    context: IDecisionContext,
    catalog: readonly IEnumeratedCandidate[],
): { candidate: IEnumeratedCandidate; groundEnemyIds: string[]; excludedEnemyIds: string[] } | undefined {
    if (context.decisionOrigin !== "root" || unit.getName() !== "Nightmare" || unit.isDead()) return undefined;
    // Reuse an engine-legal enumerated cast as the availability and metadata gate.
    const template = catalog.find(
        (candidate) =>
            candidate.spellName === "Fire Wall" &&
            candidate.actions.length === 1 &&
            candidate.actions[0].type === "cast_spell" &&
            candidate.actions[0].casterId === unit.getId(),
    );
    if (!template) return undefined;
    const enemies = context.unitsHolder
        .getAllAllies(unit.getTeam() === 2 ? 1 : 2)
        .filter((enemy) => !enemy.isDead() && !enemy.hasBuffActive("Hidden") && !enemy.hasAbilityActive("Hidden"));
    const ground = enemies.filter((enemy) => !enemy.canFly() && !hasBacklineApproachTargetOutput(enemy));
    if (!ground.length || ground.length === enemies.length) return undefined;
    const allies = context.unitsHolder.getAllAllies(unit.getTeam()).filter((ally) => !ally.isDead());
    if (!allies.length) return undefined;
    const center = {
        x: Math.round(allies.reduce((sum, ally) => sum + ally.getBaseCell().x, 0) / allies.length),
        y: Math.round(allies.reduce((sum, ally) => sum + ally.getBaseCell().y, 0) / allies.length),
    };
    const { grid, unitsHolder } = context;
    const settings = grid.getSettings();
    const legal = (anchor: XY, orientation: number): boolean => {
        let lit = 0;
        for (const cell of fireWallCells(anchor, orientation)) {
            const inside = isCellWithinGrid(settings, cell);
            if (isFireWallableCell(grid, inside, cell)) lit++;
            else {
                const occupant = inside ? grid.getOccupantUnitId(cell) : undefined;
                if (occupant && unitsHolder.getAllUnits().has(occupant)) return false;
            }
        }
        return lit > 0;
    };
    let best: { cell: XY; orientation: number; score: number } | undefined;
    for (const enemy of ground) {
        const origin = enemy.getBaseCell();
        const dx = center.x - origin.x;
        const dy = center.y - origin.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 1) continue;
        const threat = Math.max(1, enemy.getAmountAlive()) * Math.max(1, enemy.getAttackDamageMax());
        const orientations = FIRE_WALL_ORIENTATIONS.map((orientation, index) => {
            const [a, b] = fireWallCells({ x: 0, y: 0 }, orientation);
            const wx = b.x - a.x;
            const wy = b.y - a.y;
            return { orientation, index, alignment: Math.abs((wx * dx + wy * dy) / (Math.hypot(wx, wy) * distance)) };
        }).sort((a, b) => a.alignment - b.alignment || a.index - b.index);
        for (const fraction of [0.25, 0.35, 0.5]) {
            const cell = { x: Math.round(origin.x + dx * fraction), y: Math.round(origin.y + dy * fraction) };
            const score = threat / fraction;
            for (const { orientation } of orientations) {
                if (!legal(cell, orientation)) continue;
                if (!best || score > best.score) best = { cell, orientation, score };
                break;
            }
        }
    }
    if (!best) return undefined;
    const signature = (cell: XY, orientation: number | undefined) =>
        fireWallLitCells(grid, (c) => isCellWithinGrid(settings, c), cell, orientation ?? 0)
            .map((c) => `${c.x},${c.y}`)
            .sort()
            .join(";");
    const proposed = signature(best.cell, best.orientation);
    if (
        catalog.some((candidate) =>
            candidate.actions.some(
                (action) =>
                    action.type === "cast_spell" &&
                    action.spellName === "Fire Wall" &&
                    !!action.targetCell &&
                    signature(action.targetCell, action.targetOrientation) === proposed,
            ),
        )
    )
        return undefined;
    const action = template.actions[0];
    if (action.type !== "cast_spell") return undefined;
    return {
        candidate: {
            kind: "spell",
            spellName: "Fire Wall",
            targetCell: best.cell,
            actions: [{ ...action, targetCell: best.cell, targetOrientation: best.orientation }],
            features: { ...template.features, expectedDamage: 0, expectedKill: 0 },
        },
        groundEnemyIds: ground.map((enemy) => enemy.getId()),
        excludedEnemyIds: enemies.filter((enemy) => !ground.includes(enemy)).map((enemy) => enemy.getId()),
    };
}

/** Preserve every native alternative and object identity; add at most one comparison. */
export function appendNightmareGroundWall(
    retained: readonly IEnumeratedCandidate[],
    proposal: ReturnType<typeof proposeNightmareGroundWall>,
): readonly IEnumeratedCandidate[] {
    return proposal ? [...retained, proposal.candidate] : retained;
}
