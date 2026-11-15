/** Offline experiment only. Normal A19 search completes before this optional final-action comparison. */
import type { IDecisionContext } from "../ai";
import { enumerateCandidates, type IEnumeratedCandidate, type IEnumerateOptions } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../utils/lib";
import { makeRng } from "./army";
import { snapshotBattle, restoreBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";
import { SearchDriver, type ISearchMatchInfo } from "./search_driver";

export const PROTECTED_METEOR_POLICY = Object.freeze({
    id: "protected-meteor-030-v1",
    maximumComparisons: 4,
    maximumOverrides: 1,
    maximumChallengers: 3,
    margin: 0.03,
    rollouts: 2,
    horizon: 64,
});

/** Strict ties, malformed values and a nonfinite incumbent all preserve the completed A19 decision. */
export function protectedMeteorIndex(means: readonly number[]): number {
    if (!Number.isFinite(means[0])) return 0;
    let best = 0;
    for (let i = 1; i < means.length; i++)
        if (
            Number.isFinite(means[i]) &&
            means[i] > means[best] &&
            means[i] - means[0] >= PROTECTED_METEOR_POLICY.margin
        )
            best = i;
    return best;
}

interface ProbeDriver {
    deps: ILookaheadDeps;
    match: ISearchMatchInfo;
    caps: IEnumerateOptions;
    counters: Record<string, unknown>;
    finishedSim: boolean;
    finishedWinningTeam: TeamType | null;
    rolloutEnemyTeam: TeamType | null;
    a19MaterialEvidence: unknown;
    simSeed(unit: Unit): number;
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: "leaf" | "turns",
        rollouts: number,
        deadline: null,
        horizon: number,
        bound: false,
    ): number[];
}
export interface ProtectedMeteorTrace {
    unitId: string;
    lap: number;
    seed: number;
    comparison: number;
    incumbent: GameAction[];
    candidates: { actions: GameAction[]; leaf: number | null }[];
    comparedIndices: number[];
    means: (number | null)[];
    preferredIndex: number;
    appliedIndex: number;
    appliedDecision: GameAction[];
    observeOnly: boolean;
}
type FinalTransform = (
    unit: Unit,
    context: IDecisionContext,
    finalA19: GameAction[],
    preflight: (actions: GameAction[]) => { failure: unknown },
    version: string,
) => GameAction[];
let active = false;

/**
 * The caller must wire transform AFTER the neural tie correction, immediately before authoritative commit.
 * This scope neither expands nor prunes normal A19 search. Only a Meteor may replace its final decision.
 */
