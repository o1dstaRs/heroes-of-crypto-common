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

import { describe, expect, it } from "bun:test";

import {
    getAbilityConfig,
    getAuraEffectConfig,
    getCreatureConfig,
    getEffectConfig,
    getSpellConfig,
} from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import * as GridMath from "../../src/grid/grid_math";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { testGridSettings } from "../helpers/combat";

describe("EffectFactory", () => {
    const factory = new EffectFactory();
    it("makes effects and auras from valid names", () => {
        expect(factory.makeEffect("Stun")).toBeDefined();
        expect(factory.makeAuraEffect("Luck")).toBeDefined();
    });
    it("returns undefined for null / unknown names", () => {
        expect(factory.makeEffect(null)).toBeUndefined();
        expect(factory.makeEffect("__nope__")).toBeUndefined();
        expect(factory.makeAuraEffect(null)).toBeUndefined();
        expect(factory.makeAuraEffect("__nope__")).toBeUndefined();
    });
});

describe("SceneLogMock", () => {
    it("implements the no-op scene log interface", () => {
        const log = new SceneLogMock();
        log.updateLog("anything");
        log.updateLog();
        expect(log.getLog()).toBe("");
        expect(log.hasBeenUpdated()).toBe(false);
    });
});

describe("config_provider getters and error paths", () => {
    it("resolves valid effect/aura configs and undefined for unknown ones", () => {
        expect(getEffectConfig("Stun")).toBeDefined();
        expect(getEffectConfig("__nope__")).toBeUndefined();
        expect(getAuraEffectConfig("Luck")).toBeDefined();
        expect(getAuraEffectConfig("__nope__")).toBeUndefined();
    });
    it("resolves a valid ability and throws on unknown ones", () => {
        expect(getAbilityConfig("Double Punch")).toBeDefined();
        expect(() => getAbilityConfig("__nope__")).toThrow();
    });
    it("throws on unknown creature faction/spell race", () => {
        expect(() => getCreatureConfig(PBTypes.TeamVals.UPPER, "__nope__", "X", "tex", 1)).toThrow();
        expect(() => getSpellConfig("__nope__", "Morale")).toThrow();
        expect(() => getSpellConfig("System", "__nope__")).toThrow();
    });
    it("resolves a valid system spell", () => {
        expect(getSpellConfig("System", "Morale")).toBeDefined();
    });
});

describe("grid_math geometry helpers", () => {
    const gs = testGridSettings;
    const center = { x: gs.getMaxX() / 2, y: gs.getMaxY() / 2 };

    it("hasXY matches presence in a list", () => {
        expect(GridMath.hasXY({ x: 1, y: 2 }, [{ x: 1, y: 2 }])).toBe(true);
        expect(GridMath.hasXY({ x: 1, y: 2 }, [{ x: 3, y: 4 }])).toBe(false);
        expect(GridMath.hasXY({ x: 1, y: 2 })).toBe(false);
    });

    it("converts between cells and positions", () => {
        const cell = { x: 5, y: 6 };
        const pos = GridMath.getPositionForCell(cell, gs.getMinX(), gs.getStep(), gs.getHalfStep());
        expect(GridMath.getCellForPosition(gs, pos)).toEqual(cell);
        expect(GridMath.getPositionForCells(gs, [cell])).toBeDefined();
        expect(GridMath.getPositionForCells(gs, [])).toBeUndefined();
    });

    it("answers within-grid checks for valid and out-of-range inputs", () => {
        expect(GridMath.isCellWithinGrid(gs, { x: 0, y: 0 })).toBe(true);
        expect(GridMath.isCellWithinGrid(gs, { x: -1, y: 0 })).toBe(false);
        expect(GridMath.isPositionWithinGrid(gs, center)).toBe(true);
        expect(GridMath.isPositionWithinGrid(gs, { x: gs.getMinX() - 1000, y: 0 })).toBe(false);
    });

    it("computes neighbourhoods, projections and distances", () => {
        expect(GridMath.getCellsAroundCell(gs, { x: 5, y: 5 }).length).toBeGreaterThan(0);
        expect(GridMath.getCellsAroundPosition(gs, center).length).toBeGreaterThan(0);
        expect(GridMath.projectLineToFieldEdge(gs, center.x, center.y, center.x + 1, center.y)).toBeDefined();
        expect(GridMath.getDistanceToFurthestCorner(center, gs)).toBeGreaterThan(0);
    });

    it("answers point-connection / crossing queries", () => {
        const a = GridMath.getPositionForCell({ x: 4, y: 4 }, gs.getMinX(), gs.getStep(), gs.getHalfStep());
        const b = GridMath.getPositionForCell({ x: 5, y: 4 }, gs.getMinX(), gs.getStep(), gs.getHalfStep());
        expect(typeof GridMath.arePointsConnected(gs, a, b)).toBe("boolean");
        const vh = GridMath.getClosestVH(gs, a, b);
        expect(Array.isArray(vh)).toBe(true);
        const crossings = GridMath.getCrossingPoints(a, b, vh);
        expect(Array.isArray(crossings)).toBe(true);
        // Closest of a non-empty candidate list is the nearest point; an empty list yields undefined.
        expect(GridMath.getClosestCrossingPoint(a, [a, b])).toEqual(a);
        expect(GridMath.getClosestCrossingPoint(a, [])).toBeUndefined();
    });
});
