/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, V07_NONFIGHT_DRAFT_SPEC } from "../../src/ai/setup/draft_ship";
import {
    resolveSetupPolicy,
    V07_NONFIGHT_BEHAVIOR_SHA256,
    V07_NONFIGHT_SETUP_SPEC,
} from "../../src/ai/setup/setup_ship";
import { fingerprintRankedDraftArtifact } from "../../src/simulation/optimizer/ranked_draft_cem_core";
import { fingerprintV07NonfightCampaign } from "../../src/simulation/optimizer/v0_7_nonfight_campaign_core";
import campaignRun from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/campaign-run.json";
import campaignTerminal from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/campaign-terminal.json";
import manifest from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/composed-manifest.json";
import outcome from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/composed-outcome.json";
import report from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/composed-report.json";
import draftVerdict from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/draft-verdict.json";
import promotion from "../../docs/evidence/v0_7_nonfight_11h_result_20260717/promotion-report.json";

const evidenceRoot = new URL("../../docs/evidence/v0_7_nonfight_11h_result_20260717/", import.meta.url);

const rawSha256 = (name: string): string =>
    createHash("sha256")
        .update(readFileSync(new URL(name, evidenceRoot)))
        .digest("hex");

const parseAttestation = (name: string): Record<string, string> =>
    Object.fromEntries(
        readFileSync(new URL(name, evidenceRoot), "utf8")
            .trim()
            .split("\n")
            .map((line) => {
                const separator = line.indexOf("=");
                return [line.slice(0, separator), line.slice(separator + 1)];
            }),
    );

