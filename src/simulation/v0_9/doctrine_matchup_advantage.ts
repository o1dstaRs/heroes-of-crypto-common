/**
 * Research-only, action-relative build features. No weights, selector, or shipped-profile import.
 * The caller supplies the acting seat's reducer-projected observation, never the full draft state.
 * A choice is an attempted pick: collision/fallback outcomes belong in labels, not feature inputs.
 */
import { creatureInfo, type ICreatureInfo } from "../../ai/setup/creature_score";
import { draftCreatureCoherenceAffinity } from "../../ai/setup/draft_coherence";
import {
    draftContextAfterCreature,
    draftCreatureContinuation,
    draftFactionContinuations,
    draftFutureSlots,
} from "../../ai/setup/draft_continuations";
import type { ArtifactFitVersion } from "../../ai/setup/artifact_fit";
import { Tier1Artifact, Tier2Artifact } from "../../artifacts/artifact_properties";
import { Doctrine } from "../../doctrines/doctrine_properties";
import { ToFactionType } from "../../factions/faction_type";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { IDraftScoutingContext } from "../../picks/draft_visibility";
import { SynergyKeysToPower } from "../../synergies/synergy_properties";
import { CreatureLevelList } from "../../units/unit_properties";

export const DOCTRINE_MATCHUP_ADVANTAGE_SCHEMA = "hoc.ai.v0_9.doctrine_matchup_advantage.v1";
const creatureIds = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))].sort((a, b) => a - b);
const doctrines = [Doctrine.SEE_ALL, Doctrine.THREE_REVEALS, Doctrine.SEE_NONE];
const conditionalRoles = ["ranged", "damage_caster", "mobile_melee"] as const;

export const DOCTRINE_MATCHUP_ADVANTAGE_FEATURES: readonly string[] = Object.freeze([
    ...creatureIds.map((id) => `attempted_unit_${id}`),
    "ranged",
    "damage_caster",
    "support",
    "flyer",
    "slow_ground_melee",
    "mobile_melee",
    "ranged_at_least_2",
    "ranged_at_least_3",
    "ranged_at_least_4",
    "public_build_fit",
    "longbow_ranged_pairs",
    "mage_ring_beneficiaries",
    "winged_boots_beneficiaries",
    "echo_quiver_beneficiaries",
    "farsight_quiver_beneficiaries",
    "archmage_ring_beneficiaries",
    "block_large_ground_melee",
    "hazard_slow_ground_melee",
    "obstructed_map_flyers",
    ...["ranged", "damage_caster", "slow_ground_melee", "flyer"].map((role) => `unknown_map_${role}`),
    "life_supply",
    "life_morale",
    "nature_board",
    "nature_fly_armor",
    "chaos_movement",
    "chaos_break",
    "might_aura_range",
    "might_ability_power",
    "ranged_vs_visible_melee_speed",
    "slow_ground_melee_vs_visible_ranged",
    "damage_caster_vs_visible_magic_immunity",
    "ranged_vs_visible_flyers",
    "mobile_melee_vs_visible_ranged",
    ...conditionalRoles.map((role) => `unknown_enemy_${role}`),
    "future_ranged_capacity_3",
    "future_ranged_capacity_4",
    "future_damage_caster_capacity",
    "uncertain_future_ranged",
    "unreachable_faction_thresholds",
    ...doctrines.flatMap((doctrine) => conditionalRoles.map((role) => `doctrine_${doctrine}_${role}`)),
    ...[0, 1, 2, 3, 4].flatMap((level) => ["ranged", "damage_caster"].map((role) => `level_${level}_${role}`)),
]);

export interface IDoctrineMatchupObservation {
    readonly doctrine: number;
    readonly level: number;
    /** Public from the draft start. Do not erase these in an advance-information ablation. */
    readonly synergyVariants: Readonly<Record<string, number>>;
    readonly context: {
        readonly ownCreatureIds: readonly number[];
        readonly knownOpponentCreatureIds: readonly number[];
        readonly tier1ArtifactId?: number;
        readonly tier2ArtifactId?: number;
        readonly artifactFitVersion: ArtifactFitVersion;
        readonly scouting: IDraftScoutingContext;
    };
}

