import { expect, test } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { protectedAxisEmpowerPlan } from "../../src/ai/setup/empower_protected_axis";
import { empowerSetupFeatures, selectEmpowerSetup } from "../../src/ai/setup/empower_setup";
import { trainProtectedAxisEmpowerSetup } from "../../src/simulation/empower_protected_axis_training";
import type { EmpowerResearchRow } from "../../src/simulation/empower_setup_training";

test("binary Empower training preserves both seats and never enables its disabled higher levels", () => {
    const own = ["Wandering Mage", "Orc", "Healer", "Elf", "Nightmare", "Magic Dragon"].map((name) =>
        creatureIdForName(name)!,
    );
    const rows: EmpowerResearchRow[] = Array.from({ length: 432 }, (_, board) =>
        [0, 1, 2, 3].flatMap((game) =>
            [0, 1].map((level) => {
                const budget = 5 + (Math.floor(board / 3) % 3);
                return {
                    board,
                    seed: board + 100,
                    game,
                    requestedLevel: level,
                    level,
                    budget,
                    map: [1, 3, 4][board % 3],
                    own,
                    enemy: own,
                    features: empowerSetupFeatures(budget, own),
                    plan: protectedAxisEmpowerPlan(budget, own, level),
                    baseline: protectedAxisEmpowerPlan(budget, own, 0),
                    inputSha256: `${board}:${game}`,
                    formationSha256: `${board}:${game}`,
                    traceSha256: `${board}:${game}:${level}`,
                    score: level,
                    laps: 1,
                    rejected: 0,
                    elapsedMs: 1,
                    registrationSha256: "synthetic",
                };
            }),
        ),
    ).flat();
    const fit = trainProtectedAxisEmpowerSetup(rows);
    expect(fit.model).not.toBeNull();
    expect(fit.selected.gain).toBe(1);
    for (const budget of [5, 6, 7]) expect(selectEmpowerSetup(fit.model!, budget, own)).toBe(1);
    for (const head of fit.model!.heads.slice(1)) expect([head.b, ...head.w].every((value) => value === 0)).toBe(true);
    expect(() => trainProtectedAxisEmpowerSetup(rows.slice(1))).toThrow();
    expect(() => trainProtectedAxisEmpowerSetup([...rows, rows[0]])).toThrow();
});
