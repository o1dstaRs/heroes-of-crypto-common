/** Offline R8 teacher only. The qualified production R2 controller stays byte-for-byte unchanged. */
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

interface ITeacherDriver {
    horizon: number;
    rollouts: number;
    complementaryR2: boolean;
    a19MaterialArbitration: string | undefined;
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

interface ITeacherBank {
    candidates: readonly IEnumeratedCandidate[];
    means: number[];
    completed: Map<string, number>;
}

/** Eight actual completed rollouts per eligible candidate, exact primary ties, registered confidence margin. */
export function selectV09A19TeacherCorrection(input: {
    candidates: readonly { readonly actions: readonly GameAction[] }[];
    means: readonly number[];
    completed: readonly number[];
    selected: number;
    policy: readonly number[];
    minimumLogitGain: number;
    actionFamily?: "same" | "all";
}): number {
    const { candidates, means, completed, selected, policy, minimumLogitGain } = input;
    if (
        !Number.isFinite(minimumLogitGain) ||
        minimumLogitGain <= 0 ||
        (input.actionFamily !== undefined && input.actionFamily !== "same" && input.actionFamily !== "all") ||
        candidates.length !== means.length ||
        candidates.length !== policy.length ||
        completed.length !== candidates.length ||
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected >= candidates.length ||
        !policy.every(Number.isFinite)
    )
        throw new Error("Invalid R8 teacher correction evidence");
    const maximum = Math.max(...means.filter(Number.isFinite));
    if (completed[selected] !== 8 || means[selected] !== maximum) return selected;
    const family = ilActionFamily(candidates[selected].actions);
    let best = selected;
    for (let index = 0; index < candidates.length; index++)
        if (
            completed[index] === 8 &&
            means[index] === maximum &&
            (input.actionFamily === "all" || ilActionFamily(candidates[index].actions) === family) &&
            policy[index] > policy[best]
        )
            best = index;
    return policy[best] - policy[selected] >= minimumLogitGain ? best : selected;
}

/** Synchronous research scope: any model fault fails the board; hooks and deterministic RNG are always restored. */
export function withV09A19NeuralTeacher<T>(
    options: {
        team: number;
        model: Pick<V09A19CpuModel, "predict">;
        minimumLogitGain: number;
        actionFamily?: "same" | "all";
    },
    run: () => T,
) {
    if (!Number.isFinite(options.minimumLogitGain) || options.minimumLogitGain <= 0)
        throw new Error("Choose a positive registered confidence margin");
    if (options.actionFamily !== undefined && options.actionFamily !== "same" && options.actionFamily !== "all")
        throw new Error("Choose a registered correction action family");
    const statistics = { decisions: 0, inferred: 0, corrected: 0 };
    const prototype = SearchDriver.prototype as unknown as ITeacherDriver;
    const methodNames = ["chooseDecision", "shortlistCandidates", "scoreCandidates", "rollout"] as const;
    const descriptors = methodNames.map((name) => Object.getOwnPropertyDescriptor(prototype, name));
    const choose = prototype.chooseDecision,
        shortlist = prototype.shortlistCandidates,
        score = prototype.scoreCandidates,
        rollout = prototype.rollout;
    let active:
        { driver: ITeacherDriver; catalog: Map<string, IEnumeratedCandidate>; banks: ITeacherBank[] } | undefined;
    let bank: ITeacherBank | undefined;
    try {
        prototype.shortlistCandidates = function (...args) {
            if (active?.driver === this)
                for (const candidate of args[1])
                    active.catalog.set(v09CandidateSignature(candidate.actions), candidate);
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
                (args[4] ?? this.rollouts) !== 8 ||
                (args[6] ?? this.horizon) !== 64
            )
                return score.apply(this, args);
            const previous = bank;
            const recorded: ITeacherBank = { candidates: [...args[1]], means: [], completed: new Map() };
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
                this.match.offlineDeterministicWork !== true ||
                this.horizon !== 64 ||
                this.rollouts !== 8 ||
                this.complementaryR2 ||
                this.a19MaterialArbitration !== "ties"
            )
                throw new Error("Neural R8 teacher requires offline operation-bounded H64/R8 search");
            statistics.decisions++;
            const previous = active;
            const frame = {
                driver: this,
                catalog: new Map<string, IEnumeratedCandidate>(),
                banks: [] as ITeacherBank[],
            };
            active = frame;
            try {
                const stock = choose.apply(this, args);
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
                    completed[selected] !== 8 ||
                    evidence.means[selected] !== maximum ||
                    evidence.candidates.filter(
                        (candidate, index) =>
                            completed[index] === 8 &&
                            evidence.means[index] === maximum &&
                            (options.actionFamily === "all" || ilActionFamily(candidate.actions) === family),
                    ).length < 2
                )
                    return stock;
                const catalog = new Map([
                    [v09CandidateSignature(evidence.candidates[0].actions), evidence.candidates[0]],
                    ...frame.catalog,
                ]);
                for (const candidate of evidence.candidates)
                    catalog.set(v09CandidateSignature(candidate.actions), candidate);
                const random = captureDeterministicRandomState();
                let scores: Map<string, number>;
                try {
                    const observation = encodeV09A19Observation(unit, context, [...catalog.values()]);
                    const predicted = options.model.predict(observation);
                    if (
                        predicted.policy.length !== observation.candidates.length ||
                        !predicted.policy.every(Number.isFinite)
                    )
                        throw new Error("Invalid neural teacher output");
                    scores = new Map(
                        observation.candidates.map((candidate, index) => [
                            candidate.signature,
                            predicted.policy[index],
                        ]),
                    );
                    statistics.inferred++;
                } finally {
                    restoreDeterministicRandomState(random);
                }
                const chosen = selectV09A19TeacherCorrection({
                    candidates: evidence.candidates,
                    means: evidence.means,
                    completed,
                    selected,
                    policy: evidence.candidates.map((candidate) =>
                        scores.get(v09CandidateSignature(candidate.actions))!,
                    ),
                    minimumLogitGain: options.minimumLogitGain,
                    actionFamily: options.actionFamily,
                });
                if (chosen === selected) return stock;
                statistics.corrected++;
                return structuredClone(evidence.candidates[chosen].actions);
            } finally {
                active = previous;
            }
        };
        return { value: run(), statistics };
    } finally {
        methodNames.forEach((name, index) => {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(prototype, name, descriptor);
            else Reflect.deleteProperty(prototype, name);
        });
    }
}
