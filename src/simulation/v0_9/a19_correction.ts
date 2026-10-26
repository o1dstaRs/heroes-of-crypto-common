/** Isolated research arm. Importing this file never changes the shipped A19 controller. */
import type { IDecisionContext } from "../../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../../ai/candidates";
import { v09CandidateSignature } from "../../ai/versions/v0_9";
import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../../utils/lib";
import { ilActionFamily } from "../il_action_features";
import { SearchDriver } from "../search_driver";
import { encodeV09A19Observation } from "./a19_observation";
import type { V09A19CpuModel } from "./a19_inference";

interface ICorrectionDriver {
    horizon: number;
    rollouts: number;
    complementaryR2: boolean;
    a19MaterialArbitration: string | undefined;
    decisionDeadlineMs: number | null;
    circuitBreakerMs: number | null;
    match: { offlineDeterministicWork?: boolean };
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        ...args: unknown[]
    ): readonly IEnumeratedCandidate[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        count?: number,
        deadline?: number | null,
        turns?: number,
        ...args: unknown[]
    ): number[];
    rollout(
        unit: Unit,
        candidate: IEnumeratedCandidate,
        seed: number,
        index: number,
        mode: string,
        ...args: unknown[]
    ): number;
}

export const V09_A19_LIVE_INFERENCE_RESERVE_MS = 25;
export const v09A19HasInferenceTime = (now: number, started: number, deadlineMs: number) =>
    now + V09_A19_LIVE_INFERENCE_RESERVE_MS < started + deadlineMs;
interface ICorrectionBank {
    candidates: readonly IEnumeratedCandidate[];
    means: number[];
    completed: Map<string, number>;
}

/** Same-family, fully scored primary ties only. No low-scoring or partially pruned action is eligible. */
export function selectV09A19Correction(input: {
    candidates: readonly { readonly actions: readonly GameAction[] }[];
    means: readonly number[];
    completed: readonly number[];
    selected: number;
    policy: readonly number[];
    minimumLogitGain: number;
}): number {
    const { candidates, means, completed, selected, policy, minimumLogitGain } = input;
    if (
        !Number.isFinite(minimumLogitGain) ||
        minimumLogitGain <= 0 ||
        candidates.length !== means.length ||
        candidates.length !== policy.length ||
        completed.length !== candidates.length ||
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected >= candidates.length ||
        !policy.every(Number.isFinite)
    )
        throw new Error("Invalid research correction evidence");
    const maximum = Math.max(...means.filter(Number.isFinite));
    if (completed[selected] !== 2 || means[selected] !== maximum) return selected;
    const family = ilActionFamily(candidates[selected].actions);
    let best = selected;
    for (let index = 0; index < candidates.length; index++)
        if (
            completed[index] === 2 &&
            means[index] === maximum &&
            ilActionFamily(candidates[index].actions) === family &&
            policy[index] > policy[best]
        )
            best = index;
    return policy[best] - policy[selected] >= minimumLogitGain ? best : selected;
}

