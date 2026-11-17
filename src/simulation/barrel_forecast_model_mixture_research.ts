/** Offline model-uncertainty experiment. No strategy is installed by importing this module. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import { selectBarrelForecastIntent } from "./barrel_forecast_intent_research";

export const BARREL_FORECAST_MODEL_MIXTURE_RESEARCH_ID = "barrel-forecast-paired-model-mixture-v1";

export interface IBarrelForecastSample {
    readonly horizonMode: string;
    readonly rolloutCount: number;
    readonly sampleIndex: number;
    readonly seedBase: number;
}

/**
 * Stratify the existing full R2 budget over two uncertain future policies. Every candidate at the same
 * root uses the same assignment; root-seed parity balances which complementary chance stream gets the
 * intent model. Each model gets one chance sample, not its own complete antithetic pair. Native R4,
 * leaf/reply probes and invalid queries stay unchanged. This adds no random draw, rollout or model fit.
 */
export function usesBarrelIntentForecast(sample: IBarrelForecastSample): boolean {
    return (
        sample.horizonMode === "turns" &&
        sample.rolloutCount === 2 &&
        (sample.sampleIndex === 0 || sample.sampleIndex === 1) &&
        Number.isInteger(sample.seedBase) &&
        sample.seedBase >= 0 &&
        sample.seedBase <= 0xffffffff &&
        sample.sampleIndex === (sample.seedBase & 1)
    );
}

/** Both projected armies/owners use the same selected model; actual root incumbents remain native. */
export function selectBarrelForecastModelMixture(
    unit: Unit,
    context: IDecisionContext,
    beforeCleanup: GameAction[],
    cleanup: GameAction[],
    sample: IBarrelForecastSample,
): GameAction[] {
    return usesBarrelIntentForecast(sample)
        ? selectBarrelForecastIntent(unit, context, beforeCleanup, cleanup)
        : cleanup;
}
