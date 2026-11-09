/** Fixed-arm, paired offline tests for shooter counter-play; never changes a live default. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

import { finalizeA19Placement } from "../ai/placement/adapter";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../ai/setup/doctrine_draft_policy";
import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { getPositionForCells } from "../grid/grid_math";
import { PlacementPositionType } from "../grid/placement_properties";
import { RectanglePlacement } from "../grid/rectangle_placement";
import { synergyVariantsForSeed } from "../synergies/synergy_properties";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { GREEN_TEAM, RED_TEAM, runMatch, type IMatchConfig, type ISetupAugment } from "./battle_engine";
import { footprintCellsForAnchor } from "./footprint";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import {
    permuteRankedDraftSeed,
    playRankedDraftGame,
    rankedDraftBehaviorTraceSha256,
    rankedDraftStrengthCandidate,
    rankedDraftStackCapacity,
    sanitizedRankedDraftEnvironment,
    type IRankedDraftResearchChoices,
    type IRankedDraftResearchContext,
} from "./ranked_draft_eval";
import {
    createRangedCounterDraft,
    fundedRangedPlacement,
    materializeRangedCounterSplits,
    rangedCounterBodies,
    rangedCounterThreats,
    RangedCounterCombatResearch,
    spreadRangedCounterFormation,
    validRangedCounterFormation,
} from "./ranged_counter_research";
import { v09DoctrineBoard } from "./v0_9/a19_doctrine_population";
import { createLockedDoctrineDraftResearchChoices } from "./v0_9/doctrine_draft_checkpoint";

export const RANGED_COUNTER_ARMS = [
    "control",
    "draft",
    "escape",
    "free-spread",
    "placement1-sniper",
    "placement2-sniper",
    "placement2-armor",
] as const;
export type RangedCounterArm = (typeof RANGED_COUNTER_ARMS)[number];
export type RangedCounterOpponent = "current" | "rush";
export interface IRangedCounterJob {
    board: number;
    seed: number;
    opponent: RangedCounterOpponent;
    arm: RangedCounterArm;
    game: number;
    /** A/A transport check only; never present in the registered candidate jobs. */
    nullEscape?: boolean;
}

/** A legal-offer stress opponent, chosen without looking at future or concealed picks. */
export function createRangedPressureOpponent(): IRankedDraftResearchChoices {
    const value = (id: number): number => {
        const info = creatureInfo(id);
        if (!info) return -1e9;
        return (
            (info.abilities.includes("Range Null Field") ? 20 : 0) +
            (info.canFly && !info.ranged ? 9 : 0) +
            (info.rangedSpellDamage ? 10 : 0) +
            (info.abilities.includes("Fire Breath") ? 8 : 0) +
            (info.name === "Leprechaun" ? 8 : 0) +
            (info.ranged ? -12 : 0) +
            (info.movementSteps ?? 0) +
            info.initiative * 0.1
        );
    };
    return {
        bundle: (bundles, _context, preferred) => {
            let best = preferred,
                score = -Infinity;
            bundles.forEach((bundle, i) => {
                const candidate = value(bundle[0]) + value(bundle[1]) + (bundle[2] === 5 ? 8 : 0);
                if (candidate > score) {
                    best = i;
                    score = candidate;
                }
            });
            return best;
        },
        creature: (available, _context, preferred) => {
            let best = preferred,
                score = -Infinity;
            for (const id of available)
                if (value(id) > score) {
                    best = id;
                    score = value(id);
                }
            return best;
        },
    };
}

function idsFromRoster(roster: IMatchConfig["roster"]): number[] {
    return [
        ...new Set(
            roster.flatMap((unit) => {
                const id = creatureIdForName(unit.creatureName);
                return id === undefined ? [] : [id];
            }),
        ),
    ];
}

function candidateGreen(game: number): boolean {
    return game < 2 === (game % 2 === 0);
}

function eligibleFormation(ownIds: readonly number[], enemyIds: readonly number[]): boolean {
    const threat = rangedCounterThreats(enemyIds);
    return (
        ownIds.filter((id) => creatureInfo(id)?.ranged).length >= 3 &&
        (threat.nullField || threat.flyers >= 2 || threat.area)
    );
}

