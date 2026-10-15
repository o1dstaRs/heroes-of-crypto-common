import { describe, expect, it } from "bun:test";

import { selectV08A19ScoredCandidateIndex } from "../../src/ai/versions/v0_8_a19_scored_arbitration";
import { selectV08A19MaterialCandidateIndex } from "../../src/ai/versions/v0_8_a19_material_arbitration";
import { makeRng } from "../../src/simulation/army";
import { remainingRolloutsCannotWin, SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import type { Unit } from "../../src/units/unit";
import { SearchSelectionBounds, type ISearchSelectionBoundPlan } from "../../src/simulation/search_selection_bounds";

describe("selection-aware rollout bounds", () => {
    it("separates forced-finish productive fallback from a passive incumbent without ordinary repair", () => {
        const driver = withSearchEnvironment(
            { V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8", SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1" },
            () => new SearchDriver({} as ILookaheadDeps, { offlineDeterministicWork: true }),
        );
        const candidates = [
            { kind: "incumbent", actions: [{ type: "wait_turn", unitId: "actor" }], features: { expectedDamage: 0 } },
            { kind: "spell", actions: [], features: { expectedDamage: 0 } },
        ] as unknown as readonly IEnumeratedCandidate[];
        const research = driver as unknown as {
            certifiedSelectionBoundPlan: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                version: string,
                ...flags: boolean[]
            ) => ISearchSelectionBoundPlan | false;
        };
        const plan = research.certifiedSelectionBoundPlan(
            {} as Unit,
            candidates,
            "v0.8",
            false,
            true,
            false,
            false,
            false,
        );
        expect(plan).not.toBe(false);
        if (!plan) throw new Error("Missing offline research plan");
        const bounds = new SearchSelectionBounds(plan);
        bounds.recordFinished(0, 1);
        expect(bounds.referenceMean(1)).toBe(-Infinity);
    });
    it("never uses a different selection pool to eliminate an action", () => {
        const bounds = new SearchSelectionBounds({
            pools: [0, 1, 1],
            directCombat: [false, false, false],
            protectedIndices: new Set(),
            preferredIndices: new Set(),
        });
        bounds.recordFinished(0, 1);
        expect(bounds.referenceMean(1)).toBe(-Infinity);
        bounds.recordFinished(1, 0.5);
        expect(bounds.referenceMean(2)).toBe(0.5);
        expect(bounds.referenceMean(0)).toBe(-Infinity);
    });

    it("keeps fallback combat exact until its preferred action is completely and legally scored", () => {
        const bounds = new SearchSelectionBounds({
            pools: [0, 0, 0, 0],
            directCombat: [false, true, true, false],
            protectedIndices: new Set([0]),
            preferredIndices: new Set([2]),
        });
        bounds.recordFinished(0, 1);
        expect(bounds.referenceMean(1)).toBe(-Infinity);
        expect(bounds.referenceMean(3)).toBe(1);
        bounds.recordFinished(2, -Infinity);
        expect(bounds.referenceMean(1)).toBe(-Infinity);
        bounds.recordFinished(2, 0);
        expect(bounds.referenceMean(1)).toBe(1);
        expect(bounds.referenceMean(2)).toBe(-Infinity);
    });

    it("rejects malformed plans and ignores unbounded completion evidence", () => {
        const plan: ISearchSelectionBoundPlan = {
            pools: [0, 0],
            directCombat: [false, false],
            protectedIndices: new Set(),
            preferredIndices: new Set(),
        };
        expect(() => new SearchSelectionBounds({ ...plan, pools: [0] })).toThrow();
        expect(() => new SearchSelectionBounds({ ...plan, pools: [0, 8] })).toThrow();
        expect(() => new SearchSelectionBounds({ ...plan, protectedIndices: new Set([2]) })).toThrow();
        const bounds = new SearchSelectionBounds(plan);
        for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1]) bounds.recordFinished(0, value);
        expect(bounds.referenceMean(1)).toBe(-Infinity);
    });

    it("preserves every pool winner, protected score, gate and scored arbitration across 20,000 stochastic matrices", () => {
        const rng = makeRng(0xa1900819);
        let saved = 0;
        for (let trial = 0; trial < 20_000; trial += 1) {
            const count = 2 + Math.floor(rng() * 7);
            const rollouts = 2 + Math.floor(rng() * 5);
            const pools = Array.from({ length: count }, () => Math.floor(rng() * 8));
            const directCombat = Array.from({ length: count }, () => rng() < 0.7);
            const preferredIndices = new Set<number>(rng() < 0.5 ? [Math.floor(rng() * count)] : []);
            const protectedIndices = new Set([0, Math.floor(rng() * count), ...preferredIndices]);
            const samples = Array.from({ length: count }, () =>
                Array.from({ length: rollouts }, () => (rng() < 0.02 ? -Infinity : Math.floor(rng() * 5) / 4)),
            );
            const full = samples.map((row) =>
                row.includes(-Infinity) ? -Infinity : row.reduce((a, b) => a + b, 0) / rollouts,
            );
            const bounds = new SearchSelectionBounds({ pools, directCombat, preferredIndices, protectedIndices });
            const complete: boolean[] = [];
            const bounded = samples.map((row, index) => {
                const reference = bounds.referenceMean(index);
                let sum = 0;
                let completed = 0;
                for (const value of row) {
                    if (value === -Infinity) return -Infinity;
                    sum += value;
                    completed += 1;
                    if (remainingRolloutsCannotWin(sum, completed, rollouts, reference, 0.03)) break;
                }
                if (completed === rollouts) bounds.recordFinished(index, sum / rollouts);
                complete[index] = completed === rollouts;
                saved += rollouts - completed;
                return sum / rollouts;
            });
            const winner = (means: readonly number[], indices: readonly number[]) => {
                let best = indices[0];
                for (const index of indices) if (means[index] > means[best]) best = index;
                return best;
            };
            const selections = [...protectedIndices];
            for (const pool of new Set(pools)) {
                const members = pools.flatMap((value, index) => (value === pool ? [index] : []));
                const selected = winner(full, members);
                expect(winner(bounded, members)).toBe(selected);
                selections.push(selected);
            }
            for (const index of protectedIndices) expect(bounded[index]).toBe(full[index]);
            const candidates = samples.map((_row, index) => ({
                actions: [{ type: "defend_turn" as const, unitId: String(index) }],
            }));
            const material = samples.map(() => rng());
            const boundedMaterial = material.map((value, index) => (complete[index] ? value : -Infinity));
            for (const index of selections) {
                const gated = full[index] - full[0] >= 0.03 ? index : 0;
                expect(bounded[index] - bounded[0] >= 0.03 ? index : 0).toBe(gated);
                const selected = selectV08A19ScoredCandidateIndex(candidates, full, gated, []);
                expect(selectV08A19ScoredCandidateIndex(candidates, bounded, gated, [])).toBe(selected);
                expect(
                    selectV08A19MaterialCandidateIndex(
                        candidates,
                        bounded,
                        boundedMaterial,
                        selected,
                        rollouts,
                        "ties",
                    ),
                ).toBe(selectV08A19MaterialCandidateIndex(candidates, full, material, selected, rollouts, "ties"));
            }
        }
        expect(saved).toBeGreaterThan(1000);
    });
});
