import { expect, test } from "bun:test";
import {
    dragonScreenRisk,
    screenMagicDragonFormation,
    type DragonScreenBody,
} from "../../src/simulation/magic_dragon_screen_research";
import { validRangedCounterFormation } from "../../src/ai/setup/a19_ranged_formation";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
const body = (id: string, name: string, width = 1, height = 1): DragonScreenBody => ({
    id,
    name,
    width,
    height,
    value: 1,
    ranged: false,
    caster: name === "Magic Dragon",
    buffRanges: [],
});
test("screening moves only Dragon, conserves full footprints and cannot worsen registered geometric risk", () => {
    const bodies = [
        body("dragon", "Magic Dragon", 2, 2),
        body("screen", "Frenzied Boar", 2, 2),
        body("buff", "Healer"),
    ];
    const positions = new Map([
        ["dragon", { x: 1, y: 14 }],
        ["screen", { x: 3, y: 8 }],
        ["buff", { x: 2, y: 6 }],
    ]);
    const legal = new Set<number>();
    for (let x = 0; x < 4; x++) for (let y = 0; y < 16; y++) legal.add(x * 16 + y);
    const ctx = { team: PBTypes.TeamVals.LEFT, sideAxis: true, legal, enemyIds: [creatureIdForName("Elf")!] };
    const result = screenMagicDragonFormation(bodies, positions, ctx);
    expect(validRangedCounterFormation(bodies, result, legal)).toBe(true);
    expect(result.get("screen")).toEqual(positions.get("screen"));
    expect(result.get("buff")).toEqual(positions.get("buff"));
    expect(dragonScreenRisk(bodies, result, ctx)).toBeLessThan(dragonScreenRisk(bodies, positions, ctx));
    expect(result.get("dragon")!.x).toBeLessThanOrEqual(positions.get("dragon")!.x);
    expect(positions.get("dragon")).toEqual({ x: 1, y: 14 });
});
test("an aura link cannot be traded away for more cover", () => {
    const dragon = body("dragon", "Magic Dragon"),
        healer = { ...body("buff", "Healer"), buffRanges: [1] },
        screen = body("screen", "Frenzied Boar", 2, 2);
    const bodies = [dragon, healer, screen],
        positions = new Map([
            ["dragon", { x: 0, y: 1 }],
            ["buff", { x: 0, y: 0 }],
            ["screen", { x: 3, y: 10 }],
        ]);
    const legal = new Set<number>();
    for (let x = 0; x < 4; x++) for (let y = 0; y < 16; y++) legal.add(x * 16 + y);
    const result = screenMagicDragonFormation(bodies, positions, {
        team: PBTypes.TeamVals.LEFT,
        sideAxis: true,
        legal,
        enemyIds: [creatureIdForName("Elf")!],
    });
    const d = result.get("dragon")!,
        h = result.get("buff")!;
    expect(Math.max(Math.abs(d.x - h.x), Math.abs(d.y - h.y))).toBeLessThanOrEqual(1);
});
