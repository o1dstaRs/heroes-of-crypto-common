import { readFileSync, writeFileSync } from "node:fs";
import { protectedAxisEmpowerPlan } from "../ai/setup/empower_protected_axis";
import { empowerResearchSha, trainEmpowerSetup, type EmpowerResearchRow } from "./empower_setup_training";

export function trainProtectedAxisEmpowerSetup(rows: readonly EmpowerResearchRow[]) {
    const seen = new Set<string>();
    for (const row of rows) {
        const key = `${row.board}:${row.game}:${row.requestedLevel}`;
        if (
            seen.has(key) ||
            ![0, 1].includes(row.requestedLevel) ||
            row.level !== (row.features ? row.requestedLevel : 0) ||
            row.rejected !== 0 ||
            ![0, 0.5, 1].includes(row.score) ||
            empowerResearchSha(row.plan) !==
                empowerResearchSha(protectedAxisEmpowerPlan(row.budget, row.own, row.level))
        )
            throw new Error("Invalid protected-axis training row");
        seen.add(key);
    }
    const bases = rows.filter((row) => row.requestedLevel === 0);
    if (bases.length * 2 !== rows.length) throw new Error("Missing protected-axis training pair");
    // Disabled heads receive exact zero-effect labels, not newly simulated games or additional observations.
    const expanded = [
        ...rows,
        ...bases.flatMap((row) =>
            [2, 3].map((requestedLevel) => ({ ...row, requestedLevel, reusedControl: true as const })),
        ),
    ];
    const fit = trainEmpowerSetup(expanded, {
        validationBoards: 108,
        splitSalt: 2026111421,
        lambdas: [0.01, 0.1, 1],
        margins: [0.01, 0.03, 0.05, 0.1],
    });
    if (fit.model?.heads.slice(1).some((head) => head.b !== 0 || head.w.some((weight) => weight !== 0)))
        throw new Error("A disabled Empower level acquired a nonzero prediction");
    return fit;
}

if (import.meta.main) {
    const [rowsPath, output] = process.argv.slice(2);
    const rows = readFileSync(rowsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as EmpowerResearchRow);
    const fit = trainProtectedAxisEmpowerSetup(rows);
    writeFileSync(output, JSON.stringify(fit) + "\n", { flag: "wx" });
    console.log(
        JSON.stringify({ examples: fit.examples, selected: fit.selected, modelSha256: empowerResearchSha(fit.model) }),
    );
}
