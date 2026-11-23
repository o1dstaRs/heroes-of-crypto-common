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

import { describe, expect, test } from "bun:test";

import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import {
    A19_LAVA_MAP_ARTIFACT_POLICY,
    a19LavaMapOffer,
    a19LavaMapTier2Artifact,
    a19MapHasLava,
} from "../../src/ai/setup/a19_lava_map_artifact";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { createTier2ArtifactDecisionContext } from "../../src/ai/setup/setup_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const id = (name: string): number => {
    const found = creatureIdForName(name);
    if (found === undefined) throw new Error(`unknown creature ${name}`);
    return found;
};
const STRIKERS = [id("Wolf"), id("Hyena"), id("Mantis"), id("Valkyrie")];
const context = (gridType?: number) =>
    createTier2ArtifactDecisionContext({
        publicOpponentCreatureIds: [],
        ...(gridType !== undefined ? { gridType, gridSize: 16 } : {}),
    });
/** A stand-in for the seat's own policy: the first artifact it is offered. */
const first = (offer: readonly number[]): number => offer[0];

describe("a19-lava-map-artifact-v1", () => {
    test("identity and the maps with lava", () => {
        expect(A19_LAVA_MAP_ARTIFACT_POLICY).toBe("a19-lava-map-artifact-v1");
        expect(a19MapHasLava(PBTypes.GridVals.LAVA_CENTER)).toBe(true);
        expect(a19MapHasLava(PBTypes.GridVals.NORMAL)).toBe(false);
        expect(a19MapHasLava(PBTypes.GridVals.BLOCK_CENTER)).toBe(false);
        expect(a19MapHasLava(undefined)).toBeUndefined();
    });

    test("without lava, Lava Striders leaves the offer while a usable artifact remains", () => {
        const offer = [Tier2Artifact.LAVA_STRIDERS, Tier2Artifact.PENDANT_OF_VITALITY];
        for (const map of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.BLOCK_CENTER]) {
            expect(a19LavaMapOffer(offer, STRIKERS, context(map))).toEqual([Tier2Artifact.PENDANT_OF_VITALITY]);
            expect(a19LavaMapTier2Artifact(offer, STRIKERS, context(map), first)).toBe(
                Tier2Artifact.PENDANT_OF_VITALITY,
            );
        }
        // Nothing else on offer, or only an artifact the army cannot use: the offer stands.
        expect(a19LavaMapOffer([Tier2Artifact.LAVA_STRIDERS], STRIKERS, context(PBTypes.GridVals.NORMAL))).toEqual([
            Tier2Artifact.LAVA_STRIDERS,
        ]);
        const quiver = [Tier2Artifact.LAVA_STRIDERS, Tier2Artifact.FARSIGHT_QUIVER];
        expect(
            a19LavaMapOffer(quiver, STRIKERS, { gridType: PBTypes.GridVals.NORMAL, ownProspectiveCreatureIds: [] }),
        ).toEqual(quiver);
    });

    test("the lava map and an unknown map leave the seat's own choice", () => {
        const offer = [Tier2Artifact.TITAN_PLATE, Tier2Artifact.LAVA_STRIDERS];
        for (const map of [context(PBTypes.GridVals.LAVA_CENTER), context()]) {
            expect(a19LavaMapOffer(offer, STRIKERS, map)).toEqual(offer);
            expect(a19LavaMapTier2Artifact(offer, STRIKERS, map, first)).toBe(Tier2Artifact.TITAN_PLATE);
            expect(a19LavaMapTier2Artifact([...offer].reverse(), STRIKERS, map, first)).toBe(
                Tier2Artifact.LAVA_STRIDERS,
            );
        }
    });
});
