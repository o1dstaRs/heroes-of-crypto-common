/** Offline catalog experiment. No serving policy imports this module. */
export const MELEE_DELIVERY_DIVERSITY_RESEARCH_ID = "melee-delivery-diversity-v1";

export interface IMeleeDeliveryView {
    readonly targetId: string;
    readonly expectedDamage: number;
    readonly expectedKill: 0 | 1;
    readonly stationary: boolean;
    readonly x: number;
    readonly y: number;
}

/**
 * Spread equal-valued deliveries around each target before the existing engine search. Preserve the
 * original cap, target allocation, each slot's damage/kill/stationary class and the first delivery to
 * every target. Only otherwise interchangeable extra stands can change. This does not estimate tactical
 * value: counterattacks, auras, blocked allies and later turns remain the real engine search's job.
 *
 * Greedy farthest-point sampling uses squared anchor distance to already retained stands for that
 * target. Source order breaks ties. Objects/actions retain their identity, inputs are never mutated,
 * and no random source or battle state is consulted. Unsupported input returns the original catalog.
 */
export function diversifyMeleeDeliveries<T>(
    pool: readonly T[],
    kept: readonly T[],
    view: (value: T) => IMeleeDeliveryView,
): readonly T[] {
    if (kept.length < 2 || pool.length <= kept.length) return kept;
    const rows = pool.map((value) => ({ value, ...view(value) }));
    const byValue = new Map(rows.map((row) => [row.value, row]));
    if (
        byValue.size !== pool.length ||
        new Set(kept).size !== kept.length ||
        kept.some((value) => !byValue.has(value)) ||
        rows.some(
            (row) =>
                !row.targetId ||
                !Number.isFinite(row.expectedDamage) ||
                ![0, 1].includes(row.expectedKill) ||
                !Number.isSafeInteger(row.x) ||
                !Number.isSafeInteger(row.y),
        )
    )
        return kept;

    const leaders = new Map<string, T>();
    const selected = new Set<T>();
    const stands = new Map<string, IMeleeDeliveryView[]>();
    for (const value of kept) {
        const row = byValue.get(value)!;
        if (!leaders.has(row.targetId)) {
            leaders.set(row.targetId, value);
            selected.add(value);
            stands.set(row.targetId, [row]);
        }
    }
    const result = kept.map((value) => {
        const slot = byValue.get(value)!;
        if (leaders.get(slot.targetId) === value) return value;
        let best: (typeof rows)[number] | undefined;
        let distance = -1;
        for (const row of rows) {
            if (
                selected.has(row.value) ||
                row.targetId !== slot.targetId ||
                row.expectedDamage !== slot.expectedDamage ||
                row.expectedKill !== slot.expectedKill ||
                row.stationary !== slot.stationary
            )
                continue;
            const separation = Math.min(
                ...stands.get(slot.targetId)!.map((stand) => (row.x - stand.x) ** 2 + (row.y - stand.y) ** 2),
            );
            if (separation > distance) {
                best = row;
                distance = separation;
            }
        }
        // Keeping each slot's exact class guarantees an unselected member still exists.
        if (!best) throw new Error("Melee delivery class lost a retained slot");
        selected.add(best.value);
        stands.get(slot.targetId)!.push(best);
        return best.value;
    });
    return result.every((value, index) => value === kept[index]) ? kept : result;
}
