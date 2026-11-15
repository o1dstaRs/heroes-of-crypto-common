/** Offline candidate coverage experiment. Not imported by any serving strategy. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import type { GameAction } from "../engine/actions";
import { isOffensiveSpellMultiplier } from "../spells/spell_damage";
import { isSpellUsableByCaster } from "../spells/spell_helper";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";

export const BACKLINE_APPROACH_MOVE_RESEARCH_ID = "backline-approach-move-v1";
type Context = Pick<IDecisionContext, "unitsHolder" | "fightProperties" | "decisionOrigin">;
const pureMove = (actions: readonly GameAction[]) =>
    actions.length === 1 && actions[0].type === "move_unit" ? actions[0] : undefined;

/** Visible remaining ranged output, including borrowed shooting and melee/magic damage casters. */
export function hasBacklineApproachTargetOutput(unit: Unit): boolean {
    return (
        (unit.isRangeCapable() && unit.getRangeShots() > 0) ||
        unit
            .getSpells()
            .some(
                (spell) =>
                    !spell.isBuff() &&
                    isOffensiveSpellMultiplier(spell.getMultiplierType()) &&
                    isSpellUsableByCaster(unit, spell),
            )
    );
}

/**
 * Propose one already-enumerated pure move, at least one cell nearer the closest visible damage
 * backliner than ALL ordinary moves and a pure-move incumbent. Footprint distance is a proposal
 * heuristic, not a promise of next-turn reach, silence, safety or better game value. Real A19 rollouts
 * decide its value. Never pathfind again, mutate the board, consume RNG or inspect future events.
 */
export function selectBacklineApproachMove(
    unit: Unit,
    context: Context,
    moves: readonly IEnumeratedCandidate[],
    retained: readonly IEnumeratedCandidate[],
    incumbent: readonly GameAction[],
): { candidate: IEnumeratedCandidate; baselineDistance: number; selectedDistance: number } | undefined {
    if (context.decisionOrigin !== "root" || !moves.length || !retained.length) return undefined;
    if (context.fightProperties!.getCurrentLap() > 6 || unit.getAmountAlive() <= 1) return undefined;
    const id = creatureIdForName(unit.getName());
    const info = id === undefined ? undefined : creatureInfo(id);
    if (
        !info?.melee ||
        info.ranged ||
        info.rangedSpellDamage ||
        unit.isRangeCapable() ||
        (!unit.canFly() && unit.getSteps() < 5)
    )
        return undefined;
    const cells = [...context.unitsHolder.getAllUnits().values()]
        .filter(
            (enemy) =>
                !enemy.isDead() &&
                enemy.getTeam() !== unit.getTeam() &&
                !enemy.hasAbilityActive("Hidden") &&
                !enemy.hasBuffActive("Hidden") &&
                hasBacklineApproachTargetOutput(enemy),
        )
        .flatMap((enemy) => enemy.getCells());
    if (!cells.length) return undefined;
    const distance = (footprint: readonly XY[]): number => {
        let best = Infinity;
        for (const from of footprint) {
            for (const to of cells) best = Math.min(best, Math.hypot(from.x - to.x, from.y - to.y));
        }
        return best;
    };
    const score = (actions: readonly GameAction[]): number => {
        const move = pureMove(actions);
        if (!move) return Infinity;
        const anchor = move.path.at(-1);
        if (!anchor) return Infinity;
        return distance(move.targetCells ?? unit.getFootprintCellsForAnchor(anchor));
    };
    const baselineDistance = Math.min(score(incumbent), ...retained.map((c) => score(c.actions)));
    if (!Number.isFinite(baselineDistance)) return undefined;
    const currentDistance = distance(unit.getCells());
    let candidate: IEnumeratedCandidate | undefined;
    let selectedDistance = Infinity;
    for (const proposal of moves) {
        const value = score(proposal.actions);
        if (baselineDistance - value < 1 || value >= currentDistance || value >= selectedDistance) continue;
        candidate = proposal;
        selectedDistance = value;
    }
    return candidate ? { candidate, baselineDistance, selectedDistance } : undefined;
}

/** Replace only the last ordinary slot; keep K, the leading challenger and later native reservations. */
export function reserveBacklineApproachMove(
    candidate: IEnumeratedCandidate | undefined,
    challengers: readonly IEnumeratedCandidate[],
): readonly IEnumeratedCandidate[] {
    if (!candidate || challengers.includes(candidate) || challengers.length < 2) return challengers;
    return [...challengers.slice(0, -1), candidate];
}
