import { A19_NEURAL_POLICY } from "../ai/versions/v0_8_a19_neural_policy";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import { getA19NeuralModel } from "./a19_neural_model";
import type { SearchDriver } from "./search_driver";
import { withV09A19Correction } from "./v0_9/a19_correction";
import type { V09A19CpuModel } from "./v0_9/a19_inference";

interface INeuralBudget {
    horizon: number;
    rollouts: number;
    complementaryR2: boolean;
    a19MaterialArbitration: string | undefined;
    decisionDeadlineMs: number | null;
    circuitBreakerMs: number | null;
}

export interface IA19NeuralState {
    policyId: typeof A19_NEURAL_POLICY.id;
    decisions: number;
    inferred: number;
    corrected: number;
    missingStart: number;
    deadlineAbstentions: number;
    inferenceOverruns: number;
    modelErrors: number;
}
const states = new WeakMap<SearchDriver, IA19NeuralState>();
const offlineOf = new WeakMap<SearchDriver, boolean>();

/**
 * The correction was measured inside the A19 profile's 1,000 ms native allowance and 1,500 ms breaker; a live driver on
 * any other budget (the deep-fit stock search's 2,500 / 3,750 ms since profile v30) plays the native choice. Offline
 * follows live wherever the budget names a live deadline, so offline research measures the AI that bot seats run. An
 * offline driver with no deadline (deterministic-work tools) keeps the correction.
 */
const correctionEngages = (budget: INeuralBudget, version: string, offline: boolean): boolean => {
    const otherBudget = budget.decisionDeadlineMs !== 1000 || budget.circuitBreakerMs !== 1500;
    return !(
        version !== "v0.8" ||
        budget.horizon !== 64 ||
        budget.rollouts !== 2 ||
        !budget.complementaryR2 ||
        budget.a19MaterialArbitration !== "ties" ||
        (otherBudget && (!offline || budget.decisionDeadlineMs !== null))
    );
};

/**
 * Whether attachA19NeuralCorrection's wrapper corrects `driver`'s choice for `version`: the wrapper's own gate. A native
 * rollout backend keeps such a driver's banks in TypeScript (native_rollouts.ts), so the two can never disagree.
 */
export function a19NeuralCorrectionEngages(driver: SearchDriver, version: string): boolean {
    const offline = offlineOf.get(driver);
    return offline !== undefined && correctionEngages(driver as unknown as INeuralBudget, version, offline);
}
export const getA19NeuralState = (driver: SearchDriver): Readonly<IA19NeuralState> | undefined => {
    const state = states.get(driver);
    return state ? { ...state } : undefined;
};
export const requiresA19NativeDecisionStart = (driver: SearchDriver): boolean => states.has(driver);

export function attachA19NeuralCorrection(
    driver: SearchDriver,
    options: { offline: boolean; model?: Pick<V09A19CpuModel, "predict"> },
): SearchDriver {
    if (states.has(driver)) return driver;
    const state: IA19NeuralState = {
        policyId: A19_NEURAL_POLICY.id,
        decisions: 0,
        inferred: 0,
        corrected: 0,
        missingStart: 0,
        deadlineAbstentions: 0,
        inferenceOverruns: 0,
        modelErrors: 0,
    };
    states.set(driver, state);
    offlineOf.set(driver, options.offline);
    // Native rollout banks keep this driver's banks in TypeScript wherever the correction engages (native_rollouts.ts).
    driver.vetoNativeRollouts("neural_on", (version) =>
        correctionEngages(driver as unknown as INeuralBudget, version, options.offline),
    );
    const ownChoose = Object.getOwnPropertyDescriptor(driver, "chooseDecision")?.value as
        SearchDriver["chooseDecision"] | undefined;
    const model = options.model ?? { predict: (observation) => getA19NeuralModel().predict(observation) };
    const choose = function (
        this: SearchDriver,
        unit: Unit,
        version: string,
        incumbent: GameAction[],
        context?: IDecisionContext,
    ): GameAction[] {
        const nativeChoose = ownChoose ?? (Object.getPrototypeOf(this) as SearchDriver).chooseDecision;
        if (!correctionEngages(this as unknown as INeuralBudget, version, options.offline))
            return nativeChoose.call(this, unit, version, incumbent, context);
        const descriptor = Object.getOwnPropertyDescriptor(this, "chooseDecision");
        Object.defineProperty(this, "chooseDecision", { value: nativeChoose, writable: true, configurable: true });
        try {
            const corrected = withV09A19Correction(
                {
                    driver: this,
                    team: unit.getTeam(),
                    model,
                    minimumLogitGain: A19_NEURAL_POLICY.minimumLogitGain,
                    actionFamily: A19_NEURAL_POLICY.actionFamily,
                    executionMode: options.offline ? "operation-bounded" : "wall-clock",
                    chargeNativeDecision: true,
                    failClosed: true,
                },
                () => this.chooseDecision(unit, version, incumbent, context),
            );
            for (const key of [
                "decisions",
                "inferred",
                "corrected",
                "missingStart",
                "deadlineAbstentions",
                "inferenceOverruns",
                "modelErrors",
            ] as const)
                state[key] += corrected.statistics[key];
            return corrected.value;
        } finally {
            if (descriptor) Object.defineProperty(this, "chooseDecision", descriptor);
            else Reflect.deleteProperty(this, "chooseDecision");
        }
    };
    Object.defineProperty(driver, "chooseDecision", { value: choose, writable: true, configurable: true });
    return driver;
}
