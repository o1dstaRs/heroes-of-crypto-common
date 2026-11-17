import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { IDraftMatchupModel } from "../ai/setup/draft_matchup_value";
import { createUniformMatchedDraftSlate } from "./premium_uniform_draft_slate";
import {
    createMatchedDraftSlate,
    createMatchedDraftFeatures,
    type MatchedDraftView,
} from "./premium_matched_draft_model";

const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const validSha = (x: string) => /^[a-f0-9]{64}$/.test(x);
function assert(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
export interface IMatchedPickFamily {
    id: string;
    partition: "train" | "validation";
    map: 1 | 3 | 4;
    ownDoctrine: 2;
    opponentDoctrine: 1 | 2 | 3;
    selectionSeed: number;
    combatSeeds: [number, number];
}
export interface IMatchedPickLock {
    familyId: string;
    view: MatchedDraftView;
    ownTeam: number;
    incumbent: number;
    slate: NonNullable<ReturnType<ReturnType<typeof createMatchedDraftSlate>>>;
    openings: { seat: number; arm: number; openingSha256: string; draftSha256: string; appliedCreatureId: number }[];
}
interface IMatchedPickRegistrationIdentity {
    studyId: string;
    sourceSha256: string;
    runtimeSha256: string;
    profileSha256: string;
    historicalModelCanonicalSha256: string;
    choiceLocksSha256: string;
}
export interface IMatchedPickRegistration extends IMatchedPickRegistrationIdentity {
    schema: "premium-matched-pick-registration-v1";
    families: IMatchedPickFamily[];
}
export interface IMatchedPickRepeatedFamily extends Omit<IMatchedPickFamily, "combatSeeds"> {
    /** Complete, prospectively declared matched futures; no filling based on observed outcomes. */
    combatSeeds: readonly number[];
}
export interface IMatchedPickRepeatedRegistration extends IMatchedPickRegistrationIdentity {
    schema: "premium-matched-pick-registration-v2";
    families: IMatchedPickRepeatedFamily[];
}
export interface IMatchedPickUniformRegistration extends IMatchedPickRegistrationIdentity {
    schema: "premium-matched-pick-registration-v3";
    slateSampling: "two-uniform-alternatives-without-replacement";
    families: IMatchedPickRepeatedFamily[];
}
export interface IMatchedPickFight {
    familyId: string;
    seat: number;
    future: number;
    arm: number;
    combatSeed: number;
    score: 0 | 0.5 | 1;
    sourceSha256: string;
    runtimeSha256: string;
    profileSha256: string;
    lockSha256: string;
    openingSha256: string;
    appliedCreatureId: number;
    rawFightSha256: string;
    exactNativeSetup: true;
    bothTeamsFullA19: true;
    rejectedActions: 0;
}
export const premiumMatchedPickDigest = digest;

/** Every fixed arm/seat/future is required. No reconstruction of missing alternatives from observed wins. */
export function buildPremiumMatchedDraftSnapshot(
    reg: IMatchedPickRegistration | IMatchedPickRepeatedRegistration | IMatchedPickUniformRegistration,
    locks: readonly IMatchedPickLock[],
    fights: readonly IMatchedPickFight[],
    historical: IDraftMatchupModel,
    path: string,
) {
    assert(
        [
            "premium-matched-pick-registration-v1",
            "premium-matched-pick-registration-v2",
            "premium-matched-pick-registration-v3",
        ].includes(reg.schema) &&
            reg.studyId &&
            !existsSync(path),
        "Invalid or existing matched-pick snapshot",
    );
    assert(
        [
            reg.sourceSha256,
            reg.runtimeSha256,
            reg.profileSha256,
            reg.choiceLocksSha256,
            reg.historicalModelCanonicalSha256,
        ].every(validSha),
        "Unsealed source/model identity",
    );
    assert(digest(historical) === reg.historicalModelCanonicalSha256, "Changed historical prior");
    const uniform = reg.schema === "premium-matched-pick-registration-v3";
    const repeated = reg.schema !== "premium-matched-pick-registration-v1";
    assert(
        !uniform || reg.slateSampling === "two-uniform-alternatives-without-replacement",
        "Unknown uniform slate contract",
    );
    const families = new Map<string, IMatchedPickRepeatedFamily>(reg.families.map((f) => [f.id, f])),
        lockMap = new Map(locks.map((l) => [l.familyId, l]));
    assert(
        families.size > 0 &&
            families.size === reg.families.length &&
            lockMap.size === locks.length &&
            locks.length === families.size &&
            fights.length === reg.families.reduce((count, f) => count + f.combatSeeds.length * 6, 0),
        "Incomplete or duplicate fixed bank",
    );
    assert(digest(reg.families.map((f) => lockMap.get(f.id))) === reg.choiceLocksSha256, "Changed pre-outcome locks");
    const slateFor = uniform ? createUniformMatchedDraftSlate(historical) : createMatchedDraftSlate(historical),
        featuresFor = createMatchedDraftFeatures(historical),
        seeds = new Set<number>();
    for (const family of reg.families) {
        assert(
            ["train", "validation"].includes(family.partition) &&
                [1, 3, 4].includes(family.map) &&
                family.ownDoctrine === 2 &&
                [1, 2, 3].includes(family.opponentDoctrine) &&
                (repeated ? family.combatSeeds.length >= 2 : family.combatSeeds.length === 2),
            "Invalid family registration",
        );
        for (const seed of [family.selectionSeed, ...family.combatSeeds]) {
            assert(
                Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff && !seeds.has(seed),
                "Repeated seed channel",
            );
            seeds.add(seed);
        }
        const lock = lockMap.get(family.id);
        assert(lock, "Missing pick lock");
        assert(lock.view.doctrine === 2 && lock.view.revealedMap === family.map, "Wrong public doctrine/map");
        const allowed = [
            "phaseSequence",
            "phase",
            "actors",
            "requiredCreatureLevel",
            "complete",
            "creaturesBanned",
            "creaturesPicked",
            "knownOpponentCreatures",
            "doctrine",
            "bundles",
            "tier2Offers",
            "artifacts",
            "availableCreatureIds",
            "revealedMap",
            "synergyVariants",
        ];
        assert(Object.keys(lock.view).sort().join() === allowed.sort().join(), "Unexpected/private public-view field");
        assert(
            digest(slateFor(lock.view, lock.ownTeam, lock.incumbent, family.selectionSeed)) === digest(lock.slate),
            "Changed legal challenger sampling",
        );
        assert(
            lock.openings.length === 6 && new Set(lock.openings.map((o) => `${o.seat}:${o.arm}`)).size === 6,
            "Incomplete native openings",
        );
        for (const o of lock.openings)
            assert(
                [0, 1].includes(o.seat) &&
                    [0, 1, 2].includes(o.arm) &&
                    validSha(o.openingSha256) &&
                    validSha(o.draftSha256) &&
                    o.appliedCreatureId === lock.slate.creatureIds[o.arm],
                "Invalid native opening identity",
            );
        for (const id of lock.slate.creatureIds)
            assert(featuresFor(lock.view, lock.ownTeam, lock.incumbent, id), "Invalid public learning input");
    }
    const cases = new Set<string>();
    for (const fight of fights) {
        const f = families.get(fight.familyId),
            l = lockMap.get(fight.familyId);
        assert(
            f &&
                l &&
                [0, 1].includes(fight.seat) &&
                Number.isInteger(fight.future) &&
                fight.future >= 0 &&
                fight.future < f.combatSeeds.length &&
                [0, 1, 2].includes(fight.arm),
            "Unregistered fight",
        );
        const key = `${fight.familyId}:${fight.seat}:${fight.future}:${fight.arm}`;
        assert(!cases.has(key), "Duplicate fight");
        cases.add(key);
        const opening = l.openings.find((o) => o.seat === fight.seat && o.arm === fight.arm)!;
        assert(
            fight.combatSeed === f.combatSeeds[fight.future] &&
                fight.lockSha256 === digest(l) &&
                fight.openingSha256 === opening.openingSha256 &&
                fight.appliedCreatureId === opening.appliedCreatureId,
            "Fight differs from native locked branch",
        );
        assert(
            fight.sourceSha256 === reg.sourceSha256 &&
                fight.runtimeSha256 === reg.runtimeSha256 &&
                fight.profileSha256 === reg.profileSha256,
            "Mixed source/runtime/profile",
        );
        assert(
            [0, 0.5, 1].includes(fight.score) &&
                validSha(fight.rawFightSha256) &&
                fight.exactNativeSetup &&
                fight.bothTeamsFullA19 &&
                fight.rejectedActions === 0,
            "Fight quality failed",
        );
    }
    const db = new Database(path, { create: true, strict: true });
    try {
        db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE metadata(key TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE TABLE family(id TEXT PRIMARY KEY,partition TEXT NOT NULL CHECK(partition IN ('train','validation')),payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE TABLE choice_lock(family_id TEXT PRIMARY KEY REFERENCES family(id),sha256 TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE TABLE continuation(family_id TEXT NOT NULL REFERENCES family(id),arm INTEGER NOT NULL,seat INTEGER NOT NULL,future INTEGER NOT NULL,score REAL NOT NULL CHECK(score IN (0,0.5,1)),payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(family_id,arm,seat,future)) STRICT;
        CREATE VIEW training_comparison AS SELECT c.family_id,c.arm,c.seat,c.future,c.score candidate_score,b.score incumbent_score,c.score-b.score paired_gain FROM continuation c JOIN continuation b ON b.family_id=c.family_id AND b.arm=0 AND b.seat=c.seat AND b.future=c.future JOIN family f ON f.id=c.family_id WHERE c.arm>0 AND f.partition='train';`);
        if (repeated)
            db.exec(`CREATE VIEW training_weighted_comparison AS
                SELECT c.*,1.0/(4*json_array_length(f.payload,'$.combatSeeds')) family_weight
                FROM training_comparison c JOIN family f ON f.id=c.family_id;`);
        const receipt = {
            schema: uniform
                ? "premium-matched-final-pick-snapshot-v3"
                : repeated
                  ? "premium-matched-final-pick-snapshot-v2"
                  : "premium-matched-final-pick-snapshot-v1",
            status: "development",
            studyId: reg.studyId,
            registrationSha256: digest(reg),
            sourceSha256: reg.sourceSha256,
            runtimeSha256: reg.runtimeSha256,
            profileSha256: reg.profileSha256,
            families: families.size,
            logicalFights: fights.length,
            labelKind: "matched-conditional-draft-outcome-not-policy-win-rate",
            automaticallyPublished: false,
            ...(uniform ? { slateSampling: reg.slateSampling } : {}),
            ...(repeated
                ? {
                      trainingWeighting: "equal-total-weight-per-family-across-arms-seats-and-futures",
                      futureCounts: Object.fromEntries(reg.families.map((f) => [f.id, f.combatSeeds.length])),
                  }
                : {}),
        };
        db.transaction(() => {
            db.query("INSERT INTO metadata VALUES('manifest',?)").run(JSON.stringify(receipt));
            db.query("INSERT INTO metadata VALUES('registration',?)").run(JSON.stringify(reg));
            for (const f of reg.families)
                db.query("INSERT INTO family VALUES(?,?,?)").run(f.id, f.partition, JSON.stringify(f));
            for (const l of locks)
                db.query("INSERT INTO choice_lock VALUES(?,?,?)").run(l.familyId, digest(l), JSON.stringify(l));
            for (const r of fights)
                db.query("INSERT INTO continuation VALUES(?,?,?,?,?,?)").run(
                    r.familyId,
                    r.arm,
                    r.seat,
                    r.future,
                    r.score,
                    JSON.stringify(r),
                );
        })();
        assert(
            db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check === "ok" &&
                db.query("PRAGMA foreign_key_check").all().length === 0,
            "Snapshot integrity failed",
        );
        assert(
            db.query<{ n: number }, []>("SELECT count(*) n FROM training_comparison").get()?.n ===
                reg.families
                    .filter((f) => f.partition === "train")
                    .reduce((count, f) => count + f.combatSeeds.length * 4, 0),
            "Training-only comparison count mismatch",
        );
        if (repeated)
            assert(
                db
                    .query(
                        `SELECT family_id FROM training_weighted_comparison GROUP BY family_id
                        HAVING abs(sum(family_weight)-1)>1e-10`,
                    )
                    .all().length === 0,
                "Unequal training family weights",
            );
        return receipt;
    } finally {
        db.close();
    }
}
