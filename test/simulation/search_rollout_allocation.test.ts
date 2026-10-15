import { describe, expect, it } from "bun:test";

import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import type { Unit } from "../../src/units/unit";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import {
    parseSearchRolloutAllocation,
    selectSearchRolloutSurvivors,
} from "../../src/simulation/search_rollout_allocation";

const candidates = Array.from({ length: 6 }, (_, index) => ({
    kind: "defend",
    actions: [{ type: "defend_turn", unitId: String(index) }],
})) as IEnumeratedCandidate[];
const unit = { getId: () => "actor" } as Unit;
type Sample = { score: number; material: number };
type Probe = {
    captureA19Material: boolean;
    a19MaterialEvidence?: {
        candidates: readonly IEnumeratedCandidate[];
        means: number[];
        materials: number[];
        rolloutCount: number;
    };
    scoreCandidates: (
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        rolls: number,
        deadline: number | null,
        horizon: number,
        bounds: unknown,
        cache?: Map<IEnumeratedCandidate, Map<number, Sample>>,
    ) => number[];
    scoreSearchCandidates: (
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        rolls: number,
        deadline: number | null,
        horizon: number,
        bounds: boolean,
        version: string,
    ) => number[];
};

function fixture(mode: string, offline = true) {
    const driver = withSearchEnvironment(
        {
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_A19_MATERIAL_ARBITRATION: "ties",
            SEARCH_A19_ROLLOUT_ALLOCATION: mode,
        },
        () => new SearchDriver({} as ILookaheadDeps, { offlineDeterministicWork: offline }),
    );
    const probe = driver as unknown as Probe;
    probe.captureA19Material = true;
    let realSamples = 0;
    const calls: { rolls: number; cache: unknown; bounds: unknown }[] = [];
    const values = [
        [0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1],
        [0.5, 0.5, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1],
    ];
    const materials = [
        [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
        [0.99, 0.99, 0.2, 0.2, 0.2, 0.2],
        [0.9, 0.9, 0.3, 0.3, 0.3, 0.3],
        [0.1, 0.1, 0.8, 0.8, 0.8, 0.8],
        [1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1],
    ];
    probe.scoreCandidates = (_unit, selected, _seed, _mode, rolls, _deadline, _horizon, bounds, cache) => {
        calls.push({ rolls, cache, bounds });
        const means: number[] = [],
            mats: number[] = [];
        for (const candidate of selected) {
            const index = candidates.indexOf(candidate);
            let row = cache?.get(candidate);
            if (cache && !row) cache.set(candidate, (row = new Map()));
            let sum = 0,
                mat = 0;
            for (let r = 0; r < rolls; r++) {
                let sample = row?.get(r);
                if (!sample) {
                    realSamples++;
                    sample = { score: values[index][r], material: materials[index][r] };
                    row?.set(r, sample);
                }
                sum += sample.score;
                mat += sample.material;
            }
            means.push(sum / rolls);
            mats.push(mat / rolls);
        }
        probe.a19MaterialEvidence = { candidates: selected, means, materials: mats, rolloutCount: rolls };
        return means;
    };
    return { probe, calls, samples: () => realSamples };
}

describe("offline root rollout allocation", () => {
    it("validates the explicit switch and preserves the incumbent even when it ranks last", () => {
        expect(parseSearchRolloutAllocation(undefined)).toBe("uniform");
        expect(parseSearchRolloutAllocation("halving")).toBe("halving");
        expect(parseSearchRolloutAllocation("validation")).toBe("validation");
        expect(() => parseSearchRolloutAllocation("halve")).toThrow("SEARCH_A19_ROLLOUT_ALLOCATION");
        expect(selectSearchRolloutSurvivors([0, 1, 1, 1, 1, 1], [1, 0.1, 0.2, 0.9, 0.8, 0.3])).toEqual([0, 3, 4]);
        expect(selectSearchRolloutSurvivors([-Infinity, 1, -Infinity, 0.5, NaN, 1])).toEqual([0, 1, 5]);
        expect(() => selectSearchRolloutSurvivors([0, 1])).toThrow();
    });

    it("caps the requested simulation work for even and odd candidate counts", () => {
        for (let n = 6; n <= 128; n++) {
            const survivors = selectSearchRolloutSurvivors(Array.from({ length: n }, (_, i) => i % 3));
            expect(survivors[0]).toBe(0);
            expect(2 * n + 4 * survivors.length).toBeLessThanOrEqual(4 * n);
            expect(new Set(survivors).size).toBe(survivors.length);
        }
    });

    it("reuses pilot samples and returns six-sample evidence in original candidate order", () => {
        const { probe, calls, samples } = fixture("halving");
        const means = probe.scoreSearchCandidates(unit, candidates, 7, "turns", 4, null, 64, true, "v0.8");
        expect(means).toEqual([0, 1 / 3, 1, -Infinity, -Infinity, -Infinity]);
        expect(calls.map((call) => call.rolls)).toEqual([2, 6]);
        expect(calls[0].cache).toBe(calls[1].cache);
        expect(calls.every((call) => call.bounds === false)).toBe(true);
        expect(samples()).toBe(24);
        expect(probe.a19MaterialEvidence?.candidates).toBe(candidates);
        expect(probe.a19MaterialEvidence?.rolloutCount).toBe(6);
        expect(probe.a19MaterialEvidence?.materials[1]).toBeCloseTo((0.99 * 2 + 0.2 * 4) / 6);
    });

    it("keeps lucky pilot outcomes out of validation means and material evidence", () => {
        const { probe, samples } = fixture("validation");
        expect(probe.scoreSearchCandidates(unit, candidates, 7, "turns", 4, null, 64, true, "v0.8")).toEqual([
            0,
            0,
            1,
            -Infinity,
            -Infinity,
            -Infinity,
        ]);
        expect(probe.a19MaterialEvidence?.materials).toEqual([0.1, 0.2, 0.3, -Infinity, -Infinity, -Infinity]);
        expect(probe.a19MaterialEvidence?.rolloutCount).toBe(4);
        expect(samples()).toBe(24);
    });

    it("keeps live decisions, historical versions and full-score observers on uniform work", () => {
        for (const [mode, offline, version, observer] of [
            ["uniform", true, "v0.8", false],
            ["halving", false, "v0.8", false],
            ["halving", true, "v0.7", false],
            ["halving", true, "v0.8", true],
        ] as const) {
            const { probe, calls } = fixture(mode, offline);
            if (observer)
                (probe as unknown as { scoredDecisionObserver: () => void }).scoredDecisionObserver = () => {};
            probe.scoreSearchCandidates(unit, candidates, 7, "turns", 4, null, 64, true, version);
            expect(calls).toHaveLength(1);
            expect(calls[0].rolls).toBe(4);
            expect(calls[0].cache).toBeUndefined();
            expect(calls[0].bounds).toBe(true);
        }
    });
});
