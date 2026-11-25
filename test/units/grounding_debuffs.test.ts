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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { processHamstringAbility } from "../../src/abilities/hamstring_ability";
import { ARTIFACT_POWER, Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { isGroundedByDebuffNames, type Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

/**
 * Owner ruling, 2026-11-25: Gravebound and Hamstrung keep their slow and also ground a flying unit. It
 * cannot fly and walks until the debuff wears off, and the sidebar shows it as a walking unit. Quagmire
 * only slows.
 */
const debuff = (name: string) => new Spell({ spellProperties: getSpellConfig("Death", name), amount: 1 });

const flyer = (): Unit =>
    createTestUnit({ name: "Griffin", team: PBTypes.TeamVals.LEFT, movementType: PBTypes.MovementVals.FLY });

describe("grounding debuffs", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });
    afterEach(() => setDeterministicRandomSource(undefined));

    for (const name of ["Gravebound", "Hamstrung"]) {
        it(`${name} grounds a flyer until it wears off`, () => {
            const unit = flyer();
            unit.applyDebuff(debuff(name));

            expect(unit.isGrounded()).toBe(true);
            expect(unit.canFly()).toBe(false);
            expect(unit.getMovementType()).toBe(PBTypes.MovementVals.WALK);
            expect(unit.isFlyingCreature()).toBe(true);

            unit.deleteDebuff(name);
            expect(unit.isGrounded()).toBe(false);
            expect(unit.canFly()).toBe(true);
            expect(unit.getMovementType()).toBe(PBTypes.MovementVals.FLY);
        });

        it(`${name} grounds a ranked client's flyer from the snapshot's debuff names alone`, () => {
            // A ranked client keeps no debuff objects; the server's debuffs arrive only as display names.
            const unit = flyer();
            (unit.getUnitProperties() as { applied_debuffs: string[] }).applied_debuffs.push(name);

            expect(unit.canFly()).toBe(false);
            expect(isGroundedByDebuffNames(unit.getUnitProperties().applied_debuffs)).toBe(true);
        });
    }

    it("Quagmire only slows a flyer", () => {
        const unit = flyer();
        unit.applyDebuff(debuff("Quagmire"));

        expect(unit.canFly()).toBe(true);
        expect(unit.isGrounded()).toBe(false);
        expect(isGroundedByDebuffNames(unit.getUnitProperties().applied_debuffs)).toBe(false);
    });

    it("a Gravebound walker is only slowed", () => {
        const walker = createTestUnit({ team: PBTypes.TeamVals.LEFT, movementType: PBTypes.MovementVals.WALK });
        walker.applyDebuff(debuff("Gravebound"));

        expect(walker.isGrounded()).toBe(false);
        expect(walker.getMovementType()).toBe(PBTypes.MovementVals.WALK);
    });

    it("a grounded flyer no longer crosses the lava centre", () => {
        const { grid, unitsHolder } = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const unit = flyer();
        placeUnit(grid, unitsHolder, unit, { x: 5, y: 7 });
        const routeTo = (target: { x: number; y: number }) =>
            new PathHelper(testGridSettings)
                .getMovePath(
                    unit.getBaseCell(),
                    grid.getMatrix(),
                    unit.getSteps(),
                    grid.getAggrMatrixByTeam(PBTypes.TeamVals.RIGHT),
                    unit.canFly(),
                    unit.isSmallSize(),
                    unit.canTraverseLava(),
                )
                .knownPaths.get((target.x << 4) | target.y)?.[0];
        const target = { x: 7, y: 5 };
        expect(routeTo(target)?.hasLavaCell).toBe(true);

        unit.applyDebuff(debuff("Hamstrung"));

        expect(routeTo(target)?.hasLavaCell ?? false).toBe(false);
    });

    it("a grounded flyer keeps Winged Boots and never picks up Swift Boots", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, Tier1Artifact.WINGED_BOOTS);
        const unit = flyer();
        placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
        unitsHolder.applyArtifacts(fightProperties);
        unit.applyDebuff(debuff("Gravebound"));

        // Every ranked snapshot recomputes the artifacts; a grounded flyer is still the same creature.
        unitsHolder.applyArtifacts(fightProperties);
        expect(unit.getBuff("Winged Boots")?.getPower()).toBe(ARTIFACT_POWER.WINGED_BOOTS_STEPS);

        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 1, Tier1Artifact.SWIFT_BOOTS);
        unitsHolder.applyArtifacts(fightProperties);
        expect(unit.getBuff("Swift Boots")).toBeUndefined();
    });

    it("Hamstring still lands on a flyer that Gravebound already grounded", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const dryad = createTestUnit({ name: "Dryad", team: PBTypes.TeamVals.RIGHT, abilities: ["Hamstring"] });
        const target = flyer();
        placeUnit(grid, unitsHolder, dryad, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, target, { x: 5, y: 6 });
        target.applyDebuff(debuff("Gravebound"));
        setDeterministicRandomSource(() => 0);

        processHamstringAbility(dryad, target, dryad, unitsHolder, grid, new SceneLogMock());

        expect(target.hasDebuffActive("Hamstrung")).toBe(true);
    });
});
