/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    draftGenomeCreatureScore,
    embedIntrinsicDraftWeights,
    LEAGUE_ROUND1_DRAFT_CANDIDATE_SPEC,
    LEAGUE_ROUND3_DRAFT_SPEC,
    parseDraftGenome,
    projectDraftGenomeForShipping,
} from "../../src/ai/setup/draft_ship";
import { DRAFT_ANCHOR_W, DRAFT_FEATURE_DIM, scoreCreatureWeighted } from "../../src/ai/setup/creature_score";
import leagueRound1CandidateGenome from "../../src/ai/setup/draft_genomes/league_round1_br_57de5a2d_candidate.json";
import leagueRound3ProjectedGenome from "../../src/ai/setup/draft_genomes/league_round3_br_52752642_projected.json";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    createLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_DIM,
    LEAGUE_GENOME_LAYOUT,
} from "../../src/simulation/league_genome";
import { leagueGenomeFingerprint } from "../../src/simulation/optimizer/league_cycle_core";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("draft ship genome", () => {
    it("embeds legacy intrinsic weights without changing setup-v0 heads", () => {
        const embedded = embedIntrinsicDraftWeights(DRAFT_ANCHOR_W);
        expect(embedded).toHaveLength(LEAGUE_GENOME_DIM);
        expect(embedded).toEqual([...LEAGUE_ANCHOR_GENOME]);

        const creatureId = PBTypes.CreatureVals.ARBALESTER;
        const genome = createLeagueGenome("intrinsic", embedded);
        expect(draftGenomeCreatureScore(genome, creatureId)).toBe(scoreCreatureWeighted(creatureId, DRAFT_ANCHOR_W));
        expect(() => embedIntrinsicDraftWeights(new Array(DRAFT_FEATURE_DIM - 1).fill(0))).toThrow(RangeError);
        expect(() => embedIntrinsicDraftWeights([...DRAFT_ANCHOR_W.slice(0, -1), Number.NaN])).toThrow(TypeError);
    });

    it("parses named, inline and file artifacts and rejects non-deployable metadata", () => {
        expect(parseDraftGenome("anchor").weights).toEqual([...LEAGUE_ANCHOR_GENOME]);
        expect(parseDraftGenome("default").weights.slice(0, DRAFT_FEATURE_DIM)).not.toEqual(DRAFT_ANCHOR_W);

        const inline = parseDraftGenome(JSON.stringify({ id: "inline", schemaVersion: 1, weights: DRAFT_ANCHOR_W }));
        expect(inline.id).toBe("inline");
        expect(inline.weights).toEqual([...LEAGUE_ANCHOR_GENOME]);

        const directory = mkdtempSync(join(tmpdir(), "hoc-draft-ship-"));
        temporaryDirectories.push(directory);
        writeFileSync(join(directory, "champion.json"), JSON.stringify({ id: "file", weights: LEAGUE_ANCHOR_GENOME }));
        expect(parseDraftGenome("champion.json", "fallback", directory).id).toBe("file");

        expect(() => parseDraftGenome(JSON.stringify({ schemaVersion: 2, weights: LEAGUE_ANCHOR_GENOME }))).toThrow(
            "Unsupported draft genome schema 2",
        );
        expect(() =>
            parseDraftGenome(JSON.stringify({ omniscientDraft: true, weights: LEAGUE_ANCHOR_GENOME })),
        ).toThrow("cannot use omniscientDraft");
        expect(() => parseDraftGenome(JSON.stringify({ id: 7, weights: LEAGUE_ANCHOR_GENOME }))).toThrow(
            "id must be a non-empty string",
        );
    });

    it("exposes the accepted League round-3 projection as an explicit opt-in", () => {
        const accepted = parseDraftGenome(LEAGUE_ROUND3_DRAFT_SPEC);
        const intrinsicEnd = LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset + LEAGUE_GENOME_LAYOUT.draftIntrinsic.length;
        const resultSha256 = (name: string): string =>
            createHash("sha256")
                .update(readFileSync(new URL(`../../src/simulation/results/${name}`, import.meta.url)))
                .digest("hex");
        const acceptance = JSON.parse(
            readFileSync(
                new URL("../../src/simulation/results/draft_league_round3_v0_7_acceptance.json", import.meta.url),
                "utf8",
            ),
        ) as { verdict: string; gates: { passed: boolean }[]; report: { options: { baseSeed: number } } };

        expect(accepted.id).toBe("br-52752642d16db7f4");
        expect(leagueGenomeFingerprint(accepted)).toBe(
            "92ee7737d5d31f4c1ef94299cb31180c3f9e3eb50eea5c1b80647eb12beff9eb",
        );
        // `projectDraftGenomeForShipping` re-pins every non-intrinsic head to the CURRENT `LEAGUE_ANCHOR_GENOME`
        // (draft_ship.ts: `weights = [...LEAGUE_ANCHOR_GENOME]`, only the intrinsic slice is spliced in from
        // the input genome) — so re-projecting the (frozen, point-in-time) accepted genome is idempotent ONLY
        // as long as setup-v0's artifact tables haven't moved since acceptance. After the 2026-07-15 blind-table
        // refresh (setup_strategy.ts TIER1/TIER2_ARTIFACT_WINRATE) it is no longer byte-identical to `accepted`
        // — intrinsic (draft) weights still round-trip unchanged; the tail now re-projects onto the NEW anchor.
        const projected = projectDraftGenomeForShipping(accepted);
        expect(projected.weights.slice(0, intrinsicEnd)).toEqual(accepted.weights.slice(0, intrinsicEnd));
        expect(projected.weights.slice(intrinsicEnd)).toEqual(LEAGUE_ANCHOR_GENOME.slice(intrinsicEnd));
        // Frozen snapshot of the setup-v0 anchor tail AS IT WAS at this genome's acceptance (not a live
        // `LEAGUE_ANCHOR_GENOME` reference): the accepted genome itself is a point-in-time file
        // (draft_genomes/league_round3_br_52752642_projected.json) that stays reproducible even after
        // setup-v0's tables are later refreshed — `accepted` is loaded straight off that JSON (never
        // re-projected in `parseDraftGenome`'s league-r3 branch), so its OWN weights are untouched by the
        // refresh; this assertion documents what the anchor equalled when the genome was accepted.
        // prettier-ignore
        const acceptanceTimeAnchorTail = [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            61.1, 44.4, 53.2, 53.3, 47.1, 45.5, 45.4, 43.4, 62.4, 49.5, 44.3, 50.2,
            68.3, 71, 41.1, 65.4, 43.1, 45.8, 36.6, 62.5, 36.8, 41.7, 44.5, 42,
            19, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 0, 0, 0,
            1, 0, 0, 0, 0, 0, 0,
            6, 5, 7,
        ];
        expect(accepted.weights.slice(intrinsicEnd)).toEqual(acceptanceTimeAnchorTail);
        expect(acceptanceTimeAnchorTail).toHaveLength(LEAGUE_ANCHOR_GENOME.length - intrinsicEnd);
        expect(accepted.omniscientDraft).toBeUndefined();
        expect(parseDraftGenome("default").weights).not.toEqual(accepted.weights);
        expect(leagueRound3ProjectedGenome.acceptance.verdict).toBe("PASS");
        expect(resultSha256("draft_league_round3_v0_7_acceptance.json")).toBe(
            leagueRound3ProjectedGenome.acceptance.reportSha256,
        );
        expect(resultSha256("draft_league_round3_seed_audit.json")).toBe(
            leagueRound3ProjectedGenome.acceptance.seedAuditSha256,
        );
        expect(resultSha256("draft_league_round3_projection_audit.json")).toBe(
            leagueRound3ProjectedGenome.projection.auditSha256,
        );
        expect(acceptance.verdict).toBe("PASS");
        expect(acceptance.gates.every(({ passed }) => passed)).toBe(true);
        expect(acceptance.report.options.baseSeed).toBe(leagueRound3ProjectedGenome.acceptance.baseSeed);
        expect(leagueRound3ProjectedGenome.authority).toEqual({
            acceptedForOptIn: true,
            defaultChanged: false,
            productionEnabled: false,
            deployAuthorization: false,
        });
    });

    it("exposes the round-1 candidate for reproducible research without granting ranked authority", () => {
        const candidate = parseDraftGenome(LEAGUE_ROUND1_DRAFT_CANDIDATE_SPEC);

        expect(candidate.id).toBe("br-57de5a2dab8b27b5");
        expect(candidate.omniscientDraft).toBeUndefined();
        expect(leagueGenomeFingerprint(candidate)).toBe(
            "4664fbb0b8238e3db08254774ee3da774c290cd9b0a1f039ef6e923b48072a9f",
        );
        expect(leagueRound1CandidateGenome.projection.genomeFingerprint).toBe(leagueGenomeFingerprint(candidate));
        expect(leagueRound1CandidateGenome.status).toBe("research_candidate");
        expect(leagueRound1CandidateGenome.source.sourceArtifactSha256).toBe(
            "3a9a109477a540f7da9806b9cb48e594685c6581c63f67deed8c226c7661a3aa",
        );
        expect(leagueRound1CandidateGenome.acceptance.status).toBe("not_evaluated");
        expect(leagueRound1CandidateGenome.authority).toEqual({
            researchOnly: true,
            acceptedForRankedOptIn: false,
            defaultChanged: false,
            productionEnabled: false,
            deployAuthorization: false,
        });
    });

    it("projects exactly the intrinsic head and freezes every non-consumed head", () => {
        const intrinsicEnd = LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset + LEAGUE_GENOME_LAYOUT.draftIntrinsic.length;
        const weights = [...LEAGUE_ANCHOR_GENOME];
        weights[LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset + DRAFT_FEATURE_DIM] = 123;
        weights.fill(456, intrinsicEnd);

        const projected = projectDraftGenomeForShipping(createLeagueGenome("candidate", weights));
        expect(projected.weights.slice(0, intrinsicEnd)).toEqual(weights.slice(0, intrinsicEnd));
        expect(projected.weights.slice(intrinsicEnd)).toEqual(LEAGUE_ANCHOR_GENOME.slice(intrinsicEnd));
        expect(projected.omniscientDraft).toBeUndefined();
        expect(() => projectDraftGenomeForShipping(createLeagueGenome("oracle", weights, true))).toThrow(
            "cannot use omniscientDraft",
        );
    });
});
