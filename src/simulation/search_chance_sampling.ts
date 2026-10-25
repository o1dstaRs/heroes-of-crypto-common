/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the root directory of this source tree.
 */

import { hashSimulationParts, makeRng } from "./army";

export type SearchChanceBank = "antithetic" | "actor" | "actor-antithetic";
export interface ISearchChanceContext {
    getActiveUnitId(): string;
    fightProperties: { getCurrentLap(): number };
}
export interface ISearchChanceHashCache {
    readonly hashes: Map<string, number>;
}

/** The exact complement on mulberry32's [0, 1) uint32 grid, including its zero endpoint. */
export function complementSearchChance(value: number): number {
    return 1 - value - 2 ** -32;
}

/**
 * Actor/lap streams isolate another actor's extra random draws. Production complementary R2 uses indices
 * 0 and 1; offline diagnostics can also use the independent second pair at indices 2 and 3.
 * Antithetic pairs use two independent seed banks, each with an exact uint32-grid complement.
 * Only key hashes may be reused across branches; mutable generator states belong to THIS rollout.
 * An XOR seed permutation preserves an individual stream's seed distribution. It does not establish
 * cross-stream independence, unbiased battle estimates, or lower action-difference variance.
 */
export function makeSearchChanceStream(
    seed: number,
    rollout: number,
    bank: SearchChanceBank,
    context: ISearchChanceContext,
    cache: ISearchChanceHashCache,
): () => number {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new Error("Search chance seed must be a uint32");
    }
    if (!Number.isInteger(rollout) || rollout < 0 || rollout >= 4) {
        throw new Error("Search chance banks require rollout indices 0 through 3");
    }
    if (bank !== "antithetic" && bank !== "actor" && bank !== "actor-antithetic") {
        throw new Error("Unknown search chance bank");
    }
    const antithetic = bank !== "actor";
    const sample = antithetic ? Math.floor(rollout / 2) : rollout;
    const base = (seed + sample * 0x9e3779b1) >>> 0;
    const negate = antithetic && rollout % 2 === 1;
    if (bank === "antithetic") {
        const rng = makeRng(base);
        return negate ? () => complementSearchChance(rng()) : rng;
    }
    const streams = new Map<string, () => number>();
    let lastId: string | undefined;
    let lastLap: number | undefined;
    let lastStream: (() => number) | undefined;
    return () => {
        const id = context.getActiveUnitId();
        const lap = context.fightProperties.getCurrentLap();
        if (id !== lastId || lap !== lastLap || !lastStream) {
            const key = `${lap}:${id}`;
            let rng = streams.get(key);
            if (!rng) {
                let hash = cache.hashes.get(key);
                if (hash === undefined) {
                    hash = hashSimulationParts("a19-actor-chance-v1", lap, id);
                    cache.hashes.set(key, hash);
                }
                rng = makeRng((base ^ hash) >>> 0);
                streams.set(key, rng);
            }
            lastId = id;
            lastLap = lap;
            lastStream = rng;
        }
        const value = lastStream();
        return negate ? complementSearchChance(value) : value;
    };
}
