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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    draftGenomeCreatureScore,
    embedIntrinsicDraftWeights,
    parseDraftGenome,
    projectDraftGenomeForShipping,
} from "../../src/ai/setup/draft_ship";
import { DRAFT_ANCHOR_W, DRAFT_FEATURE_DIM, scoreCreatureWeighted } from "../../src/ai/setup/creature_score";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    createLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_DIM,
    LEAGUE_GENOME_LAYOUT,
} from "../../src/simulation/league_genome";

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
