import { describe, expect, it } from "bun:test";

import { selectV08A19ScoredCandidateIndex } from "../../src/ai/versions/v0_8_a19_scored_arbitration";
import type { GameAction } from "../../src/engine/actions";

const native: GameAction[] = [{ type: "range_attack", attackerId: "archer", targetId: "army" }];
const decoy: GameAction[] = [{ type: "range_attack", attackerId: "archer", targetId: "split" }];
const wait: GameAction[] = [{ type: "wait_turn", unitId: "archer" }];
const candidates = [native, decoy, wait].map((actions) => ({ actions }));

describe("A19 scored shortlist arbitration", () => {
    it("uses a materially better legal rollout despite target-pressure selection", () => {
        expect(selectV08A19ScoredCandidateIndex(candidates, [0, 0, 0.25], 1, native)).toBe(2);
        expect(selectV08A19ScoredCandidateIndex(candidates, [0.4, 0.405, 0.42], 0, native)).toBe(2);
    });

    it("keeps the selected action for small differences and positive ties", () => {
        expect(selectV08A19ScoredCandidateIndex(candidates, [0.4, 0.405, 0.4], 0, native)).toBe(0);
        expect(selectV08A19ScoredCandidateIndex(candidates, [0.5, 0.5, 0.5], 1, native)).toBe(1);
    });

    it("preserves native combat when every engine-valid candidate loses", () => {
        expect(selectV08A19ScoredCandidateIndex(candidates, [0, 0, -Infinity], 1, native)).toBe(0);
        const melee: GameAction[] = [
            { type: "melee_attack", attackerId: "ally", targetId: "enemy", attackFrom: { x: 1, y: 1 } },
        ];
        const spell: GameAction[] = [{ type: "cast_spell", casterId: "ally", spellName: "Fireball" }];
        for (const incumbent of [melee, spell]) {
            expect(
                selectV08A19ScoredCandidateIndex([{ actions: incumbent }, { actions: wait }], [0, 0], 1, incumbent),
            ).toBe(0);
        }
    });

    it("leaves passive repair active and never restores an illegal incumbent", () => {
        expect(selectV08A19ScoredCandidateIndex(candidates, [0, 0, 0], 1, wait)).toBe(1);
        expect(selectV08A19ScoredCandidateIndex(candidates, [-Infinity, 0, 0], 1, native)).toBe(1);
    });

    it("excludes nonfinite candidates and fails closed on incomplete score arrays", () => {
        expect(selectV08A19ScoredCandidateIndex(candidates, [0.2, NaN, -Infinity], 0, native)).toBe(0);
        expect(selectV08A19ScoredCandidateIndex(candidates, [0.2, 0.4], 0, native)).toBe(0);
        expect(selectV08A19ScoredCandidateIndex(candidates, [0.2, 0.4, 0.5], -1, native)).toBe(-1);
    });
});
