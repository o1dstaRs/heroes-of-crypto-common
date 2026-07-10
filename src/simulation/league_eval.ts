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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getUpgradePoints } from "../perks/perk_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    isPickSimComplete,
    transitionPickSim,
    type IPickSimState,
    type PickAction,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    hashSimulationParts,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
} from "./army";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import {
    createLeagueGenome,
    createMeleeLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_DIM,
    LEAGUE_SCHEMA_VERSION,
    leagueOpponentCreatures,
    pickLeagueAugments,
    pickLeagueBundle,
    pickLeagueCreature,
    pickLeaguePerk,
    pickLeaguePlacement,
    pickLeagueTier2,
    type ILeagueGenome,
    type LeaguePlacementTemplate,
} from "./league_genome";
import { creatureInfo } from "../ai/setup/creature_score";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const PAIR_SEED_STEP = 0x9e3779b1;

export type LeagueAggregateMethod = "worst-case" | "softmin";

export interface ILeaguePoolEntry extends ILeagueGenome {
    /** Prior mass used by the entropy-regularized adversary. Omit for a uniform prior. */
    prior?: number;
}

export interface ILeagueEvaluationOptions {
    gamesPerOpponent: number;
    baseSeed: number;
    concurrency?: number;
    fightVersion?: string;
    maxLaps?: number;
    mapTypes?: readonly number[];
    /** Default true: preserve the roadmap's SEE_NONE anchor until reveal-frequency evidence exists. */
    freezePerk?: boolean;
    aggregate?: LeagueAggregateMethod;
    /** Probability scale for the entropy-regularized adversarial pool. Default 0.025. */
    softminTemperature?: number;
    /** Normal-approximation z used by the Wilson lower bound. Default 1.96 (95%). */
    confidenceZ?: number;
}

export interface INormalizedLeagueOptions {
    gamesPerOpponent: number;
    baseSeed: number;
    concurrency: number;
    fightVersion: string;
    maxLaps: number;
    mapTypes: number[];
    freezePerk: boolean;
    aggregate: LeagueAggregateMethod;
    softminTemperature: number;
    confidenceZ: number;
}

export interface IResolvedLeaguePick {
    state: IPickSimState;
    lowerPlacement: LeaguePlacementTemplate;
    upperPlacement: LeaguePlacementTemplate;
    lowerAugments: ReturnType<typeof pickLeagueAugments>;
    upperAugments: ReturnType<typeof pickLeagueAugments>;
}

export interface ILeagueGameRecord {
    opponentId: string;
    game: number;
    pairSeed: number;
    candidateSide: Side;
    winner: Side | "draw";
    candidateResult: "win" | "loss" | "draw";
    laps: number;
    collisions: number;
}

export interface ILeagueOpponentResult {
    opponentId: string;
    prior: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveGames: number;
    decisiveWinRate: number;
    wilsonLowerBound: number;
}

export interface ILeagueAggregate {
    method: LeagueAggregateMethod;
    fitness: number;
    worstCaseLowerBound: number;
    worstCaseOpponent: string;
    softminLowerBound: number;
    adversarialMixture: { opponentId: string; weight: number }[];
}

export interface ILeagueEvaluationReport {
    schemaVersion: 1;
    status: "measurement_only";
    generatedAt: string;
    candidateId: string;
    totalGames: number;
    options: Omit<INormalizedLeagueOptions, "concurrency"> & { concurrency: number };
    opponents: ILeagueOpponentResult[];
    aggregate: ILeagueAggregate;
    limitations: string[];
    provenance: {
        pickPhase: "common/picks/pick_sim";
        stackAmounts: "LiveTwin expBudget";
        setup: "genome heads; synergies frozen at setup-v0";
        fightVector: string;
        uncertainty: "Wilson lower bound over decisive games";
        nashQualification: string;
    };
}

export interface ILeagueEvaluationDependencies {
    matchRunner: (config: IMatchConfig) => IMatchResult;
    now: () => Date;
}

const DEFAULT_DEPENDENCIES: ILeagueEvaluationDependencies = { matchRunner: runMatch, now: () => new Date() };

