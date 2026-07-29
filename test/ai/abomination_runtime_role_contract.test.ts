import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../../src/ai";
import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import {
    buildV08BacklineProtectorIntent,
    isV08BacklineProtectionBeneficiary,
    isV08BacklineProtectorDecisionAllowed,
    preservesV08BacklineProtectorIntent,
    prioritizeV08BacklineProtector,
    v08BacklineProtectorCoverageRange,
} from "../../src/ai/versions/v0_8_backline_protector";
import { V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { StrategyV0_9, buildV09HardGuardSummary, v09CandidatePassesHardGuards } from "../../src/ai/versions/v0_9";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, testGridSettings, type CombatTestContext } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
type WardName = "Battle Mage" | "Magic Dragon";

const wardFaction = (name: WardName): "Life" | "Nature" => (name === "Battle Mage" ? "Life" : "Nature");

function nativeUnit(team: number, faction: string, name: string): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 1),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

function footprint(unit: Unit, anchor: XY): XY[] {
    if (unit.isSmallSize()) return [{ ...anchor }];
    return [
        { ...anchor },
        { x: anchor.x - 1, y: anchor.y },
        { x: anchor.x, y: anchor.y - 1 },
        { x: anchor.x - 1, y: anchor.y - 1 },
    ];
}

function placeAtAnchor(combat: CombatTestContext, unit: Unit, anchor: XY): void {
    const cells = footprint(unit, anchor);
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) throw new Error(`Unable to place ${unit.getName()} at ${anchor.x},${anchor.y}`);
    unit.setPosition(position.x, position.y);
    expect(
        combat.grid.occupyCells(
            cells,
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.hasAbilityActive("Made of Fire"),
            unit.hasAbilityActive("Made of Water"),
        ),
    ).toBe(true);
    combat.unitsHolder.addUnit(unit);
}

function footprintDistance(left: readonly XY[], right: readonly XY[]): number {
    return Math.min(...left.flatMap((a) => right.map((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)))));
}

function decisionContext(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
        decisionOrigin: "root",
    };
}

function board(
    wardName?: WardName,
    enemyCell: XY = { x: 12, y: 12 },
): {
    protector: Unit;
    ward: Unit | undefined;
    enemy: Unit;
    context: IDecisionContext;
} {
    const combat = createCombatTestContext();
    const protector = nativeUnit(LOWER, "Chaos", "Abomination");
    const ward = wardName ? nativeUnit(LOWER, wardFaction(wardName), wardName) : undefined;
    const enemy = nativeUnit(UPPER, "Life", "Squire");

    placeAtAnchor(combat, protector, { x: 6, y: 6 });
    if (ward) {
        placeAtAnchor(combat, ward, ward.isSmallSize() ? { x: 6, y: 7 } : { x: 6, y: 8 });
    }
    placeAtAnchor(combat, enemy, enemyCell);
    return { protector, ward, enemy, context: decisionContext(combat) };
}

const features = {
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 0,
    hourglassSpent: 0 as const,
    spendsRangeShot: 0 as const,
    spendsSpellCharge: 0 as const,
    burnsResurrectionCharge: 0 as const,
    expectedDamage: 0,
    expectedKill: 0 as const,
};

const moveCandidate = (protector: Unit, destination: XY): IEnumeratedCandidate => ({
    kind: "move",
    actions: [
        {
            type: "move_unit",
            unitId: protector.getId(),
            path: [destination],
            targetCells: footprint(protector, destination),
        },
    ],
    targetCell: destination,
    features,
});

const localAttackCandidate = (protector: Unit, enemy: Unit): IEnumeratedCandidate => ({
    kind: "melee",
    actions: [
        {
            type: "melee_attack",
            attackerId: protector.getId(),
            targetId: enemy.getId(),
            attackFrom: protector.getBaseCell(),
        },
    ],
    targetId: enemy.getId(),
    standCell: protector.getBaseCell(),
    features: { ...features, expectedDamage: 1 },
});

const strategyFactories: readonly [string, () => IAIStrategy][] = [
    ["v0.8", () => new StrategyV0_8()],
    ["v0.8s", () => new StrategyV0_8S()],
    ["v0.9 anchor", () => new StrategyV0_9()],
];

