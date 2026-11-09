import { expect, test } from "bun:test";

import { lockedRangedCounterCheckpoint } from "../../src/simulation/ranged_counter_checkpoint";

test("preserves the exact shooter research candidates, all paired outcomes and failed qualification", () => {
    const checkpoint = lockedRangedCounterCheckpoint();
    expect(checkpoint.productionPromotion).toBe(false);
    expect(checkpoint.boardScores.length).toBe(54);
    expect(new Set(checkpoint.reservedNewChannels).size).toBe(checkpoint.reservedNewChannels.length);
    const total = (arm: string, population?: string): number =>
        checkpoint.boardScores
            .filter((board) => population === undefined || board.population === population)
            .flatMap((board) => board.scores[arm])
            .reduce((a, b) => a + b, 0);
    expect(total("control")).toBe(95.5);
    expect(total("free-spread")).toBe(103);
    expect(total("placement1-sniper")).toBe(96.5);
    expect(total("control", "counter")).toBe(40);
    expect(total("placement1-sniper", "counter")).toBe(45.5);
    expect(total("placement2-armor")).toBe(68);
    expect(checkpoint.boardScores.every((board) => checkpoint.reservedNewChannels.includes(board.seed))).toBe(true);
    for (const board of checkpoint.boardScores)
        for (const scores of Object.values(board.scores)) {
            expect(scores.length).toBe(4);
            expect(scores.every((score) => [0, 0.5, 1].includes(score))).toBe(true);
        }
});
