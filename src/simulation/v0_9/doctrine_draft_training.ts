/** Paired outcome collection, fitting and independently gated evaluation of the scouting draft head. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";

import { pickRankedLiveDraftBundle, pickRankedLiveDraftCreature } from "../../ai/setup/draft_ship";
import { creatureInfo } from "../../ai/setup/creature_score";
import { isRankedDraftStrengthPolicy } from "../../ai/setup/draft_strength_prior";
import { synergyVariantsForSeed } from "../../synergies/synergy_properties";
import type { A19AuditProfile } from "../a19_decision_audit";
import { makeRng } from "../army";
import { runMatch } from "../battle_engine";
import { exitCompletedWorkerCli } from "../completed_worker_cli";
import { PersistentWorkerPool, startPersistentWorker } from "../persistent_worker_pool";
import {
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    permuteRankedDraftSeed,
    sanitizedRankedDraftEnvironment,
    type IRankedDraftGameRecord,
    type IRankedDraftResearchChoices,
    type IRankedDraftResearchContext,
} from "../ranked_draft_eval";
import { assertV09DoctrineSetup, v09DoctrineBoard, V09_A19_DOCTRINES } from "./a19_doctrine_population";
import { withV09PilotDriverAudit } from "./a19_pilot";
import { readV09PilotSource } from "./a19_pilot_protocol";
import { fingerprintV09 } from "./protocol";
import {
    doctrineDraftFeatures,
    fitDoctrineDraftModel,
    predictDoctrineDraftGain,
    type DoctrineDraftModelVersion,
    type IDoctrineDraftChoice,
    type IDoctrineDraftExample,
    type IDoctrineDraftModel,
    type ScoutingDoctrine,
} from "./doctrine_draft_model";

export const DOCTRINE_DRAFT_STAGES = { smoke: 27, train: 810, development: 270, confirmation: 1512 } as const;
export const DOCTRINE_DRAFT_V2_STAGES = { smoke: 27, train: 1080, development: 540, confirmation: 1512 } as const;
type Stage = keyof typeof DOCTRINE_DRAFT_STAGES;
type Condition = "current" | "alternative" | "learned" | "masked";
export interface IDoctrineDraftRegistration {
    readonly schema: `hoc.ai.v0_9.doctrine_draft_training.${DoctrineDraftModelVersion}`;
    readonly sourceCommit: string;
    readonly sourceSha256: string;
    readonly profile: A19AuditProfile;
    readonly banks: Record<Stage, number[]>;
    readonly registrationSha256: string;
    readonly deadlineAtMs: number;
    readonly productionPromotion: false;
}
interface IDecision {
    level: number;
    preferred: number;
    alternative: number;
    features: number[];
    chosen: number;
}
interface IGame {
    record: IRankedDraftGameRecord;
    decisions: IDecision[];
}
interface IBoard {
    board: number;
    seed: number;
    stage: Stage;
    registrationSha256: string;
    modelSha256: string | null;
    candidateDoctrinePolicy: ScoutingDoctrine;
    opponentDoctrinePolicy: ScoutingDoctrine;
    map: number;
    conditions: Partial<Record<Condition, IGame[]>>;
    examples: IDoctrineDraftExample[];
    sha256: string;
}

const score = (game: IGame): number =>
    game.record.candidateResult === "win" ? 1 : game.record.candidateResult === "draw" ? 0.5 : 0;
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const save = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value) + "\n", { flag: "wx" });
const modelVersion = (registration: IDoctrineDraftRegistration): DoctrineDraftModelVersion =>
    registration.schema === "hoc.ai.v0_9.doctrine_draft_training.v2" ? "v2" : "v1";

export function doctrineDraftTrainingLevel(version: DoctrineDraftModelVersion, stage: Stage, board: number): number {
    if (version === "v2") return stage === "smoke" ? 3 : Math.floor(board / 27) % 4;
    return Math.floor(board / (stage === "smoke" ? 9 : 27)) % 3;
}

export function validateDoctrineDraftRegistration(registration: IDoctrineDraftRegistration): void {
    const { registrationSha256, ...body } = registration;
    const version = modelVersion(registration);
    const stages = version === "v2" ? DOCTRINE_DRAFT_V2_STAGES : DOCTRINE_DRAFT_STAGES;
    if (
        registration.schema !== `hoc.ai.v0_9.doctrine_draft_training.${version}` ||
        registration.productionPromotion !== false ||
        fingerprintV09(body) !== registrationSha256 ||
        !Number.isFinite(registration.deadlineAtMs)
    )
        throw new Error("Invalid doctrine draft registration");
    const used = new Set<number>();
    for (const stage of Object.keys(stages) as Stage[]) {
        if (registration.banks[stage]?.length !== stages[stage]) throw new Error("Incomplete registered bank");
        for (const seed of registration.banks[stage]) {
            if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_fffc) throw new Error("Invalid board seed");
            for (const offset of [0, 1, 2]) {
                if (used.has(seed + offset)) throw new Error("Overlapping seed channels");
                used.add(seed + offset);
            }
        }
    }
}

function runBoard(root: string, stage: Stage, board: number): IBoard {
    const registration = readJson<IDoctrineDraftRegistration>(join(root, "registration.json"));
    if (Date.now() >= registration.deadlineAtMs) throw new Error("Registered campaign deadline reached");
    const seed = registration.banks[stage][board];
    if (seed === undefined) throw new Error("Unregistered board");
    const training = stage === "train" || stage === "smoke";
    const version = modelVersion(registration);
    const lastDecisionLevel = version === "v2" ? 3 : 2;
    const model = training ? undefined : readJson<IDoctrineDraftModel>(join(root, "model.json"));
    if (model && model.schema !== `hoc.ai.v0_9.doctrine_draft.${version}`)
        throw new Error("Registered model version changed");
    if (!isRankedDraftStrengthPolicy(registration.profile.draft)) throw new Error("Unknown registered draft policy");
    const environment = Object.fromEntries(
        Object.entries(registration.profile.environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
    const genome = rankedDraftStrengthCandidate(registration.profile.draft);
    const policies = v09DoctrineBoard(board, "balanced-doctrines-v1") as {
        candidateDoctrinePolicy: ScoutingDoctrine;
        opponentDoctrinePolicy: ScoutingDoctrine;
    };
    const variants = synergyVariantsForSeed(`ranked-draft-${permuteRankedDraftSeed(seed + 1)}`);
    const conditions: IBoard["conditions"] = {};
    const targetLevel = doctrineDraftTrainingLevel(version, stage, board);
    const run = (condition: Condition, game: number): IGame => {
        const decisions: IDecision[] = [];
        let switched = false;
        const choose = (
            context: IRankedDraftResearchContext,
            preferred: number,
            alternative: number | undefined,
            base: IDoctrineDraftChoice,
            other: IDoctrineDraftChoice | undefined,
            level: number,
        ): number => {
            if (alternative === undefined || !other || switched || level > lastDecisionLevel) return preferred;
            if (training && level !== targetLevel) return preferred;
            const features = doctrineDraftFeatures(
                policies.candidateDoctrinePolicy,
                context,
                base,
                other,
                level,
                condition === "masked",
                version,
            );
            if (!features) return preferred;
            const shouldSwitch =
                condition === "alternative" ||
                (model !== undefined &&
                    condition !== "current" &&
                    predictDoctrineDraftGain(model, features) > model.switchMargin);
            const chosen = shouldSwitch ? alternative : preferred;
            decisions.push({ level, preferred, alternative, features, chosen });
            switched = shouldSwitch;
            return chosen;
        };
        const research: IRankedDraftResearchChoices = {
            bundle: (bundles, context, preferred) => {
                const remaining = bundles
                    .map((bundle, index) => ({ bundle, index }))
                    .filter((entry) => entry.index !== preferred);
                const other = remaining.length
                    ? remaining[
                          pickRankedLiveDraftBundle(
                              genome,
                              remaining.map((entry) => entry.bundle),
                              variants,
                              context.artifactFitVersion,
                              context.scouting,
                          )
                      ]
                    : undefined;
                return choose(
                    context,
                    preferred,
                    other?.index,
                    { creatureIds: bundles[preferred].slice(0, 2), tier1ArtifactId: bundles[preferred][2] },
                    other ? { creatureIds: other.bundle.slice(0, 2), tier1ArtifactId: other.bundle[2] } : undefined,
                    0,
                );
            },
            creature: (available, context, preferred) => {
                const level = creatureInfo(preferred)?.level ?? 4;
                if (level > lastDecisionLevel) return preferred;
                const alternative = pickRankedLiveDraftCreature(
                    genome,
                    available.filter((id) => id !== preferred),
                    context.ownCreatureIds,
                    context.knownOpponentCreatureIds,
                    context.tier1ArtifactId,
                    context.scouting.map,
                    variants,
                    context.tier2ArtifactId,
                    context.artifactFitVersion,
                    context.scouting,
                );
                return choose(
                    context,
                    preferred,
                    alternative,
                    { creatureIds: [preferred] },
                    alternative === undefined ? undefined : { creatureIds: [alternative] },
                    level,
                );
            },
        };
        const record = playRankedDraftGame(
            genome,
            genome,
            {
                gamesPerOpponent: 8,
                baseSeed: seed,
                mapTypes: [[1, 3, 4][board % 3]],
                fightProfile: "a19",
                maxLaps: 256,
                liveDraftRules: true,
                sideBoard: true,
                deterministicSearch: true,
                liveSynergyVariants: true,
                tacticalSplits: true,
                candidateSearchEnvOverrides: environment,
                candidateSetupPolicySpec: registration.profile.setup,
                opponentSetupPolicySpec: registration.profile.setup,
                ...policies,
            },
            game,
            0,
            {
                researchCandidateDraftChoices: research,
                matchRunner: (config) => {
                    assertV09DoctrineSetup(config, board);
                    return withV09PilotDriverAudit(config.searchEnvOverrideTeams![0], environment, environment, () =>
                        runMatch({
                            ...config,
                            headlessEvents: true,
                            researchA19BaseSearchEnvironment: environment,
                        }),
                    ).value;
                },
            },
        );
        if (record.rejectedCandidate || record.rejectedOpponent || record.endReason !== "elimination")
            throw new Error("Invalid or incomplete doctrine draft game");
        return { record, decisions };
    };
    const arms: Condition[] = training ? ["current", "alternative"] : ["current", "learned", "masked"];
    for (const condition of arms) {
        conditions[condition] = Array.from({ length: 4 }, (_, game) => run(condition, game));
        if (
            policies.candidateDoctrinePolicy === "see-none" &&
            condition !== "current" &&
            fingerprintV09(conditions[condition]) !== fingerprintV09(conditions.current)
        )
            throw new Error("Seven-point negative control changed");
    }
    const examples: IDoctrineDraftExample[] = [];
    if (training)
        for (const first of [0, 2]) {
            const current = conditions.current!,
                alternative = conditions.alternative!;
            const before = current[first].decisions[0],
                after = alternative[first].decisions[0];
            if (Boolean(before) !== Boolean(after)) throw new Error("Counterfactual decision missing");
            if (!before || !after) continue;
            for (const index of [first, first + 1]) {
                const a = current[index],
                    b = alternative[index];
                if (
                    fingerprintV09(a.decisions) !== fingerprintV09(current[first].decisions) ||
                    fingerprintV09(b.decisions) !== fingerprintV09(alternative[first].decisions) ||
                    fingerprintV09(a.decisions[0].features) !== fingerprintV09(b.decisions[0].features) ||
                    a.decisions[0].preferred !== b.decisions[0].preferred ||
                    a.decisions[0].alternative !== b.decisions[0].chosen ||
                    a.record.battleSeed !== b.record.battleSeed ||
                    a.record.pickSeed !== b.record.pickSeed ||
                    a.record.candidateSide !== b.record.candidateSide
                )
                    throw new Error("Unmatched counterfactual training pair");
            }
            examples.push({
                board,
                features: before.features,
                gain:
                    [first, first + 1].reduce(
                        (sum, index) => sum + score(alternative[index]) - score(current[index]),
                        0,
                    ) / 2,
            });
        }
    const body = {
        board,
        seed,
        stage,
        registrationSha256: registration.registrationSha256,
        modelSha256: model ? fingerprintV09(model) : null,
        ...policies,
        map: [1, 3, 4][board % 3],
        conditions,
        examples,
    };
    const row = { ...body, sha256: fingerprintV09(body) };
    save(join(root, stage, `board-${board}.json`), row);
    return row;
}

export function pairedDoctrineDraftStatistics(
    rows: readonly {
        board: number;
        map: number;
        candidateDoctrinePolicy: ScoutingDoctrine;
        opponentDoctrinePolicy: ScoutingDoctrine;
        delta: number;
    }[],
): { boards: number; gain: number; lower95: number; upper95: number } {
    if (!rows.length || new Set(rows.map((row) => row.board)).size !== rows.length)
        throw new Error("Missing or repeated paired board");
    const groups = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
        if (!Number.isFinite(row.delta) || Math.abs(row.delta) > 1) throw new Error("Invalid paired score");
        const key = `${row.map}:${row.candidateDoctrinePolicy}:${row.opponentDoctrinePolicy}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const rng = makeRng(2026110451);
    const draws = Array.from({ length: 10_000 }, () => {
        let sum = 0;
        for (const group of groups.values())
            for (let index = 0; index < group.length; index++) sum += group[Math.floor(rng() * group.length)].delta;
        return sum / rows.length;
    }).sort((a, b) => a - b);
    return {
        boards: rows.length,
        gain: rows.reduce((sum, row) => sum + row.delta, 0) / rows.length,
        lower95: draws[250],
        upper95: draws[9750],
    };
}

function readBoards(root: string, stage: Stage, registration: IDoctrineDraftRegistration): IBoard[] {
    const modelHash =
        stage === "train" || stage === "smoke" ? null : fingerprintV09(readJson(join(root, "model.json")));
    return registration.banks[stage].map((seed, board) => {
        const row = readJson<IBoard>(join(root, stage, `board-${board}.json`));
        const { sha256, ...body } = row;
        if (
            sha256 !== fingerprintV09(body) ||
            row.seed !== seed ||
            row.stage !== stage ||
            row.board !== board ||
            row.registrationSha256 !== registration.registrationSha256 ||
            row.modelSha256 !== modelHash
        )
            throw new Error("Stale or corrupted paired board");
        return row;
    });
}

function summarize(root: string, stage: Stage, registration: IDoctrineDraftRegistration): unknown {
    const rows = readBoards(root, stage, registration);
    if (stage === "train" || stage === "smoke")
        return {
            stage,
            complete: true,
            boards: rows.length,
            examples: rows.reduce((sum, row) => sum + row.examples.length, 0),
            registrationSha256: registration.registrationSha256,
            rejectedActions: 0,
            modelTrained: false,
            productionPromotion: false,
        };
    const comparisons = Object.fromEntries(
        (["current", "masked"] as const).map((control) => {
            const paired = rows.map((row) => ({
                ...row,
                delta:
                    row.conditions.learned!.reduce(
                        (sum, game, index) => sum + score(game) - score(row.conditions[control]![index]),
                        0,
                    ) / 4,
            }));
            return [
                control,
                {
                    pooled: pairedDoctrineDraftStatistics(paired),
                    doctrines: Object.fromEntries(
                        V09_A19_DOCTRINES.map((doctrine) => [
                            doctrine,
                            pairedDoctrineDraftStatistics(
                                paired.filter((row) => row.candidateDoctrinePolicy === doctrine),
                            ),
                        ]),
                    ),
                },
            ];
        }),
    );
    const passed =
        comparisons.current.pooled.lower95 > 0 &&
        comparisons.masked.pooled.lower95 > 0 &&
        Object.values(comparisons.current.doctrines).every((entry) => entry.gain >= 0) &&
        Object.values(comparisons.masked.doctrines).every((entry) => entry.gain >= 0);
    return {
        stage,
        complete: true,
        boards: rows.length,
        gamesPerCondition: rows.length * 4,
        registrationSha256: registration.registrationSha256,
        modelSha256: rows[0].modelSha256,
        comparisons,
        passed,
        rejectedActions: 0,
        productionPromotion: false,
    };
}

if (!isMainThread && workerData?.doctrineDraftTraining) {
    const { root, stage } = workerData as { root: string; stage: Stage };
    startPersistentWorker((board: number) => {
        runBoard(root, stage, board);
        return board;
    });
} else if (import.meta.main) {
    const args = parseArgs({
        options: {
            out: { type: "string" },
            stage: { type: "string" },
            workers: { type: "string", default: "6" },
            shard: { type: "string", default: "0" },
            shards: { type: "string", default: "1" },
            finalize: { type: "boolean", default: false },
            fit: { type: "boolean", default: false },
        },
    }).values;
    if (!args.out) throw new Error("--out is required");
    const root = resolve(args.out);
    const registration = readJson<IDoctrineDraftRegistration>(join(root, "registration.json"));
    validateDoctrineDraftRegistration(registration);
    if (readV09PilotSource(resolve(import.meta.dir, "../../..")).sha256 !== registration.sourceSha256)
        throw new Error("Frozen training source changed");
    if (args.fit) {
        const rows = readBoards(root, "train", registration);
        const model = fitDoctrineDraftModel(
            rows.flatMap((row) => row.examples),
            modelVersion(registration),
        );
        save(join(root, "model.json"), model);
        save(join(root, "fit-receipt.json"), {
            registrationSha256: registration.registrationSha256,
            modelSha256: fingerprintV09(model),
            trainingBoardsSha256: fingerprintV09(rows.map((row) => row.sha256)),
            optimizerSteps: model.optimizerSteps,
            examples: model.examples,
            initialLoss: model.initialLoss,
            finalLoss: model.finalLoss,
            developmentOpened: false,
            confirmationOpened: false,
            productionPromotion: false,
        });
        console.log(JSON.stringify({ fitted: true, examples: model.examples, optimizerSteps: model.optimizerSteps }));
    } else {
        const stage = args.stage as Stage;
        if (!(stage in DOCTRINE_DRAFT_STAGES)) throw new Error("Unknown registered stage");
        if (stage === "confirmation") {
            const dev = readJson<{ passed: boolean; modelSha256: string; registrationSha256: string }>(
                join(root, "development/summary.json"),
            );
            if (
                !dev.passed ||
                dev.registrationSha256 !== registration.registrationSha256 ||
                dev.modelSha256 !== fingerprintV09(readJson(join(root, "model.json")))
            )
                throw new Error("Development gate failed");
        }
        mkdirSync(join(root, stage), { recursive: true });
        if (args.finalize) {
            const summary = summarize(root, stage, registration);
            save(join(root, stage, "summary.json"), summary);
            console.log(JSON.stringify(summary));
        } else {
            const workers = Number(args.workers),
                shard = Number(args.shard),
                shards = Number(args.shards);
            if (
                !Number.isSafeInteger(workers) ||
                workers < 1 ||
                workers > 12 ||
                !Number.isSafeInteger(shards) ||
                shards < 1 ||
                !Number.isSafeInteger(shard) ||
                shard < 0 ||
                shard >= shards
            )
                throw new Error("Invalid actor allocation");
            const tasks = registration.banks[stage]
                .map((_, board) => board)
                .filter((board) => board % shards === shard && !existsSync(join(root, stage, `board-${board}.json`)));
            const pool = new PersistentWorkerPool<number, number>({
                concurrency: workers,
                workerUrl: new URL(import.meta.url),
                workerOptions: {
                    workerData: { doctrineDraftTraining: true, root, stage },
                    env: { ...sanitizedRankedDraftEnvironment(process.env, "a19"), LIVETWIN: "1" },
                },
            });
            try {
                await pool.runBatch(tasks, (progress) => console.log(JSON.stringify({ stage, shard, ...progress })));
            } finally {
                await pool.close();
            }
        }
    }
    await exitCompletedWorkerCli();
}
