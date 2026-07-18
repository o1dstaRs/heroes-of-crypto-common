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

import CREATURES_JSON from "../../configuration/creatures.json";
import { Tier2Artifact } from "../../artifacts/artifact_properties";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { creatureInfo } from "./creature_score";
import {
    CONDITIONAL_SETUP_RULES,
    SETUP_CONDITIONAL_VERSION,
    conditionalArtifactT2,
    conditionalAugments,
    conditionalSynergies,
    parseConditionalRules,
    TIER2_ARTIFACT_WINRATE_MELEE,
    TIER2_ARTIFACT_WINRATE_RANGED,
    type ConditionalSetupRule,
} from "./setup_conditional";
import frozenV07NonFightArtifact from "./setup_policies/v07_nonfight_4eda84635fe7.json";
import { TIER2_ARTIFACT_WINRATE, type ISetupDecisionContext } from "./setup_strategy";
import { SETUP_POLICY_V0 } from "./setup_v0";
import { pickSynergiesSituational, SYNERGY_ANCHOR_W, SYNERGY_OPTIONS } from "./synergy_score";

/**
 * Browser-safe setup-policy ship seam. The optimizer and authoritative server consume these same pure
 * classifiers and resolvers, so a frozen research policy cannot be reimplemented differently in production.
 */

export const SETUP_OPTIMIZED_BUDGET = 7;

export const SETUP_COHORTS = [
    "ranged-4plus",
    "ranged-2to3",
    "ranged-1",
    "melee-magic",
    "mage",
    "aura-heavy",
    "melee-other",
] as const;
export type SetupCohort = (typeof SETUP_COHORTS)[number];

export interface ISetupRosterFeatures {
    total: number;
    ranged: number;
    mage: number;
    meleeMagic: number;
    flyers: number;
    auraCarriers: number;
}

type CreatureJson = Record<string, Record<string, { attack_type?: string } | undefined> | undefined>;

let attackTypeByName: Map<string, string> | undefined;

function creatureAttackType(name: string): string {
    if (!attackTypeByName) {
        attackTypeByName = new Map();
        for (const faction of Object.values(CREATURES_JSON as unknown as CreatureJson)) {
            for (const [creatureName, config] of Object.entries(faction ?? {})) {
                attackTypeByName.set(creatureName, config?.attack_type ?? "");
            }
        }
    }
    return attackTypeByName.get(name) ?? "";
}

export function setupRosterFeatures(creatureIds: readonly number[]): ISetupRosterFeatures {
    const features: ISetupRosterFeatures = {
        total: 0,
        ranged: 0,
        mage: 0,
        meleeMagic: 0,
        flyers: 0,
        auraCarriers: 0,
    };
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        if (!info) continue;
        features.total += 1;
        features.ranged += Number(info.ranged);
        features.flyers += Number(info.canFly);
        features.auraCarriers += Number(info.auraCount > 0);
        const attackType = creatureAttackType(info.name);
        features.mage += Number(attackType === "MAGIC");
        features.meleeMagic += Number(attackType === "MELEE_MAGIC");
    }
    return features;
}

export function setupCohort(creatureIds: readonly number[]): SetupCohort {
    const features = setupRosterFeatures(creatureIds);
    if (features.ranged >= 4) return "ranged-4plus";
    if (features.ranged >= 2) return "ranged-2to3";
    if (features.ranged === 1) return "ranged-1";
    if (features.meleeMagic > 0) return "melee-magic";
    if (features.mage > 0) return "mage";
    if (features.auraCarriers > 0) return "aura-heavy";
    return "melee-other";
}

export interface IAugmentPlan {
    /** Placement uses its wire levels 0/1/2; 0 is the free default 3-wide zone. */
    placement: number;
    armor: number;
    might: number;
    sniper: number;
    movement: number;
}

export interface ISetupAugmentChoice {
    kind: "Placement" | "Armor" | "Might" | "Sniper" | "Movement";
    value: number;
}

export interface ISetupSynergyChoice {
    faction: number;
    synergy: number;
}

