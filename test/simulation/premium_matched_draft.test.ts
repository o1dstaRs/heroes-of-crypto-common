import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IDraftMatchupModel } from "../../src/ai/setup/draft_matchup_value";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    createMatchedDraftSlate,
    createMatchedDraftFeatures,
    createMatchedDraftPolicy,
    MATCHED_DRAFT_FEATURES,
    MATCHED_DRAFT_MODEL_SCHEMA,
    type MatchedDraftView,
} from "../../src/simulation/premium_matched_draft_model";
import {
    buildPremiumMatchedDraftSnapshot,
    premiumMatchedPickDigest as digest,
    type IMatchedPickRegistration,
    type IMatchedPickRepeatedRegistration,
    type IMatchedPickUniformRegistration,
    type IMatchedPickLock,
    type IMatchedPickFight,
} from "../../src/simulation/premium_matched_draft_snapshot";
import { readPremiumMatchedDraftTraining } from "../../src/simulation/premium_matched_draft_training";
import {
    createPremiumDraftEffectFeatures,
    PREMIUM_DRAFT_EFFECT_FEATURES,
    PREMIUM_DRAFT_EFFECT_SCHEMA,
} from "../../src/simulation/premium_draft_effect_features";
import { createUniformMatchedDraftSlate } from "../../src/simulation/premium_uniform_draft_slate";
import {
    createPremiumDraftEffectPolicy,
    PREMIUM_DRAFT_EFFECT_MODEL_SCHEMA,
} from "../../src/simulation/premium_draft_effect_policy";

const h = "a".repeat(64);
const historical: IDraftMatchupModel = {
    schema: "draft-matchup-value-v1",
    recipe: "interactions",
    sourceSha256: h,
    snapshotSha256: h,
    trainingFamilies: 10,
    weights: {},
};
const own = [...CreatureLevelList[1].slice(0, 2), ...CreatureLevelList[2].slice(0, 2), CreatureLevelList[3][0]];
const enemy = [
    ...CreatureLevelList[1].slice(2, 4),
    ...CreatureLevelList[2].slice(2, 4),
    CreatureLevelList[3][1],
    CreatureLevelList[4][0],
];
const view: MatchedDraftView = {
    phaseSequence: 10,
    phase: PBTypes.PickPhaseVals.PICK,
    actors: [PBTypes.TeamVals.LEFT],
    requiredCreatureLevel: 4,
    complete: false,
    creaturesBanned: [],
    creaturesPicked: own,
    knownOpponentCreatures: enemy,
    doctrine: 2,
    bundles: [],
    tier2Offers: [],
    artifacts: [
        [1, 9],
        [2, 2],
    ],
    availableCreatureIds: CreatureLevelList[4].slice(1),
    revealedMap: 1,
    synergyVariants: { Life: 1, Chaos: 2, Might: 1, Nature: 2 },
};
const incumbent = view.availableCreatureIds[0];
function fixture() {
    const families = (["train", "validation"] as const).map((partition, i) => ({
        id: partition,
        partition,
        map: 1 as const,
        ownDoctrine: 2 as const,
        opponentDoctrine: 1 as const,
        selectionSeed: 100 + i * 3,
        combatSeeds: [101 + i * 3, 102 + i * 3] as [number, number],
    }));
    const locks: IMatchedPickLock[] = families.map((f) => {
        const slate = createMatchedDraftSlate(historical)(view, 2, incumbent, f.selectionSeed)!;
        return {
            familyId: f.id,
            view: structuredClone(view),
            ownTeam: 2,
            incumbent,
            slate,
            openings: [0, 1].flatMap((seat) =>
                [0, 1, 2].map((arm) => ({
                    seat,
                    arm,
                    openingSha256: h,
                    draftSha256: h,
                    appliedCreatureId: slate.creatureIds[arm],
                })),
            ),
        };
    });
    const reg: IMatchedPickRegistration = {
        schema: "premium-matched-pick-registration-v1",
        studyId: "test",
        sourceSha256: h,
        runtimeSha256: h,
        profileSha256: h,
        historicalModelCanonicalSha256: digest(historical),
        choiceLocksSha256: digest(locks),
        families,
    };
    const fights: IMatchedPickFight[] = families.flatMap((f, i) =>
        [0, 1].flatMap((seat) =>
            [0, 1].flatMap((future) =>
                [0, 1, 2].map((arm) => ({
                    familyId: f.id,
                    seat,
                    future,
                    arm,
                    combatSeed: f.combatSeeds[future],
                    score: (i === 1 ? 1 : arm === 1 ? 0.5 : 0) as 0 | 0.5 | 1,
                    sourceSha256: h,
                    runtimeSha256: h,
                    profileSha256: h,
                    lockSha256: digest(locks[i]),
                    openingSha256: h,
                    appliedCreatureId: locks[i].slate.creatureIds[arm],
                    rawFightSha256: h,
                    exactNativeSetup: true as const,
                    bothTeamsFullA19: true as const,
                    rejectedActions: 0 as const,
                })),
            ),
        ),
    );
    return { reg, locks, fights };
}

