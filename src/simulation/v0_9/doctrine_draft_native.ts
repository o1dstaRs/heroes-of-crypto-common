/** Reproduce the locked draft checkpoint on native v0.9 combat and the server's sequential bundle flow. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../../ai/setup/doctrine_draft_policy";
import { synergyVariantsForSeed } from "../../synergies/synergy_properties";
import { GREEN_TEAM, RED_TEAM, runMatch } from "../battle_engine";
import {
    permuteRankedDraftSeed,
    playRankedDraftGame,
    rankedDraftStrengthCandidate,
    sanitizedRankedDraftEnvironment,
} from "../ranked_draft_eval";
import { assertV09DoctrineSetup, v09DoctrineBoard } from "./a19_doctrine_population";
import { readV09PilotSource } from "./a19_pilot_protocol";
import {
    createLockedDoctrineDraftResearchChoices,
    LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
} from "./doctrine_draft_checkpoint";
import type { IDoctrineDraftResearchDecision } from "./doctrine_draft_policy";
import { fingerprintV09 } from "./protocol";

export const NATIVE_V09_DRAFT_SETUP = "artifact-fit-v6:v07-nonfight-4eda84635fe7";
export const NATIVE_V09_DRAFT_ARMS = ["current", "locked", "masked"] as const;

export function runNativeDoctrineDraftBoard(board: number, seed: number) {
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    const policies = v09DoctrineBoard(board, "balanced-doctrines-v1");
    const map = [1, 3, 4][board % 3];
    const variants = synergyVariantsForSeed(`ranked-draft-${permuteRankedDraftSeed(seed + 1)}`);
    const run = (condition: (typeof NATIVE_V09_DRAFT_ARMS)[number], game: number) => {
        const decisions: IDoctrineDraftResearchDecision[] = [];
        let nativeDecisions = 0;
        const research =
            condition === "current"
                ? undefined
                : createLockedDoctrineDraftResearchChoices({
                      doctrine: policies.candidateDoctrinePolicy as "see-all" | "three-reveals" | "see-none",
                      genome,
                      synergyVariants: variants,
                      maskAdvanceInformation: condition === "masked",
                      onDecision: (decision) => decisions.push(decision),
                  });
        const record = playRankedDraftGame(
            genome,
            genome,
            {
                gamesPerOpponent: 8,
                baseSeed: seed,
                mapTypes: [map],
                fightProfile: "a19",
                maxLaps: 256,
                liveDraftRules: true,
                sideBoard: true,
                deterministicSearch: true,
                liveSynergyVariants: true,
                tacticalSplits: true,
                candidateSetupPolicySpec: NATIVE_V09_DRAFT_SETUP,
                opponentSetupPolicySpec: NATIVE_V09_DRAFT_SETUP,
                ...policies,
            },
            game,
            0,
            {
                liveSequentialBundles: true,
                researchCandidateDraftChoices: research,
                matchRunner: (config) => {
                    const candidateIsGreen = game < 2 === (game % 2 === 0);
                    assertV09DoctrineSetup(
                        { ...config, searchEnvOverrideTeams: [candidateIsGreen ? GREEN_TEAM : RED_TEAM] },
                        board,
                    );
                    if (config.searchEnvOverrideTeams || config.greenStrategyOverride || config.redStrategyOverride)
                        throw new Error("Native qualification cannot inject a search or strategy override");
                    return runMatch({
                        ...config,
                        greenVersion: "v0.9",
                        redVersion: "v0.9",
                        headlessEvents: true,
                        v09ServerPreflightObserver: (observation) => {
                            if (observation.failure !== null)
                                throw new Error(`Native preflight failed: ${observation.failure}`);
                            nativeDecisions++;
                        },
                    });
                },
            },
        );
        if (
            !nativeDecisions ||
            record.rejectedCandidate ||
            record.rejectedOpponent ||
            record.endReason !== "elimination"
        )
            throw new Error("Native draft qualification requires complete, legal native battles");
        return { record, decisions, nativeDecisions };
    };
    const conditions = Object.fromEntries(
        NATIVE_V09_DRAFT_ARMS.map((condition) => [
            condition,
            Array.from({ length: 4 }, (_, game) => run(condition, game)),
        ]),
    ) as Record<(typeof NATIVE_V09_DRAFT_ARMS)[number], ReturnType<typeof run>[]>;
    if (policies.candidateDoctrinePolicy === "see-none") {
        for (const arm of ["locked", "masked"] as const)
            if (fingerprintV09(conditions[arm]) !== fingerprintV09(conditions.current))
                throw new Error("Seven-point native negative control changed");
    }
    return { board, seed, map, ...policies, conditions };
}

if (import.meta.main) {
    const [registrationFile, outputDirectory, bank, shardText, shardsText] = process.argv.slice(2);
    if (!registrationFile || !outputDirectory || !["smoke", "qualification"].includes(bank))
        throw new Error(
            "Usage: doctrine_draft_native.ts <registration.json> <output-directory> <smoke|qualification> <shard> <shards>",
        );
    const registration = JSON.parse(readFileSync(registrationFile, "utf8"));
    const { registrationSha256, ...body } = registration;
    if (fingerprintV09(body) !== registrationSha256 || registration.modelSha256 !== LOCKED_DOCTRINE_DRAFT_MODEL_SHA256)
        throw new Error("Native draft registration or model identity changed");
    const source = readV09PilotSource(resolve(import.meta.dir, "../../.."));
    if (source.sha256 !== registration.sourceSha256) throw new Error("Native qualification source changed");
    const shard = Number(shardText),
        shards = Number(shardsText);
    if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(shard) || shard < 0 || shard >= shards)
        throw new Error("Invalid native qualification shard");
    const cleanEnvironment = sanitizedRankedDraftEnvironment(process.env, "v0.7");
    for (const key of Object.keys(process.env)) if (!(key in cleanEnvironment)) delete process.env[key];
    Object.assign(process.env, cleanEnvironment);
    const seeds: number[] = registration.banks[bank];
    if (seeds.length !== (bank === "smoke" ? 27 : 1512)) throw new Error("Incomplete native qualification bank");
    for (let board = shard; board < seeds.length; board += shards) {
        const path = join(outputDirectory, bank, `board-${board}.json`);
        if (existsSync(path)) {
            const { sha256, ...row } = JSON.parse(readFileSync(path, "utf8"));
            if (
                row.board !== board ||
                row.seed !== seeds[board] ||
                row.registrationSha256 !== registrationSha256 ||
                fingerprintV09(row) !== sha256
            )
                throw new Error("Stale native qualification board");
            continue;
        }
        const row = {
            ...runNativeDoctrineDraftBoard(board, seeds[board]),
            registrationSha256,
            modelSha256: registration.modelSha256,
        };
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ ...row, sha256: fingerprintV09(row) }) + "\n", { flag: "wx" });
        console.log(JSON.stringify({ bank, board, completed: true }));
    }
}