export function defaultLeaguePool(): ILeaguePoolEntry[] {
    return [
        { ...createLeagueGenome("anchor"), prior: 1 },
        { ...createMeleeLeagueGenome(), prior: 1 },
    ];
}

function normalizeOptions(options: ILeagueEvaluationOptions): INormalizedLeagueOptions {
    if (!Number.isInteger(options.gamesPerOpponent) || options.gamesPerOpponent < 2 || options.gamesPerOpponent % 2) {
        throw new RangeError("gamesPerOpponent must be an even integer >= 2 so every pick is seat-mirrored");
    }
    if (!Number.isInteger(options.baseSeed) || options.baseSeed < 0) {
        throw new RangeError("baseSeed must be a non-negative integer");
    }
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError("concurrency must be a positive integer");
    }
    const maxLaps = options.maxLaps ?? 60;
    if (!Number.isInteger(maxLaps) || maxLaps < 1) {
        throw new RangeError("maxLaps must be a positive integer");
    }
    const fightVersion = options.fightVersion ?? "v0.6";
    if (!fightVersion.trim()) {
        throw new TypeError("fightVersion must not be empty");
    }
    const aggregate = options.aggregate ?? "worst-case";
    if (aggregate !== "worst-case" && aggregate !== "softmin") {
        throw new RangeError("aggregate must be worst-case or softmin");
    }
    const mapTypes = options.mapTypes?.length ? [...options.mapTypes] : [PBTypes.GridVals.NORMAL];
    if (!mapTypes.every((mapType) => Number.isInteger(mapType) && mapType >= 1 && mapType <= 4)) {
        throw new RangeError("mapTypes must contain GridVals ids in [1, 4]");
    }
    const softminTemperature = options.softminTemperature ?? 0.025;
    if (!Number.isFinite(softminTemperature) || softminTemperature <= 0) {
        throw new RangeError("softminTemperature must be positive");
    }
    const confidenceZ = options.confidenceZ ?? 1.96;
    if (!Number.isFinite(confidenceZ) || confidenceZ <= 0) {
        throw new RangeError("confidenceZ must be positive");
    }
    return {
        gamesPerOpponent: options.gamesPerOpponent,
        baseSeed: options.baseSeed >>> 0,
        concurrency,
        fightVersion,
        maxLaps,
        mapTypes,
        freezePerk: options.freezePerk ?? true,
        aggregate,
        softminTemperature,
        confidenceZ,
    };
}

function validateEntrants(candidate: ILeagueGenome, pool: readonly ILeaguePoolEntry[]): void {
    createLeagueGenome(candidate.id, candidate.weights, !!candidate.omniscientDraft);
    if (candidate.omniscientDraft) {
        throw new Error("The evaluated candidate must be deployable and cannot use omniscientDraft");
    }
    if (!pool.length) {
        throw new RangeError("League exploiter/champion pool must not be empty");
    }
    const ids = new Set<string>();
    for (const opponent of pool) {
        createLeagueGenome(opponent.id, opponent.weights, !!opponent.omniscientDraft);
        if (ids.has(opponent.id)) {
            throw new Error(`Duplicate league pool id: ${opponent.id}`);
        }
        ids.add(opponent.id);
        if (opponent.prior !== undefined && (!Number.isFinite(opponent.prior) || opponent.prior <= 0)) {
            throw new RangeError(`Pool prior for ${opponent.id} must be positive`);
        }
    }
}

const randomInt = (seed: number): PickRandomInt => {
    const rng = makeRng(seed);
    return (maxExclusive) => Math.floor(rng() * maxExclusive);
};

function applyAccepted(state: IPickSimState, action: PickAction, rng: PickRandomInt): IPickSimState {
    const result = transitionPickSim(state, action, rng);
    if (result.status !== "accepted") {
        throw new Error(`League policy emitted ${action.type} rejected as ${result.reason}`);
    }
    return result.state;
}

/** Drive both policies through the exact live reducer. Bundle and T2 choices are computed before either
 * simultaneous actor is committed; creature collisions reveal the occupied slot and retry from the new view. */