function repeatedFixture() {
    const original = fixture();
    const families = [
        original.reg.families[0],
        {
            ...original.reg.families[0],
            id: "train-long",
            selectionSeed: 200,
            combatSeeds: Array.from({ length: 8 }, (_, i) => 201 + i),
        },
        { ...original.reg.families[1], combatSeeds: [301, 302, 303, 304] },
    ];
    const locks = families.map((f) => {
        const slate = createMatchedDraftSlate(historical)(view, 2, incumbent, f.selectionSeed)!;
        return {
            ...structuredClone(original.locks[0]),
            familyId: f.id,
            slate,
            openings: original.locks[0].openings.map((o) => ({
                ...o,
                appliedCreatureId: slate.creatureIds[o.arm],
            })),
        };
    });
    const reg: IMatchedPickRepeatedRegistration = {
        ...original.reg,
        schema: "premium-matched-pick-registration-v2",
        families,
        choiceLocksSha256: digest(locks),
    };
    const fights = families.flatMap((f, i) =>
        [0, 1].flatMap((seat) =>
            f.combatSeeds.flatMap((combatSeed, future) =>
                [0, 1, 2].map((arm) => ({
                    ...original.fights[0],
                    familyId: f.id,
                    seat,
                    future,
                    arm,
                    combatSeed,
                    score: (f.partition === "validation" ? 1 : arm === 1 ? (i === 1 ? 1 : 0.5) : 0) as 0 | 0.5 | 1,
                    lockSha256: digest(locks[i]),
                    appliedCreatureId: locks[i].slate.creatureIds[arm],
                })),
            ),
        ),
    );
    return { reg, locks, fights };
}

