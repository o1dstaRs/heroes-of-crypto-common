import { describe, expect, test } from "bun:test";

import { DEFAULT_AI_VERSION, createAIStrategy } from "../../src/ai";
import { V09_DEFAULT_DRAFT_MODEL_ID, V09_DEFAULT_DRAFT_MODEL_SHA256 } from "../../src/ai/setup/doctrine_draft_policy";
import { V09_MODEL_PROMOTED } from "../../src/ai/versions/v0_9_artifact";
import { aiMetaSynergyVariantsForPair, prepareMetaPair } from "../../src/simulation/ai_meta_cohorts_core";
import { aiMetaMatchConfig, capturePremiumFight } from "../../src/simulation/ai_meta_cohorts_pair";
import { AI_META_NATIVE_V09_STRATEGY_PROFILE } from "../../src/simulation/ai_meta_strategy_profile";
import { PREMIUM_META_FULL_AUGMENTS_STUDY } from "../../src/simulation/ai_meta_study";
import { resolveAiMetaFightProfile, sanitizedAiMetaEnvironment } from "../../src/simulation/measure_ai_meta_cohorts";
import { renderAiMetaReport } from "../../src/simulation/render_ai_meta_report";

describe("native v0.9 meta profile", () => {
    test("keeps native v0.9 explicit without promoting an untrained combat artifact or inheriting A19 flags", () => {
        expect(DEFAULT_AI_VERSION).toBe("v0.8");
        expect(createAIStrategy("v0.9").version).toBe("v0.9");
        expect(V09_MODEL_PROMOTED).toBe(false);
        const profile = resolveAiMetaFightProfile("v09-native");
        expect(profile.fightVersion).toBe("v0.9");
        expect(profile.strategyProfileId).toBe(AI_META_NATIVE_V09_STRATEGY_PROFILE);
        expect(profile.provenance).toMatchObject({
            name: "v0.9-native",
            combatModelPromoted: false,
            draftModelId: V09_DEFAULT_DRAFT_MODEL_ID,
            draftModelSha256: V09_DEFAULT_DRAFT_MODEL_SHA256,
            searchBudget: "native-no-search",
        });
        const environment = sanitizedAiMetaEnvironment(
            { V08_A19_SEARCH: "1", SEARCH_VERSIONS: "v0.9", SEARCH_ROLLOUTS: "4", PATH: "/bin" },
            profile,
        );
        expect(environment.V08_A19_SEARCH).toBeUndefined();
        expect(environment.SEARCH_VERSIONS).toBeUndefined();
        expect(environment.SEARCH_ROLLOUTS).toBeUndefined();
    });

    test("runs both physical seats through real native v0.9 with complete Premium evidence", () => {
        const prepared = prepareMetaPair(
            {
                cohort: "ranked-draft",
                games: 72,
                baseSeed: 3092306116,
                nativeV09: true,
                studyProfile: PREMIUM_META_FULL_AUGMENTS_STUDY,
                collectEvidence: true,
            },
            0,
        );
        expect(prepared.evidence!.rankedDraft!.decisions.length).toBeGreaterThan(0);
        for (const [green, red] of [
            [prepared.armyA, prepared.armyB],
            [prepared.armyB, prepared.armyA],
        ]) {
            const config = aiMetaMatchConfig(
                green,
                red,
                prepared.combatSeed,
                prepared.map,
                AI_META_NATIVE_V09_STRATEGY_PROFILE,
                aiMetaSynergyVariantsForPair(prepared.setupSeed, prepared.combatSeed),
                true,
            );
            expect(config.greenVersion).toBe("v0.9");
            expect(config.redVersion).toBe("v0.9");
            expect(config.greenStrategyOverride).toBeUndefined();
            expect(config.redStrategyOverride).toBeUndefined();
            let nativeDecisions = 0;
            const capture = capturePremiumFight(
                {
                    ...config,
                    v09ServerPreflightObserver: (observation) => {
                        expect(observation.failure).toBeNull();
                        nativeDecisions++;
                    },
                },
                true,
            );
            expect(nativeDecisions).toBeGreaterThan(0);
            expect(capture.result.outcome.green.version).toBe("v0.9");
            expect(capture.result.outcome.red.version).toBe("v0.9");
            expect(capture.result.rejectedGreen ?? 0).toBe(0);
            expect(capture.result.rejectedRed ?? 0).toBe(0);
            expect(capture.firstDecisionState!.units.length).toBeGreaterThanOrEqual(12);
            expect(capture.executionTrace!.length).toBeGreaterThan(0);
            expect(capture.healthLedger!.length).toBeGreaterThan(0);
        }
    });

    test("the report names native v0.9 and discloses its actual combat model", () => {
        const profile = resolveAiMetaFightProfile("v09-native");
        const html = renderAiMetaReport({
            provenance: { fightVersion: profile.fightVersion, fightProfile: profile.provenance },
        });
        const header = html.slice(html.indexOf('<header id="report-top"'), html.indexOf("</header>"));
        expect(header).toContain("v0.9");
        expect(header).not.toContain("H64 / R2");
        expect(html).toContain("Native v0.9 · locked V3 draft");
        expect(html).toContain("anchor-only and untrained");
        expect(html).toContain(V09_DEFAULT_DRAFT_MODEL_ID);
    });
});
