/*
 * -----------------------------------------------------------------------------
 * Resumable paired search for opponent-roster-conditioned v0.7 augment and
 * synergy rules. This is research-only: passing reports are evidence, not a
 * runtime policy switch.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    truncateSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../../ai/setup/draft_ship";
import { parseConditionalRules } from "../../ai/setup/setup_conditional";
import {
    compileNonFightSetupPolicy,
    V07_NONFIGHT_BEHAVIOR_SHA256,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    type ISetupAugmentChoice,
    type ISetupSynergyChoice,
} from "../../ai/setup/setup_ship";
import { FightStateManager } from "../../fights/fight_state_manager";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "../battle_engine";
import { runRankedConditionalPickGame, type IConditionalArmy } from "../measure_setup_conditional";
import { rankedDraftBehaviorTraceSha256 } from "../ranked_draft_eval";
import {
    PUBLIC_SETUP_CANDIDATES,
    PUBLIC_SETUP_DIAGNOSTIC_TAGS,
    PUBLIC_SETUP_GUARD_THRESHOLDS,
    publicSetupAugmentActionableCohorts,
    publicSetupBoard,
    publicSetupCandidate,
    publicSetupCandidateStrata,
    publicSetupCompositeCandidate,
    publicSetupPromotionGate,
    publicSetupStratumKey,
    selectPublicSetupChoices,
    summarizePublicSetup,
    validatePublicSetupControlParity,
    type IPublicSetupBoard,
    type IPublicSetupBoardPlan,
    type IPublicSetupCandidateBoardPlan,
    type IPublicSetupChoices,
    type IPublicSetupOutcomeRecord,
    type IPublicSetupStratifiedBoard,
    type PublicSetupCandidate,
} from "./v0_7_public_setup_search_core";
import { SETUP_LIVE_GRID_TYPES, type SetupLiveGridType, type SetupSeedPanel } from "./v0_7_setup_overnight_core";

const RULES = parseConditionalRules("all");
const SHIPPED_DRAFT = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
const SHIPPED_SETUP = compileNonFightSetupPolicy(V07_NONFIGHT_SETUP_ARTIFACT.policy, V07_NONFIGHT_SETUP_SPEC);
const INFORMATION_BOUNDARY =
    "candidate sees own creature stack ids and deduplicated final public opponent creature ids only; " +
    "no opponent positions, amounts, perk, artifacts, augments, synergies, or hidden state";
const COMMON_REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface IPublicSetupRecord extends IPublicSetupOutcomeRecord {
    candidateId: string;
    candidateFamily: PublicSetupCandidate["family"];
    boardIndex: number;
    game: number;
    pickSeed: number;
    battleSeed: number;
    pickSeat: "candidate-lower" | "candidate-upper";
    battleMirror: 0 | 1;
    candidateSide: Side;
    opponentGroup: IPublicSetupChoices["opponentGroup"];
    matchedRuleIds: string[];
    controlAugmentPlanId: string;
    candidateAugmentPlanId: string;
    controlSynergies: ISetupSynergyChoice[];
    candidateSynergies: ISetupSynergyChoice[];
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    setupFingerprintSha256: string;
    behaviorTraceSha256: string;
}

export interface IPublicSetupCluster {
    candidateId: string;
    board: IPublicSetupBoard;
    records: [IPublicSetupRecord, IPublicSetupRecord, IPublicSetupRecord, IPublicSetupRecord];
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function deepFreezeResearch<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value as Record<string, unknown>)) deepFreezeResearch(child);
        Object.freeze(value);
    }
    return value;
}

const REQUIRED_RESEARCH_ENV = {
    LIVETWIN: "1",
    V07_SEARCH: "0",
} as const;
const PUBLIC_SETUP_BOOTSTRAP_MARKER = "HOC_PUBLIC_SETUP_SANITIZED";

function verifyBootstrappedResearchEnvironment(): Record<string, string> {
    if (process.env[PUBLIC_SETUP_BOOTSTRAP_MARKER] !== "1") {
        throw new Error("public setup runner must be loaded through v0_7_public_setup_search.ts");
    }
    for (const [key, required] of Object.entries(REQUIRED_RESEARCH_ENV)) {
        if (process.env[key] !== required) {
            throw new Error(`public setup bootstrap requires ${key}=${required} before runner import`);
        }
    }
    const behaviorKey =
        /^(?:V0\d_|SEARCH_|Q2_|FIGHT_MELEE_ROSTERS$|FORCE_CREATURES$|ROSTER_|LIVETWIN$|SIM_NO_ACTIONS$|COHORT$|VALUE_DATA|PHASE_B_RUN_FINGERPRINT$|HOC_DRAFT_WEIGHTS$)/;
    for (const [key, value] of Object.entries(process.env)) {
        if (!behaviorKey.test(key)) continue;
        const required = REQUIRED_RESEARCH_ENV[key as keyof typeof REQUIRED_RESEARCH_ENV];
        if (required === undefined) throw new Error(`unsafe behavior-affecting environment variable ${key}`);
        if (value !== required) throw new Error(`unsafe ${key}=${JSON.stringify(value)}; required ${required}`);
    }
    return { ...REQUIRED_RESEARCH_ENV, SIM_NO_ACTIONS: "<unset>" };
}

function relevantSourceHashes(): Record<string, string> {
    const sources: Record<string, URL> = {
        runner: new URL(import.meta.url),
        bootstrap: new URL("./v0_7_public_setup_search.ts", import.meta.url),
        core: new URL("./v0_7_public_setup_search_core.ts", import.meta.url),
        setupShip: new URL("../../ai/setup/setup_ship.ts", import.meta.url),
        setupArtifact: new URL("../../ai/setup/setup_policies/v07_nonfight_4eda84635fe7.json", import.meta.url),
        draftShip: new URL("../../ai/setup/draft_ship.ts", import.meta.url),
        battleEngine: new URL("../battle_engine.ts", import.meta.url),
        rankedPickDriver: new URL("../measure_setup_conditional.ts", import.meta.url),
        fightPolicy: new URL("../../ai/versions/v0_7.ts", import.meta.url),
        placementPolicy: new URL("../../ai/versions/v0_7_placement_reveal.ts", import.meta.url),
    };
    const explicit = Object.fromEntries(
        Object.entries(sources).map(([label, url]) => [
            label,
            createHash("sha256").update(readFileSync(url)).digest("hex"),
        ]),
    );
    const trackedSources = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src"],
        { cwd: COMMON_REPOSITORY_ROOT, encoding: "utf8" },
    )
        .split("\u0000")
        .filter(Boolean)
        .sort();
    const treeHash = createHash("sha256");
    for (const path of trackedSources) {
        const content = readFileSync(join(COMMON_REPOSITORY_ROOT, path));
        treeHash.update(`${path.length}:${path}:${content.length}:`);
        treeHash.update(content);
    }
    return { ...explicit, srcTree: treeHash.digest("hex") };
}

function gitSourceStatus(): { dirty: boolean; sha256: string } {
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "src"], {
        cwd: COMMON_REPOSITORY_ROOT,
        encoding: "utf8",
    });
    return { dirty: status.length > 0, sha256: createHash("sha256").update(status).digest("hex") };
}

function gitCommit(): string {
    return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: COMMON_REPOSITORY_ROOT,
        encoding: "utf8",
    }).trim();
}

function resultForCandidateSide(result: IMatchResult, side: Side): "win" | "loss" | "draw" {
    if (result.winner === "draw") return "draw";
    return result.winner === side ? "win" : "loss";
}

interface IArmySetup {
    augments: ISetupAugmentChoice[];
    synergies: ISetupSynergyChoice[];
    choices: IPublicSetupChoices;
}

function armySetup(candidate: PublicSetupCandidate, own: IConditionalArmy, opponent: IConditionalArmy): IArmySetup {
    const choices = selectPublicSetupChoices(candidate, own.creatureIds, opponent.creatureIds);
    return { augments: choices.augments, synergies: choices.synergies, choices };
}

function playPublicSetupGame(
    candidate: PublicSetupCandidate,
    board: IPublicSetupBoard,
    lower: IConditionalArmy,
    upper: IConditionalArmy,
    candidatePickedLower: boolean,
    battleMirror: 0 | 1,
    maxLaps: number,
): IPublicSetupRecord {
    const lowerSetup = armySetup(
        candidatePickedLower ? candidate : publicSetupCandidate("control/shipped-v07"),
        lower,
        upper,
    );
    const upperSetup = armySetup(
        candidatePickedLower ? publicSetupCandidate("control/shipped-v07") : candidate,
        upper,
        lower,
    );
    const candidateArmy = candidatePickedLower ? lower : upper;
    const candidateSetup = candidatePickedLower ? lowerSetup : upperSetup;
    const greenArmy = battleMirror === 0 ? lower : upper;
    const redArmy = battleMirror === 0 ? upper : lower;
    const greenSetup = battleMirror === 0 ? lowerSetup : upperSetup;
    const redSetup = battleMirror === 0 ? upperSetup : lowerSetup;
    const candidateIsGreen = battleMirror === 0 ? candidatePickedLower : !candidatePickedLower;
    const candidateSide: Side = candidateIsGreen ? "green" : "red";
    const config: IMatchConfig = {
        greenVersion: "v0.7",
        redVersion: "v0.7",
        roster: greenArmy.roster,
        redRoster: redArmy.roster,
        seed: board.battleSeed,
        gridType: board.gridType,
        maxLaps,
        greenPerk: greenArmy.perk,
        redPerk: redArmy.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
        greenArtifactT1: greenArmy.tier1Artifact,
        redArtifactT1: redArmy.tier1Artifact,
        greenArtifactT2: greenArmy.tier2Artifact,
        redArtifactT2: redArmy.tier2Artifact,
        greenSynergies: greenSetup.synergies,
        redSynergies: redSetup.synergies,
        greenRevealedCreatures: greenArmy.revealedOpponentCreatures,
        redRevealedCreatures: redArmy.revealedOpponentCreatures,
        greenSetupPlacementPolicy: SHIPPED_SETUP.placement,
        redSetupPlacementPolicy: SHIPPED_SETUP.placement,
        placementAugmentTiming: "setup-before-placement",
    };
    FightStateManager.getInstance();
    const result = runMatch(config);
    if (result.gridType !== board.gridType) {
        throw new Error(
            `public setup map mismatch on board ${board.index}: expected ${board.gridType}, received ${result.gridType}`,
        );
    }
    if (result.rejectedGreen === undefined || result.rejectedRed === undefined) {
        throw new Error(`public setup board ${board.index} omitted rejection telemetry`);
    }
    return {
        candidateId: candidate.id,
        candidateFamily: candidate.family,
        boardIndex: board.index,
        game: (candidatePickedLower ? 0 : 2) + battleMirror,
        pairSeed: board.pairSeed,
        pickSeed: board.pickSeed,
        battleSeed: board.battleSeed,
        gridType: board.gridType,
        pickSeat: candidatePickedLower ? "candidate-lower" : "candidate-upper",
        battleMirror,
        candidateSide,
        candidateResult: resultForCandidateSide(result, candidateSide),
        ownGroup: candidateSetup.choices.ownGroup,
        ownTags: candidateSetup.choices.ownTags,
        opponentGroup: candidateSetup.choices.opponentGroup,
        matchedRuleIds: candidateSetup.choices.matchedRuleIds,
        actionApplied: candidateSetup.choices.actionApplied,
        controlAugmentPlanId: candidateSetup.choices.controlAugmentPlanId,
        candidateAugmentPlanId: candidateSetup.choices.candidateAugmentPlanId,
        controlSynergies: SHIPPED_SETUP.pickSynergies(candidateArmy.creatureIds),
        candidateSynergies: candidateSetup.synergies,
        candidateRejections: candidateIsGreen ? result.rejectedGreen : result.rejectedRed,
        baselineRejections: candidateIsGreen ? result.rejectedRed : result.rejectedGreen,
        laps: result.laps,
        totalActions: result.totalActions,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        setupFingerprintSha256: sha256({
            lowerCreatureIds: lower.creatureIds,
            upperCreatureIds: upper.creatureIds,
            lowerSetup,
            upperSetup,
            lowerReveals: lower.revealedOpponentCreatures,
            upperReveals: upper.revealedOpponentCreatures,
            gridType: board.gridType,
        }),
        behaviorTraceSha256: rankedDraftBehaviorTraceSha256(result),
    };
}

/** One live pick crossed with both candidate pick seats and both combat sides. */
export function evaluatePublicSetupCluster(
    candidate: PublicSetupCandidate,
    board: IPublicSetupBoard,
    maxLaps: number = 60,
): IPublicSetupCluster {
    const pick = rankedPickForBoard(board);
    const records = ([true, false] as const).flatMap((candidatePickedLower) =>
        ([0, 1] as const).map((battleMirror) =>
            playPublicSetupGame(candidate, board, pick.lower, pick.upper, candidatePickedLower, battleMirror, maxLaps),
        ),
    ) as IPublicSetupCluster["records"];
    return { candidateId: candidate.id, board, records };
}

