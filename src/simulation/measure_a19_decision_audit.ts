/*
 * Observational A19 decision audit. Run from common:
 * bun src/simulation/measure_a19_decision_audit.ts --games 48 --workers 12 --out /external/fresh-directory
 * Imports are inert. Only this CLI's dedicated workers install diagnostic wrappers.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import type { IDecisionContext } from "../ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../ai/candidates";
import { throughShotLineEnabled } from "../ai/through_shot_line";
import { v09CandidateSignature } from "../ai/versions/v0_9";
import type { GameAction } from "../engine/actions";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import {
    AUDIT_CATEGORIES,
    auditCandidateCategory,
    auditDigest,
    auditEscapeHtml,
    holmAuditPValues,
    pairedAuditEvidence,
    readA19AuditProfile,
    selectAuditTurns,
    type A19AuditProfile,
    type AuditCategory,
    type IAuditTurn,
} from "./a19_decision_audit";
import { hashSimulationParts } from "./army";
import { runMatch, GREEN_TEAM, RED_TEAM, type IMatchResult } from "./battle_engine";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { exitCompletedWorkerCli } from "./completed_worker_cli";
import { playRankedDraftGame, rankedDraftStrengthCandidate } from "./ranked_draft_eval";
import type { RankedDraftStrengthPolicyId } from "../ai/setup/draft_strength_prior";
import { SearchDriver, withSearchEnvironment, type ISearchMatchInfo } from "./search_driver";
import { withScopedAIEnvironment } from "./v0_8_a13_search";

type Candidate = IEnumeratedCandidate;
type Horizon = "leaf" | "turns" | "reply" | "lap";
interface IAuditDriver {
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    shortlistCandidates(unit: Unit, candidates: readonly Candidate[], ...rest: unknown[]): readonly Candidate[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly Candidate[],
        seed: number,
        horizon: Horizon,
        rollouts: number,
        deadline: number | null,
        turns: number,
        bounds: boolean,
    ): number[];
    rollout(
        unit: Unit,
        candidate: Candidate,
        seed: number,
        rollout: number,
        mode: Horizon,
        deadline: number | null,
        turns: number,
    ): number;
    simPlayTurn(unit: Unit): void;
    leafValue(team: TeamType): number;
    ilConfig(): Record<string, unknown>;
    deps: ILookaheadDeps;
    match: ISearchMatchInfo;
    certifiedSelectionBounds: boolean;
    certifiedTightBounds: boolean;
    a19MaterialArbitration: string | undefined;
    finishedSim: boolean;
    finishedWinningTeam: TeamType | null;
}
interface IFrame {
    full: Map<string, Candidate>;
    shortlist: Map<string, Candidate>;
    passes: { signatures: string[]; means: (number | null)[]; seed: number; rollouts: number; horizon: number }[];
}
interface ITrace extends IAuditTurn {
    actor: string;
    actions: GameAction[];
}
interface ISample {
    value: number;
    h64: number;
    terminal: boolean;
}
interface IValidation {
    category: AuditCategory;
    challenger: number;
    discoveryGain: number;
    h64Gain: number | null;
    terminalComplete: boolean;
    evidence: ReturnType<typeof pairedAuditEvidence> | null;
}
interface IPosition {
    schema: string;
    game: number;
    board: number;
    grid: number;
    seed: number;
    ordinal: number;
    team: number;
    lap: number;
    actor: string;
    stateDigest: string;
    stateFile: string;
    searchConfig: Record<string, unknown>;
    baselineScorePasses: IFrame["passes"];
    baseline: number;
    catalogCount: number;
    shortlistCount: number;
    expandedCount: number;
    expandedTruncated: string[];
    discoverySeed: number;
    terminalDiscoverySeed: number;
    validationSeed: number;
    candidates: {
        kind: string;
        actions: GameAction[];
        category: AuditCategory | "baseline";
        target?: string;
        discovery: number | null;
    }[];
    terminalDiscovery: { indices: number[]; samples: ISample[][] };
    validation: { indices: number[]; samples: ISample[][] };
    comparisons: IValidation[];
    milliseconds: number;
}
interface ISettings {
    games: number;
    seed: number;
    workers: number;
    perStratum: number;
    discoveryRollouts: number;
    referenceRollouts: number;
    validationRollouts: number;
    terminalHorizon: number;
    maxCandidates: number;
    out: string;
}
interface ITask {
    game: number;
    settings: ISettings;
    profile: A19AuditProfile;
}
interface IGame {
    game: number;
    board: number;
    grid: number;
    seed: number;
    positions: number;
    decisions: number;
    selectedOrdinals: number[];
    traceSha256: string;
    parity: boolean;
    outcome: Record<string, unknown>;
    milliseconds: number;
}

const prototype = SearchDriver.prototype as unknown as IAuditDriver;
const originalChoose = prototype.chooseDecision;
const originalShortlist = prototype.shortlistCandidates;
const originalScore = prototype.scoreCandidates;
let activeFrame: IFrame | null = null;
let task: ITask;
let collecting = false;
let selected = new Set<number>();
let trace: ITrace[] = [];
let positions: IPosition[] = [];
let currentGrid = 0;
let currentSeed = 0;
let profileChecked = false;

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const signature = (candidate: Pick<Candidate, "actions">) => v09CandidateSignature(candidate.actions);
const completed = (samples: readonly ISample[]) => samples.length > 0 && samples.every((sample) => sample.terminal);

function installAudit(): void {
    prototype.scoreCandidates = function (this: IAuditDriver, ...args) {
        const scores = originalScore.apply(this, args);
        if (activeFrame && args[3] === "turns") {
            activeFrame.passes.push({
                signatures: args[1].map(signature),
                means: scores.map((value) => (Number.isFinite(value) ? value : null)),
                seed: args[2],
                rollouts: args[4],
                horizon: args[6] ?? 64,
            });
        }
        return scores;
    };
    prototype.shortlistCandidates = function (this: IAuditDriver, unit, candidates, ...rest) {
        const shortlist = originalShortlist.call(this, unit, candidates, ...rest);
        if (activeFrame) {
            for (const candidate of candidates) activeFrame.full.set(signature(candidate), candidate);
            for (const candidate of shortlist) activeFrame.shortlist.set(signature(candidate), candidate);
        }
        return shortlist;
    };
    prototype.chooseDecision = function (this: IAuditDriver, unit, version, incumbent, context) {
        const previous = activeFrame;
        const frame: IFrame = { full: new Map(), shortlist: new Map(), passes: [] };
        activeFrame = frame;
        let choice: GameAction[];
        try {
            choice = originalChoose.call(this, unit, version, incumbent, context);
        } finally {
            activeFrame = previous;
        }
        if (!profileChecked) {
            if (
                this.a19MaterialArbitration !== task.profile.environment.SEARCH_A19_MATERIAL_ARBITRATION ||
                this.certifiedSelectionBounds !==
                    (task.profile.environment.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS === "1") ||
                this.certifiedTightBounds !== (task.profile.environment.SEARCH_A19_CERTIFIED_TIGHT_BOUNDS === "1") ||
                !this.match.offlineDeterministicWork
            )
                throw new Error("Actual search driver differs from the frozen server profile");
            profileChecked = true;
        }
        const ordinal = trace.length;
        trace.push({
            ordinal,
            team: unit.getTeam(),
            lap: this.deps.fightProperties.getCurrentLap(),
            actor: unit.getName(),
            actions: structuredClone(choice),
        });
        if (collecting && selected.has(ordinal)) {
            if (!context) throw new Error("A19 root decision lacks context");
            positions.push(auditPosition(this, unit, incumbent, choice, context, frame, ordinal));
        }
        return choice;
    };
}

/** Scores only detached candidate proposals; the child owns all search counters and speculative caches. */
function makeReference(driver: IAuditDriver): IAuditDriver {
    const environment = {
        ...task.profile.environment,
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "0",
        SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "0",
        SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
    };
    return withSearchEnvironment(environment, () =>
        withScopedAIEnvironment(
            environment,
            () =>
                new SearchDriver(
                    driver.deps,
                    { ...driver.match, offlineDeterministicWork: true },
                    undefined,
                    undefined,
                    "snapshot",
                ),
        ),
    ) as unknown as IAuditDriver;
}

