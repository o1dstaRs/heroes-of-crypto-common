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

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createGzip, type Gzip } from "node:zlib";

import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../artifacts/artifact_properties";
import { V08_A13_PROFILE } from "../ai/versions/v0_8_a13_profile";
import {
    AI_META_COHORT_DESCRIPTIONS,
    AI_META_COHORTS,
    AI_META_EXPLORATION_RATE,
    AI_META_FIGHT_PROFILE,
    AI_META_FIGHT_VERSION,
    AI_META_GAMES_PER_MATCHUP,
    AI_META_MAPS,
    AI_META_POLICY,
    AI_META_RECORDED_MAPS,
    AI_META_SCHEMA_VERSION,
    AI_META_SYNERGY_DEFINITIONS,
    AI_META_SYNERGY_POLICY_SHA256,
    AI_META_SYNERGY_POLICY_SPEC,
    AI_META_SYNERGY_TRACKING,
    aiMetaSynergyDefinition,
    aiMetaSynergyKey,
    aiMetaSynergyLevel,
    allAugmentPlans,
    artifactImageKey,
    artifactName,
    rosterSignature,
    rostersAreStrictlyDistinct,
    type AiMetaCohort,
    type AiMetaRecordedMap,
    type IAiMetaArmy,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
    type IAiMetaRunOptions,
} from "./ai_meta_cohorts_core";

interface ICountedOutcome {
    score: number;
    wins: number;
    losses: number;
    draws: number;
    hpMargin: number;
    survivorMargin: number;
}

class ClusterTally {
    public pairs = 0;
    public games = 0;
    public wins = 0;
    public losses = 0;
    public draws = 0;
    public scoreSum = 0;
    public scoreSquareSum = 0;
    public hpMarginSum = 0;
    public survivorMarginSum = 0;
    public add(outcome: ICountedOutcome): void {
        this.addCluster([outcome]);
    }
    public addCluster(outcomes: readonly ICountedOutcome[]): void {
        if (!outcomes.length) return;
        const clusterScore = outcomes.reduce((sum, outcome) => sum + outcome.score, 0) / outcomes.length;
        this.pairs += 1;
        this.games += outcomes.reduce((sum, outcome) => sum + outcome.wins + outcome.losses + outcome.draws, 0);
        this.wins += outcomes.reduce((sum, outcome) => sum + outcome.wins, 0);
        this.losses += outcomes.reduce((sum, outcome) => sum + outcome.losses, 0);
        this.draws += outcomes.reduce((sum, outcome) => sum + outcome.draws, 0);
        this.scoreSum += clusterScore;
        this.scoreSquareSum += clusterScore * clusterScore;
        this.hpMarginSum += outcomes.reduce((sum, outcome) => sum + outcome.hpMargin, 0) / outcomes.length;
        this.survivorMarginSum += outcomes.reduce((sum, outcome) => sum + outcome.survivorMargin, 0) / outcomes.length;
    }
    public row(): Pick<
        IAiMetaMetricRow,
        | "pairs"
        | "games"
        | "wins"
        | "losses"
        | "draws"
        | "scoreRate"
        | "winRate"
        | "ciLow"
        | "ciHigh"
        | "decisiveCiLow"
        | "decisiveCiHigh"
        | "liftPp"
        | "avgHpMargin"
        | "avgSurvivorMargin"
    > {
        const scoreRate = this.pairs ? this.scoreSum / this.pairs : 0.5;
        let standardError = 0;
        if (this.pairs > 1) {
            const variance = Math.max(
                0,
                (this.scoreSquareSum - (this.scoreSum * this.scoreSum) / this.pairs) / (this.pairs - 1),
            );
            standardError = Math.sqrt(variance / this.pairs);
        }
        const z = 1.959963984540054;
        const decisive = this.wins + this.losses;
        const winRate = decisive ? this.wins / decisive : 0.5;
        const [decisiveCiLow, decisiveCiHigh] = wilson(this.wins, decisive);
        const [ciLow, ciHigh] =
            this.pairs >= 2
                ? [Math.max(0, scoreRate - z * standardError), Math.min(1, scoreRate + z * standardError)]
                : [0, 1];
        return {
            pairs: this.pairs,
            games: this.games,
            wins: this.wins,
            losses: this.losses,
            draws: this.draws,
            scoreRate,
            winRate,
            ciLow,
            ciHigh,
            decisiveCiLow,
            decisiveCiHigh,
            liftPp: (scoreRate - 0.5) * 100,
            avgHpMargin: this.pairs ? this.hpMarginSum / this.pairs : 0,
            avgSurvivorMargin: this.pairs ? this.survivorMarginSum / this.pairs : 0,
        };
    }
}

interface IMetricBucket {
    strength: ClusterTally;
    policy: ClusterTally;
    selections: number;
    exploitSelections: number;
    exploreSelections: number;
}

