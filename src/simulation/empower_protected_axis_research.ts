import { createHash } from "node:crypto";
import { finalizeA19Placement } from "../ai/placement/adapter";
import { creatureIdForName } from "../ai/setup/creature_score";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../ai/setup/doctrine_draft_policy";
import { empowerSetupFeatures, selectEmpowerSetup, type IEmpowerSetupModel } from "../ai/setup/empower_setup";
import { protectedAxisEmpowerPlan as empowerSetupPlan } from "../ai/setup/empower_protected_axis";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import { getPositionForCells } from "../grid/grid_math";
import { PlacementPositionType } from "../grid/placement_properties";
import { RectanglePlacement } from "../grid/rectangle_placement";
import { synergyVariantsForSeed } from "../synergies/synergy_properties";
import { GREEN_TEAM, RED_TEAM, runMatch, type IMatchConfig } from "./battle_engine";
import { footprintCellsForAnchor } from "./footprint";
import {
    permuteRankedDraftSeed,
    playRankedDraftGame,
    rankedDraftBehaviorTraceSha256,
    rankedDraftStrengthCandidate,
} from "./ranked_draft_eval";
import { rangedCounterBodies, validRangedCounterFormation } from "./ranged_counter_research";
import { v09DoctrineBoard } from "./v0_9/a19_doctrine_population";
import { createLockedDoctrineDraftResearchChoices } from "./v0_9/doctrine_draft_checkpoint";
import type { ScoutingDoctrine } from "./v0_9/doctrine_draft_model";

export const EMPOWER_RESEARCH_SETUP = "artifact-fit-v6:conditional-v1:sniper+t2a19";
export interface IEmpowerResearchBoard {
    board: number;
    seed: number;
}
export interface IEmpowerResearchJob extends IEmpowerResearchBoard {
    game: number;
    level: number;
    model?: IEmpowerSetupModel;
}
const candidateGreen = (game: number) => game < 2 === (game % 2 === 0);
const ids = (roster: IMatchConfig["roster"]) => [
    ...new Set(roster.flatMap((unit) => creatureIdForName(unit.creatureName) ?? [])),
];
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function withDraft<T>(job: IEmpowerResearchJob, capture: (config: IMatchConfig) => T): T {
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    const doctrines = v09DoctrineBoard(job.board, "balanced-doctrines-v1");
    const synergyVariants = synergyVariantsForSeed(`ranked-draft-${permuteRankedDraftSeed(job.seed + 1)}`);
    const choices = (doctrine: ScoutingDoctrine) =>
        createLockedDoctrineDraftResearchChoices({ genome, doctrine, synergyVariants });
    const stop = Symbol("capture-empower-match");
    let output: { value: T } | undefined;
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
                tacticalSplits: true,
                candidateSetupPolicySpec: EMPOWER_RESEARCH_SETUP,
                opponentSetupPolicySpec: EMPOWER_RESEARCH_SETUP,
                ...doctrines,
            },
            job.game,
            0,
            {
                liveSequentialBundles: true,
                researchCandidateDraftChoices: choices(doctrines.candidateDoctrinePolicy as ScoutingDoctrine),
                researchOpponentDraftChoices: choices(doctrines.opponentDoctrinePolicy as ScoutingDoctrine),
                matchRunner: (config) => {
                    output = { value: capture(config) };
                    throw stop;
                },
            },
        );
    } catch (error) {
        if (error !== stop) throw error;
    }
    if (!output) throw new Error("Missing Empower draft");
    return output.value;
}

export function inspectEmpowerBoard(board: IEmpowerResearchBoard) {
    return [0, 2].map((game) =>
        withDraft({ ...board, game, level: 0 }, (config) => {
            const green = candidateGreen(game),
                own = ids(green ? config.roster : config.redRoster!);
            const budget = getUpgradePoints((green ? config.greenDoctrine : config.redDoctrine)!);
            return { game, own, budget, features: empowerSetupFeatures(budget, own) };
        }),
    );
}

