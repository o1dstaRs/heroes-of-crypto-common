import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import context from "../../docs/evidence/empower_context_registration_20261115.json";
import original from "../../docs/evidence/empower_setup_registration_20261114.json";
import protectedAxis from "../../docs/evidence/empower_protected_axis_registration_20261114.json";
import { permuteRankedDraftSeed } from "../../src/simulation/ranked_draft_eval";

test("public-context Empower preserves its frozen helpers and separate fresh banks", () => {
    expect(context.registrationSha256).toBe("896fdd2c2ee97e1a9b5bd5192aee5991c56866ddc0932679fdd09ec1f48bcb17");
    const reserved = new Set<number>();
    const channels = (seed: number) =>
        Array.from({ length: 8 }, (_, offset) => [seed + offset, permuteRankedDraftSeed(seed + offset)]).flat();
    for (const seed of [
        ...original.reservedScannedPreimages,
        ...original.retiredBeforeFitting.reservedScannedPreimages,
        ...protectedAxis.reservedScannedPreimages,
    ])
        for (const channel of channels(seed)) reserved.add(channel);
    for (const seed of context.reservedScannedPreimages) {
        const fresh = channels(seed);
        if (fresh.some((channel) => reserved.has(channel)) || new Set(fresh).size !== fresh.length)
            throw new Error("Reused public-context Empower channel");
        for (const channel of fresh) reserved.add(channel);
    }
    expect(context.banks.train).toHaveLength(2160);
    for (const phase of ["qualification", "confirmation"] as const) {
        expect(context.banks[phase]).toHaveLength(1728);
        const counts = new Array<number>(27).fill(0);
        for (const [board, seed] of context.banks[phase]) {
            expect(context.reservedScannedPreimages.includes(seed)).toBe(true);
            counts[board % 27]++;
        }
        expect(counts).toEqual(new Array(27).fill(64));
    }
    expect(context.productionPromotion).toBe(false);
});

test("public-context Empower actor helpers remain immutable", () => {
    const hashes = {
        "src/ai/setup/empower_context.ts": "24d829f7e9c36572ee81786f51973dd220580b623e515274d7367c7c9deffb98",
        "src/simulation/empower_context_research.ts":
            "3790ac242de778d29b99bd20e43b9698504fc6161963970db4389572c483ce91",
        "src/simulation/empower_context_worker.ts": "a11d32c03d1a1edb64469168134ffd120e3f4953f4e6535715b5a8ceda2144b4",
    };
    for (const [path, expected] of Object.entries(hashes))
        expect(
            createHash("sha256")
                .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
                .digest("hex"),
        ).toBe(expected);
});
