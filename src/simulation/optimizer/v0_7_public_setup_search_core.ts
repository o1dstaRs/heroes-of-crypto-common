/*
 * -----------------------------------------------------------------------------
 * Research-only policy family and statistical gates for fair public-roster
 * augment/synergy search. Runtime policy wiring belongs in setup_ship only after
 * an untouched guard panel passes.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { PBTypes } from "../../generated/protobuf/v1/types";
import {
    assertAugmentPlan,
    augmentPlanId,
    compileNonFightSetupPolicy,
    setupAugmentsForPlan,
    setupCohort,
    setupRosterFeatures,
    SETUP_COHORTS,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    type IAugmentPlan,
    type ISetupAugmentChoice,
    type ISetupSynergyChoice,
    type SetupCohort,
} from "../../ai/setup/setup_ship";
import { SYNERGY_OPTIONS } from "../../ai/setup/synergy_score";
import {
    SETUP_LIVE_GRID_TYPES,
    setupLiveGridType,
    setupPanelSeed,
    type SetupLiveGridType,
    type SetupSeedPanel,
} from "./v0_7_setup_overnight_core";

export const PUBLIC_SETUP_OWN_GROUPS = ["ranged", "mage", "melee-magic", "aura-heavy", "melee-other"] as const;
export type PublicSetupOwnGroup = (typeof PUBLIC_SETUP_OWN_GROUPS)[number];
export const PUBLIC_SETUP_DIAGNOSTIC_TAGS = PUBLIC_SETUP_OWN_GROUPS;
export type PublicSetupDiagnosticTag = PublicSetupOwnGroup;

export const PUBLIC_SETUP_OPPONENT_SIGNALS = [
    "ranged-any",
    "ranged-2plus",
    "ranged-4plus",
    "magic-any",
    "flyers-2plus",
    "aura-any",
    "low-ranged",
] as const;
export type PublicSetupOpponentSignal = (typeof PUBLIC_SETUP_OPPONENT_SIGNALS)[number];

export const PUBLIC_SETUP_AUGMENT_SHIFTS = [
    "armor-to-movement",
    "might-to-movement",
    "sniper-to-movement",
    "armor-to-might",
    "armor-to-sniper",
    "might-to-armor",
    "might-to-sniper",
    "movement-to-sniper",
] as const;
export type PublicSetupAugmentShift = (typeof PUBLIC_SETUP_AUGMENT_SHIFTS)[number];

export interface IPublicSetupControlCandidate {
    id: "control/shipped-v07";
    family: "control";
    description: string;
}

export interface IPublicSetupAugmentCandidate {
    id: string;
    family: "augment";
    ownGroup: PublicSetupOwnGroup;
    opponentSignal: PublicSetupOpponentSignal;
    shift: PublicSetupAugmentShift;
    description: string;
}

export interface IPublicSetupSynergyCandidate {
    id: string;
    family: "synergy";
    faction: number;
    factionLabel: "life" | "chaos" | "might" | "nature";
    opponentSignal: PublicSetupOpponentSignal;
    description: string;
}

export interface IPublicSetupCompositeCandidate {
    id: string;
    family: "composite";
    ruleIds: readonly string[];
    rules: readonly (IPublicSetupAugmentCandidate | IPublicSetupSynergyCandidate)[];
    description: string;
}

export type PublicSetupCandidate =
    | IPublicSetupControlCandidate
    | IPublicSetupAugmentCandidate
    | IPublicSetupSynergyCandidate
    | IPublicSetupCompositeCandidate;

const CONTROL: IPublicSetupControlCandidate = {
    id: "control/shipped-v07",
    family: "control",
    description: "Exact frozen v0.7 non-fight setup on both seats",
};

const augmentCandidate = (
    ownGroup: PublicSetupOwnGroup,
    opponentSignal: PublicSetupOpponentSignal,
    shift: PublicSetupAugmentShift,
): IPublicSetupAugmentCandidate => ({
    id: `augment/${ownGroup}/${opponentSignal}/${shift}`,
    family: "augment",
    ownGroup,
    opponentSignal,
    shift,
    description: `${ownGroup}: ${shift} when the public opponent roster is ${opponentSignal}`,
});

const factionLabels = {
    life: PBTypes.FactionVals.LIFE,
    chaos: PBTypes.FactionVals.CHAOS,
    might: PBTypes.FactionVals.MIGHT,
    nature: PBTypes.FactionVals.NATURE,
} as const;

const synergyCandidate = (
    factionLabel: keyof typeof factionLabels,
    opponentSignal: PublicSetupOpponentSignal,
): IPublicSetupSynergyCandidate => ({
    id: `synergy/${factionLabel}/${opponentSignal}/flip`,
    family: "synergy",
    faction: factionLabels[factionLabel],
    factionLabel,
    opponentSignal,
    description: `${factionLabel}: flip the shipped choice when the public opponent roster is ${opponentSignal}`,
});

/**
 * Small, legible first-pass hypotheses. Each candidate has exactly one rule, so
 * a measured delta has one attribution and can be shipped as a simple guard.
 */
