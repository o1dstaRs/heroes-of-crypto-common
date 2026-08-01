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
});
