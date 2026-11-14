import { expect, test } from "bun:test";
import continuation from "../../docs/evidence/empower_protected_axis_registration_20261114.json";
import registration from "../../docs/evidence/empower_setup_registration_20261114.json";
import { permuteRankedDraftSeed } from "../../src/simulation/ranked_draft_eval";

test("Empower banks retain balanced independent boards and exclude the retired study", () => {
    expect(registration.registrationSha256).toBe("c8a266a496d392ad7d9ead559df6a4ba3a4d61eb3dbc058c96a4f51ad077902b");
    const seeds = [
        ...registration.reservedScannedPreimages,
        ...registration.retiredBeforeFitting.reservedScannedPreimages,
    ];
    expect(seeds).toHaveLength(4320);
    const channels = new Set<number>();
    for (const seed of seeds) {
        expect(seed % 8).toBe(0);
        for (let offset = 0; offset < 8; offset++) {
            const raw = seed + offset,
                permuted = permuteRankedDraftSeed(raw);
            if (channels.has(raw) || channels.has(permuted) || raw === permuted)
                throw new Error("Reused Empower channel");
            channels.add(raw);
            channels.add(permuted);
        }
    }
    expect(channels.size).toBe(4320 * 16);
    for (const [phase, rows] of Object.entries(registration.banks)) {
        expect(rows).toHaveLength(phase === "train" ? 432 : 864);
        const cells = new Map<number, number>();
        for (const [board, seed] of rows) {
            expect(registration.reservedScannedPreimages.includes(seed)).toBe(true);
            cells.set(board % 27, (cells.get(board % 27) ?? 0) + 1);
        }
        expect(cells.size).toBe(27);
        expect([...cells.values()].every((count) => count === (phase === "train" ? 16 : 32))).toBe(true);
    }
    expect(registration.productionPromotion).toBe(false);
});

test("the protected-axis continuation reuses development only and reserves distinct fresh banks", () => {
    expect(continuation.registrationSha256).toBe("209d7c172fbb8cde1256cc5550d25327087060700b21865640040ed3144dd7c7");
    expect(continuation.banks.train).toEqual(registration.banks.train);
    expect(continuation.training.developmentBankReuse).toBe(registration.registrationSha256);
    const reserved = new Set<number>();
    const add = (seed: number) => {
        for (let offset = 0; offset < 8; offset++) {
            reserved.add(seed + offset);
            reserved.add(permuteRankedDraftSeed(seed + offset));
        }
    };
    for (const seed of [
        ...registration.reservedScannedPreimages,
        ...registration.retiredBeforeFitting.reservedScannedPreimages,
    ])
        add(seed);
    expect(continuation.reservedScannedPreimages).toHaveLength(1728);
    for (const phase of ["qualification", "confirmation"] as const) {
        expect(continuation.banks[phase]).toHaveLength(864);
        for (const [, seed] of continuation.banks[phase]) {
            for (let offset = 0; offset < 8; offset++) {
                expect(reserved.has(seed + offset)).toBe(false);
                expect(reserved.has(permuteRankedDraftSeed(seed + offset))).toBe(false);
            }
            add(seed);
        }
    }
});
