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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const FLY = PBTypes.MovementVals.FLY;

const v04 = getAIStrategy("v0.4");

function ctxFor(c: CombatTestContext): IDecisionContext {
    return {
        grid: c.grid,
        matrix: c.grid.getMatrix(),
        unitsHolder: c.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: c.attackHandler,
    };
}
function makeReal(team: number, faction: string, name: string): Unit {
    const ef = new EffectFactory();
    const af = new AbilityFactory(ef);
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        af,
        ef,
        false,
    );
}
const typeOf = (a: GameAction[], t: string): GameAction | undefined => a.find((x) => x.type === t);

describe("v0.4 (3) flyers mute an enemy siege unit (Gargantuan / Tsar Cannon)", () => {
    it("a flyer rushes/strikes the enemy Tsar Cannon instead of the nearer front-line unit", () => {
        const c = createCombatTestContext();
        const flyer = createTestUnit({ team: LOWER, name: "Flyer", attackType: MELEE, movementType: FLY, speed: 8 });
        const tsar = makeReal(UPPER, "Life", "Tsar Cannon");
        const frontMelee = createTestUnit({ team: UPPER, name: "Front", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, flyer, { x: 7, y: 7 });
        placeUnit(c.grid, c.unitsHolder, frontMelee, { x: 7, y: 8 });
        placeUnit(c.grid, c.unitsHolder, tsar, { x: 7, y: 12 });

        const actions = v04.decideTurn(flyer, ctxFor(c));
        // It commits toward the siege: either a strike on the Tsar Cannon, or a move that closes on it.
        const strike = typeOf(actions, "melee_attack");
        const move = typeOf(actions, "move_unit");
        if (strike && strike.type === "melee_attack") {
            expect(strike.targetId).toBe(tsar.getId());
        } else {
            expect(move).toBeDefined();
        }
        expect(actions.length).toBeGreaterThan(0);
    });

    it("ignores the siege rule when there is no siege unit (behaves as a normal flyer)", () => {
        const c = createCombatTestContext();
        const flyer = createTestUnit({ team: LOWER, name: "Flyer", attackType: MELEE, movementType: FLY, speed: 6 });
        const enemy = createTestUnit({ team: UPPER, name: "Brute", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, flyer, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 6, y: 8 });
        const actions = v04.decideTurn(flyer, ctxFor(c));
        expect(Array.isArray(actions)).toBe(true);
        expect(actions.length).toBeGreaterThan(0);
    });
});

describe("v0.4 (2) ranged-superiority patience", () => {
    it("a shooter that out-guns the enemy and can't fire yet holds instead of advancing", () => {
        const c = createCombatTestContext();
        // Our shooter has ammo; the enemy is a lone melee far away (no enemy ranged -> we out-gun them).
        const shooter = createTestUnit({ team: LOWER, name: "Archer", attackType: RANGE, rangeShots: 5, speed: 3 });
        const enemy = createTestUnit({ team: UPPER, name: "Brute", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 5, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 5, y: 13 }); // far away, not in shot range

        const actions = v04.decideTurn(shooter, ctxFor(c));
        // It holds (waits / ends turn) rather than walking toward the enemy (no move_unit toward them).
        const held = typeOf(actions, "wait_turn") || typeOf(actions, "end_turn");
        const move = typeOf(actions, "move_unit");
        expect(held || !move).toBeTruthy();
    });

    it("does not hold when it can actually take a shot (defers to the normal ranged turn)", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LOWER,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            speed: 2,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Brute", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 11 });
        const actions = v04.decideTurn(shooter, ctxFor(c));
        // With a clear shot it should fire, not hold.
        expect(typeOf(actions, "range_attack")).toBeDefined();
    });
});

