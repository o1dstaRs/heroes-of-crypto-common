import {
    AI_META_COHORTS,
    AI_META_GAMES_PER_MATCHUP,
    AI_META_MAPS,
    aiMetaSynergyKey,
    aiMetaSynergyLevel,
    type AiMetaCohort,
    type IAiMetaArmy,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
} from "./ai_meta_cohorts_core";

const INTERACTION_FOLDS = 5;
const INTERACTION_RIDGE_LAMBDA = 4;
const INTERACTION_Z_95 = 1.959963984540054;
const DEFAULT_MINIMUM_PAIR_SUPPORT = 24;
const DEFAULT_MINIMUM_TRIO_SUPPORT = 24;
const DEFAULT_MINIMUM_COUNTER_SUPPORT = 24;

export const AI_META_UNIT_INTERACTION_SCHEMA = "cross-fitted-ridge-unit-interactions-v1";

export interface IAiMetaUnitInteractionRow {
    key: string;
    name: string;
    units: string[];
    pairs: number;
    games: number;
    scoreRate: number;
    scoreCiLow: number;
    scoreCiHigh: number;
    expectedScoreRate: number;
    adjustedLiftPp: number;
    adjustedCiLowPp: number;
    adjustedCiHighPp: number;
    avgHpMargin: number;
}

export interface IAiMetaUnitCounterRow extends IAiMetaUnitInteractionRow {
    unit: string;
    enemyUnit: string;
}

export interface IAiMetaUnitCounterLeaders {
    unit: string;
    counters: IAiMetaUnitCounterRow[];
}

export interface IAiMetaUnitInteractionAnalysis {
    schema: typeof AI_META_UNIT_INTERACTION_SCHEMA;
    scope: {
        maps: number[];
        cohorts: AiMetaCohort[];
        pairs: number;
        games: number;
    };
    method: {
        folds: number;
        ridgeLambda: number;
        controls: string[];
        interpretation: string;
    };
    minimumSupport: {
        allyPairs: number;
        allyTrios: number;
        counters: number;
    };
    allyPairs: IAiMetaUnitInteractionRow[];
    allyTrios: IAiMetaUnitInteractionRow[];
    counters: IAiMetaUnitCounterRow[];
    topCounters: IAiMetaUnitCounterLeaders[];
}

export interface IAiMetaUnitInteractionOptions {
    minimumPairSupport?: number;
    minimumTrioSupport?: number;
    minimumCounterSupport?: number;
}

interface ICompactSide {
    units: number[];
    setupFeatures: number[];
    score: number;
    hpMargin: number;
}

interface ICompactMatchup {
    pair: number;
    fold: number;
    armyA: ICompactSide;
    armyB: ICompactSide;
}

interface IInteractionContext {
    matches: ICompactMatchup[];
}

interface IFeatureValue {
    index: number;
    value: number;
}

interface IPreparedMatchup {
    fold: number;
    armyAFeatures: IFeatureValue[];
    armyBFeatures: IFeatureValue[];
    armyAScore: number;
    armyBScore: number;
}

interface IRidgeStatistics {
    matrix: Float64Array;
    target: Float64Array;
}

interface IInteractionTally {
    unitIds: number[];
    pairs: number;
    scoreSum: number;
    scoreSquareSum: number;
    expectedScoreSum: number;
    residualSum: number;
    residualSquareSum: number;
    hpMarginSum: number;
}

const isLiveMap = (map: number): boolean => (AI_META_MAPS as readonly number[]).includes(map);

const clampScore = (value: number): number => Math.max(0, Math.min(1, value));

const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

function scoreForSide(games: readonly IAiMetaGameOutcome[], side: "a" | "b"): Pick<ICompactSide, "score" | "hpMargin"> {
    let wins = 0;
    let draws = 0;
    let hpMargin = 0;
    for (const game of games) {
        if (game.winner === side) wins += 1;
        else if (game.winner === "draw") draws += 1;
        const direction = side === "a" ? 1 : -1;
        hpMargin += direction * (game.hpA - game.hpB);
    }
    return {
        score: (wins + draws * 0.5) / Math.max(1, games.length),
        hpMargin: hpMargin / Math.max(1, games.length),
    };
}

