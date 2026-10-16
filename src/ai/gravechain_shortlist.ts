import { evaluateAffectedUnits } from "../abilities/aoe_range_ability";
import { getGravechainTargets } from "../abilities/gravechain_ability";
import { getCellsAroundCell, isPositionWithinGrid, resolveRangeAttackAimEdge } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import type { IDecisionContext } from "./ai_strategy";
import type { IEnumeratedCandidate } from "./candidates";

type GravechainContext = Pick<IDecisionContext, "grid" | "unitsHolder" | "fightProperties" | "attackHandler">;

/** Resolve the first volley with the engine's aim, interception, splash and Wingshield rules. */
function attackRoots(unit: Unit, context: GravechainContext, candidate: IEnumeratedCandidate): readonly Unit[] {
    const attacks = candidate.actions.filter(
        (action) =>
            action.type === "melee_attack" || action.type === "range_attack" || action.type === "area_throw_attack",
    );
    if (
        attacks.length !== 1 ||
        candidate.actions.some(
            (action) =>
                action.type !== "melee_attack" &&
                action.type !== "range_attack" &&
                action.type !== "area_throw_attack" &&
                action.type !== "select_attack_type" &&
                action.type !== "move_unit",
        )
    ) {
        return [];
    }
    const attack = attacks[0];
    const allUnits = context.unitsHolder.getAllUnits();
    if (attack.type === "melee_attack") {
        if (["Lightning Spin", "Fire Breath", "Skewer Strike"].some((ability) => unit.hasAbilityActive(ability))) {
            return [];
        }
        const target = allUnits.get(attack.targetId);
        return target ? [target] : [];
    }
    // Moving forbids a ranged follow-up. Chakram's later bounces depend on the previous hit landing.
    if (candidate.actions.some((action) => action.type === "move_unit") || unit.hasAbilityActive("Chakram")) {
        return [];
    }
    const through = unit.hasAbilityActive("Through Shot");
    const area = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
    if (through && area) return []; // Inherited combinations do not share one ordinary impact set.
    if (attack.type === "range_attack" && !through && !area) {
        const target = candidate.targetId ? allUnits.get(candidate.targetId) : undefined;
        return target ? [target] : [];
    }
    const handler = context.attackHandler;
    if (!handler) return [];
    const settings = context.grid.getSettings();
    if (attack.type === "area_throw_attack") {
        if (!unit.hasAbilityActive("Area Throw")) return [];
        const impact = handler.projectAreaThrowTargetCell(allUnits, unit, attack.targetCell);
        return (
            evaluateAffectedUnits(
                [...getCellsAroundCell(settings, impact), impact],
                context.unitsHolder,
                context.grid,
            )?.[0] ?? []
        );
    }
    const target = allUnits.get(attack.targetId);
    const aim = target
        ? resolveRangeAttackAimEdge(
              context.grid.getMatrix(),
              settings,
              target.getCells(),
              unit.getPosition(),
              unit.getTeam(),
              through,
              attack.aimCell,
              attack.aimSide,
              area,
          )?.position
        : through && !attack.targetId
          ? attack.targetPosition
          : undefined;
    if (!aim || !isPositionWithinGrid(settings, aim)) return [];
    const evaluation = handler.evaluateRangeAttack(allUnits, unit, unit.getPosition(), aim, through, false, area);
    if (evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length) return [];
    return through
        ? evaluation.affectedUnits.filter((group) => group.length === 1).map((group) => group[0])
        : (evaluation.affectedUnits[0] ?? []);
}

/**
 * An immediate material leaf cannot price Gravebound's future movement denial. Keep at most one broader
 * chain for real-engine horizon comparison, without replacing the incumbent or a normal top-K challenger.
 * This is potential coverage, not promised procs or HP-equivalent damage: the rollout owns misses, luck,
 * retaliation, deaths and the value of the movement that is actually denied.
 *
 * Ranged splash and piercing attacks union their actual impact roots, counting each possible beneficiary
 * once. This remains potential coverage: rolled casualties can remove links before the rider pass, and
 * the real rollout owns those deaths. Melee sweeps and conditional Chakram bounces stay with normal search.
 */
export function reserveGravechainShortlistCandidate(
    unit: Unit,
    context: GravechainContext,
    candidates: readonly IEnumeratedCandidate[],
    challengers: readonly IEnumeratedCandidate[],
): readonly IEnumeratedCandidate[] {
    if (!unit.hasBuffActive("Gravechain") || unit.getGravechainChance() <= 0) return challengers;
    const coverageByTarget = new Map<string, readonly Unit[]>();
    const coverageByCandidate = new Map<IEnumeratedCandidate, number>();
    const coverage = (candidate: IEnumeratedCandidate): number => {
        const cached = coverageByCandidate.get(candidate);
        if (cached !== undefined) return cached;
        if (!Number.isFinite(candidate.features.expectedDamage)) return 0;
        if (candidate.features.expectedDamage <= 0) return 0;
        const covered = new Set<string>();
        for (const target of attackRoots(unit, context, candidate)) {
            if (target.isDead() || target.getTeam() === unit.getTeam()) continue;
            if (target.willWaterShieldAbsorb(unit)) continue;
            // Absorption/redirection and a guaranteed miss cannot be advertised as a landed root.
            if (target.hasBuffActive("Flesh Shield Aura")) continue;
            const enemyPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(target.getTeam()) ?? 0;
            if (unit.calculateMissChance(target, enemyPower) >= 100) continue;
            let eligible = coverageByTarget.get(target.getId());
            if (!eligible) {
                eligible = getGravechainTargets(target, context.grid, context.unitsHolder).filter(
                    (enemy) =>
                        !enemy.isDead() &&
                        enemy.getMagicResist() < 100 &&
                        !enemy.hasDebuffActive("Gravebound") &&
                        enemy.getSteps() > 0,
                );
                coverageByTarget.set(target.getId(), eligible);
            }
            for (const enemy of eligible) covered.add(enemy.getId());
        }
        // A finishing hit can still relay through its corpse, but cannot slow the destroyed root itself.
        if (candidate.features.expectedKill === 1 && candidate.targetId) covered.delete(candidate.targetId);
        coverageByCandidate.set(candidate, covered.size);
        return covered.size;
    };
    const retainedCoverage = Math.max(0, ...[...candidates.slice(0, 1), ...challengers].map(coverage));
    let best: IEnumeratedCandidate | undefined;
    let bestCoverage = Math.max(1, retainedCoverage);
    for (const candidate of candidates) {
        const count = coverage(candidate);
        if (
            count > bestCoverage ||
            (best &&
                count === bestCoverage &&
                (candidate.features.expectedKill > best.features.expectedKill ||
                    (candidate.features.expectedKill === best.features.expectedKill &&
                        candidate.features.expectedDamage > best.features.expectedDamage)))
        ) {
            best = candidate;
            bestCoverage = count;
        }
    }
    return best && !challengers.includes(best) ? [...challengers, best] : challengers;
}
