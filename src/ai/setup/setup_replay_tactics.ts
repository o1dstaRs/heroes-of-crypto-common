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

import frozenReplayTacticsArtifact from "./setup_policies/ranked_replay_tactics_v1.json";
import { creatureInfo } from "./creature_score";

/**
 * Ranked replay tactics v1 distils the repeated setup choices from four human ranked games. Classification
 * deliberately consumes only the acting seat's creature identities: opponent picks, placement, stack sizes,
 * artifacts and augments cannot influence it.
 */

export const RANKED_REPLAY_TACTICS_SETUP_SPEC = "ranked-replay-tactics-v1";
export const RANKED_REPLAY_TACTICS_BASE_SPEC = "v07-nonfight-4eda84635fe7";
export const RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256 = "c0f246a501d0089b7f407ce0a5ccefd4d8db37a2e815d5969fede96f7b00aa90";
export const RANKED_REPLAY_TACTICS_BUDGET = 7;
export const REPLAY_RAPID_CHARGE_AUGMENT_PLAN = Object.freeze({
    placement: 1,
    armor: 1,
    might: 3,
    sniper: 0,
    movement: 2,
} satisfies IReplayTacticsAugmentPlan);

export const REPLAY_TACTICS_ARMY_IDENTITIES = [
    "ranged-battery",
    "fast-mobile-melee",
    "healer-durable-carry",
    "ordinary",
] as const;
export type ReplayTacticsArmyIdentity = (typeof REPLAY_TACTICS_ARMY_IDENTITIES)[number];

const REPLAY_TACTICS_CLASSIFIER_STAGES = [
    "ranged-battery",
    "rapid-charge-core",
    "healer-durable-carry",
    "broad-mobile-melee",
    "ordinary",
] as const;
type ReplayTacticsClassifierStage = (typeof REPLAY_TACTICS_CLASSIFIER_STAGES)[number];

export interface IReplayTacticsAugmentPlan {
    placement: number;
    armor: number;
    might: number;
    sniper: number;
    movement: number;
}

export interface IReplayTacticsClassifier {
    precedence: ReplayTacticsClassifierStage[];
    rangedBatteryMinRanged: number;
    rapidChargeAbility: string;
    rapidChargeMinMelee: number;
    broadMobileAbility: string;
    broadMobileMinSpeed: number;
    broadMobileMinMelee: number;
    healerName: string;
    durableCarryNames: string[];
}

export interface IReplayTacticsSetupBehavior {
    baseSpec: typeof RANKED_REPLAY_TACTICS_BASE_SPEC;
    classifier: IReplayTacticsClassifier;
    augmentPlansByIdentity: Record<ReplayTacticsArmyIdentity, IReplayTacticsAugmentPlan>;
}

export interface IReplayTacticsSetupArtifact {
    schemaVersion: 1;
    spec: typeof RANKED_REPLAY_TACTICS_SETUP_SPEC;
    behaviorSha256: typeof RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256;
    policy: IReplayTacticsSetupBehavior;
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

const parseStringArray = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry)) {
        throw new TypeError(`${label} must be a non-empty string array`);
    }
    return [...value];
};

const PLAN_CAPS: Readonly<IReplayTacticsAugmentPlan> = {
    placement: 2,
    armor: 3,
    might: 3,
    sniper: 3,
    movement: 2,
};

const parseAugmentPlan = (value: unknown, label: string): IReplayTacticsAugmentPlan => {
    const record = asRecord(value, label);
    const keys = ["placement", "armor", "might", "sniper", "movement"] as const;
    assertExactKeys(record, keys, label);
    const plan = Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as IReplayTacticsAugmentPlan;
    let cost = 0;
    for (const key of keys) {
        const amount = plan[key];
        if (!Number.isInteger(amount) || amount < 0 || amount > PLAN_CAPS[key]) {
            throw new RangeError(`${label}.${key}=${amount} is outside [0, ${PLAN_CAPS[key]}]`);
        }
        cost += amount;
    }
    if (cost !== RANKED_REPLAY_TACTICS_BUDGET) {
        throw new RangeError(`${label} must spend exactly ${RANKED_REPLAY_TACTICS_BUDGET} points`);
    }
    return { ...plan };
};

