/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";

import {
    expandV0796hPriorSeedManifest,
    fingerprintV0796h,
    fingerprintV0796hGenome,
    V07_96H_TEMPLATES,
    type IV0796hGenome,
} from "../../src/simulation/optimizer/v0_7_96h_core";

const resultsUrl = new URL("../../src/simulation/results/", import.meta.url);
const outcomeUrl = new URL("v0_7_96h_d68490a_outcome.json", resultsUrl);
const terminalUrl = new URL("v0_7_96h_d68490a_terminal.json", resultsUrl);
const selectionUrl = new URL("v0_7_96h_d68490a_selection.json", resultsUrl);
const draftAcceptanceUrl = new URL("draft_league_round3_v0_7_acceptance.json", resultsUrl);
const seedManifestUrl = new URL("../../src/simulation/manifests/v0_7_96h_run_d68490a_seeds.json", import.meta.url);
const projectedDraftUrl = new URL(
    "../../src/ai/setup/draft_genomes/league_round3_br_52752642_projected.json",
    import.meta.url,
);

const parseJson = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf8")) as T;
const rawSha256 = (url: URL): string => createHash("sha256").update(readFileSync(url)).digest("hex");

interface IAuthority {
    researchOnly: boolean;
    seedReservation: boolean;
    acceptedForOptIn: boolean;
    defaultChanged: boolean;
    productionEnabled: boolean;
    releaseAuthorization: boolean;
    bakeAuthorization: boolean;
    deployAuthorization: boolean;
}

interface ITerminal {
    schemaVersion: number;
    status: string;
    runId: string;
    completedAt: string;
    deadlineAt: string;
    code: { revision: string; sourceTreeSha256: string };
    frozenCandidate: {
        candidateFingerprint: string;
        genomeId: string;
        genome: IV0796hGenome;
        selectionEvidence: {
            evaluationSha256: string;
            reportSha256: string;
            auditSha256: string;
        };
    };
    finalStatus: string;
    finalV06: Record<string, unknown>;
    finalV04: Record<string, unknown>;
    promotions: number;
    generations: number;
    targetGate: {
        achieved: boolean;
        observed90AllArchetypes: boolean;
        certified90AllArchetypes: boolean;
        strict90AllTemplates: boolean;
        integrityQualified: boolean;
        operationalQualified: boolean;
    };
    gateDecision: { bake: boolean; deploy: boolean; reason: string };
    terminalSha256: string;
}

interface ITemplateMetric {
    template: string;
    archetype: string;
    seed: number;
    games: number;
    decisiveGames: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    decisiveWinRate: number;
    confidence95Low: number;
    scoreRate: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    candidateRejections: number;
    opponentRejections: number;
    missingRejectionCounts: number;
}

interface ISelectionArtifact {
    runId: string;
    panelId: string;
    opponent: string;
    genomeId: string;
    genome: IV0796hGenome;
    auditSha256: string;
    validation: { reportSha256: string };
    report: {
        requested: { gamesPerTemplate: number };
        limitingTemplate: { template: string; decisiveWinRate: number };
        targetDiagnostics: {
            observed90AllArchetypes: boolean;
            certified90AllArchetypes: boolean;
            strict90AllTemplates: boolean;
        };
    };
}

