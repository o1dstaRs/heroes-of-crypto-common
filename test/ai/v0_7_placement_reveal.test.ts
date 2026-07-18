/*
 * -----------------------------------------------------------------------------
 * Reveal-conditioned deployment heuristics act only on IPlacementContext.revealedOpponentCreatures — what
 * the seat legitimately learned during picks. The explicit setup policy overrides the legacy environment
 * fallback. Gate off / no reveals / no relevant threat => v0.7's placement stays byte-identical. Gate on:
 * splash reveal -> 2-cell-gap dispersion; >=2 flyers -> shooter screen; charger -> corner shift.
 * -----------------------------------------------------------------------------
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getAIStrategy } from "../../src/ai";
import type { IPlacementContext } from "../../src/ai/ai_strategy";
import type { PlacementPolicyVariant } from "../../src/ai/setup/setup_ship";
import {
    classifyRevealedThreats,
    FLYER_SCREEN_THRESHOLD,
    opponentCreatureIdsForPlacement,
    REVEAL_PLACEMENT_ENV,
} from "../../src/ai/versions/v0_7_placement_reveal";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const CREATURES = PBTypes.CreatureVals;
const v07 = getAIStrategy("v0.7");

const savedGate = process.env[REVEAL_PLACEMENT_ENV];
beforeEach(() => {
    delete process.env[REVEAL_PLACEMENT_ENV];
});
afterEach(() => {
    if (savedGate === undefined) {
        delete process.env[REVEAL_PLACEMENT_ENV];
    } else {
        process.env[REVEAL_PLACEMENT_ENV] = savedGate;
    }
});

interface IPlacementScenario {
    /** Enemy stacks on the board (the omniscient holder view the baked v0.6 trigger uses). */
    enemyAbilities?: string[];
    /** Own army roles. */
    shooters?: number;
    groundMelee?: number;
}

function buildScenario(scenario: IPlacementScenario): {
    units: Unit[];
    context: Omit<IPlacementContext, "publicOpponentCreatureIds" | "revealedOpponentCreatures">;
} {
    const c = createCombatTestContext();
    const enemy = createTestUnit({
        team: UPPER,
        name: "Threat",
        attackType: RANGE,
        abilities: scenario.enemyAbilities ?? [],
        amountAlive: 8,
    });
    c.unitsHolder.addUnit(enemy);
    const units: Unit[] = [];
    for (let i = 0; i < (scenario.shooters ?? 0); i += 1) {
        units.push(createTestUnit({ team: LOWER, name: `S${i}`, attackType: RANGE, rangeShots: 5, amountAlive: 10 }));
    }
    for (let i = 0; i < (scenario.groundMelee ?? 3); i += 1) {
        units.push(createTestUnit({ team: LOWER, name: `M${i}`, attackType: MELEE, amountAlive: 20 }));
    }
    for (const u of units) {
        c.unitsHolder.addUnit(u);
    }
    const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5);
    return {
        units,
        context: {
            team: LOWER,
            grid: c.grid,
            unitsHolder: c.unitsHolder,
            pathHelper: undefined as never,
            placement: zone,
        },
    };
}

/** Placement cells in UNIT ORDER (unit ids are fresh per scenario build, so order is the identity). */
function place(
    scenario: IPlacementScenario,
    revealed?: readonly number[],
    setupPlacementPolicy?: PlacementPolicyVariant,
    publicOpponentCreatureIds?: readonly number[],
): XY[] {
    const { units, context } = buildScenario(scenario);
    const placed = v07.placeArmy(units, {
        ...context,
        ...(revealed ? { revealedOpponentCreatures: revealed } : {}),
        ...(publicOpponentCreatureIds ? { publicOpponentCreatureIds } : {}),
        ...(setupPlacementPolicy ? { setupPlacementPolicy } : {}),
    });
    expect(placed.size).toBe(units.length);
    for (const cell of placed.values()) {
        expect(context.placement.possibleCellHashes().has((cell.x << 4) | cell.y)).toBe(true);
    }
    const keys = [...placed.values()].map((cell) => (cell.x << 4) | cell.y);
    expect(new Set(keys).size).toBe(keys.length);
    return units.map((u) => placed.get(u.getId())!);
}

const samePlacement = (a: XY[], b: XY[]): boolean =>
    a.length === b.length && a.every((cell, index) => b[index].x === cell.x && b[index].y === cell.y);

