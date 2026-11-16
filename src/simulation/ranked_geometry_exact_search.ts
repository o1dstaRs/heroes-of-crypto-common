export type Score = 0 | 0.5 | 1;
export interface BoundState {
    sums: [number, number];
    remaining: [number, number];
    baseline: [number, number];
    selected: number;
    selectedMean: number;
}

// Preserve the original selector's floating-point expression, including strict ties.
export function meanGain(sums: readonly number[], baseline: readonly number[]): number {
    return ((sums[0] - baseline[0]) / 3 + (sums[1] - baseline[1]) / 3) / 2;
}

export function mayStillWin(state: BoundState): boolean {
    const upper: [number, number] = [state.sums[0] + state.remaining[0], state.sums[1] + state.remaining[1]];
    if (upper[0] <= state.baseline[0] || upper[1] <= state.baseline[1]) return false;
    const gain = meanGain(upper, state.baseline);
    return gain >= 0.03 && (state.selected === 0 || gain > state.selectedMean);
}

/** A pure alternative scheduler. It never receives unrequested scores or actual evaluation outcomes. */
export function boundedSetupChoice(score: (plan: number, response: number, future: number) => Score) {
    const requests: { plan: number; response: number; future: number }[] = [];
    const proofs: { plan: number; reason: string; state?: BoundState }[] = [];
    const ask = (plan: number, response: number, future: number): Score => {
        requests.push({ plan, response, future });
        const result = score(plan, response, future);
        if (result !== 0 && result !== 0.5 && result !== 1) throw new Error("Invalid fight score");
        return result;
    };
    const baseline: [number, number] = [0, 0];
    for (const future of [0, 1]) {
        for (const response of [0, 1, 2]) baseline[future] += ask(0, response, future);
        if (baseline[future] === 3) {
            proofs.push({ plan: 0, reason: "A perfect incumbent future block cannot be strictly improved" });
            return { selected: 0, requests, proofs };
        }
    }
    let selected = 0;
    let selectedMean = 0;
    const futures = baseline[0] >= baseline[1] ? [0, 1] : [1, 0];
    for (let plan = 1; plan < 6; plan++) {
        const sums: [number, number] = [0, 0];
        const remaining: [number, number] = [3, 3];
        let pruned = false;
        for (const future of futures) {
            for (const response of [0, 1, 2]) {
                const state: BoundState = {
                    sums: [...sums],
                    remaining: [...remaining],
                    baseline: [...baseline],
                    selected,
                    selectedMean,
                };
                if (!mayStillWin(state)) {
                    proofs.push({ plan, reason: "Even all remaining wins cannot win the fixed selector", state });
                    pruned = true;
                    break;
                }
                sums[future] += ask(plan, response, future);
                remaining[future]--;
            }
            if (pruned) break;
        }
        if (pruned) continue;
        const gain = meanGain(sums, baseline);
        if (sums[0] > baseline[0] && sums[1] > baseline[1] && gain >= 0.03 && (selected === 0 || gain > selectedMean)) {
            selected = plan;
            selectedMean = gain;
        }
    }
    return { selected, requests, proofs };
}

export function boundedGeometryChoice(
    completeAppliedInputKeys: readonly string[],
    score: (plan: number, response: number, future: number) => Score,
) {
    if (completeAppliedInputKeys.length !== 6 || completeAppliedInputKeys.some((k) => !/^[0-9a-f]{64}$/.test(k))) {
        throw new Error("Six complete consumed-input SHA256 keys are required");
    }
    if (completeAppliedInputKeys.every((k) => k === completeAppliedInputKeys[0])) {
        return {
            selected: 0,
            appliedInputKey: completeAppliedInputKeys[0],
            equivalentAppliedStates: true,
            exactSelectorIndexClaimed: false,
            requests: [],
        };
    }
    const result = boundedSetupChoice(score);
    return {
        ...result,
        appliedInputKey: completeAppliedInputKeys[result.selected],
        equivalentAppliedStates: false,
        exactSelectorIndexClaimed: true,
    };
}