const parseClassifier = (value: unknown): IReplayTacticsClassifier => {
    const record = asRecord(value, "replay tactics classifier");
    assertExactKeys(
        record,
        [
            "precedence",
            "rangedBatteryMinRanged",
            "rapidChargeAbility",
            "rapidChargeMinMelee",
            "broadMobileAbility",
            "broadMobileMinSpeed",
            "broadMobileMinMelee",
            "healerName",
            "durableCarryNames",
        ],
        "replay tactics classifier",
    );
    const precedence = parseStringArray(record.precedence, "replay tactics classifier precedence");
    if (
        precedence.length !== REPLAY_TACTICS_CLASSIFIER_STAGES.length ||
        precedence.some((identity, index) => identity !== REPLAY_TACTICS_CLASSIFIER_STAGES[index])
    ) {
        throw new TypeError(
            `replay tactics classifier precedence must be ${REPLAY_TACTICS_CLASSIFIER_STAGES.join(",")}`,
        );
    }
    if (!Number.isInteger(record.rangedBatteryMinRanged) || (record.rangedBatteryMinRanged as number) < 1) {
        throw new TypeError("replay tactics rangedBatteryMinRanged must be a positive integer");
    }
    if (typeof record.rapidChargeAbility !== "string" || !record.rapidChargeAbility) {
        throw new TypeError("replay tactics rapidChargeAbility must be a non-empty string");
    }
    if (!Number.isInteger(record.rapidChargeMinMelee) || (record.rapidChargeMinMelee as number) < 1) {
        throw new TypeError("replay tactics rapidChargeMinMelee must be a positive integer");
    }
    if (typeof record.broadMobileAbility !== "string" || !record.broadMobileAbility) {
        throw new TypeError("replay tactics broadMobileAbility must be a non-empty string");
    }
    if (typeof record.broadMobileMinSpeed !== "number" || !Number.isFinite(record.broadMobileMinSpeed)) {
        throw new TypeError("replay tactics broadMobileMinSpeed must be a finite number");
    }
    if (!Number.isInteger(record.broadMobileMinMelee) || (record.broadMobileMinMelee as number) < 1) {
        throw new TypeError("replay tactics broadMobileMinMelee must be a positive integer");
    }
    if (typeof record.healerName !== "string" || !record.healerName) {
        throw new TypeError("replay tactics healerName must be a non-empty string");
    }
    return {
        precedence: precedence as ReplayTacticsClassifierStage[],
        rangedBatteryMinRanged: record.rangedBatteryMinRanged as number,
        rapidChargeAbility: record.rapidChargeAbility,
        rapidChargeMinMelee: record.rapidChargeMinMelee as number,
        broadMobileAbility: record.broadMobileAbility,
        broadMobileMinSpeed: record.broadMobileMinSpeed,
        broadMobileMinMelee: record.broadMobileMinMelee as number,
        healerName: record.healerName,
        durableCarryNames: parseStringArray(record.durableCarryNames, "replay tactics durableCarryNames"),
    };
};

const parseBehavior = (value: unknown): IReplayTacticsSetupBehavior => {
    const record = asRecord(value, "replay tactics setup policy");
    assertExactKeys(record, ["baseSpec", "classifier", "augmentPlansByIdentity"], "replay tactics setup policy");
    if (record.baseSpec !== RANKED_REPLAY_TACTICS_BASE_SPEC) {
        throw new TypeError(`replay tactics base spec must be ${RANKED_REPLAY_TACTICS_BASE_SPEC}`);
    }
    const plans = asRecord(record.augmentPlansByIdentity, "replay tactics augmentPlansByIdentity");
    assertExactKeys(plans, REPLAY_TACTICS_ARMY_IDENTITIES, "replay tactics augmentPlansByIdentity");
    return {
        baseSpec: RANKED_REPLAY_TACTICS_BASE_SPEC,
        classifier: parseClassifier(record.classifier),
        augmentPlansByIdentity: Object.fromEntries(
            REPLAY_TACTICS_ARMY_IDENTITIES.map((identity) => [
                identity,
                parseAugmentPlan(plans[identity], `replay tactics augment ${identity}`),
            ]),
        ) as Record<ReplayTacticsArmyIdentity, IReplayTacticsAugmentPlan>,
    };
};

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

export const canonicalReplayTacticsSetupBehavior = (behavior: Readonly<IReplayTacticsSetupBehavior>): string =>
    `${JSON.stringify(canonicalValue(behavior))}\n`;

const deepFreeze = <T>(value: T): Readonly<T> => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value as UnknownRecord)) deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
};

