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

import { processTerrifyingGazeAbility } from "../../src/abilities/terrifying_gaze_ability";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createTestUnit } from "../helpers/combat";

describe("Manticore", () => {
    it("is configured as a Chaos level 2 mounted (2x1) flyer with its three abilities", () => {
        const config = getCreatureConfig(PBTypes.TeamVals.LOWER, "Chaos", "Manticore", "manticore_512", 1);
        expect(config.level).toBe(PBTypes.UnitLevelVals.SECOND);
        // Mounted class: the body is 2 cells long and 1 tall; `size` is the legacy art tier and must read
        // as the bigger square (size === max(width, height)).
        expect(config.size).toBe(PBTypes.UnitSizeVals.LARGE);
        expect([config.footprint_width, config.footprint_height]).toEqual([2, 1]);
        expect(config.movement_type).toBe(PBTypes.MovementVals.FLY);
        expect(config.attack_type).toBe(PBTypes.AttackVals.MELEE);
        expect(config.abilities).toEqual(["Warding Mane Blessing", "Terrifying Gaze", "Deep Wounds Level 2"]);
    });

    describe("Terrifying Gaze", () => {
        const gazer = () =>
            createTestUnit({
                name: "Manticore",
                team: PBTypes.TeamVals.UPPER,
                abilities: ["Terrifying Gaze"],
                stackPower: 5,
            });

        it("bars the frightened unit from the gazer alone, and only for that one enemy", () => {
            const manticore = gazer();
            const bystander = createTestUnit({ name: "Bystander", team: PBTypes.TeamVals.UPPER });
            const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LOWER });

            // Stack power 5 => 60% per hit; a handful of attempts makes a miss vanishingly unlikely.
            const sceneLog = new SceneLogMock();
            for (let attempt = 0; attempt < 40 && !victim.hasEffectActive("Terrifying Gaze"); attempt++) {
                processTerrifyingGazeAbility(manticore, victim, victim, sceneLog);
            }

            expect(victim.hasEffectActive("Terrifying Gaze")).toBe(true);
            expect(victim.getForbiddenTarget()).toBe(manticore.getId());
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(true);
            // The inverse of Aggr: everyone else stays a legal target.
            expect(victim.cannotAttackUnitId(bystander.getId())).toBe(false);
            // ...and it must not have narrowed the victim onto a forced target the way Aggr does.
            expect(victim.getTarget()).toBe("");
        });

        it("never lands on a mind-resistant target", () => {
            const manticore = gazer();
            const resistant = createTestUnit({
                name: "Mechanism",
                team: PBTypes.TeamVals.LOWER,
                abilities: ["Mechanism"],
            });
            const sceneLog = new SceneLogMock();

            for (let attempt = 0; attempt < 40; attempt++) {
                processTerrifyingGazeAbility(manticore, resistant, resistant, sceneLog);
            }

            expect(resistant.hasEffectActive("Terrifying Gaze")).toBe(false);
            expect(resistant.cannotAttackUnitId(manticore.getId())).toBe(false);
        });

        it("releases the victim once the effect expires", () => {
            const manticore = gazer();
            const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LOWER });
            const sceneLog = new SceneLogMock();

            for (let attempt = 0; attempt < 40 && !victim.hasEffectActive("Terrifying Gaze"); attempt++) {
                processTerrifyingGazeAbility(manticore, victim, victim, sceneLog);
            }
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(true);

            victim.deleteEffect("Terrifying Gaze");
            victim.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(victim.getForbiddenTarget()).toBe("");
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(false);
        });

        it("preserves the forbidden target through a ranked display-only status refresh", () => {
            const manticore = gazer();
            const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LOWER });

            // Ranked reconstructs combat effects as display entries and keeps the server authoritative for
            // mechanics; it deliberately does not create Effect objects that could double-apply stats.
            victim.getUnitProperties().applied_debuffs.push("Terrifying Gaze");
            victim.getUnitProperties().applied_debuffs_laps.push(1);
            victim.getUnitProperties().applied_debuffs_descriptions.push("Cannot attack the gazer.");
            victim.getUnitProperties().applied_debuffs_powers.push(0);
            victim.setForbiddenTarget(manticore.getId());

            victim.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

            expect(victim.hasEffectActive("Terrifying Gaze")).toBe(false);
            expect(victim.hasStatusApplied("Terrifying Gaze")).toBe(true);
            expect(victim.cannotAttackUnitId(manticore.getId())).toBe(true);
        });
    });
});