export interface IAiMetaMetricRow {
    cohort: string;
    map: AiMetaMapDimension;
    key: string;
    name: string;
    imageKey?: string;
    kind?: string;
    level?: number;
    tier?: number;
    faction?: number;
    synergy?: number;
    pairs: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    scoreRate: number;
    winRate: number;
    ciLow: number;
    ciHigh: number;
    decisiveCiLow: number;
    decisiveCiHigh: number;
    liftPp: number;
    avgHpMargin: number;
    avgSurvivorMargin: number;
    selected: number;
    pickRate: number;
    exploitSelections: number;
    exploreSelections: number;
    policyPairs: number;
    policyScoreRate: number;
    policyWinRate: number;
    policyCiLow: number;
    policyCiHigh: number;
}

export type AiMetaMapDimension = "all" | "live" | AiMetaRecordedMap;

export interface ICohortQuality {
    cohort: string;
    description: string;
    pairs: number;
    games: number;
    greenWins: number;
    redWins: number;
    draws: number;
    armageddonDecided: number;
    rejectedActions: number;
    distinctRosterViolations: number;
    overlappingCreatureViolations: number;
    mapGames: Record<string, number>;
    endReasons: Record<string, number>;
    seconds: number;
    gamesPerSecond: number;
    rawPath: string;
}

export interface IAiMetaRankings {
    units: IAiMetaMetricRow[];
    artifactsT1: IAiMetaMetricRow[];
    artifactsT2: IAiMetaMetricRow[];
    augmentPlans: IAiMetaMetricRow[];
    augmentLevels: IAiMetaMetricRow[];
    synergies: IAiMetaMetricRow[];
}

export interface IAiMetaSummary {
    schemaVersion: typeof AI_META_SCHEMA_VERSION;
    complete: boolean;
    generatedAt: string;
    provenance: Record<string, unknown>;
    cohorts: ICohortQuality[];
    rankings: IAiMetaRankings;
}

const emptyBucket = (): IMetricBucket => ({
    strength: new ClusterTally(),
    policy: new ClusterTally(),
    selections: 0,
    exploitSelections: 0,
    exploreSelections: 0,
});

const wilson = (wins: number, n: number, z = 1.959963984540054): [number, number] => {
    if (!n) return [0, 1];
    const p = wins / n;
    const denominator = 1 + (z * z) / n;
    const center = (p + (z * z) / (2 * n)) / denominator;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
    return [Math.max(0, center - margin), Math.min(1, center + margin)];
};

const slug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

const sideOutcome = (games: readonly IAiMetaGameOutcome[], side: "a" | "b"): ICountedOutcome => {
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let hpMargin = 0;
    let survivorMargin = 0;
    for (const game of games) {
        if (game.winner === side) wins += 1;
        else if (game.winner === "draw") draws += 1;
        else losses += 1;
        const direction = side === "a" ? 1 : -1;
        hpMargin += direction * (game.hpA - game.hpB);
        survivorMargin += direction * (game.survivorsA - game.survivorsB);
    }
    return {
        score: (wins + draws * 0.5) / Math.max(1, games.length),
        wins,
        losses,
        draws,
        hpMargin: hpMargin / Math.max(1, games.length),
        survivorMargin: survivorMargin / Math.max(1, games.length),
    };
};

function bucketFor(map: Map<string, IMetricBucket>, key: string): IMetricBucket {
    let bucket = map.get(key);
    if (!bucket) {
        bucket = emptyBucket();
        map.set(key, bucket);
    }
    return bucket;
}

