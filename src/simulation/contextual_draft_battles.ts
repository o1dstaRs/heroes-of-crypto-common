/** Paired draft interventions through the canonical ranked reducer and authoritative engine. */
import { finalizeA19Placement } from "../ai/placement/adapter";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../ai/setup/doctrine_draft_policy";
import { pickDraftGenomeCreature, pickRankedLiveDraftBundle } from "../ai/setup/draft_ship";
import type { RankedDraftSynergyVariants } from "../ai/setup/draft_synergy_variants";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { getPositionForCells } from "../grid/grid_math";
import { PlacementPositionType } from "../grid/placement_properties";
import { RectanglePlacement } from "../grid/rectangle_placement";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { GREEN_TEAM, RED_TEAM, runMatch, type IMatchConfig, type ISetupAugment } from "./battle_engine";
import {
    contextualDraftFeatures,
    predictContextualDraft,
    validateContextualDraftModel,
    type IContextualDraftContext,
    type IContextualDraftModel,
} from "./contextual_draft_research";
import { footprintCellsForAnchor } from "./footprint";
import { lockedLearnedRangedSetupModel } from "./learned_ranged_setup_checkpoint";
import { selectLearnedRangedSetup } from "./learned_ranged_setup_research";
import { createRangedPressureOpponent } from "./measure_ranged_counter_research";
import {
    fundedRangedPlacement,
    materializeRangedCounterSplits,
    rangedCounterBodies,
    spreadRangedCounterFormation,
    validRangedCounterFormation,
} from "./ranged_counter_research";
import {
    permuteRankedDraftSeed,
    playRankedDraftGame,
    rankedDraftBehaviorTraceSha256,
    rankedDraftStackCapacity,
    rankedDraftStrengthCandidate,
    type IRankedDraftResearchChoices,
    type IRankedDraftResearchContext,
} from "./ranked_draft_eval";
import { v09DoctrineBoard } from "./v0_9/a19_doctrine_population";
import { createLockedDoctrineDraftResearchChoices } from "./v0_9/doctrine_draft_checkpoint";
import type { ScoutingDoctrine } from "./v0_9/doctrine_draft_model";

/** Matches the server's V08_RANKED_SETUP_POLICY_SPEC, rather than the previous nonfight research setup. */
export const CONTEXTUAL_DRAFT_SETUP_SPEC = "artifact-fit-v6:conditional-v1:sniper+t2a19";
export type ContextualDraftCondition = "current" | "locked" | "fork" | "learned" | "ablated";
export interface IContextualDraftBoard {
    readonly board: number;
    readonly seed: number;
    readonly opponent: "current" | "rush";
    readonly targetLevel: number;
    readonly synergyVariants: RankedDraftSynergyVariants;
    readonly trainingGames: readonly number[];
}
export interface IContextualDraftJob extends IContextualDraftBoard {
    readonly condition: ContextualDraftCondition;
    readonly game: number;
    readonly model?: IContextualDraftModel;
    readonly recordTrainingDecision?: boolean;
}
export interface IContextualDraftDecision {
    readonly level: number;
    readonly preferred: number;
    readonly alternative: number;
    readonly chosen: number;
    readonly features: readonly number[];
    readonly context: IContextualDraftContext;
}

const candidateGreen = (game: number) => game < 2 === (game % 2 === 0);
const rosterIds = (roster: IMatchConfig["roster"]) => [
    ...new Set(roster.flatMap((unit) => creatureIdForName(unit.creatureName) ?? [])),
];
const budgetFor = (doctrine: ScoutingDoctrine) => (doctrine === "see-all" ? 5 : doctrine === "three-reveals" ? 6 : 7);

