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

const FOOTPRINT_OVERRIDE_ENV = "HOC_FOOTPRINT_OVERRIDES";

/**
 * Run with an explicit override string, or with overrides definitively off. Both directions are set here
 * rather than assumed, because these tests are also run from harnesses that export HOC_FOOTPRINT_OVERRIDES
 * for the whole process — a "shipped roster is square" assertion that silently inherits a rectangle from the
 * ambient environment would be reporting on a board nobody configured.
 */
const withFootprintOverrides = <T>(overrides: string, run: () => T): T => {
    const previous = process.env[FOOTPRINT_OVERRIDE_ENV];
    if (overrides) {
        process.env[FOOTPRINT_OVERRIDE_ENV] = overrides;
    } else {
        delete process.env[FOOTPRINT_OVERRIDE_ENV];
    }
    try {
        return run();
    } finally {
        if (previous === undefined) {
            delete process.env[FOOTPRINT_OVERRIDE_ENV];
        } else {
            process.env[FOOTPRINT_OVERRIDE_ENV] = previous;
        }
    }
};

describe("draft-time creature footprint", () => {
    // The whole point of putting a footprint on ICreatureInfo is that a placement policy holding only a
    // creature id can reason about shape. That is worth nothing unless it is the SAME shape the engine will
    // build the Unit with, so pin the two derivations against each other for the entire catalog rather than
    // spot-checking a couple of creatures: an AI that plans on a shape the engine disagrees with proposes
    // illegal anchors, and the engine rejects them.
    const expectCatalogWideParity = (): void => {
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
    };

    test("matches the shape UnitProperties derives, for every creature in the catalog", () => {
        withFootprintOverrides("", expectCatalogWideParity);
    });

    // Same pin, with rectangles in play: parity that only holds for squares would not have caught anything.
    test("matches the shape UnitProperties derives while a footprint override is active", () => {
        withFootprintOverrides("White Tiger=2x1,Hyena=1x2", expectCatalogWideParity);
    });

    // The mounted class ships 2x1 (Point X3), so draft-time shapes must track the DECLARED footprint and
    // fall back to size x size only where nothing is declared. This is the guard that noticed the first
    // shipped rectangles, exactly as its previous wording promised.
    test("reports the declared shapes: rectangles from creatures.json, squares from size", () => {
        withFootprintOverrides("", () => {
            for (const { factionName, creatureName, creatureId } of indexedCreatures()) {
                const config = catalog[factionName][creatureName] as {
                    size?: number;
                    footprint_width?: number;
                    footprint_height?: number;
                };
                const size = config.size ?? 1;
                const info = creatureInfo(creatureId)!;
                expect({ creatureName, width: info.footprintWidth, height: info.footprintHeight }).toEqual({
                    creatureName,
                    width: config.footprint_width ?? size,
                    height: config.footprint_height ?? size,
                });
                expect(size === 1 || size === 2).toBeTrue();
            }
        });
    });

    // HOC_FOOTPRINT_OVERRIDES is the only thing that puts a rectangle on the board today, so it is also the
    // only configuration in which a draft-time footprint can be WRONG. Reading creatures.json directly would
    // pass every assertion above and still hand the placement policies a 1x1 White Tiger that the engine then
    // places as a 2x1 — the anchor is then chosen for a body one column too narrow, and the engine rejects it.
    test("follows a QA footprint override, in both axes, and reverts when it is removed", () => {
        const whiteTiger = creatureIdForName("White Tiger")!;
        const berserker = creatureIdForName("Berserker")!;
        const peasant = creatureIdForName("Peasant")!;

        withFootprintOverrides("Peasant=2x1,Berserker=1x2,White Tiger=1x1", () => {
            const peasantInfo = creatureInfo(peasant)!;
            expect([peasantInfo.footprintWidth, peasantInfo.footprintHeight]).toEqual([2, 1]);
            // The transpose is asserted separately: an axis swap is the single most likely bug here, and one
            // orientation on its own cannot see it.
            const berserkerInfo = creatureInfo(berserker)!;
            expect([berserkerInfo.footprintWidth, berserkerInfo.footprintHeight]).toEqual([1, 2]);
            // An override also RESHAPES a shipped rectangle, not only a square.
            const tiger = creatureInfo(whiteTiger)!;
            expect([tiger.footprintWidth, tiger.footprintHeight]).toEqual([1, 1]);
        });

        // The index is cached for the process, so a stale entry would keep reporting the override after it
        // is gone — which in a multi-file test run means one harness reshaping another's board. Reverting
        // must restore the SHIPPED shapes: White Tiger's declared 2x1, Peasant's square.
        withFootprintOverrides("", () => {
            const tiger = creatureInfo(whiteTiger)!;
            expect([tiger.footprintWidth, tiger.footprintHeight]).toEqual([2, 1]);
            const peasantInfo = creatureInfo(peasant)!;
            expect([peasantInfo.footprintWidth, peasantInfo.footprintHeight]).toEqual([1, 1]);
        });
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
