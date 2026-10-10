import { describe, expect, it } from "bun:test";

import { remainingRolloutsCannotWin } from "../../src/simulation/search_driver";

describe("remainingRolloutsCannotWin", () => {
    it("does not stop before a finished exact mean exists", () => {
        expect(remainingRolloutsCannotWin(0, 1, 4, Number.NEGATIVE_INFINITY, 0.01)).toBe(false);
        expect(remainingRolloutsCannotWin(0, 0, 4, 1, 0.01)).toBe(false);
        expect(remainingRolloutsCannotWin(0, 4, 4, 1, 0.01)).toBe(false);
    });

    it("stops only when the best possible remaining leaves stay outside the margin", () => {
        // One zero leaves a max mean of 0.75: a proven 1.0 is unreachable, a 0.60 is not.
        expect(remainingRolloutsCannotWin(0, 1, 4, 1, 0.01)).toBe(true);
        expect(remainingRolloutsCannotWin(0, 1, 4, 0.6, 0.01)).toBe(false);
        // Three zeros leave a max mean of 0.25, short of a 0.50 leader.
        expect(remainingRolloutsCannotWin(0, 3, 4, 0.5, 0.01)).toBe(true);
        // The boundary is strict. An equal max can still clear a gate or a tie.
        expect(remainingRolloutsCannotWin(0.2, 3, 4, 0.3, 0.01)).toBe(false);
    });

    it("keeps an all-zero board fully scored", () => {
        expect(remainingRolloutsCannotWin(0, 1, 4, 0, 0.01)).toBe(false);
        expect(remainingRolloutsCannotWin(0, 3, 4, 0, 0.01)).toBe(false);
    });

    it("still bounds a negative leaf when later leaves cannot exceed 1", () => {
        // Three rolls summing to -0.5, one left: max mean is 0.125, more than 0.01 under 0.20.
        expect(remainingRolloutsCannotWin(-0.5, 3, 4, 0.2, 0.01)).toBe(true);
    });

    it("refuses a non-finite sum or a negative margin", () => {
        expect(remainingRolloutsCannotWin(Number.NaN, 3, 4, 1, 0.01)).toBe(false);
        expect(remainingRolloutsCannotWin(0, 3, 4, 1, -0.01)).toBe(false);
    });
});
