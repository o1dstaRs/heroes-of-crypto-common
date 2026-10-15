import { ARTIFACT_POWER, TIER2_ARTIFACT_LIST, Tier1Artifact, Tier2Artifact } from "../../artifacts/artifact_properties";
import { DOUBLE_SHOT_ABILITY_NAMES } from "../../abilities/double_shot_names";
import { creatureInfo, type ICreatureInfo } from "./creature_score";
import {
    TIER2_ARTIFACT_SCORE_A19_RANGED,
    TIER2_ARTIFACT_WINRATE_MELEE,
    TIER2_ARTIFACT_WINRATE_RANGED,
} from "./setup_conditional";
import { TIER2_ARTIFACT_WINRATE, type ITier2ArtifactDecisionContext } from "./setup_strategy";
import type { IResolvedSetupPolicy } from "./setup_ship";

export const ARTIFACT_FIT_SETUP_PREFIX = "artifact-fit-v1:";

const roster = (ids: readonly number[]): ICreatureInfo[] =>
    [...new Set(ids)].flatMap((id) => {
        const info = creatureInfo(id);
        return info ? [info] : [];
    });
const average = (units: readonly ICreatureInfo[], value: (unit: ICreatureInfo) => number): number =>
    units.length ? units.reduce((sum, unit) => sum + value(unit), 0) / units.length : 0;
const magicPressure = (unit: ICreatureInfo): number => Number(unit.rangedSpellDamage || unit.magicAttack);
const attackChance = (base: number, unit: ICreatureInfo, tier1ArtifactId?: number): number =>
    Math.max(
        0,
        Math.min(
            100,
            base +
                (unit.luck ?? 0) +
                (tier1ArtifactId === Tier1Artifact.CURSED_WARD ? ARTIFACT_POWER.CURSED_WARD_LUCK : 0),
        ),
    ) / 100;

/** Mechanics-derived fit scores, not measured win rates. Historical priors remain unchanged for other items. */
export function tier1ArtifactFitScore(id: number, ownIds: readonly number[], baseline: number): number {
    const own = roster(ownIds);
    if (!own.length) return baseline;
    switch (id) {
        case Tier1Artifact.MAGES_RING: {
            const share = average(own, magicPressure);
            return share > 0 ? 50 + ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT * share : 0;
        }
        case Tier1Artifact.TOME_OF_AMPLIFICATION: {
            const share = average(own, (unit) => Number(unit.castsAmplifiableBuff));
            return share > 0 ? 50 + ARTIFACT_POWER.TOME_BUFF_POWER_PERCENT * share : 0;
        }
        case Tier1Artifact.RIME_CHARM:
            return (
                50 +
                25 *
                    average(own, (unit) =>
                        unit.melee || unit.ranged ? attackChance(ARTIFACT_POWER.RIME_PROC_PERCENT, unit) : 0,
                    )
            );
        default:
            return baseline;
    }
}

const FIT_TIER2_IDS: ReadonlySet<number> = new Set([
    Tier2Artifact.ARCHMAGES_RING,
    Tier2Artifact.AEGIS_OF_THE_ARCANE,
    Tier2Artifact.QUIVER_OF_ECHOES,
    Tier2Artifact.GRAVECHAIN,
    Tier2Artifact.LAST_FUSE,
]);
const LIVE_TIER2_IDS: ReadonlySet<number> = new Set(TIER2_ARTIFACT_LIST.map((artifact) => artifact.id));

