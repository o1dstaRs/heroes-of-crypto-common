import { createHash } from "node:crypto";
import { creatureIdForName } from "../ai/setup/creature_score";
import { V09_DEFAULT_DRAFT_BASE_POLICY_SPEC } from "../ai/setup/doctrine_draft_policy";
import {
    empowerContextFeatures,
    selectContextualEmpower,
    type IContextualEmpowerModel,
} from "../ai/setup/empower_context";
import type { IPlacementSetupDecisionContext } from "../ai/setup/setup_strategy";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import { synergyVariantsForSeed } from "../synergies/synergy_properties";
import type { IMatchConfig } from "./battle_engine";
import { permuteRankedDraftSeed, playRankedDraftGame, rankedDraftStrengthCandidate } from "./ranked_draft_eval";
import { v09DoctrineBoard } from "./v0_9/a19_doctrine_population";
import { createLockedDoctrineDraftResearchChoices } from "./v0_9/doctrine_draft_checkpoint";
import type { ScoutingDoctrine } from "./v0_9/doctrine_draft_model";
import { EMPOWER_RESEARCH_SETUP, runProtectedAxisEmpowerResearchGame } from "./empower_protected_axis_research";

export interface IContextualEmpowerJob {
    board: number;
    seed: number;
    game: number;
    level: number;
    model?: IContextualEmpowerModel;
}
type IEmpowerResearchJob = IContextualEmpowerJob;
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

export function inspectContextualEmpowerInput(job: IContextualEmpowerJob) {
    return withDraft(job, (config) => {
        const green = candidateGreen(job.game);
        const own = ids(green ? config.roster : config.redRoster!);
        const enemy = ids(green ? config.redRoster! : config.roster);
        const doctrine = (green ? config.greenDoctrine : config.redDoctrine)!;
        const budget = getUpgradePoints(doctrine);
        const context: IPlacementSetupDecisionContext = {
            decisionPhase: "placement",
            opponentRosterVisibility: "complete",
            publicOpponentCreatureIds: enemy,
            gridType: config.gridType!,
            gridSize: 16,
            ownDoctrine: doctrine,
            ownArtifactIds: [
                (green ? config.greenArtifactT1 : config.redArtifactT1) ?? 0,
                (green ? config.greenArtifactT2 : config.redArtifactT2) ?? 0,
            ],
        };
        return {
            inputSha256: sha(config),
            own,
            enemy,
            budget,
            map: config.gridType,
            context,
            features: empowerContextFeatures(budget, own, context),
        };
    });
}

export function runContextualEmpowerResearchGame(job: IContextualEmpowerJob) {
    const inspected = inspectContextualEmpowerInput(job);
    const level = job.model
        ? selectContextualEmpower(job.model, inspected.budget, inspected.own, inspected.context)
        : inspected.features
          ? job.level
          : 0;
    if (level !== 0 && level !== 1) throw new RangeError("Contextual Empower only offers zero or one point");
    const result = runProtectedAxisEmpowerResearchGame({ board: job.board, seed: job.seed, game: job.game, level });
    if (result.inputSha256 !== inspected.inputSha256) throw new Error("Contextual inspection changed the battle input");
    return { ...result, requestedLevel: job.level, ...inspected };
}