const AUGMENT_CAPS: Readonly<IAugmentPlan> = { placement: 2, armor: 3, might: 3, sniper: 3, movement: 2 };

export function augmentPlanCost(plan: Readonly<IAugmentPlan>): number {
    return plan.placement + plan.armor + plan.might + plan.sniper + plan.movement;
}

export function assertAugmentPlan(plan: Readonly<IAugmentPlan>, budget: number = SETUP_OPTIMIZED_BUDGET): void {
    for (const key of Object.keys(AUGMENT_CAPS) as (keyof IAugmentPlan)[]) {
        const value = plan[key];
        if (!Number.isInteger(value) || value < 0 || value > AUGMENT_CAPS[key]) {
            throw new RangeError(`${key}=${value} is outside [0, ${AUGMENT_CAPS[key]}]`);
        }
    }
    if (augmentPlanCost(plan) > budget) {
        throw new RangeError(`augment plan costs ${augmentPlanCost(plan)} but budget is ${budget}`);
    }
}

export function augmentPlanId(plan: Readonly<IAugmentPlan>): string {
    assertAugmentPlan(plan);
    return `P${plan.placement}-A${plan.armor}-M${plan.might}-S${plan.sniper}-V${plan.movement}`;
}

/** All 96 legal full-spend SEE_NONE plans searched by the setup optimizer. */
export function enumerateFullBudgetAugmentPlans(budget: number = SETUP_OPTIMIZED_BUDGET): IAugmentPlan[] {
    if (!Number.isInteger(budget) || budget < 0) throw new RangeError("budget must be a non-negative integer");
    const plans: IAugmentPlan[] = [];
    for (let placement = 0; placement <= AUGMENT_CAPS.placement; placement += 1) {
        for (let armor = 0; armor <= AUGMENT_CAPS.armor; armor += 1) {
            for (let might = 0; might <= AUGMENT_CAPS.might; might += 1) {
                for (let sniper = 0; sniper <= AUGMENT_CAPS.sniper; sniper += 1) {
                    for (let movement = 0; movement <= AUGMENT_CAPS.movement; movement += 1) {
                        const plan = { placement, armor, might, sniper, movement };
                        if (augmentPlanCost(plan) === budget) plans.push(plan);
                    }
                }
            }
        }
    }
    return plans.sort((left, right) => augmentPlanId(left).localeCompare(augmentPlanId(right)));
}

export function setupAugmentsForPlan(plan: Readonly<IAugmentPlan>): ISetupAugmentChoice[] {
    assertAugmentPlan(plan);
    const augments: ISetupAugmentChoice[] = [];
    if (plan.placement > 0) augments.push({ kind: "Placement", value: plan.placement });
    if (plan.armor > 0) augments.push({ kind: "Armor", value: plan.armor });
    if (plan.might > 0) augments.push({ kind: "Might", value: plan.might });
    if (plan.sniper > 0) augments.push({ kind: "Sniper", value: plan.sniper });
    if (plan.movement > 0) augments.push({ kind: "Movement", value: plan.movement });
    return augments;
}

const CONDITIONAL_ALL = parseConditionalRules("all");

export function shippedAugmentPlan(creatureIds: readonly number[]): IAugmentPlan {
    const plan: IAugmentPlan = { placement: 0, armor: 0, might: 0, sniper: 0, movement: 0 };
    for (const augment of conditionalAugments(SETUP_OPTIMIZED_BUDGET, creatureIds, CONDITIONAL_ALL)) {
        const key = augment.kind.toLowerCase() as "armor" | "might" | "sniper" | "movement";
        plan[key] = augment.value;
    }
    return plan;
}

export type T2PolicyVariant = "baseline" | "blind" | "melee-table" | "ranged-table" | `promote:${number}`;

export const T2_POLICY_VARIANTS: readonly T2PolicyVariant[] = [
    "baseline",
    "blind",
    "melee-table",
    "ranged-table",
    ...Array.from({ length: 12 }, (_, index) => `promote:${index + 1}` as const),
];

