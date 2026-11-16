import { aiMetaChoiceEvidence, type IAiMetaChoiceEvidence } from "./ai_meta_evidence";
import { makeRng } from "./army";
import { footprintCellsForRecord } from "./footprint";
import type { XY } from "../utils/math";

export interface IMetaFormationInput {
    team: number;
    gridType: number;
    legalCells: XY[];
    units: { unitId: string; creatureName: string; amount: number; width: number; height: number; cell: XY }[];
}

export interface IMetaFormationDecision {
    schema: "premium-formation-choice-v1";
    executionContract: "headless-meta-ranked-sides-not-server-qualified";
    observation: IMetaFormationInput;
    selectedKey: string;
    mode: "exploit" | "explore";
    choice: IAiMetaChoiceEvidence;
    proposals: { key: string; positions: { unitId: string; cell: XY }[] }[];
}

const cellKey = ({ x, y }: XY) => `${x},${y}`;
const exactKeys = (value: object, keys: string[]) =>
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));

export function metaFormationProposals(input: IMetaFormationInput): IMetaFormationDecision["proposals"] {
    if (
        !exactKeys(input, ["team", "gridType", "legalCells", "units"]) ||
        input.units.some(
            (unit) =>
                !exactKeys(unit, ["unitId", "creatureName", "amount", "width", "height", "cell"]) ||
                !exactKeys(unit.cell, ["x", "y"]),
        ) ||
        input.legalCells.some((cell) => !exactKeys(cell, ["x", "y"]))
    )
        throw new Error("Formation observation contains unrecognized or private inputs");
    if (
        !input.legalCells.length ||
        !input.units.length ||
        new Set(input.units.map((u) => u.unitId)).size !== input.units.length
    )
        throw new Error("Formation learning requires a nonempty unique army and deployment zone");
    if (input.legalCells.some((cell) => !Number.isInteger(cell.x) || !Number.isInteger(cell.y)))
        throw new Error("Invalid formation zone");
    const legal = new Set(input.legalCells.map(cellKey));
    const xs = input.legalCells.map((cell) => cell.x);
    const ys = input.legalCells.map((cell) => cell.y);
    const xSum = Math.min(...xs) + Math.max(...xs);
    const ySum = Math.min(...ys) + Math.max(...ys);
    const proposals: IMetaFormationDecision["proposals"] = [];
    const seen = new Set<string>();
    for (const [key, flipX, flipY] of [
        ["incumbent", false, false],
        ["depth-reflection", true, false],
        ["flank-reflection", false, true],
        ["both-reflections", true, true],
    ] as const) {
        const occupied = new Set<string>();
        let valid = true;
        const positions = input.units.map((unit) => {
            if (![unit.width, unit.height, unit.amount].every((n) => Number.isSafeInteger(n) && n > 0))
                throw new Error("Invalid formation shape or quantity");
            const cell = {
                x: flipX ? xSum - unit.cell.x + unit.width - 1 : unit.cell.x,
                y: flipY ? ySum - unit.cell.y + unit.height - 1 : unit.cell.y,
            };
            for (const covered of footprintCellsForRecord(cell, 1, unit.width, unit.height)) {
                const hash = cellKey(covered);
                if (!legal.has(hash) || occupied.has(hash)) valid = false;
                occupied.add(hash);
            }
            return { unitId: unit.unitId, cell };
        });
        if (!valid) {
            if (key === "incumbent") throw new Error("Formation learning incumbent is illegal");
            continue;
        }
        const identity = JSON.stringify([...positions].sort((a, b) => a.unitId.localeCompare(b.unitId)));
        if (seen.has(identity)) continue;
        seen.add(identity);
        proposals.push({ key, positions });
    }
    return proposals;
}

export function sampleMetaFormation(input: IMetaFormationInput, seed: number): IMetaFormationDecision {
    const proposals = metaFormationProposals(input);
    const rng = makeRng(seed);
    const mode = rng() < 0.2 ? "explore" : "exploit";
    const selected = mode === "explore" ? proposals[Math.floor(rng() * proposals.length)] : proposals[0];
    return {
        schema: "premium-formation-choice-v1",
        executionContract: "headless-meta-ranked-sides-not-server-qualified",
        observation: structuredClone(input),
        selectedKey: selected.key,
        mode,
        choice: aiMetaChoiceEvidence(
            proposals.map(({ key }) => ({ key, score: Number(key === "incumbent") })),
            "incumbent",
            selected.key,
            mode,
            0.2,
        ),
        proposals,
    };
}

export function validateMetaFormationDecision(decision: IMetaFormationDecision): void {
    if (
        decision.schema !== "premium-formation-choice-v1" ||
        decision.executionContract !== "headless-meta-ranked-sides-not-server-qualified"
    )
        throw new Error("Unknown formation collection contract");
    const proposals = metaFormationProposals(decision.observation);
    const expected = aiMetaChoiceEvidence(
        proposals.map(({ key }) => ({ key, score: Number(key === "incumbent") })),
        "incumbent",
        decision.selectedKey,
        decision.mode,
        0.2,
    );
    if (
        JSON.stringify(proposals) !== JSON.stringify(decision.proposals) ||
        JSON.stringify(expected) !== JSON.stringify(decision.choice)
    )
        throw new Error("Formation proposals or sampling probabilities changed");
}