/** One extra, outcome-trained override; the locked V3 seat keeps its own independent consumption state. */
export function createContextualDraftChoices(options: {
    readonly doctrine: ScoutingDoctrine;
    readonly synergyVariants: RankedDraftSynergyVariants;
    readonly mode: "reference" | "fork" | "model";
    readonly targetLevel: number;
    readonly model?: IContextualDraftModel;
    readonly recordTrainingDecision?: boolean;
    readonly onDecision?: (decision: IContextualDraftDecision) => void;
}): IRankedDraftResearchChoices {
    if (options.mode === "model") {
        if (!options.model) throw new Error("A contextual draft model is required");
        validateContextualDraftModel(options.model);
    }
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    const base = createLockedDoctrineDraftResearchChoices({
        genome,
        doctrine: options.doctrine,
        synergyVariants: options.synergyVariants,
    });
    let consumed = false;
    const choose = (
        context: IRankedDraftResearchContext,
        preferred: number,
        alternative: number | undefined,
        before: { creatureIds: readonly number[]; tier1ArtifactId?: number },
        after: { creatureIds: readonly number[]; tier1ArtifactId?: number } | undefined,
        level: number,
    ) => {
        if (
            consumed ||
            alternative === undefined ||
            !after ||
            ((options.mode === "fork" || options.recordTrainingDecision) && level !== options.targetLevel)
        )
            return preferred;
        const visible: IContextualDraftContext = {
            ...context,
            synergyVariants: options.synergyVariants,
            budget: budgetFor(options.doctrine),
        };
        const features = contextualDraftFeatures(visible, before, after, level);
        if (!features) return preferred;
        const switchChoice =
            options.mode === "fork" ||
            (options.mode === "model" &&
                options.model !== undefined &&
                predictContextualDraft(options.model, features) > options.model.margin);
        const chosen = switchChoice ? alternative : preferred;
        options.onDecision?.({ context: visible, level, preferred, alternative, chosen, features });
        consumed = switchChoice;
        return chosen;
    };
    return {
        bundle: (bundles, context, preferred) => {
            const current = base.bundle?.(bundles, context, preferred) ?? preferred;
            if (
                consumed ||
                (options.mode === "reference" && !options.recordTrainingDecision) ||
                ((options.mode === "fork" || options.recordTrainingDecision) && options.targetLevel !== 0)
            )
                return current;
            const remaining = bundles.map((bundle, id) => ({ bundle, id })).filter((entry) => entry.id !== current);
            const other = remaining.length
                ? remaining[
                      pickRankedLiveDraftBundle(
                          genome,
                          remaining.map((entry) => entry.bundle),
                          options.synergyVariants,
                          context.artifactFitVersion,
                          context.scouting,
                      )
                  ]
                : undefined;
            return choose(
                context,
                current,
                other?.id,
                { creatureIds: bundles[current].slice(0, 2), tier1ArtifactId: bundles[current][2] },
                other ? { creatureIds: other.bundle.slice(0, 2), tier1ArtifactId: other.bundle[2] } : undefined,
                0,
            );
        },
        creature: (available, context, preferred) => {
            const current = base.creature?.(available, context, preferred) ?? preferred;
            const level = creatureInfo(current)?.level ?? 4;
            if (
                consumed ||
                (options.mode === "reference" && !options.recordTrainingDecision) ||
                ((options.mode === "fork" || options.recordTrainingDecision) && options.targetLevel !== level)
            )
                return current;
            // An existing public scorer proposes the alternative without forcing the four-shooter floor.
            // This is a proposal only; the learned gain/margin decides whether to accept it.
            const other = pickDraftGenomeCreature(
                genome,
                available.filter((id) => id !== current),
                context.ownCreatureIds,
                context.knownOpponentCreatureIds,
                context.tier1ArtifactId,
                context.scouting.map,
            );
            return choose(
                context,
                current,
                other,
                { creatureIds: [current] },
                other === undefined ? undefined : { creatureIds: [other] },
                level,
            );
        },
    };
}

