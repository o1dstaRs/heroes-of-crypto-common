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
    v08ArmageddonPreservationOpportunity,
    v08ArmageddonWaveDamage,
    v08FirstUpcomingArmageddonWave,
    v08UpcomingArmageddonDamageThrough,
} from "../../src/ai/versions/v0_8_armageddon_endgame";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { createTestUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

describe("v0.8 Armageddon endgame", () => {
    it("matches the engine's exact per-wave raw damage and live-decision timing", () => {
        const abomination = createTestUnit({
            team: LEFT,
            name: "Abomination",
            maxHp: 600,
            amountAlive: 8,
            armor: 999,
            magicResist: 100,
        });

        expect([1, 2, 3, 4].map((wave) => v08ArmageddonWaveDamage(abomination, wave))).toEqual([
            1_200, 2_400, 3_600, 4_800,
        ]);
        expect(v08FirstUpcomingArmageddonWave(11)).toBe(1);
        expect(v08FirstUpcomingArmageddonWave(12)).toBe(2);
        expect(v08UpcomingArmageddonDamageThrough(abomination, 11, 2)).toBe(3_600);
        expect(v08UpcomingArmageddonDamageThrough(abomination, 12, 2)).toBe(2_400);
    });

    it("lets an intact Water Shield absorb exactly the first upcoming wave", () => {
        const shielded = createTestUnit({ team: LEFT, name: "Shielded", maxHp: 100, amountAlive: 4 });
        shielded.applyBuff(
            new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: shielded.getAmountAlive() }),
        );

        expect(v08UpcomingArmageddonDamageThrough(shielded, 11, 1)).toBe(0);
        expect(v08UpcomingArmageddonDamageThrough(shielded, 11, 2)).toBe(200);
        expect(v08UpcomingArmageddonDamageThrough(shielded, 12, 2)).toBe(0);
        expect(v08UpcomingArmageddonDamageThrough(shielded, 12, 3)).toBe(300);
    });

    it("detects a current environmental survival edge and treats equality as doomed", () => {
        const ally = createTestUnit({ team: LEFT, name: "Abomination", maxHp: 600, amountAlive: 8 });
        const enemy = createTestUnit({ team: RIGHT, name: "Abomination", maxHp: 600, amountAlive: 8 });
        ally.applyDamage(964, 0, new SceneLogMock());
        enemy.applyDamage(1_416, 0, new SceneLogMock());

        const opportunity = v08ArmageddonPreservationOpportunity(ally, enemy, 9);
        expect(opportunity?.resolutionWave).toBe(2);

        ally.applyDamage(236, 0, new SceneLogMock());
        expect(ally.getCumulativeHp()).toBe(3_600);
        expect(v08ArmageddonPreservationOpportunity(ally, enemy, 9)).toBeUndefined();
        expect(v08ArmageddonPreservationOpportunity(ally, enemy, 7)).toBeUndefined();
    });
});
