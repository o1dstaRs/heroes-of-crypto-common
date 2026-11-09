import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, spyOn, test } from "bun:test";
import evidence from "../../docs/evidence/wandering_mage_20261108.json";
import { planTacticalStackSplits, type ITacticalSplitUnit } from "../../src/ai/tactical_split_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SearchDriver } from "../../src/simulation/search_driver";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import {
    createLockedWanderingMageResearchStrategy,
    lockedWanderingMageCheckpoint,
    LOCKED_WANDERING_MAGE_STRATEGIES,
} from "../../src/simulation/wandering_mage_checkpoint";

test("saved Mage checkpoint pins the measured source and every study, including failed alternatives", () => {
    const checkpoint = lockedWanderingMageCheckpoint();
    expect(fingerprintV09(evidence)).toBe(checkpoint.evidenceFingerprint);
    expect(
        createHash("sha256")
            .update(readFileSync(resolve(import.meta.dir, "../..", checkpoint.policySource)))
            .digest("hex"),
    ).toBe(checkpoint.policySha256);
    expect(checkpoint.strategies.map((s) => s.id)).toEqual([...LOCKED_WANDERING_MAGE_STRATEGIES]);
    expect(checkpoint.productionActivation).toBe(false);
    expect(checkpoint.originalProgressionGatesPassed).toBe(false);
    checkpoint.productionActivation = true;
    expect(lockedWanderingMageCheckpoint().productionActivation).toBe(false);
    expect(evidence.allReservedChannels).toHaveLength(804);
    expect(new Set(evidence.allReservedChannels).size).toBe(804);
    expect(evidence.studies.map((s) => s.boardScores.length)).toEqual([108, 54, 54, 54]);
    for (const study of evidence.studies) {
        expect(study.originalGatePassed).toBe(false);
        expect(study.confirmationOutcomes).toBe(0);
        const boards = study.boardScores as Array<{ scoresGreenThenRed: Record<string, number[]> }>;
        for (const [arm, summary] of Object.entries(study.summary.arms)) {
            const scores = boards.flatMap((b) => b.scoresGreenThenRed[arm]);
            expect(scores).toHaveLength(summary.games);
            expect(scores.filter((s) => s === 1)).toHaveLength(summary.wins);
            expect(scores.filter((s) => s === 0.5)).toHaveLength(summary.draws);
            expect(scores.filter((s) => s === 0)).toHaveLength(summary.losses);
            expect((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100).toBeCloseTo(summary.mean, 10);
        }
        for (const [contrast, summary] of Object.entries(study.summary.contrasts)) {
            const [candidate, control] = contrast.split("-minus-");
            const delta = boards.reduce(
                (sum, b) =>
                    sum +
                    b.scoresGreenThenRed[candidate].reduce((a, s) => a + s, 0) -
                    b.scoresGreenThenRed[control].reduce((a, s) => a + s, 0),
                0,
            );
            expect((delta / (2 * boards.length)) * 100).toBeCloseTo(summary.mean, 10);
        }
    }
});

test("named candidates preserve different split/placement rules without merging them", () => {
    const split = createLockedWanderingMageResearchStrategy(LOCKED_WANDERING_MAGE_STRATEGIES[0]);
    const lateral = createLockedWanderingMageResearchStrategy(LOCKED_WANDERING_MAGE_STRATEGIES[1]);
    const caster: ITacticalSplitUnit = {
        id: "mage",
        identity: "Wandering Mage:1",
        amount: 138,
        level: 1,
        small: true,
        summoned: false,
        attackType: 1,
        steps: 5,
        hpPerCreature: 12,
        auraUtilityCount: 0,
        supportSpellCount: 2,
        waterShieldUtilityCount: 0,
        rangedCoverCount: 0,
    };
    const units = [caster];
    expect(lateral.planSplits(units, 8)).toEqual(planTacticalStackSplits(units, 8));
    expect(split.planSplits(units, 6)).toEqual([]);
    const incumbent = new Map([["mage", { x: 0, y: 0 }]]);
    const placements = [{ id: "mage", name: "Wandering Mage", small: true, amount: 138 }];
    const context = {
        team: PBTypes.TeamVals.LEFT,
        sideOrientedPlacement: true,
        legalCellHashes: new Set(Array.from({ length: 16 }, (_, y) => y)),
    };
    expect(split.place(incumbent, placements, context).get("mage")).toEqual({ x: 0, y: 7 });
    expect(lateral.place(incumbent, placements, context).get("mage")).toEqual({ x: 0, y: 0 });
    expect(incumbent.get("mage")).toEqual({ x: 0, y: 0 });
    expect(() => createLockedWanderingMageResearchStrategy("unknown" as never)).toThrow("Unknown");
});

test("research search widens only own Mage roots and restores scope before outer neural correction", () => {
    const candidate = createLockedWanderingMageResearchStrategy(LOCKED_WANDERING_MAGE_STRATEGIES[0]);
    const driver = { shortlist: 6, researchShortlist: null };
    const unit = (team: number, name = "Wandering Mage") => ({ getTeam: () => team, getName: () => name });
    const observed: number[] = [];
    const spy = spyOn(SearchDriver.prototype, "chooseDecision").mockImplementation(function () {
        observed.push((this as unknown as typeof driver).shortlist);
        return [];
    });
    try {
        const original = SearchDriver.prototype.chooseDecision;
        candidate.withSearch(PBTypes.TeamVals.LEFT, () => {
            for (const actor of [
                unit(PBTypes.TeamVals.LEFT),
                unit(PBTypes.TeamVals.RIGHT),
                unit(PBTypes.TeamVals.LEFT, "Healer"),
            ]) {
                SearchDriver.prototype.chooseDecision.call(driver as never, actor as never, "v0.8", []);
                expect(driver.shortlist).toBe(6);
            }
        });
        expect(observed).toEqual([8, 6, 6]);
        expect(SearchDriver.prototype.chooseDecision).toBe(original);
        expect(() => candidate.withSearch(1, () => candidate.withSearch(1, () => 0))).toThrow("nested");
        expect(() => candidate.withSearch(1, () => Promise.resolve(0))).toThrow("synchronous");
        expect(SearchDriver.prototype.chooseDecision).toBe(original);
        driver.shortlist = 4;
        expect(() =>
            candidate.withSearch(1, () =>
                SearchDriver.prototype.chooseDecision.call(driver as never, unit(1) as never, "v0.8", []),
            ),
        ).toThrow("shortlist 6");
        expect(driver.shortlist).toBe(4);
        expect(SearchDriver.prototype.chooseDecision).toBe(original);
        driver.shortlist = 6;
        spy.mockImplementation(() => {
            throw new Error("engine failed");
        });
        expect(() =>
            candidate.withSearch(1, () =>
                SearchDriver.prototype.chooseDecision.call(driver as never, unit(1) as never, "v0.8", []),
            ),
        ).toThrow("engine failed");
        expect(driver.shortlist).toBe(6);
        expect(SearchDriver.prototype.chooseDecision).toBe(original);
    } finally {
        spy.mockRestore();
    }
});
