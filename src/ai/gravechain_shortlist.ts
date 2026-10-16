import { getGravechainTargets } from "../abilities/gravechain_ability";
import type { Unit } from "../units/unit";
import type { IDecisionContext } from "./ai_strategy";
import type { IEnumeratedCandidate } from "./candidates";

/**
 * An immediate material leaf cannot price Gravebound's future movement denial. Keep at most one broader
 * chain for real-engine horizon comparison, without replacing the incumbent or a normal top-K challenger.
 * This is potential coverage, not promised procs or HP-equivalent damage: the rollout owns misses, luck,
 * retaliation, deaths and the value of the movement that is actually denied.
 *
 * Only ordinary single-target attacks are covered here. Splash/line/secondary-hit roots need their whole
 * authoritative impact set; counting only their advertised primary would compare incomplete chains.
 */
export function reserveGravechainShortlistCandidate(
    unit: Unit,
    context: Pick<IDecisionContext, "grid" | "unitsHolder" | "fightProperties">,
    candidates: readonly IEnumeratedCandidate[],
    challengers: readonly IEnumeratedCandidate[],
): readonly IEnumeratedCandidate[] {
    if (!unit.hasBuffActive("Gravechain") || unit.getGravechainChance() <= 0) return challengers;
    if (
        [
            "Area Throw",
            "Large Caliber",
            "Through Shot",
            "Chakram",
            "Lightning Spin",
            "Fire Breath",
            "Skewer Strike",
        ].some((ability) => unit.hasAbilityActive(ability))
    ) {
        return challengers;
    }
    const coverageByTarget = new Map<string, readonly Unit[]>();
    const coverage = (candidate: IEnumeratedCandidate): number => {
        if (!candidate.targetId || !Number.isFinite(candidate.features.expectedDamage)) return 0;
        if (candidate.features.expectedDamage <= 0) return 0;
        const attacks = candidate.actions.filter(
            (action) => action.type === "melee_attack" || action.type === "range_attack",
        );
        if (
            attacks.length !== 1 ||
            candidate.actions.some(
                (action) =>
                    action.type !== "melee_attack" &&
                    action.type !== "range_attack" &&
                    action.type !== "select_attack_type" &&
                    action.type !== "move_unit",
            )
        ) {
            return 0;
        }
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId);
        if (!target || target.isDead() || target.getTeam() === unit.getTeam()) return 0;
        if (target.hasBuffActive("Water Shield") && !unit.hasAbilityActive("Fire Element")) return 0;
        // Absorption/redirection and a guaranteed miss cannot be advertised as a landed primary chain.
        if (target.hasBuffActive("Flesh Shield Aura")) return 0;
        const enemyPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(target.getTeam()) ?? 0;
        if (unit.calculateMissChance(target, enemyPower) >= 100) return 0;
        let eligible = coverageByTarget.get(target.getId());
        if (!eligible) {
            eligible = getGravechainTargets(target, context.grid, context.unitsHolder).filter(
                (enemy) =>
                    !enemy.isDead() &&
                    enemy.getMagicResist() < 100 &&
                    !enemy.hasStatusApplied("Gravebound") &&
                    enemy.getSteps() > 0,
            );
            coverageByTarget.set(target.getId(), eligible);
        }
        // A finishing hit can still relay through its corpse, but cannot slow the destroyed root itself.
        return eligible.length - Number(candidate.features.expectedKill === 1 && eligible.includes(target));
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