export function resolveLeaguePick(
    seed: number,
    lowerGenome: ILeagueGenome,
    upperGenome: ILeagueGenome,
    freezePerk: boolean = true,
): IResolvedLeaguePick {
    const rng = randomInt(seed);
    let state = createPickSimState(rng);
    const genomeFor = (team: PickTeam): ILeagueGenome => (team === LOWER ? lowerGenome : upperGenome);

    const lowerPerk = pickLeaguePerk(lowerGenome, freezePerk);
    const upperPerk = pickLeaguePerk(upperGenome, freezePerk);
    state = applyAccepted(state, { type: "select_perk", team: LOWER, perk: lowerPerk }, rng);
    state = applyAccepted(state, { type: "select_perk", team: UPPER, perk: upperPerk }, rng);

    const lowerBundle = pickLeagueBundle(state, LOWER, lowerGenome);
    const upperBundle = pickLeagueBundle(state, UPPER, upperGenome);
    state = applyAccepted(state, { type: "select_bundle", team: LOWER, bundleIndex: lowerBundle }, rng);
    state = applyAccepted(state, { type: "select_bundle", team: UPPER, bundleIndex: upperBundle }, rng);

    let transitions = 0;
    while (!isPickSimComplete(state)) {
        transitions += 1;
        if (transitions > 40) {
            throw new Error("League pick exceeded the collision retry guard");
        }
        const phase = getCurrentPickPhase(state);
        if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
            const lowerArtifact = pickLeagueTier2(state, LOWER, lowerGenome);
            const upperArtifact = pickLeagueTier2(state, UPPER, upperGenome);
            state = applyAccepted(state, { type: "select_tier2", team: LOWER, artifactId: lowerArtifact }, rng);
            state = applyAccepted(state, { type: "select_tier2", team: UPPER, artifactId: upperArtifact }, rng);
            continue;
        }
        if (phase.phase !== PBTypes.PickPhaseVals.PICK || phase.actors.length !== 1) {
            throw new Error(`Unexpected live pick phase ${phase.phase} at sequence ${state.phaseSequence}`);
        }
        const team = phase.actors[0];
        const creatureId = pickLeagueCreature(state, team, genomeFor(team));
        const result = transitionPickSim(state, { type: "pick_creature", team, creatureId }, rng);
        if (result.status === "rejected") {
            throw new Error(`League creature policy was rejected as ${result.reason}`);
        }
        state = result.state;
    }

    const lowerOpponent = leagueOpponentCreatures(state, LOWER, !!lowerGenome.omniscientDraft);
    const upperOpponent = leagueOpponentCreatures(state, UPPER, !!upperGenome.omniscientDraft);
    return {
        state,
        lowerPlacement: pickLeaguePlacement(state.lower.creatures, lowerOpponent, lowerGenome),
        upperPlacement: pickLeaguePlacement(state.upper.creatures, upperOpponent, upperGenome),
        lowerAugments: pickLeagueAugments(
            state.lower.creatures,
            lowerOpponent,
            getUpgradePoints(state.lower.perk),
            lowerGenome,
        ),
        upperAugments: pickLeagueAugments(
            state.upper.creatures,
            upperOpponent,
            getUpgradePoints(state.upper.perk),
            upperGenome,
        ),
    };
}

