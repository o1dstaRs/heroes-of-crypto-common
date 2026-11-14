import { readFileSync, writeFileSync } from "node:fs";
import { selectEmpowerSetup, type IEmpowerSetupModel } from "../ai/setup/empower_setup";
import type { IEmpowerResearchBoard } from "./empower_setup_research";
import { empowerResearchSha, type EmpowerResearchRow } from "./empower_setup_training";

export function empowerBoardInterval(values: readonly number[], replicates = 20_000, seed = 2026111419) {
    if (!values.length || values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1))
        throw new Error("Invalid Empower board differences");
    if (!Number.isInteger(replicates) || replicates < 100) throw new Error("Too few bootstrap replicates");
    let state = seed >>> 0;
    const draws = Array.from({ length: replicates }, () => {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            sum += values[Math.floor(((state >>> 0) / 0x100000000) * values.length)];
        }
        return sum / values.length;
    }).sort((a, b) => a - b);
    return {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        lower: draws[Math.floor((replicates - 1) * 0.025)],
        upper: draws[Math.floor((replicates - 1) * 0.975)],
        replicates,
        seed,
    };
}

export function analyzeEmpowerSetup(
    rows: readonly EmpowerResearchRow[],
    boards: readonly IEmpowerResearchBoard[],
    model: IEmpowerSetupModel,
    registrationSha256: string,
) {
    if (rows.length !== boards.length * 8 || new Set(boards.map((board) => board.board)).size !== boards.length)
        throw new Error("Incomplete Empower qualification bank");
    const index = new Map<string, EmpowerResearchRow>();
    for (const row of rows) {
        const key = `${row.board}:${row.game}:${row.requestedLevel}`;
        if (
            index.has(key) ||
            ![0, -1].includes(row.requestedLevel) ||
            ![0, 0.5, 1].includes(row.score) ||
            row.registrationSha256 !== registrationSha256 ||
            row.rejected !== 0
        )
            throw new Error("Invalid Empower qualification row");
        index.set(key, row);
    }
    const effects = boards.map((board) => {
        let current = 0,
            learned = 0,
            switched = 0;
        const budget = 5 + (Math.floor(board.board / 3) % 3);
        const map = [1, 3, 4][board.board % 3];
        for (let game = 0; game < 4; game++) {
            const base = index.get(`${board.board}:${game}:0`),
                candidate = index.get(`${board.board}:${game}:-1`);
            if (
                !base ||
                !candidate ||
                base.seed !== board.seed ||
                candidate.seed !== board.seed ||
                base.budget !== budget ||
                candidate.budget !== budget ||
                base.map !== map ||
                candidate.map !== map ||
                base.inputSha256 !== candidate.inputSha256 ||
                base.formationSha256 !== candidate.formationSha256 ||
                base.level !== 0 ||
                candidate.level !== selectEmpowerSetup(model, budget, candidate.own) ||
                empowerResearchSha(base.features) !== empowerResearchSha(candidate.features)
            )
                throw new Error("Unmatched Empower qualification pair");
            if (candidate.level === 0 && (candidate.traceSha256 !== base.traceSha256 || candidate.score !== base.score))
                throw new Error("Unchanged Empower policy failed its exact control");
            current += base.score / 4;
            learned += candidate.score / 4;
            if (candidate.level !== 0) switched++;
        }
        return {
            board: board.board,
            seed: board.seed,
            budget,
            map,
            current,
            learned,
            gain: learned - current,
            switched,
        };
    });
    const interval = empowerBoardInterval(effects.map((row) => row.gain));
    const slices = (key: "budget" | "map", values: number[]) =>
        values.map((value) => {
            const selected = effects.filter((row) => row[key] === value);
            return {
                value,
                boards: selected.length,
                mean: selected.reduce((sum, row) => sum + row.gain, 0) / selected.length,
            };
        });
    const budgets = slices("budget", [5, 6, 7]),
        maps = slices("map", [1, 3, 4]);
    const activatedBoards = effects.filter((row) => row.switched > 0).length;
    const gates = {
        gain: interval.mean >= 0.005,
        interval: interval.lower > 0,
        budgets: budgets.every((row) => row.boards > 0 && row.mean >= -0.01),
        maps: maps.every((row) => row.boards > 0 && row.mean >= -0.01),
        activation: activatedBoards >= 60,
    };
    return {
        passed: Object.values(gates).every(Boolean),
        gates,
        interval,
        budgets,
        maps,
        activatedBoards,
        boards: effects.length,
        rows: rows.length,
        executedFights: rows.filter((row) => !row.reusedControl).length,
        reusedControls: rows.filter((row) => row.reusedControl).length,
        modelSha256: empowerResearchSha(model),
        registrationSha256,
        currentScore: effects.reduce((sum, row) => sum + row.current, 0) / effects.length,
        learnedScore: effects.reduce((sum, row) => sum + row.learned, 0) / effects.length,
        effects,
    };
}

if (import.meta.main) {
    const [rowsPath, registrationPath, fitPath, phase, output] = process.argv.slice(2);
    if (phase !== "qualification" && phase !== "confirmation")
        throw new Error("Expected qualification or confirmation");
    const registration = JSON.parse(readFileSync(registrationPath, "utf8"));
    const fit = JSON.parse(readFileSync(fitPath, "utf8"));
    const rows = readFileSync(rowsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as EmpowerResearchRow);
    const result = analyzeEmpowerSetup(rows, registration.banks[phase], fit.model, registration.registrationSha256);
    writeFileSync(output, JSON.stringify(result) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ ...result, effects: undefined }));
}