function prepareSetup(job: IContextualDraftJob, config: IMatchConfig) {
    const green = candidateGreen(job.game);
    const own = rosterIds(green ? config.roster : config.redRoster!);
    const enemy = rosterIds(green ? config.redRoster! : config.roster);
    if (job.opponent === "rush") {
        const budget = getUpgradePoints((green ? config.redDoctrine : config.greenDoctrine)!);
        const plan: ISetupAugment[] = [
            { kind: "Movement", value: 2 },
            { kind: "Might", value: 2 },
            { kind: "Armor", value: budget - 4 },
        ];
        if (green) config.redAugments = plan;
        else config.greenAugments = plan;
    }
    const arm =
        job.condition === "current"
            ? "control"
            : selectLearnedRangedSetup(lockedLearnedRangedSetupModel(), {
                  ownCreatureIds: own,
                  publicOpponentCreatureIds: enemy,
                  budget: getUpgradePoints((green ? config.greenDoctrine : config.redDoctrine)!),
                  map: config.gridType!,
                  synergyVariants: job.synergyVariants,
              });
    if (arm === "placement1-sniper") {
        const plan = fundedRangedPlacement(
            getUpgradePoints((green ? config.greenDoctrine : config.redDoctrine)!),
            1,
            "sniper",
        );
        if (green) config.greenAugments = plan;
        else config.redAugments = plan;
    }
    config.placementAugmentTiming = "setup-before-placement";
    const a = materializeRangedCounterSplits(
        config.roster,
        rankedDraftStackCapacity(rosterIds(config.roster), config.greenAugments!, job.synergyVariants),
    );
    const b = materializeRangedCounterSplits(
        config.redRoster!,
        rankedDraftStackCapacity(rosterIds(config.redRoster!), config.redAugments!, job.synergyVariants),
    );
    config.roster = a.roster;
    config.greenTacticalSplitStacks = a.splitRoles;
    config.redRoster = b.roster;
    config.redTacticalSplitStacks = b.splitRoles;
    return arm;
}

function applyPositions(
    context: Parameters<NonNullable<IMatchConfig["beforeFightStart"]>>[0],
    own: readonly Unit[],
    positions: ReadonlyMap<string, XY>,
    legal: ReadonlySet<number>,
) {
    if (!validRangedCounterFormation(rangedCounterBodies(own, 0), positions, legal))
        throw new Error("Illegal contextual draft formation");
    for (const unit of own) context.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
    for (const unit of own) {
        const cells = footprintCellsForAnchor(unit, positions.get(unit.getId())!);
        const point = getPositionForCells(context.grid.getSettings(), cells);
        if (!point) throw new Error("Invalid contextual draft footprint");
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
            throw new Error("Contextual formation occupancy failed");
    }
}

function withDraft<T>(
    job: IContextualDraftJob,
    capture: (config: IMatchConfig, decisions: IContextualDraftDecision[]) => T,
): T {
    const genome = rankedDraftStrengthCandidate(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC);
    const doctrines = v09DoctrineBoard(job.board, "balanced-doctrines-v1");
    const decisions: IContextualDraftDecision[] = [];
    const own = createContextualDraftChoices({
        doctrine: doctrines.candidateDoctrinePolicy as ScoutingDoctrine,
        synergyVariants: job.synergyVariants,
        mode:
            job.condition === "fork"
                ? "fork"
                : job.condition === "learned" || job.condition === "ablated"
                  ? "model"
                  : "reference",
        targetLevel: job.targetLevel,
        model: job.model,
        recordTrainingDecision: job.recordTrainingDecision,
        onDecision: (decision) => decisions.push(decision),
    });
    const enemy =
        job.opponent === "rush"
            ? createRangedPressureOpponent()
            : createLockedDoctrineDraftResearchChoices({
                  genome,
                  doctrine: doctrines.opponentDoctrinePolicy as ScoutingDoctrine,
                  synergyVariants: job.synergyVariants,
              });
    const stop = Symbol("capture-contextual-match");
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
                tacticalSplits: false,
                candidateSetupPolicySpec: CONTEXTUAL_DRAFT_SETUP_SPEC,
                opponentSetupPolicySpec: CONTEXTUAL_DRAFT_SETUP_SPEC,
                ...doctrines,
            },
            job.game,
            0,
            {
                liveSequentialBundles: true,
                researchCandidateDraftChoices: own,
                researchOpponentDraftChoices: enemy,
                matchRunner: (config) => {
                    if (
                        ["Life", "Chaos", "Might", "Nature"].some(
                            (faction) => config.synergyVariants?.[faction] !== job.synergyVariants[faction],
                        )
                    )
                        throw new Error("Registered contextual synergy variants changed");
                    output = { value: capture(config, decisions) };
                    throw stop;
                },
            },
        );
    } catch (error) {
        if (error !== stop) throw error;
    }
    if (!output) throw new Error("Missing contextual draft result");
    return output.value;
}

/** Seed registration may inspect draft context and public variants, but never battle outcomes. */
export function inspectContextualDraftBoard(board: IContextualDraftBoard) {
    return withDraft(
        { ...board, condition: "locked", game: board.trainingGames[0], recordTrainingDecision: true },
        (config, decisions) => ({
            pickSeed: permuteRankedDraftSeed(board.seed + 1),
            synergyVariants: config.synergyVariants,
            ownIds: rosterIds(candidateGreen(board.trainingGames[0]) ? config.roster : config.redRoster!),
            decisions,
        }),
    );
}

