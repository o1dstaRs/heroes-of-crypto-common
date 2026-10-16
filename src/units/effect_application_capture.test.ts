import { describe, expect, test } from "bun:test";

import {
    beginEffectApplicationCapture,
    endEffectApplicationCapture,
    isEffectApplicationNoise,
    recordEffectApplication,
} from "./effect_application_capture";

describe("effect application capture", () => {
    test("army passives, auras, augments and engine markers are noise; real spells are news", () => {
        for (const name of [
            "Angelic Host Blessing",
            "Arcane Ward Blessing",
            "Warding Mane Blessing",
            "Arrows Wingshield Blessing",
            "Disguise Aura",
            "Armor Augment",
            "Morale",
            "Water Shield",
        ]) {
            expect(isEffectApplicationNoise(name), name).toBe(true);
        }
        // The castable Book of Healing spell is plain "Blessing" — not an army passive.
        for (const name of ["Blessing", "Stun", "Poison", "Spiritual Armor", "Luck Shield"]) {
            expect(isEffectApplicationNoise(name), name).toBe(false);
        }
    });

    test("a capture window keeps the news and drops the noise", () => {
        beginEffectApplicationCapture();
        recordEffectApplication({ unitId: "u1", name: "Arcane Ward Blessing", kind: "buff" });
        recordEffectApplication({ unitId: "u1", name: "Stun", kind: "debuff", laps: 1 });
        const records = endEffectApplicationCapture();
        expect(records.map((record) => record.name)).toEqual(["Stun"]);
    });
});