describe("matched final-pick collection", () => {
    it("allows the direct-effect policy to select any legal pick while preserving zero-model fallback", () => {
        const model = {
            schema: PREMIUM_DRAFT_EFFECT_MODEL_SCHEMA,
            featureSchema: PREMIUM_DRAFT_EFFECT_SCHEMA,
            features: PREMIUM_DRAFT_EFFECT_FEATURES,
            weights: PREMIUM_DRAFT_EFFECT_FEATURES.map(() => 0),
            scales: PREMIUM_DRAFT_EFFECT_FEATURES.map(() => 1),
            historicalModelCanonicalSha256: digest(historical),
            margin: 0.03 as const,
        } as const;
        expect(createPremiumDraftEffectPolicy(historical, model)(view, 2, incumbent)?.selectedCreatureId).toBe(
            incumbent,
        );
        const last = view.availableCreatureIds.at(-1)!;
        const index = PREMIUM_DRAFT_EFFECT_FEATURES.indexOf(`unitDelta:${last}`);
        expect(index).toBeGreaterThanOrEqual(0);
        model.weights[index] = 0.04;
        const choose = createPremiumDraftEffectPolicy(historical, model);
        const choice = choose(view, 2, incumbent)!;
        expect(choice.selectedCreatureId).toBe(last);
        expect(choice.selectedCreatureId).not.toBe(
            createMatchedDraftSlate(historical)(view, 2, incumbent, 123)!.creatureIds[1],
        );
        expect(choice.candidates.length).toBe(view.availableCreatureIds.length);
        model.weights[index] = -5;
        expect(choose(view, 2, incumbent)).toEqual(choice);
        expect(choose({ ...view, doctrine: 1 }, 2, incumbent)).toBeNull();
        expect(choose({ ...view, knownOpponentCreatures: enemy.slice(0, 3) }, 2, incumbent)).toBeNull();
        expect(() =>
            createPremiumDraftEffectPolicy(historical, { ...model, historicalModelCanonicalSha256: h }),
        ).toThrow();
    });

    it("collects two uniform alternatives in a separate v3 contract without changing prior snapshot semantics", () => {
        const data = repeatedFixture(),
            sample = createUniformMatchedDraftSlate(historical);
        const locks = data.locks.map((lock, i) => {
            const slate = sample(lock.view, lock.ownTeam, lock.incumbent, data.reg.families[i].selectionSeed)!;
            expect(new Set(slate.creatureIds).size).toBe(3);
            for (const row of slate.inclusionProbabilities)
                expect(row.probability).toBe(
                    row.creatureId === lock.incumbent ? 1 : 2 / (view.availableCreatureIds.length - 1),
                );
            expect(slate.inclusionProbabilities.reduce((s, r) => s + r.probability, 0)).toBeCloseTo(3);
            return {
                ...lock,
                slate,
                openings: lock.openings.map((o) => ({ ...o, appliedCreatureId: slate.creatureIds[o.arm] })),
            };
        });
        const reg: IMatchedPickUniformRegistration = {
            ...data.reg,
            schema: "premium-matched-pick-registration-v3",
            slateSampling: "two-uniform-alternatives-without-replacement",
            choiceLocksSha256: digest(locks),
        };
        const fights = data.fights.map((f) => {
            const lock = locks.find((l) => l.familyId === f.familyId)!;
            return { ...f, lockSha256: digest(lock), appliedCreatureId: lock.slate.creatureIds[f.arm] };
        });
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-uniform-"));
        try {
            const file = join(dir, "v3.sqlite");
            const receipt = buildPremiumMatchedDraftSnapshot(reg, locks, fights, historical, file);
            expect(receipt.schema).toBe("premium-matched-final-pick-snapshot-v3");
            const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
            expect(readPremiumMatchedDraftTraining(file, hash).comparisons).toBe(40);
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    { ...reg, schema: "premium-matched-pick-registration-v2" },
                    locks,
                    fights,
                    historical,
                    join(dir, "wrong.sqlite"),
                ),
            ).toThrow("Changed legal challenger sampling");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("retains public opponent capability in conditional pick effects without leaking hidden setup", () => {
        const id = (name: string) => CreatureLevelList[4].find((candidate) => creatureInfo(candidate)?.name === name)!;
        const cannon = id("Tsar Cannon"),
            hydra = id("Hydra"),
            dragon = id("Magic Dragon"),
            abomination = id("Abomination");
        expect([cannon, hydra, dragon, abomination].every(Number.isInteger)).toBe(true);
        const publicState = {
            ...structuredClone(view),
            creaturesBanned: [abomination],
            knownOpponentCreatures: [...enemy.slice(0, 5), dragon],
            availableCreatureIds: CreatureLevelList[4].filter((unit) => unit !== dragon && unit !== abomination),
        };
        const features = createPremiumDraftEffectFeatures(historical);
        const before = structuredClone(publicState);
        const caster = features(publicState, 2, cannon, hydra)!;
        const ground = features(
            { ...publicState, creaturesBanned: [dragon], knownOpponentCreatures: [...enemy.slice(0, 5), abomination] },
            2,
            cannon,
            hydra,
        )!;
        const interaction = PREMIUM_DRAFT_EFFECT_FEATURES.indexOf("enemyInteraction:shooters:casters");
        expect(interaction).toBeGreaterThanOrEqual(0);
        // Replacing a shooter against one additional caster changes the interaction by 1/6 × 1/6.
        expect(Math.abs(caster.values[interaction] - ground.values[interaction])).toBeCloseTo(1 / 36);
        const reverse = features(publicState, 2, hydra, cannon)!;
        expect(caster.values.length).toBe(PREMIUM_DRAFT_EFFECT_FEATURES.length);
        expect(caster.values.every((x, i) => Math.abs(x + reverse.values[i]) < 1e-12)).toBe(true);
        expect(features(publicState, 2, cannon, cannon)?.values.every((x) => x === 0)).toBe(true);
        expect(
            features(
                { ...publicState, enemyArtifacts: [17], enemyPositions: [99], combatSeed: 41 } as MatchedDraftView,
                2,
                cannon,
                hydra,
            ),
        ).toEqual(caster);
        expect(features({ ...publicState, knownOpponentCreatures: enemy.slice(0, 3) }, 2, cannon, hydra)).toBeNull();
        expect(features({ ...publicState, doctrine: 1 }, 2, cannon, hydra)).toBeNull();
        expect(publicState).toEqual(before);
    });

    it("keeps a fixed legal challenger, public-only features and conservative fallback", () => {
        const slate = createMatchedDraftSlate(historical)(view, 2, incumbent, 123)!;
        expect(new Set(slate.creatureIds).size).toBe(3);
        expect(slate.inclusionProbabilities.reduce((s, x) => s + x.probability, 0)).toBeCloseTo(3);
        const feature = createMatchedDraftFeatures(historical),
            before = structuredClone(view);
        const f = feature(view, 2, incumbent, slate.creatureIds[1])!;
        expect(f.features.every(Number.isFinite)).toBe(true);
        expect(
            feature(
                { ...view, enemyArtifacts: [17], combatSeed: 987, actualEnemyPositions: [99] } as MatchedDraftView,
                2,
                incumbent,
                slate.creatureIds[1],
            ),
        ).toEqual(f);
        expect(
            feature({ ...view, knownOpponentCreatures: enemy.slice(0, 3) }, 2, incumbent, slate.creatureIds[1]),
        ).toBeNull();
        expect(feature({ ...view, doctrine: 1 }, 2, incumbent, slate.creatureIds[1])).toBeNull();
        const model = {
            schema: MATCHED_DRAFT_MODEL_SCHEMA as typeof MATCHED_DRAFT_MODEL_SCHEMA,
            features: MATCHED_DRAFT_FEATURES,
            weights: MATCHED_DRAFT_FEATURES.map(() => 0),
            scales: MATCHED_DRAFT_FEATURES.map(() => 1),
            margin: 0.03 as const,
            historicalModelSha256: h,
        };
        expect(createMatchedDraftPolicy(historical, model)(view, 2, incumbent)?.selectedCreatureId).toBe(incumbent);
        model.weights[0] = 0.031;
        expect(createMatchedDraftPolicy(historical, model)(view, 2, incumbent)?.selectedCreatureId).toBe(
            slate.creatureIds[1],
        );
        expect(view).toEqual(before);
        expect(() => createMatchedDraftPolicy(historical, { ...model, historicalModelSha256: "wrong" })).toThrow();
    });

    it("keeps reserved validation outcomes out of the training-only SQLite view", () => {
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-"));
        try {
            const { reg, locks, fights } = fixture(),
                file = join(dir, "data.sqlite");
            const receipt = buildPremiumMatchedDraftSnapshot(reg, locks, fights, historical, file);
            expect(receipt.logicalFights).toBe(24);
            const db = new Database(file, { readonly: true });
            const rows = db
                .query<{ family_id: string; paired_gain: number }, []>("SELECT * FROM training_comparison")
                .all();
            expect(rows.length).toBe(8);
            expect(rows.every((r) => r.family_id === "train")).toBe(true);
            expect(rows.reduce((s, r) => s + r.paired_gain, 0)).toBe(2);
            expect(db.query<{ n: number }, []>("SELECT count(*) n FROM continuation").get()?.n).toBe(24);
            expect(receipt.schema).toBe("premium-matched-final-pick-snapshot-v1");
            expect(db.query("SELECT name FROM sqlite_master WHERE name='training_weighted_comparison'").all()).toEqual(
                [],
            );
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("weights repeated training futures by whole family and keeps all validation labels excluded", () => {
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-repeated-"));
        try {
            const { reg, locks, fights } = repeatedFixture();
            const path = join(dir, "repeated.sqlite");
            const receipt = buildPremiumMatchedDraftSnapshot(reg, locks, fights, historical, path);
            expect(receipt.schema).toBe("premium-matched-final-pick-snapshot-v2");
            expect(receipt.logicalFights).toBe(84);
            const db = new Database(path, { readonly: true });
            const rows = db
                .query<{ family_id: string; paired_gain: number; family_weight: number }, []>(
                    "SELECT * FROM training_weighted_comparison",
                )
                .all();
            expect(rows.length).toBe(40);
            expect(rows.some((r) => r.family_id === "validation")).toBe(false);
            for (const family of ["train", "train-long"])
                expect(rows.filter((r) => r.family_id === family).reduce((s, r) => s + r.family_weight, 0)).toBeCloseTo(
                    1,
                );
            // Eight futures improve a family's estimate without giving it four times the objective weight.
            expect(rows.reduce((s, r) => s + r.paired_gain * r.family_weight, 0) / 2).toBeCloseTo(0.375);
            expect(rows.reduce((s, r) => s + r.paired_gain, 0) / rows.length).toBeCloseTo(0.45);
            expect(
                db.query<{ n: number }, []>("SELECT count(*) n FROM continuation WHERE family_id='validation'").get()
                    ?.n,
            ).toBe(24);
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects undeclared, missing, duplicated and cross-family repeated-future channels", () => {
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-repeated-bad-"));
        try {
            const { reg, locks, fights } = repeatedFixture();
            expect(() =>
                buildPremiumMatchedDraftSnapshot(reg, locks, fights.slice(1), historical, join(dir, "missing")),
            ).toThrow("Incomplete");
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    reg,
                    locks,
                    [fights[1], ...fights.slice(1)],
                    historical,
                    join(dir, "duplicate"),
                ),
            ).toThrow("Duplicate fight");
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    reg,
                    locks,
                    [{ ...fights[0], future: 2 }, ...fights.slice(1)],
                    historical,
                    join(dir, "undeclared"),
                ),
            ).toThrow("Unregistered fight");
            const collision = structuredClone(reg);
            collision.families[1].combatSeeds = [
                collision.families[0].combatSeeds[0],
                ...collision.families[1].combatSeeds.slice(1),
            ];
            expect(() =>
                buildPremiumMatchedDraftSnapshot(collision, locks, fights, historical, join(dir, "channel")),
            ).toThrow("Repeated seed channel");
            // A v1 registration must still mean exactly two futures, even with a complete larger bank.
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    { ...reg, schema: "premium-matched-pick-registration-v1" } as IMatchedPickRegistration,
                    locks,
                    fights,
                    historical,
                    join(dir, "v1"),
                ),
            ).toThrow("Invalid family registration");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads only public training inputs with equal family weights for both snapshot versions", () => {
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-reader-"));
        const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
        try {
            for (const [index, data] of [fixture(), repeatedFixture()].entries()) {
                const file = join(dir, `v${index + 1}.sqlite`);
                buildPremiumMatchedDraftSnapshot(data.reg, data.locks, data.fights, historical, file);
                const training = readPremiumMatchedDraftTraining(file, sha(file));
                expect(training.trainingFamilies).toBe(index + 1);
                expect(training.comparisons).toBe(index === 0 ? 8 : 40);
                expect(training.cases.some((row) => row.familyId === "validation")).toBe(false);
                expect(training.cases.every((row) => JSON.stringify(row.input.view) === JSON.stringify(view))).toBe(
                    true,
                );
                const families = new Set(training.cases.map((row) => row.familyId));
                for (const id of families)
                    expect(
                        training.cases
                            .filter((row) => row.familyId === id)
                            .flatMap((row) => row.targets)
                            .reduce((sum, row) => sum + row.familyWeight, 0),
                    ).toBeCloseTo(1);
                const encoded = JSON.stringify(training.cases);
                for (const concealed of ["opponentDoctrine", "combatSeed", "openingSha256", "actualEnemyPositions"])
                    expect(encoded.includes(concealed)).toBe(false);

                // A training consumer must not parse validation payloads or trust a changed SQL view.
                const db = new Database(file);
                db.exec(`UPDATE choice_lock SET payload='"held-out sentinel"' WHERE family_id='validation';
                    UPDATE continuation SET payload='"held-out sentinel"' WHERE family_id='validation';
                    DROP VIEW training_comparison;
                    CREATE VIEW training_comparison AS SELECT * FROM continuation WHERE family_id='validation';`);
                db.close();
                expect(readPremiumMatchedDraftTraining(file, sha(file)).cases).toEqual(training.cases);
                expect(() => readPremiumMatchedDraftTraining(file, training.snapshotSha256)).toThrow("Unadmitted");
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects an incomplete training family even if the supplied file hash matches", () => {
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-reader-missing-"));
        try {
            const { reg, locks, fights } = repeatedFixture();
            const file = join(dir, "data.sqlite");
            buildPremiumMatchedDraftSnapshot(reg, locks, fights, historical, file);
            const db = new Database(file);
            db.exec("DELETE FROM continuation WHERE family_id='train-long' AND arm=0 AND seat=0 AND future=7");
            db.close();
            const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
            expect(() => readPremiumMatchedDraftTraining(file, hash)).toThrow("Incomplete training comparisons");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects missing cases, wrong actions, source changes and hidden fields", () => {
        const dir = mkdtempSync(join(tmpdir(), "matched-pick-bad-"));
        try {
            const { reg, locks, fights } = fixture();
            expect(() =>
                buildPremiumMatchedDraftSnapshot(reg, locks, fights.slice(1), historical, join(dir, "missing")),
            ).toThrow("Incomplete");
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    reg,
                    locks,
                    [{ ...fights[0], appliedCreatureId: 999 }, ...fights.slice(1)],
                    historical,
                    join(dir, "action"),
                ),
            ).toThrow("locked branch");
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    reg,
                    locks,
                    [{ ...fights[0], sourceSha256: "b".repeat(64) }, ...fights.slice(1)],
                    historical,
                    join(dir, "source"),
                ),
            ).toThrow("Mixed source");
            const hidden = structuredClone(locks);
            Object.assign(hidden[0].view, { enemyArtifacts: [17] });
            expect(() =>
                buildPremiumMatchedDraftSnapshot(
                    { ...reg, choiceLocksSha256: digest(hidden) },
                    hidden,
                    fights,
                    historical,
                    join(dir, "private"),
                ),
            ).toThrow("private");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
