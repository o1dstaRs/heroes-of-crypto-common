import { ARTIFACT_POWER, TIER2_ARTIFACT_LIST, Tier1Artifact, Tier2Artifact } from "../../artifacts/artifact_properties";
import { DOUBLE_PUNCH_ABILITY_NAMES, DOUBLE_SHOT_ABILITY_NAMES } from "../../abilities/double_shot_names";
import { LUCK_MAX_VALUE_TOTAL } from "../../constants";
import { creatureInfo, type ICreatureInfo } from "./creature_score";
import {
    TIER2_ARTIFACT_SCORE_A19_RANGED,
    TIER2_ARTIFACT_WINRATE_MELEE,
    TIER2_ARTIFACT_WINRATE_RANGED,
} from "./setup_conditional";
import { TIER2_ARTIFACT_WINRATE, type ITier2ArtifactDecisionContext } from "./setup_strategy";
import type { IResolvedSetupPolicy } from "./setup_ship";

export const ARTIFACT_FIT_SETUP_PREFIX = "artifact-fit-v1:";
export const ARTIFACT_FIT_SETUP_PREFIX_V2 = "artifact-fit-v2:";
export const ARTIFACT_FIT_SETUP_PREFIX_V3 = "artifact-fit-v3:";
export const ARTIFACT_FIT_SETUP_PREFIX_V4 = "artifact-fit-v4:";
export type ArtifactFitVersion = 1 | 2 | 3 | 4;

export const artifactFitVersionForSetupSpec = (spec: string): ArtifactFitVersion =>
    spec.startsWith(ARTIFACT_FIT_SETUP_PREFIX_V4)
        ? 4
        : spec.startsWith(ARTIFACT_FIT_SETUP_PREFIX_V3)
          ? 3
          : spec.startsWith(ARTIFACT_FIT_SETUP_PREFIX_V2)
            ? 2
            : 1;

const roster = (ids: readonly number[]): ICreatureInfo[] =>
    [...new Set(ids)].flatMap((id) => {
        const info = creatureInfo(id);
        return info ? [info] : [];
    });
const average = (units: readonly ICreatureInfo[], value: (unit: ICreatureInfo) => number): number =>
    units.length ? units.reduce((sum, unit) => sum + value(unit), 0) / units.length : 0;
const magicPressure = (unit: ICreatureInfo): number => Number(unit.rangedSpellDamage || unit.magicAttack);
const magicPressureV2 = (unit: ICreatureInfo): number =>
    Number(unit.rangedSpellDamage || unit.magicAttack || unit.magicalSplash);
const attackChance = (base: number, unit: ICreatureInfo, tier1ArtifactId?: number, useBaseLuck = false): number => {
    const luck =
        (useBaseLuck ? (unit.baseLuck ?? 0) : (unit.luck ?? 0)) +
        (tier1ArtifactId === Tier1Artifact.CURSED_WARD ? ARTIFACT_POWER.CURSED_WARD_LUCK : 0);
    const currentLuck = useBaseLuck
        ? Math.max(-LUCK_MAX_VALUE_TOTAL, Math.min(LUCK_MAX_VALUE_TOTAL, Math.round(luck)))
        : luck;
    return Math.max(0, Math.min(100, base + currentLuck)) / 100;
};

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

const nativeAttacks = (unit: ICreatureInfo): number => {
    const attacks = (unit.ranged ? DOUBLE_SHOT_ABILITY_NAMES : DOUBLE_PUNCH_ABILITY_NAMES).some((name) =>
        unit.abilities.includes(name),
    )
        ? 2
        : 1;
    return unit.ranged ? Math.min(attacks, Math.max(0, unit.shots)) : attacks;
};
const procPerTurn = (base: number, unit: ICreatureInfo, tier1?: number, useBaseLuck = false): number =>
    1 - (1 - attackChance(base, unit, tier1, useBaseLuck)) ** nativeAttacks(unit);

export function tier1ArtifactFitScoreV2(id: number, ownIds: readonly number[], baseline: number): number {
    const own = roster(ownIds);
    if (id === Tier1Artifact.MAGES_RING && own.length) {
        const share = average(own, magicPressureV2);
        return share > 0 ? 50 + ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT * share : 0;
    }
    if (id !== Tier1Artifact.RIME_CHARM || !own.length) return tier1ArtifactFitScore(id, ownIds, baseline);
    return (
        50 +
        25 *
            average(own, (unit) =>
                unit.melee || unit.ranged ? procPerTurn(ARTIFACT_POWER.RIME_PROC_PERCENT, unit) : 0,
            )
    );
}

