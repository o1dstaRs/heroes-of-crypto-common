import { expect, test } from "bun:test";
import { prepareMetaPair, type IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";
import { AiMetaAccumulator } from "../../src/simulation/measure_ai_meta_cohorts";
import { aiMetaActualArmy } from "../../src/simulation/ai_meta_actual_setup";

test("native setup selection frequency uses four army-fight observations per independent pair", () => {
    const base = prepareMetaPair(
        {
            cohort: "uniform-mixed",
            games: 6,
            baseSeed: 381701,
            studyProfile: "premium-ranked-v3",
            collectEvidence: true,
        },
        0,
    );
    const record = {
        ...base,
        games: [
            { aIsGreen: true, winner: "a", hpA: 10, hpB: 0, survivorsA: 1, survivorsB: 0 },
            { aIsGreen: false, winner: "b", hpA: 0, hpB: 10, survivorsA: 0, survivorsB: 1 },
        ],
        evidence: {
            ...base.evidence,
            studyProfile: "premium-ranked-current-v1",
            fights: [true, false].map((aIsGreen) => ({
                aIsGreen,
                formations: {
                    a: { augments: [{ kind: "Armor", value: 3 }] },
                    b: { augments: [{ kind: "Armor", value: 3 }] },
                },
            })),
        },
    } as IAiMetaPairRecord;
    const accumulator = new AiMetaAccumulator("uniform-mixed");
    accumulator.add(record);
    const rows = accumulator.rows();
    const actual = aiMetaActualArmy(record, 0, "a");
    const plan = rows.augmentPlans.find((row) => row.key === actual.augment.planId)!;
    expect(plan.selected).toBe(4);
    expect(plan.pickRate).toBe(1);
    expect(plan.pairs).toBe(1);
    expect(plan.games).toBe(4);
    expect(plan.scoreRate).toBe(0.5);
    expect(rows.augmentLevels.every((row) => row.pickRate >= 0 && row.pickRate <= 1)).toBe(true);
});
