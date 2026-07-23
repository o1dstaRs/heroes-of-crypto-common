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
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP,
    rankPureRangedParetoNoMeleeFocusCandidates,
} from "../../src/simulation/pure_ranged_pareto_no_melee_focus";
import {
    capturePureRangedTerminalState,
    type PureRangedTerminalState,
} from "../../src/simulation/v0_7_pure_ranged_terminal";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const RANGE = PBTypes.AttackVals.RANGE;

interface IFixture {
    actor: Unit;
    primary: Unit;
    noMelee: Unit;
    unitsHolder: ReturnType<typeof createCombatTestContext>["unitsHolder"];
    state: PureRangedTerminalState;
    incumbent: IEnumeratedCandidate;
    focus: IEnumeratedCandidate;
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
    const enemy = overrides.enemy ?? 120;
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
            lap: 1,
            hourglassSpent: 0,
            spendsRangeShot: 1,
            spendsSpellCharge: 0,
            burnsResurrectionCharge: 0,
            expectedDamage: overrides.net ?? enemy - friendly,
            expectedKill: overrides.kill ?? 0,
        },
    };
}

function fixture(actorAbilities: readonly string[] = ["Through Shot"]): IFixture {
    const context = createCombatTestContext();
    const actor = createTestUnit({ team: LOWER, attackType: RANGE, rangeShots: 9, abilities: [...actorAbilities] });
    const primary = createTestUnit({ team: UPPER, attackType: RANGE, rangeShots: 9, name: "Incumbent target" });
    const noMelee = createTestUnit({
        team: UPPER,
        attackType: RANGE,
        rangeShots: 9,
        name: "No Melee target",
        abilities: ["No Melee"],
    });
    placeUnit(context.grid, context.unitsHolder, actor, { x: 2, y: 7 });
    placeUnit(context.grid, context.unitsHolder, primary, { x: 6, y: 7 });
    placeUnit(context.grid, context.unitsHolder, noMelee, { x: 9, y: 7 });
    const state: PureRangedTerminalState = {
        eligible: true,
        initialScale: 1,
        originalUnits: [actor, primary, noMelee].map((unit) => ({
            id: unit.getId(),
            team: unit.getTeam(),
            activeAbilityNames: unit.getAbilities().map((ability) => ability.getName()),
        })),
    };
    return {
        actor,
        primary,
        noMelee,
        unitsHolder: context.unitsHolder,
        state,
        incumbent: shot(actor, primary, "incumbent", { enemy: 100, net: 100, primary: 100 }),
        focus: shot(actor, noMelee, "shot", { enemy: 120, net: 120, primary: 60 }),
    };
}

function rank(f: IFixture, candidates: readonly IEnumeratedCandidate[], lap = 1) {
    return rankPureRangedParetoNoMeleeFocusCandidates(f.actor, f.unitsHolder, candidates, f.state, lap);
}