const minPairChebyshev = (cells: XY[]): number => {
    let min = Infinity;
    for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
            min = Math.min(min, Math.max(Math.abs(cells[i].x - cells[j].x), Math.abs(cells[i].y - cells[j].y)));
        }
    }
    return min;
};

describe("classifyRevealedThreats", () => {
    it("classifies splash AOE, flyers and chargers from the catalog and ignores unknown ids", () => {
        const threats = classifyRevealedThreats([
            CREATURES.GARGANTUAN, // Area Throw -> splash
            CREATURES.CYCLOPS, // Large Caliber -> splash
            CREATURES.GRIFFIN, // flyer
            CREATURES.BLACK_DRAGON, // flyer
            CREATURES.NOMAD, // Rapid Charge -> charger
            999999, // unknown -> ignored
        ]);
        expect(threats.splashAoe).toBe(2);
        expect(threats.flyers).toBe(2);
        expect(threats.chargers).toBe(1);
    });

    it("returns zero threats for an empty or harmless reveal list", () => {
        expect(classifyRevealedThreats([])).toEqual({ splashAoe: 0, flyers: 0, chargers: 0 });
        expect(classifyRevealedThreats([CREATURES.PEASANT])).toEqual({ splashAoe: 0, flyers: 0, chargers: 0 });
    });
});

describe("V07_PLACEMENT_REVEAL gating (byte-identical defaults)", () => {
    it("gate OFF: reveals in the context change nothing", () => {
        const baseline = place({ shooters: 1, groundMelee: 3 });
        const withReveals = place({ shooters: 1, groundMelee: 3 }, [CREATURES.GARGANTUAN, CREATURES.GRIFFIN]);
        expect(samePlacement(baseline, withReveals)).toBe(true);
    });

    it("gate ON without reveals: placement unchanged", () => {
        const baseline = place({ shooters: 1, groundMelee: 3 });
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const gated = place({ shooters: 1, groundMelee: 3 });
        expect(samePlacement(baseline, gated)).toBe(true);
    });

    it("gate ON with only irrelevant reveals: placement unchanged", () => {
        const baseline = place({ shooters: 1, groundMelee: 3 });
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const gated = place({ shooters: 1, groundMelee: 3 }, [CREATURES.PEASANT]);
        expect(samePlacement(baseline, gated)).toBe(true);
    });

    it("explicit baseline overrides an env-on process", () => {
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const baseline = place({ shooters: 1, groundMelee: 3 }, [], "baseline");
        const withFlyerReveals = place(
            { shooters: 1, groundMelee: 3 },
            [CREATURES.GRIFFIN, CREATURES.BLACK_DRAGON],
            "baseline",
        );
        expect(samePlacement(baseline, withFlyerReveals)).toBe(true);
    });

    it("explicit legitimate-reveal overrides an env-off process", () => {
        process.env[REVEAL_PLACEMENT_ENV] = "off";
        const baseline = place({ shooters: 1, groundMelee: 3 }, [], "legitimate-reveal");
        const withFlyerReveals = place(
            { shooters: 1, groundMelee: 3 },
            [CREATURES.GRIFFIN, CREATURES.BLACK_DRAGON],
            "legitimate-reveal",
        );
        expect(samePlacement(baseline, withFlyerReveals)).toBe(false);
    });

    it("legitimate-reveal ignores the full public roster and preserves its partial-reveal behavior", () => {
        const flyers = [CREATURES.GRIFFIN, CREATURES.BLACK_DRAGON];
        const baseline = place({ shooters: 1, groundMelee: 3 }, [], "legitimate-reveal");
        const publicOnly = place({ shooters: 1, groundMelee: 3 }, [], "legitimate-reveal", flyers);

        expect(samePlacement(baseline, publicOnly)).toBe(true);
    });

    it("public-roster is explicit and the new field wins over the legacy alias", () => {
        const scenario = { shooters: 1, groundMelee: 3 };
        const flyers = [CREATURES.GRIFFIN, CREATURES.BLACK_DRAGON];
        const baseline = place(scenario, [], "public-roster", []);
        const publicFlyers = place(scenario, [CREATURES.PEASANT], "public-roster", flyers);
        const emptyPublicOverridesLegacyFlyers = place(scenario, flyers, "public-roster", []);

        expect(samePlacement(baseline, publicFlyers)).toBe(false);
        expect(samePlacement(baseline, emptyPublicOverridesLegacyFlyers)).toBe(true);
    });
});