export class AiMetaAccumulator {
    private readonly units = new Map<string, IMetricBucket>();
    private readonly artifactsT1 = new Map<string, IMetricBucket>();
    private readonly artifactsT2 = new Map<string, IMetricBucket>();
    private readonly augmentPlans = new Map<string, IMetricBucket>();
    private readonly augmentLevels = new Map<string, IMetricBucket>();
    private readonly synergies = new Map<string, IMetricBucket>();
    public pairs = 0;
    public games = 0;
    public greenWins = 0;
    public redWins = 0;
    public draws = 0;
    public armageddonDecided = 0;
    public rejectedActions = 0;
    public distinctRosterViolations = 0;
    public overlappingCreatureViolations = 0;
    public readonly mapGames: Record<string, number> = {};
    public readonly endReasons: Record<string, number> = {};
    public constructor(
        public readonly cohort: string,
        public readonly map: AiMetaMapDimension = "all",
    ) {
        for (const artifact of TIER1_ARTIFACT_LIST) this.artifactsT1.set(String(artifact.id), emptyBucket());
        for (const artifact of TIER2_ARTIFACT_LIST) this.artifactsT2.set(String(artifact.id), emptyBucket());
        for (const plan of allAugmentPlans()) this.augmentPlans.set(planKey(plan), emptyBucket());
        for (const definition of AI_META_SYNERGY_DEFINITIONS) {
            for (const level of [1, 2, 3] as const) {
                this.synergies.set(aiMetaSynergyKey(definition.faction, definition.synergy, level), emptyBucket());
            }
        }
        for (const [kind, cap] of [
            ["Placement", 2],
            ["Armor", 3],
            ["Might", 3],
            ["Sniper", 3],
            ["Movement", 2],
        ] as const) {
            for (let level = 0; level <= cap; level += 1) {
                this.augmentLevels.set(`${kind}:${level}`, emptyBucket());
            }
        }
    }
    public add(record: IAiMetaPairRecord): void {
        this.pairs += 1;
        this.games += record.games.length;
        this.mapGames[String(record.map)] = (this.mapGames[String(record.map)] ?? 0) + record.games.length;
        if (rosterSignature(record.armyA.roster) === rosterSignature(record.armyB.roster)) {
            this.distinctRosterViolations += 1;
        }
        if (!rostersAreStrictlyDistinct(record.armyA.roster, record.armyB.roster)) {
            this.overlappingCreatureViolations += 1;
        }
        for (const game of record.games) {
            if (game.winner === "draw") this.draws += 1;
            else if ((game.winner === "a") === game.aIsGreen) this.greenWins += 1;
            else this.redWins += 1;
            this.armageddonDecided += Number(game.armageddonDecided);
            this.rejectedActions += game.rejectedA + game.rejectedB;
            this.endReasons[game.endReason] = (this.endReasons[game.endReason] ?? 0) + 1;
        }
        const outcomeA = sideOutcome(record.games, "a");
        const outcomeB = sideOutcome(record.games, "b");
        this.addUnits(record.armyA, record.armyB, outcomeA, outcomeB);
        this.addArtifact(this.artifactsT1, record.armyA, record.armyB, outcomeA, outcomeB, 1);
        this.addArtifact(this.artifactsT2, record.armyA, record.armyB, outcomeA, outcomeB, 2);
        this.addAugmentPlans(record.armyA, record.armyB, outcomeA, outcomeB);
        this.addAugmentLevels(record.armyA, record.armyB, outcomeA, outcomeB);
        this.addSynergies(record.armyA, record.armyB, outcomeA, outcomeB);
    }
    private addUnits(
        armyA: IAiMetaArmy,
        armyB: IAiMetaArmy,
        outcomeA: ICountedOutcome,
        outcomeB: ICountedOutcome,
    ): void {
        const namesA = new Set(armyA.roster.map((unit) => unit.creatureName));
        const namesB = new Set(armyB.roster.map((unit) => unit.creatureName));
        for (const name of namesA) {
            const bucket = bucketFor(this.units, name);
            bucket.selections += 1;
            if (!namesB.has(name)) {
                bucket.strength.add(outcomeA);
                bucket.policy.add(outcomeA);
            }
        }
        for (const name of namesB) {
            const bucket = bucketFor(this.units, name);
            bucket.selections += 1;
            if (!namesA.has(name)) {
                bucket.strength.add(outcomeB);
                bucket.policy.add(outcomeB);
            }
        }
    }
    private addArtifact(
        buckets: Map<string, IMetricBucket>,
        armyA: IAiMetaArmy,
        armyB: IAiMetaArmy,
        outcomeA: ICountedOutcome,
        outcomeB: ICountedOutcome,
        tier: 1 | 2,
    ): void {
        const choiceA = tier === 1 ? armyA.artifactT1 : armyA.artifactT2;
        const choiceB = tier === 1 ? armyB.artifactT1 : armyB.artifactT2;
        const bucketA = bucketFor(buckets, String(choiceA.id));
        const bucketB = bucketFor(buckets, String(choiceB.id));
        for (const [bucket, mode] of [
            [bucketA, choiceA.mode],
            [bucketB, choiceB.mode],
        ] as const) {
            bucket.selections += 1;
            if (mode === "explore") bucket.exploreSelections += 1;
            else bucket.exploitSelections += 1;
        }
        if (choiceA.id === choiceB.id) {
            bucketA.policy.addCluster([outcomeA, outcomeB]);
            const randomized = [
                ...(choiceA.mode === "explore" ? [outcomeA] : []),
                ...(choiceB.mode === "explore" ? [outcomeB] : []),
            ];
            bucketA.strength.addCluster(randomized);
            return;
        }
        bucketA.policy.add(outcomeA);
        bucketB.policy.add(outcomeB);
        if (choiceA.mode === "explore") bucketA.strength.add(outcomeA);
        if (choiceB.mode === "explore") bucketB.strength.add(outcomeB);
    }
    private addAugmentPlans(
        armyA: IAiMetaArmy,
        armyB: IAiMetaArmy,
        outcomeA: ICountedOutcome,
        outcomeB: ICountedOutcome,
    ): void {
        const bucketA = bucketFor(this.augmentPlans, armyA.augment.planId);
        const bucketB = bucketFor(this.augmentPlans, armyB.augment.planId);
        for (const [bucket, mode] of [
            [bucketA, armyA.augment.mode],
            [bucketB, armyB.augment.mode],
        ] as const) {
            bucket.selections += 1;
            if (mode === "explore") bucket.exploreSelections += 1;
            else bucket.exploitSelections += 1;
        }
        if (armyA.augment.planId === armyB.augment.planId) {
            bucketA.policy.addCluster([outcomeA, outcomeB]);
            const randomized = [
                ...(armyA.augment.mode === "explore" ? [outcomeA] : []),
                ...(armyB.augment.mode === "explore" ? [outcomeB] : []),
            ];
            bucketA.strength.addCluster(randomized);
            return;
        }
        bucketA.policy.add(outcomeA);
        bucketB.policy.add(outcomeB);
        if (armyA.augment.mode === "explore") bucketA.strength.add(outcomeA);
        if (armyB.augment.mode === "explore") bucketB.strength.add(outcomeB);
    }
    private addAugmentLevels(
        armyA: IAiMetaArmy,
        armyB: IAiMetaArmy,
        outcomeA: ICountedOutcome,
        outcomeB: ICountedOutcome,
    ): void {
        for (const kind of ["Placement", "Armor", "Might", "Sniper", "Movement"] as const) {
            const key = kind.toLowerCase() as "placement" | "armor" | "might" | "sniper" | "movement";
            const levelA = armyA.augment.plan[key];
            const levelB = armyB.augment.plan[key];
            const bucketA = bucketFor(this.augmentLevels, `${kind}:${levelA}`);
            const bucketB = bucketFor(this.augmentLevels, `${kind}:${levelB}`);
            for (const [bucket, mode] of [
                [bucketA, armyA.augment.mode],
                [bucketB, armyB.augment.mode],
            ] as const) {
                bucket.selections += 1;
                if (mode === "explore") bucket.exploreSelections += 1;
                else bucket.exploitSelections += 1;
            }
            if (levelA === levelB) {
                bucketA.policy.addCluster([outcomeA, outcomeB]);
                const randomized = [
                    ...(armyA.augment.mode === "explore" ? [outcomeA] : []),
                    ...(armyB.augment.mode === "explore" ? [outcomeB] : []),
                ];
                bucketA.strength.addCluster(randomized);
                continue;
            }
            bucketA.policy.add(outcomeA);
            bucketB.policy.add(outcomeB);
            if (armyA.augment.mode === "explore") bucketA.strength.add(outcomeA);
            if (armyB.augment.mode === "explore") bucketB.strength.add(outcomeB);
        }
    }
    private exactSynergies(army: IAiMetaArmy): Map<string, { faction: number; synergy: number; level: 1 | 2 | 3 }> {
        const exact = new Map<string, { faction: number; synergy: number; level: 1 | 2 | 3 }>();
        for (const choice of army.synergies) {
            if (!aiMetaSynergyDefinition(choice.faction, choice.synergy)) {
                throw new Error(`Unknown AI meta synergy ${choice.faction}:${choice.synergy}`);
            }
            const level = aiMetaSynergyLevel(army.creatureIds, choice.faction);
            if (!level) {
                throw new Error(`Inactive AI meta synergy ${choice.faction}:${choice.synergy}`);
            }
            const key = aiMetaSynergyKey(choice.faction, choice.synergy, level);
            if (exact.has(key)) throw new Error(`Duplicate AI meta synergy ${key}`);
            exact.set(key, { ...choice, level });
        }
        return exact;
    }
    /**
     * Synergies are deterministic and composition-linked, not randomized treatments. The primary tally uses
     * exact-key-exclusive matchups; policyScoreRate retains every selected-army outcome, including same-vs-same.
     */
    private addSynergies(
        armyA: IAiMetaArmy,
        armyB: IAiMetaArmy,
        outcomeA: ICountedOutcome,
        outcomeB: ICountedOutcome,
    ): void {
        const choicesA = this.exactSynergies(armyA);
        const choicesB = this.exactSynergies(armyB);
        for (const key of new Set([...choicesA.keys(), ...choicesB.keys()])) {
            const selectedA = choicesA.has(key);
            const selectedB = choicesB.has(key);
            const bucket = bucketFor(this.synergies, key);
            bucket.selections += Number(selectedA) + Number(selectedB);
            bucket.exploitSelections += Number(selectedA) + Number(selectedB);
            if (selectedA && selectedB) {
                bucket.policy.addCluster([outcomeA, outcomeB]);
                continue;
            }
            const outcome = selectedA ? outcomeA : outcomeB;
            bucket.strength.add(outcome);
            bucket.policy.add(outcome);
        }
    }
    private metricRow(
        key: string,
        name: string,
        bucket: IMetricBucket,
        extra: Partial<IAiMetaMetricRow> = {},
    ): IAiMetaMetricRow {
        const strength = bucket.strength.row();
        const policy = bucket.policy.row();
        return {
            cohort: this.cohort,
            map: this.map,
            key,
            name,
            ...strength,
            selected: bucket.selections,
            pickRate: this.pairs ? bucket.selections / (this.pairs * 2) : 0,
            exploitSelections: bucket.exploitSelections,
            exploreSelections: bucket.exploreSelections,
            policyPairs: policy.pairs,
            policyScoreRate: policy.scoreRate,
            policyWinRate: policy.winRate,
            policyCiLow: policy.ciLow,
            policyCiHigh: policy.ciHigh,
            ...extra,
        };
    }
    public rows(): IAiMetaSummary["rankings"] {
        const units = [...this.units.entries()].map(([name, bucket]) => {
            const level = UNIT_LEVEL_BY_NAME.get(name) ?? 0;
            return this.metricRow(name, name, bucket, { imageKey: `${slug(name)}_512`, kind: "unit", level });
        });
        const artifactsT1 = [...this.artifactsT1.entries()].map(([key, bucket]) =>
            this.metricRow(key, artifactName(1, Number(key)), bucket, {
                imageKey: artifactImageKey(1, Number(key)),
                kind: "artifact",
                tier: 1,
            }),
        );
        const artifactsT2 = [...this.artifactsT2.entries()].map(([key, bucket]) =>
            this.metricRow(key, artifactName(2, Number(key)), bucket, {
                imageKey: artifactImageKey(2, Number(key)),
                kind: "artifact",
                tier: 2,
            }),
        );
        const augmentPlans = [...this.augmentPlans.entries()].map(([key, bucket]) =>
            this.metricRow(key, key, bucket, { kind: "plan", imageKey: "board_augment_256" }),
        );
        const augmentLevels = [...this.augmentLevels.entries()].map(([key, bucket]) => {
            const [kind, level] = key.split(":");
            return this.metricRow(key, `${kind} L${level}`, bucket, {
                kind,
                level: Number(level),
                imageKey: `${kind.toLowerCase() === "placement" ? "board" : kind.toLowerCase()}_augment_256`,
            });
        });
        const synergies = [...this.synergies.entries()].map(([key, bucket]) => {
            const [factionName, synergyText, levelText] = key.split(":");
            const synergy = Number(synergyText);
            const level = Number(levelText);
            const definition = AI_META_SYNERGY_DEFINITIONS.find(
                (candidate) => candidate.factionName === factionName && candidate.synergy === synergy,
            );
            if (!definition || (level !== 1 && level !== 2 && level !== 3)) {
                throw new Error(`Invalid AI meta synergy ranking key ${key}`);
            }
            return this.metricRow(key, `${definition.factionName} · ${definition.synergyName} · L${level}`, bucket, {
                kind: "synergy",
                level,
                faction: definition.faction,
                synergy: definition.synergy,
                imageKey: definition.imageKey,
            });
        });
        for (const rows of [units, artifactsT1, artifactsT2, augmentPlans, augmentLevels, synergies]) {
            rows.sort((left, right) => right.scoreRate - left.scoreRate || right.pairs - left.pairs);
        }
        return { units, artifactsT1, artifactsT2, augmentPlans, augmentLevels, synergies };
    }
}