const APPROVED_REPLAY_TACTICS_BEHAVIOR = deepFreeze<IReplayTacticsSetupBehavior>({
    baseSpec: RANKED_REPLAY_TACTICS_BASE_SPEC,
    classifier: {
        precedence: [...REPLAY_TACTICS_CLASSIFIER_STAGES],
        rangedBatteryMinRanged: 2,
        rapidChargeAbility: "Rapid Charge",
        rapidChargeMinMelee: 2,
        broadMobileAbility: "Sky Runner",
        broadMobileMinSpeed: 7,
        broadMobileMinMelee: 4,
        healerName: "Healer",
        durableCarryNames: ["Abomination", "Frenzied Boar", "Goblin Knight", "Angel"],
    },
    augmentPlansByIdentity: {
        "ranged-battery": { placement: 2, armor: 2, might: 0, sniper: 3, movement: 0 },
        "fast-mobile-melee": { placement: 1, armor: 1, might: 3, sniper: 0, movement: 2 },
        "healer-durable-carry": { placement: 1, armor: 3, might: 2, sniper: 0, movement: 1 },
        ordinary: { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
    },
});
const APPROVED_REPLAY_TACTICS_CANONICAL = canonicalReplayTacticsSetupBehavior(APPROVED_REPLAY_TACTICS_BEHAVIOR);

export function parseReplayTacticsSetupArtifact(value: unknown): Readonly<IReplayTacticsSetupArtifact> {
    const record = asRecord(value, "replay tactics setup artifact");
    assertExactKeys(record, ["schemaVersion", "spec", "behaviorSha256", "policy"], "replay tactics setup artifact");
    if (record.schemaVersion !== 1) throw new TypeError(`unsupported replay tactics schema ${record.schemaVersion}`);
    if (record.spec !== RANKED_REPLAY_TACTICS_SETUP_SPEC) {
        throw new TypeError(`unknown replay tactics setup spec ${String(record.spec)}`);
    }
    if (record.behaviorSha256 !== RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256) {
        throw new TypeError(`unknown replay tactics behavior hash ${String(record.behaviorSha256)}`);
    }
    const policy = parseBehavior(record.policy);
    if (canonicalReplayTacticsSetupBehavior(policy) !== APPROVED_REPLAY_TACTICS_CANONICAL) {
        throw new TypeError(`replay tactics behavior does not match approved spec ${RANKED_REPLAY_TACTICS_SETUP_SPEC}`);
    }
    return deepFreeze({
        schemaVersion: 1,
        spec: RANKED_REPLAY_TACTICS_SETUP_SPEC,
        behaviorSha256: RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256,
        policy,
    });
}

export const RANKED_REPLAY_TACTICS_SETUP_ARTIFACT = parseReplayTacticsSetupArtifact(frozenReplayTacticsArtifact);

/** Classify a completed own roster using the frozen replay-tactics precedence. */
export function replayTacticsArmyIdentity(
    ownCreatureIds: readonly number[],
    behavior: Readonly<IReplayTacticsSetupBehavior> = RANKED_REPLAY_TACTICS_SETUP_ARTIFACT.policy,
): ReplayTacticsArmyIdentity {
    const own = [...new Set(ownCreatureIds)].map(creatureInfo).filter((info) => info !== undefined);
    if (own.filter((info) => info.ranged).length >= behavior.classifier.rangedBatteryMinRanged) {
        return "ranged-battery";
    }
    const rapidChargeCount = own.filter(
        (info) => info.melee && info.abilities.includes(behavior.classifier.rapidChargeAbility),
    ).length;
    if (rapidChargeCount >= behavior.classifier.rapidChargeMinMelee) {
        return "fast-mobile-melee";
    }
    const ownNames = new Set(own.map((info) => info.name));
    if (
        ownNames.has(behavior.classifier.healerName) &&
        behavior.classifier.durableCarryNames.some((name) => ownNames.has(name))
    ) {
        return "healer-durable-carry";
    }
    const broadMobileMeleeCount = own.filter(
        (info) =>
            info.melee &&
            (info.abilities.includes(behavior.classifier.rapidChargeAbility) ||
                info.canFly ||
                info.speed >= behavior.classifier.broadMobileMinSpeed ||
                info.abilities.includes(behavior.classifier.broadMobileAbility)),
    ).length;
    if (broadMobileMeleeCount >= behavior.classifier.broadMobileMinMelee) {
        return "fast-mobile-melee";
    }
    return "ordinary";
}

/**
 * Replay-supported charger core: a Wolf Rider or Champion paired with another distinct native charger.
 * Two-plus-ranged batteries keep the incumbent Sniper plan instead of trading it for a melee charge plan.
 */
export function replayRapidChargeCoreEligible(ownCreatureIds: readonly number[]): boolean {
    const own = [...new Set(ownCreatureIds)].map(creatureInfo).filter((info) => info !== undefined);
    const rapidChargers = own.filter((info) => info.abilities.includes("Rapid Charge"));
    return (
        rapidChargers.length >= 2 &&
        own.filter((info) => info.ranged).length < 2 &&
        rapidChargers.some((info) => info.name === "Wolf Rider" || info.name === "Champion")
    );
}

export function replayTacticsAugmentPlan(
    ownCreatureIds: readonly number[],
    behavior: Readonly<IReplayTacticsSetupBehavior> = RANKED_REPLAY_TACTICS_SETUP_ARTIFACT.policy,
): Readonly<IReplayTacticsAugmentPlan> {
    return behavior.augmentPlansByIdentity[replayTacticsArmyIdentity(ownCreatureIds, behavior)];
}
