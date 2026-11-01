/** Offline recorder scoped to one real-engine game; no hook is installed by importing this module. */
import type { IDecisionContext } from "../../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../../ai/candidates";
import type { GameAction } from "../../engine/actions";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import { V08_A19_MATERIAL_ARBITRATION_POLICY } from "../../ai/versions/v0_8_a19_material_arbitration";
import { hashSimulationParts } from "../army";
import { v09CandidateSignature } from "../../ai/versions/v0_9";
import { SearchDriver } from "../search_driver";
import { encodeV09A19Observation, type IV09A19Observation } from "./a19_observation";

interface IRolloutSample {
    index: number;
    value: number;
    terminal: boolean;
    material: number;
}
export interface IV09A19TrainingDecision {
    ordinal: number;
    lap: number;
    observation: IV09A19Observation;
    selectedIndex: number;
    /** Actual registered independent rollout samples. Missing/illegal actions remain null. */
    samples: (IRolloutSample[] | null)[];
    teacherMeans: (number | null)[];
    teacherStandardErrors: (number | null)[];
    teacherMaterialMeans: (number | null)[];
    seedBase: number;
    team: number;
    outcome?: 0 | 0.5 | 1;
}

interface IRecordingDriver {
    horizon: number;
    rollouts: number;
    finishedSim: boolean;
    finishedWinningTeam: number | null;
    deps: { unitsHolder: UnitsHolder };
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        count?: number,
        deadline?: number | null,
        turns?: number,
        ...rest: unknown[]
    ): number[];
    rollout(
        unit: Unit,
        candidate: IEnumeratedCandidate,
        seed: number,
        index: number,
        mode: string,
        ...rest: unknown[]
    ): number;
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        ...rest: unknown[]
    ): readonly IEnumeratedCandidate[];
}
interface IScoreBank {
    candidates: readonly IEnumeratedCandidate[];
    samples: Map<string, IRolloutSample[]>;
    means: number[];
    seed: number;
}

