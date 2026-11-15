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
import { makeRng, hashSimulationParts } from "./army";
import { snapshotBattle, restoreBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";
import { SearchDriver, type ISearchMatchInfo } from "./search_driver";

export const DRAGON_PRECISION_POLICY = Object.freeze({
    id: "dragon-precision-r8-030-v1",
    maximumComparisons: 4,
    maximumOverrides: 1,
    maximumChallengers: 6,
    margin: 0.03,
    rollouts: 4,
    blocks: 2,
    horizon: 64,
});

/** Strict ties, malformed values and a nonfinite incumbent all preserve the completed A19 decision. */
export function dragonPrecisionIndex(blocks: readonly (readonly number[])[]): number {
    if (blocks.length !== 2 || blocks[0].length !== blocks[1].length || !blocks.every((b) => Number.isFinite(b[0])))
        return 0;
    let best = 0,
        gain = 0;
    for (let i = 1; i < blocks[0].length; i++) {
        const deltas = blocks.map((b) => b[i] - b[0]);
        const mean = (deltas[0] + deltas[1]) / 2;
        if (deltas.every((d) => Number.isFinite(d) && d > 0) && mean >= DRAGON_PRECISION_POLICY.margin && mean > gain) {
            best = i;
            gain = mean;
        }
    }
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
export interface DragonPrecisionTrace {
    unitId: string;
    lap: number;
    seed: number;
    comparison: number;
    incumbent: GameAction[];
    candidates: { actions: GameAction[]; leaf: number | null }[];
    comparedIndices: number[];
    means: (number | null)[];
    blockMeans: (number | null)[][];
    probeSeeds: number[];
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
 * This scope neither expands nor prunes normal A19 search. Only a legal Dragon spell may replace its final decision; both probe blocks must improve.
 */
export function withDragonPrecisionResearch<T>(
    team: TeamType,
    run: (transform: FinalTransform) => T,
    observe: (trace: DragonPrecisionTrace) => void,
    observeOnly = false,
): T {
    if (active) throw new Error("Dragon precision research cannot be nested");
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
            comparisons >= DRAGON_PRECISION_POLICY.maximumComparisons ||
            overrides >= DRAGON_PRECISION_POLICY.maximumOverrides
        )
            return incumbent;
        if (!root || root.unit !== unit) throw new Error("Missing final A19 root capture");
        const driver = root.driver,
            deps = driver.deps;
        if (!driver.match.offlineDeterministicWork) throw new Error("Dragon precision is offline-only");
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
        let trace: DragonPrecisionTrace | undefined;
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
            const spells = catalog.filter((c) => {
                if (!["Lightning Strike", "Meteor Shower", "Ring of Fire", "Whirlpool"].includes(c.spellName ?? ""))
                    return false;
                const key = JSON.stringify(c.actions);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (!spells.length) return incumbent;
            if (JSON.stringify(catalog[0].actions) !== signature) throw new Error("Incumbent was not preserved");
            comparisons++;
            const candidates = [catalog[0], ...spells];
            const leaf = driver.scoreCandidates(unit, candidates, seed, "leaf", 1, null, 0, false);
            const selected: number[] = [];
            for (const [name, count] of [
                ["Lightning Strike", 1],
                ["Meteor Shower", 2],
                ["Ring of Fire", 1],
                ["Whirlpool", 2],
            ] as const) {
                const pressure = (i: number): number => {
                    const target = deps.unitsHolder.getAllUnits().get(candidates[i].targetId ?? "");
                    if (!target) return 0;
                    return target.getAmountAlive() * target.getAttackDamageMax() * (1 + target.getInitiative() / 100);
                };
                selected.push(
                    ...spells
                        .map((_, i) => i + 1)
                        .filter((i) => candidates[i].spellName === name && Number.isFinite(leaf[i]))
                        .sort((a, b) =>
                            name === "Whirlpool" ? pressure(b) - pressure(a) || a - b : leaf[b] - leaf[a] || a - b,
                        )
                        .slice(0, count),
                );
            }
            const indices = [0, ...selected];
            const probeSeeds = [0, 1].map((block) => hashSimulationParts(DRAGON_PRECISION_POLICY.id, seed, block));
            const blocks = probeSeeds.map((probeSeed) =>
                driver.scoreCandidates(
                    unit,
                    indices.map((i) => candidates[i]),
                    probeSeed,
                    "turns",
                    DRAGON_PRECISION_POLICY.rollouts,
                    null,
                    DRAGON_PRECISION_POLICY.horizon,
                    false,
                ),
            );
            const means = indices.map((_, i) => (blocks[0][i] + blocks[1][i]) / 2);
            const preferredIndex = dragonPrecisionIndex(blocks),
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
                probeSeeds,
                blockMeans: blocks.map((b) => b.map((x) => (Number.isFinite(x) ? x : null))),
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
            if (errors.length) throw new AggregateError(errors, "Dragon precision rollback failed");
        }
        if (!trace) return incumbent;
        if (trace.appliedIndex > 0) {
            if (preflight(trace.appliedDecision).failure !== null)
                throw new Error("Dragon precision failed authoritative preflight");
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