export interface IDoctrineMatchupChoice {
    readonly creatureIds: readonly number[];
    readonly tier1ArtifactId?: number;
}

function units(ids: readonly number[]): ICreatureInfo[] {
    return [...new Set(ids)].map((id) => {
        const unit = creatureInfo(id);
        if (!unit) throw new Error(`Unknown draft creature ${id}`);
        return unit;
    });
}

function power(
    army: readonly ICreatureInfo[],
    variants: Readonly<Record<string, number>>,
    name: string,
    variant: number,
): number {
    if (variants[name] !== variant) return 0;
    const level = Math.min(3, Math.floor(army.filter((unit) => unit.faction === ToFactionType[name]).length / 2));
    return SynergyKeysToPower[`${name}:${variant}:${level}`]?.[0] ?? 0;
}

function choiceValues(o: IDoctrineMatchupObservation, choice: IDoctrineMatchupChoice): Record<string, number> {
    if (!doctrines.includes(o.doctrine) || !Number.isInteger(o.level) || o.level < 0 || o.level > 4)
        throw new Error("Invalid doctrine matchup decision");
    const ctx = o.context;
    const added = units(choice.creatureIds);
    if (
        added.length !== choice.creatureIds.length ||
        added.length !== (o.level === 0 ? 2 : 1) ||
        (o.level !== 0 && added.some((unit) => unit.level !== o.level)) ||
        choice.creatureIds.some((id) => ctx.ownCreatureIds.includes(id))
    )
        throw new Error("Invalid attempted draft choice");
    const roster = [...ctx.ownCreatureIds, ...choice.creatureIds];
    const own = units(roster),
        enemy = units(ctx.knownOpponentCreatureIds);
    if (own.length > 6 || enemy.length > 6) throw new Error("Invalid draft army size");
    const scouting = o.level === 0 ? ctx.scouting : choice.creatureIds.reduce(draftContextAfterCreature, ctx.scouting);
    const t1 = choice.tier1ArtifactId ?? ctx.tier1ArtifactId,
        t2 = ctx.tier2ArtifactId;
    const n = (predicate: (unit: ICreatureInfo) => boolean) => own.filter(predicate).length;
    const slow = (u: ICreatureInfo) => u.melee && !u.canFly && (u.movementSteps ?? 0) <= 4;
    const mobile = (u: ICreatureInfo) => u.melee && (u.canFly || (u.movementSteps ?? 0) >= 6);
    const roles = {
        ranged: n((u) => u.ranged),
        damage_caster: n((u) => u.rangedSpellDamage),
        support: n((u) => u.caster && !u.rangedSpellDamage),
        flyer: n((u) => u.canFly),
        slow_ground_melee: n(slow),
        mobile_melee: n(mobile),
    };
    const map = scouting.map;
    const block = map === PBTypes.GridVals.BLOCK_CENTER;
    const lava = map === PBTypes.GridVals.LAVA_CENTER,
        water = map === PBTypes.GridVals.WATER_CENTER;
    const rangedPath = draftCreatureContinuation(roster, ctx.knownOpponentCreatureIds, scouting, (u) => u.ranged);
    const spellPath = draftCreatureContinuation(
        roster,
        ctx.knownOpponentCreatureIds,
        scouting,
        (u) => u.rangedSpellDamage,
    );
    const enemyRanged = enemy.filter((u) => u.ranged).length;
    const enemyMovement = power(enemy, o.synergyVariants, "Chaos", 1);
    // Visible enemies are a lower bound, not an imputed complete enemy roster. Unknownness is separate.
    const enemyMeleeSpeed = enemy
        .filter((u) => u.melee)
        .reduce((sum, u) => sum + (u.movementSteps ?? 0) + enemyMovement, 0);
    const values: Record<string, number> = {
        ...Object.fromEntries(
            creatureIds.map((id) => [`attempted_unit_${id}`, Number(choice.creatureIds.includes(id))]),
        ),
        ...Object.fromEntries(Object.entries(roles).map(([name, value]) => [name, value / 6])),
        ranged_at_least_2: Number(roles.ranged >= 2),
        ranged_at_least_3: Number(roles.ranged >= 3),
        ranged_at_least_4: Number(roles.ranged >= 4),
        public_build_fit: added.reduce(
            (sum, u) =>
                sum +
                draftCreatureCoherenceAffinity(u.id, {
                    ownCreatureIds: ctx.ownCreatureIds,
                    knownOpponentCreatureIds: ctx.knownOpponentCreatureIds,
                    tier1ArtifactId: t1,
                    tier2ArtifactId: ctx.tier2ArtifactId,
                    artifactFitVersion: ctx.artifactFitVersion,
                    scouting: ctx.scouting,
                }),
            0,
        ),
        // N ranged stacks grant +N attack to each ranged stack. This is a draft composition signal,
        // not exact combat damage: later splits, attrition, augments and placement are not observed here.
        longbow_ranged_pairs: t1 === Tier1Artifact.HUNTERS_LONGBOW ? roles.ranged ** 2 / 36 : 0,
        mage_ring_beneficiaries: t1 === Tier1Artifact.MAGES_RING ? n((u) => !!u.dealsMagicDamage) / 6 : 0,
        winged_boots_beneficiaries: t1 === Tier1Artifact.WINGED_BOOTS ? roles.flyer / 6 : 0,
        echo_quiver_beneficiaries: t2 === Tier2Artifact.QUIVER_OF_ECHOES ? n((u) => u.ranged && u.shots > 1) / 6 : 0,
        farsight_quiver_beneficiaries: t2 === Tier2Artifact.FARSIGHT_QUIVER ? roles.ranged / 6 : 0,
        archmage_ring_beneficiaries: t2 === Tier2Artifact.ARCHMAGES_RING ? n((u) => !!u.dealsMagicDamage) / 6 : 0,
        block_large_ground_melee: block
            ? n((u) => u.melee && !u.canFly && u.footprintWidth * u.footprintHeight > 1) / 6
            : 0,
        hazard_slow_ground_melee:
            n(
                (u) =>
                    slow(u) &&
                    ((lava && t2 !== Tier2Artifact.LAVA_STRIDERS && !u.abilities.includes("Made of Fire")) ||
                        (water && !u.abilities.includes("Made of Water"))),
            ) / 6,
        obstructed_map_flyers: block || lava || water ? roles.flyer / 6 : 0,
        life_supply: (power(own, o.synergyVariants, "Life", 1) * own.length) / 600,
        life_morale: (power(own, o.synergyVariants, "Life", 2) * own.length) / 600,
        nature_board: power(own, o.synergyVariants, "Nature", 1) / 6,
        nature_fly_armor: (power(own, o.synergyVariants, "Nature", 2) * roles.flyer) / 600,
        chaos_movement: (power(own, o.synergyVariants, "Chaos", 1) * n((u) => u.melee)) / 18,
        chaos_break: (power(own, o.synergyVariants, "Chaos", 2) * n((u) => u.melee || u.ranged)) / 600,
        might_aura_range: (power(own, o.synergyVariants, "Might", 1) * own.reduce((s, u) => s + u.auraCount, 0)) / 18,
        might_ability_power:
            (power(own, o.synergyVariants, "Might", 2) * own.reduce((s, u) => s + u.abilityCount, 0)) / 600,
        ranged_vs_visible_melee_speed: (roles.ranged * enemyMeleeSpeed) / 288,
        slow_ground_melee_vs_visible_ranged: (roles.slow_ground_melee * enemyRanged) / 36,
        damage_caster_vs_visible_magic_immunity: (roles.damage_caster * enemy.filter((u) => u.magicImmune).length) / 36,
        ranged_vs_visible_flyers: (roles.ranged * enemy.filter((u) => u.canFly).length) / 36,
        mobile_melee_vs_visible_ranged: (roles.mobile_melee * enemyRanged) / 36,
        future_ranged_capacity_3: Number(rangedPath.maximumCount >= 3),
        future_ranged_capacity_4: Number(rangedPath.maximumCount >= 4),
        future_damage_caster_capacity: spellPath.maximumCount / 6,
        uncertain_future_ranged:
            (draftFutureSlots(roster, ctx.knownOpponentCreatureIds, scouting)
                .filter((slot) => slot.uncertain)
                .reduce((sum, slot) => sum + slot.count, 0) *
                roles.ranged) /
            36,
        unreachable_faction_thresholds:
            draftFactionContinuations(roster, ctx.knownOpponentCreatureIds, scouting).filter(
                (path) => path.count % 2 === 1 && !path.reachable,
            ).length / 4,
    };
    for (const role of ["ranged", "damage_caster", "slow_ground_melee", "flyer"] as const)
        values[`unknown_map_${role}`] = map === undefined ? roles[role] / 6 : 0;
    for (const role of conditionalRoles) {
        values[`unknown_enemy_${role}`] = ((6 - enemy.length) * roles[role]) / 36;
        for (const doctrine of doctrines)
            values[`doctrine_${doctrine}_${role}`] = doctrine === o.doctrine ? roles[role] / 6 : 0;
    }
    for (const level of [0, 1, 2, 3, 4])
        for (const role of ["ranged", "damage_caster"] as const)
            values[`level_${level}_${role}`] = level === o.level ? roles[role] / 6 : 0;
    return values;
}