export const PUBLIC_SETUP_CANDIDATES: readonly PublicSetupCandidate[] = Object.freeze([
    CONTROL,
    // Existing league setup heads favor armor/sniper into ranged opponents.
    augmentCandidate("ranged", "ranged-2plus", "might-to-armor"),
    augmentCandidate("ranged", "ranged-2plus", "might-to-sniper"),
    augmentCandidate("ranged", "ranged-any", "might-to-armor"),
    augmentCandidate("ranged", "ranged-any", "might-to-sniper"),
    augmentCandidate("mage", "ranged-2plus", "movement-to-sniper"),
    augmentCandidate("mage", "ranged-any", "movement-to-sniper"),
    augmentCandidate("melee-magic", "ranged-2plus", "movement-to-sniper"),
    augmentCandidate("melee-magic", "ranged-any", "movement-to-sniper"),
    augmentCandidate("aura-heavy", "ranged-2plus", "movement-to-sniper"),
    augmentCandidate("aura-heavy", "ranged-any", "movement-to-sniper"),
    augmentCandidate("melee-other", "ranged-2plus", "movement-to-sniper"),
    augmentCandidate("melee-other", "ranged-any", "movement-to-sniper"),
    // Might is the positive historical response to multiple public flyers.
    augmentCandidate("ranged", "flyers-2plus", "armor-to-might"),
    // Retain mobility-vs-ranged as explicit falsification arms, not the prior.
    augmentCandidate("ranged", "ranged-2plus", "armor-to-movement"),
    augmentCandidate("ranged", "ranged-2plus", "might-to-movement"),
    augmentCandidate("ranged", "ranged-any", "armor-to-movement"),
    augmentCandidate("ranged", "ranged-any", "might-to-movement"),
    augmentCandidate("mage", "ranged-any", "armor-to-movement"),
    augmentCandidate("melee-magic", "ranged-any", "armor-to-movement"),
    augmentCandidate("aura-heavy", "ranged-any", "armor-to-movement"),
    augmentCandidate("melee-other", "ranged-any", "armor-to-movement"),
    synergyCandidate("chaos", "ranged-2plus"),
    synergyCandidate("chaos", "ranged-any"),
    synergyCandidate("chaos", "flyers-2plus"),
    synergyCandidate("life", "magic-any"),
    synergyCandidate("life", "aura-any"),
    synergyCandidate("might", "aura-any"),
    synergyCandidate("might", "low-ranged"),
    synergyCandidate("might", "flyers-2plus"),
    synergyCandidate("nature", "ranged-2plus"),
    synergyCandidate("nature", "ranged-any"),
    synergyCandidate("nature", "magic-any"),
]);

const candidateIds = new Set(PUBLIC_SETUP_CANDIDATES.map((candidate) => candidate.id));
if (candidateIds.size !== PUBLIC_SETUP_CANDIDATES.length) {
    throw new Error("public setup candidate ids must be unique");
}

export function publicSetupCandidate(candidateId: string): PublicSetupCandidate {
    const candidate = PUBLIC_SETUP_CANDIDATES.find((entry) => entry.id === candidateId);
    if (!candidate) throw new Error(`unknown public setup candidate ${candidateId}`);
    return candidate;
}

export function publicSetupCompositeCandidate(ruleIdsInput: readonly string[]): IPublicSetupCompositeCandidate {
    const ruleIds = [...new Set(ruleIdsInput)].sort();
    if (!ruleIds.length) throw new Error("public setup composite requires at least one rule");
    const rules = ruleIds.map((id) => {
        const candidate = publicSetupCandidate(id);
        if (candidate.family !== "augment" && candidate.family !== "synergy") {
            throw new Error(`composite rule ${id} is not a single augment/synergy rule`);
        }
        return candidate;
    });
    const augmentGroups = rules.filter((rule) => rule.family === "augment").map((rule) => rule.ownGroup);
    if (new Set(augmentGroups).size !== augmentGroups.length) {
        throw new Error("composite may contain at most one augment rule per own setup group");
    }
    const synergyFactions = rules.filter((rule) => rule.family === "synergy").map((rule) => rule.faction);
    if (new Set(synergyFactions).size !== synergyFactions.length) {
        throw new Error("composite may contain at most one synergy rule per faction");
    }
    const hash = createHash("sha256").update(JSON.stringify(ruleIds)).digest("hex").slice(0, 16);
    return Object.freeze({
        id: `composite/${hash}`,
        family: "composite" as const,
        ruleIds: Object.freeze(ruleIds),
        rules: Object.freeze(rules),
        description: `Canonical composite: ${ruleIds.join(" + ")}`,
    });
}

export function publicSetupCandidateRules(
    candidate: PublicSetupCandidate,
): readonly (IPublicSetupAugmentCandidate | IPublicSetupSynergyCandidate)[] {
    if (candidate.family === "control") return [];
    return candidate.family === "composite" ? candidate.rules : [candidate];
}