function addStatistics(statistics: IRidgeStatistics, features: readonly IFeatureValue[], target: number): void {
    for (const left of features) {
        statistics.target[left.index] += left.value * target;
        const rowOffset = left.index * statistics.target.length;
        for (const right of features) {
            statistics.matrix[rowOffset + right.index] += left.value * right.value;
        }
    }
}

function solveRidge(
    all: IRidgeStatistics,
    withheld: IRidgeStatistics,
    dimension: number,
    lambda: number,
): Float64Array {
    if (!dimension) return new Float64Array();
    const matrix = new Float64Array(all.matrix.length);
    const target = new Float64Array(dimension);
    for (let index = 0; index < matrix.length; index += 1) {
        matrix[index] = all.matrix[index] - withheld.matrix[index];
    }
    for (let index = 0; index < dimension; index += 1) {
        matrix[index * dimension + index] += lambda;
        target[index] = all.target[index] - withheld.target[index];
    }
    const left = new Float64Array(matrix.length);
    for (let row = 0; row < dimension; row += 1) {
        const rowOffset = row * dimension;
        for (let column = 0; column <= row; column += 1) {
            let value = matrix[rowOffset + column];
            for (let inner = 0; inner < column; inner += 1) {
                value -= left[rowOffset + inner] * left[column * dimension + inner];
            }
            if (row === column) {
                left[rowOffset + column] = Math.sqrt(Math.max(value, Number.EPSILON));
            } else {
                left[rowOffset + column] = value / left[column * dimension + column];
            }
        }
    }
    const forward = new Float64Array(dimension);
    for (let row = 0; row < dimension; row += 1) {
        let value = target[row];
        const rowOffset = row * dimension;
        for (let column = 0; column < row; column += 1) value -= left[rowOffset + column] * forward[column];
        forward[row] = value / left[rowOffset + row];
    }
    const result = new Float64Array(dimension);
    for (let row = dimension - 1; row >= 0; row -= 1) {
        let value = forward[row];
        for (let column = row + 1; column < dimension; column += 1) {
            value -= left[column * dimension + row] * result[column];
        }
        result[row] = value / left[row * dimension + row];
    }
    return result;
}

function predict(features: readonly IFeatureValue[], coefficients: Float64Array): number {
    let value = 0.5;
    for (const feature of features) value += feature.value * coefficients[feature.index];
    return clampScore(finiteOr(value, 0.5));
}

function normalInterval(sum: number, squareSum: number, count: number, clamp = false): [number, number] {
    if (count < 2) return clamp ? [0, 1] : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
    const mean = sum / count;
    const variance = Math.max(0, (squareSum - (sum * sum) / count) / (count - 1));
    const margin = INTERACTION_Z_95 * Math.sqrt(variance / count);
    const low = mean - margin;
    const high = mean + margin;
    return clamp ? [clampScore(low), clampScore(high)] : [low, high];
}

function tallyFor(tallies: Map<string, IInteractionTally>, key: string, unitIds: readonly number[]): IInteractionTally {
    let tally = tallies.get(key);
    if (!tally) {
        tally = {
            unitIds: [...unitIds],
            pairs: 0,
            scoreSum: 0,
            scoreSquareSum: 0,
            expectedScoreSum: 0,
            residualSum: 0,
            residualSquareSum: 0,
            hpMarginSum: 0,
        };
        tallies.set(key, tally);
    }
    return tally;
}

function addTally(tally: IInteractionTally, side: ICompactSide, expectedScore: number): void {
    const residual = side.score - expectedScore;
    tally.pairs += 1;
    tally.scoreSum += side.score;
    tally.scoreSquareSum += side.score * side.score;
    tally.expectedScoreSum += expectedScore;
    tally.residualSum += residual;
    tally.residualSquareSum += residual * residual;
    tally.hpMarginSum += side.hpMargin;
}

function interactionKey(unitIds: readonly number[]): string {
    return unitIds.join("|");
}

