import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { ICandidateFeatures, IEnumeratedCandidate, IShotCandidateFeatures } from "../../src/ai/candidates";
import { WAIT_FEATURE_NAMES } from "../../src/ai/versions/wait_scorer";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { GRID_SIZE } from "../../src/grid/grid_constants";
import { RangeAttackCellSide } from "../../src/grid/grid_math";
import { IL_ACTION_FEATURE_NAMES, ilCandidateActionEncoding } from "../../src/simulation/il_action_features";
import {
    IL_CANDIDATE_FEATURE_NAMES,
    IL_DATASET_VERSION,
    IL_FEATURE_FINGERPRINTS,
    IL_MODEL_INPUT_CONTRACT,
    ilActionSignature,
    ilCandidateFeatureVector,
    parseIlRow,
    validateIlCorpus,
} from "../../src/simulation/il_dataset";
import { VALUE_FEATURE_NAMES_V2 } from "../../src/simulation/value_features";

const FINGERPRINT = "a".repeat(64);
const VERSIONS = ["v0.7s", "v0.7"] as const;
const SECOND_SEED = (7 + 0x9e3779b1) >>> 0;
const candidateFeatures: ICandidateFeatures = {
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 1,
    hourglassSpent: 0,
    spendsRangeShot: 0,
    spendsSpellCharge: 0,
    burnsResurrectionCharge: 0,
    expectedDamage: 0,
    expectedKill: 0,
};
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
    activeChallengers: 0,
    oppModel: null,
    decisionDeadlineMs: null,
    circuitBreakerMs: null,
    caps: {
        maxMoveDestinations: 1,
        maxMeleePairs: 8,
        maxShotAims: 6,
        maxAreaThrowCells: 4,
    },
} as const;

const candidate = (
    kind: IEnumeratedCandidate["kind"],
    actions: GameAction[],
    mean: number | null,
    shotFeatures?: IShotCandidateFeatures,
    perspective = PBTypes.TeamVals.LOWER,
) => {
    const enumerated: IEnumeratedCandidate = { kind, actions, features: candidateFeatures, shotFeatures };
    const encoding = ilCandidateActionEncoding(enumerated, perspective);
    return {
        kind,
        ck: encoding.metadata.family,
        sig: ilActionSignature(actions),
        act: actions,
        cf: ilCandidateFeatureVector(candidateFeatures),
        am: encoding.metadata,
        af: encoding.features,
        m: mean,
    };
};

const decision = (overrides: Record<string, unknown> = {}) => {
    const perspective = overrides.side === "red" ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    return {
        t: "ild",
        v: 3,
        runFingerprint: FINGERPRINT,
        featureFingerprints: IL_FEATURE_FINGERPRINTS,
        cohort: "melee",
        decision: 0,
        seed: 7,
        green: "v0.7s",
        red: "v0.7",
        side: "green",
        lap: 1,
        unit: "Archer",
        k: "wait",
        ov: 1,
        chosen: 1,
        nc: 2,
        act: [selectRange, shot],
        wf: new Array(WAIT_FEATURE_NAMES.length).fill(0),
        vf: new Array(VALUE_FEATURE_NAMES_V2.length).fill(0),
        cands: [
            candidate("incumbent", [wait], 0.4, undefined, perspective),
            candidate("shot", [selectRange, shot], 0.5, undefined, perspective),
        ],
        cfg: config,
        ...overrides,
    };
};