function rankedPickForBoard(board: IPublicSetupBoard): { lower: IConditionalArmy; upper: IConditionalArmy } {
    return runRankedConditionalPickGame(board.pickSeed, RULES, SHIPPED_DRAFT, {
        pickArtifactT2: (_team, offered, ownCreatureIds) => SHIPPED_SETUP.pickArtifactT2(offered, ownCreatureIds),
    });
}

const candidatePlanKey = (candidateId: string, boardIndex: number): string => `${candidateId}\u0000${boardIndex}`;

/** Draft-only, outcome-blind preflight. The returned plan is frozen and hashed before any fight worker starts. */
export function buildPublicSetupBoardPlan(options: {
    candidates: readonly PublicSetupCandidate[];
    panel: SetupSeedPanel;
    baseSeed: number;
    naturalBoards: number;
    stratumBoards: number;
    stratifiedScanCap: number;
}): IPublicSetupBoardPlan {
    if (options.stratifiedScanCap < options.naturalBoards) {
        throw new RangeError("stratified scan cap must cover every natural board");
    }
    const nonControl = options.candidates.filter((candidate) => candidate.family !== "control");
    const state = new Map(
        nonControl.map((candidate) => {
            const strata = publicSetupCandidateStrata(candidate);
            return [
                candidate.id,
                {
                    candidate,
                    strata,
                    fills: new Map(
                        strata.map((stratum) => [publicSetupStratumKey(stratum), [] as IPublicSetupStratifiedBoard[]]),
                    ),
                },
            ];
        }),
    );
    const complete = (): boolean =>
        [...state.values()].every(({ fills }) =>
            [...fills.values()].every((entries) => entries.length >= options.stratumBoards),
        );
    let scanIndex = options.naturalBoards;
    while (scanIndex < options.stratifiedScanCap && !complete()) {
        const board = publicSetupBoard(options.baseSeed, options.panel, scanIndex);
        const pick = rankedPickForBoard(board);
        for (const { candidate, strata, fills } of state.values()) {
            for (const pickSeat of ["lower", "upper"] as const) {
                const own = pickSeat === "lower" ? pick.lower : pick.upper;
                const opponent = pickSeat === "lower" ? pick.upper : pick.lower;
                const choices = selectPublicSetupChoices(candidate, own.creatureIds, opponent.creatureIds);
                if (!choices.actionApplied) continue;
                const stratum = strata.find(
                    (entry) =>
                        entry.pickSeat === pickSeat &&
                        entry.gridType === board.gridType &&
                        choices.ownTags.includes(entry.ownTag) &&
                        choices.matchedRuleIds.includes(entry.ruleId) &&
                        fills.get(publicSetupStratumKey(entry))!.length < options.stratumBoards,
                );
                if (stratum) fills.get(publicSetupStratumKey(stratum))!.push({ stratum, board });
            }
        }
        scanIndex += 1;
    }
    const candidates: IPublicSetupCandidateBoardPlan[] = nonControl.map((candidate) => {
        const { strata, fills } = state.get(candidate.id)!;
        const unfilledStrata = strata
            .map((stratum) => ({
                stratum,
                filled: fills.get(publicSetupStratumKey(stratum))!.length,
                planned: options.stratumBoards,
            }))
            .filter(({ filled, planned }) => filled !== planned);
        const supported = unfilledStrata.length === 0;
        return {
            candidateId: candidate.id,
            supported,
            strata,
            stratifiedBoards: supported ? strata.flatMap((stratum) => fills.get(publicSetupStratumKey(stratum))!) : [],
            unfilledStrata,
        };
    });
    const naturalBoards = Array.from({ length: options.naturalBoards }, (_, index) =>
        publicSetupBoard(options.baseSeed, options.panel, index),
    );
    const controlByIndex = new Map(naturalBoards.map((board) => [board.index, board]));
    for (const candidate of candidates) {
        if (!candidate.supported) continue;
        for (const { board } of candidate.stratifiedBoards) controlByIndex.set(board.index, board);
    }
    return Object.freeze({
        schemaVersion: 1 as const,
        panel: options.panel,
        baseSeed: options.baseSeed,
        naturalBoards: Object.freeze(naturalBoards),
        stratumBoards: options.stratumBoards,
        stratifiedScanCap: options.stratifiedScanCap,
        scannedBoards: scanIndex - options.naturalBoards,
        candidates: Object.freeze(candidates),
        controlBoards: Object.freeze([...controlByIndex.values()].sort((left, right) => left.index - right.index)),
    });
}

