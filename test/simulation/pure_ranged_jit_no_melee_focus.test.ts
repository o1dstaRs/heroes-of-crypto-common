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

import type { IEnumeratedCandidate } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import {
    ownsPureRangedJitClassifyingAbility,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
    pureRangedJitNoMeleeFocusActorEligible,
    isPureRangedJitNoMeleeFocusStationaryIncumbent,
    rankPureRangedJitNoMeleeFocusCandidates,
} from "../../src/simulation/pure_ranged_jit_no_melee_focus";
import type { PureRangedTerminalState } from "../../src/simulation/v0_7_pure_ranged_terminal";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const RANGE = PBTypes.AttackVals.RANGE;

interface IFixture {
    actor: Unit;
    primary: Unit;
    noMelee: Unit;
    grid: ReturnType<typeof createCombatTestContext>["grid"];
    unitsHolder: ReturnType<typeof createCombatTestContext>["unitsHolder"];
    state: PureRangedTerminalState;
    incumbent: IEnumeratedCandidate;
}

function shot(
    actor: Unit,
    target: Unit,
    kind: "incumbent" | "shot",
    overrides: {
        kill?: 0 | 1;
        net?: number;
        enemy?: number;
        friendly?: number;
        primary?: number;
    } = {},
): IEnumeratedCandidate {
    const enemy = overrides.enemy ?? 100;
    const friendly = overrides.friendly ?? 0;
    return {
        kind,
        actions: [
            {
                type: "range_attack",
                attackerId: actor.getId(),
                targetId: target.getId(),
                aimCell: { ...target.getBaseCell() },
                aimSide: 0,
            },
        ],
        targetId: target.getId(),
        shotFeatures: {
            enemyDamage: enemy,
            friendlyFireDamage: friendly,
            primaryTargetDamage: overrides.primary ?? enemy,
            targetFirepower: 0,
            targetLevel: 1,
            targetIsRanged: 1,
            targetCanCastSpells: 0,
            targetNotYetActed: 1,
            targetWoundedFraction: 0,
            targetFocusFire: 0,
        },
        features: {
            moraleDelta: 0,
            luckDelta: 0,
            enemiesNotYetActedFrac: 1,
            alliesNotYetActedFrac: 1,
            lap: PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
            hourglassSpent: 0,
            spendsRangeShot: 1,
            spendsSpellCharge: 0,
            burnsResurrectionCharge: 0,
            expectedDamage: overrides.net ?? enemy - friendly,
            expectedKill: overrides.kill ?? 0,
        },
    };
}

function fixture(actorAbilities: readonly string[] = [], rangeShots = 6): IFixture {
    const context = createCombatTestContext();
    const actor = createTestUnit({
        team: LOWER,
        attackType: RANGE,
        rangeShots,
        name: "Ordinary shooter",
        abilities: [...actorAbilities],
    });
    const primary = createTestUnit({ team: UPPER, attackType: RANGE, rangeShots: 6, name: "Primary" });
    const noMelee = createTestUnit({
        team: UPPER,
        attackType: RANGE,
        rangeShots: 4,
        maxHp: 100,
        name: "Tsar Cannon",
        abilities: ["No Melee"],
    });
    placeUnit(context.grid, context.unitsHolder, actor, { x: 2, y: 7 });
    placeUnit(context.grid, context.unitsHolder, primary, { x: 6, y: 7 });
    placeUnit(context.grid, context.unitsHolder, noMelee, { x: 9, y: 7 });
    const state: PureRangedTerminalState = {
        eligible: true,
        initialScale: 1,
        originalUnits: [actor, primary, noMelee].map((unit) => ({ id: unit.getId(), team: unit.getTeam() })),
    };
    return {
        actor,
        primary,
        noMelee,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        state,
        incumbent: shot(actor, primary, "incumbent"),
    };
}

const rank = (
    f: IFixture,
    candidates: readonly IEnumeratedCandidate[],
    lap = PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
) => rankPureRangedJitNoMeleeFocusCandidates(f.actor, f.unitsHolder, candidates, f.state, lap);