/** Intervention after the sealed draft: identical artifacts, formations, splits, opponent and combat seed. */
export function runProtectedAxisEmpowerResearchGame(job: IEmpowerResearchJob) {
    const began = performance.now();
    return withDraft(job, (config) => {
        const green = candidateGreen(job.game),
            team = green ? GREEN_TEAM : RED_TEAM;
        const own = ids(green ? config.roster : config.redRoster!),
            enemy = ids(green ? config.redRoster! : config.roster);
        const budget = getUpgradePoints((green ? config.greenDoctrine : config.redDoctrine)!);
        const features = empowerSetupFeatures(budget, own);
        const level = job.model ? selectEmpowerSetup(job.model, budget, own) : features ? job.level : 0;
        const baseline = empowerSetupPlan(budget, own, 0),
            plan = empowerSetupPlan(budget, own, level);
        const original = green ? config.greenAugments : config.redAugments;
        if (sha(original) !== sha(baseline)) throw new Error("Empower incumbent differs from current setup");
        const inputSha256 = sha(config);
        if (green) config.greenAugments = plan;
        else config.redAugments = plan;
        const formations: unknown[] = [];
        const result = runMatch({
            ...config,
            headlessEvents: true,
            beforeFightStart: (context) => {
                for (const side of [GREEN_TEAM, RED_TEAM]) {
                    const units = context.unitsHolder.getAllAllies(side),
                        fp = context.fightProperties;
                    const augments =
                        side === team ? baseline : side === GREEN_TEAM ? config.greenAugments! : config.redAugments!;
                    const legal = new RectanglePlacement(
                        context.grid.getSettings(),
                        side === GREEN_TEAM ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
                        fp.getAugmentPlacement(side)[0],
                        true,
                    ).possibleCellHashes();
                    const positions = finalizeA19Placement(
                        units,
                        {
                            team: side,
                            gridType: config.gridType!,
                            sideOrientedPlacement: true,
                            legalCellHashes: legal,
                            publicOpponentCreatureIds: ids(side === GREEN_TEAM ? config.redRoster! : config.roster),
                            artifacts: [fp.getArtifactTier1(side), fp.getArtifactTier2(side)],
                            doctrine: fp.getDoctrine(side),
                            augments,
                        },
                        new Map(units.map((unit) => [unit.getId(), { ...unit.getBaseCell() }])),
                    );
                    if (!validRangedCounterFormation(rangedCounterBodies(units, 0), positions, legal))
                        throw new Error("Illegal Empower formation");
                    for (const unit of units)
                        context.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
                    for (const unit of units) {
                        const cells = footprintCellsForAnchor(unit, positions.get(unit.getId())!);
                        const point = getPositionForCells(context.grid.getSettings(), cells);
                        if (!point) throw new Error("Invalid Empower footprint");
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
                            throw new Error("Invalid Empower occupancy");
                    }
                    formations.push({
                        side,
                        units: units.map((unit) => ({
                            name: unit.getName(),
                            amount: unit.getAmountAlive(),
                            width: unit.getFootprintWidth(),
                            height: unit.getFootprintHeight(),
                            ...unit.getBaseCell(),
                        })),
                    });
                }
            },
        });
        if (result.rejectedGreen || result.rejectedRed || result.endReason !== "elimination")
            throw new Error(`Invalid Empower battle: ${result.endReason}; ${JSON.stringify(result.rejectedDetails)}`);
        return {
            board: job.board,
            seed: job.seed,
            game: job.game,
            requestedLevel: job.level,
            level,
            budget,
            map: config.gridType,
            own,
            enemy,
            features,
            plan,
            baseline,
            inputSha256,
            formationSha256: sha(formations),
            traceSha256: rankedDraftBehaviorTraceSha256(result),
            score: result.winner === "draw" ? 0.5 : result.winner === (green ? "green" : "red") ? 1 : 0,
            laps: result.laps,
            rejected: 0,
            elapsedMs: performance.now() - began,
        };
    });
}

export function inspectProtectedAxisEmpowerInput(job: IEmpowerResearchJob) {
    return withDraft(job, (config) => {
        const green = candidateGreen(job.game);
        return {
            inputSha256: sha(config),
            own: ids(green ? config.roster : config.redRoster!),
            enemy: ids(green ? config.redRoster! : config.roster),
            budget: getUpgradePoints((green ? config.greenDoctrine : config.redDoctrine)!),
            map: config.gridType,
        };
    });
}