/** Record a seeded quarter of candidate-seat decisions; selection never inspects a score or game outcome. */
export function withV09A19Recording<T>(team: number, gameSeed: number, run: () => T, sampleEvery = 4) {
    if (!Number.isSafeInteger(sampleEvery) || sampleEvery < 1) throw new Error("Invalid observation sampling interval");
    const prototype = SearchDriver.prototype as unknown as IRecordingDriver;
    const choose = prototype.chooseDecision,
        score = prototype.scoreCandidates,
        rollout = prototype.rollout;
    const shortlist = prototype.shortlistCandidates;
    const decisions: IV09A19TrainingDecision[] = [];
    let ordinal = 0;
    let skipped = 0;
    let active:
        { driver: IRecordingDriver; banks: IScoreBank[]; catalog: Map<string, IEnumeratedCandidate> } | undefined;
    let bank: IScoreBank | undefined;
    prototype.shortlistCandidates = function (...args) {
        if (active?.driver === this)
            for (const candidate of args[1]) active.catalog.set(v09CandidateSignature(candidate.actions), candidate);
        return shortlist.apply(this, args);
    };
    prototype.rollout = function (...args) {
        const value = rollout.apply(this, args);
        if (active?.driver === this && bank && args[4] === "turns") {
            const key = v09CandidateSignature(args[1].actions);
            const entries = bank.samples.get(key) ?? [];
            let ours = 0,
                enemy = 0;
            for (const remaining of this.deps.unitsHolder.getAllUnits().values()) {
                if (remaining.isDead()) continue;
                const strength = (remaining.getExp() * remaining.getCumulativeHp()) / Math.max(1, remaining.getMaxHp());
                if (remaining.getTeam() === args[0].getTeam()) ours += strength;
                else enemy += strength;
            }
            const material =
                0.5 * (1 + (ours - enemy) / (ours + enemy + V08_A19_MATERIAL_ARBITRATION_POLICY.materialSmoothing));
            entries.push({
                index: args[3],
                value,
                terminal: this.finishedSim && this.finishedWinningTeam !== null,
                material,
            });
            bank.samples.set(key, entries);
        }
        return value;
    };
    prototype.scoreCandidates = function (...args) {
        if (
            active?.driver !== this ||
            args[3] !== "turns" ||
            (args[4] ?? this.rollouts) !== this.rollouts ||
            (args[6] ?? this.horizon) !== this.horizon
        )
            return score.apply(this, args);
        const previous = bank;
        const captured: IScoreBank = { candidates: [...args[1]], samples: new Map(), means: [], seed: args[2] };
        bank = captured;
        try {
            captured.means = score.apply(this, args);
            active.banks.push(captured);
            return captured.means;
        } finally {
            bank = previous;
        }
    };
    prototype.chooseDecision = function (...args) {
        const [unit, , , context] = args;
        if (unit.getTeam() !== team) return choose.apply(this, args);
        const current = ordinal++;
        if (hashSimulationParts("v09-a19-observation-sample-v1", gameSeed, current) % sampleEvery !== 0)
            return choose.apply(this, args);
        if (!context) throw new Error("Recorded A19 decision lacks its public context");
        const previous = active;
        const frame = { driver: this, banks: [] as IScoreBank[], catalog: new Map<string, IEnumeratedCandidate>() };
        active = frame;
        try {
            const selected = choose.apply(this, args);
            const signature = v09CandidateSignature(selected);
            const captured = [...frame.banks]
                .reverse()
                .find((entry) =>
                    entry.candidates.some((candidate) => v09CandidateSignature(candidate.actions) === signature),
                );
            if (!captured || captured.candidates.length < 2) {
                skipped++;
                return selected;
            }
            // The proposal sees the full pre-shortlist catalog at training and inference. Only genuinely
            // scored actions have numeric targets; discarded actions are not fabricated losing examples.
            const anchor = captured.candidates[0];
            const catalog = new Map([[v09CandidateSignature(anchor.actions), anchor], ...frame.catalog]);
            for (const candidate of captured.candidates)
                catalog.set(v09CandidateSignature(candidate.actions), candidate);
            const observation = encodeV09A19Observation(unit, context, [...catalog.values()]);
            const samples = observation.candidates.map((candidate) => {
                const values = captured.samples.get(candidate.signature);
                return values?.length === this.rollouts && values.every((sample) => Number.isFinite(sample.value))
                    ? values
                    : null;
            });
            const means = samples.map((values) =>
                values ? values.reduce((sum, sample) => sum + sample.value, 0) / values.length : null,
            );
            const selectedIndex = observation.candidates.findIndex((candidate) => candidate.signature === signature);
            if (
                selectedIndex < 0 ||
                samples[0] === null ||
                samples[selectedIndex] === null ||
                samples.filter(Boolean).length < 2
            ) {
                skipped++;
                return selected;
            }
            decisions.push({
                ordinal: current,
                lap: context.fightProperties!.getCurrentLap(),
                observation,
                selectedIndex,
                samples,
                teacherMeans: means,
                teacherMaterialMeans: samples.map((values) =>
                    values ? values.reduce((sum, sample) => sum + sample.material, 0) / values.length : null,
                ),
                teacherStandardErrors: samples.map((values, index) =>
                    values && values.length > 1
                        ? Math.sqrt(
                              values.reduce((sum, sample) => sum + (sample.value - means[index]!) ** 2, 0) /
                                  (values.length - 1) /
                                  values.length,
                          )
                        : null,
                ),
                seedBase: captured.seed,
                team,
            });
            return selected;
        } finally {
            active = previous;
        }
    };
    try {
        return { value: run(), decisions, sampledWithoutCompleteEvidence: skipped };
    } finally {
        prototype.chooseDecision = choose;
        prototype.scoreCandidates = score;
        prototype.rollout = rollout;
        prototype.shortlistCandidates = shortlist;
    }
}
