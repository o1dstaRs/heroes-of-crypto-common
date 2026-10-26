/** Research-only integer antithetics. Importing this module does not install a random source. */
import { hashSimulationParts, makeRng } from "./army";
import type { ISearchChanceContext, ISearchChanceHashCache } from "./search_chance_sampling";

const TWO53 = 1n << 53n;

/**
 * Equal-size quantile buckets on an exactly uniform accepted 53-bit grid. A rejected raw value must be
 * redrawn in BOTH members of the pair. For the same range and aligned draws the outputs sum to span-1.
 * This is a marginal-distribution property, not a guarantee about battle or action-difference variance.
 */
export function discreteAntitheticQuantile(raw: bigint, span: bigint, complement: boolean): bigint | undefined {
    if (raw < 0n || raw >= TWO53 || span < 1n || span > TWO53) throw new Error("Invalid discrete chance grid");
    const bucketSize = TWO53 / span;
    const limit = bucketSize * span;
    if (raw >= limit) return undefined;
    return (complement ? limit - 1n - raw : raw) / bucketSize;
}

/**
 * H64/R2 research tape. It retains the current actor/lap seed and consumes two uint32 draws per 53-bit
 * trial. Only the integer mapping and location of the complement differ from raw-complement R2.
 * A private research-export getRandomInt seam must call integer(); this is not a serving registration.
 */
export function makeA19DiscreteChanceTape(
    seed: number,
    rollout: number,
    context: ISearchChanceContext,
    cache: ISearchChanceHashCache,
): { integer(min: number, max: number): number } {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Expected a uint32 seed");
    if (rollout !== 0 && rollout !== 1) throw new Error("Discrete chance research requires R2");
    const streams = new Map<string, () => number>();
    let lastId: string | undefined;
    let lastLap: number | undefined;
    let lastStream: (() => number) | undefined;
    return {
        integer(min, max) {
            if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min)
                throw new Error("Expected an ordered safe-integer range");
            const span = BigInt(max) - BigInt(min);
            if (span > TWO53) throw new Error("Range exceeds the 53-bit grid");
            if (span <= 1n) return min;
            const id = context.getActiveUnitId();
            const lap = context.fightProperties.getCurrentLap();
            if (id !== lastId || lap !== lastLap || !lastStream) {
                const key = `${lap}:${id}`;
                let stream = streams.get(key);
                if (!stream) {
                    let hash = cache.hashes.get(key);
                    if (hash === undefined) {
                        // Keep the production R2 key and seed; do not add an unrelated seed-bank change.
                        hash = hashSimulationParts("a19-actor-chance-v1", lap, id);
                        cache.hashes.set(key, hash);
                    }
                    stream = makeRng((seed ^ hash) >>> 0);
                    streams.set(key, stream);
                }
                lastId = id;
                lastLap = lap;
                lastStream = stream;
            }
            for (;;) {
                const high = BigInt(Math.floor(lastStream() * 0x200000));
                const low = BigInt(Math.floor(lastStream() * 0x100000000));
                const value = discreteAntitheticQuantile((high << 32n) | low, span, rollout === 1);
                if (value !== undefined) return Number(value + BigInt(min));
            }
        },
    };
}
