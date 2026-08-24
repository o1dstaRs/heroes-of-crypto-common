import { describe, expect, test } from "bun:test";

import CREATURES_JSON from "../../src/configuration/creatures.json";
import {
    creatureIdForName,
    creatureInfo,
    creatureFeatures,
    DRAFT_ANCHOR_W,
    DRAFT_FEATURE_DIM,
    DRAFT_FEATURE_NAMES,
    scoreCreature,
    scoreCreatureWeighted,
} from "../../src/ai/setup/creature_score";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const catalog = CREATURES_JSON as unknown as Record<string, Record<string, { size?: number }>>;

/** Every catalog entry that the draft index can actually address, as (faction, name, id) triples. */
const indexedCreatures = (): { factionName: string; creatureName: string; creatureId: number }[] => {
    const out: { factionName: string; creatureName: string; creatureId: number }[] = [];
    for (const [factionName, creatures] of Object.entries(catalog)) {
        if (!creatures || typeof creatures !== "object") continue;
        for (const creatureName of Object.keys(creatures)) {
            const creatureId = creatureIdForName(creatureName);
            if (creatureId !== undefined) out.push({ factionName, creatureName, creatureId });
        }
    }
    return out;
};

describe("draft-time creature footprint", () => {
    // The whole point of putting a footprint on ICreatureInfo is that a placement policy holding only a
    // creature id can reason about shape. That is worth nothing unless it is the SAME shape the engine will
    // build the Unit with, so pin the two derivations against each other for the entire catalog rather than
    // spot-checking a couple of creatures: an AI that plans on a shape the engine disagrees with proposes
    // illegal anchors, and the engine rejects them.
    test("matches the shape UnitProperties derives, for every creature in the catalog", () => {
        const creatures = indexedCreatures();
        expect(creatures.length).toBeGreaterThan(0);

        for (const { factionName, creatureName, creatureId } of creatures) {
            const info = creatureInfo(creatureId);
            expect(info).toBeDefined();

            const properties = getCreatureConfig(
                PBTypes.TeamVals.LOWER,
                factionName,
                creatureName,
                `${creatureName.replace(/\s+/g, "_")}_512`,
                1,
            );

            expect({
                creatureName,
                width: info!.footprintWidth,
                height: info!.footprintHeight,
            }).toEqual({
                creatureName,
                width: properties.footprint_width,
                height: properties.footprint_height,
            });
        }
    });

    // Today's roster is entirely square, so this doubles as the "no behaviour moved" guard: if a rectangle
    // ever lands in creatures.json this test is the intended place to notice it, not a live ranked match.
    test("reports the legacy square shapes as exactly size x size", () => {
        for (const { factionName, creatureName, creatureId } of indexedCreatures()) {
            const size = catalog[factionName][creatureName].size ?? 1;
            const info = creatureInfo(creatureId)!;
            expect({ creatureName, width: info.footprintWidth, height: info.footprintHeight }).toEqual({
                creatureName,
                width: size,
                height: size,
            });
            expect(size === 1 || size === 2).toBeTrue();
        }
    });

    // A footprint is a cost-and-value signal, but pricing it is a balance decision. The baked draft vectors
    // (DRAFT_ANCHOR_W, DEFAULT_DRAFT_W, every trained genome) are fit on this exact 11-dim basis, so adding a
    // shape term here would silently invalidate all of them. Keep the metadata out of the feature vector.
    test("keeps footprint out of the trained draft feature basis", () => {
        expect(DRAFT_FEATURE_DIM).toBe(11);
        expect(DRAFT_FEATURE_NAMES.some((name) => name.toLowerCase().includes("footprint"))).toBeFalse();
        expect(DRAFT_ANCHOR_W.length).toBe(DRAFT_FEATURE_DIM);

        for (const { creatureId } of indexedCreatures()) {
            expect(creatureFeatures(creatureId).length).toBe(DRAFT_FEATURE_DIM);
            // DRAFT_ANCHOR_W is defined as the exact linear restatement of the heuristic; a shape term
            // leaking into either side would break that identity first.
            expect(Math.round(scoreCreatureWeighted(creatureId, DRAFT_ANCHOR_W))).toBe(scoreCreature(creatureId));
        }
    });
});
