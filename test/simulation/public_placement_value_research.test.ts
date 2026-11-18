import { describe, expect, test } from "bun:test";
import { buildPlacementInput } from "../../src/ai/placement/adapter";
import { cells, propose, valid, type Point } from "../../src/ai/placement/layout";
import { relationFeatures } from "../../src/ai/placement/relations";
import { creatureIdForName, creatureInfo } from "../../src/ai/setup/creature_score";
import { draftSynergyEffects, DRAFT_BATTLEFIELD_FACTIONS } from "../../src/ai/setup/draft_battlefield_context";
import {
    normalizePublicPlacementValueContext,
    publicPlacementValueFeatures,
    publicPlacementValueProposals,
    publicPlacementValueRayBits,
    PUBLIC_PLACEMENT_VALUE_FEATURE_COUNT,
    type IPublicPlacementValueContext,
} from "../../src/simulation/public_placement_value_research";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../../src/utils/lib";

function fixture(): { context: IPublicPlacementValueContext; reference: Point[] } {
    const names = ["Orc", "Wandering Mage", "Satyr", "Beholder", "Cyclops", "Magic Dragon"];
    const units = names.map((name, index) => {
        const info = creatureInfo(creatureIdForName(name)!)!;
        return {
            getId: () => `own-${index}`,
            getName: () => name,
            getAmountAlive: () => Math.ceil(1000 / info.exp),
            getFootprintWidth: () => info.footprintWidth,
            getFootprintHeight: () => info.footprintHeight,
        };
    });
    const legal = Array.from({ length: 64 }, (_, index) => Math.floor(index / 16) * 16 + (index % 16));
    const input = buildPlacementInput(units, {
        team: 2,
        gridType: 4,
        sideOrientedPlacement: true,
        legalCellHashes: new Set(legal),
        publicOpponentCreatureIds: ["Peasant", "Arbalester", "Troll", "Crusader", "Zena", "Thunderbird"].map((name) =>
            creatureIdForName(name)!,
        ),
        artifacts: [1, 2],
        doctrine: 3,
        augments: [
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 1 },
            { kind: "Sniper", value: 3 },
            { kind: "Placement", value: 0 },
            { kind: "Movement", value: 0 },
            { kind: "Empower", value: 0 },
        ],
    });
    if (!input) throw new Error("Native fixture is outside the learned model domain");
    const variants = { Life: 1 as const, Chaos: 1 as const, Might: 1 as const, Nature: 1 as const };
    const own = draftSynergyEffects(
        input.bodies.map((body) => body.creature),
        variants,
    );
    const context: IPublicPlacementValueContext = {
        input,
        neutralCells: [
            { x: 6, y: 6 },
            { x: 8, y: 8 },
            { x: 10, y: 11 },
        ],
        synergyVariants: variants,
        ownActiveSynergies: DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction, index) =>
            own.levels[index] ? [`${faction}:1:${own.levels[index]}`] : [],
        ),
        positiveAuraRanges: units.map((_, index) => (index === 2 ? [2] : [])),
    };
    const occupied = new Set<number>();
    const reference = input.bodies.map((body) => {
        for (const key of legal) {
            const point = { x: key >> 4, y: key & 15 },
                footprint = cells(body, point);
            if (
                footprint.some(
                    (cell) =>
                        cell.x < 0 ||
                        cell.y < 0 ||
                        !legal.includes(cell.x * 16 + cell.y) ||
                        occupied.has(cell.x * 16 + cell.y),
                )
            )
                continue;
            for (const cell of footprint) occupied.add(cell.x * 16 + cell.y);
            return point;
        }
        throw new Error("No legal complete native fixture formation");
    });
    expect(valid(input, reference)).toBe(true);
    return { context, reference };
}