export function plannedPublicSetupClusters(
    plan: IPublicSetupBoardPlan,
    candidates: readonly PublicSetupCandidate[],
): Map<string, { candidate: PublicSetupCandidate; board: IPublicSetupBoard }> {
    const expected = new Map<string, { candidate: PublicSetupCandidate; board: IPublicSetupBoard }>();
    const control = publicSetupCandidate("control/shipped-v07");
    for (const board of plan.controlBoards)
        expected.set(candidatePlanKey(control.id, board.index), { candidate: control, board });
    for (const candidatePlan of plan.candidates) {
        if (!candidatePlan.supported) continue;
        const candidate = candidates.find((entry) => entry.id === candidatePlan.candidateId)!;
        const boards = new Map(plan.naturalBoards.map((board) => [board.index, board]));
        for (const { board } of candidatePlan.stratifiedBoards) boards.set(board.index, board);
        for (const board of boards.values()) {
            expected.set(candidatePlanKey(candidate.id, board.index), { candidate, board });
        }
    }
    return expected;
}

function assertPublicSetupClusterMatchesPlan(
    cluster: IPublicSetupCluster,
    candidate: PublicSetupCandidate,
    board: IPublicSetupBoard,
): void {
    const key = candidatePlanKey(candidate.id, board.index);
    if (cluster.candidateId !== candidate.id || JSON.stringify(cluster.board) !== JSON.stringify(board)) {
        throw new Error(`cluster does not match frozen candidate/board plan: ${key}`);
    }
    if (cluster.records.length !== 4) throw new Error(`cluster ${key} has ${cluster.records.length}/4 games`);
    const expectedGames = new Set([0, 1, 2, 3]);
    for (const record of cluster.records) {
        if (!expectedGames.delete(record.game))
            throw new Error(`cluster ${key} has duplicate/invalid game ${record.game}`);
        const expectedPickSeat = record.game < 2 ? "candidate-lower" : "candidate-upper";
        const expectedBattleMirror = (record.game % 2) as 0 | 1;
        const expectedCandidateSide = record.game === 0 || record.game === 3 ? "green" : "red";
        if (
            record.candidateId !== candidate.id ||
            record.candidateFamily !== candidate.family ||
            record.boardIndex !== board.index ||
            record.pairSeed !== board.pairSeed ||
            record.pickSeed !== board.pickSeed ||
            record.battleSeed !== board.battleSeed ||
            record.gridType !== board.gridType ||
            record.pickSeat !== expectedPickSeat ||
            record.battleMirror !== expectedBattleMirror ||
            record.candidateSide !== expectedCandidateSide
        ) {
            throw new Error(`cluster ${key} game ${record.game} has invalid frozen-plan membership`);
        }
    }
}