export function publicSetupOwnGroup(creatureIds: readonly number[]): PublicSetupOwnGroup {
    return publicSetupOwnGroupForCohort(setupCohort(creatureIds));
}

export function publicSetupOwnGroupForCohort(cohort: SetupCohort): PublicSetupOwnGroup {
    if (cohort === "ranged-4plus" || cohort === "ranged-2to3" || cohort === "ranged-1") return "ranged";
    if (cohort === "mage") return "mage";
    if (cohort === "melee-magic") return "melee-magic";
    if (cohort === "aura-heavy") return "aura-heavy";
    return "melee-other";
}

/** Overlapping risk tags; unlike setupCohort, one mixed roster can cover several diagnostics. */
export function publicSetupDiagnosticTags(creatureIds: readonly number[]): PublicSetupDiagnosticTag[] {
    const features = setupRosterFeatures(creatureIds);
    const tags: PublicSetupDiagnosticTag[] = [];
    if (features.ranged > 0) tags.push("ranged");
    if (features.mage > 0) tags.push("mage");
    if (features.meleeMagic > 0) tags.push("melee-magic");
    if (features.auraCarriers > 0) tags.push("aura-heavy");
    if (creatureIds.some((id) => setupCohort([id]) === "melee-other")) tags.push("melee-other");
    return tags;
}

export function publicSetupPossibleDiagnosticTags(group: PublicSetupOwnGroup): readonly PublicSetupDiagnosticTag[] {
    if (group === "ranged") return PUBLIC_SETUP_DIAGNOSTIC_TAGS;
    if (group === "mage") return ["mage", "aura-heavy", "melee-other"];
    if (group === "melee-magic") return ["mage", "melee-magic", "aura-heavy", "melee-other"];
    if (group === "aura-heavy") return ["aura-heavy", "melee-other"];
    return ["melee-other"];
}

export function publicSetupOpponentSignalMatches(
    signal: PublicSetupOpponentSignal,
    opponentCreatureIds: readonly number[],
): boolean {
    const ids = [...new Set(opponentCreatureIds)];
    const features = setupRosterFeatures(ids);
    if (signal === "ranged-any") return features.ranged > 0;
    if (signal === "ranged-2plus") return features.ranged >= 2;
    if (signal === "ranged-4plus") return features.ranged >= 4;
    if (signal === "magic-any") return features.mage + features.meleeMagic > 0;
    if (signal === "flyers-2plus") return features.flyers >= 2;
    if (signal === "aura-any") return features.auraCarriers > 0;
    return features.total > 0 && features.ranged <= 1;
}

const AUGMENT_CAPS: Readonly<IAugmentPlan> = {
    placement: 2,
    armor: 3,
    might: 3,
    sniper: 3,
    movement: 2,
};

const SHIFT_STATS: Record<PublicSetupAugmentShift, readonly [keyof IAugmentPlan, keyof IAugmentPlan]> = {
    "armor-to-movement": ["armor", "movement"],
    "might-to-movement": ["might", "movement"],
    "sniper-to-movement": ["sniper", "movement"],
    "armor-to-might": ["armor", "might"],
    "armor-to-sniper": ["armor", "sniper"],
    "might-to-armor": ["might", "armor"],
    "might-to-sniper": ["might", "sniper"],
    "movement-to-sniper": ["movement", "sniper"],
};

export function shiftPublicSetupAugmentPlan(
    plan: Readonly<IAugmentPlan>,
    shift: PublicSetupAugmentShift,
): IAugmentPlan | undefined {
    const [from, to] = SHIFT_STATS[shift];
    if (plan[from] <= 0 || plan[to] >= AUGMENT_CAPS[to]) return undefined;
    const shifted: IAugmentPlan = { ...plan, [from]: plan[from] - 1, [to]: plan[to] + 1 };
    assertAugmentPlan(shifted);
    return shifted;
}

/** Exact shipped cohorts on which an augment arm can change a legal point. */
export function publicSetupAugmentActionableCohorts(candidate: IPublicSetupAugmentCandidate): SetupCohort[] {
    return SETUP_COHORTS.filter(
        (cohort) =>
            publicSetupOwnGroupForCohort(cohort) === candidate.ownGroup &&
            shiftPublicSetupAugmentPlan(
                V07_NONFIGHT_SETUP_ARTIFACT.policy.augmentsByCohort[cohort],
                candidate.shift,
            ) !== undefined,
    );
}

for (const candidate of PUBLIC_SETUP_CANDIDATES) {
    if (candidate.family === "augment" && publicSetupAugmentActionableCohorts(candidate).length === 0) {
        throw new Error(`public setup augment candidate ${candidate.id} can never alter the shipped plan`);
    }
}

const SHIPPED_SETUP = compileNonFightSetupPolicy(V07_NONFIGHT_SETUP_ARTIFACT.policy, V07_NONFIGHT_SETUP_SPEC);