describe("public-context placement value research", () => {
    test("keeps the exact old relation feature prefix and has a finite fixed context schema", () => {
        const { context, reference } = fixture();
        const features = publicPlacementValueFeatures(context, reference, reference);
        expect(features.length).toBe(PUBLIC_PLACEMENT_VALUE_FEATURE_COUNT);
        expect(features.every(Number.isFinite)).toBe(true);
        expect(features.slice(0, 2138)).toEqual(relationFeatures(context.input, reference, reference));
    });

    test("native reconstruction preserves all proposals across sorted-key transport", () => {
        const { context, reference } = fixture();
        const transport = JSON.parse(
            JSON.stringify(context, (_key, value) =>
                value && !Array.isArray(value) && typeof value === "object"
                    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
                    : value,
            ),
        );
        const original = publicPlacementValueProposals(context, reference);
        expect(publicPlacementValueProposals(transport, reference)).toEqual(original);
        expect(publicPlacementValueFeatures(transport, original[4], reference)).toEqual(
            publicPlacementValueFeatures(context, original[4], reference),
        );
        const restored = normalizePublicPlacementValueContext(transport);
        for (let index = 0; index < 8; index++)
            expect(propose(restored.input, reference, index)).toEqual(original[index]);
    });

    test("unit IDs do not enter tensor values or proposal randomness", () => {
        const { context, reference } = fixture();
        const renamed = structuredClone(context);
        renamed.input.bodies.forEach((body, index) => {
            body.id = `unrelated-public-id-${1000 + index}`;
        });
        expect(publicPlacementValueFeatures(renamed, reference, reference)).toEqual(
            publicPlacementValueFeatures(context, reference, reference),
        );
        expect(publicPlacementValueProposals(renamed, reference)).toEqual(
            publicPlacementValueProposals(context, reference),
        );
    });

    test("public neutral layout and active synergy choices change the new context features", () => {
        const { context, reference } = fixture();
        const base = publicPlacementValueFeatures(context, reference, reference);
        const terrain = structuredClone(context);
        terrain.neutralCells[0].y++;
        const changed = publicPlacementValueFeatures(terrain, reference, reference);
        expect(changed.slice(0, 2138)).toEqual(base.slice(0, 2138));
        expect(changed).not.toEqual(base);
        const synergy = structuredClone(context);
        const [faction, , level] = synergy.ownActiveSynergies[0].split(":");
        synergy.synergyVariants[faction as keyof typeof synergy.synergyVariants] = 2;
        synergy.ownActiveSynergies[0] = `${faction}:2:${level}`;
        expect(publicPlacementValueFeatures(synergy, reference, reference).slice(0, 2138)).toEqual(base.slice(0, 2138));
        expect(publicPlacementValueFeatures(synergy, reference, reference)).not.toEqual(base);
    });

    test("a public neutral wall blocks every ranged hypothetical ray using the native coordinate transform", () => {
        const { context, reference } = fixture();
        context.neutralCells = Array.from({ length: 16 }, (_, y) => ({ x: 6, y }));
        const bits = publicPlacementValueRayBits(context, reference);
        for (let index = 0; index < 12; index++) {
            expect(bits.slice(index * 14, index * 14 + 14)).toEqual(
                Array(14).fill(Number(context.input.bodies[index]?.ranged ?? false)),
            );
        }
        expect(bits.reduce((sum, bit) => sum + bit, 0)).toBeGreaterThan(0);
    });

    test("canonical owner-side reflection preserves the complete tensor", () => {
        const { context, reference } = fixture();
        const mirror = structuredClone(context);
        mirror.input.left = false;
        mirror.input.legal = mirror.input.legal.map((key) => (15 - (key >> 4)) * 16 + (key & 15));
        mirror.neutralCells = mirror.neutralCells.map((cell) => ({ x: 15 - cell.x, y: cell.y }));
        const reflected = reference.map((point, index) => ({
            x: 15 - point.x + context.input.bodies[index].width - 1,
            y: point.y,
        }));
        expect(publicPlacementValueFeatures(mirror, reflected, reflected)).toEqual(
            publicPlacementValueFeatures(context, reference, reference),
        );
    });

    test("feature and proposal extraction leave the input and native RNG/UUID scope untouched", () => {
        const { context, reference } = fixture(),
            before = structuredClone(context);
        const previous = captureDeterministicRandomState();
        let draws = 0;
        try {
            setDeterministicRandomSource(() => {
                draws++;
                return 0.75;
            });
            const scoped = captureDeterministicRandomState();
            const proposals = publicPlacementValueProposals(context, reference);
            for (const points of proposals) publicPlacementValueFeatures(context, points, reference);
            expect(captureDeterministicRandomState()).toEqual(scoped);
            expect(draws).toBe(0);
            expect(context).toEqual(before);
        } finally {
            restoreDeterministicRandomState(previous);
        }
    });

    test("hidden states, identities and future outcomes are rejected outside the public envelope", () => {
        const { context, reference } = fixture();
        for (const field of [
            "enemyDoctrine",
            "enemyPositions",
            "enemyAmounts",
            "setupSeed",
            "searchSeed",
            "family",
            "gameId",
            "outcome",
            "futureActions",
        ]) {
            expect(() => publicPlacementValueFeatures({ ...context, [field]: 123 }, reference, reference)).toThrow(
                "unexpected fields",
            );
            expect(() =>
                publicPlacementValueFeatures(
                    { ...context, input: { ...context.input, [field]: 123 } },
                    reference,
                    reference,
                ),
            ).toThrow("unexpected fields");
        }
    });

    test("invalid native catalog values, active variants and untrusted layouts fail closed", () => {
        const { context, reference } = fixture();
        const stale = structuredClone(context);
        stale.input.bodies[0].hp++;
        expect(() => publicPlacementValueFeatures(stale, reference, reference)).toThrow("catalog mismatch");
        const invalid = structuredClone(context);
        invalid.ownActiveSynergies[0] = invalid.ownActiveSynergies[0].replace(":1:", ":2:");
        expect(() => publicPlacementValueFeatures(invalid, reference, reference)).toThrow("active synergy");
        const duplicate = structuredClone(context);
        duplicate.neutralCells.push(duplicate.neutralCells[0]);
        expect(() => normalizePublicPlacementValueContext(duplicate)).toThrow("duplicate neutral");
        const nan = structuredClone(context);
        nan.positiveAuraRanges[0] = [NaN];
        expect(() => normalizePublicPlacementValueContext(nan)).toThrow("aura ranges");
        const collision = structuredClone(context);
        collision.neutralCells = [cells(collision.input.bodies[0], reference[0])[0]];
        expect(() => publicPlacementValueProposals(collision, reference)).toThrow("neutral terrain");
        const unsupported = structuredClone(context);
        unsupported.input.doctrine = 2;
        expect(() => normalizePublicPlacementValueContext(unsupported)).toThrow("native model domain");
    });
});
