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
    createKitOmissionTally,
    mergeKitOmissionTallies,
    recordKitTurn,
} from "../../src/simulation/kit_omission_tally";

describe("kit omission tally", () => {
    it("splits every legal capability into chosen vs omitted, once per acting turn", () => {
        const tally = createKitOmissionTally();
        const omitted = recordKitTurn(
            tally,
            "Healer",
            "spell",
            new Set(["spell:Heal"]),
            new Map([
                ["spell:Heal", 0], // chosen; generated twin deduped into the incumbent anchor
                ["spell:Blessing", 4],
                ["move", 12],
                ["defend", 1],
            ]),
        );
        expect(omitted).toEqual(["defend", "move", "spell:Blessing"]);
        expect(tally.actingUnitTurns).toBe(1);
        expect(tally.capabilities["spell:Heal"]).toEqual({
            legalTurns: 1,
            chosenTurns: 1,
            omittedTurns: 0,
            legalCandidates: 0,
        });
        expect(tally.capabilities["spell:Blessing"]).toEqual({
            legalTurns: 1,
            chosenTurns: 0,
            omittedTurns: 1,
            legalCandidates: 4,
        });
        const healer = tally.creatures["Healer"];
        expect(healer.actingTurns).toBe(1);
        expect(healer.anySpellLegalTurns).toBe(1);
        expect(healer.anySpellCastTurns).toBe(1);
        expect(healer.anySpellOmittedTurns).toBe(0);
        expect(healer.capabilities["spell:Blessing"].omittedTurns).toBe(1);
        expect(healer.decisionShapes).toEqual({ spell: 1 });
    });

    it("counts a legal-but-castless turn as an any-spell omission", () => {
        const tally = createKitOmissionTally();
        recordKitTurn(
            tally,
            "Satyr",
            "melee+move",
            new Set(["move", "melee"]),
            new Map([
                ["move", 8],
                ["melee", 2],
                ["spell:Courage", 3],
            ]),
        );
        const satyr = tally.creatures["Satyr"];
        expect(satyr.anySpellLegalTurns).toBe(1);
        expect(satyr.anySpellCastTurns).toBe(0);
        expect(satyr.anySpellOmittedTurns).toBe(1);
        expect(tally.capabilities["spell:Courage"]).toEqual({
            legalTurns: 1,
            chosenTurns: 0,
            omittedTurns: 1,
            legalCandidates: 3,
        });
        // No spell legal at all -> anySpell* untouched.
        recordKitTurn(tally, "Satyr", "melee", new Set(["melee"]), new Map([["melee", 1]]));
        expect(tally.creatures["Satyr"].anySpellLegalTurns).toBe(1);
        expect(tally.creatures["Satyr"].actingTurns).toBe(2);
    });

    it("merges worker tallies additively across creatures, capabilities and outcomes", () => {
        const a = createKitOmissionTally();
        recordKitTurn(a, "Healer", "spell", new Set(["spell:Heal"]), new Map([["spell:Heal", 1]]));
        a.games = 1;
        a.outcomes.greenWins = 1;
        a.outcomes.totalLaps = 6;
        a.outcomes.endReasons["elimination"] = 1;
        const b = createKitOmissionTally();
        recordKitTurn(
            b,
            "Healer",
            "shot",
            new Set(["shot"]),
            new Map([
                ["shot", 2],
                ["spell:Heal", 1],
            ]),
        );
        b.games = 1;
        b.outcomes.redWins = 1;
        b.outcomes.totalLaps = 4;
        b.outcomes.endReasons["elimination"] = 1;

        mergeKitOmissionTallies(a, b);
        expect(a.games).toBe(2);
        expect(a.actingUnitTurns).toBe(2);
        expect(a.capabilities["spell:Heal"]).toEqual({
            legalTurns: 2,
            chosenTurns: 1,
            omittedTurns: 1,
            legalCandidates: 2,
        });
        const healer = a.creatures["Healer"];
        expect(healer.actingTurns).toBe(2);
        expect(healer.anySpellLegalTurns).toBe(2);
        expect(healer.anySpellCastTurns).toBe(1);
        expect(healer.anySpellOmittedTurns).toBe(1);
        expect(healer.decisionShapes).toEqual({ spell: 1, shot: 1 });
        expect(a.outcomes).toEqual({
            greenWins: 1,
            redWins: 1,
            draws: 0,
            totalLaps: 10,
            endReasons: { elimination: 2 },
        });
    });
});