export interface IPublicSetupChoices {
    augments: ISetupAugmentChoice[];
    synergies: ISetupSynergyChoice[];
    controlAugmentPlanId: string;
    candidateAugmentPlanId: string;
    actionApplied: boolean;
    ownGroup: PublicSetupOwnGroup;
    ownTags: PublicSetupDiagnosticTag[];
    opponentGroup: PublicSetupOwnGroup;
    publicOpponentCreatureIds: number[];
    matchedRuleIds: string[];
}

/**
 * Fair decision boundary: opponent creature identities are the only opponent
 * data accepted here. Duplicate identities cannot manufacture extra signal.
 */
export function selectPublicSetupChoices(
    candidate: PublicSetupCandidate,
    ownCreatureStackIds: readonly number[],
    opponentCreatureIds: readonly number[],
): IPublicSetupChoices {
    const publicOpponentCreatureIds = [...new Set(opponentCreatureIds)];
    const ownGroup = publicSetupOwnGroup(ownCreatureStackIds);
    const ownTags = publicSetupDiagnosticTags(ownCreatureStackIds);
    const opponentGroup = publicSetupOwnGroup(publicOpponentCreatureIds);
    const cohort: SetupCohort = setupCohort(ownCreatureStackIds);
    const controlPlan = V07_NONFIGHT_SETUP_ARTIFACT.policy.augmentsByCohort[cohort];
    const controlAugments = SHIPPED_SETUP.pickAugments(7, ownCreatureStackIds);
    const controlSynergies = SHIPPED_SETUP.pickSynergies(ownCreatureStackIds);
    let augments = controlAugments;
    let synergies = controlSynergies;
    let candidatePlan = controlPlan;
    const matchedRuleIds: string[] = [];

    for (const rule of publicSetupCandidateRules(candidate)) {
        if (
            rule.family === "augment" &&
            rule.ownGroup === ownGroup &&
            publicSetupOpponentSignalMatches(rule.opponentSignal, publicOpponentCreatureIds)
        ) {
            const shifted = shiftPublicSetupAugmentPlan(controlPlan, rule.shift);
            if (shifted) {
                candidatePlan = shifted;
                augments = setupAugmentsForPlan(shifted);
                matchedRuleIds.push(rule.id);
            }
        } else if (
            rule.family === "synergy" &&
            publicSetupOpponentSignalMatches(rule.opponentSignal, publicOpponentCreatureIds)
        ) {
            const activeIndex = synergies.findIndex((choice) => choice.faction === rule.faction);
            if (activeIndex >= 0) {
                const alternative = SYNERGY_OPTIONS.find(
                    (option) => option.faction === rule.faction && option.synergy !== synergies[activeIndex].synergy,
                );
                if (alternative) {
                    synergies = synergies.map((choice, index) =>
                        index === activeIndex ? { faction: choice.faction, synergy: alternative.synergy } : choice,
                    );
                    matchedRuleIds.push(rule.id);
                }
            }
        }
    }

    return {
        augments,
        synergies,
        controlAugmentPlanId: augmentPlanId(controlPlan),
        candidateAugmentPlanId: augmentPlanId(candidatePlan),
        actionApplied:
            augmentPlanId(candidatePlan) !== augmentPlanId(controlPlan) ||
            JSON.stringify(synergies) !== JSON.stringify(controlSynergies),
        ownGroup,
        ownTags,
        opponentGroup,
        publicOpponentCreatureIds,
        matchedRuleIds,
    };
}

export interface IPublicSetupBoard {
    index: number;
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
    gridType: SetupLiveGridType;
}

const MAX_SEED_INDEX = 0x3fffffff;

/** Three disjoint deterministic channels per offer board: identity, pick, combat. */
export function publicSetupBoard(baseSeed: number, panel: SetupSeedPanel, index: number): IPublicSetupBoard {
    if (!Number.isInteger(index) || index < 0 || index * 3 + 2 > MAX_SEED_INDEX) {
        throw new RangeError(`board index must fit three setup-panel seed channels; got ${index}`);
    }
    const pairSeed = setupPanelSeed(baseSeed, panel, index * 3);
    const pickSeed = setupPanelSeed(baseSeed, panel, index * 3 + 1);
    const battleSeed = setupPanelSeed(baseSeed, panel, index * 3 + 2);
    return { index, pairSeed, pickSeed, battleSeed, gridType: setupLiveGridType(battleSeed) };
}

export type PublicSetupPickSeat = "lower" | "upper";

export interface IPublicSetupStratum {
    candidateId: string;
    ruleId: string;
    pickSeat: PublicSetupPickSeat;
    gridType: SetupLiveGridType;
    ownTag: PublicSetupDiagnosticTag;
    opponentSignal: PublicSetupOpponentSignal;
}

export interface IPublicSetupStratifiedBoard {
    stratum: IPublicSetupStratum;
    board: IPublicSetupBoard;
}

export interface IPublicSetupCandidateBoardPlan {
    candidateId: string;
    supported: boolean;
    strata: readonly IPublicSetupStratum[];
    stratifiedBoards: readonly IPublicSetupStratifiedBoard[];
    unfilledStrata: readonly { stratum: IPublicSetupStratum; filled: number; planned: number }[];
}

