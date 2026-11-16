/** Offline action-coverage experiment. No serving strategy imports this module. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";

export const SHOOTER_PIN_DELIVERY_RESEARCH_ID = "shooter-pin-delivery-v1";
type Context = Pick<IDecisionContext, "unitsHolder" | "grid" | "attackHandler" | "fightProperties" | "decisionOrigin">;

const adjacent = (left: readonly XY[], right: readonly XY[]) =>
    left.some((a) => right.some((b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1));

/**
 * Keep the original target and native damage/kill/moving class. Position-dependent aura, retaliation,
 * secondary damage and survival remain questions for the complete native rollout, not this metadata.
 */
const attackClass = (candidate: IEnumeratedCandidate): string | undefined => {
    if (candidate.kind !== "melee" || !Number.isFinite(candidate.features.expectedDamage)) return undefined;
    const hit = candidate.actions.find((action) => action.type === "melee_attack");
    if (!hit) return undefined;
    return JSON.stringify([
        hit.targetId,
        candidate.features.expectedDamage,
        candidate.features.expectedKill,
        candidate.actions.some((action) => action.type === "move_unit"),
    ]);
};

/**
 * Offer one missing move-and-strike endpoint that additionally pins a currently shootable, not-yet-acted
 * enemy. Shooting eligibility comes from the engine, including existing melee pins, ammo and Rangebane.
 * Spellcasters gain no suppression credit for spells. The coarse damage-band weight orders proposals;
 * it is not an estimate of prevented damage or a promise the shooter cannot escape.
 *
 * Only already-enumerated legal melee candidates are considered. Every normal candidate is retained;
 * the caller must append the proposal after computing the entire normal shortlist. No forced action,
 * extra pathfinding, state mutation, future seed, outcome label or private setup input is used here.
 */
export function selectShooterPinDelivery(
    unit: Unit,
    context: Context,
    candidates: readonly IEnumeratedCandidate[],
    retained: readonly IEnumeratedCandidate[],
): { candidate: IEnumeratedCandidate; pinWeight: number; baselinePinWeight: number; shooterIds: string[] } | undefined {
    const { fightProperties, attackHandler, grid } = context;
    if (
        context.decisionOrigin !== "root" ||
        !fightProperties ||
        !attackHandler ||
        unit.isDead() ||
        unit.getAttackRange() <= 0 ||
        unit.hasAbilityActive("No Melee") ||
        !retained.length
    )
        return undefined;

    const shooters = [...context.unitsHolder.getAllUnits().values()]
        .filter(
            (enemy) =>
                enemy.getTeam() !== unit.getTeam() &&
                !enemy.isDead() &&
                !enemy.hasAbilityActive("Hidden") &&
                !enemy.hasBuffActive("Hidden") &&
                !fightProperties.hasAlreadyMadeTurn(enemy.getId()) &&
                attackHandler.canLandRangeAttack(enemy, grid.getEnemyAggrMatrixByUnitId(enemy.getId())),
        )
        .map((enemy) => ({
            id: enemy.getId(),
            cells: enemy.getCells(),
            weight: Math.max(
                0,
                (enemy.getAmountAlive() * (enemy.getAttackDamageMin() + enemy.getAttackDamageMax())) / 2,
            ),
        }));
    if (!shooters.length) return undefined;

    const pins = (candidate: IEnumeratedCandidate) => {
        const move = candidate.actions.find((action) => action.type === "move_unit");
        const anchor = move?.path.at(-1);
        if (!move || !anchor) return { weight: 0, ids: [] as string[] };
        const cells = move.targetCells ?? unit.getFootprintCellsForAnchor(anchor);
        const pinned = shooters.filter((shooter) => adjacent(cells, shooter.cells));
        return { weight: pinned.reduce((sum, shooter) => sum + shooter.weight, 0), ids: pinned.map((s) => s.id) };
    };
    const bestRetained = new Map<string, number>();
    for (const candidate of retained) {
        const key = attackClass(candidate);
        if (key !== undefined) bestRetained.set(key, Math.max(bestRetained.get(key) ?? 0, pins(candidate).weight));
    }

    let result: ReturnType<typeof selectShooterPinDelivery>;
    let bestGain = 0;
    for (const candidate of candidates) {
        const key = attackClass(candidate);
        if (key === undefined || !bestRetained.has(key)) continue;
        const baselinePinWeight = bestRetained.get(key)!;
        const { weight: pinWeight, ids: shooterIds } = pins(candidate);
        const gain = pinWeight - baselinePinWeight;
        if (gain <= bestGain) continue;
        bestGain = gain;
        result = { candidate, pinWeight, baselinePinWeight, shooterIds };
    }
    return result;
}