const UNIT_LEVEL_BY_NAME = new Map<string, number>();

function planKey(plan: { placement: number; armor: number; might: number; sniper: number; movement: number }): string {
    return `P${plan.placement}-A${plan.armor}-M${plan.might}-S${plan.sniper}-V${plan.movement}`;
}

function primeUnitLevels(record: IAiMetaPairRecord): void {
    for (const army of [record.armyA, record.armyB]) {
        for (const unit of army.roster) UNIT_LEVEL_BY_NAME.set(unit.creatureName, unit.level);
    }
}

export function isAiMetaRecordedMap(map: number): map is AiMetaRecordedMap {
    return (AI_META_RECORDED_MAPS as readonly number[]).includes(map);
}

export function isAiMetaLiveMap(map: number): map is (typeof AI_META_MAPS)[number] {
    return (AI_META_MAPS as readonly number[]).includes(map);
}

const dimensionKey = (cohort: string, map: AiMetaMapDimension): string => `${cohort}\u0000${map}`;

/** Aggregate every record across cohort and map dimensions without changing the pair-cluster statistics. */
export class AiMetaAggregation {
    private readonly dimensions = new Map<string, AiMetaAccumulator>();
    private accumulator(cohort: string, map: AiMetaMapDimension): AiMetaAccumulator {
        const key = dimensionKey(cohort, map);
        let accumulator = this.dimensions.get(key);
        if (!accumulator) {
            accumulator = new AiMetaAccumulator(cohort, map);
            this.dimensions.set(key, accumulator);
        }
        return accumulator;
    }
    public add(record: IAiMetaPairRecord): void {
        if (!AI_META_COHORTS.includes(record.cohort)) {
            throw new Error(`Unknown AI meta cohort in pair record: ${record.cohort}`);
        }
        if (!isAiMetaRecordedMap(record.map)) {
            throw new Error(`Unknown AI meta map in pair record: ${record.map}`);
        }
        primeUnitLevels(record);
        for (const [cohort, map] of [
            ["all", "all"],
            [record.cohort, "all"],
            ["all", record.map],
            [record.cohort, record.map],
        ] as const) {
            this.accumulator(cohort, map).add(record);
        }
        if (isAiMetaLiveMap(record.map)) {
            this.accumulator("all", "live").add(record);
            this.accumulator(record.cohort, "live").add(record);
        }
    }
    public get(cohort: string, map: AiMetaMapDimension): AiMetaAccumulator | undefined {
        return this.dimensions.get(dimensionKey(cohort, map));
    }
    public accumulators(): AiMetaAccumulator[] {
        const cohortOrder = (cohort: string): number =>
            cohort === "all" ? -1 : AI_META_COHORTS.indexOf(cohort as AiMetaCohort);
        const mapOrder = (map: AiMetaMapDimension): number =>
            map === "all"
                ? -2
                : map === "live"
                  ? -1
                  : AI_META_RECORDED_MAPS.indexOf(map as (typeof AI_META_RECORDED_MAPS)[number]);
        return [...this.dimensions.values()].sort(
            (left, right) =>
                mapOrder(left.map) - mapOrder(right.map) || cohortOrder(left.cohort) - cohortOrder(right.cohort),
        );
    }
    public rows(): IAiMetaRankings {
        return mergeRankings(this.accumulators());
    }
}