interface IOutcome {
    schemaVersion: number;
    artifactKind: string;
    artifactId: string;
    status: string;
    authority: IAuthority;
    releaseInstruction: string;
    run: {
        runId: string;
        revision: string;
        sourceTreeSha256: string;
        deadlineAt: string;
        seedManifest: { committedPath: string; sha256: string };
        terminal: {
            rawSha256: string;
            terminalSha256: string;
            status: string;
            completedAt: string;
            finalStatus: string;
            promotions: number;
            generations: number;
            finalV06: Record<string, unknown>;
            finalV04: Record<string, unknown>;
            targetGate: ITerminal["targetGate"];
            gateDecision: ITerminal["gateDecision"];
        };
    };
    frozenCandidate: {
        genomeId: string;
        candidateFingerprint: string;
        sourceArtifactSha256: string;
        selection: {
            committedPath: string;
            panelId: string;
            opponent: string;
            gamesPerTemplate: number;
            evaluationSha256: string;
            reportSha256: string;
            auditSha256: string;
            limitingTemplate: { template: string; decisiveWinRate: number; confidence95Low: number };
            maximumDrawOrArmageddonRate: number;
            targetDiagnostics: {
                observed90AllArchetypes: boolean;
                certified90AllArchetypes: boolean;
                strict90AllTemplates: boolean;
            };
        };
        partialFinalV06AtDeadline: {
            schemaVersion: number;
            artifactKind: string;
            runId: string;
            panelId: string;
            revision: string;
            capturedAt: string;
            evidenceStatus: string;
            checkpointFiles: number;
            checkpointBytes: number;
            checkpointAuditBytes: number;
            checkpointIndexSha256: string;
            checkpointIndex: {
                path: string;
                template: string;
                start: number;
                end: number;
                games: number;
                checkpointBytes: number;
                auditBytes: number;
            }[];
            behaviorEnvironmentFingerprint: string;
            completedGames: number;
            requestedGames: number;
            targetClaim: boolean;
            templates: {
                template: string;
                status: string;
                games: number;
                requestedGames: number;
                decisiveGames: number;
                candidateWins: number;
                opponentWins: number;
                draws: number;
                decisiveWinRate: number | null;
                scoreRate: number | null;
                drawOrArmageddon: number;
                drawOrArmageddonRate: number | null;
                bestPossibleDecisiveWinRate: number | null;
                canStillReach90: boolean;
                canStillMeetIntegrityGate: boolean;
            }[];
        };
        decision: {
            qualified: boolean;
            promotionEligible: boolean;
            releaseEligible: boolean;
            reasonCodes: string[];
        };
    };
    lateResearchCandidate: {
        genomeId: string;
        genome: IV0796hGenome;
        discovery: {
            panelId: string;
            games: number;
            artifactSha256: string;
            auditSha256: string;
            minimumTemplateRate: number;
            minimumTemplateLow: number;
            maximumDrawOrArmageddonRate: number;
        };
        cleanReplay: {
            sourceRevision: string;
            sourceProvenance: {
                revision: {
                    commit: string;
                    branch: string;
                    trackedClean: boolean;
                    trackedDiffSha256: string | null;
                    worktreeClean: boolean;
                    statusPorcelainSha256: string;
                    untrackedPaths: string[];
                };
                revisionAtCompletion: {
                    commit: string;
                    branch: string;
                    trackedClean: boolean;
                    trackedDiffSha256: string | null;
                    worktreeClean: boolean;
                    statusPorcelainSha256: string;
                    untrackedPaths: string[];
                };
                revisionStable: boolean;
            };
            reportSha256: string;
            auditSha256: string;
            gamesPerTemplate: number;
            totalGames: number;
            requested: {
                candidate: string;
                opponent: string;
                templates: string[];
                gamesPerTemplate: number;
                seeds: Record<string, number>;
                concurrency: number;
                auditTurns: boolean;
                behaviorEnvironment: Record<string, string>;
                behaviorEnvironmentSha256: string;
                qualification: string;
            };
            templates: ITemplateMetric[];
            targetDiagnostics: {
                observed90AllArchetypes: boolean;
                certified90AllArchetypes: boolean;
                strict90AllTemplates: boolean;
            };
            integrity: { maximumDrawOrArmageddonRate: number; requiredMaximum: number; passed: boolean };
            latency: {
                matchBudget: { requiredMaximumMs: number; p95Ms: number; maxMs: number; passed: boolean };
                serverTurnCircuitDiagnostic: {
                    serverRevision: string;
                    requiredMaximumMs: number;
                    turns: number;
                    turnsOverBudget: number;
                    turnsOverBudgetRate: number;
                    gamesWithAtLeastOneOverBudgetTurn: number;
                    games: number;
                    p95Ms: number;
                    maxMs: number;
                    passed: boolean;
                };
            };
        };
        decision: {
            qualified: boolean;
            promotionEligible: boolean;
            releaseEligible: boolean;
            reasonCodes: string[];
        };
    };
    independentDraftWin: {
        scope: string;
        candidateId: string;
        genomeFingerprint: string;
        acceptanceReportSha256: string;
        verdict: string;
        authority: {
            acceptedForOptIn: boolean;
            defaultChanged: boolean;
            productionEnabled: boolean;
            deployAuthorization: boolean;
        };
    };
    outcomeSha256: string;
}