describe("v0.7 non-fight promotion evidence", () => {
    it("preserves the exact terminal artifacts and every self-hash", () => {
        const { manifestSha256, ...manifestBase } = manifest;
        const { reportSha256, ...reportBase } = report;
        const { promotionSha256, ...promotionBase } = promotion;
        const { runSha256, ...campaignRunBase } = campaignRun;
        const { terminalSha256, ...campaignTerminalBase } = campaignTerminal;

        expect(rawSha256(promotion.archive.campaignRun.path)).toBe(promotion.archive.campaignRun.bytesSha256);
        expect(rawSha256(promotion.archive.campaignTerminal.path)).toBe(promotion.archive.campaignTerminal.bytesSha256);
        expect(rawSha256(promotion.archive.draftVerdict.path)).toBe(promotion.archive.draftVerdict.bytesSha256);
        expect(rawSha256(promotion.archive.manifest.path)).toBe(promotion.archive.manifest.bytesSha256);
        expect(rawSha256(promotion.archive.report.path)).toBe(promotion.archive.report.bytesSha256);
        expect(rawSha256(promotion.archive.outcome.path)).toBe(promotion.archive.outcome.bytesSha256);
        expect(fingerprintRankedDraftArtifact(manifestBase)).toBe(manifestSha256);
        expect(fingerprintRankedDraftArtifact(reportBase)).toBe(reportSha256);
        expect(fingerprintRankedDraftArtifact(promotionBase)).toBe(promotionSha256);
        expect(fingerprintV07NonfightCampaign(campaignRunBase)).toBe(runSha256);
        expect(fingerprintV07NonfightCampaign(campaignTerminalBase)).toBe(terminalSha256);
        expect(fingerprintRankedDraftArtifact(draftVerdict)).toBe(promotion.archive.draftVerdict.artifactSha256);
        expect(promotion.archive.campaignRun.artifactSha256).toBe(runSha256);
        expect(promotion.archive.campaignTerminal.artifactSha256).toBe(terminalSha256);
        expect(promotion.archive.manifest.artifactSha256).toBe(manifestSha256);
        expect(promotion.archive.report.artifactSha256).toBe(reportSha256);
        expect(campaignTerminal.runSha256).toBe(runSha256);
        expect(outcome.manifestSha256).toBe(manifestSha256);
        expect(outcome.reportSha256).toBe(reportSha256);
        expect(outcome.ledgerSha256).toBe(report.ledgerSha256);
    });

    it("binds both prelaunch attestations to the clean campaign and guard source", () => {
        const campaign = parseAttestation(promotion.archive.campaignAttestation.path);
        const guard = parseAttestation(promotion.archive.guardAttestation.path);

        expect(rawSha256(promotion.archive.campaignAttestation.path)).toBe(
            promotion.archive.campaignAttestation.bytesSha256,
        );
        expect(rawSha256(promotion.archive.guardAttestation.path)).toBe(promotion.archive.guardAttestation.bytesSha256);
        expect(promotion.archive.campaignAttestation.sourceMode).toBe("0440");
        expect(promotion.archive.guardAttestation.sourceMode).toBe("0440");
        expect(campaign).toMatchObject({
            CAMPAIGN_RUN_SHA256: manifest.campaign.runSha256,
            CAMPAIGN_TERMINAL_SHA256: manifest.campaign.terminalSha256,
            CAMPAIGN_CONFIG_SHA256: manifest.campaign.configSha256,
            CAMPAIGN_PROVENANCE_SHA256: manifest.campaign.provenanceSha256,
            CAMPAIGN_SOURCE_COMMIT: manifest.campaign.sourceCommit,
            DRAFT_VERDICT_SHA256: manifest.sealedInputs["draft-verdict.json"].bytesSha256,
            DRAFT_RUN_FINGERPRINT: manifest.artifacts.draft.runFingerprint,
            SETUP_FINAL_SHA256: manifest.sealedInputs["setup-final.json"].bytesSha256,
            SETUP_CHECKPOINT_SHA256: manifest.sealedInputs["setup-checkpoint.json"].bytesSha256,
            RUN_ID: manifest.runId,
        });
        expect(guard.GUARD_SOURCE_COMMIT).toBe(manifest.campaign.guardSourceCommit);
        expect(manifest.campaign.sourceLineage).toMatchObject({
            campaignIsAncestor: true,
            diffSha256: "5d3e9d2e30381d27bd0fbe536f68f6000fbfa1f01f8df85912d104c9fc33c782",
        });
        expect(manifest.provenance).toMatchObject({
            commit: manifest.campaign.guardSourceCommit,
            originMain: manifest.campaign.guardSourceCommit,
            branch: "main",
            cleanIncludingUntracked: true,
        });
        expect(manifest.smoke).toBe(false);
        expect(Object.keys(manifest.sealedInputs)).toHaveLength(promotion.sealedInputs.count);
        expect(manifest.panels).toEqual({
            naturalBoards: 8000,
            cohortBoards: 2500,
            cohortScanMaxBoards: 1000000,
            symmetryBoards: 64,
            replayBoards: 8,
        });
    });

    it("accepts only the independently qualified setup policy", () => {
        expect(promotion.status).toBe("accepted_setup_only");
        expect(promotion.policies.setup).toMatchObject({
            spec: V07_NONFIGHT_SETUP_SPEC,
            behaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256,
            guardPolicyFingerprint: manifest.candidate.setupFingerprint,
        });
        expect(promotion.sealedInputs.setupFinalArtifactSha256).toBe(manifest.artifacts.setup.artifactSha256);
        expect(resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC).mode).toBe("optimized-v07");
        expect(promotion.individualSetupGuard.promotable).toBe(true);
        expect(promotion.individualSetupGuard.aggregate).toMatchObject({
            pairs: 12288,
            games: 24576,
            candidateRejections: 0,
            baselineRejections: 0,
        });
        expect(promotion.individualSetupGuard.aggregate.confidence95LowGainPp).toBeGreaterThan(0);
        for (const cohort of Object.values(promotion.individualSetupGuard.cohorts)) {
            expect(cohort.games).toBeGreaterThanOrEqual(100);
            expect(cohort.decisiveWinRate).toBeGreaterThanOrEqual(0.495);
            expect(cohort.confidence95LowGainPp).toBeGreaterThanOrEqual(-2);
        }
        for (const map of Object.values(promotion.individualSetupGuard.maps)) {
            expect(map.games).toBeGreaterThanOrEqual(1000);
            expect(map.decisiveWinRate).toBeGreaterThanOrEqual(0.495);
            expect(map.confidence95LowGainPp).toBeGreaterThanOrEqual(-2);
        }
        expect(promotion.individualSetupGuard.controlSymmetry.passed).toBe(true);
        expect(promotion.individualSetupGuard.deterministicReplay.byteIdentical).toBe(true);
        expect(promotion.authority).toEqual({
            setupAcceptedForPromotion: true,
            draftAcceptedForPromotion: false,
            draftExplicitOptInRetained: true,
            composedAcceptedForPromotion: false,
            defaultChangedByThisArtifact: false,
            productionEnabled: false,
            deployAuthorization: false,
        });
    });

    it("records the completed composed rejection and the exact mage failure", () => {
        const failedChecks = Object.entries(report.checks)
            .filter(([, passed]) => !passed)
            .map(([name]) => name);

        expect(outcome).toMatchObject({
            completion: "complete",
            eligibleForManualReview: false,
            autoBaked: false,
        });
        expect(report.eligibleForManualReview).toBe(false);
        expect(Object.values(report.checks).filter(Boolean)).toHaveLength(promotion.composedGuard.checksPassed);
        expect(Object.keys(report.checks)).toHaveLength(promotion.composedGuard.checksTotal);
        expect(failedChecks).toEqual(promotion.composedGuard.failedChecks);
        expect(failedChecks).toEqual([
            "targetedCohortPointEstimatesAtLeast49_5",
            "targetedCohortClusteredLower95AtLeast48",
        ]);
        expect(report.natural).toMatchObject({
            offerBoards: promotion.composedGuard.natural.offerBoards,
            games: promotion.composedGuard.natural.games,
            decisiveWinRate: promotion.composedGuard.natural.decisiveWinRate,
            candidateRejections: 0,
            baselineRejections: 0,
        });
        expect(report.natural.confidence95.low).toBe(promotion.composedGuard.natural.confidence95Low);
        expect(report.targetedCohorts.mage.estimate.decisiveWinRate).toBe(
            promotion.composedGuard.failure.observedPoint,
        );
        expect(report.targetedCohorts.mage.estimate.confidence95.low).toBe(
            promotion.composedGuard.failure.observedLower95,
        );
        expect(promotion.composedGuard.failure.observedPoint).toBeLessThan(
            promotion.composedGuard.failure.pointThreshold,
        );
        expect(promotion.composedGuard.failure.observedLower95).toBeLessThan(
            promotion.composedGuard.failure.lower95Threshold,
        );
        for (const cohort of ["ranged", "melee_magic", "aura"] as const) {
            expect(report.targetedCohorts[cohort].estimate.decisiveWinRate).toBeGreaterThanOrEqual(
                report.thresholds.namedDecisiveWinRate,
            );
            expect(report.targetedCohorts[cohort].estimate.confidence95.low).toBeGreaterThanOrEqual(
                report.thresholds.namedClusteredLower95,
            );
        }
        expect(report.deterministicReplay).toMatchObject({
            boards: 8,
            firstSha256: promotion.composedGuard.deterministicReplay.sha256,
            secondSha256: promotion.composedGuard.deterministicReplay.sha256,
            byteIdentical: true,
        });
    });

    it("retains the qualified draft only as a non-default explicit opt-in", () => {
        const draft = parseDraftGenome(V07_NONFIGHT_DRAFT_SPEC);
        const incumbent = parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC);

        expect(promotion.policies.draft).toMatchObject({
            spec: V07_NONFIGHT_DRAFT_SPEC,
            candidateFingerprint: manifest.candidate.draftFingerprint,
            disposition: "explicit_opt_in_only_not_default",
        });
        expect(fingerprintRankedDraftArtifact({ schemaVersion: draft.schemaVersion, weights: draft.weights })).toBe(
            promotion.policies.draft.candidateFingerprint,
        );
        expect(draft.weights).not.toEqual(incumbent.weights);
        expect(promotion.decision).toMatchObject({
            setup: "accept_for_promotion",
            draft: "do_not_promote_from_this_campaign",
            composed: "reject",
        });
    });
});