/** A null model takes the original path. Wall-clock research explicitly reserves time and falls back on faults. */
export function withV09A19Correction<T>(
    options: {
        team: number;
        model: Pick<V09A19CpuModel, "predict"> | null;
        minimumLogitGain: number;
        executionMode?: "operation-bounded" | "wall-clock";
    },
    run: () => T,
) {
    const statistics = {
        decisions: 0,
        inferred: 0,
        corrected: 0,
        inferenceMs: [] as number[],
        fullTurnMs: [] as number[],
        deadlineAbstentions: 0,
        inferenceOverruns: 0,
        modelErrors: 0,
    };
    if (!options.model) return { value: run(), statistics };
    if (!Number.isFinite(options.minimumLogitGain) || options.minimumLogitGain <= 0)
        throw new Error("Choose a positive registered confidence margin");
    const model = options.model;
    const prototype = SearchDriver.prototype as unknown as ICorrectionDriver;
    const choose = prototype.chooseDecision,
        shortlist = prototype.shortlistCandidates,
        score = prototype.scoreCandidates,
        rollout = prototype.rollout;
    let active:
        { driver: ICorrectionDriver; catalog: Map<string, IEnumeratedCandidate>; banks: ICorrectionBank[] } | undefined;
    let bank: ICorrectionBank | undefined;
    prototype.shortlistCandidates = function (...args) {
        if (active?.driver === this)
            for (const candidate of args[1]) active.catalog.set(v09CandidateSignature(candidate.actions), candidate);
        return shortlist.apply(this, args);
    };
    prototype.rollout = function (...args) {
        const value = rollout.apply(this, args);
        if (active?.driver === this && bank && args[4] === "turns" && Number.isFinite(value)) {
            const key = v09CandidateSignature(args[1].actions);
            bank.completed.set(key, (bank.completed.get(key) ?? 0) + 1);
        }
        return value;
    };
    prototype.scoreCandidates = function (...args) {
        if (
            active?.driver !== this ||
            args[3] !== "turns" ||
            (args[4] ?? this.rollouts) !== 2 ||
            (args[6] ?? this.horizon) !== 64
        )
            return score.apply(this, args);
        const previous = bank;
        const recorded: ICorrectionBank = { candidates: [...args[1]], means: [], completed: new Map() };
        bank = recorded;
        try {
            recorded.means = score.apply(this, args);
            active.banks.push(recorded);
            return recorded.means;
        } finally {
            bank = previous;
        }
    };
    prototype.chooseDecision = function (...args) {
        const [unit, version, , context] = args;
        if (unit.getTeam() !== options.team || version !== "v0.8") return choose.apply(this, args);
        if (
            (this.match.offlineDeterministicWork === true) !== (options.executionMode !== "wall-clock") ||
            this.horizon !== 64 ||
            this.rollouts !== 2 ||
            !this.complementaryR2 ||
            this.a19MaterialArbitration !== "ties"
        )
            throw new Error("Correction arm requires frozen A19 complementary R2 and the selected execution mode");
        const live = options.executionMode === "wall-clock";
        if (live && (this.decisionDeadlineMs !== 1000 || this.circuitBreakerMs !== 1500))
            throw new Error("Wall-clock research requires the current A19 deadline and breaker profile");
        const started = performance.now();
        statistics.decisions++;
        const previous = active;
        const frame = {
            driver: this,
            catalog: new Map<string, IEnumeratedCandidate>(),
            banks: [] as ICorrectionBank[],
        };
        active = frame;
        try {
            const stock = choose.apply(this, args);
            if (live && !v09A19HasInferenceTime(performance.now(), started, this.decisionDeadlineMs!)) {
                statistics.deadlineAbstentions++;
                return stock;
            }
            const signature = v09CandidateSignature(stock);
            const evidence = [...frame.banks]
                .reverse()
                .find((row) =>
                    row.candidates.some((candidate) => v09CandidateSignature(candidate.actions) === signature),
                );
            if (!context || !evidence) return stock;
            const selected = evidence.candidates.findIndex(
                (candidate) => v09CandidateSignature(candidate.actions) === signature,
            );
            const completed = evidence.candidates.map(
                (candidate) => evidence.completed.get(v09CandidateSignature(candidate.actions)) ?? 0,
            );
            const maximum = Math.max(...evidence.means.filter(Number.isFinite));
            const family = ilActionFamily(stock);
            if (
                completed[selected] !== 2 ||
                evidence.means[selected] !== maximum ||
                evidence.candidates.filter(
                    (candidate, index) =>
                        completed[index] === 2 &&
                        evidence.means[index] === maximum &&
                        ilActionFamily(candidate.actions) === family,
                ).length < 2
            )
                return stock;
            const catalog = new Map([
                [v09CandidateSignature(evidence.candidates[0].actions), evidence.candidates[0]],
                ...frame.catalog,
            ]);
            for (const candidate of evidence.candidates)
                catalog.set(v09CandidateSignature(candidate.actions), candidate);
            if (live && !v09A19HasInferenceTime(performance.now(), started, this.decisionDeadlineMs!)) {
                statistics.deadlineAbstentions++;
                return stock;
            }
            const before = performance.now();
            const random = captureDeterministicRandomState();
            let scores: Map<string, number>;
            try {
                const observation = encodeV09A19Observation(unit, context, [...catalog.values()]);
                const predicted = model.predict(observation);
                if (
                    predicted.policy.length !== observation.candidates.length ||
                    !predicted.policy.every(Number.isFinite)
                )
                    throw new Error("Invalid neural correction output");
                scores = new Map(
                    observation.candidates.map((candidate, index) => [candidate.signature, predicted.policy[index]]),
                );
            } catch (error) {
                if (!live) throw error;
                statistics.modelErrors++;
                return stock;
            } finally {
                restoreDeterministicRandomState(random);
                statistics.inferenceMs.push(performance.now() - before);
                statistics.inferred++;
            }
            if (live && performance.now() >= started + this.decisionDeadlineMs!) {
                statistics.inferenceOverruns++;
                return stock;
            }
            const chosen = selectV09A19Correction({
                candidates: evidence.candidates,
                means: evidence.means,
                completed,
                selected,
                policy: evidence.candidates.map((candidate) => scores.get(v09CandidateSignature(candidate.actions))!),
                minimumLogitGain: options.minimumLogitGain,
            });
            if (chosen === selected) return stock;
            statistics.corrected++;
            return structuredClone(evidence.candidates[chosen].actions);
        } finally {
            active = previous;
            statistics.fullTurnMs.push(performance.now() - started);
        }
    };
    try {
        return { value: run(), statistics };
    } finally {
        prototype.chooseDecision = choose;
        prototype.shortlistCandidates = shortlist;
        prototype.scoreCandidates = score;
        prototype.rollout = rollout;
    }
}