export interface IPublicSetupBoardPlan {
    schemaVersion: 1;
    panel: SetupSeedPanel;
    baseSeed: number;
    naturalBoards: readonly IPublicSetupBoard[];
    stratumBoards: number;
    stratifiedScanCap: number;
    scannedBoards: number;
    candidates: readonly IPublicSetupCandidateBoardPlan[];
    controlBoards: readonly IPublicSetupBoard[];
}

export function publicSetupCandidateStrata(candidate: PublicSetupCandidate): IPublicSetupStratum[] {
    if (candidate.family === "control") return [];
    const strata: IPublicSetupStratum[] = [];
    for (const rule of publicSetupCandidateRules(candidate)) {
        const tags: readonly PublicSetupDiagnosticTag[] =
            rule.family === "augment" ? publicSetupPossibleDiagnosticTags(rule.ownGroup) : PUBLIC_SETUP_DIAGNOSTIC_TAGS;
        for (const pickSeat of ["lower", "upper"] as const) {
            for (const gridType of SETUP_LIVE_GRID_TYPES) {
                for (const ownTag of tags) {
                    strata.push({
                        candidateId: candidate.id,
                        ruleId: rule.id,
                        pickSeat,
                        gridType,
                        ownTag,
                        opponentSignal: rule.opponentSignal,
                    });
                }
            }
        }
    }
    return strata.sort((left, right) => publicSetupStratumKey(left).localeCompare(publicSetupStratumKey(right)));
}

export function publicSetupStratumKey(stratum: IPublicSetupStratum): string {
    return [
        stratum.candidateId,
        stratum.ruleId,
        stratum.pickSeat,
        stratum.gridType,
        stratum.ownTag,
        stratum.opponentSignal,
    ].join("\u0000");
}

export interface IPublicSetupOutcomeRecord {
    pairSeed: number;
    /** Stable member of the four-game pick-seat x battle-side cluster. */
    game: number;
    gridType: SetupLiveGridType;
    candidateResult: "win" | "loss" | "draw";
    ownGroup: PublicSetupOwnGroup;
    ownTags: readonly PublicSetupDiagnosticTag[];
    actionApplied: boolean;
    candidateRejections: number;
    baselineRejections: number;
    laps: number;
    totalActions: number;
    endReason: "elimination" | "turn_cap" | "stuck";
    decidedByArmageddon: boolean;
    behaviorTraceSha256: string;
}

export interface IPublicSetupEstimate {
    clusters: number;
    games: number;
    candidateWins: number;
    candidateLosses: number;
    candidateDraws: number;
    controlWins: number;
    controlLosses: number;
    controlDraws: number;
    candidateDecisiveWinRate: number;
    controlDecisiveWinRate: number;
    candidateScoreRate: number;
    controlScoreRate: number;
    matchedGainPp: number;
    confidence95GainPp: { low: number; high: number };
    confidence95LowGainPp: number;
    candidateRejections: number;
    candidateOpponentRejections: number;
    controlRejections: number;
    candidateAvgLaps: number;
    controlAvgLaps: number;
    candidateAvgActions: number;
    controlAvgActions: number;
    candidateTurnCaps: number;
    controlTurnCaps: number;
    candidateArmageddons: number;
    controlArmageddons: number;
    candidateActionGames: number;
}

export interface IPublicSetupMatchedRecord {
    candidate: IPublicSetupOutcomeRecord;
    control: IPublicSetupOutcomeRecord;
}

const resultScore = (result: IPublicSetupOutcomeRecord["candidateResult"]): number =>
    result === "win" ? 1 : result === "loss" ? 0 : 0.5;

const recordKey = (record: Pick<IPublicSetupOutcomeRecord, "pairSeed" | "game">): string =>
    `${record.pairSeed}\u0000${record.game}`;

/** Match a selected candidate slice to the exact same control board/game. */
export function matchPublicSetupRecords(
    candidateRecords: readonly IPublicSetupOutcomeRecord[],
    controlRecords: readonly IPublicSetupOutcomeRecord[],
): IPublicSetupMatchedRecord[] {
    const controls = new Map<string, IPublicSetupOutcomeRecord>();
    for (const control of controlRecords) {
        const key = recordKey(control);
        if (controls.has(key)) throw new Error(`duplicate public setup control record ${key}`);
        controls.set(key, control);
    }
    const seen = new Set<string>();
    const matched: IPublicSetupMatchedRecord[] = [];
    for (const candidate of candidateRecords) {
        const key = recordKey(candidate);
        if (seen.has(key)) throw new Error(`duplicate public setup candidate record ${key}`);
        seen.add(key);
        const control = controls.get(key);
        if (!control) continue;
        if (candidate.gridType !== control.gridType || candidate.ownGroup !== control.ownGroup) {
            throw new Error(`candidate/control board metadata mismatch for ${key}`);
        }
        matched.push({ candidate, control });
    }
    return matched;
}

