import { describe, expect, test } from "bun:test";

import {
    DISABLED_TIER1_ARTIFACT_IDS,
    DISABLED_TIER2_ARTIFACT_IDS,
    TIER1_ARTIFACT_LIST,
    TIER2_ARTIFACT_LIST,
    Tier1Artifact,
    Tier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { LIVE_TIER1_ARTIFACT_IDS, LIVE_TIER2_ARTIFACT_IDS } from "../../src/picks/pick_sim";

describe("disabled artifacts", () => {
    test("keeps Broken Aegis and Holy Cross out of every live draft pool", () => {
        expect(DISABLED_TIER1_ARTIFACT_IDS.has(Tier1Artifact.BROKEN_AEGIS)).toBe(true);
        expect(DISABLED_TIER2_ARTIFACT_IDS.has(Tier2Artifact.HOLY_CROSS)).toBe(true);
        expect(TIER1_ARTIFACT_LIST.map((artifact) => artifact.id)).not.toContain(Tier1Artifact.BROKEN_AEGIS);
        expect(TIER2_ARTIFACT_LIST.map((artifact) => artifact.id)).not.toContain(Tier2Artifact.HOLY_CROSS);
        expect(LIVE_TIER1_ARTIFACT_IDS).not.toContain(Tier1Artifact.BROKEN_AEGIS);
        expect(LIVE_TIER2_ARTIFACT_IDS).not.toContain(Tier2Artifact.HOLY_CROSS);
    });

    test("offers Tome of Amplification as Tier 1 and keeps the old Tier 2 id out of the draft", () => {
        expect(DISABLED_TIER2_ARTIFACT_IDS.has(Tier2Artifact.TOME_OF_AMPLIFICATION)).toBe(true);
        expect(TIER1_ARTIFACT_LIST.map((artifact) => artifact.id)).toContain(Tier1Artifact.TOME_OF_AMPLIFICATION);
        expect(TIER2_ARTIFACT_LIST.map((artifact) => artifact.id)).not.toContain(Tier2Artifact.TOME_OF_AMPLIFICATION);
        expect(LIVE_TIER1_ARTIFACT_IDS).toContain(Tier1Artifact.TOME_OF_AMPLIFICATION);
        expect(LIVE_TIER2_ARTIFACT_IDS).not.toContain(Tier2Artifact.TOME_OF_AMPLIFICATION);
        const live = TIER1_ARTIFACT_LIST.find((artifact) => artifact.id === Tier1Artifact.TOME_OF_AMPLIFICATION);
        expect(live?.imageKey).toBe("artifact_t2_tome_of_amplification_256");
    });

    test("offers Rime Charm as Tier 1 and keeps the old Tier 2 id out of the draft", () => {
        expect(DISABLED_TIER2_ARTIFACT_IDS.has(Tier2Artifact.RIME_CHARM)).toBe(true);
        expect(TIER1_ARTIFACT_LIST.map((artifact) => artifact.id)).toContain(Tier1Artifact.RIME_CHARM);
        expect(TIER2_ARTIFACT_LIST.map((artifact) => artifact.id)).not.toContain(Tier2Artifact.RIME_CHARM);
        expect(LIVE_TIER1_ARTIFACT_IDS).toContain(Tier1Artifact.RIME_CHARM);
        expect(LIVE_TIER2_ARTIFACT_IDS).not.toContain(Tier2Artifact.RIME_CHARM);
        const live = TIER1_ARTIFACT_LIST.find((artifact) => artifact.id === Tier1Artifact.RIME_CHARM);
        expect(live?.imageKey).toBe("artifact_t2_rime_charm_256");
    });
});
