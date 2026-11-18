import { expect, test } from "bun:test";
import { a19RevealedRangedDraftPool } from "../../src/ai/setup/a19_revealed_ranged_draft";
import { lockedRevealedRangedDeliveryCheckpoints } from "../../src/simulation/revealed_ranged_delivery_checkpoint";

test("locks both separate positive estimates, all losses and the failed combination", () => {
    const checkpoint = lockedRevealedRangedDeliveryCheckpoints();
    const rows = checkpoint.result.verifiedResults.rows;
    const total = (arm: keyof (typeof rows)[number]["scores"]) => rows.reduce((sum, row) => sum + row.scores[arm], 0);
    expect([total("native"), total("draft"), total("setup"), total("combined"), total("free")]).toEqual([
        23, 27, 28, 22, 22,
    ]);
    expect(new Set(rows.map((row) => row.task.id)).size).toBe(27);
    expect(checkpoint.draftOnly.evidence.differencePp).toBeCloseTo(((27 - 23) / 54) * 100, 10);
    expect(checkpoint.setupOnly.evidence.differencePp).toBeCloseTo(((28 - 23) / 54) * 100, 10);
    expect(checkpoint.draftOnly.evidence.simultaneous95IntervalPp[0]).toBeLessThan(0);
    expect(checkpoint.setupOnly.evidence.simultaneous95IntervalPp[0]).toBeLessThan(0);
    expect(checkpoint.rejectedCombination.differencePp).toBeLessThan(0);
});

test("serving draft reproduces every saved public proposal and honors its separate consumed budget", () => {
    const rows = lockedRevealedRangedDeliveryCheckpoints().result.verifiedResults.rows.filter((row) => row.seat === 0);
    for (const { proposal } of rows) {
        const { native, available, consumedBefore, pool } = proposal;
        const context = { ...proposal.context, synergyVariants: proposal.variants };
        expect(a19RevealedRangedDraftPool(native, available, context, consumedBefore)).toEqual(pool);
        expect(a19RevealedRangedDraftPool(native, available, context, true)).toEqual([]);
        expect(
            a19RevealedRangedDraftPool(native, available, { ...context, knownOpponentCreatureIds: [] }, false),
        ).toEqual([]);
    }
});