const footer = (overrides: Record<string, unknown> = {}) => ({
    t: "ild_game",
    v: 3,
    runFingerprint: FINGERPRINT,
    featureFingerprints: IL_FEATURE_FINGERPRINTS,
    cohort: "melee",
    seed: 7,
    green: "v0.7s",
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
const validate = (lines: string[], expectedGames = 2) =>
    validateIlCorpus(lines, {
        runFingerprint: FINGERPRINT,
        cohort: "melee",
        expectedGames,
        baseSeed: 7,
        versions: VERSIONS,
    });
const reversedDecision = () => decision({ green: "v0.7", red: "v0.7s" });
const reversedFooter = () => footer({ green: "v0.7", red: "v0.7s" });
const completePair = (): string[] => corpus(decision(), footer(), reversedDecision(), reversedFooter());

describe("IL dataset v3", () => {
    it("pins the named feature orders and their content fingerprint", () => {
        expect(IL_DATASET_VERSION).toBe(3);
        expect([...IL_CANDIDATE_FEATURE_NAMES]).toEqual([
            "moraleDelta",
            "luckDelta",
            "enemiesNotYetActedFrac",
            "alliesNotYetActedFrac",
            "lap",
            "hourglassSpent",
            "spendsRangeShot",
            "spendsSpellCharge",
            "burnsResurrectionCharge",
            "expectedDamage",
            "expectedKill",
        ]);
        expect(ilCandidateFeatureVector(candidateFeatures)).toHaveLength(11);
        expect(IL_ACTION_FEATURE_NAMES.length).toBeGreaterThan(40);
        expect(WAIT_FEATURE_NAMES).toHaveLength(41);
        expect(VALUE_FEATURE_NAMES_V2).toHaveLength(60);
        expect(IL_FEATURE_FINGERPRINTS).toEqual({
            wf: "9d39ecc739c96c9569d3f606e0aa8dec7043657b3226ad3747bc800cc88d76b5",
            vf: "01af95ce0fa9b93be9ef76579b56f458161c1eb368ac73f2d8a7a9f8373310c8",
            cf: "e332dbea45c3ebfe117de2276f530517c203b09bddaa71099e32c75f10a2111f",
            af: "fc05c543bbb06d280f523ee2971fb19e89558403ecfe86b35ad3e6c41cd1b885",
            schema: "95d337946c224c95537fc5a524578fc053e8525c2bc4f97b16736cdb0b0fe176",
        });
    });

    it("preserves attack-type selection as semantic identity without putting ids in the action vector", () => {
        expect(ilActionSignature([selectRange, shot])).toBe(`sel:${PBTypes.AttackVals.RANGE}|rg:e@-/-`);
        expect(ilActionSignature([selectRange, shot])).not.toBe(ilActionSignature([shot]));
        expect(ilActionSignature([{ ...selectRange, attackType: PBTypes.AttackVals.MELEE }, shot])).not.toBe(
            ilActionSignature([selectRange, shot]),
        );

        const renamed = candidate(
            "shot",
            [
                { ...selectRange, unitId: "some-other-actor" },
                { ...shot, attackerId: "some-other-actor", targetId: "some-other-target" },
            ],
            0.5,
        );
        expect(renamed.af).toEqual(decision().cands[1].af);
        expect(renamed.sig).not.toBe(decision().cands[1].sig);
    });

    it("makes spatial action features relative to the acting team", () => {
        const lowerShot: IEnumeratedCandidate = {
            kind: "shot",
            actions: [
                selectRange,
                {
                    ...shot,
                    aimCell: { x: 3, y: 2 },
                    aimSide: RangeAttackCellSide.DOWN,
                },
            ],
            features: candidateFeatures,
        };
        const upperShot: IEnumeratedCandidate = {
            kind: "shot",
            actions: [
                { ...selectRange, unitId: "upper" },
                {
                    ...shot,
                    attackerId: "upper",
                    targetId: "upper-target",
                    aimCell: { x: 3, y: GRID_SIZE - 1 - 2 },
                    aimSide: RangeAttackCellSide.UP,
                },
            ],
            features: candidateFeatures,
        };
        const lowerMoveMelee: IEnumeratedCandidate = {
            kind: "melee",
            actions: [
                {
                    type: "move_unit",
                    unitId: "lower",
                    path: [
                        { x: 4, y: 1 },
                        { x: 4, y: 2 },
                    ],
                },
                { type: "melee_attack", attackerId: "lower", targetId: "target", attackFrom: { x: 4, y: 2 } },
            ],
            features: candidateFeatures,
        };
        const upperMoveMelee: IEnumeratedCandidate = {
            kind: "melee",
            actions: [
                {
                    type: "move_unit",
                    unitId: "upper",
                    path: [
                        { x: 4, y: GRID_SIZE - 2 },
                        { x: 4, y: GRID_SIZE - 1 - 2 },
                    ],
                },
                {
                    type: "melee_attack",
                    attackerId: "upper",
                    targetId: "upper-target",
                    attackFrom: { x: 4, y: GRID_SIZE - 1 - 2 },
                },
            ],
            features: candidateFeatures,
        };

        const lowerShotEncoding = ilCandidateActionEncoding(lowerShot, PBTypes.TeamVals.LOWER);
        const upperShotEncoding = ilCandidateActionEncoding(upperShot, PBTypes.TeamVals.UPPER);
        expect(lowerShotEncoding.metadata).not.toEqual(upperShotEncoding.metadata);
        expect(lowerShotEncoding.features).toEqual(upperShotEncoding.features);
        expect(ilCandidateActionEncoding(lowerMoveMelee, PBTypes.TeamVals.LOWER).features).toEqual(
            ilCandidateActionEncoding(upperMoveMelee, PBTypes.TeamVals.UPPER).features,
        );
    });

    it("strictly rejects legacy, malformed, and poisoned rows", () => {
        expect(parseIlRow(decision(), FINGERPRINT).cands[1].sig).toContain("sel:");
        expect(() => parseIlRow({ ...decision(), v: 2 }, FINGERPRINT)).toThrow("legacy schemas");

        const badFingerprint = decision();
        badFingerprint.featureFingerprints = { ...IL_FEATURE_FINGERPRINTS, af: "b".repeat(64) };
        expect(() => parseIlRow(badFingerprint, FINGERPRINT)).toThrow("feature fingerprint");

        const poisonedVector = decision();
        poisonedVector.cands[1].af[0] = 99;
        expect(() => parseIlRow(poisonedVector, FINGERPRINT)).toThrow("action feature vector");

        const poisonedMetadata = decision();
        poisonedMetadata.cands[1].am.hasUnitTarget = 0;
        expect(() => parseIlRow(poisonedMetadata, FINGERPRINT)).toThrow("action metadata");

        const shortVf = decision();
        shortVf.vf.pop();
        expect(() => parseIlRow(shortVf, FINGERPRINT)).toThrow("feature width 59 != 60");

        const unknownField = { ...decision(), poison: 1 };
        expect(() => parseIlRow(unknownField, FINGERPRINT)).toThrow("keys");

        const unknownActionField = structuredClone(decision());
        (unknownActionField.act[1] as GameAction & { poison?: number }).poison = 1;
        expect(() => parseIlRow(unknownActionField, FINGERPRINT)).toThrow("unknown keys poison");

        const missingActor = structuredClone(decision());
        delete (missingActor.cands[1].act[1] as Partial<Extract<GameAction, { type: "range_attack" }>>).attackerId;
        expect(() => parseIlRow(missingActor, FINGERPRINT)).toThrow("expected a non-empty string");

        const illegalChoice = decision();
        illegalChoice.cands[1].m = null;
        expect(() => parseIlRow(illegalChoice, FINGERPRINT)).toThrow("chosen candidate");

        const unknownCap = decision();
        unknownCap.cfg = { ...config, caps: { ...config.caps, poison: 1 } } as typeof config;
        expect(() => parseIlRow(unknownCap, FINGERPRINT)).toThrow("keys");
        expect(() => parseIlRow(decision(), "b".repeat(64))).toThrow("does not match");
    });

    it("requires complete game chunks and exact reversed version orientations", () => {
        const valid = validate(completePair());
        expect(valid.decisions).toHaveLength(2);
        expect(valid.games).toHaveLength(2);

        expect(() => validate(corpus(decision()))).toThrow("missing final game footer");
        expect(() => validate(corpus(decision(), footer({ rows: 0 })))).toThrow("footer row count");
        expect(() => validate(corpus(decision(), footer({ deadlineFallbacks: 1, searched: 2, decisions: 2 })))).toThrow(
            "deadline or circuit",
        );
        expect(() => validate(["{torn"])).toThrow("invalid JSON");
        expect(() => validate(corpus(decision(), footer()))).toThrow("completed games");
        expect(() => validate(corpus(decision(), footer({ seed: 8 })))).toThrow("decision provenance");

        const sameVersion = decision({ green: "v0.7", red: "v0.7" });
        expect(() =>
            validate(
                corpus(
                    sameVersion,
                    footer({ green: "v0.7", red: "v0.7" }),
                    decision({ green: "v0.7", red: "v0.7" }),
                    footer({ green: "v0.7", red: "v0.7" }),
                ),
            ),
        ).toThrow("orientation is untestable");

        expect(() => validate(corpus(decision(), footer(), decision(), footer()))).toThrow(
            "exact reversed version orientation",
        );

        expect(() =>
            validate(
                corpus(
                    decision({ green: "v0.6s", red: "v0.6" }),
                    footer({ green: "v0.6s", red: "v0.6" }),
                    decision({ green: "v0.6", red: "v0.6s" }),
                    footer({ green: "v0.6", red: "v0.6s" }),
                ),
            ),
        ).toThrow("do not match planned pair");

        expect(() =>
            validate(
                corpus(
                    decision(),
                    footer(),
                    reversedDecision(),
                    reversedFooter(),
                    decision({ seed: SECOND_SEED, green: "v0.6s", red: "v0.6" }),
                    footer({ seed: SECOND_SEED, green: "v0.6s", red: "v0.6" }),
                    decision({ seed: SECOND_SEED, green: "v0.6", red: "v0.6s" }),
                    footer({ seed: SECOND_SEED, green: "v0.6", red: "v0.6s" }),
                ),
                4,
            ),
        ).toThrow("do not match planned pair");

        const deadlineConfig = { ...config, decisionDeadlineMs: 10 };
        expect(() =>
            validate(
                corpus(
                    decision({ cfg: deadlineConfig }),
                    footer({ cfg: deadlineConfig }),
                    reversedDecision(),
                    reversedFooter(),
                ),
            ),
        ).toThrow("configured deadline or circuit breaker");
    });

    it("extracts v3 state and action features without invoking a fitter", () => {
        const dir = mkdtempSync(join(tmpdir(), "il-v3-extract-"));
        const dump = join(dir, "melee.ild.jsonl");
        const out = join(dir, "rows.jsonl");
        writeFileSync(dump, `${completePair().join("\n")}\n`);
        const missingVersions = Bun.spawnSync({
            cmd: [
                process.execPath,
                "src/simulation/optimizer/extract_il.mjs",
                `out=${join(dir, "missing-versions.jsonl")}`,
                `fingerprint=${FINGERPRINT}`,
                `melee=${dump}`,
                "games.melee=2",
                "base.melee=7",
            ],
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(missingVersions.exitCode).toBe(1);
        expect(new TextDecoder().decode(missingVersions.stderr)).toContain("versions=<teacher>,<student>");

        const result = Bun.spawnSync({
            cmd: [
                process.execPath,
                "src/simulation/optimizer/extract_il.mjs",
                `out=${out}`,
                `fingerprint=${FINGERPRINT}`,
                `versions=${VERSIONS.join(",")}`,
                `melee=${dump}`,
                "games.melee=2",
                "base.melee=7",
            ],
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        const rows = readFileSync(out, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({ t: "ilx", v: 3, featureFingerprints: IL_FEATURE_FINGERPRINTS });
        expect(rows[0].vf).toHaveLength(60);
        expect(rows[0].cands[1].af).toHaveLength(IL_ACTION_FEATURE_NAMES.length);
        expect(rows[2]).toEqual({
            t: "ilx_complete",
            v: 3,
            runFingerprint: FINGERPRINT,
            featureFingerprints: IL_FEATURE_FINGERPRINTS,
            modelInputContract: IL_MODEL_INPUT_CONTRACT,
            versions: VERSIONS,
            decisions: 2,
            gamesByCohort: { melee: 2 },
            config,
        });
    });
});

describe("planned-versions option validation (regression: unknown-narrowing after never-guard)", () => {
    const validateWithVersions = (versions: unknown) =>
        validateIlCorpus(completePair(), {
            runFingerprint: FINGERPRINT,
            cohort: "melee",
            expectedGames: 2,
            baseSeed: 7,
            versions: versions as never,
        });

    it("accepts a distinct two-version pair (the fixed narrowed-index path)", () => {
        expect(() => validateWithVersions(["v0.7s", "v0.7"])).not.toThrow();
    });

    it("rejects a non-array", () => {
        expect(() => validateWithVersions("v0.7s,v0.7")).toThrow(/exactly two planned strategy versions/);
    });

    it("rejects the wrong arity", () => {
        expect(() => validateWithVersions(["v0.7s"])).toThrow(/exactly two planned strategy versions/);
        expect(() => validateWithVersions(["v0.7s", "v0.7", "v0.6"])).toThrow(/exactly two planned strategy versions/);
    });

    it("rejects an identical pair", () => {
        expect(() => validateWithVersions(["v0.7", "v0.7"])).toThrow(/must be distinct/);
    });

    it("rejects non-string members via the element validator", () => {
        expect(() => validateWithVersions([7, "v0.7"])).toThrow();
    });
});
