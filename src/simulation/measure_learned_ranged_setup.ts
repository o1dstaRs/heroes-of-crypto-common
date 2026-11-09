/** Offline adapter for the frozen learned setup model, keeping all three fixed controls. */
import { synergyVariantsForSeed } from "../synergies/synergy_properties";
import {
    inspectRangedCounterBoard,
    runRangedCounterGame,
    type IRangedCounterJob,
} from "./measure_ranged_counter_research";
import { lockedLearnedRangedSetupModel } from "./learned_ranged_setup_checkpoint";
import { selectLearnedRangedSetup } from "./learned_ranged_setup_research";
import { permuteRankedDraftSeed } from "./ranked_draft_eval";
import { runSituationalRangedCounter, type RangedCounterCondition } from "./ranged_counter_situational_research";
import { v09DoctrineBoard } from "./v0_9/a19_doctrine_population";

export const LEARNED_SETUP_CONDITIONS = ["current", "free", "situational", "learned"] as const;
export type LearnedSetupCondition = (typeof LEARNED_SETUP_CONDITIONS)[number];
const MODEL = lockedLearnedRangedSetupModel();

export function runLearnedRangedSetup(job: Omit<IRangedCounterJob, "arm"> & { condition: LearnedSetupCondition }) {
    if (job.condition !== "learned")
        return runSituationalRangedCounter({ ...job, condition: job.condition as RangedCounterCondition });
    const began = performance.now();
    const setup = inspectRangedCounterBoard(job)[job.game < 2 ? 0 : 1];
    const doctrine = v09DoctrineBoard(job.board, "balanced-doctrines-v1").candidateDoctrinePolicy;
    const budget = doctrine === "see-all" ? 5 : doctrine === "three-reveals" ? 6 : 7;
    const arm = selectLearnedRangedSetup(MODEL, {
        ownCreatureIds: setup.ownIds,
        publicOpponentCreatureIds: setup.enemyIds,
        budget,
        map: [1, 3, 4][job.board % 3],
        synergyVariants: synergyVariantsForSeed(`ranked-draft-${permuteRankedDraftSeed(job.seed + 1)}`),
    });
    const dispatchMs = performance.now() - began;
    const result = runRangedCounterGame({ ...job, arm });
    return {
        ...result,
        condition: job.condition,
        selectedPolicy: arm,
        dispatchMs,
        timing: { ...result.timing, elapsedMs: result.timing.elapsedMs + dispatchMs },
    };
}
