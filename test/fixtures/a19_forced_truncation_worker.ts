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

// Deterministic deadline exhaustion: every timed search expires on the first check, so
// SearchDriver takes the real SearchDecisionDeadlineExceeded fallback regardless of host speed.
// Operation-bounded waits and fallback validation retain their normal non-deadline path.
type DeadlineCheck = (this: unknown, deadlineAt: number | null) => void;
const driver = SearchDriver.prototype as unknown as { assertBeforeDecisionDeadline: DeadlineCheck };
const drivers = new Set<SearchDriver>();
const onMatchEnd = SearchDriver.prototype.onMatchEnd;
SearchDriver.prototype.onMatchEnd = function (...args) {
    drivers.add(this);
    onMatchEnd.apply(this, args);
};
const assertBeforeDecisionDeadline = driver.assertBeforeDecisionDeadline;
driver.assertBeforeDecisionDeadline = function (deadlineAt) {
    assertBeforeDecisionDeadline.call(this, deadlineAt === null ? null : 0);
};

const { pairs, strategyProfileId } = workerData as IForcedTruncationWorkerData;
try {
    const games = pairs.map(({ cohort, pair }) => {
        drivers.clear();
        const games = playMetaPair({ cohort, games: 1008, baseSeed: 85_000_717 }, pair, strategyProfileId).games;
        const searches = [...drivers]
            .filter((driver) => driver.counters.decisions > 0)
            .map((driver) => ({
                deadlineFallbacks: driver.counters.deadlineFallbacks,
            }));
        return { cohort, pair, games, searches };
    });
    parentPort.postMessage({ type: "result", games });
} catch (error) {
    parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
    });
}
