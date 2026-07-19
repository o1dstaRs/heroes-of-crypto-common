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

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { AI_VERSIONS, DEFAULT_AI_VERSION } from "../ai";
import CREATURES_JSON from "../configuration/creatures.json";
import { PBTypes } from "../generated/protobuf/v1/types";
import { hashSimulationParts, type IArmyUnitSpec, STACK_EXPERIENCE_BUDGET } from "./army";
import type { IMatchConfig, Side } from "./battle_engine";

export const ARACHNA_QUEEN_STRESS_DEFAULT_GAMES = 50_000;
export const ARACHNA_QUEEN_STRESS_DEFAULT_CONCURRENCY = 12;
export const ARACHNA_QUEEN_STRESS_DEFAULT_SEED = 87_180_718;
export const ARACHNA_QUEEN_STRESS_SMOKE_GAMES = 120;

export interface IArachnaQueenStressOptions {
    games: number;
    baseSeed: number;
    concurrency: number;
    aiVersion: string;
    maxLaps: number;
    smoke: boolean;
}

interface ICreatureJson {
    exp: number;
    level: number;
    size: number;
}

interface ICreatureRef {
    faction: string;
    name: string;
}

export interface IArachnaQueenStressScenario {
    id: string;
    category: "ranged" | "spellbook" | "direct-cast" | "mixed";
    victims: readonly ICreatureRef[];
}

const QUEEN_ARMY: readonly ICreatureRef[] = [
    { faction: "Life", name: "Squire" },
    { faction: "Life", name: "Peasant" },
    { faction: "Life", name: "Arbalester" },
    { faction: "Life", name: "Pikeman" },
    { faction: "Life", name: "Griffin" },
    { faction: "Nature", name: "Arachna Queen" },
];

const VICTIM_FILLERS: readonly ICreatureRef[] = [
    { faction: "Life", name: "Squire" },
    { faction: "Life", name: "Peasant" },
    { faction: "Life", name: "Arbalester" },
    { faction: "Nature", name: "Fairy" },
    { faction: "Might", name: "Berserker" },
    { faction: "Chaos", name: "Scavenger" },
];

/**
 * Focused real-creature boards. Each side has at most one LARGE stack, so normal 3x3 deployment remains
 * legal. Every pair plays the same board twice with the armies swapped between LOWER and UPPER.
 */
export const ARACHNA_QUEEN_STRESS_SCENARIOS: readonly IArachnaQueenStressScenario[] = [
    {
        id: "ranged-quiver-through-shot",
        category: "ranged",
        victims: [
            { faction: "Chaos", name: "Medusa" },
            { faction: "Nature", name: "Elf" },
            { faction: "Life", name: "Tsar Cannon" },
        ],
    },
    {
        id: "ranged-quiver-area-throw",
        category: "ranged",
        victims: [
            { faction: "Chaos", name: "Medusa" },
            { faction: "Nature", name: "Elf" },
            { faction: "Nature", name: "Gargantuan" },
        ],
    },
    {
        id: "spellbooks-all",
        category: "spellbook",
        victims: [
            { faction: "Life", name: "Healer" },
            { faction: "Nature", name: "Satyr" },
            { faction: "Might", name: "Ogre Mage" },
        ],
    },
    {
        id: "direct-cast-angel",
        category: "direct-cast",
        victims: [
            { faction: "Life", name: "Valkyrie" },
            { faction: "Might", name: "Harpy" },
            { faction: "Life", name: "Angel" },
        ],
    },
    {
        id: "direct-cast-behemoth",
        category: "direct-cast",
        victims: [
            { faction: "Life", name: "Valkyrie" },
            { faction: "Might", name: "Harpy" },
            { faction: "Might", name: "Behemoth" },
        ],
    },
    {
        id: "mixed-spell-range",
        category: "mixed",
        victims: [
            { faction: "Chaos", name: "Medusa" },
            { faction: "Life", name: "Healer" },
            { faction: "Nature", name: "Satyr" },
            { faction: "Might", name: "Ogre Mage" },
            { faction: "Might", name: "Behemoth" },
        ],
    },
] as const;