function terminalScores(child: IAuditDriver, unit: Unit, candidates: Candidate[], seed: number, rollouts: number) {
    const samples: ISample[][] = candidates.map(() => []);
    const indices = new Map(candidates.map((candidate, index) => [candidate, index]));
    const rollout = child.rollout;
    const play = child.simPlayTurn;
    let turns = 0;
    let h64: number | undefined;
    child.simPlayTurn = function (actor) {
        play.call(this, actor);
        if (++turns === 64) h64 = this.leafValue(unit.getTeam());
    };
    child.rollout = function (...args) {
        turns = 0;
        h64 = undefined;
        const value = rollout.apply(this, args);
        const index = indices.get(args[1]);
        if (index === undefined) throw new Error("Unmapped terminal candidate");
        samples[index].push({
            value,
            h64: h64 ?? value,
            terminal: this.finishedSim && this.finishedWinningTeam !== null,
        });
        return value;
    };
    try {
        child.scoreCandidates(unit, candidates, seed, "turns", rollouts, null, task.settings.terminalHorizon, false);
    } finally {
        child.rollout = rollout;
        child.simPlayTurn = play;
    }
    if (samples.some((row) => row.length !== rollouts || row.some((sample) => !Number.isFinite(sample.value)))) {
        throw new Error("Rejected or incomplete terminal reference; preserve output for diagnosis");
    }
    return samples;
}

