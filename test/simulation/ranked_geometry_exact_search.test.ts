import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import {
    boundedSetupChoice,
    boundedGeometryChoice,
    mayStillWin,
    meanGain,
    type Score,
} from "../../src/simulation/ranked_geometry_exact_search";

test("a pruned prefix cannot beat the incumbent under any discrete score completion", () => {
    let checks = 0;
    const bestScores = new Set<number>();
    for (let d0 = 1; d0 <= 6; d0++) for (let d1 = 1; d1 <= 6; d1++) bestScores.add((d0 / 6 + d1 / 6) / 2);
    for (let b0 = 0; b0 <= 6; b0++) {
        for (let b1 = 0; b1 <= 6; b1++) {
            const baseline: [number, number] = [b0 / 2, b1 / 2];
            const futures = b0 >= b1 ? [0, 1] : [1, 0];
            for (let encoded = 0; encoded < 729; encoded++) {
                let code = encoded;
                const outcome: number[] = [];
                for (let i = 0; i < 6; i++) {
                    outcome.push((code % 3) / 2);
                    code = Math.floor(code / 3);
                }
                const full: [number, number] = [0, 0];
                for (let i = 0; i < 6; i++) full[futures[Math.floor(i / 3)]] += outcome[i];
                const gain = meanGain(full, baseline);
                const accepted = full[0] > baseline[0] && full[1] > baseline[1] && gain >= 0.03;
                const sums: [number, number] = [0, 0];
                const remaining: [number, number] = [3, 3];
                for (let prefix = 0; prefix <= 6; prefix++) {
                    if (!mayStillWin({ sums, remaining, baseline, selected: 0, selectedMean: 0 })) assert(!accepted);
                    checks++;
                    for (const selectedMean of bestScores) {
                        if (!mayStillWin({ sums, remaining, baseline, selected: 1, selectedMean }))
                            assert(!accepted || gain <= selectedMean);
                        checks++;
                    }
                    if (prefix < 6) {
                        const future = futures[Math.floor(prefix / 3)];
                        sums[future] += outcome[prefix];
                        remaining[future]--;
                    }
                }
            }
        }
    }
    expect(checks).toBeGreaterThan(1_000_000);
    console.log(JSON.stringify({ exhaustivePrefixCompletionChecks: checks }));
});

test("whole selector preserves exact choices, strict ties and both-block gates", () => {
    let state = 0x51b7a93d;
    const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    for (let i = 0; i < 20_000; i++) {
        const scores = Array.from({ length: 6 }, () =>
            Array.from({ length: 3 }, () => [((random() % 3) / 2) as Score, ((random() % 3) / 2) as Score]),
        );
        if (i % 7 === 0) scores[5] = structuredClone(scores[2]);
        if (i % 11 === 0)
            scores[0] = [
                [1, 0.5],
                [1, 0],
                [1, 0.5],
            ];
        const full = chooseSearchPlan(scores);
        const bounded = boundedSetupChoice((p, r, f) => scores[p][r][f]);
        assert.equal(bounded.selected, full.selected, "The exact archived policy's choice must be preserved");
        assert(bounded.requests.length <= 36);
    }
});

test("invalid callback scores fail instead of supplying an optimistic bound", () => {
    expect(() => boundedSetupChoice(() => 0.75 as Score)).toThrow("Invalid fight score");
});

function chooseSearchPlan(scores: Score[][][]) {
    const gains = scores.map((plan) =>
        [0, 1].map((future) => plan.reduce((sum, response, i) => sum + response[future] - scores[0][i][future], 0) / 3),
    );
    const means = gains.map((g) => (g[0] + g[1]) / 2);
    let selected = 0;
    for (let plan = 1; plan < 6; plan++) {
        if (means[plan] >= 0.03 && gains[plan].every((g) => g > 0) && (selected === 0 || means[plan] > means[selected]))
            selected = plan;
    }
    return { selected };
}

test("identical complete inputs skip all fights without claiming the same internal plan", () => {
    const key = "a".repeat(64);
    const result = boundedGeometryChoice(Array(6).fill(key), () => {
        throw new Error("No score may be requested");
    });
    expect(result.selected).toBe(0);
    expect(result.appliedInputKey).toBe(key);
    expect(result.equivalentAppliedStates).toBe(true);
    expect(result.exactSelectorIndexClaimed).toBe(false);
    expect(result.requests).toEqual([]);
});

test("distinct complete inputs retain exact selection and strict earliest ties", () => {
    const keys = Array.from({ length: 6 }, (_, i) => String(i).repeat(64));
    const result = boundedGeometryChoice(keys, (plan) => (plan === 0 ? 0 : 1));
    expect(result.selected).toBe(1);
    expect(result.appliedInputKey).toBe(keys[1]);
    expect(result.exactSelectorIndexClaimed).toBe(true);
});

test("incomplete keys and scoring interruptions cannot produce a partial decision", () => {
    expect(() => boundedGeometryChoice(["partial"], () => 1)).toThrow();
    const keys = Array.from({ length: 6 }, (_, i) => String(i).repeat(64));
    expect(() =>
        boundedGeometryChoice(keys, () => {
            throw new Error("deadline");
        }),
    ).toThrow("deadline");
});