const creatureJson = (ref: ICreatureRef): ICreatureJson => {
    const factions = CREATURES_JSON as unknown as Record<string, Record<string, ICreatureJson>>;
    const value = factions[ref.faction]?.[ref.name];
    if (!value || !Number.isFinite(value.exp) || value.exp <= 0) {
        throw new Error(`Unknown stress creature ${ref.faction}:${ref.name}`);
    }
    return value;
};

const creatureSpec = (ref: ICreatureRef): IArmyUnitSpec => {
    const value = creatureJson(ref);
    return {
        faction: ref.faction,
        creatureName: ref.name,
        level: value.level,
        size: value.size,
        amount: Math.max(1, Math.ceil(STACK_EXPERIENCE_BUDGET / value.exp)),
    };
};

const victimArmy = (scenario: IArachnaQueenStressScenario): IArmyUnitSpec[] => {
    const refs = [...scenario.victims];
    for (const filler of VICTIM_FILLERS) {
        if (refs.length >= QUEEN_ARMY.length) break;
        if (!refs.some((entry) => entry.name === filler.name)) refs.push(filler);
    }
    if (refs.length !== QUEEN_ARMY.length) {
        throw new Error(`Scenario ${scenario.id} resolved ${refs.length} stacks instead of ${QUEEN_ARMY.length}`);
    }
    return refs.map(creatureSpec);
};

export function arachnaQueenStressScenarioForGame(game: number): IArachnaQueenStressScenario {
    const pair = Math.floor(game / 2);
    return ARACHNA_QUEEN_STRESS_SCENARIOS[pair % ARACHNA_QUEEN_STRESS_SCENARIOS.length];
}

export function arachnaQueenExpectedSide(game: number): Side {
    return game % 2 === 0 ? "green" : "red";
}

/** Same scenario + combat seed for games 2p/2p+1; only the complete armies exchange board sides. */
export function buildArachnaQueenStressConfig(
    options: Pick<IArachnaQueenStressOptions, "aiVersion" | "baseSeed" | "maxLaps">,
    game: number,
): IMatchConfig {
    const pair = Math.floor(game / 2);
    const scenario = arachnaQueenStressScenarioForGame(game);
    const queenRoster = QUEEN_ARMY.map(creatureSpec);
    const targets = victimArmy(scenario);
    const queenIsGreen = arachnaQueenExpectedSide(game) === "green";
    return {
        greenVersion: options.aiVersion,
        redVersion: options.aiVersion,
        roster: queenIsGreen ? queenRoster : targets,
        redRoster: queenIsGreen ? targets : queenRoster,
        seed: hashSimulationParts("arachna-queen-stress-v1", options.baseSeed, pair),
        maxLaps: options.maxLaps,
        gridType: PBTypes.GridVals.NORMAL,
    };
}

export interface IArachnaQueenStressFailure {
    game: number;
    scenario: string;
    kind: string;
    detail: string;
    abilityName?: string;
    spellName?: string;
    thiefId?: string;
    targetId?: string;
}