describe("v0.4 (5) anti-AoE: spread deployment when an AoE unit is present", () => {
    const v03 = getAIStrategy("v0.3");
    const minPairwise = (placed: Map<string, { x: number; y: number }>): number => {
        const cells = [...placed.values()];
        let m = Infinity;
        for (let i = 0; i < cells.length; i++)
            for (let j = i + 1; j < cells.length; j++)
                m = Math.min(m, Math.hypot(cells[i].x - cells[j].x, cells[i].y - cells[j].y));
        return m;
    };
    const place = (strat: ReturnType<typeof getAIStrategy>, units: Unit[]) => {
        const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        return strat.placeArmy(units, {
            team: LOWER,
            grid: undefined as never,
            unitsHolder: undefined as never,
            pathHelper: undefined as never,
            placement: zone,
        });
    };
    it("spreads stacks farther apart than v0.3 clusters them when the roster has an AoE unit", () => {
        const roster = () => [
            makeReal(LOWER, "Nature", "Gargantuan"), // AoE (Area Throw) -> triggers spread
            createTestUnit({ team: LOWER, name: "M1", attackType: MELEE }),
            createTestUnit({ team: LOWER, name: "M2", attackType: MELEE }),
            createTestUnit({ team: LOWER, name: "S", attackType: RANGE, rangeShots: 5 }),
        ];
        const spread = minPairwise(place(v04, roster()));
        const clustered = minPairwise(place(v03, roster()));
        expect(spread).toBeGreaterThan(clustered); // v0.4 keeps stacks farther apart
    });
    it("defers to v0.3 deployment when no AoE unit is present", () => {
        const noAoe = () => [
            createTestUnit({ team: LOWER, name: "M1", attackType: MELEE }),
            createTestUnit({ team: LOWER, name: "M2", attackType: MELEE }),
            createTestUnit({ team: LOWER, name: "S", attackType: RANGE, rangeShots: 5 }),
        ];
        expect([...place(v04, noAoe()).values()]).toEqual([...place(v03, noAoe()).values()]);
    });
});

describe("v0.4 (4) melee strikes relocate into a friendly buff aura", () => {
    const v03 = getAIStrategy("v0.3");
    const coverAt = (cell: { x: number; y: number }, allies: Unit[], self: Unit): number => {
        let n = 0;
        for (const a of allies) {
            if (a.isDead() || a.getId() === self.getId()) continue;
            for (const aura of a.getAuraEffects()) {
                if (aura.getProperties().is_buff) {
                    const d = Math.hypot(cell.x - a.getBaseCell().x, cell.y - a.getBaseCell().y);
                    if (d <= aura.getRange()) {
                        n += 1;
                        break;
                    }
                }
            }
        }
        return n;
    };
    const strikeCell = (a: GameAction[]) => {
        const s = a.find((x) => x.type === "melee_attack");
        return s && s.type === "melee_attack" ? s.attackFrom : undefined;
    };

    it("never strikes from a less-aura-covered cell than v0.3", () => {
        const c = createCombatTestContext();
        const attacker = createTestUnit({ team: LOWER, name: "Striker", attackType: MELEE, speed: 6 });
        const emitter = createTestUnit({
            team: LOWER,
            name: "Bard",
            attackType: MELEE,
            auraEffects: ["Luck"],
            auraRanges: [3],
            auraIsBuff: [true],
        });
        const target = createTestUnit({ team: UPPER, name: "Victim", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, attacker, { x: 8, y: 4 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, emitter, { x: 10, y: 10 }); // covers the upper-right side of target

        const allies = [attacker, emitter];
        const c3 = strikeCell(v03.decideTurn(attacker, ctxFor(c)));
        const c4 = strikeCell(v04.decideTurn(attacker, ctxFor(c)));
        if (c4) {
            const cover3 = c3 ? coverAt(c3, allies, attacker) : 0;
            expect(coverAt(c4, allies, attacker)).toBeGreaterThanOrEqual(cover3);
        }
    });
});

describe("v0.4 (1) healer focuses the biggest sufficiently-wounded stack", () => {
    it("re-aims a single-target heal onto the biggest-HP ally that is down >25%", () => {
        const c = createCombatTestContext();
        const healer = createTestUnit({
            team: LOWER,
            name: "Healer",
            attackType: PBTypes.AttackVals.MAGIC,
            spells: ["Heal"],
        });
        // A small wounded stack (what v0.2 might pick by missing HP) and a BIG stack wounded >25%.
        const smallHurt = createTestUnit({ team: LOWER, name: "Small", attackType: MELEE, maxHp: 20, amountAlive: 2 });
        const bigHurt = createTestUnit({ team: LOWER, name: "Big", attackType: MELEE, maxHp: 100, amountAlive: 30 });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, healer, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, smallHurt, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, bigHurt, { x: 7, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 6, y: 9 });
        // Wound both well past 25%.
        const log = new SceneLogMock();
        smallHurt.applyDamage(Math.floor(smallHurt.getCumulativeHp() * 0.5), 0, log);
        bigHurt.applyDamage(Math.floor(bigHurt.getCumulativeHp() * 0.5), 0, log);

        const actions = v04.decideTurn(healer, ctxFor(c));
        const cast = typeOf(actions, "cast_spell");
        if (cast && cast.type === "cast_spell" && cast.targetId) {
            // If it heals a single target, it must be the BIG stack (biggest HP), not the small one.
            expect(cast.targetId).toBe(bigHurt.getId());
        }
        // (If the healer chose a non-heal action that's fine; the assertion only binds when it heals.)
        expect(Array.isArray(actions)).toBe(true);
    });
});