/** Candidate minus incumbent; no constant context columns that vanish unnoticed in a linear ranking. */
export function doctrineMatchupAdvantageFeatures(
    observation: IDoctrineMatchupObservation,
    incumbent: IDoctrineMatchupChoice,
    candidate: IDoctrineMatchupChoice,
): number[] {
    const base = choiceValues(observation, incumbent),
        other = choiceValues(observation, candidate);
    const result = DOCTRINE_MATCHUP_ADVANTAGE_FEATURES.map((name) => other[name] - base[name]);
    if (!result.every(Number.isFinite)) throw new Error("Invalid doctrine matchup feature vector");
    return result;
}

export interface IDoctrineMatchedOutcome {
    readonly future: number;
    readonly combatSeed: number;
    readonly score: number;
}

/** One board is one statistical unit, regardless of its menu size or number of matched futures. */
export function doctrineMatchedAdvantage(
    incumbent: readonly IDoctrineMatchedOutcome[],
    candidate: readonly IDoctrineMatchedOutcome[],
): { gain: number; futureDifferences: number[] } {
    const index = (rows: readonly IDoctrineMatchedOutcome[]) => {
        if (!rows.length) throw new Error("Missing matched futures");
        const result = new Map<number, IDoctrineMatchedOutcome>();
        const seeds = new Set<number>();
        for (const row of rows) {
            if (
                !Number.isSafeInteger(row.future) ||
                row.future < 0 ||
                !Number.isSafeInteger(row.combatSeed) ||
                row.combatSeed < 0 ||
                row.combatSeed > 0xffffffff ||
                ![0, 0.5, 1].includes(row.score) ||
                result.has(row.future) ||
                seeds.has(row.combatSeed)
            )
                throw new Error("Invalid matched future");
            result.set(row.future, row);
            seeds.add(row.combatSeed);
        }
        return result;
    };
    const base = index(incumbent),
        other = index(candidate);
    if (base.size !== other.size) throw new Error("Unpaired futures");
    const futureDifferences = [...base]
        .sort(([a], [b]) => a - b)
        .map(([future, row]) => {
            const match = other.get(future);
            if (!match || match.combatSeed !== row.combatSeed) throw new Error("Unpaired futures");
            return match.score - row.score;
        });
    return { gain: futureDifferences.reduce((sum, value) => sum + value, 0) / base.size, futureDifferences };
}