export interface IArachnaQueenStressTally {
    games: number;
    queenPlacementGames: number;
    queenTurns: number;
    steals: number;
    theftInvariantChecks: number;
    spellEntryConservationChecks: number;
    spellEntriesTransferred: number;
    duplicateRemainingEntryTransfers: number;
    partialSpellbookTransfers: number;
    spentDirectCardThefts: number;
    queenSpellLegalTurns: number;
    queenSpellChosen: number;
    queenSpellCompleted: number;
    queenSpellRejected: number;
    queenSpellChargeChecks: number;
    queenCastsAtZero: number;
    queenRangeLegalTurns: number;
    queenRangeChosen: number;
    queenRangeCompleted: number;
    queenRangeRejected: number;
    strategyRejections: number;
    crashes: number;
    stuck: number;
    turnCaps: number;
    invariantFailures: number;
    scenarioGames: Record<string, number>;
    endReasons: Record<string, number>;
    stealsByAbility: Record<string, number>;
    transfersByAbility: Record<string, number>;
    partialTransfersByAbility: Record<string, number>;
    spentDirectTheftsByAbility: Record<string, number>;
    legalSpellTurnsBySpell: Record<string, number>;
    chosenSpellCastsBySpell: Record<string, number>;
    completedSpellCastsBySpell: Record<string, number>;
    completedSpellCastsByOrigin: Record<string, number>;
    rejectionReasons: Record<string, number>;
    failures: IArachnaQueenStressFailure[];
}

const TALLY_SCALARS = [
    "games",
    "queenPlacementGames",
    "queenTurns",
    "steals",
    "theftInvariantChecks",
    "spellEntryConservationChecks",
    "spellEntriesTransferred",
    "duplicateRemainingEntryTransfers",
    "partialSpellbookTransfers",
    "spentDirectCardThefts",
    "queenSpellLegalTurns",
    "queenSpellChosen",
    "queenSpellCompleted",
    "queenSpellRejected",
    "queenSpellChargeChecks",
    "queenCastsAtZero",
    "queenRangeLegalTurns",
    "queenRangeChosen",
    "queenRangeCompleted",
    "queenRangeRejected",
    "strategyRejections",
    "crashes",
    "stuck",
    "turnCaps",
    "invariantFailures",
] as const satisfies readonly (keyof IArachnaQueenStressTally)[];

const TALLY_MAPS = [
    "scenarioGames",
    "endReasons",
    "stealsByAbility",
    "transfersByAbility",
    "partialTransfersByAbility",
    "spentDirectTheftsByAbility",
    "legalSpellTurnsBySpell",
    "chosenSpellCastsBySpell",
    "completedSpellCastsBySpell",
    "completedSpellCastsByOrigin",
    "rejectionReasons",
] as const satisfies readonly (keyof IArachnaQueenStressTally)[];

export function createArachnaQueenStressTally(): IArachnaQueenStressTally {
    return {
        games: 0,
        queenPlacementGames: 0,
        queenTurns: 0,
        steals: 0,
        theftInvariantChecks: 0,
        spellEntryConservationChecks: 0,
        spellEntriesTransferred: 0,
        duplicateRemainingEntryTransfers: 0,
        partialSpellbookTransfers: 0,
        spentDirectCardThefts: 0,
        queenSpellLegalTurns: 0,
        queenSpellChosen: 0,
        queenSpellCompleted: 0,
        queenSpellRejected: 0,
        queenSpellChargeChecks: 0,
        queenCastsAtZero: 0,
        queenRangeLegalTurns: 0,
        queenRangeChosen: 0,
        queenRangeCompleted: 0,
        queenRangeRejected: 0,
        strategyRejections: 0,
        crashes: 0,
        stuck: 0,
        turnCaps: 0,
        invariantFailures: 0,
        scenarioGames: {},
        endReasons: {},
        stealsByAbility: {},
        transfersByAbility: {},
        partialTransfersByAbility: {},
        spentDirectTheftsByAbility: {},
        legalSpellTurnsBySpell: {},
        chosenSpellCastsBySpell: {},
        completedSpellCastsBySpell: {},
        completedSpellCastsByOrigin: {},
        rejectionReasons: {},
        failures: [],
    };
}

const mergeCounts = (target: Record<string, number>, source: Readonly<Record<string, number>>): void => {
    for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
};

