import { parentPort, workerData } from "node:worker_threads";

import type { AiMetaCohort } from "../../src/simulation/ai_meta_cohorts_core";
import { playMetaPair } from "../../src/simulation/ai_meta_cohorts_pair";
import type { AiMetaStrategyProfileId } from "../../src/simulation/ai_meta_strategy_profile";
import { SearchDriver } from "../../src/simulation/search_driver";

interface IForcedTruncationWorkerData {
    pairs: { cohort: AiMetaCohort; pair: number }[];
    strategyProfileId: AiMetaStrategyProfileId;
}

if (!parentPort) {
    throw new Error("a19_forced_truncation_worker must run in a worker thread");
}

// Deterministic deadline exhaustion: every search sees its wall-clock deadline expire on the first check, so
// SearchDriver takes the real SearchDecisionDeadlineExceeded fallback on every searched decision regardless of
// host speed. The parent passes the sanitized a19 environment with the circuit breaker pushed out of reach.
type DeadlineCheck = (this: unknown, deadlineAt: number | null) => void;
const driver = SearchDriver.prototype as unknown as { assertBeforeDecisionDeadline: DeadlineCheck };
const assertBeforeDecisionDeadline = driver.assertBeforeDecisionDeadline;
driver.assertBeforeDecisionDeadline = function (deadlineAt) {
    assertBeforeDecisionDeadline.call(this, deadlineAt === null ? null : 0);
};

const { pairs, strategyProfileId } = workerData as IForcedTruncationWorkerData;
try {
    const games = pairs.map(({ cohort, pair }) => ({
        cohort,
        pair,
        games: playMetaPair({ cohort, games: 1008, baseSeed: 85_000_717 }, pair, strategyProfileId).games,
    }));
    parentPort.postMessage({ type: "result", games });
} catch (error) {
    parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
    });
}