describe("pure-ranged JIT No-Melee focus", () => {
    it("uses the exact lap 1..11 window and includes the current activation in pre-Armageddon slack", () => {
        const f = fixture([], 99);
        const focus = shot(f.actor, f.noMelee, "shot", { primary: 10 }); // 10 actions; slack 1 at lap 1
        expect(PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP).toBe(1);
        expect(rank(f, [f.incumbent, focus], 0)).toEqual([]);
        expect(rank(f, [f.incumbent, focus], PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP)[0]).toMatchObject({
            availableFullDamageActivationsUpperBound: 11,
            estimatedRequiredActivations: 10,
            deadlineSlack: 1,
        });
        expect(rank(f, [f.incumbent, focus], PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP)[0]).toMatchObject({
            availableFullDamageActivationsUpperBound: 1,
            estimatedRequiredActivations: 10,
            deadlineSlack: -9,
        });
        expect(rank(f, [f.incumbent, focus], PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP)).toEqual([]);
        expect(rank(f, [f.incumbent, focus], PURE_RANGED_JIT_NO_MELEE_FOCUS_END_LAP + 1)).toEqual([]);
    });

    it("rejects slack two while retaining one-buffer, exact, and overdue strata", () => {
        const f = fixture();
        const slackTwo = shot(f.actor, f.noMelee, "shot", { primary: 25 });
        const slackOne = shot(f.actor, f.noMelee, "shot", { primary: 20 });
        const exact = shot(f.actor, f.noMelee, "shot", { primary: 17 });
        const overdue = shot(f.actor, f.noMelee, "shot", { primary: 10 });
        expect(rank(f, [f.incumbent, slackTwo])).toEqual([]);
        expect(rank(f, [f.incumbent, slackOne])[0]?.deadlineSlack).toBe(1);
        expect(rank(f, [f.incumbent, exact])[0]?.deadlineSlack).toBe(0);
        expect(rank(f, [f.incumbent, overdue])[0]?.deadlineSlack).toBe(-4);
    });

    it("recomputes the finite-ammo upper bound and treats active Endless Quiver as unlimited", () => {
        const dry = fixture([], 0);
        expect(rank(dry, [dry.incumbent, shot(dry.actor, dry.noMelee, "shot", { primary: 100 })])).toEqual([]);

        const oneShot = fixture([], 1);
        expect(
            rank(oneShot, [oneShot.incumbent, shot(oneShot.actor, oneShot.noMelee, "shot", { primary: 50 })])[0],
        ).toMatchObject({ availableFullDamageActivationsUpperBound: 1, deadlineSlack: -1 });

        const endless = fixture(["Endless Quiver"], 1);
        expect(
            rank(endless, [endless.incumbent, shot(endless.actor, endless.noMelee, "shot", { primary: 10 })])[0],
        ).toMatchObject({ availableFullDamageActivationsUpperBound: 11, deadlineSlack: 1 });
    });

    it("excludes collateral, No-Melee, and Double-Shot actor cards using stable ownership", () => {
        for (const ability of ["No Melee", "Through Shot", "Large Caliber", "Area Throw", "Double Shot"]) {
            const f = fixture([ability]);
            expect(pureRangedJitNoMeleeFocusActorEligible(f.actor, f.state)).toBe(false);
            expect(rank(f, [f.incumbent, shot(f.actor, f.noMelee, "shot", { primary: 20 })])).toEqual([]);
        }
    });

    it("keeps intrinsic identity under Break but stops classifying a stolen-away card", () => {
        const f = fixture(["Large Caliber"]);
        f.actor.applyEffect(new EffectFactory().makeEffect("Break")!);
        expect(f.actor.getAbility("Large Caliber")).toBeUndefined();
        expect(ownsPureRangedJitClassifyingAbility(f.actor, "Large Caliber")).toBe(true);
        expect(pureRangedJitNoMeleeFocusActorEligible(f.actor, f.state)).toBe(false);

        f.actor.disableAbilityAsStolen("Large Caliber");
        expect(ownsPureRangedJitClassifyingAbility(f.actor, "Large Caliber")).toBe(false);
        expect(pureRangedJitNoMeleeFocusActorEligible(f.actor, f.state)).toBe(true);

        f.noMelee.applyEffect(new EffectFactory().makeEffect("Break")!);
        expect(f.noMelee.getAbility("No Melee")).toBeUndefined();
        expect(rank(f, [f.incumbent, shot(f.actor, f.noMelee, "shot", { primary: 20 })])).toHaveLength(1);
        f.noMelee.disableAbilityAsStolen("No Melee");
        expect(rank(f, [f.incumbent, shot(f.actor, f.noMelee, "shot", { primary: 20 })])).toEqual([]);
    });

    it("preserves inherited kill, the 0.80 enemy/net floors, friendly fire, and one-shot shape", () => {
        const f = fixture();
        const killingIncumbent = shot(f.actor, f.primary, "incumbent", { kill: 1 });
        expect(rank(f, [killingIncumbent, shot(f.actor, f.noMelee, "shot", { primary: 20 })])).toEqual([]);

        const atFloor = shot(f.actor, f.noMelee, "shot", { enemy: 80, net: 80, primary: 20 });
        expect(rank(f, [f.incumbent, atFloor])[0]?.minimumDamageRatio).toBe(
            PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR,
        );
        expect(rank(f, [f.incumbent, shot(f.actor, f.noMelee, "shot", { enemy: 79, primary: 20 })])).toEqual([]);
        expect(rank(f, [f.incumbent, shot(f.actor, f.noMelee, "shot", { net: 79, primary: 20 })])).toEqual([]);
        expect(
            rank(f, [f.incumbent, shot(f.actor, f.noMelee, "shot", { enemy: 101, friendly: 1, primary: 20 })]),
        ).toEqual([]);

        const moving = {
            ...atFloor,
            actions: [
                { type: "move_unit" as const, unitId: f.actor.getId(), path: [{ x: 3, y: 7 }] },
                ...atFloor.actions,
            ],
        };
        expect(rank(f, [f.incumbent, moving])).toEqual([]);
    });

    it("cannot intervene on waits, moves, move-shots, melee, spells, defend, or obstacle attacks", () => {
        const f = fixture();
        const actorId = f.actor.getId();
        const targetId = f.primary.getId();
        const forbidden: readonly GameAction[][] = [
            [{ type: "wait_turn", unitId: actorId }],
            [{ type: "move_unit", unitId: actorId, path: [{ x: 3, y: 7 }] }],
            [{ type: "move_unit", unitId: actorId, path: [{ x: 3, y: 7 }] }, ...f.incumbent.actions],
            [{ type: "melee_attack", attackerId: actorId, targetId, attackFrom: { x: 5, y: 7 } }],
            [{ type: "cast_spell", casterId: actorId, spellName: "Fireball" }],
            [{ type: "defend_turn", unitId: actorId }],
            [{ type: "obstacle_attack", attackerId: actorId, targetPosition: { x: 7, y: 7 } }],
        ];
        for (const actions of forbidden) {
            expect(isPureRangedJitNoMeleeFocusStationaryIncumbent(f.actor, actions)).toBe(false);
            const incumbent = { ...f.incumbent, actions };
            expect(rank(f, [incumbent, shot(f.actor, f.noMelee, "shot", { primary: 20 })])).toEqual([]);
        }
    });

    it("locks an armed incumbent and follows the preregistered stable redirect order", () => {
        const f = fixture();
        const locked = shot(f.actor, f.noMelee, "incumbent", { primary: 20 });
        const ordinaryAlternative = shot(f.actor, f.noMelee, "shot", { primary: 50 });
        expect(rank(f, [locked, ordinaryAlternative])).toEqual([
            expect.objectContaining({ candidate: locked, incumbentLocked: true }),
        ]);
        const immediateKill = shot(f.actor, f.noMelee, "shot", { kill: 1, primary: 100 });
        expect(rank(f, [locked, immediateKill])[0]?.candidate).toBe(immediateKill);

        const lowerRatio = shot(f.actor, f.noMelee, "shot", { enemy: 80, net: 80, primary: 20 });
        const higherRatio = shot(f.actor, f.noMelee, "shot", { enemy: 90, net: 90, primary: 20 });
        expect(rank(f, [f.incumbent, lowerRatio, higherRatio])[0]?.candidate).toBe(higherRatio);
        const killing = shot(f.actor, f.noMelee, "shot", { kill: 1, enemy: 80, net: 80, primary: 20 });
        expect(rank(f, [f.incumbent, higherRatio, killing])[0]?.candidate).toBe(killing);

        const wounded = createTestUnit({
            team: UPPER,
            attackType: RANGE,
            rangeShots: 4,
            maxHp: 100,
            name: "Wounded Tsar",
            abilities: ["No Melee"],
        });
        placeUnit(f.grid, f.unitsHolder, wounded, { x: 9, y: 9 });
        wounded.applyDamage(50, 0, new SceneLogMock(), false);
        const extendedState: PureRangedTerminalState = {
            ...f.state,
            originalUnits: [...f.state.originalUnits, { id: wounded.getId(), team: wounded.getTeam() }],
        };
        const woundedAim = shot(f.actor, wounded, "shot", { enemy: 80, net: 80, primary: 10 });
        expect(
            rankPureRangedJitNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, higherRatio, woundedAim],
                extendedState,
                PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
            )[0]?.candidate,
        ).toBe(woundedAim);

        const overdue = shot(f.actor, f.noMelee, "shot", { enemy: 80, net: 80, primary: 10 });
        expect(rank(f, [f.incumbent, higherRatio, overdue])[0]?.candidate).toBe(overdue);
    });
});