describe("placement opponent-information source", () => {
    it("selects only the list authorized by the explicit placement policy", () => {
        const { context } = buildScenario({ shooters: 1, groundMelee: 3 });
        const revealed = [CREATURES.PEASANT];
        const publicRoster = [CREATURES.NOMAD];

        expect(
            opponentCreatureIdsForPlacement({
                ...context,
                setupPlacementPolicy: "legitimate-reveal",
                revealedOpponentCreatures: revealed,
                publicOpponentCreatureIds: publicRoster,
            }),
        ).toBe(revealed);
        expect(
            opponentCreatureIdsForPlacement({
                ...context,
                setupPlacementPolicy: "public-roster",
                revealedOpponentCreatures: revealed,
                publicOpponentCreatureIds: publicRoster,
            }),
        ).toBe(publicRoster);
        expect(
            opponentCreatureIdsForPlacement({
                ...context,
                setupPlacementPolicy: "baseline",
                revealedOpponentCreatures: revealed,
                publicOpponentCreatureIds: publicRoster,
            }),
        ).toBeUndefined();
    });
});

describe("V07_PLACEMENT_REVEAL heuristics", () => {
    it("splash present: the baked v0.6 dispersion wins — the reveal layer no-ops (amendment 1)", () => {
        // The real enemy fields Area Throw, so the BAKED v0.6 dispersion (1-cell gap) is the baseline.
        // A reveal-driven wide dispersion measured -14.10pp on the Gargantuan mirror; the guard keeps
        // the treated placement byte-identical to the baked answer.
        const baseline = place({ enemyAbilities: ["Area Throw"], groundMelee: 3 });
        expect(minPairChebyshev(baseline)).toBeGreaterThanOrEqual(2);
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const treated = place({ enemyAbilities: ["Area Throw"], groundMelee: 3 }, [CREATURES.GARGANTUAN]);
        expect(samePlacement(baseline, treated)).toBe(true);
    });

    it("flyer reveal: every shooter gets an adjacent ground-melee bodyguard", () => {
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const flyers = [CREATURES.GRIFFIN, CREATURES.BLACK_DRAGON];
        expect(flyers.length).toBeGreaterThanOrEqual(FLYER_SCREEN_THRESHOLD);
        const { units, context } = buildScenario({ shooters: 2, groundMelee: 3 });
        const placed = v07.placeArmy(units, { ...context, revealedOpponentCreatures: flyers });
        const shooterCells = units.filter((u) => u.getAttackType() === RANGE).map((u) => placed.get(u.getId())!);
        const meleeCells = units.filter((u) => u.getAttackType() === MELEE).map((u) => placed.get(u.getId())!);
        for (const shooter of shooterCells) {
            const guarded = meleeCells.some(
                (guard) => Math.max(Math.abs(guard.x - shooter.x), Math.abs(guard.y - shooter.y)) === 1,
            );
            expect(guarded).toBe(true);
        }
    });

    it("charger reveal: the formation compacts toward the low-x corner", () => {
        const baseline = place({ shooters: 1, groundMelee: 4 });
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const treated = place({ shooters: 1, groundMelee: 4 }, [CREATURES.NOMAD]);
        const meanX = (cells: XY[]): number => cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length;
        expect(meanX(treated)).toBeLessThan(meanX(baseline));
    });

    it("precedence: an actual splash enemy blocks the flyer screen (no adjacency rebuilt)", () => {
        const baseline = place({ enemyAbilities: ["Area Throw"], shooters: 1, groundMelee: 3 });
        process.env[REVEAL_PLACEMENT_ENV] = "on";
        const treated = place({ enemyAbilities: ["Area Throw"], shooters: 1, groundMelee: 3 }, [
            CREATURES.GARGANTUAN,
            CREATURES.GRIFFIN,
            CREATURES.BLACK_DRAGON,
        ]);
        // The baked dispersion wins: the screen would rebuild exactly the adjacency the gap removes.
        expect(samePlacement(baseline, treated)).toBe(true);
        expect(minPairChebyshev(treated)).toBeGreaterThanOrEqual(2);
    });
});
