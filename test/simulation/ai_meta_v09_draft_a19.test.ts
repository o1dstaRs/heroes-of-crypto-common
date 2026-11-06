import { expect, test } from "bun:test";

import { DEFAULT_AI_VERSION } from "../../src/ai";
import { V09_DEFAULT_DRAFT_MODEL_ID } from "../../src/ai/setup/doctrine_draft_policy";
import { V08_A19_PROFILE } from "../../src/ai/versions/v0_8_a19_profile";
import { type IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";
import { PREMIUM_META_FULL_AUGMENTS_STUDY } from "../../src/simulation/ai_meta_study";
import { resolveAiMetaFightProfile, runAiMetaWorkerPool } from "../../src/simulation/measure_ai_meta_cohorts";
import { renderAiMetaReport } from "../../src/simulation/render_ai_meta_report";

test("the combined profile preserves A19 combat and explicitly records the locked v0.9 draft", async () => {
    expect(DEFAULT_AI_VERSION).toBe("v0.8");
    const profile = resolveAiMetaFightProfile("v09-draft-a19-work");
    expect(profile.nativeV09).toBeUndefined();
    expect(profile.lockedV09Draft).toBe(true);
    expect(profile.provenance).toMatchObject({
        name: "v0.9-draft+v0.8-a19-work",
        draftModelId: V09_DEFAULT_DRAFT_MODEL_ID,
        search: V08_A19_PROFILE.search,
        searchBudget: "offline-deterministic-work",
    });
    expect(profile.workerEnvironment.V08_A19_SEARCH).toBe("1");
    const records: IAiMetaPairRecord[] = [];
    await runAiMetaWorkerPool(
        {
            cohort: "ranked-draft",
            games: 72,
            baseSeed: 3092306116,
            studyProfile: PREMIUM_META_FULL_AUGMENTS_STUDY,
            collectEvidence: true,
        },
        1,
        profile,
        (record) => records.push(record),
        { pairStart: 0, pairCount: 1 },
    );
    expect(records).toHaveLength(1);
    expect(records[0].evidence!.rankedDraft!.policy).toContain(V09_DEFAULT_DRAFT_MODEL_ID);
    expect(records[0].games).toHaveLength(2);
    expect(records[0].games.every(({ rejectedA, rejectedB }) => rejectedA === 0 && rejectedB === 0)).toBe(true);
    expect(records[0].evidence!.fights!.every(({ executionTrace }) => executionTrace!.length > 0)).toBe(true);
    const html = renderAiMetaReport({
        provenance: { fightVersion: profile.fightVersion, fightProfile: profile.provenance },
    });
    expect(html).toContain("Locked v0.9 draft + A19 combat");
    expect(html).toContain("H64 / R2 search");
}, 120_000);
