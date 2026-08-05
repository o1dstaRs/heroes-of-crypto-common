import { describe, expect, test } from "bun:test";

import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import { reserveResearchRapidChargeShortlist } from "../../src/simulation/search_driver";

const candidate = (targetId: string, reserved = false): IEnumeratedCandidate => ({
    kind: "melee",
    targetId,
    standCell: { x: 1, y: 1 },
    actions: [
        {
            type: "melee_attack",
            attackerId: "charger",
            targetId,
            attackFrom: { x: 1, y: 1 },
        },
    ],
    ...(reserved ? { researchRapidChargeDifferentTargetReserved: true as const } : {}),
    features: {
        moraleDelta: 0,
        luckDelta: 0,
        enemiesNotYetActedFrac: 0,
        alliesNotYetActedFrac: 0,
        lap: 1,
        hourglassSpent: 0,
        spendsRangeShot: 0,
        spendsSpellCharge: 0,
        burnsResurrectionCharge: 0,
        expectedDamage: 10,
        expectedKill: 0,
    },
});

describe("Rapid Charge search reservation", () => {
    test("appends exactly one marked challenger and preserves the normal leaf winner", () => {
        const ordinary = candidate("ordinary");
        const reserved = candidate("reserved", true);
        const other = candidate("other");

        expect(reserveResearchRapidChargeShortlist([ordinary, reserved, other], [ordinary])).toEqual([
            ordinary,
            reserved,
        ]);
        expect(reserveResearchRapidChargeShortlist([ordinary, reserved, other], [ordinary, reserved])).toEqual([
            ordinary,
            reserved,
        ]);
        expect(reserveResearchRapidChargeShortlist([ordinary, other], [ordinary])).toEqual([ordinary]);
    });
});