/** Public roster forecasts only: no hidden positions, stack sizes, opponent artifacts, or future picks. */
export function tier2ArtifactFitScore(
    id: number,
    ownIds: readonly number[],
    context?: Readonly<ITier2ArtifactDecisionContext>,
): number {
    const own = roster(ownIds);
    if (!own.length) return 50;
    const enemy = roster(context?.publicOpponentCreatureIds ?? []);
    const tier1 = context?.ownArtifactIds?.[0];
    switch (id) {
        case Tier2Artifact.ARCHMAGES_RING: {
            const share = average(own, magicPressure);
            const existing = tier1 === Tier1Artifact.MAGES_RING ? ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT / 100 : 0;
            return share > 0 ? 50 + (ARTIFACT_POWER.ARCHMAGES_RING_MAGIC_PERCENT * share) / (1 + existing) : 0;
        }
        case Tier2Artifact.AEGIS_OF_THE_ARCANE: {
            const incomingMagic = average(enemy, magicPressure);
            const defense = ARTIFACT_POWER.AEGIS_OF_THE_ARCANE_MAGIC_DEFENSE / 100;
            const beneficiaries = average(own, (unit) => Number(!unit.magicImmune));
            return beneficiaries > 0 ? 50 + ((100 * defense) / (1 - defense)) * incomingMagic * beneficiaries : 0;
        }
        case Tier2Artifact.QUIVER_OF_ECHOES: {
            const extraVolleyShare = average(own, (unit) => {
                if (!unit.ranged) return 0;
                const nativeVolleys = DOUBLE_SHOT_ABILITY_NAMES.some((name) => unit.abilities.includes(name)) ? 2 : 1;
                return attackChance(ARTIFACT_POWER.QUIVER_OF_ECHOES_CHANCE, unit, tier1) / nativeVolleys;
            });
            return extraVolleyShare > 0 ? 50 + 100 * extraVolleyShare : 0;
        }
        case Tier2Artifact.GRAVECHAIN: {
            const enemyMovementReliance = enemy.length ? average(enemy, (unit) => Number(unit.melee)) : 0.5;
            // Connectivity is unknown at draft time. Forecast half the additional possible links, never a full cluster.
            const targets = 1 + 0.5 * Math.min(ARTIFACT_POWER.GRAVECHAIN_CONNECTIONS, Math.max(0, enemy.length - 1));
            const slow = average(own, (unit) =>
                unit.melee || unit.ranged ? attackChance(ARTIFACT_POWER.GRAVECHAIN_CHANCE, unit, tier1) : 0,
            );
            const movementCost = average(
                own,
                (unit) =>
                    (ARTIFACT_POWER.GRAVECHAIN_STEPS_PENALTY / Math.max(1, unit.movementSteps ?? 4)) *
                    (unit.melee ? 1 : 0.25),
            );
            return 50 + 25 * slow * targets * enemyMovementReliance - 100 * movementCost;
        }
        case Tier2Artifact.LAST_FUSE: {
            // The only guaranteed damage basis before combat is the per-power floor. Never substitute original
            // maximum stack HP for the actual fatal hit, or charge the army for still-living stacks.
            const contact = average(
                own,
                (unit) =>
                    (unit.melee ? 1 : 0.1) *
                    (unit.abilities.includes("Resurrection") ? 0.5 : 1) *
                    (unit.footprintWidth * unit.footprintHeight > 1 ? 1.25 : 1),
            );
            return 40 + ARTIFACT_POWER.LAST_FUSE_MIN_DAMAGE_PER_POWER * contact;
        }
        default:
            return TIER2_ARTIFACT_WINRATE[id] ?? 50;
    }
}

/** Keep the base policy's ordering of established items; compare only the new items against that incumbent. */
export function withArtifactFitSetupPolicy(base: Readonly<IResolvedSetupPolicy>): IResolvedSetupPolicy {
    if (base.spec.startsWith(ARTIFACT_FIT_SETUP_PREFIX)) return base;
    return Object.freeze({
        ...base,
        configured: true,
        spec: `${ARTIFACT_FIT_SETUP_PREFIX}${base.spec}`,
        journalVersion: `${ARTIFACT_FIT_SETUP_PREFIX}${base.journalVersion}`,
        pickArtifactT2: (
            offered: readonly number[],
            ownIds: readonly number[],
            context?: Readonly<ITier2ArtifactDecisionContext>,
        ): number => {
            const legal = offered.filter((id) => LIVE_TIER2_IDS.has(id));
            if (!legal.length) return Tier2Artifact.NO_ARTIFACT;
            const own = roster(ownIds);
            if (!own.length || !legal.some((id) => FIT_TIER2_IDS.has(id)))
                return base.pickArtifactT2(legal, ownIds, context);
            const established = legal.filter((id) => !FIT_TIER2_IDS.has(id));
            const ranged = own.filter((unit) => unit.ranged).length >= 2;
            const table =
                base.rules.includes("t2a19") && ranged
                    ? TIER2_ARTIFACT_SCORE_A19_RANGED
                    : base.rules.includes("t2")
                      ? ranged
                          ? TIER2_ARTIFACT_WINRATE_RANGED
                          : TIER2_ARTIFACT_WINRATE_MELEE
                      : TIER2_ARTIFACT_WINRATE;
            let best = established.length ? base.pickArtifactT2(established, ownIds, context) : legal[0];
            let bestScore = established.length ? (table[best] ?? 50) : -Infinity;
            for (const id of legal) {
                if (!FIT_TIER2_IDS.has(id)) continue;
                const score = tier2ArtifactFitScore(id, ownIds, context);
                if (score > bestScore) {
                    best = id;
                    bestScore = score;
                }
            }
            return best;
        },
    });
}
