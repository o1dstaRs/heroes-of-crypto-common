import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { parseDraftGenome } from "../../src/ai/setup/draft_ship";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { MoveHandler } from "../../src/handlers/move_handler";
import { getDraftScoutingContext } from "../../src/picks/draft_visibility";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { footprintCellsForAnchor } from "../../src/simulation/footprint";
import {
    createRangedCounterDraft,
    fundedRangedPlacement,
    materializeRangedCounterSplits,
    rangedCounterFormationRisk,
    rangeNullEscapeProposal,
    spreadRangedCounterFormation,
    validRangedCounterFormation,
    type IRangedCounterBody,
} from "../../src/simulation/ranged_counter_research";
import type { IRankedDraftResearchContext } from "../../src/simulation/ranked_draft_eval";
import { Unit } from "../../src/units/unit";
import { creaturesByLevel } from "../../src/simulation/army";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const genome = parseDraftGenome("ranked-unit-strength-a19-side-v4-w16-r4");
const variants = { Life: 1, Chaos: 1, Might: 1, Nature: 1 };
const scouting = getDraftScoutingContext({
    gridType: 1,
    bannedCreatureIds: [],
    phaseOrder: [1, 2, 1, 2],
    phaseLevels: [2, 2, 3, 3],
    phaseActors: [[1], [2], [1], [2]],
    phaseSequence: 2,
    doctrine: Doctrine.THREE_REVEALS,
    team: 1,
});
const context = (known: readonly number[]): IRankedDraftResearchContext => ({
    ownCreatureIds: [47, 31, 15, 6],
    knownOpponentCreatureIds: known,
    artifactFitVersion: 6,
    scouting,
});

describe("ranged counter research isolation and legal information", () => {
    test("the reported Griffin draft can select a non-shooter, while unseen counters do not alter it", () => {
        const draft = createRangedCounterDraft(genome, { creature: (_pool, _context, choice) => choice }, variants);
        const available = [8, 17, 18, 28, 30, 38, 50, 54];
        expect(draft.creature!(available, context([]), 50)).toBe(50);
        expect(draft.creature!(available, context([37]), 50)).not.toBe(50);
        expect(available).toContain(draft.creature!(available, context([37]), 50));
        expect(draft.creature!([50, 54], context([37]), 50)).toBe(50);
    });

    test("retains the learned draft state across calls, including collision retries", () => {
        let calls = 0;
        const draft = createRangedCounterDraft(genome, { creature: () => (++calls === 1 ? 54 : 50) }, variants);
        expect(draft.creature!([50, 54], context([]), 50)).toBe(54);
        expect(draft.creature!([50, 54], context([]), 50)).toBe(50);
        expect(calls).toBe(2);
    });

    test("Placement points are funded for all three real doctrine budgets", () => {
        for (const budget of [5, 6, 7])
            for (const placement of [1, 2] as const)
                for (const preserve of ["sniper", "armor"] as const) {
                    const plan = fundedRangedPlacement(budget, placement, preserve);
                    expect(plan.reduce((sum, augment) => sum + augment.value, 0)).toBe(budget);
                    expect(plan.find((augment) => augment.kind === "Placement")?.value).toBe(placement);
                    expect(plan.every((augment) => augment.value >= 1 && augment.value <= 3)).toBe(true);
                }
        expect(() => fundedRangedPlacement(8, 2, "sniper")).toThrow();
    });

    test("funded extra slots use current support splits and conserve the complete army", () => {
        const names = ["Dryad", "Wandering Mage", "Healer", "Troll", "Zena", "Gargantuan"];
        const roster = names.map((name) => {
            const entry = [1, 2, 3, 4]
                .flatMap((level) => creaturesByLevel(level))
                .find((unit) => unit.creatureName === name)!;
            return { ...entry, amount: Math.ceil(1000 / entry.exp!) };
        });
        expect(materializeRangedCounterSplits(roster, 6).roster).toEqual(roster);
        const expanded = materializeRangedCounterSplits(roster, 8);
        expect(expanded.roster.length).toBe(8);
        expect(expanded.splitRoles.length).toBe(2);
        for (const original of roster) {
            const stacks = expanded.roster.filter((unit) => unit.creatureName === original.creatureName);
            expect(stacks.reduce((sum, unit) => sum + unit.amount, 0)).toBe(original.amount);
        }
        const mage = expanded.roster.filter((unit) => unit.creatureName === "Wandering Mage");
        expect(mage.length).toBe(2);
        expect(mage[0].initialSpellEntries).toEqual(mage[1].initialSpellEntries);
        expect(mage[0].initialSpellEntries).not.toBe(mage[1].initialSpellEntries);
    });
});

const body = (id: string, width = 1, height = 1): IRangedCounterBody => ({
    id,
    width,
    height,
    ranged: true,
    caster: false,
    value: 1,
    buffRanges: [],
});