const bestFromTable = (offered: readonly number[], table: Readonly<Record<number, number>>): number | undefined => {
    let best: number | undefined;
    let score = -Infinity;
    for (const artifact of offered) {
        const candidate = table[artifact];
        if (candidate !== undefined && candidate > score) {
            score = candidate;
            best = artifact;
        }
    }
    return best;
};

export function pickTier2ForVariant(
    offered: readonly number[],
    creatureIds: readonly number[],
    variant: T2PolicyVariant,
): number {
    if (!offered.length) return Tier2Artifact.NO_ARTIFACT;
    const baseline = conditionalArtifactT2(offered, creatureIds, CONDITIONAL_ALL);
    if (variant === "baseline") return baseline;
    if (variant === "blind") return bestFromTable(offered, TIER2_ARTIFACT_WINRATE) ?? baseline;
    if (variant === "melee-table") return bestFromTable(offered, TIER2_ARTIFACT_WINRATE_MELEE) ?? baseline;
    if (variant === "ranged-table") return bestFromTable(offered, TIER2_ARTIFACT_WINRATE_RANGED) ?? baseline;
    const promoted = Number(variant.slice("promote:".length));
    return Number.isInteger(promoted) && offered.includes(promoted) ? promoted : baseline;
}

export const SYNERGY_POLICY_VARIANTS = [
    "baseline",
    "beneficiary",
    "beneficiary-with-anchor",
    "flip-life",
    "flip-chaos",
    "flip-might",
    "flip-nature",
] as const;
export type SynergyPolicyVariant = (typeof SYNERGY_POLICY_VARIANTS)[number];

function synergyWeights(variant: SynergyPolicyVariant): number[] {
    if (variant === "baseline") return [...SYNERGY_ANCHOR_W];
    if (variant === "beneficiary" || variant === "beneficiary-with-anchor") {
        return SYNERGY_OPTIONS.flatMap((option) => [
            variant === "beneficiary-with-anchor" && option.tablePick ? 0.25 : 0,
            1,
        ]);
    }
    const factionName = variant.slice("flip-".length);
    const factionByLabel: Record<string, number> = {
        life: PBTypes.FactionVals.LIFE,
        chaos: PBTypes.FactionVals.CHAOS,
        might: PBTypes.FactionVals.MIGHT,
        nature: PBTypes.FactionVals.NATURE,
    };
    const faction = factionByLabel[factionName];
    return SYNERGY_OPTIONS.flatMap((option) => {
        if (option.faction !== faction) return [option.tablePick ? 1 : 0, 0];
        return [option.tablePick ? 0 : 1, 0];
    });
}

export function pickSynergiesForVariant(
    creatureIds: readonly number[],
    variant: SynergyPolicyVariant,
): ISetupSynergyChoice[] {
    return pickSynergiesSituational(creatureIds, synergyWeights(variant));
}

export type PlacementPolicyVariant = "baseline" | "legitimate-reveal" | "public-roster";
export type PlacementAugmentTiming = "current-live" | "setup-before-placement";

export interface ISetupPolicyBehavior {
    augmentsByCohort: Record<SetupCohort, IAugmentPlan>;
    tier2ByCohort: Record<SetupCohort, T2PolicyVariant>;
    synergy: SynergyPolicyVariant;
    placement: PlacementPolicyVariant;
    placementAugmentTiming: PlacementAugmentTiming;
}

export interface INonFightCandidatePolicy extends ISetupPolicyBehavior {
    id: string;
}

export function shippedNonFightPolicy(id: string = "shipped-round1-conditional-all"): INonFightCandidatePolicy {
    const augmentsByCohort = {} as Record<SetupCohort, IAugmentPlan>;
    const tier2ByCohort = {} as Record<SetupCohort, T2PolicyVariant>;
    for (const cohort of SETUP_COHORTS) {
        const ranged = cohort === "ranged-4plus" || cohort === "ranged-2to3";
        augmentsByCohort[cohort] = ranged
            ? { placement: 0, armor: 3, might: 1, sniper: 3, movement: 0 }
            : { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 };
        tier2ByCohort[cohort] = "baseline";
    }
    return {
        id,
        augmentsByCohort,
        tier2ByCohort,
        synergy: "baseline",
        placement: "baseline",
        placementAugmentTiming: "setup-before-placement",
    };
}

