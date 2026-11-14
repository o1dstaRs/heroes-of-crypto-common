import { describe, expect, it } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    EMPOWER_SETUP_FEATURES,
    EMPOWER_SETUP_SCHEMA,
    empowerSetupFeatures,
    empowerSetupPlan,
    selectEmpowerSetup,
    type IEmpowerSetupModel,
} from "../../src/ai/setup/empower_setup";
import { analyzeEmpowerSetup, empowerBoardInterval } from "../../src/simulation/empower_setup_analysis";
import {
    empowerTrainingExamples,
    trainEmpowerSetup,
    type EmpowerResearchRow,
} from "../../src/simulation/empower_setup_training";

const own = ["Squire", "Wandering Mage", "Healer", "Battle Mage", "Nightmare", "Magic Dragon"].map((name) =>
    creatureIdForName(name)!,
);
const model: IEmpowerSetupModel = {
    schema: EMPOWER_SETUP_SCHEMA,
    features: EMPOWER_SETUP_FEATURES,
    margin: 0.03,
    heads: [1, 0, 0].map((b) => ({ b, w: EMPOWER_SETUP_FEATURES.map(() => 0) })),
};
function row(board: number, game: number, requestedLevel: number): EmpowerResearchRow {
    const budget = 5 + (Math.floor(board / 3) % 3),
        level = requestedLevel === -1 ? 1 : requestedLevel;
    return {
        board,
        seed: board + 100,
        game,
        requestedLevel,
        level,
        budget,
        map: [1, 3, 4][board % 3],
        own,
        enemy: own,
        features: empowerSetupFeatures(budget, own),
        plan: empowerSetupPlan(budget, own, level),
        baseline: empowerSetupPlan(budget, own, 0),
        inputSha256: `${board}:${game}`,
        formationSha256: `${board}:${game}`,
        traceSha256: `${board}:${game}:${level}`,
        score: level === 1 ? 1 : 0,
        laps: 1,
        rejected: 0,
        elapsedMs: 1,
        registrationSha256: "synthetic",
    };
}

describe("Empower research integrity", () => {
    it("requires all four interventions and both physical seats with unchanged controlled inputs", () => {
        const rows = [0, 1].flatMap((game) => [0, 1, 2, 3].map((level) => row(0, game, level)));
        expect(empowerTrainingExamples(rows)).toHaveLength(1);
        expect(empowerTrainingExamples(rows)[0].gains).toEqual([1, 0, 0]);
        expect(() => empowerTrainingExamples(rows.slice(1))).toThrow("Unmatched");
        expect(() => empowerTrainingExamples(rows.slice(0, 4))).toThrow("physical mirror");
        const changed = structuredClone(rows);
        changed[3].formationSha256 = "different";
        expect(() => empowerTrainingExamples(changed)).toThrow("Unmatched");
    });
    it("learns paired gains with a whole-board internal split and retains the frozen feature schema", () => {
        const rows = Array.from({ length: 12 }, (_, board) =>
            [0, 1, 2, 3].flatMap((game) => [0, 1, 2, 3].map((level) => row(board, game, level))),
        ).flat();
        const fit = trainEmpowerSetup(rows, { validationBoards: 3, splitSalt: 123, lambdas: [0.1], margins: [0.03] });
        expect(fit.examples).toBe(24);
        expect(fit.selected.gain).toBe(1);
        expect(fit.model?.features).toEqual(EMPOWER_SETUP_FEATURES);
        for (const budget of [5, 6, 7]) expect(selectEmpowerSetup(fit.model!, budget, own)).toBe(1);
    });
    it("uses boards as the inference unit and enforces the registered activation and safety gates", () => {
        const boards = Array.from({ length: 81 }, (_, board) => ({ board, seed: board + 100 }));
        const rows = boards.flatMap(({ board }) =>
            [0, 1, 2, 3].flatMap((game) => [0, -1].map((level) => row(board, game, level))),
        );
        const result = analyzeEmpowerSetup(rows, boards, model, "synthetic");
        expect(result.passed).toBe(true);
        expect(result.boards).toBe(81);
        expect(result.interval).toMatchObject({ mean: 1, lower: 1, upper: 1 });
        expect(result.budgets.map((slice) => slice.boards)).toEqual([27, 27, 27]);
        expect(() => analyzeEmpowerSetup(rows.slice(1), boards, model, "synthetic")).toThrow("Incomplete");
        const changed = structuredClone(rows);
        changed[1].inputSha256 = "different";
        expect(() => analyzeEmpowerSetup(changed, boards, model, "synthetic")).toThrow("Unmatched");
        expect(
            analyzeEmpowerSetup(rows.slice(0, 54 * 8), boards.slice(0, 54), model, "synthetic").gates.activation,
        ).toBe(false);
    });
    it("does not claim a positive interval from mixed or null board effects", () => {
        const nullResult = empowerBoardInterval([0, 0, 0, 0], 1000);
        expect(nullResult.lower).toBe(0);
        const mixed = empowerBoardInterval([-1, 1, -1, 1], 1000);
        expect(mixed.lower).toBeLessThan(0);
        expect(mixed.upper).toBeGreaterThan(0);
        expect(() => empowerBoardInterval([NaN])).toThrow();
    });
});