export function withProtectedMeteorResearch<T>(
    team: TeamType,
    run: (transform: FinalTransform) => T,
    observe: (trace: ProtectedMeteorTrace) => void,
    observeOnly = false,
): T {
    if (active) throw new Error("Protected Meteor research cannot be nested");
    if (team !== PBTypes.TeamVals.LEFT && team !== PBTypes.TeamVals.RIGHT) throw new Error("Expected physical team");
    const original = SearchDriver.prototype.chooseDecision;
    let captured: { driver: ProbeDriver; unit: Unit } | undefined;
    let comparisons = 0,
        overrides = 0;
    active = true;
    SearchDriver.prototype.chooseDecision = function (unit, version, incumbent, context) {
        const result = original.call(this, unit, version, incumbent, context);
        captured =
            unit.getTeam() === team && unit.getName() === "Magic Dragon" && version === "v0.8"
                ? { driver: this as unknown as ProbeDriver, unit }
                : undefined;
        return result;
    };
    const transform: FinalTransform = (unit, context, incumbent, preflight, version) => {
        const root = captured;
        captured = undefined;
        if (version !== "v0.8" || unit.getTeam() !== team || unit.getName() !== "Magic Dragon") return incumbent;
        if (
            comparisons >= PROTECTED_METEOR_POLICY.maximumComparisons ||
            overrides >= PROTECTED_METEOR_POLICY.maximumOverrides
        )
            return incumbent;
        if (!root || root.unit !== unit) throw new Error("Missing final A19 root capture");
        const driver = root.driver,
            deps = driver.deps;
        if (!driver.match.offlineDeterministicWork) throw new Error("Protected Meteor is offline-only");
        const random = captureDeterministicRandomState(),
            activeId = deps.getActiveUnitId();
        const state = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
        const stats = deps.captureDamageStats(),
            restoreAux = deps.captureAuxiliaryState?.();
        const privateState = {
            finishedSim: driver.finishedSim,
            finishedWinningTeam: driver.finishedWinningTeam,
            rolloutEnemyTeam: driver.rolloutEnemyTeam,
            a19MaterialEvidence: driver.a19MaterialEvidence,
            counters: structuredClone(driver.counters),
        };
        let trace: ProtectedMeteorTrace | undefined;
        try {
            const seed = driver.simSeed(unit);
            setDeterministicRandomSource(makeRng(seed));
            // A fresh path catalog is built by enumeration. Never reuse the consumed root catalog.
            const catalog = enumerateCandidates(
                unit,
                { ...context, matrix: deps.grid.getMatrix(), decisionPathCatalog: undefined },
                incumbent,
                {
                    ...driver.caps,
                    researchMagicDragonMeteorCoverage: true,
                    enrichIncumbentMetadata: true,
                },
            ).candidates;
            const signature = JSON.stringify(incumbent),
                seen = new Set([signature]);
            const meteors = catalog.filter((c) => {
                if (c.spellName !== "Meteor Shower") return false;
                const key = JSON.stringify(c.actions);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (!meteors.length) return incumbent;
            if (JSON.stringify(catalog[0].actions) !== signature) throw new Error("Incumbent was not preserved");
            comparisons++;
            const candidates = [catalog[0], ...meteors];
            const leaf = driver.scoreCandidates(unit, candidates, seed, "leaf", 1, null, 0, false);
            const selected = meteors
                .map((_, i) => i + 1)
                .filter((i) => Number.isFinite(leaf[i]))
                .sort((a, b) => leaf[b] - leaf[a] || a - b)
                .slice(0, PROTECTED_METEOR_POLICY.maximumChallengers);
            const indices = [0, ...selected];
            const means = driver.scoreCandidates(
                unit,
                indices.map((i) => candidates[i]),
                seed,
                "turns",
                PROTECTED_METEOR_POLICY.rollouts,
                null,
                PROTECTED_METEOR_POLICY.horizon,
                false,
            );
            const preferredIndex = protectedMeteorIndex(means),
                appliedIndex = observeOnly ? 0 : preferredIndex;
            trace = {
                unitId: unit.getId(),
                lap: deps.fightProperties.getCurrentLap(),
                seed,
                comparison: comparisons,
                incumbent: structuredClone(incumbent),
                candidates: candidates.map((c, i) => ({
                    actions: structuredClone(c.actions),
                    leaf: Number.isFinite(leaf[i]) ? leaf[i] : null,
                })),
                comparedIndices: indices,
                means: means.map((x) => (Number.isFinite(x) ? x : null)),
                preferredIndex,
                appliedIndex,
                appliedDecision: structuredClone(candidates[indices[appliedIndex]].actions),
                observeOnly,
            };
        } finally {
            // Restore even when enumeration/scoring throws. No probe may advance real RNG/UUIDs or engine state.
            const errors: unknown[] = [];
            for (const restore of [
                () => restoreBattle(state, deps.unitsHolder, deps.grid, deps.fightProperties),
                () => deps.restoreDamageStats(stats),
                () => restoreAux?.(),
                () => restoreDeterministicRandomState(random),
                () => deps.setActiveUnitId(activeId),
                () => Object.assign(driver, privateState),
            ]) {
                try {
                    restore();
                } catch (e) {
                    errors.push(e);
                }
            }
            if (errors.length) throw new AggregateError(errors, "Protected Meteor rollback failed");
        }
        if (!trace) return incumbent;
        if (trace.appliedIndex > 0) {
            if (preflight(trace.appliedDecision).failure !== null)
                throw new Error("Protected Meteor failed authoritative preflight");
            overrides++;
        }
        observe(trace);
        return trace.appliedIndex > 0 ? trace.appliedDecision : incumbent;
    };
    try {
        const result = run(transform);
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Synchronous research callback required");
        return result;
    } finally {
        SearchDriver.prototype.chooseDecision = original;
        active = false;
    }
}