interface IPublicSetupWorkerJob {
    candidate: PublicSetupCandidate;
    board: IPublicSetupBoard;
    maxLaps: number;
}

type PublicSetupWorkerReply =
    | { type: "ready" }
    | { type: "result"; cluster: IPublicSetupCluster }
    | { type: "error"; error: string };

async function runJobs(
    jobs: readonly IPublicSetupWorkerJob[],
    workers: number,
    jobTimeoutMs: number,
    onCluster: (cluster: IPublicSetupCluster, completed: number, total: number) => void,
): Promise<void> {
    if (!jobs.length) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const pool: Worker[] = [];
        const assigned = new Map<Worker, IPublicSetupWorkerJob>();
        const timers = new Map<Worker, ReturnType<typeof setTimeout>>();
        const intentionalExit = new WeakSet<Worker>();
        let cursor = 0;
        let completed = 0;
        let stopped = false;
        const clearWorkerTimer = (worker: Worker): void => {
            const timer = timers.get(worker);
            if (timer) clearTimeout(timer);
            timers.delete(worker);
        };
        const cleanup = (): void =>
            pool.forEach((worker) => {
                intentionalExit.add(worker);
                clearWorkerTimer(worker);
                void worker.terminate();
            });
        const fail = (error: unknown): void => {
            if (stopped) return;
            stopped = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (cursor >= jobs.length) {
                intentionalExit.add(worker);
                worker.postMessage({ type: "stop" });
                return;
            }
            const job = jobs[cursor++];
            assigned.set(worker, job);
            clearWorkerTimer(worker);
            timers.set(
                worker,
                setTimeout(() => {
                    fail(
                        new Error(
                            `worker watchdog expired after ${jobTimeoutMs}ms for ${job.candidate.id}/${job.board.index}`,
                        ),
                    );
                }, jobTimeoutMs),
            );
            worker.postMessage({ type: "job", job });
        };
        const poolSize = Math.max(1, Math.min(Math.floor(workers), jobs.length));
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(new URL(import.meta.url), { workerData: { publicSetupWorker: true } });
            pool.push(worker);
            timers.set(
                worker,
                setTimeout(
                    () => fail(new Error(`worker startup watchdog expired after ${jobTimeoutMs}ms`)),
                    jobTimeoutMs,
                ),
            );
            worker.on("message", (message: PublicSetupWorkerReply) => {
                if (message.type === "error") {
                    clearWorkerTimer(worker);
                    return fail(new Error(message.error));
                }
                if (message.type === "ready") return dispatch(worker);
                clearWorkerTimer(worker);
                const job = assigned.get(worker);
                assigned.delete(worker);
                if (!job) return fail(new Error("worker returned a cluster without an assigned job"));
                try {
                    assertPublicSetupClusterMatchesPlan(message.cluster, job.candidate, job.board);
                } catch (error) {
                    return fail(error);
                }
                completed += 1;
                onCluster(message.cluster, completed, jobs.length);
                if (completed === jobs.length) {
                    stopped = true;
                    cleanup();
                    resolvePromise();
                } else {
                    dispatch(worker);
                }
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                clearWorkerTimer(worker);
                if (!stopped && !intentionalExit.has(worker)) {
                    fail(new Error(`public setup worker exited unexpectedly with code ${code}`));
                }
            });
        }
    });
}

