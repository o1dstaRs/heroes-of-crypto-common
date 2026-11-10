import { expect, test } from "bun:test";
import evidence from "../../docs/evidence/contextual_draft_registration_20261110.json";
import { permuteRankedDraftSeed } from "../../src/simulation/ranked_draft_eval";

test("contextual draft banks preserve every map/doctrine/variant/population cell and disjoint game channels", () => {
    expect(evidence.registrationSha256).toBe("b3c86d9ed2b14858828a31f30f664dd3b8d7b3be42ff1e567f63b94a0d0ffc29");
    expect(evidence.sourceManifestSha256).toBe("eb6ff05c7b65e6e1ddbd7799d8db0422d48f920f2310b7a97f55fba4051a850e");
    const channels = new Set<number>();
    for (const [name, rows] of Object.entries(evidence.banks)) {
        expect(rows.length).toBe(name === "train" ? 4320 : 1728);
        const cells = new Map<string, number>();
        for (const [board, seed, rush, targetLevel, firstGame, mask] of rows) {
            const key = [board % 27, rush, mask, ...(name === "train" ? [targetLevel] : [])].join(":");
            cells.set(key, (cells.get(key) ?? 0) + 1);
            if (firstGame !== 0 && firstGame !== 2) throw new Error("Wrong training draft assignment");
            for (let offset = 0; offset < 8; offset++) {
                const raw = seed + offset,
                    permuted = permuteRankedDraftSeed(raw);
                if (channels.has(raw) || channels.has(permuted)) throw new Error("Reused contextual channel");
                channels.add(raw);
                channels.add(permuted);
            }
        }
        expect(cells.size).toBe(name === "train" ? 4320 : 864);
        expect([...cells.values()].every((count) => count === (name === "train" ? 1 : 2))).toBe(true);
    }
    expect(channels.size).toBe(124416);
    expect(evidence.reservedActualChannels.length).toBe(channels.size);
    expect(new Set(evidence.reservedActualChannels).size).toBe(channels.size);
    expect(evidence.reservedActualChannels.every((value) => channels.has(value))).toBe(true);
    expect(evidence.priorChannelAudit.conflicts).toBe(0);
    expect(evidence.productionPromotion).toBe(false);
});

test("all scanned preimages remain reserved beyond the selected games", () => {
    expect(evidence.reservedScannedPreimages.length).toBe(125416);
    const preimages = new Set(evidence.reservedScannedPreimages);
    expect(preimages.size).toBe(125416);
    expect(evidence.reservedScannedPreimages.every((seed) => seed >= 0 && seed <= 0x7ffffff8 && seed % 8 === 0)).toBe(
        true,
    );
    for (const rows of Object.values(evidence.banks)) expect(rows.every((row) => preimages.has(row[1]))).toBe(true);
    expect(evidence.priorChannelAudit.newReservedChannels).toBe(preimages.size * 16);
    expect(evidence.profile.setup).toBe("artifact-fit-v6:conditional-v1:sniper+t2a19");
});