function relocate(
    context: Parameters<NonNullable<IMatchConfig["beforeFightStart"]>>[0],
    units: readonly Unit[],
    positions: ReadonlyMap<string, XY>,
    legal: ReadonlySet<number>,
): void {
    if (!validRangedCounterFormation(rangedCounterBodies(units, 0), positions, legal))
        throw new Error("Illegal final research formation");
    for (const unit of units) context.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
    for (const unit of units) {
        const cells = footprintCellsForAnchor(unit, positions.get(unit.getId())!);
        const point = getPositionForCells(context.grid.getSettings(), cells);
        if (!point) throw new Error("Invalid research position");
        unit.setPosition(point.x, point.y);
        if (
            !context.grid.occupyCells(
                cells,
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            )
        )
            throw new Error("Research final-placement occupancy failed");
    }
}

function prepareConfig(job: IRangedCounterJob, config: IMatchConfig): IMatchConfig {
    const ownGreen = candidateGreen(job.game);
    const ownIds = idsFromRoster(ownGreen ? config.roster : config.redRoster!);
    const enemyIds = idsFromRoster(ownGreen ? config.redRoster! : config.roster);
    if (job.opponent === "rush") {
        const budget = getUpgradePoints((ownGreen ? config.redDoctrine : config.greenDoctrine)!);
        const armor = budget - 4;
        const plan: ISetupAugment[] = [
            { kind: "Movement", value: 2 },
            { kind: "Might", value: 2 },
            { kind: "Armor", value: armor },
        ];
        if (ownGreen) config.redAugments = plan;
        else config.greenAugments = plan;
    }
    if (job.arm.startsWith("placement") && eligibleFormation(ownIds, enemyIds)) {
        const budget = getUpgradePoints((ownGreen ? config.greenDoctrine : config.redDoctrine)!);
        const plan = fundedRangedPlacement(
            budget,
            job.arm === "placement1-sniper" ? 1 : 2,
            job.arm === "placement2-armor" ? "armor" : "sniper",
        );
        if (ownGreen) config.greenAugments = plan;
        else config.redAugments = plan;
    }
    config.placementAugmentTiming = "setup-before-placement";
    const greenSplit = materializeRangedCounterSplits(
        config.roster,
        rankedDraftStackCapacity(idsFromRoster(config.roster), config.greenAugments!, config.synergyVariants!),
    );
    const redSplit = materializeRangedCounterSplits(
        config.redRoster!,
        rankedDraftStackCapacity(idsFromRoster(config.redRoster!), config.redAugments!, config.synergyVariants!),
    );
    config.roster = greenSplit.roster;
    config.greenTacticalSplitStacks = greenSplit.splitRoles;
    config.redRoster = redSplit.roster;
    config.redTacticalSplitStacks = redSplit.splitRoles;
    return config;
}

function draftGame<T>(job: IRangedCounterJob, matchRunner: (config: IMatchConfig, changes: unknown[]) => T): T {
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    const policies = v09DoctrineBoard(job.board, "balanced-doctrines-v1");
    const variants = synergyVariantsForSeed(`ranked-draft-${permuteRankedDraftSeed(job.seed + 1)}`);
    const choices = (candidate: boolean) =>
        createLockedDoctrineDraftResearchChoices({
            genome,
            synergyVariants: variants,
            doctrine: (candidate ? policies.candidateDoctrinePolicy : policies.opponentDoctrinePolicy) as
                "see-all" | "three-reveals" | "see-none",
        });
    const changes: unknown[] = [];
    const stop = Symbol("capture-result");
    let returned: { value: T } | undefined;
    try {
        playRankedDraftGame(
            genome,
            genome,
            {
                gamesPerOpponent: 8,
                baseSeed: job.seed,
                mapTypes: [[1, 3, 4][job.board % 3]],
                fightProfile: "a19",
                maxLaps: 256,
                liveDraftRules: true,
                sideBoard: true,
                deterministicSearch: true,
                liveSynergyVariants: true,
                tacticalSplits: false,
                recordArmies: true,
                candidateSetupPolicySpec: "artifact-fit-v6:v07-nonfight-4eda84635fe7",
                opponentSetupPolicySpec: "artifact-fit-v6:v07-nonfight-4eda84635fe7",
                ...policies,
            },
            job.game,
            0,
            {
                liveSequentialBundles: true,
                researchCandidateDraftChoices:
                    job.arm === "draft"
                        ? createRangedCounterDraft(
                              genome,
                              choices(true),
                              variants,
                              (from: number, to: number, context: IRankedDraftResearchContext) =>
                                  changes.push({
                                      from,
                                      to,
                                      own: [...context.ownCreatureIds],
                                      known: [...context.knownOpponentCreatureIds],
                                  }),
                          )
                        : choices(true),
                researchOpponentDraftChoices: job.opponent === "rush" ? createRangedPressureOpponent() : choices(false),
                matchRunner: (config) => {
                    returned = { value: matchRunner(prepareConfig(job, config), changes) };
                    throw stop;
                },
            },
        );
    } catch (error) {
        if (error !== stop) throw error;
    }
    if (!returned) throw new Error("Missing research match result");
    return returned.value;
}