describe("Abomination runtime role contract", () => {
    test.each([
        ["Battle Mage", "Battle Mage"],
        ["Magic Dragon", "Magic Dragon"],
    ] as const)("places Abomination in native Flesh Shield range of %s", (_label, wardName) => {
        for (const [version, createStrategy] of strategyFactories) {
            const combat = createCombatTestContext();
            const protector = nativeUnit(LOWER, "Chaos", "Abomination");
            const ward = nativeUnit(LOWER, wardFaction(wardName), wardName);
            const melee = nativeUnit(LOWER, "Life", "Squire");
            const enemy = nativeUnit(UPPER, "Life", "Squire");
            for (const unit of [protector, ward, melee, enemy]) combat.unitsHolder.addUnit(unit);
            const context: IPlacementContext = {
                team: LOWER,
                grid: combat.grid,
                unitsHolder: combat.unitsHolder,
                pathHelper: new PathHelper(testGridSettings),
                placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
                publicOpponentCreatureIds: [PBTypes.CreatureVals.SQUIRE],
            };

            const result = createStrategy().placeArmy([protector, ward, melee], context);
            const protectorAnchor = result.get(protector.getId());
            const wardAnchor = result.get(ward.getId());
            expect(protectorAnchor, `${version} protector placement`).toBeDefined();
            expect(wardAnchor, `${version} ward placement`).toBeDefined();
            expect(
                footprintDistance(footprint(protector, protectorAnchor!), footprint(ward, wardAnchor!)),
                `${version} opening coverage`,
            ).toBeLessThanOrEqual(1);
        }
    });

    test.each([
        ["Battle Mage", "Battle Mage"],
        ["Magic Dragon", "Magic Dragon"],
    ] as const)("keeps Abomination beside a live %s instead of rushing", (_label, wardName) => {
        for (const [version, createStrategy] of strategyFactories) {
            const { protector, ward, enemy, context } = board(wardName);
            const intent = buildV08BacklineProtectorIntent(protector, context);
            expect(intent?.ward, `${version} ward selection`).toBe(ward);
            expect(v08BacklineProtectorCoverageRange(protector, context)).toBe(1);

            const decision = createStrategy().decideTurn(protector, context);
            expect(preservesV08BacklineProtectorIntent(intent!, protector, context, decision), version).toBe(true);
            expect(
                decision.some((action) => action.type === "melee_attack" && action.targetId === enemy.getId()),
                `${version} forward attack`,
            ).toBe(false);
            expect(
                decision.some((action) => action.type === "move_unit"),
                `${version} forward move`,
            ).toBe(false);
        }
    });

    test.each([
        ["Battle Mage", "Battle Mage"],
        ["Magic Dragon", "Magic Dragon"],
    ] as const)(
        "rejects a retaliating local hit for %s, allows it after response is spent, and rejects a rush",
        (_label, wardName) => {
            const local = board(wardName, { x: 7, y: 7 });
            const localIntent = buildV08BacklineProtectorIntent(local.protector, local.context)!;
            const localCandidate = localAttackCandidate(local.protector, local.enemy);
            const rushCandidate = moveCandidate(local.protector, { x: 10, y: 10 });
            const farAttack: GameAction[] = [
                {
                    type: "melee_attack",
                    attackerId: local.protector.getId(),
                    targetId: local.enemy.getId(),
                    attackFrom: { x: 11, y: 11 },
                },
            ];

            expect(
                preservesV08BacklineProtectorIntent(
                    localIntent,
                    local.protector,
                    local.context,
                    localCandidate.actions,
                ),
            ).toBe(true);
            expect(
                prioritizeV08BacklineProtector(local.protector, local.context, localCandidate.actions, false),
            ).toEqual([{ type: "defend_turn", unitId: local.protector.getId() }]);
            expect(isV08BacklineProtectorDecisionAllowed(local.protector, local.context, localCandidate.actions)).toBe(
                false,
            );
            const freshResponseSummary = buildV09HardGuardSummary(
                [localCandidate, rushCandidate],
                local.protector,
                local.context,
            );
            expect(
                v09CandidatePassesHardGuards(
                    0,
                    localCandidate,
                    [localCandidate, rushCandidate],
                    local.protector,
                    local.context,
                    freshResponseSummary,
                ),
            ).toBe(false);

            local.enemy.setResponded(true);
            expect(prioritizeV08BacklineProtector(local.protector, local.context, localCandidate.actions, false)).toBe(
                localCandidate.actions,
            );
            expect(isV08BacklineProtectorDecisionAllowed(local.protector, local.context, localCandidate.actions)).toBe(
                true,
            );
            expect(isV08BacklineProtectorDecisionAllowed(local.protector, local.context, farAttack)).toBe(false);
            expect(
                preservesV08BacklineProtectorIntent(localIntent, local.protector, local.context, rushCandidate.actions),
            ).toBe(false);

            const candidates = [localCandidate, rushCandidate];
            const summary = buildV09HardGuardSummary(candidates, local.protector, local.context);
            expect(
                v09CandidatePassesHardGuards(0, localCandidate, candidates, local.protector, local.context, summary),
            ).toBe(true);
            expect(
                v09CandidatePassesHardGuards(1, rushCandidate, candidates, local.protector, local.context, summary),
            ).toBe(false);
        },
    );

    test("releases the role with no ward, depleted spells, or the universal late finish", () => {
        const assertReleased = (fixture: ReturnType<typeof board>, label: string): void => {
            const advance = moveCandidate(fixture.protector, { x: 10, y: 10 });
            expect(buildV08BacklineProtectorIntent(fixture.protector, fixture.context), label).toBeUndefined();
            expect(
                prioritizeV08BacklineProtector(fixture.protector, fixture.context, advance.actions, false),
                label,
            ).toBe(advance.actions);
            const summary = buildV09HardGuardSummary([advance], fixture.protector, fixture.context);
            expect(summary.backlineProtectorIntent, label).toBeUndefined();
            expect(
                v09CandidatePassesHardGuards(0, advance, [advance], fixture.protector, fixture.context, summary),
                label,
            ).toBe(true);
        };

        assertReleased(board(), "no ward");

        for (const wardName of ["Battle Mage", "Magic Dragon"] as const) {
            const depleted = board(wardName);
            for (const spell of depleted.ward!.getSpells()) spell.setAmount(0);
            expect(isV08BacklineProtectionBeneficiary(depleted.ward!), `${wardName} depleted`).toBe(false);
            assertReleased(depleted, `${wardName} depleted`);
        }

        const late = board("Magic Dragon");
        while (late.context.fightProperties!.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
            late.context.fightProperties!.flipLap();
        }
        assertReleased(late, "late finish");
    });
});