if (!isMainThread && parentPort && (workerData as { publicSetupWorker?: boolean }).publicSetupWorker) {
    parentPort.on("message", (message: { type: "job"; job: IPublicSetupWorkerJob } | { type: "stop" }) => {
        if (message.type === "stop") return parentPort!.close();
        try {
            const { candidate, board, maxLaps } = message.job;
            parentPort!.postMessage({
                type: "result",
                cluster: evaluatePublicSetupCluster(candidate, board, maxLaps),
            });
        } catch (error) {
            parentPort!.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    parentPort!.postMessage({ type: "ready" });
}

interface IPublicSetupRunIdentity {
    schemaVersion: 3;
    setupSpec: string;
    setupBehaviorSha256: string;
    draftSpec: string;
    fightVersion: "v0.7";
    informationBoundary: string;
    panel: SetupSeedPanel;
    baseSeed: number;
    maxLaps: number;
    jobTimeoutMs: number;
    maps: readonly SetupLiveGridType[];
    clusterSize: 4;
    candidates: readonly PublicSetupCandidate[];
    boardPlan: IPublicSetupBoardPlan;
    boardPlanSha256: string;
    gitCommit: string;
    gitSourceDirty: boolean;
    gitSourceStatusSha256: string;
    sourceHashes: Record<string, string>;
    sanitizedEnv: Record<string, string>;
}

interface IPublicSetupManifest {
    identity: IPublicSetupRunIdentity;
    identitySha256: string;
    createdAt: string;
}

function ensureManifest(outDir: string, identity: IPublicSetupRunIdentity): IPublicSetupManifest {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, "manifest.json");
    const boardPlanPath = join(outDir, "board-plan.json");
    const identitySha256 = sha256(identity);
    if (existsSync(path)) {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as IPublicSetupManifest;
        if (manifest.identitySha256 !== identitySha256 || sha256(manifest.identity) !== identitySha256) {
            throw new Error(`resume identity mismatch in ${path}; use a new --out directory`);
        }
        if (
            !existsSync(boardPlanPath) ||
            sha256(JSON.parse(readFileSync(boardPlanPath, "utf8"))) !== identity.boardPlanSha256
        ) {
            throw new Error(`resume board plan is missing or corrupt in ${boardPlanPath}`);
        }
        return manifest;
    }
    for (const artifact of ["board-plan.json", "clusters.jsonl", "report.json"]) {
        const artifactPath = join(outDir, artifact);
        if (existsSync(artifactPath) && statSync(artifactPath).size > 0) {
            throw new Error(`refusing manifest-less output with existing ${artifactPath}; use a new --out directory`);
        }
    }
    writeFileSync(boardPlanPath, `${JSON.stringify(identity.boardPlan, null, 2)}\n`);
    const manifest = { identity, identitySha256, createdAt: new Date().toISOString() };
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

interface IPublicSetupRunLock {
    schemaVersion: 1;
    pid: number;
    identitySha256: string;
    createdAt: string;
}

function acquireRunLock(outDir: string, identitySha256: string): () => void {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, ".run.lock");
    const lock: IPublicSetupRunLock = {
        schemaVersion: 1,
        pid: process.pid,
        identitySha256,
        createdAt: new Date().toISOString(),
    };
    let descriptor: number | undefined;
    try {
        descriptor = openSync(path, "wx");
        writeFileSync(descriptor, `${JSON.stringify(lock)}\n`);
        closeSync(descriptor);
        descriptor = undefined;
    } catch (error) {
        if (descriptor !== undefined) {
            closeSync(descriptor);
            try {
                unlinkSync(path);
            } catch {
                // Preserve the original lock-write failure.
            }
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(`public setup output is locked; verify no run is active, then remove ${path}`);
        }
        throw error;
    }
    const releaseFile = (): void => {
        try {
            const current = JSON.parse(readFileSync(path, "utf8")) as IPublicSetupRunLock;
            if (current.pid === process.pid && current.identitySha256 === identitySha256) unlinkSync(path);
        } catch {
            // A missing or replaced lock must not be removed by this process.
        }
    };
    process.once("exit", releaseFile);
    return () => {
        process.off("exit", releaseFile);
        releaseFile();
    };
}

export interface IPublicSetupLedgerEnvelope {
    schemaVersion: 1;
    key: string;
    payloadSha256: string;
    cluster: IPublicSetupCluster;
}

export function publicSetupLedgerEnvelope(cluster: IPublicSetupCluster): IPublicSetupLedgerEnvelope {
    return {
        schemaVersion: 1,
        key: candidatePlanKey(cluster.candidateId, cluster.board.index),
        payloadSha256: sha256(cluster),
        cluster,
    };
}

export function loadPublicSetupLedger(
    path: string,
    expected: ReadonlyMap<string, { candidate: PublicSetupCandidate; board: IPublicSetupBoard }>,
): Map<string, IPublicSetupCluster> {
    const clusters = new Map<string, IPublicSetupCluster>();
    if (!existsSync(path)) return clusters;
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    let recoveredMalformedFinalLine = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let envelope: IPublicSetupLedgerEnvelope;
        try {
            envelope = JSON.parse(line) as IPublicSetupLedgerEnvelope;
        } catch (error) {
            const malformedFinalUnterminated = index === lines.length - 1 && !raw.endsWith("\n");
            if (malformedFinalUnterminated) {
                const validPrefix = lines.slice(0, index).join("\n") + (index > 0 ? "\n" : "");
                truncateSync(path, Buffer.byteLength(validPrefix));
                recoveredMalformedFinalLine = true;
                break;
            }
            throw new Error(`invalid JSONL in ${path}:${index + 1}: ${String(error)}`);
        }
        if (envelope.schemaVersion !== 1 || envelope.payloadSha256 !== sha256(envelope.cluster)) {
            throw new Error(`checksum failure in ${path}:${index + 1}`);
        }
        const cluster = envelope.cluster;
        const key = candidatePlanKey(cluster.candidateId, cluster.board.index);
        if (envelope.key !== key) throw new Error(`ledger key mismatch in ${path}:${index + 1}`);
        const planned = expected.get(key);
        if (!planned) throw new Error(`ledger contains cluster outside frozen board plan: ${key}`);
        assertPublicSetupClusterMatchesPlan(cluster, planned.candidate, planned.board);
        if (clusters.has(key)) throw new Error(`duplicate ledger cluster ${key}`);
        clusters.set(key, cluster);
    }
    if (raw && !raw.endsWith("\n") && !recoveredMalformedFinalLine) appendFileSync(path, "\n");
    return clusters;
}

function buildReport(manifest: IPublicSetupManifest, clusters: readonly IPublicSetupCluster[], startedAt: number) {
    const plan = manifest.identity.boardPlan;
    const currentSourceStatus = gitSourceStatus();
    const currentGitCommit = gitCommit();
    const sourceAttestation = {
        gitCommit: currentGitCommit,
        gitSourceDirty: currentSourceStatus.dirty,
        gitSourceStatusSha256: currentSourceStatus.sha256,
        matchesLaunchIdentity:
            currentGitCommit === manifest.identity.gitCommit &&
            currentSourceStatus.dirty === manifest.identity.gitSourceDirty &&
            currentSourceStatus.sha256 === manifest.identity.gitSourceStatusSha256,
    };
    const expected = plannedPublicSetupClusters(plan, manifest.identity.candidates);
    const completedKeys = new Set(
        clusters.map((cluster) => candidatePlanKey(cluster.candidateId, cluster.board.index)),
    );
    const runComplete =
        completedKeys.size === expected.size && [...expected.keys()].every((key) => completedKeys.has(key));
    const controlRecords = clusters
        .filter((cluster) => cluster.candidateId === "control/shipped-v07")
        .flatMap((cluster) => cluster.records);
    const naturalIndices = new Set(plan.naturalBoards.map((board) => board.index));
    const controlNaturalRecords = clusters
        .filter((cluster) => cluster.candidateId === "control/shipped-v07" && naturalIndices.has(cluster.board.index))
        .flatMap((cluster) => cluster.records);
    const controlParity = validatePublicSetupControlParity(controlRecords, plan.controlBoards.length * 4);
    const nonControlCandidateCount = manifest.identity.candidates.filter(
        (candidate) => candidate.family !== "control",
    ).length;
    const summaries = Object.fromEntries(
        manifest.identity.candidates.map((candidate) => {
            const candidatePlan = plan.candidates.find((entry) => entry.candidateId === candidate.id);
            const candidateClusters = clusters.filter((cluster) => cluster.candidateId === candidate.id);
            const allCandidateRecords = candidateClusters.flatMap((cluster) => cluster.records);
            const naturalRecords = candidateClusters
                .filter((cluster) => naturalIndices.has(cluster.board.index))
                .flatMap((cluster) => cluster.records);
            const stratifiedKeys = new Set(
                (candidatePlan?.stratifiedBoards ?? []).flatMap(({ board, stratum }) =>
                    (stratum.pickSeat === "lower" ? [0, 1] : [2, 3]).map((game) => `${board.pairSeed}\u0000${game}`),
                ),
            );
            const stratifiedActionableRecords = candidateClusters
                .flatMap((cluster) => cluster.records)
                .filter(
                    (record) => stratifiedKeys.has(`${record.pairSeed}\u0000${record.game}`) && record.actionApplied,
                );
            const summary = summarizePublicSetup(
                candidate.family === "control" ? controlNaturalRecords : naturalRecords,
                stratifiedActionableRecords,
                controlRecords,
            );
            const plannedNaturalGames = candidatePlan?.supported ? plan.naturalBoards.length * 4 : 0;
            const plannedStratifiedActionableGames = candidatePlan?.supported
                ? candidatePlan.stratifiedBoards.length * 2
                : 0;
            return [
                candidate.id,
                {
                    candidate,
                    actionableCohorts:
                        candidate.family === "augment" ? publicSetupAugmentActionableCohorts(candidate) : undefined,
                    boardPlan: candidatePlan,
                    summary,
                    gate: publicSetupPromotionGate(candidate, summary, {
                        panel: plan.panel,
                        runComplete,
                        candidateFrozen: true,
                        nonControlCandidateCount,
                        candidateSupported: candidate.family === "control" ? true : (candidatePlan?.supported ?? false),
                        sourceClean: !manifest.identity.gitSourceDirty && sourceAttestation.matchesLaunchIdentity,
                        allCandidateRejections: allCandidateRecords.reduce(
                            (sum, record) => sum + record.candidateRejections + record.baselineRejections,
                            0,
                        ),
                        plannedNaturalGames,
                        plannedStratifiedActionableGames,
                        controlParity,
                    }),
                },
            ];
        }),
    );
    const ranking = Object.values(summaries)
        .filter((entry) => entry.candidate.family !== "control")
        .sort(
            (left, right) =>
                Number(
                    right.summary.stratifiedActionable.games >=
                        PUBLIC_SETUP_GUARD_THRESHOLDS.minimumStratifiedActionableGames,
                ) -
                    Number(
                        left.summary.stratifiedActionable.games >=
                            PUBLIC_SETUP_GUARD_THRESHOLDS.minimumStratifiedActionableGames,
                    ) ||
                right.summary.stratifiedActionable.confidence95LowGainPp -
                    left.summary.stratifiedActionable.confidence95LowGainPp ||
                right.summary.natural.confidence95LowGainPp - left.summary.natural.confidence95LowGainPp,
        )
        .map((entry) => entry.candidate.id);
    const guardEntry = Object.values(summaries).find((entry) => entry.candidate.family !== "control");
    const status = !runComplete
        ? "in_progress"
        : plan.panel !== "guard"
          ? "complete_exploratory_never_promotable"
          : guardEntry?.gate.promotable
            ? "complete_guard_pass_research_only"
            : "complete_guard_fail";
    const reportWithoutHash = {
        schemaVersion: 3,
        status,
        identity: manifest.identity,
        identitySha256: manifest.identitySha256,
        boardPlanSha256: manifest.identity.boardPlanSha256,
        completedClusters: clusters.length,
        expectedClusters: expected.size,
        completedGames: clusters.length * 4,
        wallSecondsThisProcess: (Date.now() - startedAt) / 1_000,
        guardThresholds: PUBLIC_SETUP_GUARD_THRESHOLDS,
        diagnosticTags: PUBLIC_SETUP_DIAGNOSTIC_TAGS,
        sourceAttestation,
        controlParity,
        unsupportedCandidates: plan.candidates.filter((candidate) => !candidate.supported),
        summaries,
        ranking,
    };
    return { ...reportWithoutHash, reportSha256: sha256(reportWithoutHash) };
}

function writeReport(path: string, report: unknown): void {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(temporary, path);
}

function selectedCandidates(
    family: string,
    requestedCandidateIds: readonly string[],
    compositeRuleIds: readonly string[],
    panel: SetupSeedPanel,
): PublicSetupCandidate[] {
    let selected: PublicSetupCandidate[];
    if (compositeRuleIds.length) {
        if (requestedCandidateIds.length) throw new Error("use either --candidate or --composite-rule, not both");
        selected = [publicSetupCandidate("control/shipped-v07"), publicSetupCompositeCandidate(compositeRuleIds)];
    } else if (requestedCandidateIds.length) {
        const requested = requestedCandidateIds.map(publicSetupCandidate);
        if (!requested.some((candidate) => candidate.family === "control")) {
            requested.unshift(publicSetupCandidate("control/shipped-v07"));
        }
        selected = [...new Map(requested.map((candidate) => [candidate.id, candidate])).values()];
    } else {
        if (!["all", "augment", "synergy", "control"].includes(family)) {
            throw new Error("family must be all, augment, synergy, or control");
        }
        selected =
            family === "control"
                ? [publicSetupCandidate("control/shipped-v07")]
                : PUBLIC_SETUP_CANDIDATES.filter(
                      (candidate) => candidate.family === "control" || family === "all" || candidate.family === family,
                  );
    }
    const nonControl = selected.filter((candidate) => candidate.family !== "control");
    if (panel === "guard" && nonControl.length !== 1) {
        throw new Error(
            "guard requires one frozen --candidate, or one canonical composite built with repeated --composite-rule",
        );
    }
    return selected;
}

export async function main(): Promise<void> {
    const sanitizedEnv = verifyBootstrappedResearchEnvironment();
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            out: { type: "string", default: "sim-out/v0_7_public_setup_search" },
            boards: { type: "string", default: "1000" },
            "base-seed": { type: "string", default: "97072710" },
            panel: { type: "string", default: "train" },
            workers: { type: "string", default: String(Math.min(12, availableParallelism())) },
            "max-laps": { type: "string", default: "60" },
            "checkpoint-every": { type: "string", default: "25" },
            "stratum-boards": { type: "string", default: "40" },
            "stratified-scan-cap": { type: "string", default: "100000" },
            "job-timeout-ms": { type: "string", default: "300000" },
            family: { type: "string", default: "all" },
            candidate: { type: "string", multiple: true, default: [] },
            "composite-rule": { type: "string", multiple: true, default: [] },
            "list-candidates": { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/optimizer/v0_7_public_setup_search.ts " +
                "[--out dir] [--boards 1000] [--base-seed N] [--panel train|selection|guard] " +
                "[--workers 12] [--family all|augment|synergy|control] [--candidate id ...] " +
                "[--composite-rule id ...] [--stratum-boards 40] [--stratified-scan-cap 100000] " +
                "[--max-laps 60] [--job-timeout-ms 300000] [--checkpoint-every 25] [--list-candidates]",
        );
        return;
    }
    if (values["list-candidates"]) {
        for (const candidate of PUBLIC_SETUP_CANDIDATES) {
            const coverage =
                candidate.family === "augment"
                    ? ` [actionable cohorts: ${publicSetupAugmentActionableCohorts(candidate).join(",")}]`
                    : "";
            console.log(`${candidate.id}\t${candidate.description}${coverage}`);
        }
        return;
    }
    const boards = Number(values.boards);
    const baseSeed = Number(values["base-seed"]);
    const panel = values.panel as SetupSeedPanel;
    const workers = Number(values.workers);
    const maxLaps = Number(values["max-laps"]);
    const checkpointEvery = Number(values["checkpoint-every"]);
    const stratumBoards = Number(values["stratum-boards"]);
    const stratifiedScanCap = Number(values["stratified-scan-cap"]);
    const jobTimeoutMs = Number(values["job-timeout-ms"]);
    if (!Number.isInteger(boards) || boards < 1) throw new RangeError("boards must be a positive integer");
    if (!Number.isSafeInteger(baseSeed)) throw new RangeError("base-seed must be a safe integer");
    if (!["train", "selection", "guard"].includes(panel)) {
        throw new Error("panel must be train, selection, or guard");
    }
    if (!Number.isInteger(workers) || workers < 1) throw new RangeError("workers must be a positive integer");
    if (!Number.isInteger(maxLaps) || maxLaps < 1) throw new RangeError("max-laps must be a positive integer");
    if (!Number.isInteger(checkpointEvery) || checkpointEvery < 1) {
        throw new RangeError("checkpoint-every must be a positive integer");
    }
    if (!Number.isInteger(stratumBoards) || stratumBoards < 1) {
        throw new RangeError("stratum-boards must be a positive integer");
    }
    if (!Number.isInteger(stratifiedScanCap) || stratifiedScanCap < boards) {
        throw new RangeError("stratified-scan-cap must be an integer covering all natural boards");
    }
    if (!Number.isInteger(jobTimeoutMs) || jobTimeoutMs < 1_000) {
        throw new RangeError("job-timeout-ms must be an integer >= 1000");
    }
    const launchGitCommit = gitCommit();
    const launchSourceStatus = gitSourceStatus();
    const launchSourceHashes = relevantSourceHashes();
    const candidates = deepFreezeResearch(
        selectedCandidates(values.family, values.candidate, values["composite-rule"], panel),
    );
    console.error(`preflight: freezing outcome-blind natural/stratified board plan (scan cap ${stratifiedScanCap})`);
    const boardPlan = deepFreezeResearch(
        buildPublicSetupBoardPlan({
            candidates,
            panel,
            baseSeed,
            naturalBoards: boards,
            stratumBoards,
            stratifiedScanCap,
        }),
    );
    const boardPlanSha256 = sha256(boardPlan);
    const preWorkerSourceStatus = gitSourceStatus();
    if (
        gitCommit() !== launchGitCommit ||
        preWorkerSourceStatus.dirty !== launchSourceStatus.dirty ||
        preWorkerSourceStatus.sha256 !== launchSourceStatus.sha256 ||
        sha256(relevantSourceHashes()) !== sha256(launchSourceHashes)
    ) {
        throw new Error("common source identity changed during draft preflight; restart in a stable checkout");
    }
    const outDir = resolve(values.out);
    const identity: IPublicSetupRunIdentity = {
        schemaVersion: 3,
        setupSpec: V07_NONFIGHT_SETUP_SPEC,
        setupBehaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256,
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        informationBoundary: INFORMATION_BOUNDARY,
        panel,
        baseSeed,
        maxLaps,
        jobTimeoutMs,
        maps: SETUP_LIVE_GRID_TYPES,
        clusterSize: 4,
        candidates,
        boardPlan,
        boardPlanSha256,
        gitCommit: launchGitCommit,
        gitSourceDirty: launchSourceStatus.dirty,
        gitSourceStatusSha256: launchSourceStatus.sha256,
        sourceHashes: launchSourceHashes,
        sanitizedEnv,
    };
    const releaseRunLock = acquireRunLock(outDir, sha256(identity));
    try {
        const manifest = ensureManifest(outDir, identity);
        const ledgerPath = join(outDir, "clusters.jsonl");
        const reportPath = join(outDir, "report.json");
        const expected = plannedPublicSetupClusters(boardPlan, candidates);
        const completed = loadPublicSetupLedger(ledgerPath, expected);
        const jobs = [...expected.entries()]
            .filter(([key]) => !completed.has(key))
            .map(([, job]) => ({ ...job, maxLaps }));
        const startedAt = Date.now();
        console.error(
            `public-setup ${panel}: plan=${boardPlanSha256.slice(0, 16)} ${jobs.length} missing/${expected.size} clusters ` +
                `(${jobs.length * 4} games), ${workers} workers`,
        );
        let sinceCheckpoint = 0;
        await runJobs(jobs, workers, jobTimeoutMs, (cluster, done, total) => {
            const key = candidatePlanKey(cluster.candidateId, cluster.board.index);
            if (completed.has(key)) throw new Error(`worker returned duplicate cluster ${key}`);
            appendFileSync(ledgerPath, `${JSON.stringify(publicSetupLedgerEnvelope(cluster))}\n`);
            completed.set(key, cluster);
            sinceCheckpoint += 1;
            if (sinceCheckpoint >= checkpointEvery || done === total) {
                sinceCheckpoint = 0;
                writeReport(reportPath, buildReport(manifest, [...completed.values()], startedAt));
                console.error(`  ${done}/${total} new clusters; ${completed.size}/${expected.size} persisted`);
            }
        });
        const report = buildReport(manifest, [...completed.values()], startedAt);
        writeReport(reportPath, report);
        console.error(`Report: ${reportPath}`);
        for (const candidateId of report.ranking.slice(0, 10)) {
            const entry = report.summaries[candidateId];
            console.error(
                `${candidateId}: matched ${entry.summary.natural.matchedGainPp >= 0 ? "+" : ""}` +
                    `${entry.summary.natural.matchedGainPp.toFixed(2)}pp ` +
                    `(LCB ${entry.summary.natural.confidence95LowGainPp.toFixed(2)}pp), stratified ` +
                    `${entry.summary.stratifiedActionable.matchedGainPp >= 0 ? "+" : ""}` +
                    `${entry.summary.stratifiedActionable.matchedGainPp.toFixed(2)}pp ` +
                    `(LCB ${entry.summary.stratifiedActionable.confidence95LowGainPp.toFixed(2)}pp, ` +
                    `${entry.summary.stratifiedActionable.games} games), promotable=${entry.gate.promotable}`,
            );
        }
    } finally {
        releaseRunLock();
    }
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