interface IWorkerReady {
    type: "ready";
}

interface IWorkerResult {
    type: "result";
    record: IAiMetaPairRecord;
}

interface IWorkerError {
    type: "error";
    error: string;
}

type WorkerReply = IWorkerReady | IWorkerResult | IWorkerError;

const AI_META_FIXED_ENVIRONMENT = {
    SIM_NO_ACTIONS: "1",
    LIVETWIN: "1",
    FIGHT_MELEE_ROSTERS: "0",
    V08_A13_SEARCH: "1",
} as const;

/** Remove simulation and model experiment flags before a worker statically imports fight-policy modules. */
export function sanitizedAiMetaEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment = { ...source };
    const exact = new Set([
        "COHORT",
        "FORCE_CREATURES",
        "MAPS",
        "PHASE_B_RUN_FINGERPRINT",
        "RANDOM",
        "SIM_NO_ACTIONS",
        "TEAM_WR_RANDOM",
        "VALUE_DATA",
        "VALUE_DATA_FEATURES",
    ]);
    for (const key of Object.keys(environment)) {
        if (/^(?:V\d+_|SEARCH_|Q\d+_|CEM_|FIGHT_|ROSTER_|AUGCA_)/.test(key) || exact.has(key)) {
            delete environment[key];
        }
    }
    return { ...environment, ...AI_META_FIXED_ENVIRONMENT };
}