export function leagueRoster(creatureIds: readonly number[]): IArmyUnitSpec[] {
    return creatureIds.map((creatureId) => {
        const info = creatureInfo(creatureId);
        if (!info) {
            throw new Error(`League pick selected unknown creature id ${creatureId}`);
        }
        const catalog = creaturesByLevel(info.level).find((entry) => entry.creatureName === info.name);
        if (!catalog) {
            throw new Error(`League pick selected disabled creature ${info.name}`);
        }
        return {
            faction: catalog.faction,
            creatureName: catalog.creatureName,
            level: catalog.level,
            size: catalog.size,
            amount: resolveStackAmount(catalog.creatureName, catalog.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

function withFightEnvironment<T>(
    lowerPlacement: LeaguePlacementTemplate,
    upperPlacement: LeaguePlacementTemplate,
    run: () => T,
): T {
    const overrides: Record<string, string> = {
        LIVETWIN: "1",
        SIM_NO_ACTIONS: "1",
        V07_SEARCH: "0",
        Q2_WAIT_ABLATION: "0",
        V06_CASTER_ROUTER: "off",
        V06_AREA_THROW: "off",
        V06_RIDER_EV: "off",
        V06_DISPERSE_TEAM:
            lowerPlacement === "adaptive" && upperPlacement === "adaptive"
                ? "both"
                : lowerPlacement === "adaptive"
                  ? "lower"
                  : upperPlacement === "adaptive"
                    ? "upper"
                    : "none",
    };
    const before = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
        return run();
    } finally {
        for (const [key, value] of before) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

export function playLeagueGame(
    candidate: ILeagueGenome,
    opponent: ILeaguePoolEntry,
    options: ILeagueEvaluationOptions,
    game: number,
    dependencies: Partial<ILeagueEvaluationDependencies> = {},
): ILeagueGameRecord {
    const normalized = normalizeOptions(options);
    if (!Number.isInteger(game) || game < 0 || game >= normalized.gamesPerOpponent) {
        throw new RangeError(`game must be in [0, ${normalized.gamesPerOpponent})`);
    }
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const pairIndex = Math.floor(game / 2);
    const pairSeed = (normalized.baseSeed + Math.imul(pairIndex, PAIR_SEED_STEP)) >>> 0;
    const pickSeed = hashSimulationParts("league-pick", pairSeed);
    const battleSeed = hashSimulationParts("league-battle", pairSeed);
    const candidateIsLower = game % 2 === 0;
    const lowerGenome = candidateIsLower ? candidate : opponent;
    const upperGenome = candidateIsLower ? opponent : candidate;
    const pick = resolveLeaguePick(pickSeed, lowerGenome, upperGenome, normalized.freezePerk);
    const lowerRoster = leagueRoster(pick.state.lower.creatures);
    const upperRoster = leagueRoster(pick.state.upper.creatures);
    const gridType = normalized.mapTypes[pairIndex % normalized.mapTypes.length];
    const lowerSynergies = SETUP_POLICY_V0.pickSynergies(pick.state.lower.creatures);
    const upperSynergies = SETUP_POLICY_V0.pickSynergies(pick.state.upper.creatures);
    const result = withFightEnvironment(pick.lowerPlacement, pick.upperPlacement, () =>
        deps.matchRunner({
            greenVersion: normalized.fightVersion,
            redVersion: normalized.fightVersion,
            roster: lowerRoster,
            redRoster: upperRoster,
            seed: battleSeed,
            maxLaps: normalized.maxLaps,
            gridType,
            greenArtifactT1: pick.state.lower.tier1Artifact,
            redArtifactT1: pick.state.upper.tier1Artifact,
            greenArtifactT2: pick.state.lower.tier2Artifact,
            redArtifactT2: pick.state.upper.tier2Artifact,
            greenPerk: pick.state.lower.perk,
            redPerk: pick.state.upper.perk,
            greenAugments: pick.lowerAugments,
            redAugments: pick.upperAugments,
            greenSynergies: lowerSynergies,
            redSynergies: upperSynergies,
        }),
    );
    const candidateSide: Side = candidateIsLower ? "green" : "red";
    return {
        opponentId: opponent.id,
        game,
        pairSeed,
        candidateSide,
        winner: result.winner,
        candidateResult: result.winner === "draw" ? "draw" : result.winner === candidateSide ? "win" : "loss",
        laps: result.laps,
        collisions: pick.state.transcript.filter((entry) => entry.type === "creature_collision").length,
    };
}

export function wilsonLowerBound(wins: number, losses: number, z: number = 1.96): number {
    const total = wins + losses;
    if (!total) {
        return 0;
    }
    const p = wins / total;
    const z2 = z * z;
    const center = p + z2 / (2 * total);
    const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
    return Math.max(0, (center - spread) / (1 + z2 / total));
}

export function summarizeLeagueRecords(
    candidate: ILeagueGenome,
    pool: readonly ILeaguePoolEntry[],
    options: ILeagueEvaluationOptions,
    records: readonly ILeagueGameRecord[],
    generatedAt: Date = new Date(),
): ILeagueEvaluationReport {
    const normalized = normalizeOptions(options);
    validateEntrants(candidate, pool);
    const opponentIds = new Set(pool.map((entry) => entry.id));
    const unknownRecord = records.find((record) => !opponentIds.has(record.opponentId));
    if (unknownRecord) {
        throw new Error(`League record names unknown opponent ${unknownRecord.opponentId}`);
    }
    const rawPriors = pool.map((entry) => entry.prior ?? 1);
    const priorTotal = rawPriors.reduce((sum, prior) => sum + prior, 0);
    const opponents = pool.map((entry, index): ILeagueOpponentResult => {
        const own = records.filter((record) => record.opponentId === entry.id);
        if (own.length !== normalized.gamesPerOpponent) {
            throw new Error(
                `League opponent ${entry.id} has ${own.length} records; expected ${normalized.gamesPerOpponent}`,
            );
        }
        const gameIds = new Set(own.map((record) => record.game));
        if (
            gameIds.size !== normalized.gamesPerOpponent ||
            [...gameIds].some((game) => game < 0 || game >= normalized.gamesPerOpponent)
        ) {
            throw new Error(`League opponent ${entry.id} has duplicate or out-of-range game ids`);
        }
        const wins = own.filter((record) => record.candidateResult === "win").length;
        const losses = own.filter((record) => record.candidateResult === "loss").length;
        const draws = own.length - wins - losses;
        const decisiveGames = wins + losses;
        return {
            opponentId: entry.id,
            prior: rawPriors[index] / priorTotal,
            games: own.length,
            wins,
            losses,
            draws,
            decisiveGames,
            decisiveWinRate: decisiveGames ? wins / decisiveGames : 0.5,
            wilsonLowerBound: wilsonLowerBound(wins, losses, normalized.confidenceZ),
        };
    });
    const worst = opponents.reduce((left, right) => (right.wilsonLowerBound < left.wilsonLowerBound ? right : left));
    const minimum = worst.wilsonLowerBound;
    const unnormalized = opponents.map(
        (opponent) => opponent.prior * Math.exp(-(opponent.wilsonLowerBound - minimum) / normalized.softminTemperature),
    );
    const adversaryTotal = unnormalized.reduce((sum, weight) => sum + weight, 0);
    const adversarialMixture = opponents.map((opponent, index) => ({
        opponentId: opponent.opponentId,
        weight: unnormalized[index] / adversaryTotal,
    }));
    const softminLowerBound = minimum - normalized.softminTemperature * Math.log(adversaryTotal);
    const aggregate: ILeagueAggregate = {
        method: normalized.aggregate,
        fitness: normalized.aggregate === "worst-case" ? minimum : softminLowerBound,
        worstCaseLowerBound: minimum,
        worstCaseOpponent: worst.opponentId,
        softminLowerBound,
        adversarialMixture,
    };
    return {
        schemaVersion: 1,
        status: "measurement_only",
        generatedAt: generatedAt.toISOString(),
        candidateId: candidate.id,
        totalGames: records.length,
        options: normalized,
        opponents,
        aggregate,
        limitations: [
            "The built-in anchor/melee pool is a bootstrap smoke pool, not a powered acceptance panel; provide accumulated champions and exploiters with --pool.",
            "The placement head selects the existing v0.6 adaptive-dispersion or tight template; placement-zone expansion and stack splitting are not yet engine action-space choices.",
            "SEE_NONE remains frozen by default; use --unfreeze-perk only for an explicit reveal-value experiment.",
            "No training or bake verdict is inferred from this report; acceptance still requires fresh-seed powered evaluation.",
        ],
        provenance: {
            pickPhase: "common/picks/pick_sim",
            stackAmounts: "LiveTwin expBudget",
            setup: "genome heads; synergies frozen at setup-v0",
            fightVector: `${normalized.fightVersion} for both sides`,
            uncertainty: "Wilson lower bound over decisive games",
            nashQualification:
                "softmin is an entropy-regularized adversarial response over the configured pool; a full Nash equilibrium requires a complete entrant-by-entrant payoff matrix",
        },
    };
}

export function evaluateLeagueCandidateSequential(
    candidate: ILeagueGenome,
    pool: readonly ILeaguePoolEntry[],
    options: ILeagueEvaluationOptions,
    dependencies: Partial<ILeagueEvaluationDependencies> = {},
): ILeagueEvaluationReport {
    const normalized = normalizeOptions(options);
    validateEntrants(candidate, pool);
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const records: ILeagueGameRecord[] = [];
    for (const opponent of pool) {
        for (let game = 0; game < normalized.gamesPerOpponent; game += 1) {
            records.push(playLeagueGame(candidate, opponent, normalized, game, deps));
        }
    }
    return summarizeLeagueRecords(candidate, pool, normalized, records, deps.now());
}

type LeagueWorkerMessage = { type: "ready" } | { type: "result"; opponentIndex: number; record: ILeagueGameRecord };

interface ILeagueWorkerData {
    candidate: ILeagueGenome;
    pool: ILeaguePoolEntry[];
    options: INormalizedLeagueOptions;
}

/** Fight policies have several simulation-only environment overrides, some read at module initialization.
 * League workers start from a clean copy so an ambient CEM/A-B shell cannot silently mutate the frozen fight. */
function frozenWorkerEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (
            key.startsWith("V05_") ||
            key.startsWith("V06_") ||
            key.startsWith("V07_") ||
            key.startsWith("SEARCH_") ||
            key.startsWith("Q2_") ||
            key === "VALUE_DATA"
        ) {
            delete environment[key];
        }
    }
    return environment;
}

export function evaluateLeagueCandidate(
    candidate: ILeagueGenome,
    pool: readonly ILeaguePoolEntry[],
    options: ILeagueEvaluationOptions,
): Promise<ILeagueEvaluationReport> {
    const normalized = normalizeOptions(options);
    validateEntrants(candidate, pool);
    const total = normalized.gamesPerOpponent * pool.length;
    const concurrency = Math.min(normalized.concurrency, total);
    return new Promise((resolvePromise, rejectPromise) => {
        const records: ILeagueGameRecord[] = [];
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
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
            const opponentIndex = Math.floor(dispatched / normalized.gamesPerOpponent);
            const game = dispatched % normalized.gamesPerOpponent;
            dispatched += 1;
            worker.postMessage({ type: "game", opponentIndex, game });
        };
        for (let index = 0; index < concurrency; index += 1) {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: { candidate, pool: [...pool], options: normalized } satisfies ILeagueWorkerData,
                env: frozenWorkerEnvironment(),
            });
            workers.push(worker);
            worker.on("message", (message: LeagueWorkerMessage) => {
                if (settled) return;
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                completed += 1;
                if (completed === total) {
                    settled = true;
                    cleanup();
                    resolvePromise(summarizeLeagueRecords(candidate, pool, normalized, records));
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) {
                    fail(new Error(`League worker exited ${code} before completing its jobs`));
                }
            });
        }
    });
}

function parseGenome(raw: unknown, fallbackId: string): ILeagueGenome {
    if (Array.isArray(raw)) {
        return createLeagueGenome(fallbackId, raw as number[]);
    }
    if (!raw || typeof raw !== "object") {
        throw new TypeError("Genome JSON must be a weight array or an object with id and weights");
    }
    const value = raw as Partial<ILeagueGenome>;
    if (value.schemaVersion !== undefined && value.schemaVersion !== LEAGUE_SCHEMA_VERSION) {
        throw new Error(`Unsupported league genome schema ${value.schemaVersion}`);
    }
    return createLeagueGenome(value.id ?? fallbackId, value.weights ?? [], !!value.omniscientDraft);
}

export function loadLeagueGenome(specifier: string, cwd: string = process.cwd()): ILeagueGenome {
    if (specifier === "anchor") return createLeagueGenome("anchor", LEAGUE_ANCHOR_GENOME);
    if (specifier === "melee" || specifier === "melee_coevo") return createMeleeLeagueGenome();
    return parseGenome(JSON.parse(readFileSync(resolve(cwd, specifier), "utf8")), "candidate");
}

export function loadLeaguePool(specifier: string | undefined, cwd: string = process.cwd()): ILeaguePoolEntry[] {
    if (!specifier || specifier === "default") return defaultLeaguePool();
    const parsed = JSON.parse(readFileSync(resolve(cwd, specifier), "utf8")) as unknown;
    const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown[] }).entries)
          ? (parsed as { entries: unknown[] }).entries
          : undefined;
    if (!entries) {
        throw new TypeError("League pool JSON must be an array or { entries: [...] }");
    }
    return entries.map((entry, index) => {
        const genome = parseGenome(entry, `opponent-${index}`);
        const prior = (entry as { prior?: unknown }).prior;
        return {
            ...genome,
            ...(prior === undefined ? {} : { prior: Number(prior) }),
        };
    });
}

