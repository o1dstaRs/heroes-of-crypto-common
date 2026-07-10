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

import type { ICandidateFeatures, IEnumeratedCandidate } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import type { Unit } from "../../src/units/unit";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch, type IDecisionObservation } from "../../src/simulation/battle_engine";
import {
    createMisplayAuditTally,
    finalizeMisplayAudit,
    observeMisplayDecision,
} from "../../src/simulation/misplay_audit";

const features: ICandidateFeatures = {
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 1,
    hourglassSpent: 0,
    spendsRangeShot: 0,
    spendsSpellCharge: 0,
    burnsResurrectionCharge: 0,
    expectedDamage: 0,
    expectedKill: 0,
};

const candidate = (kind: IEnumeratedCandidate["kind"], spellName?: string): IEnumeratedCandidate => ({
    kind,
    actions: [],
    spellName,
    features,
});

const observation = (incumbent: GameAction[] = [{ type: "end_turn", unitId: "angel", reason: "manual" }]) =>
    ({
        unit: { getName: () => "Angel" } as Unit,
        context: {} as IDecisionObservation["context"],
        incumbent,
        strategyVersion: "v0.6",
    }) satisfies IDecisionObservation;

describe("MISPLAY_AUDIT census", () => {
    it("observes the real strategy decision before execution through a default-off match hook", () => {
        FightStateManager.getInstance();
        let turns = 0;
        const result = runMatch({
            greenVersion: "v0.6",
            redVersion: "v0.6",
            roster: buildRoster(makeRng(7)),
            seed: 7,
            maxLaps: 1,
            decisionObserver: ({ unit, context, incumbent, strategyVersion }) => {
                turns += 1;
                expect(unit.isDead()).toBe(false);
                expect(context.fightProperties).toBeDefined();
                expect(incumbent.length).toBeGreaterThan(0);
                expect(strategyVersion).toBe("v0.6");
            },
        });
        expect(turns).toBeGreaterThan(0);
        expect(result.laps).toBeGreaterThan(0);
    });

    it("counts an omitted class once per turn while retaining its alternative-candidate count", () => {
        const tally = createMisplayAuditTally();
        observeMisplayDecision(tally, observation(), () => ({
            candidates: [
                candidate("incumbent"),
                candidate("defend"),
                candidate("wait"),
                candidate("area_throw"),
                candidate("spell", "Resurrection"),
                candidate("spell", "Resurrection"),
                candidate("spell", "Wind Flow"),
            ],
            truncated: [],
        }));

        expect(tally.actingUnitTurns).toBe(1);
        expect(tally.classCounters.spell).toEqual({ opportunityTurns: 1, alternativeCandidates: 3 });
        expect(tally.spellCounters.Resurrection).toEqual({ opportunityTurns: 1, alternativeCandidates: 2 });
        expect(tally.capabilityCounters["spell:Resurrection"].opportunityTurns).toBe(1);
        expect(tally.creatures.Angel.opportunityCandidates["spell:Resurrection"]).toBe(2);
        expect(tally.creatures.Angel.opportunities).toMatchObject({
            defend: 1,
            wait: 1,
            area_throw: 1,
            "spell:Resurrection": 1,
            "spell:Wind Flow": 1,
        });
    });

    it("does not call a class omitted when the incumbent already uses that class", () => {
        const tally = createMisplayAuditTally();
        observeMisplayDecision(tally, observation([{ type: "wait_turn", unitId: "angel" }]), () => ({
            candidates: [candidate("incumbent"), candidate("wait"), candidate("defend")],
            truncated: [],
        }));
        expect(tally.classCounters.wait.opportunityTurns).toBe(0);
        expect(tally.classCounters.wait.alternativeCandidates).toBe(1);
        expect(tally.capabilityCounters.wait).toBeUndefined();
        expect(tally.capabilityCounters.defend.opportunityTurns).toBe(1);
    });

    it("reports focus spells, top-three summed share and the threshold without claiming a verdict", () => {
        const tally = createMisplayAuditTally();
        for (let i = 0; i < 4; i += 1) {
            observeMisplayDecision(tally, observation(), () => ({
                candidates: [
                    candidate("incumbent"),
                    candidate("defend"),
                    candidate("wait"),
                    candidate("spell", "Wind Flow"),
                    ...(i < 3 ? [candidate("area_throw")] : []),
                    ...(i < 2 ? [candidate("spell", "Castling")] : []),
                    ...(i < 1 ? [candidate("spell", "Resurrection")] : []),
                ],
                truncated: [],
            }));
        }
        tally.games = 1;
        const report = finalizeMisplayAudit({ games: 1, baseSeed: 1 }, tally);
        expect(report.focusBreakdown["spell:Castling"].opportunityTurns).toBe(2);
        expect(report.classBreakdown.find((entry) => entry.key === "defend")?.opportunityTurns).toBe(4);
        expect(report.repertoireGapBreakdown.map((entry) => entry.key)).toEqual([
            "spell:Wind Flow",
            "area_throw",
            "spell:Castling",
            "spell:Resurrection",
        ]);
        expect(report.topThreeKillMetric.topThree.map((entry) => entry.key)).toEqual([
            "spell:Wind Flow",
            "area_throw",
            "spell:Castling",
        ]);
        expect(report.topThreeKillMetric.summedOpportunityShare).toBe(2.25);
        expect(report.topThreeKillMetric.eligibleCapabilities).toBe("spell:* and area_throw");
        expect(report.topThreeKillMetric.threshold).toBe(0.015);
        expect(report.topThreeKillMetric.verdict).toBe("not_claimed");
        expect(report.limitations.some((limitation) => limitation.includes("not evidence"))).toBe(true);
        expect(report.limitations.some((limitation) => limitation.includes("M3 rider-EV"))).toBe(true);
        expect(report.limitations.some((limitation) => limitation.includes("still requires wiring"))).toBe(false);
    });
});