/** Draft-only selection is allowed before registering a target bank; it never runs combat. */
export function inspectRangedCounterBoard(job: Omit<IRangedCounterJob, "game" | "arm">) {
    return [0, 2].map((game) =>
        draftGame({ ...job, game, arm: "control" }, (config) => {
            const ownGreen = candidateGreen(game);
            const ownIds = idsFromRoster(ownGreen ? config.roster : config.redRoster!);
            const enemyIds = idsFromRoster(ownGreen ? config.redRoster! : config.roster);
            return { eligible: eligibleFormation(ownIds, enemyIds), ownIds, enemyIds };
        }),
    );
}

export function runRangedCounterGame(job: IRangedCounterJob) {
    const startedAt = performance.now();
    let setupMs = 0,
        decisions = 0,
        rangedAttacks = 0,
        decisionMs = 0;
    const ownTeam = candidateGreen(job.game) ? GREEN_TEAM : RED_TEAM;
    const combat = new RangedCounterCombatResearch(createV08A19Strategy(), job.nullEscape !== true);
    const formations: unknown[] = [];
    return draftGame(job, (prepared, draftChanges) => {
        const draftMs = performance.now() - startedAt;
        const result = runMatch({
            ...prepared,
            headlessEvents: true,
            researchCaptureDecisionStart: true,
            ...(job.arm === "escape"
                ? candidateGreen(job.game)
                    ? { greenStrategyOverride: combat }
                    : { redStrategyOverride: combat }
                : {}),
            beforeFightStart: (context) => {
                const began = performance.now();
                for (const team of [GREEN_TEAM, RED_TEAM]) {
                    const own = context.unitsHolder.getAllAllies(team);
                    const enemy = idsFromRoster(team === GREEN_TEAM ? prepared.redRoster! : prepared.roster);
                    const fp = context.fightProperties;
                    const legal = new RectanglePlacement(
                        context.grid.getSettings(),
                        team === GREEN_TEAM ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
                        fp.getAugmentPlacement(team)[0],
                        true,
                    ).possibleCellHashes();
                    const initial = new Map(own.map((unit) => [unit.getId(), { ...unit.getBaseCell() }]));
                    const levels = team === GREEN_TEAM ? prepared.greenAugments! : prepared.redAugments!;
                    const envelope = {
                        team,
                        gridType: prepared.gridType!,
                        sideOrientedPlacement: true,
                        legalCellHashes: legal,
                        publicOpponentCreatureIds: enemy,
                        artifacts: [fp.getArtifactTier1(team), fp.getArtifactTier2(team)] as [number, number],
                        doctrine: fp.getDoctrine(team),
                        augments: levels,
                    };
                    const current = finalizeA19Placement(own, envelope, initial);
                    const spread =
                        team === ownTeam &&
                        (job.arm === "free-spread" || job.arm.startsWith("placement")) &&
                        eligibleFormation(
                            idsFromRoster(team === GREEN_TEAM ? prepared.roster : prepared.redRoster!),
                            enemy,
                        );
                    const selected = spread
                        ? spreadRangedCounterFormation(
                              rangedCounterBodies(own, fp.getAdditionalAuraRangePerTeam(team)),
                              current,
                              { team: team as TeamType, sideAxis: true, legal, enemyIds: enemy },
                          )
                        : current;
                    relocate(context, own, selected, legal);
                    formations.push({
                        team,
                        spread,
                        augments: levels,
                        units: own.map((unit) => ({
                            name: unit.getName(),
                            amount: unit.getAmountAlive(),
                            width: unit.getFootprintWidth(),
                            height: unit.getFootprintHeight(),
                            ...unit.getBaseCell(),
                        })),
                    });
                }
                setupMs += performance.now() - began;
            },
            decisionObserver: (observation) => {
                if (observation.unit.getTeam() !== ownTeam) return;
                decisions++;
                if (observation.context.decisionStartedAtMs === undefined) throw new Error("Missing decision timing");
                decisionMs += performance.now() - observation.context.decisionStartedAtMs;
            },
            turnExecutionObserver: (observation) => {
                if (observation.side !== (ownTeam === GREEN_TEAM ? "green" : "red")) return;
                for (const execution of observation.strategyActions)
                    if (execution.completed && ["range_attack", "area_throw_attack"].includes(execution.action.type))
                        rangedAttacks++;
            },
        });
        if (result.rejectedGreen || result.rejectedRed || result.endReason !== "elimination")
            throw new Error(
                `Incomplete or illegal counter-play match: ${JSON.stringify({ job, reason: result.endReason, rejected: result.rejectedDetails })}`,
            );
        const winner = result.winner;
        const side = ownTeam === GREEN_TEAM ? "green" : "red";
        return {
            ...job,
            score: winner === "draw" ? 0.5 : winner === side ? 1 : 0,
            winner,
            laps: result.laps,
            rejected: (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0),
            rangedAttacks,
            draftChanges,
            escapeProposals: combat.changed,
            rolloutEscapeProposals: combat.rolloutChanged,
            ownIds: idsFromRoster(candidateGreen(job.game) ? prepared.roster : prepared.redRoster!),
            enemyIds: idsFromRoster(candidateGreen(job.game) ? prepared.redRoster! : prepared.roster),
            traceSha256: rankedDraftBehaviorTraceSha256(result),
            formations,
            timing: { draftMs, setupMs, decisions, decisionMs, elapsedMs: performance.now() - startedAt },
        };
    });
}

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