export function tier1ArtifactFitScoreV3(id: number, ownIds: readonly number[], baseline: number): number {
    const own = roster(ownIds);
    if (id !== Tier1Artifact.MAGES_RING || !own.length) return tier1ArtifactFitScoreV2(id, ownIds, baseline);
    const share = average(own, (unit) => Number(unit.dealsMagicDamage));
    return share > 0 ? 50 + ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT * share : 0;
}

export function tier1ArtifactFitScoreV4(id: number, ownIds: readonly number[], baseline: number): number {
    const own = roster(ownIds);
    if (id !== Tier1Artifact.RIME_CHARM || !own.length) return tier1ArtifactFitScoreV3(id, ownIds, baseline);
    return (
        50 +
        25 *
            average(own, (unit) =>
                unit.melee || unit.ranged ? procPerTurn(ARTIFACT_POWER.RIME_PROC_PERCENT, unit, undefined, true) : 0,
            )
    );
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

/** Conservative forecasts at pick time. A single scouted caster is not an entire magical enemy army. */
export function tier2ArtifactFitScoreV2(
    id: number,
    ownIds: readonly number[],
    context?: Readonly<ITier2ArtifactDecisionContext>,
): number {
    return tier2ArtifactFitScoreWithMagicPressure(id, ownIds, context, magicPressureV2);
}

export function tier2ArtifactFitScoreV3(
    id: number,
    ownIds: readonly number[],
    context?: Readonly<ITier2ArtifactDecisionContext>,
): number {
    return tier2ArtifactFitScoreWithMagicPressure(id, ownIds, context, (unit) => Number(unit.dealsMagicDamage));
}

export function tier2ArtifactFitScoreV4(
    id: number,
    ownIds: readonly number[],
    context?: Readonly<ITier2ArtifactDecisionContext>,
): number {
    return tier2ArtifactFitScoreWithMagicPressure(id, ownIds, context, (unit) => Number(unit.dealsMagicDamage), true);
}

function tier2ArtifactFitScoreWithMagicPressure(
    id: number,
    ownIds: readonly number[],
    context: Readonly<ITier2ArtifactDecisionContext> | undefined,
    magicPressureForUnit: (unit: ICreatureInfo) => number,
    useBaseLuck = false,
): number {
    const own = roster(ownIds);
    if (!own.length) return 50;
    const enemy = roster(context?.publicOpponentCreatureIds ?? []);
    const tier1 = context?.ownArtifactIds?.[0];
    // Both armies have five drafted identities at this decision; unidentified slots never inherit a revealed
    // unit's kit. Full-army counts, positions and the final level-4 pick remain unavailable.
    const knownEnemyShare = (value: (unit: ICreatureInfo) => number): number =>
        enemy.reduce((sum, unit) => sum + value(unit), 0) / Math.max(5, enemy.length);
    switch (id) {
        case Tier2Artifact.ARCHMAGES_RING: {
            const share = average(own, magicPressureForUnit);
            const existing = tier1 === Tier1Artifact.MAGES_RING ? ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT / 100 : 0;
            // Anchor to the actual A19 prior instead of treating a damage percentage as win-rate points.
            // A token caster must not displace a strong whole-army item in an otherwise physical draft.
            return share > 0
                ? (TIER2_ARTIFACT_SCORE_A19_RANGED[id] ?? 50) +
                      (ARTIFACT_POWER.ARCHMAGES_RING_MAGIC_PERCENT * share) / (1 + existing)
                : 0;
        }
        case Tier2Artifact.AEGIS_OF_THE_ARCANE: {
            const defense = ARTIFACT_POWER.AEGIS_OF_THE_ARCANE_MAGIC_DEFENSE / 100;
            const beneficiaries = average(own, (unit) => Number(!unit.magicImmune));
            return beneficiaries > 0
                ? 50 + ((100 * defense) / (1 - defense)) * knownEnemyShare(magicPressureForUnit) * beneficiaries
                : 0;
        }
        case Tier2Artifact.QUIVER_OF_ECHOES: {
            // A bonus volley consumes ammunition. A stack that starts with only enough for its native volleys
            // cannot trigger it. Weight pressure rather than treating one weak archer like an entire battery.
            const pressure = (unit: ICreatureInfo): number =>
                unit.melee || unit.ranged || unit.rangedSpellDamage
                    ? (Math.max(1, unit.maxDamage) / Math.max(1, unit.exp)) * nativeAttacks(unit)
                    : 0;
            const total = own.reduce((sum, unit) => sum + pressure(unit), 0);
            const extra = own.reduce(
                (sum, unit) =>
                    sum +
                    (unit.ranged && unit.shots > nativeAttacks(unit)
                        ? (pressure(unit) *
                              attackChance(ARTIFACT_POWER.QUIVER_OF_ECHOES_CHANCE, unit, tier1, useBaseLuck)) /
                          nativeAttacks(unit)
                        : 0),
                0,
            );
            return extra > 0 && total > 0 ? 50 + (100 * extra) / total : 0;
        }
        case Tier2Artifact.GRAVECHAIN: {
            const reliance = knownEnemyShare((unit) => Number(unit.melee)) + 0.5 * (1 - Math.min(1, enemy.length / 5));
            // Contact is an expectation, never knowledge of hidden deployment. Only revealed melee identities
            // justify additional links; unknown positions do not become a guaranteed four-target cluster.
            const links =
                0.5 *
                Math.min(
                    ARTIFACT_POWER.GRAVECHAIN_CONNECTIONS,
                    Math.max(0, enemy.filter((unit) => unit.melee).length - 1),
                );
            const slow = average(own, (unit) =>
                unit.melee || unit.ranged ? procPerTurn(ARTIFACT_POWER.GRAVECHAIN_CHANCE, unit, tier1, useBaseLuck) : 0,
            );
            const cost = average(
                own,
                (unit) =>
                    (ARTIFACT_POWER.GRAVECHAIN_STEPS_PENALTY / Math.max(1, unit.movementSteps ?? 4)) *
                    (unit.melee ? 1 : 0.25),
            );
            // Rime's Hamstrung and Gravebound stack multiplicatively, so the second slow removes fewer steps.
            const existingSlow =
                tier1 === Tier1Artifact.RIME_CHARM
                    ? 1 -
                      0.25 *
                          average(own, (unit) =>
                              unit.melee || unit.ranged
                                  ? procPerTurn(ARTIFACT_POWER.RIME_PROC_PERCENT, unit, undefined, useBaseLuck)
                                  : 0,
                          )
                    : 1;
            return 50 + 25 * slow * (1 + links) * reliance * existingSlow - 100 * cost;
        }
        case Tier2Artifact.LAST_FUSE: {
            const contact = average(
                own,
                (unit) =>
                    (unit.melee ? 1 : 0.1) *
                    (unit.abilities.includes("Resurrection") ? 0.5 : 1) *
                    (unit.footprintWidth * unit.footprintHeight > 1 ? 1.25 : 1),
            );
            const enemyContact =
                knownEnemyShare((unit) => Number(unit.melee)) + 0.5 * (1 - Math.min(1, enemy.length / 5));
            // Even a frontline body can be killed from range before making contact. No alive-stack penalty is
            // invented, and resurrection only delays the explosion rather than permanently disabling it.
            return 40 + ARTIFACT_POWER.LAST_FUSE_MIN_DAMAGE_PER_POWER * contact * (0.5 + 0.5 * enemyContact);
        }
        default:
            return tier2ArtifactFitScore(id, ownIds, context);
    }
}

/** Keep the base policy's ordering of established items; compare only the new items against that incumbent. */
export function withArtifactFitSetupPolicy(
    base: Readonly<IResolvedSetupPolicy>,
    version: ArtifactFitVersion = 1,
): IResolvedSetupPolicy {
    const prefix =
        version === 4
            ? ARTIFACT_FIT_SETUP_PREFIX_V4
            : version === 1
              ? ARTIFACT_FIT_SETUP_PREFIX
              : version === 2
                ? ARTIFACT_FIT_SETUP_PREFIX_V2
                : ARTIFACT_FIT_SETUP_PREFIX_V3;
    if (base.spec.startsWith(prefix)) return base;
    return Object.freeze({
        ...base,
        configured: true,
        spec: `${prefix}${base.spec}`,
        journalVersion: `${prefix}${base.journalVersion}`,
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
                    : base.rules.includes("t2") || (version >= 2 && base.rules.includes("t2a19"))
                      ? ranged
                          ? TIER2_ARTIFACT_WINRATE_RANGED
                          : TIER2_ARTIFACT_WINRATE_MELEE
                      : TIER2_ARTIFACT_WINRATE;
            let best = established.length ? base.pickArtifactT2(established, ownIds, context) : legal[0];
            let bestScore = established.length ? (table[best] ?? 50) : -Infinity;
            for (const id of legal) {
                if (!FIT_TIER2_IDS.has(id)) continue;
                const score = (
                    version === 1
                        ? tier2ArtifactFitScore
                        : version === 2
                          ? tier2ArtifactFitScoreV2
                          : version === 3
                            ? tier2ArtifactFitScoreV3
                            : tier2ArtifactFitScoreV4
                )(id, ownIds, context);
                if (score > bestScore) {
                    best = id;
                    bestScore = score;
                }
            }
            return best;
        },
    });
}