export function mergeArachnaQueenStressTally(
    target: IArachnaQueenStressTally,
    source: Readonly<IArachnaQueenStressTally>,
): void {
    for (const key of TALLY_SCALARS) target[key] += source[key] as number;
    for (const key of TALLY_MAPS) mergeCounts(target[key] as Record<string, number>, source[key]);
    target.failures.push(...source.failures);
    target.failures.sort(
        (left, right) =>
            left.game - right.game ||
            left.scenario.localeCompare(right.scenario) ||
            left.kind.localeCompare(right.kind) ||
            left.detail.localeCompare(right.detail),
    );
    if (target.failures.length > 100) target.failures.length = 100;
}

interface IWorkerResultMessage {
    type: "result";
    tally: IArachnaQueenStressTally;
}

type IWorkerMessage = { type: "ready" } | IWorkerResultMessage | { type: "fatal"; error: string };

async function runStressPool(options: IArachnaQueenStressOptions): Promise<IArachnaQueenStressTally> {
    const poolSize = Math.max(1, Math.min(options.concurrency, options.games));
    const aggregate = createArachnaQueenStressTally();
    return new Promise<IArachnaQueenStressTally>((resolvePromise, rejectPromise) => {
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
            if (dispatched >= options.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched });
            dispatched += 1;
        };
        const workerUrl = new URL("./arachna_queen_stress_worker.ts", import.meta.url);
        for (let workerIndex = 0; workerIndex < poolSize; workerIndex += 1) {
            const worker = new Worker(workerUrl, { workerData: { options } });
            workers.push(worker);
            worker.on("message", (message: IWorkerMessage) => {
                if (settled) return;
                if (message.type === "fatal") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                mergeArachnaQueenStressTally(aggregate, message.tally);
                completed += 1;
                if (completed % 1_000 === 0 || completed === options.games) {
                    console.error(`  ${completed}/${options.games} games...`);
                }
                if (completed >= options.games) {
                    settled = true;
                    cleanup();
                    resolvePromise(aggregate);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`Arachna stress worker exited ${code}`));
            });
        }
    });
}

const requiredAbilities = [
    "Endless Quiver",
    "Double Shot",
    "Through Shot",
    "Area Throw",
    "Book of Healing",
    "Forest Spellbook",
    "Tome of Might",
    "Resurrection",
    "Wind Flow",
    "Castling",
    "Battle Roar",
] as const;
const requiredSpellbooks = ["Book of Healing", "Forest Spellbook", "Tome of Might"] as const;

function evaluateGates(options: IArachnaQueenStressOptions, tally: IArachnaQueenStressTally) {
    const core = {
        exactGameCount: tally.games === options.games,
        queenPlacedEveryGame: tally.queenPlacementGames === options.games,
        noCrashes: tally.crashes === 0,
        noStuckMatches: tally.stuck === 0,
        zeroStrategyRejections: tally.strategyRejections === 0,
        zeroInvariantFailures: tally.invariantFailures === 0,
        noQueenCastAtZero: tally.queenCastsAtZero === 0,
        everyTheftChecked: tally.theftInvariantChecks === tally.steals,
    };
    const coverage = {
        enforced: !options.smoke,
        everyRequiredAbilityStolen: requiredAbilities.every((ability) => (tally.stealsByAbility[ability] ?? 0) > 0),
        everySpellbookTransferredPartially: requiredSpellbooks.every(
            (ability) => (tally.partialTransfersByAbility[ability] ?? 0) > 0,
        ),
        duplicateRemainingEntryTransferObserved: tally.duplicateRemainingEntryTransfers > 0,
        spentDirectCardObserved: (tally.spentDirectTheftsByAbility["Battle Roar"] ?? 0) > 0,
        queenCompletedSpellCast: tally.queenSpellCompleted > 0,
        queenCompletedBookSpellCast: (tally.completedSpellCastsByOrigin.spellbook ?? 0) > 0,
        queenCompletedDirectSpellCast: (tally.completedSpellCastsByOrigin.direct ?? 0) > 0,
        queenCompletedRangeAttack: tally.queenRangeCompleted > 0,
        queenHadLegalSpellTurn: tally.queenSpellLegalTurns > 0,
        queenHadLegalRangeTurn: tally.queenRangeLegalTurns > 0,
    };
    const failed = [
        ...Object.entries(core)
            .filter(([, pass]) => !pass)
            .map(([name]) => name),
        ...(!options.smoke
            ? Object.entries(coverage)
                  .filter(([name, pass]) => name !== "enforced" && !pass)
                  .map(([name]) => name)
            : []),
    ];
    return { pass: failed.length === 0, failed, core, coverage };
}

