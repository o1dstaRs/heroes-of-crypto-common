/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import {
    TIER1_ARTIFACT_LIST,
    TIER2_ARTIFACT_LIST,
    Tier1Artifact,
    Tier2Artifact,
} from "../artifacts/artifact_properties";
import { creatureInfo, DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import { TIER1_ARTIFACT_WINRATE, TIER2_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import {
    augmentPlanId,
    enumerateFullBudgetAugmentPlans,
    setupAugmentsForPlan,
    setupCohort,
    setupRosterFeatures,
    type IAugmentPlan,
    type ISetupAugmentChoice,
    type SetupCohort,
} from "../ai/setup/setup_ship";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { getArmorPower, getMightPower, getMovementPower, getSniperPower } from "../augments/augment_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import { Perk } from "../perks/perk_properties";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    DEFAULT_ROSTER_COMPOSITION,
    hashSimulationParts,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
} from "./army";
import { creatureIdForName, draftRoster } from "./draft";

/**
 * Post-draft contextual-oracle meta measurement.
 *
 * This deliberately is NOT presented as the deployable ranked setup policy. Tier-1 is selected before a
 * complete army exists in live picks and Tier-2 is selected before the final opponent roster is public. The
 * requested both-armies question therefore needs a research policy. The policy below is deterministic,
 * mechanic-aware and sees both complete rosters plus the public map. Each component independently uses a
 * preregistered 80% contextual / 20% uniform-exploration mixture. Only the exploration slice is used for the
 * causal artifact and augment rankings; all choices remain active together in the actual battles.
 */

export const AI_META_SCHEMA_VERSION = 1;
export const AI_META_POLICY = "contextual-oracle-v2-cast-buffs-80x20";
export const AI_META_EXPLORATION_RATE = 0.2;
export const AI_META_FIGHT_VERSION = "v0.7";
export const AI_META_GAMES_PER_MATCHUP = 2;
export const AI_META_AUGMENT_BUDGET = 7;

export const AI_META_MAPS = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;

/** All protocol map ids accepted when re-reading historical cohort records. Water is no longer live. */
export const AI_META_RECORDED_MAPS = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;

export type AiMetaMap = (typeof AI_META_MAPS)[number];
export type AiMetaRecordedMap = (typeof AI_META_RECORDED_MAPS)[number];

export const AI_META_COHORTS = [
    "ranked-draft",
    "uniform-mixed",
    "ranged-heavy",
    "ground-melee",
    "flyer-heavy",
    "caster-support",
    "cross-archetype",
] as const;

export type AiMetaCohort = (typeof AI_META_COHORTS)[number];
export type AiMetaArchetype = "ranked" | "uniform" | "ranged" | "melee" | "flyer" | "caster";
export type AiMetaSelectionMode = "exploit" | "explore";

export const AI_META_COHORT_DESCRIPTIONS: Readonly<Record<AiMetaCohort, string>> = {
    "ranked-draft": "Current melee-coevolution draft scorer choosing from six offers per level.",
    "uniform-mixed": "Level-balanced armies sampled uniformly from every enabled creature.",
    "ranged-heavy": "Each army fields two to four ranged stacks.",
    "ground-melee": "Each army fields no ranged stacks and at least four ground-melee stacks.",
    "flyer-heavy": "Each army fields at least two flying stacks.",
    "caster-support": "Each army fields at least two MAGIC or MELEE_MAGIC stacks.",
    "cross-archetype": "Balanced ordered ranged/melee/flyer/caster matchups; opposing archetypes differ.",
};

export interface IAiMetaArmyFeatures {
    total: number;
    ranged: number;
    flyers: number;
    groundMelee: number;
    casters: number;
    meleeMagic: number;
    auraCarriers: number;
    large: number;
    healers: number;
    mindControllers: number;
    statusSources: number;
    areaAttackers: number;
    doubleAttackers: number;
    buffers: number;
    averageLevel: number;
}

export interface IAiMetaArtifactChoice {
    id: number;
    mode: AiMetaSelectionMode;
    propensity: number;
    contextualScore: number;
}

export interface IAiMetaAugmentChoice {
    plan: IAugmentPlan;
    planId: string;
    augments: ISetupAugmentChoice[];
    mode: AiMetaSelectionMode;
    propensity: number;
    contextualScore: number;
}

export interface IAiMetaArmy {
    archetype: AiMetaArchetype;
    roster: IArmyUnitSpec[];
    creatureIds: number[];
    features: IAiMetaArmyFeatures;
    setupCohort: SetupCohort;
    artifactT1: IAiMetaArtifactChoice;
    artifactT2: IAiMetaArtifactChoice;
    augment: IAiMetaAugmentChoice;
    perk: Perk;
    synergies: { faction: number; synergy: number }[];
}

export interface IAiMetaGameOutcome {
    /** A is GREEN in game 0 and RED in game 1. */
    aIsGreen: boolean;
    winner: "a" | "b" | "draw";
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck";
    armageddonDecided: boolean;
    rejectedA: number;
    rejectedB: number;
    hpA: number;
    hpB: number;
    survivorsA: number;
    survivorsB: number;
}

export interface IAiMetaPairRecord {
    schemaVersion: typeof AI_META_SCHEMA_VERSION;
    cohort: AiMetaCohort;
    pair: number;
    setupSeed: number;
    combatSeed: number;
    map: AiMetaRecordedMap;
    armyA: IAiMetaArmy;
    armyB: IAiMetaArmy;
    games: [IAiMetaGameOutcome, IAiMetaGameOutcome];
}

export interface IAiMetaRunOptions {
    cohort: AiMetaCohort;
    games: number;
    baseSeed: number;
}

interface ICatalogEntry {
    faction: string;
    creatureName: string;
    level: number;
    size: number;
}

interface IGeneratedMatchup {
    setupSeed: number;
    combatSeed: number;
    map: AiMetaMap;
    archetypeA: AiMetaArchetype;
    archetypeB: AiMetaArchetype;
    rosterA: IArmyUnitSpec[];
    rosterB: IArmyUnitSpec[];
}

const TIER1_IDS = TIER1_ARTIFACT_LIST.map((artifact) => artifact.id);
const TIER2_IDS = TIER2_ARTIFACT_LIST.map((artifact) => artifact.id);
const FULL_AUGMENT_PLANS = enumerateFullBudgetAugmentPlans(AI_META_AUGMENT_BUDGET);

const fraction = (part: number, total: number): number => part / Math.max(1, total);

export function rosterSignature(roster: readonly IArmyUnitSpec[]): string {
    return roster
        .map((unit) => unit.creatureName)
        .slice()
        .sort()
        .join("|");
}

export function creatureIdsForRoster(roster: readonly IArmyUnitSpec[]): number[] {
    return roster.map((unit) => creatureIdForName(unit.creatureName));
}

export function rostersAreStrictlyDistinct(left: readonly IArmyUnitSpec[], right: readonly IArmyUnitSpec[]): boolean {
    const leftNames = new Set(left.map((unit) => unit.creatureName));
    return rosterSignature(left) !== rosterSignature(right) && right.every((unit) => !leftNames.has(unit.creatureName));
}

const includesAny = (value: string, needles: readonly string[]): boolean =>
    needles.some((needle) => value.toLowerCase().includes(needle));

export function armyFeatures(roster: readonly IArmyUnitSpec[]): IAiMetaArmyFeatures {
    const ids = creatureIdsForRoster(roster);
    const setup = setupRosterFeatures(ids);
    const out: IAiMetaArmyFeatures = {
        total: roster.length,
        ranged: 0,
        flyers: 0,
        groundMelee: 0,
        casters: setup.mage,
        meleeMagic: setup.meleeMagic,
        auraCarriers: setup.auraCarriers,
        large: 0,
        healers: 0,
        mindControllers: 0,
        statusSources: 0,
        areaAttackers: 0,
        doubleAttackers: 0,
        buffers: 0,
        averageLevel: roster.reduce((sum, unit) => sum + unit.level, 0) / Math.max(1, roster.length),
    };
    roster.forEach((unit, index) => {
        const info = creatureInfo(ids[index]);
        if (!info) return;
        out.ranged += Number(info.ranged);
        out.flyers += Number(info.canFly);
        out.groundMelee += Number(!info.ranged && !info.canFly);
        out.large += Number(unit.size > 1);
        out.healers += Number(includesAny(info.abilities, ["heal", "resurrect", "revive"]));
        out.mindControllers += Number(includesAny(info.abilities, ["mind", "madness", "coward", "blind"]));
        out.statusSources += Number(
            includesAny(info.abilities, ["stun", "slow", "petr", "break", "wound", "weak", "blind"]),
        );
        out.areaAttackers += Number(
            includesAny(info.abilities, ["area", "through shot", "large caliber", "chain", "splash", "spin"]),
        );
        out.doubleAttackers += Number(includesAny(info.abilities, ["double", "second attack", "rapid"]));
        out.buffers += Number(info.castsAmplifiableBuff);
    });
    return out;
}

function acceptsArchetype(archetype: AiMetaArchetype, roster: readonly IArmyUnitSpec[]): boolean {
    if (archetype === "ranked" || archetype === "uniform") return true;
    const features = armyFeatures(roster);
    if (archetype === "ranged") return features.ranged >= 2 && features.ranged <= 4;
    if (archetype === "melee") return features.ranged === 0 && features.groundMelee >= 4;
    if (archetype === "flyer") return features.flyers >= 2;
    return features.casters + features.meleeMagic >= 2;
}

function sampleRoster(rng: () => number, excluded: ReadonlySet<string> = new Set()): IArmyUnitSpec[] {
    const roster: IArmyUnitSpec[] = [];
    const used = new Set(excluded);
    for (const { level, count } of DEFAULT_ROSTER_COMPOSITION) {
        const pool = (creaturesByLevel(level) as ICatalogEntry[]).filter((entry) => !used.has(entry.creatureName));
        if (pool.length < count) {
            throw new Error(`Not enough level-${level} creatures after exclusions`);
        }
        for (let slot = 0; slot < count; slot += 1) {
            const available = pool.filter((entry) => !used.has(entry.creatureName));
            const pick = available[Math.floor(rng() * available.length)];
            used.add(pick.creatureName);
            roster.push({
                faction: pick.faction,
                creatureName: pick.creatureName,
                level: pick.level,
                size: pick.size,
                amount: resolveStackAmount(pick.creatureName, pick.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
            });
        }
    }
    return roster;
}

function generateSyntheticRoster(
    archetype: Exclude<AiMetaArchetype, "ranked">,
    seed: number,
    excluded: ReadonlySet<string>,
): IArmyUnitSpec[] {
    for (let attempt = 0; attempt < 20_000; attempt += 1) {
        const rng = makeRng(hashSimulationParts("ai-meta-roster", seed, archetype, attempt));
        const roster = sampleRoster(rng, excluded);
        if (acceptsArchetype(archetype, roster)) return roster;
    }
    throw new Error(`Unable to generate ${archetype} roster from seed ${seed}`);
}

function generateRankedRoster(seed: number, excluded: ReadonlySet<string>): IArmyUnitSpec[] {
    for (let attempt = 0; attempt < 20_000; attempt += 1) {
        const offerSeed = hashSimulationParts("ai-meta-ranked-roster", seed, attempt);
        const roster = draftRoster(
            DEFAULT_DRAFT_W,
            offerSeed,
            DEFAULT_ROSTER_COMPOSITION,
            DEFAULT_AMOUNT_BY_LEVEL,
            6,
            "expBudget",
        );
        if (roster.every((unit) => !excluded.has(unit.creatureName))) return roster;
    }
    throw new Error(`Unable to generate non-overlapping ranked roster from seed ${seed}`);
}

const CROSS_ARCHETYPES = ["ranged", "melee", "flyer", "caster"] as const;
const CROSS_ORDERED_MATCHUPS = CROSS_ARCHETYPES.flatMap((left) =>
    CROSS_ARCHETYPES.filter((right) => right !== left).map((right) => [left, right] as const),
);

export function cohortArchetypes(cohort: AiMetaCohort, pair: number): [AiMetaArchetype, AiMetaArchetype] {
    if (cohort === "ranked-draft") return ["ranked", "ranked"];
    if (cohort === "uniform-mixed") return ["uniform", "uniform"];
    if (cohort === "ranged-heavy") return ["ranged", "ranged"];
    if (cohort === "ground-melee") return ["melee", "melee"];
    if (cohort === "flyer-heavy") return ["flyer", "flyer"];
    if (cohort === "caster-support") return ["caster", "caster"];
    return [...CROSS_ORDERED_MATCHUPS[pair % CROSS_ORDERED_MATCHUPS.length]];
}

export function cohortMap(cohort: AiMetaCohort, pair: number): AiMetaMap {
    if (cohort !== "cross-archetype") return AI_META_MAPS[pair % AI_META_MAPS.length];

    // Rotate every ordered matchup through every map. Adding the matchup index keeps
    // each complete 12-matchup block exactly balanced across the live maps.
    const matchupIndex = pair % CROSS_ORDERED_MATCHUPS.length;
    const block = Math.floor(pair / CROSS_ORDERED_MATCHUPS.length);
    return AI_META_MAPS[(block + matchupIndex) % AI_META_MAPS.length];
}

/** Build two globally creature-exclusive armies. Every resulting battle is therefore strictly non-mirrored. */
export function generateMetaMatchup(options: IAiMetaRunOptions, pair: number): IGeneratedMatchup {
    if (!Number.isInteger(pair) || pair < 0 || pair >= options.games / AI_META_GAMES_PER_MATCHUP) {
        throw new RangeError(`pair ${pair} is outside this ${options.games}-game cohort`);
    }
    const setupSeed = hashSimulationParts("ai-meta-setup", options.baseSeed, options.cohort, pair);
    const combatSeed = hashSimulationParts("ai-meta-combat", options.baseSeed, options.cohort, pair);
    const map = cohortMap(options.cohort, pair);
    const [archetypeA, archetypeB] = cohortArchetypes(options.cohort, pair);
    const rosterA =
        archetypeA === "ranked"
            ? generateRankedRoster(hashSimulationParts(setupSeed, "a"), new Set())
            : generateSyntheticRoster(archetypeA, hashSimulationParts(setupSeed, "a"), new Set());
    const excluded = new Set(rosterA.map((unit) => unit.creatureName));
    const rosterB =
        archetypeB === "ranked"
            ? generateRankedRoster(hashSimulationParts(setupSeed, "b"), excluded)
            : generateSyntheticRoster(archetypeB, hashSimulationParts(setupSeed, "b"), excluded);
    if (!rostersAreStrictlyDistinct(rosterA, rosterB)) {
        throw new Error(`Generated mirrored/overlapping rosters for ${options.cohort} pair ${pair}`);
    }
    return { setupSeed, combatSeed, map, archetypeA, archetypeB, rosterA, rosterB };
}

function tier1ContextScore(id: number, own: IAiMetaArmyFeatures, opponent: IAiMetaArmyFeatures): number {
    const ownRanged = fraction(own.ranged, own.total);
    const ownFlyers = fraction(own.flyers, own.total);
    const ownGround = fraction(own.groundMelee, own.total);
    const opponentRanged = fraction(opponent.ranged, opponent.total);
    const opponentGround = fraction(opponent.groundMelee, opponent.total);
    const base = TIER1_ARTIFACT_WINRATE[id] ?? 50;
    switch (id) {
        case Tier1Artifact.VETERAN_HELM:
            return base + 5 * (opponentGround + opponentRanged);
        case Tier1Artifact.AMULET_OF_RESOLVE:
            return base + 8 * fraction(opponent.statusSources, opponent.total);
        case Tier1Artifact.KEEN_BLADE:
            return base + 3 * ownGround;
        case Tier1Artifact.IRON_PLATE:
            return base + 7 * (0.5 + opponentRanged);
        case Tier1Artifact.SWIFT_BOOTS:
            return base + 22 * ownGround * (0.6 + opponentRanged);
        case Tier1Artifact.WINGED_BOOTS:
            return base + 22 * ownFlyers * (0.6 + opponentRanged);
        case Tier1Artifact.DUAL_STRIKE_CHARM:
            return base + 24 * fraction(own.doubleAttackers, own.total);
        case Tier1Artifact.WOUNDING_CHARM:
            return base + 4 * (opponent.averageLevel / 4);
        case Tier1Artifact.CURSED_WARD:
            return base;
        case Tier1Artifact.HUNTERS_LONGBOW:
            return base + 36 * ownRanged + (own.ranged >= 3 ? 8 : 0);
        case Tier1Artifact.HELM_OF_FOCUS:
            return base + 18 * fraction(opponent.mindControllers, opponent.total);
        case Tier1Artifact.BROKEN_AEGIS:
            return base + 8 * fraction(opponent.auraCarriers + opponent.buffers, opponent.total);
        default:
            return base;
    }
}

function tier2ContextScore(
    id: number,
    own: IAiMetaArmyFeatures,
    opponent: IAiMetaArmyFeatures,
    map: AiMetaRecordedMap,
): number {
    const ownRanged = fraction(own.ranged, own.total);
    const ownGround = fraction(own.groundMelee, own.total);
    const opponentRanged = fraction(opponent.ranged, opponent.total);
    const opponentGround = fraction(opponent.groundMelee, opponent.total);
    // Tome's measured 68.8 baseline came from its former augment amplification. Keep the new mechanic neutral
    // until it is remeasured, then add only the roster's actual castable-buff signal below.
    const base = id === Tier2Artifact.TOME_OF_AMPLIFICATION ? 50 : (TIER2_ARTIFACT_WINRATE[id] ?? 50);
    switch (id) {
        case Tier2Artifact.WARLORDS_EDGE:
            return base + 3 * ownGround;
        case Tier2Artifact.TITAN_PLATE:
            return base + 7 * (0.5 + opponentRanged);
        case Tier2Artifact.HOLY_CROSS:
            return base + 32 * fraction(own.healers, own.total);
        case Tier2Artifact.CLOVER_OF_FORTUNE:
            return base;
        case Tier2Artifact.CROWN_OF_COMMAND:
            return base + 24 * ownGround * (0.5 + opponentRanged);
        case Tier2Artifact.GIANTS_MAUL:
            return base + 34 * fraction(own.areaAttackers, own.total);
        case Tier2Artifact.PENDANT_OF_VITALITY:
            return base + 5 * (opponent.averageLevel / 4);
        case Tier2Artifact.FARSIGHT_QUIVER:
            return base + 48 * ownRanged;
        case Tier2Artifact.BERSERKERS_BOND:
            return base + 4 * ownGround;
        case Tier2Artifact.TOME_OF_AMPLIFICATION:
            return base + 15 * fraction(own.buffers, own.total);
        case Tier2Artifact.RIME_CHARM:
            return base + 13 * opponentGround;
        case Tier2Artifact.LAVA_STRIDERS:
            return base + (map === PBTypes.GridVals.LAVA_CENTER ? 48 : 0);
        default:
            return base;
    }
}

function chooseArtifact(
    tier: 1 | 2,
    own: IAiMetaArmyFeatures,
    opponent: IAiMetaArmyFeatures,
    map: AiMetaRecordedMap,
    rng: () => number,
): IAiMetaArtifactChoice {
    const ids = tier === 1 ? TIER1_IDS : TIER2_IDS;
    const score = (id: number): number =>
        tier === 1 ? tier1ContextScore(id, own, opponent) : tier2ContextScore(id, own, opponent, map);
    if (rng() < AI_META_EXPLORATION_RATE) {
        const id = ids[Math.floor(rng() * ids.length)];
        return {
            id,
            mode: "explore",
            propensity: AI_META_EXPLORATION_RATE / ids.length,
            contextualScore: score(id),
        };
    }
    let id = ids[0];
    let bestScore = -Infinity;
    for (const candidate of ids) {
        const candidateScore = score(candidate);
        if (candidateScore > bestScore || (candidateScore === bestScore && candidate < id)) {
            id = candidate;
            bestScore = candidateScore;
        }
    }
    return {
        id,
        mode: "exploit",
        propensity: 1 - AI_META_EXPLORATION_RATE + AI_META_EXPLORATION_RATE / ids.length,
        contextualScore: bestScore,
    };
}

export function augmentContextScore(
    plan: Readonly<IAugmentPlan>,
    own: IAiMetaArmyFeatures,
    opponent: IAiMetaArmyFeatures,
): number {
    const ownRanged = fraction(own.ranged, own.total);
    const ownGround = fraction(own.groundMelee, own.total);
    const opponentRanged = fraction(opponent.ranged, opponent.total);
    const opponentGround = fraction(opponent.groundMelee, opponent.total);
    const armor = getArmorPower(plan.armor) * (0.7 + 0.2 * opponentRanged + 0.1 * opponentGround);
    const might = getMightPower(plan.might) * (0.15 + ownGround);
    const [sniperAttack, sniperDistance] = getSniperPower(plan.sniper);
    const sniper = (sniperAttack + sniperDistance * 0.16) * ownRanged;
    const movement = getMovementPower(plan.movement) * 11 * ownGround * (0.55 + opponentRanged);
    const placement = plan.placement * 6 * (ownRanged + fraction(own.large, own.total));
    return armor + might + sniper + movement + placement;
}

function chooseAugments(
    own: IAiMetaArmyFeatures,
    opponent: IAiMetaArmyFeatures,
    rng: () => number,
): IAiMetaAugmentChoice {
    if (rng() < AI_META_EXPLORATION_RATE) {
        const plan = FULL_AUGMENT_PLANS[Math.floor(rng() * FULL_AUGMENT_PLANS.length)];
        return {
            plan: { ...plan },
            planId: augmentPlanId(plan),
            augments: setupAugmentsForPlan(plan),
            mode: "explore",
            propensity: AI_META_EXPLORATION_RATE / FULL_AUGMENT_PLANS.length,
            contextualScore: augmentContextScore(plan, own, opponent),
        };
    }
    let plan = FULL_AUGMENT_PLANS[0];
    let bestScore = -Infinity;
    for (const candidate of FULL_AUGMENT_PLANS) {
        const score = augmentContextScore(candidate, own, opponent);
        const candidateId = augmentPlanId(candidate);
        if (score > bestScore || (score === bestScore && candidateId < augmentPlanId(plan))) {
            plan = candidate;
            bestScore = score;
        }
    }
    return {
        plan: { ...plan },
        planId: augmentPlanId(plan),
        augments: setupAugmentsForPlan(plan),
        mode: "exploit",
        propensity: 1 - AI_META_EXPLORATION_RATE + AI_META_EXPLORATION_RATE / FULL_AUGMENT_PLANS.length,
        contextualScore: bestScore,
    };
}

export function chooseMetaArmy(
    archetype: AiMetaArchetype,
    roster: IArmyUnitSpec[],
    opponentRoster: readonly IArmyUnitSpec[],
    map: AiMetaRecordedMap,
    seed: number,
): IAiMetaArmy {
    const creatureIds = creatureIdsForRoster(roster);
    const features = armyFeatures(roster);
    const opponent = armyFeatures(opponentRoster);
    const artifactT1 = chooseArtifact(1, features, opponent, map, makeRng(hashSimulationParts(seed, "t1")));
    const artifactT2 = chooseArtifact(2, features, opponent, map, makeRng(hashSimulationParts(seed, "t2")));
    const augment = chooseAugments(features, opponent, makeRng(hashSimulationParts(seed, "augment")));
    return {
        archetype,
        roster,
        creatureIds,
        features,
        setupCohort: setupCohort(creatureIds),
        artifactT1,
        artifactT2,
        augment,
        perk: Perk.SEE_NONE,
        synergies: SETUP_POLICY_V0.pickSynergies(creatureIds),
    };
}

export function prepareMetaPair(options: IAiMetaRunOptions, pair: number): Omit<IAiMetaPairRecord, "games"> {
    const matchup = generateMetaMatchup(options, pair);
    return {
        schemaVersion: AI_META_SCHEMA_VERSION,
        cohort: options.cohort,
        pair,
        setupSeed: matchup.setupSeed,
        combatSeed: matchup.combatSeed,
        map: matchup.map,
        armyA: chooseMetaArmy(
            matchup.archetypeA,
            matchup.rosterA,
            matchup.rosterB,
            matchup.map,
            hashSimulationParts(matchup.setupSeed, "a"),
        ),
        armyB: chooseMetaArmy(
            matchup.archetypeB,
            matchup.rosterB,
            matchup.rosterA,
            matchup.map,
            hashSimulationParts(matchup.setupSeed, "b"),
        ),
    };
}

export function artifactName(tier: 1 | 2, id: number): string {
    const list = tier === 1 ? TIER1_ARTIFACT_LIST : TIER2_ARTIFACT_LIST;
    return list.find((artifact) => artifact.id === id)?.name ?? `Artifact ${id}`;
}

export function artifactImageKey(tier: 1 | 2, id: number): string {
    const list = tier === 1 ? TIER1_ARTIFACT_LIST : TIER2_ARTIFACT_LIST;
    return list.find((artifact) => artifact.id === id)?.imageKey ?? "";
}

export function allAugmentPlans(): readonly IAugmentPlan[] {
    return FULL_AUGMENT_PLANS;
}