describe("pure-ranged aggregate-Pareto No-Melee focus", () => {
    it("accepts higher aggregate damage even when the intentionally changed target receives lower primary damage", () => {
        const f = fixture();
        const [selected] = rank(f, [f.incumbent, f.focus]);
        expect(selected.candidate).toBe(f.focus);
        expect(selected.actorAbility).toBe("through_shot");
        expect(selected.noMeleeTargetId).toBe(f.noMelee.getId());
        expect(selected.expectedNoMeleeDamage).toBe(60);
        expect(selected.expectedEnemyDamageDelta).toBe(20);
        expect(selected.expectedNetDamageDelta).toBe(20);
        expect(selected.enemyDamageRatio).toBe(1.2);
        expect(selected.netDamageRatio).toBe(1.2);
        expect(selected.minimumDamageRatio).toBeGreaterThanOrEqual(1);
    });

    it("admits a preregistered five-percent aggregate sacrifice but not a larger one", () => {
        const f = fixture();
        const atFloor = shot(f.actor, f.noMelee, "shot", { enemy: 95, net: 95, primary: 70 });
        const enemyBelowFloor = shot(f.actor, f.noMelee, "shot", { enemy: 94, net: 95, primary: 90 });
        const netBelowFloor = shot(f.actor, f.noMelee, "shot", { enemy: 95, net: 94, primary: 90 });

        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(f.actor, f.unitsHolder, [f.incumbent, atFloor], f.state, 4),
        ).toEqual([]);
        const [selected] = rankPureRangedParetoNoMeleeFocusCandidates(
            f.actor,
            f.unitsHolder,
            [f.incumbent, atFloor, enemyBelowFloor, netBelowFloor],
            f.state,
            4,
            0.95,
        );
        expect(selected.candidate).toBe(atFloor);
        expect(selected.minimumDamageRatio).toBe(0.95);
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, enemyBelowFloor],
                f.state,
                4,
                0.95,
            ),
        ).toEqual([]);
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, netBelowFloor],
                f.state,
                4,
                0.95,
            ),
        ).toEqual([]);
    });

    it("ranks a preserved kill first, then the smallest aggregate sacrifice before target-local damage", () => {
        const f = fixture();
        const highTargetDamage = shot(f.actor, f.noMelee, "shot", { enemy: 95, net: 95, primary: 95 });
        const betterRetention = shot(f.actor, f.noMelee, "shot", { enemy: 98, net: 98, primary: 60 });
        const secureKill = shot(f.actor, f.noMelee, "shot", { kill: 1, enemy: 95, net: 95, primary: 50 });

        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, highTargetDamage, betterRetention],
                f.state,
                4,
                0.95,
            )[0]?.candidate,
        ).toBe(betterRetention);
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, betterRetention, secureKill],
                f.state,
                4,
                0.95,
            )[0]?.candidate,
        ).toBe(secureKill);

        const oldOrderTarget = shot(f.actor, f.noMelee, "shot", { enemy: 101, net: 101, primary: 95 });
        const higherRatio = shot(f.actor, f.noMelee, "shot", { enemy: 110, net: 110, primary: 60 });
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, oldOrderTarget, higherRatio],
                f.state,
                4,
                1,
            )[0]?.candidate,
        ).toBe(oldOrderTarget);
    });

    it("requires exact Through Shot-only or Large Caliber-only actor ability shapes", () => {
        const through = fixture(["Through Shot"]);
        expect(rank(through, [through.incumbent, through.focus])).toHaveLength(1);

        const caliber = fixture(["Large Caliber"]);
        expect(rank(caliber, [caliber.incumbent, caliber.focus])[0]?.actorAbility).toBe("large_caliber");

        for (const abilities of [[], ["Through Shot", "Large Caliber"], ["Through Shot", "Area Throw"]]) {
            const mixed = fixture(abilities);
            expect(rank(mixed, [mixed.incumbent, mixed.focus])).toEqual([]);
        }
    });

    it("rejects every aggregate regression, lost kill, invalid delivery, or non-original target", () => {
        const f = fixture();
        const mutate = (overrides: Parameters<typeof shot>[3]): IEnumeratedCandidate =>
            shot(f.actor, f.noMelee, "shot", overrides);
        expect(rank(f, [f.incumbent, mutate({ enemy: 99, net: 100 })])).toEqual([]);
        expect(rank(f, [f.incumbent, mutate({ enemy: 120, net: 99 })])).toEqual([]);
        expect(rank(f, [f.incumbent, mutate({ enemy: 121, net: 100, friendly: 1 })])).toEqual([]);

        const killingIncumbent = shot(f.actor, f.primary, "incumbent", { kill: 1, enemy: 100, net: 100 });
        expect(rank(f, [killingIncumbent, f.focus])).toEqual([]);

        const moving: IEnumeratedCandidate = {
            ...f.focus,
            actions: [{ type: "move_unit", unitId: f.actor.getId(), path: [{ x: 3, y: 7 }] }, ...f.focus.actions],
        };
        expect(rank(f, [f.incumbent, moving])).toEqual([]);
        const noShotSpend = { ...f.focus, features: { ...f.focus.features, spendsRangeShot: 0 as const } };
        expect(rank(f, [f.incumbent, noShotSpend])).toEqual([]);

        const summonedNoMelee = createTestUnit({ team: UPPER, attackType: RANGE, abilities: ["No Melee"] });
        expect(rank(f, [f.incumbent, shot(f.actor, summonedNoMelee, "shot")])).toEqual([]);
    });

    it("fails closed for non-shot incumbents, mixed boards, an already-focused incumbent, and lap nine", () => {
        const f = fixture();
        const wait: IEnumeratedCandidate = {
            ...f.incumbent,
            actions: [{ type: "wait_turn", unitId: f.actor.getId() }],
            features: { ...f.incumbent.features, spendsRangeShot: 0, expectedDamage: 0 },
            shotFeatures: undefined,
        };
        expect(rank(f, [wait, f.focus])).toEqual([]);
        expect(rank(f, [{ ...f.focus, kind: "incumbent" }, f.focus])).toEqual([]);
        expect(rank(f, [f.incumbent, f.focus], PURE_RANGED_PARETO_NO_MELEE_FOCUS_END_LAP)).toEqual([]);
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, f.focus],
                { ...f.state, eligible: false },
                1,
            ),
        ).toEqual([]);
    });

    it("widens exact Pareto to mixed boards only under the explicit any-board scope", () => {
        const f = fixture(["Large Caliber"]);
        const mixedState = { ...f.state, eligible: false };

        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(f.actor, f.unitsHolder, [f.incumbent, f.focus], mixedState, 3),
        ).toEqual([]);
        const [selected] = rankPureRangedParetoNoMeleeFocusCandidates(
            f.actor,
            f.unitsHolder,
            [f.incumbent, f.focus],
            mixedState,
            3,
            1,
            "any_board",
        );
        expect(selected).toMatchObject({
            candidate: f.focus,
            actorAbility: "large_caliber",
            noMeleeTargetId: f.noMelee.getId(),
            minimumDamageRatio: 1.2,
        });
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, f.focus],
                mixedState,
                3,
                0.95,
                "any_board",
            ),
        ).toEqual([]);
    });

    it("requires original native living actors and intrinsic-active No-Melee targets on any board", () => {
        const missingActor = fixture();
        const actorOmitted = {
            ...missingActor.state,
            eligible: false,
            originalUnits: missingActor.state.originalUnits.filter(({ id }) => id !== missingActor.actor.getId()),
        };
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                missingActor.actor,
                missingActor.unitsHolder,
                [missingActor.incumbent, missingActor.focus],
                actorOmitted,
                1,
                1,
                "any_board",
            ),
        ).toEqual([]);

        const inactiveActor = fixture();
        inactiveActor.actor.disableAbilityAsStolen("Through Shot");
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                inactiveActor.actor,
                inactiveActor.unitsHolder,
                [inactiveActor.incumbent, inactiveActor.focus],
                { ...inactiveActor.state, eligible: false },
                1,
                1,
                "any_board",
            ),
        ).toEqual([]);

        const inactiveTarget = fixture();
        inactiveTarget.noMelee.disableAbilityAsStolen("No Melee");
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                inactiveTarget.actor,
                inactiveTarget.unitsHolder,
                [inactiveTarget.incumbent, inactiveTarget.focus],
                { ...inactiveTarget.state, eligible: false },
                1,
                1,
                "any_board",
            ),
        ).toEqual([]);

        const combination = fixture(["Through Shot", "Large Caliber"]);
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                combination.actor,
                combination.unitsHolder,
                [combination.incumbent, combination.focus],
                { ...combination.state, eligible: false },
                1,
                1,
                "any_board",
            ),
        ).toEqual([]);
    });

    it("does not let post-capture stolen grants masquerade as intrinsic any-board cards", () => {
        const grantedActor = fixture([]);
        const beforeActorGrant = capturePureRangedTerminalState(grantedActor.unitsHolder, 1);
        grantedActor.actor.grantStolenAbility("Through Shot");
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                grantedActor.actor,
                grantedActor.unitsHolder,
                [grantedActor.incumbent, grantedActor.focus],
                { ...beforeActorGrant, eligible: false },
                1,
                1,
                "any_board",
            ),
        ).toEqual([]);

        const grantedTarget = fixture();
        grantedTarget.noMelee.deleteAbility("No Melee");
        const beforeTargetGrant = capturePureRangedTerminalState(grantedTarget.unitsHolder, 1);
        grantedTarget.noMelee.grantStolenAbility("No Melee");
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                grantedTarget.actor,
                grantedTarget.unitsHolder,
                [grantedTarget.incumbent, grantedTarget.focus],
                { ...beforeTargetGrant, eligible: false },
                1,
                1,
                "any_board",
            ),
        ).toEqual([]);

        const intrinsic = fixture(["Large Caliber"]);
        const intrinsicSnapshot = capturePureRangedTerminalState(intrinsic.unitsHolder, 1);
        expect(
            rankPureRangedParetoNoMeleeFocusCandidates(
                intrinsic.actor,
                intrinsic.unitsHolder,
                [intrinsic.incumbent, intrinsic.focus],
                { ...intrinsicSnapshot, eligible: false },
                1,
                1,
                "any_board",
            )[0]?.candidate,
        ).toBe(intrinsic.focus);
    });

    it("keeps the legacy pure-ranged default path identical to an explicit pure-ranged scope", () => {
        const f = fixture();
        expect(rank(f, [f.incumbent, f.focus])).toEqual(
            rankPureRangedParetoNoMeleeFocusCandidates(
                f.actor,
                f.unitsHolder,
                [f.incumbent, f.focus],
                f.state,
                1,
                1,
                "pure_ranged",
            ),
        );
    });
});