function auditPosition(
    driver: IAuditDriver,
    unit: Unit,
    incumbent: GameAction[],
    baseline: GameAction[],
    context: IDecisionContext,
    frame: IFrame,
    ordinal: number,
): IPosition {
    const start = performance.now();
    const deps = driver.deps;
    const snapshot = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
    const state = { ...snapshot, unitRefs: undefined };
    const stateDigest = auditDigest(state);
    const random = captureDeterministicRandomState();
    const stats = deps.captureDamageStats();
    const auxiliary = deps.captureAuxiliaryState?.();
    const active = deps.getActiveUnitId();
    try {
        const baselineSignature = v09CandidateSignature(baseline);
        const production = new Set(frame.full.keys());
        const shortlisted = new Set(frame.shortlist.keys());
        production.add(baselineSignature);
        shortlisted.add(baselineSignature);
        const expanded = enumerateCandidates(unit, context, incumbent, {
            maxMoveDestinations: 0,
            maxMeleePairs: 0,
            maxShotAims: 0,
            maxAreaThrowCells: 0,
            includeMountainAttacks: true,
            includeArtifactBarrelAttackCoverage: true,
            includeLastFuseCounterTrades: true,
            includeLastFusePrimaryTrades: true,
            throughShotFreeAim: throughShotLineEnabled(unit),
            enrichIncumbentMetadata: true,
        });
        const finalCandidate = enumerateCandidates(unit, context, baseline, {
            maxMoveDestinations: 1,
            maxMeleePairs: 1,
            maxShotAims: 1,
            maxAreaThrowCells: 1,
            enrichIncumbentMetadata: true,
        }).candidates[0];
        const catalog = new Map<string, Candidate>([[baselineSignature, finalCandidate]]);
        for (const candidate of [...frame.full.values(), ...expanded.candidates]) {
            if (!catalog.has(signature(candidate))) catalog.set(signature(candidate), candidate);
        }
        const candidates = [...catalog.values()];
        if (candidates.length > task.settings.maxCandidates) {
            throw new Error(
                `Expanded catalog ${candidates.length} exceeds declared cap ${task.settings.maxCandidates}`,
            );
        }
        const child = makeReference(driver);
        const discoverySeed = hashSimulationParts("a19-audit-discovery-v1", currentSeed, ordinal);
        const terminalDiscoverySeed = hashSimulationParts("a19-audit-terminal-discovery-v1", currentSeed, ordinal);
        const validationSeed = hashSimulationParts("a19-audit-validation-v1", currentSeed, ordinal);
        const scores = child.scoreCandidates(
            unit,
            candidates,
            discoverySeed,
            "turns",
            task.settings.discoveryRollouts,
            null,
            64,
            false,
        );
        if (!Number.isFinite(scores[0])) throw new Error("The real selected baseline was rejected by the reference");
        const category = (index: number) =>
            auditCandidateCategory(signature(candidates[index]), production, shortlisted);
        const referenceIndices = [0];
        for (let index = 1; index < candidates.length; index++) {
            if (category(index) === "scoring" && Number.isFinite(scores[index])) referenceIndices.push(index);
        }
        for (const group of ["missing", "shortlist"] as const) {
            const eligible = candidates
                .map((_, index) => index)
                .filter((index) => index > 0 && category(index) === group && Number.isFinite(scores[index]));
            eligible.sort((left, right) => scores[right] - scores[left] || left - right);
            if (eligible.length) referenceIndices.push(eligible[0]);
        }
        const referenceCandidates = referenceIndices.map((index) => candidates[index]);
        const referenceSamples = terminalScores(
            child,
            unit,
            referenceCandidates,
            terminalDiscoverySeed,
            task.settings.referenceRollouts,
        );
        const challengers: { category: AuditCategory; index: number; slot: number }[] = [];
        for (const group of AUDIT_CATEGORIES) {
            const slots = referenceIndices
                .map((_, slot) => slot)
                .filter(
                    (slot) =>
                        slot > 0 && category(referenceIndices[slot]) === group && completed(referenceSamples[slot]),
                );
            slots.sort(
                (left, right) =>
                    mean(referenceSamples[right].map((sample) => sample.value)) -
                        mean(referenceSamples[left].map((sample) => sample.value)) || left - right,
            );
            if (slots.length) challengers.push({ category: group, index: referenceIndices[slots[0]], slot: slots[0] });
        }
        const validationIndices = [0, ...challengers.map((challenger) => challenger.index)];
        const validationSamples = terminalScores(
            child,
            unit,
            validationIndices.map((index) => candidates[index]),
            validationSeed,
            task.settings.validationRollouts,
        );
        const comparisons = challengers.map((challenger, index): IValidation => {
            const terminalComplete = completed(validationSamples[0]) && completed(validationSamples[index + 1]);
            return {
                category: challenger.category,
                challenger: challenger.index,
                discoveryGain:
                    mean(referenceSamples[challenger.slot].map((sample) => sample.value)) -
                    mean(referenceSamples[0].map((sample) => sample.value)),
                h64Gain:
                    mean(validationSamples[index + 1].map((sample) => sample.h64)) -
                    mean(validationSamples[0].map((sample) => sample.h64)),
                terminalComplete,
                evidence: terminalComplete
                    ? pairedAuditEvidence(
                          validationSamples[0].map((sample) => sample.value),
                          validationSamples[index + 1].map((sample) => sample.value),
                      )
                    : null,
            };
        });
        if (
            auditDigest({
                ...snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties),
                unitRefs: undefined,
            }) !== stateDigest
        ) {
            throw new Error("Decision diagnostic changed the live battle epoch");
        }
        const stateFile = `states/game-${task.game}-turn-${ordinal}.json.gz`;
        writeFileSync(
            join(task.settings.out, stateFile),
            gzipSync(
                JSON.stringify(
                    { state, incumbent, baseline, discoverySeed, terminalDiscoverySeed, validationSeed },
                    (_key, value) => (value instanceof Map || value instanceof Set ? [...value] : value),
                ),
            ),
        );
        return {
            schema: "hoc.a19-decision-position.v1",
            game: task.game,
            board: Math.floor(task.game / 4),
            grid: currentGrid,
            seed: currentSeed,
            ordinal,
            team: unit.getTeam(),
            lap: deps.fightProperties.getCurrentLap(),
            actor: unit.getName(),
            stateDigest,
            stateFile,
            searchConfig: driver.ilConfig(),
            baselineScorePasses: frame.passes,
            baseline: 0,
            catalogCount: production.size,
            shortlistCount: shortlisted.size,
            expandedCount: candidates.length,
            expandedTruncated: expanded.truncated,
            discoverySeed,
            terminalDiscoverySeed,
            validationSeed,
            candidates: candidates.map((candidate, index) => ({
                kind: candidate.kind,
                actions: candidate.actions,
                category: index === 0 ? "baseline" : category(index),
                target: candidate.targetId
                    ? deps.unitsHolder.getAllUnits().get(candidate.targetId)?.getName()
                    : undefined,
                discovery: Number.isFinite(scores[index]) ? scores[index] : null,
            })),
            terminalDiscovery: { indices: referenceIndices, samples: referenceSamples },
            validation: { indices: validationIndices, samples: validationSamples },
            comparisons,
            milliseconds: performance.now() - start,
        };
    } finally {
        restoreBattle(snapshot, deps.unitsHolder, deps.grid, deps.fightProperties);
        deps.restoreDamageStats(stats);
        auxiliary?.();
        restoreDeterministicRandomState(random);
        deps.setActiveUnitId(active);
    }
}