export function cloneNonFightPolicy(policy: Readonly<INonFightCandidatePolicy>): INonFightCandidatePolicy {
    return {
        ...policy,
        augmentsByCohort: Object.fromEntries(
            SETUP_COHORTS.map((cohort) => [cohort, { ...policy.augmentsByCohort[cohort] }]),
        ) as Record<SetupCohort, IAugmentPlan>,
        tier2ByCohort: { ...policy.tier2ByCohort },
    };
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown, label: string): UnknownRecord => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as UnknownRecord;
};

const assertExactKeys = (value: UnknownRecord, expected: readonly string[], label: string): void => {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new TypeError(`${label} keys must be exactly ${wanted.join(",")}; received ${actual.join(",")}`);
    }
};

const parseAugmentPlan = (value: unknown, label: string): IAugmentPlan => {
    const record = asRecord(value, label);
    const keys = ["placement", "armor", "might", "sniper", "movement"] as const;
    assertExactKeys(record, keys, label);
    const plan = Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as IAugmentPlan;
    assertAugmentPlan(plan);
    if (augmentPlanCost(plan) !== SETUP_OPTIMIZED_BUDGET) {
        throw new RangeError(`${label} must spend exactly ${SETUP_OPTIMIZED_BUDGET} points`);
    }
    return { ...plan };
};

const parseT2Variant = (value: unknown, label: string): T2PolicyVariant => {
    if (typeof value !== "string" || !T2_POLICY_VARIANTS.includes(value as T2PolicyVariant)) {
        throw new TypeError(`${label} has unknown Tier-2 variant ${String(value)}`);
    }
    return value as T2PolicyVariant;
};

export function parseSetupPolicyBehavior(value: unknown): ISetupPolicyBehavior {
    const record = asRecord(value, "setup policy");
    assertExactKeys(
        record,
        ["augmentsByCohort", "tier2ByCohort", "synergy", "placement", "placementAugmentTiming"],
        "setup policy",
    );
    const augmentRecord = asRecord(record.augmentsByCohort, "setup policy augmentsByCohort");
    const tier2Record = asRecord(record.tier2ByCohort, "setup policy tier2ByCohort");
    assertExactKeys(augmentRecord, SETUP_COHORTS, "setup policy augmentsByCohort");
    assertExactKeys(tier2Record, SETUP_COHORTS, "setup policy tier2ByCohort");
    if (!SYNERGY_POLICY_VARIANTS.includes(record.synergy as SynergyPolicyVariant)) {
        throw new TypeError(`setup policy has unknown synergy variant ${String(record.synergy)}`);
    }
    if (
        record.placement !== "baseline" &&
        record.placement !== "legitimate-reveal" &&
        record.placement !== "public-roster"
    ) {
        throw new TypeError(`setup policy has unknown placement variant ${String(record.placement)}`);
    }
    if (record.placementAugmentTiming !== "setup-before-placement") {
        throw new TypeError("a deployable setup policy must use setup-before-placement");
    }
    return {
        augmentsByCohort: Object.fromEntries(
            SETUP_COHORTS.map((cohort) => [cohort, parseAugmentPlan(augmentRecord[cohort], `augment ${cohort}`)]),
        ) as Record<SetupCohort, IAugmentPlan>,
        tier2ByCohort: Object.fromEntries(
            SETUP_COHORTS.map((cohort) => [cohort, parseT2Variant(tier2Record[cohort], `Tier-2 ${cohort}`)]),
        ) as Record<SetupCohort, T2PolicyVariant>,
        synergy: record.synergy as SynergyPolicyVariant,
        placement: record.placement,
        placementAugmentTiming: record.placementAugmentTiming,
    };
}