describe("free spread geometry", () => {
    test("reduces clustering without buying space on either physical seat, including rectangular bodies", () => {
        for (const team of [LEFT, RIGHT]) {
            const zone = new RectanglePlacement(
                testGridSettings,
                team === LEFT ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
                3,
                true,
            );
            const legal = zone.possibleCellHashes();
            const bodies = [body("dryad"), body("zena"), body("beholder", 2, 1), body("gargantuan", 2, 2)];
            const x = team === LEFT ? 2 : 14;
            const incumbent = new Map([
                ["dryad", { x, y: 1 }],
                ["zena", { x, y: 2 }],
                ["beholder", { x, y: 3 }],
                ["gargantuan", { x, y: 5 }],
            ]);
            const original = JSON.stringify([...incumbent]);
            const spread = spreadRangedCounterFormation(bodies, incumbent, {
                team,
                sideAxis: true,
                legal,
                enemyIds: [37, 49],
            });
            expect(validRangedCounterFormation(bodies, spread, legal)).toBe(true);
            expect(rangedCounterFormationRisk(bodies, spread, team, true, [37, 49])).toBeLessThan(
                rangedCounterFormationRisk(bodies, incumbent, team, true, [37, 49]),
            );
            expect(JSON.stringify([...incumbent])).toBe(original);
            expect([
                ...spreadRangedCounterFormation(bodies, incumbent, { team, sideAxis: true, legal, enemyIds: [37, 49] }),
            ]).toEqual([...spread]);
        }
    });

    test("keeps friendly buff coverage and rejects overlap, malformed anchors and incomplete formations", () => {
        const legal = new Set(Array.from({ length: 256 }, (_, i) => i));
        const bodies = [{ ...body("a"), buffRanges: [1] }, body("b")];
        const original = new Map([
            ["a", { x: 2, y: 2 }],
            ["b", { x: 2, y: 3 }],
        ]);
        const spread = spreadRangedCounterFormation(bodies, original, {
            team: LEFT,
            sideAxis: true,
            legal,
            enemyIds: [37],
        });
        const a = spread.get("a")!,
            b = spread.get("b")!;
        expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeLessThanOrEqual(1);
        expect(validRangedCounterFormation(bodies, new Map([["a", a]]), legal)).toBe(false);
        expect(
            validRangedCounterFormation(
                bodies,
                new Map([
                    ["a", a],
                    ["b", a],
                ]),
                legal,
            ),
        ).toBe(false);
        expect(
            validRangedCounterFormation(
                bodies,
                new Map([
                    ["a", a],
                    ["b", { x: NaN, y: 4 }],
                ]),
                legal,
            ),
        ).toBe(false);
        expect([
            ...spreadRangedCounterFormation(bodies, original, { team: LEFT, sideAxis: true, legal, enemyIds: [] }),
        ]).toEqual([...original]);
    });
});

test("a suppressed shooter receives an engine-legal escape outside the real Griffin field", () => {
    const c = createCombatTestContext();
    const ef = new EffectFactory(),
        af = new AbilityFactory(ef);
    const griffin = Unit.createUnit(
        getCreatureConfig(RIGHT, "Life", "Griffin", "", 9),
        testGridSettings,
        RIGHT,
        PBTypes.UnitVals.CREATURE,
        af,
        ef,
        false,
    );
    const griffinCells = footprintCellsForAnchor(griffin, { x: 8, y: 8 });
    const point = getPositionForCells(testGridSettings, griffinCells)!;
    griffin.setPosition(point.x, point.y);
    c.unitsHolder.addUnit(griffin);
    c.grid.occupyCells(griffinCells, griffin.getId(), RIGHT, griffin.getAttackRange(), false, false);
    const shooter = createTestUnit({
        name: "Shooter",
        team: LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 10,
        amountAlive: 20,
        damageMin: 2,
        damageMax: 3,
        maxHp: 20,
    });
    placeUnit(c.grid, c.unitsHolder, shooter, { x: 6, y: 8 });
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.startFight();
    fight.setTeamUnitsAlive(LEFT, 1);
    fight.setTeamUnitsAlive(RIGHT, 1);
    fight.startTurn(LEFT, 1_000);
    c.unitsHolder.refreshAuraEffectsForAllUnits();
    expect(shooter.hasDebuffActive("Range Null Field Aura")).toBe(true);
    const ctx = {
        grid: c.grid,
        matrix: c.grid.getMatrix(),
        unitsHolder: c.unitsHolder,
        attackHandler: c.attackHandler,
        fightProperties: fight,
        pathHelper: new PathHelper(testGridSettings),
    };
    const incumbent = [{ type: "end_turn" as const, unitId: shooter.getId(), reason: "manual" as const }];
    const proposal = rangeNullEscapeProposal(shooter, ctx, incumbent);
    expect(proposal).not.toBe(incumbent);
    expect(proposal[0].type).toBe("move_unit");
    const engine = new GameActionEngine({
        ...ctx,
        fightProperties: fight,
        moveHandler: new MoveHandler(testGridSettings, c.grid, c.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => shooter.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => [],
    });
    const result = engine.apply(proposal[0]);
    expect(result.completed).toBe(true);
    c.unitsHolder.refreshAuraEffectsForAllUnits();
    expect(shooter.hasDebuffActive("Range Null Field Aura")).toBe(false);
    expect(rangeNullEscapeProposal(shooter, ctx, incumbent)).toBe(incumbent);
});