interface ILeagueCliOptions extends ILeagueEvaluationOptions {
    candidate: ILeagueGenome;
    pool: ILeaguePoolEntry[];
    outputPath?: string;
    validateOnly: boolean;
}

export function parseLeagueEvalArgs(argv: readonly string[], cwd: string = process.cwd()): ILeagueCliOptions {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument: ${argument}`);
        const [key, inline] = argument.slice(2).split("=", 2);
        if (key === "validate" || key === "unfreeze-perk") {
            flags.add(key);
            continue;
        }
        const value = inline ?? argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
        values.set(key, value);
    }
    const candidateJson = values.get("candidate-json");
    const candidate = candidateJson
        ? parseGenome(JSON.parse(candidateJson), "candidate")
        : loadLeagueGenome(values.get("candidate") ?? "anchor", cwd);
    const pool = loadLeaguePool(values.get("pool"), cwd);
    return {
        candidate,
        pool,
        gamesPerOpponent: Number(values.get("games") ?? 200),
        baseSeed: Number(values.get("seed") ?? 1),
        concurrency: Number(values.get("concurrency") ?? 1),
        fightVersion: values.get("fight-version") ?? "v0.6",
        maxLaps: Number(values.get("max-laps") ?? 60),
        mapTypes: (values.get("maps") ?? String(PBTypes.GridVals.NORMAL)).split(",").map(Number),
        freezePerk: !flags.has("unfreeze-perk"),
        aggregate: (values.get("aggregate") ?? "worst-case") as LeagueAggregateMethod,
        softminTemperature: Number(values.get("temperature") ?? 0.025),
        confidenceZ: Number(values.get("confidence-z") ?? 1.96),
        outputPath: values.get("output") ? resolve(cwd, values.get("output")!) : undefined,
        validateOnly: flags.has("validate"),
    };
}

async function cliMain(): Promise<void> {
    const options = parseLeagueEvalArgs(process.argv.slice(2));
    const normalized = normalizeOptions(options);
    validateEntrants(options.candidate, options.pool);
    if (options.aggregate !== "worst-case" && options.aggregate !== "softmin") {
        throw new Error("--aggregate must be worst-case or softmin");
    }
    if (options.validateOnly) {
        process.stdout.write(
            `${JSON.stringify({
                valid: true,
                schemaVersion: LEAGUE_SCHEMA_VERSION,
                dimension: LEAGUE_GENOME_DIM,
                candidateId: options.candidate.id,
                pool: options.pool.map(({ id, prior, omniscientDraft }) => ({
                    id,
                    prior: prior ?? 1,
                    omniscientDraft: !!omniscientDraft,
                })),
                options: normalized,
            })}\n`,
        );
        return;
    }
    const report = await evaluateLeagueCandidate(options.candidate, options.pool, normalized);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, json);
    }
    process.stdout.write(json);
}

function workerMain(data: ILeagueWorkerData): void {
    if (!parentPort) throw new Error("league_eval worker requires a parent port");
    parentPort.on("message", (message: { type: "game"; opponentIndex: number; game: number } | { type: "stop" }) => {
        if (message.type === "stop") {
            parentPort.close();
            return;
        }
        const opponent = data.pool[message.opponentIndex];
        const record = playLeagueGame(data.candidate, opponent, data.options, message.game);
        parentPort!.postMessage({ type: "result", opponentIndex: message.opponentIndex, record });
    });
    parentPort.postMessage({ type: "ready" });
}

if (!isMainThread) {
    workerMain(workerData as ILeagueWorkerData);
} else if (import.meta.main) {
    cliMain().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