function clusteredMatchedConfidence95GainPp(records: readonly IPublicSetupMatchedRecord[]): {
    low: number;
    high: number;
} {
    if (!records.length) return { low: -100, high: 100 };
    const deltas = records.map(
        ({ candidate, control }) => resultScore(candidate.candidateResult) - resultScore(control.candidateResult),
    );
    const mean = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
    const clusters = new Map<number, number[]>();
    records.forEach(({ candidate }, index) => {
        const cluster = clusters.get(candidate.pairSeed) ?? [];
        cluster.push(deltas[index]);
        clusters.set(candidate.pairSeed, cluster);
    });
    if (clusters.size < 2) {
        return deltas.every((delta) => delta === 0) ? { low: 0, high: 0 } : { low: -100, high: 100 };
    }
    let residualSquares = 0;
    for (const cluster of clusters.values()) {
        const residual = cluster.reduce((sum, delta) => sum + delta - mean, 0);
        residualSquares += residual * residual;
    }
    const standardError = Math.sqrt((clusters.size / (clusters.size - 1)) * residualSquares) / records.length;
    const halfWidthPp = 1.96 * standardError * 100;
    return {
        low: Math.max(-100, mean * 100 - halfWidthPp),
        high: Math.min(100, mean * 100 + halfWidthPp),
    };
}

export function publicSetupEstimate(records: readonly IPublicSetupMatchedRecord[]): IPublicSetupEstimate {
    const candidateWins = records.filter(({ candidate }) => candidate.candidateResult === "win").length;
    const candidateLosses = records.filter(({ candidate }) => candidate.candidateResult === "loss").length;
    const candidateDraws = records.length - candidateWins - candidateLosses;
    const controlWins = records.filter(({ control }) => control.candidateResult === "win").length;
    const controlLosses = records.filter(({ control }) => control.candidateResult === "loss").length;
    const controlDraws = records.length - controlWins - controlLosses;
    const candidateDecisive = candidateWins + candidateLosses;
    const controlDecisive = controlWins + controlLosses;
    const candidateScore = records.reduce((sum, { candidate }) => sum + resultScore(candidate.candidateResult), 0);
    const controlScore = records.reduce((sum, { control }) => sum + resultScore(control.candidateResult), 0);
    const confidence95GainPp = clusteredMatchedConfidence95GainPp(records);
    return {
        clusters: new Set(records.map(({ candidate }) => candidate.pairSeed)).size,
        games: records.length,
        candidateWins,
        candidateLosses,
        candidateDraws,
        controlWins,
        controlLosses,
        controlDraws,
        candidateDecisiveWinRate: candidateDecisive ? candidateWins / candidateDecisive : 0.5,
        controlDecisiveWinRate: controlDecisive ? controlWins / controlDecisive : 0.5,
        candidateScoreRate: records.length ? candidateScore / records.length : 0.5,
        controlScoreRate: records.length ? controlScore / records.length : 0.5,
        matchedGainPp: records.length ? ((candidateScore - controlScore) / records.length) * 100 : 0,
        confidence95GainPp,
        confidence95LowGainPp: confidence95GainPp.low,
        candidateRejections: records.reduce((sum, { candidate }) => sum + candidate.candidateRejections, 0),
        candidateOpponentRejections: records.reduce((sum, { candidate }) => sum + candidate.baselineRejections, 0),
        controlRejections: records.reduce((sum, { control }) => sum + control.candidateRejections, 0),
        candidateAvgLaps: records.length
            ? records.reduce((sum, { candidate }) => sum + candidate.laps, 0) / records.length
            : 0,
        controlAvgLaps: records.length
            ? records.reduce((sum, { control }) => sum + control.laps, 0) / records.length
            : 0,
        candidateAvgActions: records.length
            ? records.reduce((sum, { candidate }) => sum + candidate.totalActions, 0) / records.length
            : 0,
        controlAvgActions: records.length
            ? records.reduce((sum, { control }) => sum + control.totalActions, 0) / records.length
            : 0,
        candidateTurnCaps: records.filter(({ candidate }) => candidate.endReason === "turn_cap").length,
        controlTurnCaps: records.filter(({ control }) => control.endReason === "turn_cap").length,
        candidateArmageddons: records.filter(({ candidate }) => candidate.decidedByArmageddon).length,
        controlArmageddons: records.filter(({ control }) => control.decidedByArmageddon).length,
        candidateActionGames: records.filter(({ candidate }) => candidate.actionApplied).length,
    };
}

export interface IPublicSetupSummary {
    natural: IPublicSetupEstimate;
    stratifiedActionable: IPublicSetupEstimate;
    byOwnTag: Record<PublicSetupDiagnosticTag, IPublicSetupEstimate>;
    byMap: Record<string, IPublicSetupEstimate>;
}