if (!isMainThread) startPersistentWorker(runRangedCounterGame);
else if (import.meta.main) {
    const [registrationPath, outputDirectory, bank, concurrencyText = "8"] = process.argv.slice(2);
    if (!registrationPath || !outputDirectory || !["smoke", "development", "confirmation"].includes(bank))
        throw new Error(
            "Usage: measure_ranged_counter_research.ts registration.json output-directory smoke|development|confirmation [concurrency]",
        );
    const registration = JSON.parse(readFileSync(registrationPath, "utf8"));
    const { registrationSha256, ...body } = registration;
    if (sha(body) !== registrationSha256) throw new Error("Changed counter-play registration");
    for (const entry of registration.sourceManifest as { path: string; sha256: string }[]) {
        const path = resolve(import.meta.dir, "../..", entry.path);
        if (createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256)
            throw new Error(`Changed frozen source: ${entry.path}`);
    }
    const boards: Omit<IRangedCounterJob, "game" | "arm">[] = registration.banks[bank];
    if (!boards?.length) throw new Error("Empty counter-play bank");
    const concurrency = Number(concurrencyText);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error("Invalid concurrency");
    const arms: RangedCounterArm[] =
        bank === "confirmation"
            ? [
                  "control",
                  registration.finalist,
                  ...(registration.finalist.startsWith("placement") ? ["free-spread"] : []),
              ]
            : [...RANGED_COUNTER_ARMS];
    if (arms.some((arm) => !RANGED_COUNTER_ARMS.includes(arm))) throw new Error("Unknown counter-play finalist");
    const jobs = boards
        .flatMap((board) => Array.from({ length: 4 }, (_, game) => arms.map((arm) => ({ ...board, game, arm }))).flat())
        .filter((job) => {
            const path = join(outputDirectory, bank, `${job.board}-${job.game}-${job.arm}.json`);
            if (!existsSync(path)) return true;
            const previous = JSON.parse(readFileSync(path, "utf8")),
                { sha256, ...row } = previous;
            if (row.registrationSha256 !== registrationSha256 || sha(row) !== sha256)
                throw new Error("Stale counter-play output");
            return false;
        });
    const environment = sanitizedRankedDraftEnvironment(process.env, "a19");
    const pool = new PersistentWorkerPool<IRangedCounterJob, ReturnType<typeof runRangedCounterGame>>({
        concurrency,
        workerUrl: new URL(import.meta.url),
        workerOptions: { env: environment },
    });
    const began = Date.now();
    const total = jobs.length;
    let completed = 0;
    let failed = false;
    try {
        const save = (result: ReturnType<typeof runRangedCounterGame>): void => {
            const path = join(resolve(outputDirectory), bank, `${result.board}-${result.game}-${result.arm}.json`);
            mkdirSync(dirname(path), { recursive: true });
            const row = { ...result, registrationSha256 };
            writeFileSync(path, JSON.stringify({ ...row, sha256: sha(row) }) + "\n", { flag: "wx" });
        };
        const lanes = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
            try {
                while (jobs.length && !failed) {
                    const job = jobs.shift()!;
                    save(await pool.run(job));
                    completed++;
                    if (completed % 14 === 0 || completed === total)
                        console.log(JSON.stringify({ bank, completed, total, seconds: (Date.now() - began) / 1000 }));
                }
            } catch (error) {
                failed = true;
                throw error;
            }
        });
        await Promise.all(lanes);
    } finally {
        await pool.close();
    }
}
