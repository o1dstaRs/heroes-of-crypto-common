import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GameAction } from "../../src/engine/actions";
import {
    IL_CANDIDATE_FEATURE_NAMES,
    ilActionSignature,
    parseIlRow,
    validateIlCorpus,
} from "../../src/simulation/il_dataset";

const FINGERPRINT = "a".repeat(64);
const features = new Array(IL_CANDIDATE_FEATURE_NAMES.length).fill(0);
const selectRange: GameAction = {
    type: "select_attack_type",
    unitId: "u",
    attackType: PBTypes.AttackVals.RANGE,
};
const shot: GameAction = { type: "range_attack", attackerId: "u", targetId: "e" };
const wait: GameAction = { type: "wait_turn", unitId: "u" };
const config = {
    gate: 0.01,
    horizon: 12,
    rollouts: 3,
    leaf: "learned",
    shortlist: null,
    includeMoves: 0,
    oppModel: null,
};

const decision = () => ({
    t: "ild",
    v: 2,
    runFingerprint: FINGERPRINT,
    cohort: "melee",
    decision: 0,
    seed: 7,
    green: "v0.7",
    red: "v0.7",
    side: "green",
    lap: 1,
    unit: "Archer",
    k: "wait",
    ov: 1,
    chosen: 1,
    nc: 2,
    act: [selectRange, shot],
    wf: [0, 1],
    vf: [0, 1, 2],
    cands: [
        { kind: "incumbent", ck: "wait", sig: ilActionSignature([wait]), cf: features, m: 0.4 },
        { kind: "shot", ck: "shot", sig: ilActionSignature([selectRange, shot]), cf: features, m: 0.5 },
    ],
    cfg: config,
});

const footer = (overrides: Record<string, unknown> = {}) => ({
    t: "ild_game",
    v: 2,
    runFingerprint: FINGERPRINT,
    cohort: "melee",
    seed: 7,
    green: "v0.7",
    red: "v0.7",
    winner: "green",
    endReason: "elimination",
    rows: 1,
    decisions: 1,
    searched: 1,
    singleCandidate: 0,
    deadlineFallbacks: 0,
    circuitOpened: 0,
    circuitSkipped: 0,
    cfg: config,
    ...overrides,
});

const corpus = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row));
const validate = (lines: string[], expectedGames = 1) =>
    validateIlCorpus(lines, {
        wfWidth: 2,
        vfWidth: 3,
        runFingerprint: FINGERPRINT,
        cohort: "melee",
        expectedGames,
        baseSeed: 7,
    });

describe("IL dataset v2", () => {
    it("preserves attack-type selection as semantic identity", () => {
        expect(ilActionSignature([selectRange, shot])).toBe(`sel:${PBTypes.AttackVals.RANGE}|rg:e@-/-`);
        expect(ilActionSignature([selectRange, shot])).not.toBe(ilActionSignature([shot]));
        expect(ilActionSignature([{ ...selectRange, attackType: PBTypes.AttackVals.MELEE }, shot])).not.toBe(
            ilActionSignature([selectRange, shot]),
        );
    });

    it("strictly validates decision semantics and configuration", () => {
        expect(parseIlRow(decision(), 2, 3, FINGERPRINT).cands[1].sig).toContain("sel:");
        const missingSelector = decision();
        missingSelector.cands[1].sig = ilActionSignature([shot]);
        expect(() => parseIlRow(missingSelector, 2, 3, FINGERPRINT)).toThrow("act signature");
        expect(() => parseIlRow({ ...decision(), cfg: { ...config, includeMoves: 2 } }, 2, 3, FINGERPRINT)).toThrow(
            "expected 0 or 1",
        );
        const illegalChoice = decision();
        illegalChoice.cands[1].m = null;
        expect(() => parseIlRow(illegalChoice, 2, 3, FINGERPRINT)).toThrow("chosen candidate");
        expect(() => parseIlRow(decision(), 2, 3, "b".repeat(64))).toThrow("does not match");
    });

    it("requires complete game chunks and the exact mirrored seed multiset", () => {
        const valid = validate(corpus(decision(), footer()));
        expect(valid.decisions).toHaveLength(1);
        expect(valid.games).toHaveLength(1);

        expect(() => validate(corpus(decision()))).toThrow("missing final game footer");
        expect(() => validate(corpus(decision(), footer({ rows: 0 })))).toThrow("footer row count");
        expect(() => validate(corpus(decision(), footer({ deadlineFallbacks: 1, searched: 2, decisions: 2 })))).toThrow(
            "deadline or circuit",
        );
        expect(() => validate(["{torn"])).toThrow("invalid JSON");
        expect(() => validate(corpus(decision(), footer()), 2)).toThrow("completed games");
        expect(() => validate(corpus(decision(), footer({ seed: 8 })))).toThrow("decision provenance");
    });
});