export function summarizePublicSetup(
    naturalRecords: readonly IPublicSetupOutcomeRecord[],
    stratifiedActionableRecords: readonly IPublicSetupOutcomeRecord[],
    controlRecords: readonly IPublicSetupOutcomeRecord[],
): IPublicSetupSummary {
    const estimate = (selected: readonly IPublicSetupOutcomeRecord[]): IPublicSetupEstimate =>
        publicSetupEstimate(matchPublicSetupRecords(selected, controlRecords));
    return {
        natural: estimate(naturalRecords),
        stratifiedActionable: estimate(stratifiedActionableRecords),
        byOwnTag: Object.fromEntries(
            PUBLIC_SETUP_DIAGNOSTIC_TAGS.map((tag) => [
                tag,
                estimate(naturalRecords.filter((record) => record.ownTags.includes(tag))),
            ]),
        ) as Record<PublicSetupDiagnosticTag, IPublicSetupEstimate>,
        byMap: Object.fromEntries(
            SETUP_LIVE_GRID_TYPES.map((gridType) => [
                String(gridType),
                estimate(naturalRecords.filter((record) => record.gridType === gridType)),
            ]),
        ),
    };
}

export const PUBLIC_SETUP_GUARD_THRESHOLDS = {
    minimumNaturalGames: 4_000,
    aggregateConfidence95LowGainPp: 0,
    minimumStratifiedActionableGames: 400,
    practicalActionablePointGainPp: 1,
    actionableConfidence95LowGainPp: 0,
    minimumOwnTagGames: 200,
    ownTagPointGainPp: -0.5,
    ownTagConfidence95LowGainPp: -2,
    minimumMapGames: 500,
    mapPointGainPp: -0.5,
    mapConfidence95LowGainPp: -2,
} as const;

export interface IPublicSetupGate {
    promotable: boolean;
    failures: string[];
}

export interface IPublicSetupControlParity {
    ok: boolean;
    failures: string[];
}

export function validatePublicSetupControlParity(
    records: readonly IPublicSetupOutcomeRecord[],
    expectedGames: number,
): IPublicSetupControlParity {
    const failures: string[] = [];
    if (records.length !== expectedGames) failures.push(`control has ${records.length}/${expectedGames} planned games`);
    if (records.some((record) => record.actionApplied)) failures.push("control changed shipped setup choices");
    if (records.some((record) => record.candidateRejections !== 0 || record.baselineRejections !== 0)) {
        failures.push("control has rejected actions");
    }
    const clusters = new Map<number, IPublicSetupOutcomeRecord[]>();
    for (const record of records) {
        const cluster = clusters.get(record.pairSeed) ?? [];
        cluster.push(record);
        clusters.set(record.pairSeed, cluster);
    }
    for (const [pairSeed, cluster] of clusters) {
        const byGame = new Map(cluster.map((record) => [record.game, record]));
        if (cluster.length !== 4 || byGame.size !== 4 || [0, 1, 2, 3].some((game) => !byGame.has(game))) {
            failures.push(`control cluster ${pairSeed} is not a complete four-game cluster`);
            continue;
        }
        for (const [left, right] of [
            [0, 2],
            [1, 3],
        ] as const) {
            const a = byGame.get(left)!;
            const b = byGame.get(right)!;
            if (resultScore(a.candidateResult) + resultScore(b.candidateResult) !== 1) {
                failures.push(`control cluster ${pairSeed} games ${left}/${right} are not exact role complements`);
            }
            if (a.behaviorTraceSha256 !== b.behaviorTraceSha256) {
                failures.push(`control cluster ${pairSeed} games ${left}/${right} have different behavior traces`);
            }
        }
    }
    const wins = records.filter((record) => record.candidateResult === "win").length;
    const losses = records.filter((record) => record.candidateResult === "loss").length;
    if (wins !== losses) failures.push(`control parity is ${wins} wins/${losses} losses`);
    return { ok: failures.length === 0, failures };
}

export interface IPublicSetupPromotionContext {
    panel: SetupSeedPanel;
    runComplete: boolean;
    candidateFrozen: boolean;
    nonControlCandidateCount: number;
    candidateSupported: boolean;
    sourceClean: boolean;
    allCandidateRejections: number;
    plannedNaturalGames: number;
    plannedStratifiedActionableGames: number;
    controlParity: IPublicSetupControlParity;
}