const outcome = parseJson<IOutcome>(outcomeUrl);
const terminal = parseJson<ITerminal>(terminalUrl);
const selection = parseJson<ISelectionArtifact>(selectionUrl);

describe("v0.7 96-hour historical outcome", () => {
    it("preserves exact self-hashed terminal and outcome evidence", () => {
        const { terminalSha256, ...terminalBase } = terminal;
        const { outcomeSha256, ...outcomeBase } = outcome;

        expect(rawSha256(terminalUrl)).toBe(outcome.run.terminal.rawSha256);
        expect(fingerprintV0796h(terminalBase)).toBe(terminalSha256);
        expect(outcome.run.terminal.terminalSha256).toBe(terminalSha256);
        expect(fingerprintV0796h(outcomeBase)).toBe(outcomeSha256);
    });

    it("records the deadline result without granting release authority", () => {
        expect(outcome).toMatchObject({
            schemaVersion: 1,
            artifactKind: "v0.7_96h_historical_research_outcome",
            artifactId: "v0.7-96h-d68490a-dd420df1",
            status: "complete_research_record",
            authority: {
                researchOnly: true,
                seedReservation: false,
                acceptedForOptIn: false,
                defaultChanged: false,
                productionEnabled: false,
                releaseAuthorization: false,
                bakeAuthorization: false,
                deployAuthorization: false,
            },
            releaseInstruction: "NO_BAKE_NO_RELEASE_NO_DEPLOY_FROM_THIS_ARTIFACT",
        });
        expect(outcome.run).toMatchObject({
            runId: "dd420df1314ccb95eadd6285a6124a725ec08125009aa60d7690dda1b90f2942",
            revision: "d68490a4c1afbf10101baa746b8388cd031b8dca",
            sourceTreeSha256: "b63af92f41b3a9d28a6001135879ffffee47e96aa61ac22fd40659bbbb097a1c",
            deadlineAt: "2026-07-15T06:28:47.000Z",
            seedManifest: {
                committedPath: "src/simulation/manifests/v0_7_96h_run_d68490a_seeds.json",
                sha256: "634407118ab78e1cccd4f09a6414bfba9d7cfc402ce372fd7baa96afd69aff23",
            },
        });
        expect(rawSha256(seedManifestUrl)).toBe(outcome.run.seedManifest.sha256);
        expect(terminal).toMatchObject({
            schemaVersion: 1,
            status: "complete_research_only",
            runId: outcome.run.runId,
            deadlineAt: outcome.run.deadlineAt,
            finalStatus: "primary_incomplete_deadline",
            promotions: 0,
            generations: 3,
            targetGate: {
                achieved: false,
                observed90AllArchetypes: false,
                certified90AllArchetypes: false,
                strict90AllTemplates: false,
                integrityQualified: false,
                operationalQualified: false,
            },
            gateDecision: { bake: false, deploy: false },
        });
        expect(terminal.code.revision).toBe(outcome.run.revision);
        expect(terminal.code.sourceTreeSha256).toBe(outcome.run.sourceTreeSha256);
        expect(outcome.run.terminal).toMatchObject({
            status: terminal.status,
            completedAt: terminal.completedAt,
            finalStatus: terminal.finalStatus,
            promotions: terminal.promotions,
            generations: terminal.generations,
            finalV06: terminal.finalV06,
            finalV04: terminal.finalV04,
            targetGate: terminal.targetGate,
            gateDecision: terminal.gateDecision,
        });
    });

    it("cannot be interpreted as a seed reservation manifest", () => {
        for (const key of ["seedSeries", "panels", "gamesPerCell", "cells", "headline", "cohorts"]) {
            expect(Object.hasOwn(outcome, key)).toBe(false);
        }
        expect(expandV0796hPriorSeedManifest(outcome)).toEqual([]);
        expect(expandV0796hPriorSeedManifest(terminal)).toEqual([]);
    });

    it("rejects the frozen candidate on its selection and incomplete final evidence", () => {
        const { candidateFingerprint, ...frozenCandidateBase } = terminal.frozenCandidate;
        const reconstructedArtifactSha256 = createHash("sha256")
            .update(`${JSON.stringify(terminal.frozenCandidate, null, 2)}\n`)
            .digest("hex");

        expect(fingerprintV0796hGenome(terminal.frozenCandidate.genome)).toBe(outcome.frozenCandidate.genomeId);
        expect(terminal.frozenCandidate.genomeId).toBe(
            "d8ab6a7d5fb8ed0eaef10ad919c1f12a5bd6e1bbdb43f7a09f9db72ff130344c",
        );
        expect(terminal.frozenCandidate.candidateFingerprint).toBe(outcome.frozenCandidate.candidateFingerprint);
        expect(fingerprintV0796h(frozenCandidateBase)).toBe(candidateFingerprint);
        expect(reconstructedArtifactSha256).toBe(outcome.frozenCandidate.sourceArtifactSha256);
        expect(reconstructedArtifactSha256).toBe("5b41efc4c1636fecf260605a9b6142e654afee5abce1fc1f49ee7f86e71d1324");
        expect(outcome.frozenCandidate.selection.committedPath).toBe(
            "src/simulation/results/v0_7_96h_d68490a_selection.json",
        );
        expect(rawSha256(selectionUrl)).toBe(outcome.frozenCandidate.selection.evaluationSha256);
        expect(outcome.frozenCandidate.selection.evaluationSha256).toBe(
            terminal.frozenCandidate.selectionEvidence.evaluationSha256,
        );
        expect(fingerprintV0796h(selection.report)).toBe(outcome.frozenCandidate.selection.reportSha256);
        expect(selection.validation.reportSha256).toBe(outcome.frozenCandidate.selection.reportSha256);
        expect(selection.auditSha256).toBe(outcome.frozenCandidate.selection.auditSha256);
        expect(fingerprintV0796hGenome(selection.genome)).toBe(outcome.frozenCandidate.genomeId);
        expect(selection).toMatchObject({
            runId: outcome.run.runId,
            panelId: outcome.frozenCandidate.selection.panelId,
            opponent: outcome.frozenCandidate.selection.opponent,
            genomeId: outcome.frozenCandidate.genomeId,
            report: {
                requested: { gamesPerTemplate: outcome.frozenCandidate.selection.gamesPerTemplate },
                limitingTemplate: {
                    template: outcome.frozenCandidate.selection.limitingTemplate.template,
                    decisiveWinRate: outcome.frozenCandidate.selection.limitingTemplate.decisiveWinRate,
                },
                targetDiagnostics: outcome.frozenCandidate.selection.targetDiagnostics,
            },
        });
        expect(outcome.frozenCandidate.selection).toMatchObject({
            limitingTemplate: {
                template: "melee_magic_utility",
                decisiveWinRate: 0.8156312625250501,
                confidence95Low: 0.7915477437151457,
            },
            maximumDrawOrArmageddonRate: 0.9,
            targetDiagnostics: {
                observed90AllArchetypes: false,
                certified90AllArchetypes: false,
                strict90AllTemplates: false,
            },
        });
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline).toMatchObject({
            schemaVersion: 1,
            artifactKind: "v0.7_96h_partial_final_v06_checkpoint_index",
            runId: outcome.run.runId,
            panelId: "final-v06",
            revision: outcome.run.revision,
            evidenceStatus: "partial_unqualified",
            requestedGames: 96_000,
            targetClaim: false,
        });
        expect(Date.parse(outcome.frozenCandidate.partialFinalV06AtDeadline.capturedAt)).toBeGreaterThanOrEqual(
            Date.parse(outcome.run.terminal.completedAt),
        );
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.completedGames).toBeLessThan(96_000);
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointFiles * 200).toBe(
            outcome.frozenCandidate.partialFinalV06AtDeadline.completedGames,
        );
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointBytes).toBeGreaterThan(0);
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointAuditBytes).toBeGreaterThan(0);
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndexSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprintV0796h(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex)).toBe(
            outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndexSha256,
        );
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex).toHaveLength(
            outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointFiles,
        );
        expect(
            new Set(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex.map(({ path }) => path)).size,
        ).toBe(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointFiles);
        expect(
            outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex.reduce(
                (sum, entry) => sum + entry.checkpointBytes,
                0,
            ),
        ).toBe(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointBytes);
        expect(
            outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex.reduce(
                (sum, entry) => sum + entry.auditBytes,
                0,
            ),
        ).toBe(outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointAuditBytes);
        expect(
            outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex.reduce(
                (sum, entry) => sum + entry.games,
                0,
            ),
        ).toBe(outcome.frozenCandidate.partialFinalV06AtDeadline.completedGames);
        const checkpointRanges = new Map<
            string,
            IOutcome["frozenCandidate"]["partialFinalV06AtDeadline"]["checkpointIndex"]
        >();
        for (const entry of outcome.frozenCandidate.partialFinalV06AtDeadline.checkpointIndex) {
            const ranges = checkpointRanges.get(entry.template) ?? [];
            ranges.push(entry);
            checkpointRanges.set(entry.template, ranges);
        }
        for (const template of V07_96H_TEMPLATES.map(({ template }) => template)) {
            const ranges = (checkpointRanges.get(template) ?? []).sort((left, right) => left.start - right.start);
            let nextStart = 0;
            for (const entry of ranges) {
                expect(entry.start).toBe(nextStart);
                expect(entry.end - entry.start).toBe(entry.games);
                expect(entry.path).toBe(
                    `${template}/games-${String(entry.start).padStart(6, "0")}-${String(entry.end).padStart(6, "0")}.json`,
                );
                nextStart = entry.end;
            }
            expect(nextStart).toBe(
                outcome.frozenCandidate.partialFinalV06AtDeadline.templates.find((entry) => entry.template === template)
                    ?.games,
            );
        }
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.behaviorEnvironmentFingerprint).toBe(
            "97147e28090f0445dc5def1cca7e2e35774e29e0403266df861629eff826c06b",
        );
        expect(outcome.frozenCandidate.partialFinalV06AtDeadline.templates.map(({ template }) => template)).toEqual(
            V07_96H_TEMPLATES.map(({ template }) => template),
        );
        expect(
            outcome.frozenCandidate.partialFinalV06AtDeadline.templates.reduce((sum, value) => sum + value.games, 0),
        ).toBe(outcome.frozenCandidate.partialFinalV06AtDeadline.completedGames);
        for (const metric of outcome.frozenCandidate.partialFinalV06AtDeadline.templates) {
            expect(metric.decisiveGames).toBe(metric.candidateWins + metric.opponentWins);
            expect(metric.games).toBe(metric.decisiveGames + metric.draws);
            expect(metric.decisiveWinRate).toBe(
                metric.decisiveGames ? metric.candidateWins / metric.decisiveGames : null,
            );
            expect(metric.scoreRate).toBe(
                metric.games ? (metric.candidateWins + 0.5 * metric.draws) / metric.games : null,
            );
            expect(metric.drawOrArmageddonRate).toBe(metric.games ? metric.drawOrArmageddon / metric.games : null);
            const remaining = metric.requestedGames - metric.games;
            const bestPossible =
                metric.decisiveGames + remaining
                    ? (metric.candidateWins + remaining) / (metric.decisiveGames + remaining)
                    : null;
            expect(metric.bestPossibleDecisiveWinRate).toBe(bestPossible);
            expect(metric.canStillReach90).toBe(bestPossible === null || bestPossible >= 0.9);
            expect(metric.canStillMeetIntegrityGate).toBe(metric.drawOrArmageddon <= 120);
        }
        expect(
            outcome.frozenCandidate.partialFinalV06AtDeadline.templates.find(
                ({ template }) => template === "melee_magic_utility",
            ),
        ).toMatchObject({ canStillReach90: false });
        expect(
            outcome.frozenCandidate.partialFinalV06AtDeadline.templates.find(
                ({ template }) => template === "mage_fireline",
            ),
        ).toMatchObject({ canStillMeetIntegrityGate: false });
        expect(outcome.frozenCandidate.decision).toMatchObject({
            qualified: false,
            promotionEligible: false,
            releaseEligible: false,
        });
        expect(outcome.frozenCandidate.decision.reasonCodes).toEqual(
            expect.arrayContaining([
                "SELECTION_COHORT_BELOW_TARGET",
                "SELECTION_TEMPLATE_BELOW_TARGET",
                "SELECTION_DRAW_OR_ARMAGEDDON_GATE_FAILED",
                "PRIMARY_FINAL_INCOMPLETE_DEADLINE",
            ]),
        );
    });

    it("preserves the late research win while rejecting it for release", () => {
        const replay = outcome.lateResearchCandidate.cleanReplay;
        expect(fingerprintV0796hGenome(outcome.lateResearchCandidate.genome)).toBe(
            outcome.lateResearchCandidate.genomeId,
        );
        expect(outcome.lateResearchCandidate.genome).toMatchObject({
            gate: 0.025219288749309066,
            horizon: 24,
            rollouts: 4,
            includeMoves: false,
            maxMelee: 9,
            maxShots: 4,
            maxThrows: 4,
        });
        expect(outcome.lateResearchCandidate.genome.leaf?.w).toHaveLength(60);
        expect(outcome.lateResearchCandidate.discovery).toEqual({
            panelId: "g3-mid",
            games: 512,
            artifactSha256: "5783d50cb29e9ab05616ac59525f7f41f972f35feb0f0087ca5169043eb29481",
            auditSha256: "cfe47fafca22bce298fa9bab3f9d64edf1e8ade8b4fb611d6d457760e747cbfb",
            minimumTemplateRate: 0.9464285714285714,
            minimumTemplateLow: 0.8884182369648126,
            maximumDrawOrArmageddonRate: 0.875,
        });
        expect(replay).toMatchObject({
            reportSha256: "70c025ec9c5a5d8fed15cbc1385ac42704e75ea14a329540fe7e185ececc2f2a",
            auditSha256: "e7feb2bab8d1bf7303e904a7720ba6711fdbff6d1d158b3073d84f1931024843",
            gamesPerTemplate: 256,
            totalGames: 2048,
            targetDiagnostics: {
                observed90AllArchetypes: true,
                certified90AllArchetypes: true,
                strict90AllTemplates: true,
            },
            integrity: { maximumDrawOrArmageddonRate: 0.8515625, requiredMaximum: 0.01, passed: false },
        });
        expect(replay.requested).toMatchObject({
            candidate: "v0.7",
            opponent: "v0.6",
            templates: V07_96H_TEMPLATES.map(({ template }) => template),
            gamesPerTemplate: 256,
            concurrency: 12,
            auditTurns: true,
            behaviorEnvironmentSha256: "c455ea2e4be674c0bd4b01ba41486eb1b5b2f71d6fd6efb760ab77784c8af011",
        });
        expect(replay.requested.seeds).toEqual(
            parseJson<{ panels: Record<string, { seeds: Record<string, number> }> }>(seedManifestUrl).panels["g3-deep"]
                .seeds,
        );
        expect(replay.requested.behaviorEnvironment).toEqual({
            SEARCH_AUDIT: "/private/tmp/hoc-v07-salvage.gCtumV/b9ce-g3-deep.audit.jsonl",
            SEARCH_AUDIT_TURNS: "1",
            SEARCH_GATE: String(outcome.lateResearchCandidate.genome.gate),
            SEARCH_HORIZON: String(outcome.lateResearchCandidate.genome.horizon),
            SEARCH_INCLUDE_MOVES: outcome.lateResearchCandidate.genome.includeMoves ? "1" : "0",
            SEARCH_MAX_MELEE: String(outcome.lateResearchCandidate.genome.maxMelee),
            SEARCH_MAX_MOVES: "1",
            SEARCH_MAX_SHOTS: String(outcome.lateResearchCandidate.genome.maxShots),
            SEARCH_MAX_THROWS: String(outcome.lateResearchCandidate.genome.maxThrows),
            SEARCH_ROLLOUTS: String(outcome.lateResearchCandidate.genome.rollouts),
            SEARCH_VERSIONS: "v0.7",
            SIM_NO_ACTIONS: "1",
            V07_SEARCH: "1",
            V07_VALUE_WEIGHTS_V2: JSON.stringify(outcome.lateResearchCandidate.genome.leaf),
        });
        expect(fingerprintV0796h(replay.requested.behaviorEnvironment)).toBe(
            replay.requested.behaviorEnvironmentSha256,
        );
        expect(replay.sourceRevision).toBe("b909e521e96d9cad993e78a77c4a9c6a1e114bc4");
        expect(replay.sourceProvenance).toMatchObject({
            revision: {
                commit: replay.sourceRevision,
                branch: "main",
                trackedClean: true,
                trackedDiffSha256: null,
                worktreeClean: true,
                statusPorcelainSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                untrackedPaths: [],
            },
            revisionAtCompletion: {
                commit: replay.sourceRevision,
                branch: "main",
                trackedClean: true,
                trackedDiffSha256: null,
                worktreeClean: true,
                statusPorcelainSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                untrackedPaths: [],
            },
            revisionStable: true,
        });
        expect(replay.templates.map(({ template }) => template)).toEqual(
            V07_96H_TEMPLATES.map(({ template }) => template),
        );
        expect(replay.templates.every(({ games }) => games === 256)).toBe(true);
        expect(replay.templates.reduce((sum, metric) => sum + metric.games, 0)).toBe(2048);
        expect(replay.templates.reduce((sum, metric) => sum + metric.candidateWins, 0)).toBe(1964);
        expect(replay.templates.reduce((sum, metric) => sum + metric.opponentWins, 0)).toBe(46);
        expect(replay.templates.reduce((sum, metric) => sum + metric.draws, 0)).toBe(38);
        expect(replay.templates.reduce((sum, metric) => sum + metric.candidateRejections, 0)).toBe(0);
        expect(replay.templates.reduce((sum, metric) => sum + metric.opponentRejections, 0)).toBe(0);
        expect(replay.templates.reduce((sum, metric) => sum + metric.missingRejectionCounts, 0)).toBe(0);
        expect(outcome.lateResearchCandidate.decision).toMatchObject({
            qualified: false,
            promotionEligible: false,
            releaseEligible: false,
        });
        expect(outcome.lateResearchCandidate.decision.reasonCodes).toEqual(
            expect.arrayContaining([
                "RESEARCH_PANEL_ONLY",
                "DRAW_OR_ARMAGEDDON_GATE_FAILED",
                "SERVER_300MS_CIRCUIT_DIAGNOSTIC_FAILED",
                "COMMITTED_DEFAULT_ACCEPTANCE_NOT_RUN",
            ]),
        );
    });

    it("keeps match-budget and live circuit diagnostics distinct", () => {
        const latency = outcome.lateResearchCandidate.cleanReplay.latency;
        expect(latency.matchBudget).toEqual({
            requiredMaximumMs: 240_000,
            p95Ms: 18_433.8,
            maxMs: 38_529.6,
            passed: true,
        });
        expect(latency.serverTurnCircuitDiagnostic).toMatchObject({
            serverRevision: "98a1f82daa966e615d2f44e8722e16e9eaa74a43",
            requiredMaximumMs: 300,
            turns: 72_953,
            turnsOverBudget: 26_506,
            gamesWithAtLeastOneOverBudgetTurn: 2048,
            games: 2048,
            p95Ms: 927.3,
            maxMs: 5472.7,
            passed: false,
        });
        expect(latency.serverTurnCircuitDiagnostic.turnsOverBudgetRate).toBe(26_506 / 72_953);
    });

    it("keeps the independent draft PASS scoped away from fight release", () => {
        const acceptance = parseJson<{ candidateId: string; verdict: string }>(draftAcceptanceUrl);
        const projected = parseJson<{
            acceptance: { reportSha256: string };
            authority: IOutcome["independentDraftWin"]["authority"];
            projection: { genomeFingerprint: string };
        }>(projectedDraftUrl);

        expect(rawSha256(draftAcceptanceUrl)).toBe(outcome.independentDraftWin.acceptanceReportSha256);
        expect(outcome.independentDraftWin).toMatchObject({
            scope: "draft_only",
            candidateId: acceptance.candidateId,
            genomeFingerprint: projected.projection.genomeFingerprint,
            acceptanceReportSha256: projected.acceptance.reportSha256,
            verdict: acceptance.verdict,
            authority: projected.authority,
        });
        expect(outcome.independentDraftWin.verdict).toBe("PASS");
        expect(outcome.independentDraftWin.authority).toEqual({
            acceptedForOptIn: true,
            defaultChanged: false,
            productionEnabled: false,
            deployAuthorization: false,
        });
        expect(outcome.authority.acceptedForOptIn).toBe(false);
        expect(outcome.authority.releaseAuthorization).toBe(false);
        expect(outcome.authority.deployAuthorization).toBe(false);
    });
});
