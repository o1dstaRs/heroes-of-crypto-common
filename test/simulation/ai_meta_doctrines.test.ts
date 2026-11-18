import { expect, test } from "bun:test";
import { AiMetaDoctrineCollector } from "../../src/simulation/ai_meta_doctrines";
import type { IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";

test("doctrine W/D/L retains physical outcomes while clustering both armies and seats by family", () => {
    const c = new AiMetaDoctrineCollector();
    const pair = (a: number, b: number, winners: string[]) =>
        ({
            cohort: "ranked-draft",
            map: 1,
            armyA: { doctrine: a },
            armyB: { doctrine: b },
            games: winners.map((winner) => ({ winner })),
        }) as IAiMetaPairRecord;
    c.add(pair(1, 2, ["a", "draw"]));
    c.add(pair(1, 1, ["a", "a"]));
    const rows = c.result().rows.filter((r) => r.cohort === "all" && r.map === "all");
    const scout = rows.find((r) => r.ownDoctrine === 1 && r.opponentDoctrine === "all")!;
    expect(scout).toMatchObject({ families: 2, assignments: 3, armyOutcomes: 6, wins: 3, draws: 1, losses: 2 });
    expect(scout.scoreRate).toBe(3.5 / 6);
    expect(rows.find((r) => r.ownDoctrine === 2 && r.opponentDoctrine === 1)).toMatchObject({
        families: 1,
        assignments: 1,
        wins: 0,
        draws: 1,
        losses: 1,
        scoreRate: 0.25,
    });
    expect(rows.filter((r) => r.opponentDoctrine !== "all")).toHaveLength(9);
    expect(rows.find((r) => r.ownDoctrine === 3)).toMatchObject({ families: 0, scoreRate: null, ciLow: 0, ciHigh: 1 });
    const pooled = rows.filter((r) => r.opponentDoctrine === "all");
    expect(
        pooled.reduce((n, r) => n + r.wins + 0.5 * r.draws, 0) / pooled.reduce((n, r) => n + r.armyOutcomes, 0),
    ).toBe(0.5);
});
