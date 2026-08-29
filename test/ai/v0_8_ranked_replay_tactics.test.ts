import { describe, expect, test } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import {
    reserveV08ReplayLeafChallenger,
    prioritizeV08RankedReplayCombatTactics,
    selectV08ReplayBacklineDiveCandidate,
    selectV08ReplayFocusFireCandidate,
    selectV08ReplayLightWoundFocusCandidate,
    selectV08ReplayNearTieCandidateIndex,
    selectV08ReplayShortlistFocusCandidate,
    v08ReplayTargetRoleValue,
    v08ReplayTargetWoundedFraction,
    v08ReplayNativeRangedMatchupEligible,
    v08RankedReplayTiebreakSupportsGrid,
    V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV,
} from "../../src/ai/versions/v0_8_ranked_replay_tactics";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const MELEE = PBTypes.AttackVals.MELEE;
const MAGIC = PBTypes.AttackVals.MAGIC;

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

const candidateFeatures = (expectedDamage: number, expectedKill: 0 | 1) => ({
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 1,
    hourglassSpent: 0 as const,
    spendsRangeShot: 0 as const,
    spendsSpellCharge: 0 as const,
    burnsResurrectionCharge: 0 as const,
    expectedDamage,
    expectedKill,
});

function meleeCandidate(
    kind: "incumbent" | "melee",
    attacker: Unit,
    target: Unit,
    expectedDamage: number,
    expectedKill: 0 | 1 = 0,
): IEnumeratedCandidate {
    return {
        kind,
        targetId: target.getId(),
        actions: [
            {
                type: "melee_attack",
                attackerId: attacker.getId(),
                targetId: target.getId(),
                attackFrom: attacker.getBaseCell(),
            },
        ],
        features: candidateFeatures(expectedDamage, expectedKill),
    };
}

function rangedCandidate(
    kind: "incumbent" | "shot",
    attacker: Unit,
    target: Unit,
    expectedDamage: number,
    expectedKill: 0 | 1 = 0,
): IEnumeratedCandidate {
    const action: GameAction = {
        type: "range_attack",
        attackerId: attacker.getId(),
        targetId: target.getId(),
    };
    return {
        kind,
        targetId: target.getId(),
        actions: [action],
        features: { ...candidateFeatures(expectedDamage, expectedKill), spendsRangeShot: 1 },
    };
}