const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        const record = value as UnknownRecord;
        return Object.fromEntries(
            Object.keys(record)
                .sort()
                .map((key) => [key, canonicalValue(record[key])]),
        );
    }
    return value;
};

export function canonicalSetupPolicyBehavior(behavior: Readonly<ISetupPolicyBehavior>): string {
    return `${JSON.stringify(canonicalValue(behavior))}\n`;
}

const deepFreeze = <T>(value: T): Readonly<T> => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value as UnknownRecord)) deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
};

/**
 * Independent compiled copy of the only approved behavior. Keeping this separate from the JSON import makes
 * parseSetupPolicyArtifact a semantic boundary: a valid-looking policy cannot reuse the approved hash.
 */
const APPROVED_V07_NONFIGHT_BEHAVIOR = deepFreeze<ISetupPolicyBehavior>({
    augmentsByCohort: {
        "ranged-4plus": { placement: 0, armor: 3, might: 1, sniper: 3, movement: 0 },
        "ranged-2to3": { placement: 0, armor: 2, might: 2, sniper: 3, movement: 0 },
        "ranged-1": { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 },
        "melee-magic": { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
        mage: { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
        "aura-heavy": { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
        "melee-other": { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
    },
    tier2ByCohort: {
        "ranged-4plus": "baseline",
        "ranged-2to3": "promote:10",
        "ranged-1": "promote:1",
        "melee-magic": "baseline",
        mage: "baseline",
        "aura-heavy": "baseline",
        "melee-other": "promote:4",
    },
    synergy: "flip-chaos",
    placement: "legitimate-reveal",
    placementAugmentTiming: "setup-before-placement",
});
const APPROVED_V07_NONFIGHT_CANONICAL = canonicalSetupPolicyBehavior(APPROVED_V07_NONFIGHT_BEHAVIOR);

export const V07_NONFIGHT_SETUP_SPEC = "v07-nonfight-4eda84635fe7";
export const V07_NONFIGHT_BEHAVIOR_SHA256 = "4eda84635fe7e3e9054e1d8161328ce61d45719734adf16acf98006eb3f88f57";
export const CONDITIONAL_SETUP_V1_SPEC = "conditional-v1";
export const SETUP_V0_SPEC = "setup-v0";

export interface ISetupPolicyArtifact {
    schemaVersion: 1;
    spec: typeof V07_NONFIGHT_SETUP_SPEC;
    behaviorSha256: typeof V07_NONFIGHT_BEHAVIOR_SHA256;
    policy: ISetupPolicyBehavior;
}

export function parseSetupPolicyArtifact(value: unknown): Readonly<ISetupPolicyArtifact> {
    const record = asRecord(value, "setup policy artifact");
    assertExactKeys(record, ["schemaVersion", "spec", "behaviorSha256", "policy"], "setup policy artifact");
    if (record.schemaVersion !== 1)
        throw new TypeError(`unsupported setup policy schema ${String(record.schemaVersion)}`);
    if (record.spec !== V07_NONFIGHT_SETUP_SPEC)
        throw new TypeError(`unknown setup policy spec ${String(record.spec)}`);
    if (record.behaviorSha256 !== V07_NONFIGHT_BEHAVIOR_SHA256) {
        throw new TypeError(`unknown setup policy behavior hash ${String(record.behaviorSha256)}`);
    }
    const policy = parseSetupPolicyBehavior(record.policy);
    if (canonicalSetupPolicyBehavior(policy) !== APPROVED_V07_NONFIGHT_CANONICAL) {
        throw new TypeError(`setup policy behavior does not match approved spec ${V07_NONFIGHT_SETUP_SPEC}`);
    }
    return deepFreeze({
        schemaVersion: 1,
        spec: V07_NONFIGHT_SETUP_SPEC,
        behaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256,
        policy,
    });
}

export const V07_NONFIGHT_SETUP_ARTIFACT = parseSetupPolicyArtifact(frozenV07NonFightArtifact);

export type ResolvedSetupPolicyMode = "setup-v0" | "conditional-v1" | "optimized-v07";

export interface IResolvedSetupPolicy {
    readonly configured: boolean;
    readonly mode: ResolvedSetupPolicyMode;
    readonly spec: string;
    readonly journalVersion: string;
    /** Ordered, frozen view of active conditional fallback rules; decision closures retain a private Set. */
    readonly rules: readonly ConditionalSetupRule[];
    readonly placement: PlacementPolicyVariant;
    readonly placementAugmentTiming: "setup-before-placement";
    /** Own roster identities are deduplicated; context contains only the fair opponent/map view. */
    pickArtifactT2(
        offered: readonly number[],
        ownCreatureIds: readonly number[],
        context?: Readonly<ISetupDecisionContext>,
    ): number;
    /** Own roster identities are deduplicated; context contains only the fair opponent/map view. */
    pickAugments(
        budget: number,
        ownCreatureIds: readonly number[],
        context?: Readonly<ISetupDecisionContext>,
    ): ISetupAugmentChoice[];
    /** One entry per own physical stack; duplicate creature ids created by a legal split remain significant. */
    pickSynergies(
        ownCreatureStackIds: readonly number[],
        context?: Readonly<ISetupDecisionContext>,
    ): ISetupSynergyChoice[];
}

const behaviorFromCandidate = (policy: Readonly<INonFightCandidatePolicy>): ISetupPolicyBehavior => ({
    augmentsByCohort: policy.augmentsByCohort,
    tier2ByCohort: policy.tier2ByCohort,
    synergy: policy.synergy,
    placement: policy.placement,
    placementAugmentTiming: policy.placementAugmentTiming,
});

export function compileNonFightSetupPolicy(
    candidate: Readonly<INonFightCandidatePolicy> | Readonly<ISetupPolicyBehavior>,
    spec: string = "setup-candidate",
): IResolvedSetupPolicy {
    const behavior = parseSetupPolicyBehavior(
        "id" in candidate ? behaviorFromCandidate(candidate as Readonly<INonFightCandidatePolicy>) : candidate,
    );
    const fallbackRules = new Set(CONDITIONAL_SETUP_RULES);
    const exposedRules = Object.freeze([...CONDITIONAL_SETUP_RULES]);
    return Object.freeze({
        configured: true,
        mode: "optimized-v07" as const,
        spec,
        journalVersion: spec,
        rules: exposedRules,
        placement: behavior.placement,
        placementAugmentTiming: "setup-before-placement" as const,
        pickArtifactT2: (offered: readonly number[], ownCreatureIds: readonly number[]): number => {
            if (setupRosterFeatures(ownCreatureIds).total === 0) {
                return conditionalArtifactT2(offered, ownCreatureIds, fallbackRules);
            }
            const cohort = setupCohort(ownCreatureIds);
            return pickTier2ForVariant(offered, ownCreatureIds, behavior.tier2ByCohort[cohort]);
        },
        pickAugments: (budget: number, ownCreatureIds: readonly number[]): ISetupAugmentChoice[] => {
            if (budget !== SETUP_OPTIMIZED_BUDGET || setupRosterFeatures(ownCreatureIds).total === 0) {
                return conditionalAugments(budget, ownCreatureIds, fallbackRules);
            }
            return setupAugmentsForPlan(behavior.augmentsByCohort[setupCohort(ownCreatureIds)]);
        },
        pickSynergies: (ownCreatureIds: readonly number[]): ISetupSynergyChoice[] =>
            pickSynergiesForVariant(ownCreatureIds, behavior.synergy),
    });
}

const conditionalPolicy = (rules: ReadonlySet<ConditionalSetupRule>): IResolvedSetupPolicy => {
    const ruleSnapshot = new Set(rules);
    const enabled = CONDITIONAL_SETUP_RULES.filter((rule) => ruleSnapshot.has(rule));
    const exposedRules = Object.freeze([...enabled]);
    return Object.freeze({
        configured: enabled.length > 0,
        mode: enabled.length > 0 ? ("conditional-v1" as const) : ("setup-v0" as const),
        spec: enabled.length ? `${CONDITIONAL_SETUP_V1_SPEC}:${enabled.join("+")}` : SETUP_V0_SPEC,
        journalVersion: enabled.length ? `${SETUP_CONDITIONAL_VERSION}:${enabled.join("+")}` : "setup_v0",
        rules: exposedRules,
        placement: "baseline" as const,
        placementAugmentTiming: "setup-before-placement" as const,
        pickArtifactT2: (offered: readonly number[], ownCreatureIds: readonly number[]): number =>
            conditionalArtifactT2(offered, ownCreatureIds, ruleSnapshot),
        pickAugments: (budget: number, ownCreatureIds: readonly number[]): ISetupAugmentChoice[] =>
            conditionalAugments(budget, ownCreatureIds, ruleSnapshot),
        pickSynergies: (ownCreatureIds: readonly number[]): ISetupSynergyChoice[] =>
            conditionalSynergies(ownCreatureIds),
    });
};

const conditionalRulesForSpec = (normalized: string): ReadonlySet<ConditionalSetupRule> | undefined => {
    if ([CONDITIONAL_SETUP_V1_SPEC, SETUP_CONDITIONAL_VERSION, "on", "1", "all"].includes(normalized)) {
        return new Set(CONDITIONAL_SETUP_RULES);
    }
    const prefixed = [CONDITIONAL_SETUP_V1_SPEC, SETUP_CONDITIONAL_VERSION].find((prefix) =>
        normalized.startsWith(`${prefix}:`),
    );
    const ruleSpec = prefixed ? normalized.slice(prefixed.length + 1).replaceAll("+", ",") : normalized;
    const requested = ruleSpec.split(",").map((rule) => rule.trim());
    const known = new Set<string>(CONDITIONAL_SETUP_RULES);
    if (!requested.length || requested.some((rule) => !known.has(rule))) return undefined;
    return parseConditionalRules(ruleSpec);
};

/** Resolve an explicit setup spec. Undefined/blank remains setup-v0; the optimized artifact is opt-in only. */
export function resolveSetupPolicy(spec: string | undefined): IResolvedSetupPolicy {
    const normalized = (spec ?? "").trim().toLowerCase();
    if (!normalized || normalized === "off" || normalized === "0" || normalized === SETUP_V0_SPEC) {
        return conditionalPolicy(new Set());
    }
    if (normalized === V07_NONFIGHT_SETUP_SPEC) {
        return compileNonFightSetupPolicy(V07_NONFIGHT_SETUP_ARTIFACT.policy, V07_NONFIGHT_SETUP_SPEC);
    }
    const rules = conditionalRulesForSpec(normalized);
    if (rules) return conditionalPolicy(rules);
    throw new Error(
        `Invalid setup policy spec ${JSON.stringify(spec)}; expected ${V07_NONFIGHT_SETUP_SPEC}, ${CONDITIONAL_SETUP_V1_SPEC}, ${SETUP_V0_SPEC}, or conditional rule names`,
    );
}

/** Original setup-v0 choices, retained as an explicit semantic check for callers and tests. */
export const SETUP_POLICY_V0_RESOLVED: IResolvedSetupPolicy = Object.freeze({
    configured: false,
    mode: "setup-v0",
    spec: SETUP_V0_SPEC,
    journalVersion: "setup_v0",
    rules: Object.freeze([] as ConditionalSetupRule[]),
    placement: "baseline",
    placementAugmentTiming: "setup-before-placement",
    pickArtifactT2: (offered: readonly number[]) => SETUP_POLICY_V0.pickArtifactT2(offered),
    pickAugments: (budget: number) => SETUP_POLICY_V0.pickAugments(budget),
    pickSynergies: (ownCreatureIds: readonly number[]) => SETUP_POLICY_V0.pickSynergies(ownCreatureIds),
});