const outcome = (result: IMatchResult): Record<string, unknown> => ({
    winner: result.winner,
    endReason: result.endReason,
    laps: result.laps,
    rejectedGreen: result.rejectedGreen ?? 0,
    rejectedRed: result.rejectedRed ?? 0,
});

function oneGame(input: ITask): IGame {
    task = input;
    const started = performance.now();
    const genome = rankedDraftStrengthCandidate(task.profile.draft as RankedDraftStrengthPolicyId);
    let scenarioDigest: string | undefined;
    const execute = (): IMatchResult => {
        let result: IMatchResult | undefined;
        playRankedDraftGame(
            genome,
            genome,
            {
                gamesPerOpponent: task.settings.games,
                baseSeed: task.settings.seed,
                fightProfile: "a19",
                mapTypes: [1, 3, 4],
                liveDraftRules: true,
                sideBoard: true,
                deterministicSearch: true,
                liveSynergyVariants: true,
                tacticalSplits: true,
                recordArmies: true,
                candidateSetupPolicySpec: task.profile.setup,
                opponentSetupPolicySpec: task.profile.setup,
                candidateDoctrinePolicy: "see-none",
                opponentDoctrinePolicy: "see-none",
            },
            task.game,
            0,
            {
                matchRunner: (config) => {
                    const digest = auditDigest(config);
                    if (scenarioDigest && scenarioDigest !== digest)
                        throw new Error("Control scenario changed on replay");
                    scenarioDigest = digest;
                    writeFileSync(
                        join(task.settings.out, `game-${task.game}.scenario.json`),
                        JSON.stringify(config, null, 2),
                    );
                    currentGrid = config.gridType!;
                    currentSeed = config.seed!;
                    process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify(task.profile.overrides);
                    result = runMatch({
                        ...config,
                        headlessEvents: true,
                        searchEnvOverrideTeams: [GREEN_TEAM, RED_TEAM],
                    });
                    return result;
                },
            },
        );
        if (!result) throw new Error("Ranked scenario did not execute a match");
        return result;
    };
    trace = [];
    positions = [];
    profileChecked = false;
    collecting = false;
    const control = outcome(execute());
    const controlTrace = trace;
    const selectedOrdinals = selectAuditTurns(controlTrace, currentSeed, task.settings.perStratum);
    selected = new Set(selectedOrdinals);
    trace = [];
    collecting = true;
    const audited = outcome(execute());
    collecting = false;
    const parity = auditDigest(controlTrace) === auditDigest(trace) && auditDigest(control) === auditDigest(audited);
    if (!parity) throw new Error(`Diagnostic changed the played trajectory in game ${task.game}`);
    if (audited.rejectedGreen !== 0 || audited.rejectedRed !== 0) throw new Error("Baseline game rejected an action");
    if (positions.length !== selectedOrdinals.length) throw new Error("Sampling plan was not fully collected");
    writeFileSync(
        join(task.settings.out, `game-${task.game}.positions.jsonl`),
        positions.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(join(task.settings.out, `game-${task.game}.trajectory.json`), JSON.stringify(controlTrace));
    return {
        game: task.game,
        board: Math.floor(task.game / 4),
        grid: currentGrid,
        seed: currentSeed,
        positions: positions.length,
        decisions: trace.length,
        selectedOrdinals,
        traceSha256: auditDigest(trace),
        parity,
        outcome: audited,
        milliseconds: performance.now() - started,
    };
}

function sourceReceipt(root: string) {
    const files: Record<string, string> = {};
    const walk = (folder: string) => {
        for (const entry of readdirSync(join(root, folder), { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const name = join(folder, entry.name);
            if (entry.isDirectory()) walk(name);
            else if (entry.isFile())
                files[name] = createHash("sha256")
                    .update(readFileSync(join(root, name)))
                    .digest("hex");
        }
    };
    walk("src");
    for (const name of ["package.json", "bun.lock"])
        if (existsSync(join(root, name))) {
            files[name] = createHash("sha256")
                .update(readFileSync(join(root, name)))
                .digest("hex");
        }
    return { files, sha256: auditDigest(files) };
}

function report(settings: ISettings, profile: A19AuditProfile, games: IGame[], source: unknown) {
    const rows = games.flatMap((game) =>
        readFileSync(join(settings.out, `game-${game.game}.positions.jsonl`), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as IPosition),
    );
    const comparisons = rows.flatMap((position) =>
        position.comparisons.map((comparison) => ({ position, ...comparison })),
    );
    const adjusted = holmAuditPValues(comparisons.map((comparison) => comparison.evidence?.p ?? 1));
    const annotated = comparisons.map((comparison, index) => ({
        ...comparison,
        adjustedP: adjusted[index],
        supported: !!comparison.evidence && comparison.evidence.mean > 0 && adjusted[index] <= 0.05,
    }));
    const categories = AUDIT_CATEGORIES.map((category) => {
        const tested = annotated.filter((comparison) => comparison.category === category);
        const valid = tested.filter((comparison) => comparison.evidence !== null);
        return {
            category,
            comparisons: tested.length,
            complete: valid.length,
            positive: valid.filter((comparison) => comparison.evidence!.mean > 0).length,
            negative: valid.filter((comparison) => comparison.evidence!.mean < 0).length,
            supported: valid.filter((comparison) => comparison.supported).length,
            meanValidationGain: valid.length ? mean(valid.map((comparison) => comparison.evidence!.mean)) : null,
        };
    });
    const summary = {
        schema: "hoc.a19-decision-audit.v1",
        complete: true,
        diagnosticOnly: true,
        profile,
        settings,
        source,
        games,
        positions: rows.length,
        independentBoards: new Set(games.map((game) => game.board)).size,
        categories,
        comparisons: annotated,
        limitations: [
            "Terminal outcomes follow native policy continuations, not optimal play or recursively searched A19.",
            "Missing means absent from the filtered production catalog; generation and policy filters are not distinguished.",
            "Discovery tests the expanded catalog at H64; only its best missing and discarded proposals receive terminal evaluation.",
            "All available shortlisted alternatives receive terminal discovery; a separate bank validates one per category.",
            "Score differences are local counterfactual effects, not measured full-match win-rate improvements.",
            "Holm-adjusted paired sign-flip tests cover this run; army-clustered strength confirmation remains necessary.",
            "Deterministic work budgets preserve the server policy but do not reproduce live deadline truncation.",
            "Baseline score passes can include certified bounds; their pruned means are not exact full-sample estimates.",
        ],
    };
    writeFileSync(join(settings.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    const labels = {
        missing: "Absent from production catalog",
        shortlist: "Discarded by shortlist",
        scoring: "Scoring / final selection",
    };
    const mapName = (grid: number) => ({ 1: "Normal", 3: "Lava", 4: "Block" })[grid] ?? String(grid);
    const percent = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(2)} pp`);
    const cases = [...annotated].sort(
        (left, right) =>
            Number(right.supported) - Number(left.supported) ||
            (right.evidence?.mean ?? -Infinity) - (left.evidence?.mean ?? -Infinity),
    );
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A19 decision audit</title><style>body{font:16px system-ui;max-width:1200px;margin:36px auto;padding:0 20px;background:#10141e;color:#e3e8f2}a{color:#8ec5ff}h1{font-size:30px}p,li{line-height:1.55;color:#bac5da}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;padding:12px;border-bottom:1px solid #303a4f}th{color:#a5b8d9}select{font:inherit;padding:8px;background:#202a3d;color:white;border:1px solid #566782}details{margin:12px 0;padding:14px;background:#1c2434;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.supported{color:#80e8b1}.muted{color:#a5b2ca}code{overflow-wrap:anywhere}@media(max-width:650px){table{font-size:12px}th,td{padding:7px}}</style>
<h1>A19: where decisions lose value</h1><p>${rows.length} sampled positions · ${games.length} games · ${summary.independentBoards} independent draft boards · ${auditEscapeHtml(profile.revision)}</p>
<p>Both seats use the current server draft, funded setup, public synergy variants, tactical splits and side-board placement. Every audited game reproduced its complete baseline action trajectory and outcome. Sampling uses team and fight phase, without inspecting candidate pruning or outcomes.</p>
<p><a href="summary.json">Summary and raw comparisons</a> · <a href="manifest.json">Frozen protocol and source receipt</a></p>
<table><thead><tr><th>Mechanism</th><th>Validated comparisons</th><th>Positive / negative</th><th>Supported after Holm</th><th>Mean held-out difference</th></tr></thead><tbody>${categories.map((row) => `<tr><td>${labels[row.category]}</td><td>${row.complete}</td><td>${row.positive} / ${row.negative}</td><td>${row.supported}</td><td>${percent(row.meanValidationGain)}</td></tr>`).join("")}</tbody></table>
<p>Differences are percentage points of terminal score from the same position, following native continuations. They are not full-match win-rate gains. Negative validation results remain in the totals. “Supported” requires a positive difference and a paired sign-flip test passing Holm correction over every comparison in this report.</p>
<h2>Decision examples</h2><label>Mechanism <select id="category"><option value="all">All</option>${AUDIT_CATEGORIES.map((category) => `<option value="${category}">${labels[category]}</option>`).join("")}</select></label>
${cases.map((row) => `<details data-category="${row.category}"><summary><span class="${row.supported ? "supported" : "muted"}">${row.supported ? "Supported" : "Exploratory"}</span> · ${auditEscapeHtml(row.position.actor)} · ${mapName(row.position.grid)} · lap ${row.position.lap} · ${labels[row.category]} · ${percent(row.evidence?.mean ?? null)}</summary><p>Game ${row.position.game}, turn ${row.position.ordinal}; ${row.position.catalogCount} production candidates, ${row.position.shortlistCount} shortlisted, ${row.position.expandedCount} expanded. Independent validation: ${row.evidence ? `${row.evidence.improved} improved / ${row.evidence.worsened} worsened / ${row.evidence.tied} tied; adjusted p=${row.adjustedP.toPrecision(3)}; H64 difference ${percent(row.h64Gain)}` : "Incomplete terminal bank"}.</p><p><a href="${row.position.stateFile}">Compressed state and seeds</a></p><pre>${auditEscapeHtml(JSON.stringify({ baseline: row.position.candidates[0], challenger: row.position.candidates[row.challenger] }, null, 2))}</pre></details>`).join("\n")}
<h2>Interpretation limits</h2><ul>${summary.limitations.map((limitation) => `<li>${auditEscapeHtml(limitation)}</li>`).join("")}</ul>
<script>document.querySelector('#category').addEventListener('change',e=>{for(const row of document.querySelectorAll('details[data-category]'))row.hidden=e.target.value!=='all'&&row.dataset.category!==e.target.value})</script></html>`;
    writeFileSync(join(settings.out, "report.html"), html);
    return { positions: rows.length, categories, independentBoards: summary.independentBoards };
}

if (!isMainThread && workerData?.a19DecisionAudit) {
    installAudit();
    startPersistentWorker<ITask, IGame>(oneGame);
} else if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            games: { type: "string", default: "48" },
            seed: { type: "string", default: "2026101701" },
            workers: { type: "string", default: "12" },
            out: { type: "string" },
            "server-root": { type: "string" },
            "per-stratum": { type: "string", default: "1" },
            "discovery-rollouts": { type: "string", default: "4" },
            "reference-rollouts": { type: "string", default: "16" },
            "validation-rollouts": { type: "string", default: "32" },
            "terminal-horizon": { type: "string", default: "1024" },
            "max-candidates": { type: "string", default: "512" },
        },
    });
    if (!values.out) throw new Error("--out must name a fresh directory outside Git");
    const settings: ISettings = {
        games: Number(values.games),
        seed: Number(values.seed),
        workers: Number(values.workers),
        perStratum: Number(values["per-stratum"]),
        discoveryRollouts: Number(values["discovery-rollouts"]),
        referenceRollouts: Number(values["reference-rollouts"]),
        validationRollouts: Number(values["validation-rollouts"]),
        terminalHorizon: Number(values["terminal-horizon"]),
        maxCandidates: Number(values["max-candidates"]),
        out: resolve(values.out),
    };
    if (
        Object.entries(settings).some(
            ([key, value]) => key !== "out" && (!Number.isSafeInteger(value) || Number(value) < 1),
        )
    ) {
        throw new Error("All numeric options must be positive safe integers");
    }
    if (settings.games % 6 !== 0 || settings.seed > 0xffffffff || settings.terminalHorizon < 64) {
        throw new Error("Games must be divisible by six; seed must be uint32; terminal horizon must be >=64");
    }
    if (existsSync(settings.out)) throw new Error("Choose a fresh output directory");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const server = resolve(
        values["server-root"] ?? process.env.HOC_SERVER_LOC ?? resolve(root, "../../../heroes-of-crypto-server"),
    );
    const readServer = (name: string) => readFileSync(join(server, "src/api/game/v1", name), "utf8");
    const sources = {
        search: readServer("bot_search.ts"),
        draft: readServer("draft_policy.ts"),
        setup: readServer("setup_policy.ts"),
    };
    const profile = readA19AuditProfile(sources);
    const source = sourceReceipt(root);
    mkdirSync(join(settings.out, "states"), { recursive: true });
    const taskGames = Array.from({ length: settings.games }, (_, index) => Math.floor(index / 2) * 4 + (index % 2));
    // playRankedDraftGame validates game ordinals against this option, including unused reciprocal pick assignments.
    const workerSettings = { ...settings, games: settings.games * 2 };
    const manifest = {
        schema: "hoc.a19-decision-audit-protocol.v1",
        settings,
        profile,
        source,
        taskGames,
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        committedSource: (() => {
            try {
                const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
                    cwd: root,
                    encoding: "utf8",
                }).trim();
                if (resolve(top) !== root) return null;
                return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
            } catch {
                return null;
            }
        })(),
        protocol: {
            sampling: "outcome-blind hash per team x lap 1-2 / 3-5 / 6+",
            control: "full trajectory plus outcome replay for every game",
            discovery: "H64 full expanded catalog",
            terminalDiscovery: "all production finalists plus best missing and discarded proposals",
            validation: "independent bank; one terminal-discovery winner per disjoint category",
            statistics: "paired sign-flip test; global Holm correction",
            referenceContinuation: "native policies; exact engine; terminal results required",
            promotion: false,
        },
    };
    writeFileSync(join(settings.out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const pool = new PersistentWorkerPool<ITask, IGame>({
        concurrency: settings.workers,
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { a19DecisionAudit: true } },
    });
    const start = Date.now();
    try {
        const games = await pool.runBatch(
            taskGames.map((game) => ({ game, settings: workerSettings, profile })),
            ({ completed, total }) =>
                console.log(JSON.stringify({ completed, total, seconds: (Date.now() - start) / 1000 })),
        );
        if (sourceReceipt(root).sha256 !== source.sha256)
            throw new Error("Source changed during the diagnostic; output is not complete");
        const result = report(settings, profile, games, source);
        console.log(
            JSON.stringify({
                complete: true,
                ...result,
                seconds: (Date.now() - start) / 1000,
                report: join(settings.out, "report.html"),
            }),
        );
        // runBatch has returned every task; report() writes its artifacts synchronously. Failure paths
        // retain normal pool cleanup, while a successful standalone CLI can skip idle realm destruction.
        await exitCompletedWorkerCli();
    } finally {
        await pool.close();
    }
}
