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

import { getUpgradePoints } from "../../src/perks/perk_properties";
import {
    ARCHETYPE_NAMES,
    buildArchetypeRoster,
    buildSharedArchetypeOffers,
    HYBRID_ROLE_CYCLE,
    PAYOFF_CELLS,
    playArchetypeGame,
    runArchetypePayoffSequential,
    setupForArchetype,
    type IArchetypeMatchOutcome,
} from "../../src/simulation/archetype_payoff";
import { getCreatureExperience, makeRng, STACK_EXPERIENCE_BUDGET } from "../../src/simulation/army";
import type { IMatchConfig } from "../../src/simulation/battle_engine";
import { liveTwinSetup } from "../../src/simulation/livetwin";

const greenWin: IArchetypeMatchOutcome = {
    winner: "green",
    laps: 4,
    endReason: "elimination",
    attrition: { decidedByArmageddon: false },
};

describe("B1 archetype payoff proxy", () => {
    it("defines the five registered scripts and only the requested melee mirror control", () => {
        expect(ARCHETYPE_NAMES).toEqual(["melee_coevo", "flyer_max", "ranged_max_sniper3", "hybrid", "anchor"]);
        expect(PAYOFF_CELLS).toHaveLength(11); // 5 choose 2 + one control
        expect(PAYOFF_CELLS.filter((cell) => cell.control)).toEqual([
            {
                id: "melee_coevo_control",
                archetypeA: "melee_coevo",
                archetypeB: "melee_coevo",
                control: true,
            },
        ]);
        expect(HYBRID_ROLE_CYCLE).toEqual(["melee", "melee", "ranged", "flyer"]);
    });

    it("builds every archetype from one deterministic injected-RNG offer with LiveTwin amounts", () => {
        let draws = 0;
        const injected = () => {
            draws += 1;
            return 0.25;
        };
        const offers = buildSharedArchetypeOffers(injected);
        expect(draws).toBeGreaterThan(0);
        expect(buildSharedArchetypeOffers(makeRng(123))).toEqual(buildSharedArchetypeOffers(makeRng(123)));

        for (const name of ARCHETYPE_NAMES) {
            const first = buildArchetypeRoster(name, offers);
            const second = buildArchetypeRoster(name, offers);
            expect(first).toEqual(second);
            expect(first.roster).toHaveLength(6);
            for (const unit of first.roster) {
                const exp = getCreatureExperience(unit.creatureName)!;
                expect(unit.amount).toBe(Math.max(1, Math.ceil(STACK_EXPERIENCE_BUDGET / exp)));
            }
        }

        const hybrid = buildArchetypeRoster("hybrid", offers);
        expect(hybrid.hybridRoleSelections.map((selection) => selection.role)).toEqual([
            "melee",
            "melee",
            "ranged",
            "flyer",
            "melee",
            "melee",
        ]);
        expect(hybrid.hybridRoleFallbacks).toBe(
            hybrid.hybridRoleSelections.filter((selection) => selection.fallback).length,
        );
    });

    it("pins ranged Sniper3 and spends the remaining LiveTwin budget in anchor order", () => {
        const base = liveTwinSetup();
        expect(setupForArchetype("melee_coevo")).toEqual(base);
        const ranged = setupForArchetype("ranged_max_sniper3");
        expect(ranged.perk).toBe(base.perk);
        expect(ranged.augments).toEqual([
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 1 },
        ]);
        expect(ranged.augments.reduce((sum, augment) => sum + augment.value, 0)).toBe(getUpgradePoints(ranged.perk));
    });

    it("reuses a pair seed and swaps roster plus setup between sides", () => {
        const cell = PAYOFF_CELLS.find((candidate) => candidate.id === "melee_coevo_vs_ranged_max_sniper3")!;
        const configs: IMatchConfig[] = [];
        const matchRunner = (config: IMatchConfig): IArchetypeMatchOutcome => {
            configs.push(config);
            return greenWin;
        };
        const options = { gamesPerCell: 2, baseSeed: 77 };
        const first = playArchetypeGame(cell, options, 0, { matchRunner });
        const second = playArchetypeGame(cell, options, 1, { matchRunner });

        expect(first.seed).toBe(second.seed);
        expect(first.greenArchetype).toBe("melee_coevo");
        expect(second.greenArchetype).toBe("ranged_max_sniper3");
        expect(first.greenRoster).toBe(second.redRoster);
        expect(first.redRoster).toBe(second.greenRoster);
        expect(configs[0].greenAugments).toEqual(configs[1].redAugments);
        expect(configs[0].redAugments).toEqual(configs[1].greenAugments);
        expect(first.winnerSlot).toBe("a");
        expect(second.winnerSlot).toBe("b");
    });

    it("summarizes decisive rates, the control and hybrid role fallbacks without an oracle verdict", () => {
        const summary = runArchetypePayoffSequential({ gamesPerCell: 2, baseSeed: 5 }, { matchRunner: () => greenWin });
        expect(summary.status).toBe("exploratory_offer_proxy");
        expect(summary.totalGames).toBe(22);
        expect(summary.controlCell.decisiveRate).toBe(1);
        expect(summary.controlCell.decisiveWinRateA).toBe(0.5);
        expect(summary.controlCell.decisiveGreenWinRate).toBe(1);
        expect(summary.cells.every((cell) => cell.decisiveRate === 1)).toBe(true);
        expect(summary.meleeChallenge.bestDecisiveWinRate).toBe(0.5);
        expect(summary.meleeChallenge.anyAtOrAboveThreshold).toBe(false);
        expect(summary.provenance.hybridRosterBuilds).toBeGreaterThan(0);
        expect(summary.provenance.hybridRoleFallbacks).toBeGreaterThanOrEqual(0);
        expect(summary.limitations.some((limitation) => limitation.includes("oracle"))).toBe(true);
    });
});