const positiveInteger = (value: string, flag: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    return parsed;
};

async function cliMain(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string" },
            seed: { type: "string", default: String(ARACHNA_QUEEN_STRESS_DEFAULT_SEED) },
            concurrency: { type: "string", default: String(ARACHNA_QUEEN_STRESS_DEFAULT_CONCURRENCY) },
            "ai-version": { type: "string", default: DEFAULT_AI_VERSION },
            "max-laps": { type: "string", default: "60" },
            output: { type: "string", default: "" },
            smoke: { type: "boolean", default: false },
        },
    });
    const smoke = values.smoke ?? false;
    const games = values.games
        ? positiveInteger(values.games, "--games")
        : smoke
          ? ARACHNA_QUEEN_STRESS_SMOKE_GAMES
          : ARACHNA_QUEEN_STRESS_DEFAULT_GAMES;
    if (games % 2 !== 0) throw new Error(`--games must be even for side-swapped pairs; got ${games}`);
    const aiVersion = values["ai-version"]!;
    if (!AI_VERSIONS.includes(aiVersion)) {
        throw new Error(`Unknown --ai-version ${aiVersion}; known: ${AI_VERSIONS.join(", ")}`);
    }
    const options: IArachnaQueenStressOptions = {
        games,
        baseSeed: positiveInteger(values.seed!, "--seed"),
        concurrency: Math.min(
            positiveInteger(values.concurrency!, "--concurrency"),
            Math.max(1, availableParallelism()),
        ),
        aiVersion,
        maxLaps: positiveInteger(values["max-laps"]!, "--max-laps"),
        smoke,
    };
    process.env.SIM_NO_ACTIONS = "1";
    const outputPath = values.output
        ? resolve(process.cwd(), values.output)
        : resolve(
              process.cwd(),
              "sim-out",
              "arachna-queen-stress",
              `arachna-queen-stress-${options.games}-seed${options.baseSeed}.json`,
          );
    console.error(
        `Arachna Queen stress: ${options.games} games, ${options.aiVersion}, seed ${options.baseSeed}, ` +
            `concurrency ${options.concurrency}, ${smoke ? "SMOKE (coverage advisory)" : "STRICT"}`,
    );
    const started = Date.now();
    const tally = await runStressPool(options);
    const elapsedMs = Date.now() - started;
    const gates = evaluateGates(options, tally);
    const report = {
        schemaVersion: 1 as const,
        status: gates.pass ? ("pass" as const) : ("fail" as const),
        generatedAt: new Date().toISOString(),
        options,
        scenarioOrder: ARACHNA_QUEEN_STRESS_SCENARIOS,
        elapsedMs,
        gamesPerSecond: tally.games / Math.max(0.001, elapsedMs / 1_000),
        gates,
        tally,
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        `${report.status.toUpperCase()}: ${tally.games} games, ${tally.steals} steals, ` +
            `${tally.queenSpellCompleted} Queen casts, ${tally.queenRangeCompleted} Queen shots, ` +
            `${tally.strategyRejections} rejections, ${tally.invariantFailures} invariant failures, ` +
            `${report.gamesPerSecond.toFixed(1)} games/s`,
    );
    if (!gates.pass) console.log(`failed gates: ${gates.failed.join(", ")}`);
    console.log(`report -> ${outputPath}`);
    if (!gates.pass) process.exitCode = 1;
}

if ((import.meta as unknown as { main?: boolean }).main) {
    cliMain().catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : error);
        process.exit(1);
    });
}