async function runWorkerPool(
    options: IAiMetaRunOptions,
    concurrency: number,
    onRecord: (record: IAiMetaPairRecord, completed: number, total: number) => void,
): Promise<void> {
    const total = options.games / AI_META_GAMES_PER_MATCHUP;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency), total));
    const workerUrl = new URL("./ai_meta_cohorts_worker.ts", import.meta.url);
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "pair", pair: dispatched });
            dispatched += 1;
        };
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(workerUrl, {
                workerData: { options },
                env: sanitizedAiMetaEnvironment(),
            });
            workers.push(worker);
            worker.on("message", (message: WorkerReply) => {
                if (settled) return;
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                completed += 1;
                onRecord(message.record, completed, total);
                if (completed === total) {
                    settled = true;
                    cleanup();
                    resolvePromise();
                } else {
                    dispatch(worker);
                }
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`AI meta worker exited with code ${code}`));
            });
        }
    });
}

function finishGzip(gzip: Gzip, output: ReturnType<typeof createWriteStream>): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
        output.on("finish", resolvePromise);
        output.on("error", rejectPromise);
        gzip.on("error", rejectPromise);
        gzip.end();
    });
}

const git = (args: string[]): string => {
    try {
        return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch {
        return "unknown";
    }
};

function sourceFingerprint(): string {
    const hash = createHash("sha256");
    const visit = (directory: string): string[] =>
        readdirSync(resolve(process.cwd(), directory), { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
            .flatMap((entry) => {
                const path = join(directory, entry.name);
                return entry.isDirectory() ? visit(path) : entry.isFile() ? [path] : [];
            });
    for (const path of [...visit("src"), "package.json"]) {
        hash.update(path);
        hash.update(readFileSync(resolve(process.cwd(), path)));
    }
    return hash.digest("hex");
}

export interface IAiMetaSourceIdentity {
    commonCommit: string;
    commonDirty: boolean;
    commonStatus: string[];
    sourceSha256: string;
    runtime: string;
}

export function captureAiMetaSourceIdentity(): IAiMetaSourceIdentity {
    const status = git(["status", "--short"]);
    return {
        commonCommit: git(["rev-parse", "HEAD"]),
        commonDirty: Boolean(status),
        commonStatus: status.split("\n").filter(Boolean),
        sourceSha256: sourceFingerprint(),
        runtime: `bun ${process.versions.bun ?? "unknown"}`,
    };
}

function assertAiMetaSourceIdentity(expected: IAiMetaSourceIdentity): void {
    const current = captureAiMetaSourceIdentity();
    if (current.commonCommit !== expected.commonCommit || current.sourceSha256 !== expected.sourceSha256) {
        throw new Error(
            "AI meta source changed between cohort worker waves; preserving the partial run instead of mixing source identities",
        );
    }
}

function mergeRankings(accumulators: readonly AiMetaAccumulator[]): IAiMetaRankings {
    const merged: IAiMetaRankings = {
        units: [],
        artifactsT1: [],
        artifactsT2: [],
        augmentPlans: [],
        augmentLevels: [],
        synergies: [],
    };
    for (const accumulator of accumulators) {
        const rows = accumulator.rows();
        merged.units.push(...rows.units);
        merged.artifactsT1.push(...rows.artifactsT1);
        merged.artifactsT2.push(...rows.artifactsT2);
        merged.augmentPlans.push(...rows.augmentPlans);
        merged.augmentLevels.push(...rows.augmentLevels);
        merged.synergies.push(...rows.synergies);
    }
    return merged;
}

function writeSummary(
    path: string,
    complete: boolean,
    startedAt: string,
    requestedCohorts: readonly AiMetaCohort[],
    gamesPerCohort: number,
    baseSeed: number,
    concurrency: number,
    parallelCohorts: number,
    runIdentity: IAiMetaSourceIdentity,
    qualities: ICohortQuality[],
    aggregation: AiMetaAggregation,
): void {
    const summary: IAiMetaSummary = {
        schemaVersion: AI_META_SCHEMA_VERSION,
        complete,
        generatedAt: new Date().toISOString(),
        provenance: {
            title: "Heroes of Crypto — v0.8+a13 AI Meta Balance Cohorts",
            startedAt,
            gamesPerCohort,
            requestedCohorts,
            totalGames: qualities.reduce((sum, quality) => sum + quality.games, 0),
            totalPairs: qualities.reduce((sum, quality) => sum + quality.pairs, 0),
            baseSeed,
            concurrency,
            parallelCohorts,
            fightVersion: AI_META_FIGHT_VERSION,
            fightProfile: {
                name: AI_META_FIGHT_PROFILE,
                schema: V08_A13_PROFILE.schema,
                candidateId: V08_A13_PROFILE.candidateId,
                genomeSha256: V08_A13_PROFILE.genomeSha256,
                sourceBindingSha256: V08_A13_PROFILE.sourceBindingSha256,
                sourceBehaviorEnvironmentSha256: V08_A13_PROFILE.sourceBehaviorEnvironmentSha256,
                search: V08_A13_PROFILE.search,
                policy: V08_A13_PROFILE.policy,
                workerOverride: "V08_A13_SEARCH=1",
            },
            selectionPolicy: AI_META_POLICY,
            explorationRate: AI_META_EXPLORATION_RATE,
            rankingDimensions: ["units", "artifactsT1", "artifactsT2", "augmentPlans", "augmentLevels", "synergies"],
            synergyTracking: {
                schema: AI_META_SYNERGY_TRACKING,
                policySpec: AI_META_SYNERGY_POLICY_SPEC,
                policySha256: AI_META_SYNERGY_POLICY_SHA256,
                catalogRows: AI_META_SYNERGY_DEFINITIONS.length * 3,
                estimand:
                    "Exact active faction/choice/level associative performance; same-key mirrors excluded from scoreRate.",
            },
            maps: AI_META_MAPS,
            rosterSlots: "2xL1, 2xL2, 1xL3, 1xL4",
            stackSizing: "expBudget (1000 XP per stack)",
            perkAndSynergies: `SEE_NONE (7 points) with ${AI_META_SYNERGY_POLICY_SPEC} faction synergy picks`,
            nonMirroredGuarantee: "Opposing rosters have distinct signatures and no shared creature identities.",
            seatControl: "Each distinct matchup is fought twice with the complete armies and setups swapping seats.",
            interpretation:
                "Artifact and augment strength uses uniform exploration assignments; policyScoreRate describes all contextual-policy selections. Synergy rows are exact active choice/level associations confounded by faction composition, not randomized causal effects. Tier-1/Tier-2 contextual selection is a post-draft oracle, not deployable live timing.",
            ...runIdentity,
        },
        cohorts: qualities,
        rankings: aggregation.rows(),
    };
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
}

interface ICohortRunResult {
    accumulator: AiMetaAccumulator;
    quality: ICohortQuality;
}

async function runCohort(
    cohort: AiMetaCohort,
    gamesPerCohort: number,
    baseSeed: number,
    workers: number,
    outDir: string,
    aggregation: AiMetaAggregation,
): Promise<ICohortRunResult> {
    const options: IAiMetaRunOptions = { cohort, games: gamesPerCohort, baseSeed };
    const accumulator = new AiMetaAccumulator(cohort);
    const rawPath = join(outDir, `${cohort}.pairs.jsonl.gz`);
    const output = createWriteStream(rawPath);
    const gzip = createGzip({ level: 6 });
    gzip.pipe(output);
    const cohortStarted = Date.now();
    let lastPrinted = 0;
    console.log(`\n[${cohort}] ${AI_META_COHORT_DESCRIPTIONS[cohort]} (${workers} workers)`);
    await runWorkerPool(options, workers, (record, completed, total) => {
        accumulator.add(record);
        aggregation.add(record);
        gzip.write(`${JSON.stringify(record)}\n`);
        const now = Date.now();
        if (completed === total || now - lastPrinted >= 10_000) {
            const games = completed * AI_META_GAMES_PER_MATCHUP;
            const elapsed = Math.max(0.001, (now - cohortStarted) / 1000);
            console.log(
                `  [${cohort}] ${games.toLocaleString()}/${gamesPerCohort.toLocaleString()} games ` +
                    `(${(games / elapsed).toFixed(1)}/s, ${Math.floor((100 * completed) / total)}%)`,
            );
            lastPrinted = now;
        }
    });
    await finishGzip(gzip, output);
    const seconds = (Date.now() - cohortStarted) / 1000;
    const quality: ICohortQuality = {
        cohort,
        description: AI_META_COHORT_DESCRIPTIONS[cohort],
        pairs: accumulator.pairs,
        games: accumulator.games,
        greenWins: accumulator.greenWins,
        redWins: accumulator.redWins,
        draws: accumulator.draws,
        armageddonDecided: accumulator.armageddonDecided,
        rejectedActions: accumulator.rejectedActions,
        distinctRosterViolations: accumulator.distinctRosterViolations,
        overlappingCreatureViolations: accumulator.overlappingCreatureViolations,
        mapGames: accumulator.mapGames,
        endReasons: accumulator.endReasons,
        seconds,
        gamesPerSecond: accumulator.games / Math.max(0.001, seconds),
        rawPath: basename(rawPath),
    };
    console.log(
        `  [${cohort}] complete in ${(seconds / 60).toFixed(1)}m; draws ${quality.draws}; ` +
            `rejections ${quality.rejectedActions}; roster violations ` +
            `${quality.distinctRosterViolations + quality.overlappingCreatureViolations}`,
    );
    return { accumulator, quality };
}

const AI_META_USAGE =
    "Usage: bun src/simulation/measure_ai_meta_cohorts.ts " +
    "[games-per-cohort=150000] [base-seed=85000717] [out-dir] [concurrency] [cohorts-csv] [parallel-cohorts]";

export function validateAiMetaGamesPerCohort(games: number): void {
    const mapCycleGames = AI_META_GAMES_PER_MATCHUP * AI_META_MAPS.length;
    if (!Number.isSafeInteger(games) || games < mapCycleGames || games % mapCycleGames !== 0) {
        throw new RangeError(
            `gamesPerCohort must be a positive safe integer divisible by ${mapCycleGames}; got ${games}`,
        );
    }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    if (argv[0] === "--help" || argv[0] === "-h") {
        console.log(AI_META_USAGE);
        return;
    }
    const gamesPerCohort = Number(argv[0] ?? 150_000);
    validateAiMetaGamesPerCohort(gamesPerCohort);
    const baseSeed = Number(argv[1] ?? 85_000_717);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = resolve(argv[2] ?? join(process.cwd(), "sim-out", `ai-meta-${stamp}`));
    const concurrency = Math.min(
        Number(argv[3] ?? Math.min(12, availableParallelism())),
        Math.max(1, gamesPerCohort / 2),
    );
    const requested = (argv[4] ? argv[4].split(",") : [...AI_META_COHORTS]).map((value) => value.trim());
    const cohorts = requested.map((value) => {
        if (!AI_META_COHORTS.includes(value as AiMetaCohort)) {
            throw new Error(`Unknown cohort ${value}; expected ${AI_META_COHORTS.join(", ")}`);
        }
        return value as AiMetaCohort;
    });
    const parallelCohorts = Math.min(Number(argv[5] ?? Math.min(3, cohorts.length)), cohorts.length, concurrency);
    if (!Number.isSafeInteger(baseSeed)) throw new RangeError(`baseSeed must be a safe integer; got ${baseSeed}`);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError(`concurrency must be a positive integer; got ${concurrency}`);
    }
    if (!Number.isInteger(parallelCohorts) || parallelCohorts < 1) {
        throw new RangeError(`parallelCohorts must be a positive integer; got ${parallelCohorts}`);
    }
    mkdirSync(outDir, { recursive: true });
    const summaryPath = join(outDir, "ai-meta.summary.json");
    const startedAt = new Date().toISOString();
    // Freeze identity before workers load the simulation. A shared main working tree may
    // keep changing while this multi-hour run is in progress.
    const runIdentity = captureAiMetaSourceIdentity();
    const aggregation = new AiMetaAggregation();
    const qualities: ICohortQuality[] = [];

    console.log(
        `AI meta: ${cohorts.length} cohorts x ${gamesPerCohort.toLocaleString()} non-mirrored fights, ` +
            `${concurrency} total workers across ${parallelCohorts} parallel cohorts, seed ${baseSeed} -> ${outDir}`,
    );
    console.log(
        `Policy ${AI_META_POLICY}; exploration ${(AI_META_EXPLORATION_RATE * 100).toFixed(0)}% per setup component.`,
    );

    for (let offset = 0; offset < cohorts.length; offset += parallelCohorts) {
        assertAiMetaSourceIdentity(runIdentity);
        const wave = cohorts.slice(offset, offset + parallelCohorts);
        const workersBase = Math.floor(concurrency / wave.length);
        const extraWorkers = concurrency % wave.length;
        const results = await Promise.all(
            wave.map((cohort, index) =>
                runCohort(
                    cohort,
                    gamesPerCohort,
                    baseSeed,
                    workersBase + Number(index < extraWorkers),
                    outDir,
                    aggregation,
                ),
            ),
        );
        for (const result of results) {
            qualities.push(result.quality);
        }
        writeSummary(
            summaryPath,
            false,
            startedAt,
            cohorts,
            gamesPerCohort,
            baseSeed,
            concurrency,
            parallelCohorts,
            runIdentity,
            qualities,
            aggregation,
        );
    }

    writeSummary(
        summaryPath,
        true,
        startedAt,
        cohorts,
        gamesPerCohort,
        baseSeed,
        concurrency,
        parallelCohorts,
        runIdentity,
        qualities,
        aggregation,
    );
    console.log(`\nComplete: ${qualities.reduce((sum, quality) => sum + quality.games, 0).toLocaleString()} fights.`);
    console.log(`Summary: ${summaryPath}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