export function runContextualDraftGame(job: IContextualDraftJob) {
    const began = performance.now();
    const ownTeam = candidateGreen(job.game) ? GREEN_TEAM : RED_TEAM;
    return withDraft(job, (config, draftDecisions) => {
        const arm = prepareSetup(job, config);
        const formations: unknown[] = [];
        let decisionMs = 0,
            decisionCount = 0,
            setupMs = 0;
        const draftMs = performance.now() - began;
        const result = runMatch({
            ...config,
            headlessEvents: true,
            researchCaptureDecisionStart: true,
            beforeFightStart: (context) => {
                const started = performance.now();
                for (const team of [GREEN_TEAM, RED_TEAM]) {
                    const own = context.unitsHolder.getAllAllies(team),
                        fp = context.fightProperties;
                    const enemy = rosterIds(team === GREEN_TEAM ? config.redRoster! : config.roster);
                    const augments = team === GREEN_TEAM ? config.greenAugments! : config.redAugments!;
                    const legal = new RectanglePlacement(
                        context.grid.getSettings(),
                        team === GREEN_TEAM ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
                        fp.getAugmentPlacement(team)[0],
                        true,
                    ).possibleCellHashes();
                    const baseline = finalizeA19Placement(
                        own,
                        {
                            team,
                            gridType: config.gridType!,
                            sideOrientedPlacement: true,
                            legalCellHashes: legal,
                            publicOpponentCreatureIds: enemy,
                            artifacts: [fp.getArtifactTier1(team), fp.getArtifactTier2(team)] as [number, number],
                            doctrine: fp.getDoctrine(team),
                            augments,
                        },
                        new Map(own.map((u) => [u.getId(), { ...u.getBaseCell() }])),
                    );
                    const spread = team === ownTeam && arm !== "control";
                    const positions = spread
                        ? spreadRangedCounterFormation(
                              rangedCounterBodies(own, fp.getAdditionalAuraRangePerTeam(team)),
                              baseline,
                              { team: team as TeamType, sideAxis: true, legal, enemyIds: enemy },
                          )
                        : baseline;
                    applyPositions(context, own, positions, legal);
                    formations.push({
                        team,
                        spread,
                        augments,
                        units: own.map((unit) => ({
                            name: unit.getName(),
                            amount: unit.getAmountAlive(),
                            width: unit.getFootprintWidth(),
                            height: unit.getFootprintHeight(),
                            ...unit.getBaseCell(),
                        })),
                    });
                }
                setupMs += performance.now() - started;
            },
            decisionObserver: (observation) => {
                if (observation.unit.getTeam() === ownTeam) {
                    if (observation.context.decisionStartedAtMs === undefined)
                        throw new Error("Missing decision timer");
                    decisionMs += performance.now() - observation.context.decisionStartedAtMs;
                    decisionCount++;
                }
            },
        });
        if (result.rejectedGreen || result.rejectedRed || result.endReason !== "elimination")
            throw new Error(
                `Invalid contextual draft battle: ${JSON.stringify({ job: { board: job.board, condition: job.condition, game: job.game }, reason: result.endReason, rejected: result.rejectedDetails })}`,
            );
        const side = ownTeam === GREEN_TEAM ? "green" : "red";
        return {
            board: job.board,
            seed: job.seed,
            condition: job.condition,
            game: job.game,
            opponent: job.opponent,
            targetLevel: job.targetLevel,
            map: config.gridType,
            synergyVariants: config.synergyVariants,
            ownIds: rosterIds(candidateGreen(job.game) ? config.roster : config.redRoster!),
            enemyIds: rosterIds(candidateGreen(job.game) ? config.redRoster! : config.roster),
            score: result.winner === "draw" ? 0.5 : result.winner === side ? 1 : 0,
            winner: result.winner,
            laps: result.laps,
            rejected: 0,
            selectedSetup: arm,
            draftDecisions,
            formations,
            traceSha256: rankedDraftBehaviorTraceSha256(result),
            timing: { elapsedMs: performance.now() - began, draftMs, setupMs, decisionMs, decisionCount },
        };
    });
}
