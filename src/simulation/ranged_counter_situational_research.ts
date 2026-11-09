/** New hypothesis after the locked first study; the earlier candidates and their gates are unchanged. */
import { creatureInfo } from "../ai/setup/creature_score";
import {
    inspectRangedCounterBoard,
    runRangedCounterGame,
    type IRangedCounterJob,
    type RangedCounterArm,
} from "./measure_ranged_counter_research";
import { rangedCounterThreats } from "./ranged_counter_research";

export const RANGED_COUNTER_SITUATIONAL_ID = "ranged-counter-situational-v2-20261109";
export const RANGED_COUNTER_SITUATIONAL_CONDITIONS = ["current", "free", "situational"] as const;
export type RangedCounterCondition = (typeof RANGED_COUNTER_SITUATIONAL_CONDITIONS)[number];

/** Public final roster only. It cannot infer hidden enemy upgrades, stack sizes or positions. */
export function selectSituationalRangedCounter(
    ownIds: readonly number[],
    publicEnemyIds: readonly number[],
): RangedCounterArm {
    if (ownIds.filter((id) => creatureInfo(id)?.ranged).length < 3) return "control";
    const threat = rangedCounterThreats(publicEnemyIds);
    if (threat.nullField || threat.flyers >= 2) return "placement1-sniper";
    return threat.area ? "free-spread" : "control";
}

export function runSituationalRangedCounter(
    job: Omit<IRangedCounterJob, "arm"> & { condition: RangedCounterCondition },
) {
    const began = performance.now();
    let arm: RangedCounterArm = job.condition === "free" ? "free-spread" : "control";
    if (job.condition === "situational") {
        const setup = inspectRangedCounterBoard(job)[job.game < 2 ? 0 : 1];
        arm = selectSituationalRangedCounter(setup.ownIds, setup.enemyIds);
    }
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
