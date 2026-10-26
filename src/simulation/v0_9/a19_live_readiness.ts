/** Complete decision timing on development boards, plus deterministic disabled-model parity. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { IAIStrategy, IDecisionContext } from "../../ai/ai_strategy";
import type { RankedDraftStrengthPolicyId } from "../../ai/setup/draft_strength_prior";
import { createV08A19Strategy } from "../../ai/versions/v0_8_a19_profile";
import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import { runMatch, type IMatchConfig } from "../battle_engine";
import { playRankedDraftGame, rankedDraftStrengthCandidate } from "../ranked_draft_eval";
import { SearchDriver } from "../search_driver";
import { withV09A19Correction, V09_A19_LIVE_INFERENCE_RESERVE_MS } from "./a19_correction";
import { V09A19CpuModel } from "./a19_inference";
import { readV09PilotSource } from "./a19_pilot_protocol";
import {
    validateV09A19StudentManifest,
    v09StudentFileSha256,
    type IV09A19StudentManifest,
} from "./a19_student_protocol";
import { fingerprintV09 } from "./protocol";

interface IDriver {
    horizon: number;
    rollouts: number;
    shortlist: number;
    complementaryR2: boolean;
    certifiedSelectionBounds: boolean;
    certifiedTightBounds: boolean;
    a19MaterialArbitration: string;
    decisionDeadlineMs: number | null;
    circuitBreakerMs: number | null;
    match: { offlineDeterministicWork?: boolean };
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
}

function timedStrategy(starts: Map<string, number>): IAIStrategy {
    const strategy = createV08A19Strategy();
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(strategy, {
        get(target, key) {
            if (methods.has(key)) return methods.get(key);
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            const bound =
                key === "decideTurn"
                    ? (unit: Unit, context: IDecisionContext) => {
                          if (context.decisionOrigin === "root") starts.set(unit.getId(), performance.now());
                          return target.decideTurn(unit, context);
                      }
                    : value.bind(target);
            methods.set(key, bound);
            return bound;
        },
    });
}

function play(
    manifest: IV09A19StudentManifest,
    model: V09A19CpuModel,
    board: number,
    index: number,
    mode: "stock-parity" | "disabled-parity" | "baseline-live" | "candidate-live",
    margin: number,
) {
    const offline = mode.endsWith("parity"),
        enabled = mode === "candidate-live",
        starts = new Map<string, number>(),
        stockArrays = new Map<string, GameAction[]>(),
        trace = createHash("sha256"),
        decisionMs: number[] = [];
    let referenceMismatches = 0;
    let statistics: ReturnType<typeof withV09A19Correction>["statistics"] | undefined;
    const baseline = manifest.parent.baseline;
    const genome = rankedDraftStrengthCandidate(manifest.parent.profile.draft as RankedDraftStrengthPolicyId);
    const record = playRankedDraftGame(
        genome,
        genome,
        {
            gamesPerOpponent: 8,
            baseSeed: manifest.registration.stages.development[board],
            mapTypes: [[1, 3, 4][board % 3]],
            fightProfile: "a19",
            maxLaps: 256,
            liveDraftRules: true,
            sideBoard: true,
            deterministicSearch: offline,
            liveSynergyVariants: true,
            tacticalSplits: true,
            candidateSearchEnvOverrides: baseline,
            candidateSetupPolicySpec: manifest.parent.profile.setup,
            opponentSetupPolicySpec: manifest.parent.profile.setup,
            candidateDoctrinePolicy: "see-none",
            opponentDoctrinePolicy: "see-none",
        },
        index,
        0,
        {
            matchRunner: (config: IMatchConfig) => {
                const team = config.searchEnvOverrideTeams?.[0];
                if (team === undefined) throw new Error("Live rehearsal lost its physical seat");
                const prototype = SearchDriver.prototype as unknown as IDriver;
                const native = prototype.chooseDecision;
                prototype.chooseDecision = function (...args) {
                    if (
                        (this.match.offlineDeterministicWork === true) !== offline ||
                        this.horizon !== Number(baseline.SEARCH_HORIZON) ||
                        this.rollouts !== 2 ||
                        this.shortlist !== 6 ||
                        !this.complementaryR2 ||
                        this.certifiedSelectionBounds !== (baseline.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS === "1") ||
                        this.certifiedTightBounds !== (baseline.SEARCH_A19_CERTIFIED_TIGHT_BOUNDS === "1") ||
                        this.a19MaterialArbitration !== baseline.SEARCH_A19_MATERIAL_ARBITRATION ||
                        (!offline && (this.decisionDeadlineMs !== 1000 || this.circuitBreakerMs !== 1500))
                    )
                        throw new Error("Actual timing driver differs from the frozen A19 profile");
                    const actions = native.apply(this, args);
                    stockArrays.set(args[0].getId(), actions);
                    return actions;
                };
                try {
                    const result = withV09A19Correction(
                        {
                            team,
                            model: enabled ? model : null,
                            minimumLogitGain: margin,
                            executionMode: offline ? "operation-bounded" : "wall-clock",
                        },
                        () => {
                            const corrected = prototype.chooseDecision;
                            prototype.chooseDecision = function (...args) {
                                const actions = corrected.apply(this, args);
                                if (!enabled && actions !== stockArrays.get(args[0].getId())) referenceMismatches++;
                                return actions;
                            };
                            try {
                                return runMatch({
                                    ...config,
                                    searchOfflineDeterministicWork: offline,
                                    headlessEvents: true,
                                    ...(mode === "stock-parity"
                                        ? {}
                                        : {
                                              greenStrategyOverride: timedStrategy(starts),
                                              redStrategyOverride: timedStrategy(starts),
                                          }),
                                    researchA19BaseSearchEnvironment: baseline,
                                    decisionObserver: ({ unit }) => {
                                        const started = starts.get(unit.getId());
                                        if (started !== undefined && unit.getTeam() === team)
                                            decisionMs.push(performance.now() - started);
                                        starts.delete(unit.getId());
                                    },
                                    turnExecutionObserver: (turn) => {
                                        trace.update(JSON.stringify([turn.side, turn.unitId, turn.chosenDecision]));
                                    },
                                });
                            } finally {
                                prototype.chooseDecision = corrected;
                            }
                        },
                    );
                    statistics = result.statistics;
                    return result.value;
                } finally {
                    prototype.chooseDecision = native;
                }
            },
        },
    );
    if (!statistics || record.rejectedCandidate || record.rejectedOpponent || record.endReason !== "elimination")
        throw new Error("Timing requires complete legal ranked games");
    return { mode, record, decisionMs, statistics, referenceMismatches, trajectorySha256: trace.digest("hex") };
}

async function main() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        strict: true,
        options: {
            manifest: { type: "string" },
            model: { type: "string" },
            out: { type: "string" },
            repository: { type: "string", default: process.cwd() },
            "minimum-turns": { type: "string", default: "1000" },
            diagnostic: { type: "boolean" },
            "production-cpu": { type: "boolean" },
        },
    });
    if (!values.manifest || !values.model || !values.out) throw new Error("Required: --manifest --model --out");
    const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as IV09A19StudentManifest;
    validateV09A19StudentManifest(manifest);
    const source = readV09PilotSource(resolve(values.repository));
    const bytes = readFileSync(values.model, "utf8"),
        minimumTurns = Number(values["minimum-turns"]);
    const diagnostic = values.diagnostic === true;
    if (
        source.sha256 !== manifest.source.sha256 ||
        Bun.version !== manifest.runtime ||
        v09StudentFileSha256(bytes) !== manifest.modelFileSha256 ||
        resolve(import.meta.path) !== join(resolve(values.repository), "src/simulation/v0_9/a19_live_readiness.ts") ||
        !Number.isInteger(minimumTurns) ||
        minimumTurns < (diagnostic ? 1 : 1000) ||
        minimumTurns > 20000 ||
        (manifest.diagnosticOnly && !diagnostic) ||
        (values["production-cpu"] && (diagnostic || process.platform !== "linux" || process.arch !== "x64"))
    )
        throw new Error("Use matching frozen inputs; production timing requires a trained model on Linux x64");
    const model = new V09A19CpuModel(JSON.parse(bytes), {
        manifestSha256: manifest.parent.manifestSha256,
        sourceSha256: manifest.parent.source.sha256,
    });
    const margin = diagnostic ? 0.000001 : manifest.minimumLogitGain;
    const games: ReturnType<typeof play>[] = [],
        baseline: number[] = [],
        candidate: number[] = [];
    let exactMatches = 0;
    for (let board = 0; board < manifest.registration.stages.development.length; board++) {
        for (let index = 0; index < 4; index++) {
            if (board < 3) {
                const stock = play(manifest, model, board, index, "stock-parity", margin);
                const disabled = play(manifest, model, board, index, "disabled-parity", margin);
                if (
                    stock.trajectorySha256 !== disabled.trajectorySha256 ||
                    fingerprintV09(stock.record) !== fingerprintV09(disabled.record) ||
                    disabled.referenceMismatches
                )
                    throw new Error("Disabled model changed a complete deterministic trajectory or action reference");
                exactMatches++;
                games.push(stock, disabled);
            }
            const control = play(manifest, model, board, index, "baseline-live", margin);
            const challenger = play(manifest, model, board, index, "candidate-live", margin);
            baseline.push(...control.decisionMs);
            candidate.push(...challenger.decisionMs);
            games.push(control, challenger);
        }
        if (board >= 2 && baseline.length >= minimumTurns && candidate.length >= minimumTurns) break;
    }
    if (baseline.length < minimumTurns || candidate.length < minimumTurns) throw new Error("Incomplete timing sample");
    const candidates = games.filter((game) => game.mode === "candidate-live");
    const sum = (key: "inferred" | "corrected" | "modelErrors" | "inferenceOverruns") =>
        candidates.reduce((n, game) => n + game.statistics[key], 0);
    if (!sum("inferred") || sum("modelErrors") || (!diagnostic && sum("inferenceOverruns")))
        throw new Error("Live neural timing did not exercise clean inference inside the deadline");
    baseline.sort((a, b) => a - b);
    candidate.sort((a, b) => a - b);
    const identity = {
        manifestSha256: manifest.manifestSha256,
        modelFileSha256: manifest.modelFileSha256,
        sourceSha256: source.sha256,
        runtime: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        diagnosticOnly: diagnostic,
        rejectedActions: 0,
    };
    const disabled = {
        schema: "hoc.ai.v0_9_a19_disabled_parity.v1",
        ...identity,
        games: exactMatches,
        trajectoryMismatches: 0,
        actionReferenceMismatches: 0,
    };
    const live = {
        schema: "hoc.ai.v0_9_a19_live_latency.v1",
        ...identity,
        executionMode: "wall-clock",
        productionCpu: values["production-cpu"] === true,
        cpuIdentity: `${process.arch}: ${cpus()[0]?.model}`,
        baselineProfileSha256: fingerprintV09(manifest.parent.profile),
        minimumLogitGain: margin,
        decisionDeadlineMs: 1000,
        circuitBreakerMs: 1500,
        inferenceReserveMs: V09_A19_LIVE_INFERENCE_RESERVE_MS,
        baselineTurns: baseline.length,
        candidateTurns: candidate.length,
        inferredTurns: sum("inferred"),
        correctedTurns: sum("corrected"),
        modelErrors: sum("modelErrors"),
        inferenceOverruns: sum("inferenceOverruns"),
        baselineP99Ms: baseline[Math.floor(baseline.length * 0.99)],
        baselineMaxMs: baseline.at(-1),
        candidateP99Ms: candidate[Math.floor(candidate.length * 0.99)],
        candidateMaxMs: candidate.at(-1),
        scope: "Native incumbent plus complete A19 search, feature extraction and neural correction; excludes action application/rendering",
    };
    mkdirSync(values.out, { recursive: false });
    writeFileSync(join(values.out, "disabled-parity.json"), JSON.stringify(disabled) + "\n", { flag: "wx" });
    writeFileSync(join(values.out, "live-latency.json"), JSON.stringify(live) + "\n", { flag: "wx" });
    writeFileSync(join(values.out, "raw-games.json"), JSON.stringify({ diagnosticOnly: diagnostic, games }) + "\n", {
        flag: "wx",
    });
    process.stdout.write(JSON.stringify({ disabled, live }) + "\n");
}

if (import.meta.main) await main();