describe("v0.8 ranked-replay fight tactics", () => {
    test("scopes the search tiebreak to numeric GridVals and fails closed for explicit invalid scopes", () => {
        const previous = process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV];
        try {
            delete process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV];
            expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.NORMAL)).toBe(true);
            expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.BLOCK_CENTER)).toBe(true);

            process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV] =
                `${PBTypes.GridVals.NORMAL}, ${PBTypes.GridVals.LAVA_CENTER}`;
            expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.NORMAL)).toBe(true);
            expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.LAVA_CENTER)).toBe(true);
            expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.BLOCK_CENTER)).toBe(false);

            for (const invalid of ["", "not-a-grid", `${PBTypes.GridVals.NORMAL},not-a-grid`, "99", "1,,3"]) {
                process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV] = invalid;
                expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.NORMAL)).toBe(false);
                expect(v08RankedReplayTiebreakSupportsGrid(PBTypes.GridVals.LAVA_CENTER)).toBe(false);
            }
        } finally {
            if (previous === undefined) {
                delete process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV];
            } else {
                process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV] = previous;
            }
        }
    });

    test("measures removed creatures and damage on the surviving front creature", () => {
        const target = createTestUnit({ team: RIGHT, amountAlive: 10, maxHp: 10 });
        target.applyDamage(15, 0, new SceneLogMock());

        expect(target.getAmountAlive()).toBe(9);
        expect(target.getAmountDied()).toBe(1);
        expect(v08ReplayTargetWoundedFraction(target)).toBeCloseTo(0.15, 8);
    });

    test("recognizes a live support spellbook without hard-coding a unit name", () => {
        const support = createTestUnit({
            team: RIGHT,
            name: "Future support",
            attackType: MAGIC,
            stackPower: 4,
            spells: ["Life:Heal", "Life:Spiritual Armor"],
        });
        const ordinary = createTestUnit({ team: RIGHT, name: "Ordinary melee" });

        expect(v08ReplayTargetRoleValue(support)).toBeGreaterThanOrEqual(7);
        expect(v08ReplayTargetRoleValue(ordinary)).toBe(0);
        support.applyEffect(new EffectFactory().makeEffect("Break")!);
        expect(v08ReplayTargetRoleValue(support)).toBe(0);
    });

    test("enables replay focus when either army has a native ranged stack", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LEFT, name: "Squire" });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        expect(v08ReplayNativeRangedMatchupEligible(contextFor(combat))).toBe(false);
        // Eligibility is frozen to the public base roster, not mutable fight-time attack properties or side.
        const enemyShooter = createTestUnit({ team: RIGHT, name: "Arbalester", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, enemyShooter, { x: 12, y: 2 });
        expect(v08ReplayNativeRangedMatchupEligible(contextFor(combat))).toBe(true);
    });

    test("focuses only a guaranteed finish or a 25%-wounded stack at 90% damage", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ team: LEFT, name: "Attacker" });
        const fresh = createTestUnit({ team: RIGHT, name: "Fresh", amountAlive: 10, maxHp: 10 });
        const wounded = createTestUnit({ team: RIGHT, name: "Wounded", amountAlive: 10, maxHp: 10 });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 4, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, wounded, { x: 3, y: 4 });
        wounded.applyDamage(24, 0, new SceneLogMock());
        const context = contextFor(combat);
        const focus = meleeCandidate("melee", attacker, wounded, 90);
        const incumbent = meleeCandidate("incumbent", attacker, fresh, 100);

        expect(selectV08ReplayFocusFireCandidate(context, [incumbent, focus])).toBeUndefined();
        focus.features.expectedKill = 1;
        expect(selectV08ReplayFocusFireCandidate(context, [incumbent, focus])).toBe(focus);
        focus.features.expectedKill = 0;
        wounded.applyDamage(1, 0, new SceneLogMock());
        focus.features.expectedDamage = 89;
        expect(selectV08ReplayFocusFireCandidate(context, [incumbent, focus])).toBeUndefined();
        focus.features.expectedDamage = 90;
        expect(selectV08ReplayFocusFireCandidate(context, [incumbent, focus])).toBe(focus);
        expect(
            selectV08ReplayFocusFireCandidate(context, [meleeCandidate("incumbent", attacker, fresh, 100, 1), focus]),
        ).toBeUndefined();
    });

    test("does not trade aggregate splash damage for a nonlethal focus-fire target", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            team: LEFT,
            name: "Splash shooter",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 8,
            abilities: ["Large Caliber"],
        });
        const fresh = createTestUnit({ team: RIGHT, name: "Fresh", amountAlive: 20, maxHp: 10 });
        const wounded = createTestUnit({ team: RIGHT, name: "Wounded", amountAlive: 20, maxHp: 10 });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 2, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 12, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, wounded, { x: 12, y: 5 });
        wounded.applyDamage(10, 0, new SceneLogMock());
        const context = contextFor(combat);
        const focus = rangedCandidate("shot", attacker, wounded, 90);

        expect(
            selectV08ReplayFocusFireCandidate(context, [rangedCandidate("incumbent", attacker, fresh, 100), focus]),
        ).toBeUndefined();
        focus.features.expectedKill = 1;
        expect(
            selectV08ReplayFocusFireCandidate(context, [rangedCandidate("incumbent", attacker, fresh, 100), focus]),
        ).toBe(focus);
    });

    test("reserves one rollout-gated finish or high-value focus behind a lightly wounded incumbent", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ team: LEFT, name: "Attacker" });
        const incumbentTarget = createTestUnit({ team: RIGHT, name: "Lightly wounded", amountAlive: 10, maxHp: 10 });
        const ordinary = createTestUnit({ team: RIGHT, name: "Ordinary", amountAlive: 10, maxHp: 10 });
        const support = createTestUnit({
            team: RIGHT,
            name: "Support",
            attackType: MAGIC,
            amountAlive: 10,
            maxHp: 10,
            stackPower: 4,
            spells: ["Life:Heal", "Life:Spiritual Armor"],
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, incumbentTarget, { x: 4, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, ordinary, { x: 3, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, support, { x: 4, y: 4 });
        incumbentTarget.applyDamage(10, 0, new SceneLogMock());
        ordinary.applyDamage(25, 0, new SceneLogMock());
        support.applyDamage(25, 0, new SceneLogMock());
        const context = contextFor(combat);
        const incumbent = meleeCandidate("incumbent", attacker, incumbentTarget, 100);
        const ordinaryAlternative = meleeCandidate("melee", attacker, ordinary, 90);
        const supportAlternative = meleeCandidate("melee", attacker, support, 90);

        expect(selectV08ReplayLightWoundFocusCandidate(context, [incumbent, ordinaryAlternative])).toBeUndefined();
        expect(selectV08ReplayLightWoundFocusCandidate(context, [incumbent, supportAlternative])).toBe(
            supportAlternative,
        );
        supportAlternative.features.expectedDamage = 89;
        expect(selectV08ReplayLightWoundFocusCandidate(context, [incumbent, supportAlternative])).toBeUndefined();
        supportAlternative.features.expectedKill = 1;
        expect(selectV08ReplayLightWoundFocusCandidate(context, [incumbent, supportAlternative])).toBe(
            supportAlternative,
        );

        expect(
            selectV08ReplayShortlistFocusCandidate(context, [incumbent, ordinaryAlternative, supportAlternative]),
        ).toBe(supportAlternative);
        const leafRanks = [
            { index: 1, score: 0.6 },
            { index: 2, score: 0.598 },
        ];
        expect(reserveV08ReplayLeafChallenger(leafRanks, 2, 1, 0.002)).toEqual(leafRanks);
        expect(reserveV08ReplayLeafChallenger(leafRanks, 2, 1, 0.001)).toEqual([leafRanks[0]]);
        expect(reserveV08ReplayLeafChallenger(leafRanks, 1, 1, 0.002)).toEqual([leafRanks[0]]);

        expect(
            selectV08ReplayNearTieCandidateIndex(
                attacker,
                context,
                [incumbent, ordinaryAlternative, supportAlternative],
                [0.56, 0.6, 0.598],
                1,
                0.002,
                0.03,
            ),
        ).toBe(2);
        incumbentTarget.applyDamage(15, 0, new SceneLogMock());
        expect(selectV08ReplayLightWoundFocusCandidate(context, [incumbent, supportAlternative])).toBeUndefined();
        expect(
            selectV08ReplayLightWoundFocusCandidate(context, [
                meleeCandidate("incumbent", attacker, incumbentTarget, 100, 1),
                supportAlternative,
            ]),
        ).toBeUndefined();
    });

    test("uses replay target preference only inside the scored near-tie window", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({ team: LEFT, name: "Attacker" });
        const fresh = createTestUnit({ team: RIGHT, name: "Fresh", amountAlive: 10, maxHp: 10 });
        const wounded = createTestUnit({ team: RIGHT, name: "Wounded", amountAlive: 10, maxHp: 10 });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, fresh, { x: 4, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, wounded, { x: 3, y: 4 });
        wounded.applyDamage(25, 0, new SceneLogMock());
        const candidates = [
            meleeCandidate("incumbent", attacker, fresh, 100),
            meleeCandidate("melee", attacker, wounded, 90),
            meleeCandidate("melee", attacker, fresh, 100),
        ];

        expect(
            selectV08ReplayNearTieCandidateIndex(
                attacker,
                contextFor(combat),
                candidates,
                [0.56, 0.598, 0.6],
                2,
                0.002,
                0.03,
            ),
        ).toBe(1);
        expect(
            selectV08ReplayNearTieCandidateIndex(
                attacker,
                contextFor(combat),
                candidates,
                [0.56, 0.598, 0.6],
                2,
                0.001,
                0.03,
            ),
        ).toBeUndefined();
        expect(
            selectV08ReplayNearTieCandidateIndex(
                attacker,
                contextFor(combat),
                candidates,
                [0.57, 0.598, 0.6],
                2,
                0.002,
                0.03,
            ),
        ).toBeUndefined();
        expect(
            selectV08ReplayNearTieCandidateIndex(
                attacker,
                contextFor(combat),
                candidates,
                [0.56, 0.598, 0.6],
                0,
                0.002,
                0.03,
            ),
        ).toBeUndefined();
        expect(
            selectV08ReplayNearTieCandidateIndex(
                attacker,
                contextFor(combat),
                candidates,
                [0.56, 0.598, 0.6],
                2,
                0.002,
                0.03,
                new Set([0]),
            ),
        ).toBeUndefined();
    });

    test("a fast opening melee attacker prefers a comparable hit on a support target", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            team: LEFT,
            name: "Flying diver",
            attackType: MELEE,
            movementType: PBTypes.MovementVals.FLY,
        });
        const front = createTestUnit({ team: RIGHT, name: "Front line", maxHp: 100 });
        const support = createTestUnit({
            team: RIGHT,
            name: "Support",
            attackType: MAGIC,
            maxHp: 100,
            stackPower: 4,
            spells: ["Life:Heal", "Life:Spiritual Armor"],
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 2, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, front, { x: 3, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, support, { x: 5, y: 4 });
        const context = contextFor(combat);
        const dive = meleeCandidate("melee", attacker, support, 84);

        expect(
            selectV08ReplayBacklineDiveCandidate(attacker, context, [
                meleeCandidate("incumbent", attacker, front, 100),
                dive,
            ]),
        ).toBeUndefined();
        dive.features.expectedDamage = 85;
        expect(
            selectV08ReplayBacklineDiveCandidate(attacker, context, [
                meleeCandidate("incumbent", attacker, front, 100),
                dive,
            ]),
        ).toBe(dive);
        context.fightProperties!.flipLap();
        context.fightProperties!.flipLap();
        expect(
            selectV08ReplayBacklineDiveCandidate(attacker, context, [
                meleeCandidate("incumbent", attacker, front, 100),
                dive,
            ]),
        ).toBeUndefined();
    });

    test("enumerates and returns an engine-legal move-and-dive from the supplied incumbent", () => {
        const combat = createCombatTestContext();
        const attacker = createTestUnit({
            team: LEFT,
            name: "Flying diver",
            attackType: MELEE,
            attack: 20,
            damageMin: 5,
            damageMax: 5,
            amountAlive: 10,
            movementType: PBTypes.MovementVals.FLY,
        });
        const front = createTestUnit({ team: RIGHT, name: "Front line", maxHp: 100, amountAlive: 10 });
        const support = createTestUnit({
            team: RIGHT,
            name: "Support",
            attackType: MAGIC,
            maxHp: 100,
            amountAlive: 10,
            stackPower: 4,
            spells: ["Life:Heal", "Life:Spiritual Armor"],
        });
        placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 2, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, front, { x: 3, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, support, { x: 5, y: 4 });
        const context = contextFor(combat);
        const incumbent = meleeCandidate("incumbent", attacker, front, 1).actions;

        const decision = prioritizeV08RankedReplayCombatTactics(attacker, context, incumbent);

        expect(decision.some((action) => action.type === "move_unit")).toBe(true);
        expect(
            decision.find(
                (action): action is Extract<GameAction, { type: "melee_attack" }> => action.type === "melee_attack",
            )?.targetId,
        ).toBe(support.getId());
    });
});
