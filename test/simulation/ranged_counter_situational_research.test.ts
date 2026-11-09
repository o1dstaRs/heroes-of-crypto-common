import { expect, test } from "bun:test";

import { selectSituationalRangedCounter } from "../../src/simulation/ranged_counter_situational_research";

test("the new hypothesis funds middle Placement for public range-null threats without turning it into a blanket purchase", () => {
    const threeShooters = [47, 31, 15, 6, 50];
    expect(selectSituationalRangedCounter(threeShooters, [37])).toBe("placement1-sniper");
    expect(selectSituationalRangedCounter(threeShooters, [49])).toBe("free-spread");
    expect(selectSituationalRangedCounter(threeShooters, [])).toBe("control");
    expect(selectSituationalRangedCounter([47, 31, 15, 6], [37])).toBe("control");
});