export class AiMetaUnitInteractionCollector {
    private readonly featureIds = new Map<string, number>();
    private readonly featureNames: string[] = [];
    private readonly unitNames = new Map<number, string>();
    private readonly contexts = new Map<string, IInteractionContext>();
    private readonly cohorts = new Set<AiMetaCohort>();
    private readonly maps = new Set<number>();
    private pairs = 0;
    private featureId(name: string): number {
        const existing = this.featureIds.get(name);
        if (existing !== undefined) return existing;
        const next = this.featureNames.length;
        this.featureIds.set(name, next);
        this.featureNames.push(name);
        return next;
    }
    private unitFeatureId(name: string): number {
        const id = this.featureId(`unit:${name}`);
        this.unitNames.set(id, name);
        return id;
    }
    private setupFeatures(army: IAiMetaArmy): number[] {
        const features = [
            this.featureId(`setup:${army.setupCohort}`),
            this.featureId(`artifact-t1:${army.artifactT1.id}`),
            this.featureId(`artifact-t2:${army.artifactT2.id}`),
            this.featureId(`augment:${army.augment.planId}`),
        ];
        for (const choice of army.synergies) {
            const level = aiMetaSynergyLevel(army.creatureIds, choice.faction);
            if (level) {
                features.push(this.featureId(`synergy:${aiMetaSynergyKey(choice.faction, choice.synergy, level)}`));
            }
        }
        return [...new Set(features)].sort((left, right) => left - right);
    }
    private compactSide(army: IAiMetaArmy, games: readonly IAiMetaGameOutcome[], side: "a" | "b"): ICompactSide {
        return {
            units: army.roster
                .map((unit) => this.unitFeatureId(unit.creatureName))
                .sort((left, right) => (this.unitNames.get(left) ?? "").localeCompare(this.unitNames.get(right) ?? "")),
            setupFeatures: this.setupFeatures(army),
            ...scoreForSide(games, side),
        };
    }
    public add(record: IAiMetaPairRecord): void {
        if (!isLiveMap(record.map)) return;
        const key = `${record.cohort}\u0000${record.map}`;
        let context = this.contexts.get(key);
        if (!context) {
            context = { matches: [] };
            this.contexts.set(key, context);
        }
        context.matches.push({
            pair: record.pair,
            fold: Math.abs(record.pair) % INTERACTION_FOLDS,
            armyA: this.compactSide(record.armyA, record.games, "a"),
            armyB: this.compactSide(record.armyB, record.games, "b"),
        });
        this.cohorts.add(record.cohort);
        this.maps.add(record.map);
        this.pairs += 1;
    }
    private contextPredictions(matches: readonly ICompactMatchup[]): { armyA: number[]; armyB: number[] } {
        const featureIds = new Set<number>();
        for (const matchup of matches) {
            for (const featureId of [
                ...matchup.armyA.units,
                ...matchup.armyA.setupFeatures,
                ...matchup.armyB.units,
                ...matchup.armyB.setupFeatures,
            ]) {
                featureIds.add(featureId);
            }
        }
        const localFeatureIndex = new Map<number, number>();
        [...featureIds]
            .sort((left, right) => this.featureNames[left].localeCompare(this.featureNames[right]))
            .forEach((featureId, index) => localFeatureIndex.set(featureId, index));
        const featuresFor = (own: ICompactSide, enemy: ICompactSide): IFeatureValue[] => {
            const values = new Map<number, number>();
            for (const featureId of [...own.units, ...own.setupFeatures]) {
                const index = localFeatureIndex.get(featureId);
                if (index !== undefined) values.set(index, (values.get(index) ?? 0) + 1);
            }
            for (const featureId of [...enemy.units, ...enemy.setupFeatures]) {
                const index = localFeatureIndex.get(featureId);
                if (index !== undefined) values.set(index, (values.get(index) ?? 0) - 1);
            }
            return [...values]
                .filter(([, value]) => value !== 0)
                .map(([index, value]) => ({ index, value }))
                .sort((left, right) => left.index - right.index);
        };
        const prepared: IPreparedMatchup[] = matches.map((matchup) => ({
            fold: matchup.fold,
            armyAFeatures: featuresFor(matchup.armyA, matchup.armyB),
            armyBFeatures: featuresFor(matchup.armyB, matchup.armyA),
            armyAScore: matchup.armyA.score,
            armyBScore: matchup.armyB.score,
        }));
        const dimension = localFeatureIndex.size;
        const total: IRidgeStatistics = {
            matrix: new Float64Array(dimension * dimension),
            target: new Float64Array(dimension),
        };
        const folds = Array.from({ length: INTERACTION_FOLDS }, () => ({
            matrix: new Float64Array(dimension * dimension),
            target: new Float64Array(dimension),
        }));
        for (const matchup of prepared) {
            const foldStatistics = folds[matchup.fold];
            for (const [features, score] of [
                [matchup.armyAFeatures, matchup.armyAScore],
                [matchup.armyBFeatures, matchup.armyBScore],
            ] as const) {
                addStatistics(total, features, score - 0.5);
                addStatistics(foldStatistics, features, score - 0.5);
            }
        }
        const armyA = new Array<number>(matches.length).fill(0.5);
        const armyB = new Array<number>(matches.length).fill(0.5);
        for (let fold = 0; fold < INTERACTION_FOLDS; fold += 1) {
            const coefficients = solveRidge(total, folds[fold], dimension, INTERACTION_RIDGE_LAMBDA);
            prepared.forEach((matchup, index) => {
                if (matchup.fold !== fold) return;
                armyA[index] = predict(matchup.armyAFeatures, coefficients);
                armyB[index] = predict(matchup.armyBFeatures, coefficients);
            });
        }
        return { armyA, armyB };
    }
    private addSide(
        pairTallies: Map<string, IInteractionTally>,
        trioTallies: Map<string, IInteractionTally>,
        counterTallies: Map<string, IInteractionTally>,
        side: ICompactSide,
        enemy: ICompactSide,
        expectedScore: number,
    ): void {
        for (let first = 0; first < side.units.length; first += 1) {
            for (let second = first + 1; second < side.units.length; second += 1) {
                const unitIds = [side.units[first], side.units[second]];
                addTally(tallyFor(pairTallies, interactionKey(unitIds), unitIds), side, expectedScore);
            }
        }
        for (let first = 0; first < side.units.length; first += 1) {
            for (let second = first + 1; second < side.units.length; second += 1) {
                for (let third = second + 1; third < side.units.length; third += 1) {
                    const unitIds = [side.units[first], side.units[second], side.units[third]];
                    addTally(tallyFor(trioTallies, interactionKey(unitIds), unitIds), side, expectedScore);
                }
            }
        }
        for (const unitId of side.units) {
            for (const enemyUnitId of enemy.units) {
                const key = `${unitId}>${enemyUnitId}`;
                addTally(tallyFor(counterTallies, key, [unitId, enemyUnitId]), side, expectedScore);
            }
        }
    }
    private rowFromTally(key: string, tally: IInteractionTally): IAiMetaUnitInteractionRow {
        const units = tally.unitIds.map((unitId) => this.unitNames.get(unitId) ?? this.featureNames[unitId]);
        const stableKey = key.includes(">") ? `${units[0]}>${units[1]}` : units.join("|");
        const scoreRate = tally.scoreSum / tally.pairs;
        const expectedScoreRate = tally.expectedScoreSum / tally.pairs;
        const adjustedLift = tally.residualSum / tally.pairs;
        const [scoreCiLow, scoreCiHigh] = normalInterval(tally.scoreSum, tally.scoreSquareSum, tally.pairs, true);
        const [adjustedCiLow, adjustedCiHigh] = normalInterval(tally.residualSum, tally.residualSquareSum, tally.pairs);
        return {
            key: stableKey,
            name: units.join(" + "),
            units,
            pairs: tally.pairs,
            games: tally.pairs * AI_META_GAMES_PER_MATCHUP,
            scoreRate,
            scoreCiLow,
            scoreCiHigh,
            expectedScoreRate,
            adjustedLiftPp: adjustedLift * 100,
            adjustedCiLowPp: adjustedCiLow * 100,
            adjustedCiHighPp: adjustedCiHigh * 100,
            avgHpMargin: tally.hpMarginSum / tally.pairs,
        };
    }
    public analyze(options: IAiMetaUnitInteractionOptions = {}): IAiMetaUnitInteractionAnalysis {
        const minimumPairSupport = options.minimumPairSupport ?? DEFAULT_MINIMUM_PAIR_SUPPORT;
        const minimumTrioSupport = options.minimumTrioSupport ?? DEFAULT_MINIMUM_TRIO_SUPPORT;
        const minimumCounterSupport = options.minimumCounterSupport ?? DEFAULT_MINIMUM_COUNTER_SUPPORT;
        const pairTallies = new Map<string, IInteractionTally>();
        const trioTallies = new Map<string, IInteractionTally>();
        const counterTallies = new Map<string, IInteractionTally>();
        for (const [, context] of [...this.contexts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const matches = [...context.matches].sort((left, right) => left.pair - right.pair);
            const predictions = this.contextPredictions(matches);
            matches.forEach((matchup, index) => {
                this.addSide(
                    pairTallies,
                    trioTallies,
                    counterTallies,
                    matchup.armyA,
                    matchup.armyB,
                    predictions.armyA[index],
                );
                this.addSide(
                    pairTallies,
                    trioTallies,
                    counterTallies,
                    matchup.armyB,
                    matchup.armyA,
                    predictions.armyB[index],
                );
            });
        }
        const compareRows = (left: IAiMetaUnitInteractionRow, right: IAiMetaUnitInteractionRow): number =>
            right.adjustedLiftPp - left.adjustedLiftPp ||
            right.adjustedCiLowPp - left.adjustedCiLowPp ||
            right.pairs - left.pairs ||
            left.name.localeCompare(right.name);
        const allyPairs = [...pairTallies.entries()]
            .filter(([, tally]) => tally.pairs >= minimumPairSupport)
            .map(([key, tally]) => this.rowFromTally(key, tally))
            .sort(compareRows);
        const allyTrios = [...trioTallies.entries()]
            .filter(([, tally]) => tally.pairs >= minimumTrioSupport)
            .map(([key, tally]) => this.rowFromTally(key, tally))
            .sort(compareRows);
        const counters = [...counterTallies.entries()]
            .filter(([, tally]) => tally.pairs >= minimumCounterSupport)
            .map(([key, tally]) => {
                const row = this.rowFromTally(key, tally);
                return { ...row, unit: row.units[0], enemyUnit: row.units[1] };
            })
            .sort(compareRows);
        const topCounters = [...this.unitNames.values()]
            .sort((left, right) => left.localeCompare(right))
            .map((unit) => ({
                unit,
                counters: counters
                    .filter((counter) => counter.unit === unit)
                    .sort(compareRows)
                    .slice(0, 5),
            }));
        return {
            schema: AI_META_UNIT_INTERACTION_SCHEMA,
            scope: {
                maps: [...this.maps].sort((left, right) => left - right),
                cohorts: AI_META_COHORTS.filter((cohort) => this.cohorts.has(cohort)),
                pairs: this.pairs,
                games: this.pairs * AI_META_GAMES_PER_MATCHUP,
            },
            method: {
                folds: INTERACTION_FOLDS,
                ridgeLambda: INTERACTION_RIDGE_LAMBDA,
                controls: [
                    "own and opposing unit main effects",
                    "tier-1 and tier-2 artifact choices",
                    "exact augment plan",
                    "exact active faction synergy choice and level",
                    "setup cohort",
                    "separate cohort-and-map models",
                ],
                interpretation:
                    "Cross-fitted adjusted associations, not randomized causal effects. Positive lift means the observed side outperformed its held-out additive roster-and-setup expectation.",
            },
            minimumSupport: {
                allyPairs: minimumPairSupport,
                allyTrios: minimumTrioSupport,
                counters: minimumCounterSupport,
            },
            allyPairs,
            allyTrios,
            counters,
            topCounters,
        };
    }
}