export function publicSetupPromotionGate(
    candidate: PublicSetupCandidate,
    summary: Readonly<IPublicSetupSummary>,
    context: Readonly<IPublicSetupPromotionContext>,
): IPublicSetupGate {
    const failures: string[] = [];
    if (candidate.family === "control") failures.push("control is a calibration arm, not a promotable policy");
    if (context.panel !== "guard") failures.push(`${context.panel} is exploratory and can never promote`);
    if (!context.runComplete) failures.push("manifest-fixed board plan is incomplete");
    if (!context.candidateFrozen) failures.push("guard candidate is not frozen in the manifest");
    if (context.nonControlCandidateCount !== 1) failures.push("guard requires exactly one candidate or composite");
    if (!context.candidateSupported) failures.push("candidate could not fill the fixed stratified board plan");
    if (!context.sourceClean) failures.push("guard source tree is dirty; commit the exact evaluated sources first");
    if (context.allCandidateRejections !== 0) failures.push("candidate has rejections outside the scored slices");
    failures.push(...context.controlParity.failures.map((failure) => `control: ${failure}`));
    if (summary.natural.games !== context.plannedNaturalGames) {
        failures.push(`natural has ${summary.natural.games}/${context.plannedNaturalGames} planned games`);
    }
    if (summary.stratifiedActionable.games !== context.plannedStratifiedActionableGames) {
        failures.push(
            `stratified actionable has ${summary.stratifiedActionable.games}/${context.plannedStratifiedActionableGames} planned games`,
        );
    }
    if (summary.stratifiedActionable.candidateActionGames !== summary.stratifiedActionable.games) {
        failures.push("stratified plan contains no-op candidate games");
    }
    if (summary.natural.games < PUBLIC_SETUP_GUARD_THRESHOLDS.minimumNaturalGames) {
        failures.push(`natural has only ${summary.natural.games} games`);
    }
    if (summary.natural.confidence95LowGainPp <= PUBLIC_SETUP_GUARD_THRESHOLDS.aggregateConfidence95LowGainPp) {
        failures.push(`aggregate LCB is ${summary.natural.confidence95LowGainPp.toFixed(3)}pp`);
    }
    if (summary.stratifiedActionable.games < PUBLIC_SETUP_GUARD_THRESHOLDS.minimumStratifiedActionableGames) {
        failures.push(`stratified actionable has only ${summary.stratifiedActionable.games} games`);
    }
    if (summary.stratifiedActionable.matchedGainPp < PUBLIC_SETUP_GUARD_THRESHOLDS.practicalActionablePointGainPp) {
        failures.push(`actionable point gain is ${summary.stratifiedActionable.matchedGainPp.toFixed(3)}pp`);
    }
    if (
        summary.stratifiedActionable.confidence95LowGainPp <=
        PUBLIC_SETUP_GUARD_THRESHOLDS.actionableConfidence95LowGainPp
    ) {
        failures.push(`actionable LCB is ${summary.stratifiedActionable.confidence95LowGainPp.toFixed(3)}pp`);
    }
    for (const tag of PUBLIC_SETUP_DIAGNOSTIC_TAGS) {
        const estimate = summary.byOwnTag[tag];
        if (estimate.games < PUBLIC_SETUP_GUARD_THRESHOLDS.minimumOwnTagGames) {
            failures.push(`${tag} has ${estimate.games} natural games`);
        } else if (estimate.matchedGainPp < PUBLIC_SETUP_GUARD_THRESHOLDS.ownTagPointGainPp) {
            failures.push(`${tag} matched gain is ${estimate.matchedGainPp.toFixed(3)}pp`);
        } else if (estimate.confidence95LowGainPp < PUBLIC_SETUP_GUARD_THRESHOLDS.ownTagConfidence95LowGainPp) {
            failures.push(`${tag} LCB is ${estimate.confidence95LowGainPp.toFixed(3)}pp`);
        }
    }
    for (const [gridType, estimate] of Object.entries(summary.byMap)) {
        if (estimate.games < PUBLIC_SETUP_GUARD_THRESHOLDS.minimumMapGames) {
            failures.push(`map ${gridType} has ${estimate.games} games`);
        } else if (estimate.matchedGainPp < PUBLIC_SETUP_GUARD_THRESHOLDS.mapPointGainPp) {
            failures.push(`map ${gridType} matched gain is ${estimate.matchedGainPp.toFixed(3)}pp`);
        } else if (estimate.confidence95LowGainPp < PUBLIC_SETUP_GUARD_THRESHOLDS.mapConfidence95LowGainPp) {
            failures.push(`map ${gridType} LCB is ${estimate.confidence95LowGainPp.toFixed(3)}pp`);
        }
    }
    if (summary.natural.candidateRejections + summary.stratifiedActionable.candidateRejections !== 0) {
        failures.push("candidate has rejected actions");
    }
    if (summary.natural.candidateOpponentRejections + summary.stratifiedActionable.candidateOpponentRejections !== 0) {
        failures.push("candidate games have opponent-side rejected actions");
    }
    if (summary.natural.controlRejections + summary.stratifiedActionable.controlRejections !== 0) {
        failures.push("control has rejected actions");
    }
    for (const [label, estimate] of [
        ["natural", summary.natural],
        ["stratified actionable", summary.stratifiedActionable],
    ] as const) {
        if (estimate.candidateDraws > estimate.controlDraws) failures.push(`${label} draw count regressed`);
        if (estimate.candidateTurnCaps > estimate.controlTurnCaps) failures.push(`${label} turn-cap count regressed`);
        if (estimate.candidateArmageddons > estimate.controlArmageddons) {
            failures.push(`${label} Armageddon count regressed`);
        }
        if (estimate.candidateAvgLaps > estimate.controlAvgLaps) {
            failures.push(`${label} average lap duration regressed`);
        }
        if (estimate.candidateAvgActions > estimate.controlAvgActions) {
            failures.push(`${label} average action count regressed`);
        }
    }
    return { promotable: failures.length === 0, failures };
}
