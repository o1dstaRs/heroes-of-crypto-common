import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import type { ISetupAugmentChoice } from "../ai/setup/setup_ship";
import { premiumUpgradeSlate } from "./premium_upgrade_neighborhood";

export const PREMIUM_MATCHED_UPGRADE_SCHEMA = "premium-matched-upgrade-snapshot-v1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validSha = (value: string) => /^[a-f0-9]{64}$/.test(value);
function assert(ok: unknown, reason: string): asserts ok {
    if (!ok) throw new Error(reason);
}

export interface IPremiumMatchedUpgradeFamily {
    id: string;
    partition: "train" | "validation";
    map: 1 | 3 | 4;
    ownDoctrine: 1 | 2 | 3;
    opponentDoctrine: 1 | 2 | 3;
    pickOrder: 0 | 1;
    selectionSeed: number;
    combatSeeds: [number, number];
}
export interface IPremiumMatchedUpgradeRegistration {
    schema: "premium-matched-upgrade-registration-v1";
    studyId: string;
    sourceSha256: string;
    runtimeSha256: string;
    profileSha256: string;
    /** Sealed after all native openings are prepared and before the first continuation. */
    setupLocksSha256: string;
    families: IPremiumMatchedUpgradeFamily[];
}
export interface IPremiumMatchedUpgradeLock {
    familyId: string;
    incumbentPurchases: ISetupAugmentChoice[];
    slate: ReturnType<typeof premiumUpgradeSlate>;
    /** Strict public Setup inputs. Opponent doctrine/build/positions do not enter the learner. */
    observation: {
        ownCreatureIds: number[];
        publicOpponentCreatureIds: number[];
        ownArtifactIds: [number, number];
        ownDoctrine: number;
        gridType: number;
        synergyVariants: { Life: number; Nature: number; Chaos: number; Might: number };
    };
    seats: {
        geometrySha256: string;
        ownBodiesSha256: string;
        opponentSetupSha256: string;
    }[];
}
export interface IPremiumMatchedUpgradeFight {
    familyId: string;
    arm: number;
    seat: number;
    future: number;
    combatSeed: number;
    lockSha256: string;
    sourceSha256: string;
    runtimeSha256: string;
    profileSha256: string;
    planKey: string;
    score: 0 | 0.5 | 1;
    nativePublicSetup: true;
    exactFundedPlan: true;
    bothTeamsFullA19: true;
    rejectedActions: 0;
    geometrySha256: string;
    ownBodiesSha256: string;
    opponentSetupSha256: string;
    rawFightSha256: string;
}

export const premiumMatchedUpgradeLockHash = digest;

function validateLock(family: IPremiumMatchedUpgradeFamily, lock: IPremiumMatchedUpgradeLock) {
    assert(lock.familyId === family.id, "Mismatched setup lock family");
    const expected = premiumUpgradeSlate(
        lock.incumbentPurchases,
        getUpgradePoints(family.ownDoctrine),
        family.selectionSeed,
    );
    assert(JSON.stringify(expected) === JSON.stringify(lock.slate), "Upgrade slate changed after registration");
    const observation = lock.observation;
    assert(
        Object.keys(observation).sort().join() ===
            [
                "ownCreatureIds",
                "publicOpponentCreatureIds",
                "ownArtifactIds",
                "ownDoctrine",
                "gridType",
                "synergyVariants",
            ]
                .sort()
                .join(),
        "Unexpected/private Setup observation field",
    );
    assert(
        observation.ownDoctrine === family.ownDoctrine && observation.gridType === family.map,
        "Setup doctrine or map differs",
    );
    for (const ids of [observation.ownCreatureIds, observation.publicOpponentCreatureIds]) {
        assert(
            ids.length === 6 && new Set(ids).size === 6 && ids.every((id) => Number.isSafeInteger(id) && id > 0),
            "Incomplete public ranked roster",
        );
    }
    assert(
        observation.ownCreatureIds.every((id) => !observation.publicOpponentCreatureIds.includes(id)),
        "Shared draft creature",
    );
    assert(
        observation.ownArtifactIds.length === 2 &&
            observation.ownArtifactIds.every((id) => Number.isSafeInteger(id) && id > 0),
        "Invalid own artifacts",
    );
    assert(
        Object.keys(observation.synergyVariants).sort().join() === ["Life", "Nature", "Chaos", "Might"].sort().join() &&
            Object.values(observation.synergyVariants).every((id) => [1, 2].includes(id)),
        "Invalid public synergy variants",
    );
    assert(lock.seats.length === 2, "Both native physical seats required");
    for (const seat of lock.seats)
        assert(
            [seat.geometrySha256, seat.ownBodiesSha256, seat.opponentSetupSha256].every(validSha),
            "Missing exact native opening commitments",
        );
}

/** Admission validates a complete fixed bank, never a favorable/complete subset of families. */
export function validatePremiumMatchedUpgradeBank(
    registration: IPremiumMatchedUpgradeRegistration,
    locks: readonly IPremiumMatchedUpgradeLock[],
    fights: readonly IPremiumMatchedUpgradeFight[],
) {
    assert(
        registration.schema === "premium-matched-upgrade-registration-v1" && registration.studyId,
        "Unknown matched collection registration",
    );
    assert(
        [
            registration.sourceSha256,
            registration.runtimeSha256,
            registration.profileSha256,
            registration.setupLocksSha256,
        ].every(validSha),
        "Unsealed collection identity",
    );
    assert(
        registration.families.length > 0 &&
            locks.length === registration.families.length &&
            fights.length === registration.families.length * 16,
        "Incomplete fixed matched bank",
    );
    const families = new Map(registration.families.map((family) => [family.id, family]));
    const lockMap = new Map(locks.map((lock) => [lock.familyId, lock]));
    assert(families.size === registration.families.length && lockMap.size === locks.length, "Duplicate matched family");
    assert(
        digest(registration.families.map((family) => lockMap.get(family.id))) === registration.setupLocksSha256,
        "Global pre-outcome setup lock changed",
    );
    const seeds = new Set<number>();
    for (const family of registration.families) {
        assert(
            family.id &&
                ["train", "validation"].includes(family.partition) &&
                [1, 3, 4].includes(family.map) &&
                [1, 2, 3].includes(family.ownDoctrine) &&
                [1, 2, 3].includes(family.opponentDoctrine) &&
                [0, 1].includes(family.pickOrder),
            "Invalid registered family",
        );
        assert(family.combatSeeds.length === 2, "Two matched futures required");
        for (const seed of [family.selectionSeed, ...family.combatSeeds]) {
            assert(
                Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff && !seeds.has(seed),
                "Overlapping selection/combat channels",
            );
            seeds.add(seed);
        }
        assert(lockMap.has(family.id), "Missing setup lock");
        validateLock(family, lockMap.get(family.id)!);
    }
    const cases = new Set<string>();
    for (const fight of fights) {
        const family = families.get(fight.familyId);
        assert(
            family && [0, 1, 2, 3].includes(fight.arm) && [0, 1].includes(fight.seat) && [0, 1].includes(fight.future),
            "Unregistered fight case",
        );
        const key = JSON.stringify([fight.familyId, fight.arm, fight.seat, fight.future]);
        assert(!cases.has(key), "Duplicate fight case");
        cases.add(key);
        const lock = lockMap.get(fight.familyId)!;
        assert(
            fight.combatSeed === family.combatSeeds[fight.future] && fight.lockSha256 === digest(lock),
            "Fight does not match pre-outcome lock/future",
        );
        assert(
            fight.sourceSha256 === registration.sourceSha256 &&
                fight.runtimeSha256 === registration.runtimeSha256 &&
                fight.profileSha256 === registration.profileSha256,
            "Mixed source/runtime/profile identity",
        );
        assert(
            fight.planKey === lock.slate.plans[fight.arm].key && [0, 0.5, 1].includes(fight.score),
            "Wrong paid plan or outcome",
        );
        assert(
            fight.nativePublicSetup === true &&
                fight.exactFundedPlan === true &&
                fight.bothTeamsFullA19 === true &&
                fight.rejectedActions === 0 &&
                validSha(fight.rawFightSha256),
            "Native application or full-A19 admission failed",
        );
        const seat = lock.seats[fight.seat];
        assert(
            fight.geometrySha256 === seat.geometrySha256 &&
                fight.ownBodiesSha256 === seat.ownBodiesSha256 &&
                fight.opponentSetupSha256 === seat.opponentSetupSha256,
            "Intervention changed geometry, splits or opponent setup",
        );
    }
    return { families, lockMap, cases };
}

/** Separate paired-label artifact; never replaces or publishes the production Premium SQLite. */
export function buildPremiumMatchedUpgradeSnapshot(
    registration: IPremiumMatchedUpgradeRegistration,
    locks: readonly IPremiumMatchedUpgradeLock[],
    fights: readonly IPremiumMatchedUpgradeFight[],
    outputPath: string,
) {
    const { families } = validatePremiumMatchedUpgradeBank(registration, locks, fights);
    assert(!existsSync(outputPath), "Refusing to overwrite an existing snapshot");
    const db = new Database(outputPath, { create: true, strict: true });
    try {
        db.exec(`PRAGMA foreign_keys=ON;
            CREATE TABLE metadata(key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
            CREATE TABLE family(id TEXT PRIMARY KEY, partition TEXT NOT NULL CHECK(partition IN ('train','validation')), payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
            CREATE TABLE setup_lock(family_id TEXT PRIMARY KEY REFERENCES family(id), sha256 TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
            CREATE TABLE continuation(family_id TEXT NOT NULL REFERENCES family(id), arm INTEGER NOT NULL, seat INTEGER NOT NULL, future INTEGER NOT NULL, score REAL NOT NULL CHECK(score IN (0,0.5,1)), payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(family_id,arm,seat,future)) STRICT;
            CREATE VIEW training_comparison AS SELECT c.family_id,c.arm,c.seat,c.future,c.score AS candidate_score,b.score AS incumbent_score,c.score-b.score AS paired_gain FROM continuation c JOIN continuation b ON b.family_id=c.family_id AND b.arm=0 AND b.seat=c.seat AND b.future=c.future JOIN family f ON f.id=c.family_id WHERE c.arm>0 AND f.partition='train';`);
        const manifest = {
            schema: PREMIUM_MATCHED_UPGRADE_SCHEMA,
            status: "development",
            studyId: registration.studyId,
            registrationSha256: digest(registration),
            sourceSha256: registration.sourceSha256,
            runtimeSha256: registration.runtimeSha256,
            profileSha256: registration.profileSha256,
            families: families.size,
            fights: fights.length,
            labelKind: "matched-conditional-upgrade-outcome-not-policy-win-rate",
            modelsFitted: 0,
            promoted: false,
        };
        db.transaction(() => {
            db.query("INSERT INTO metadata VALUES('manifest',?)").run(JSON.stringify(manifest));
            db.query("INSERT INTO metadata VALUES('registration',?)").run(JSON.stringify(registration));
            for (const family of registration.families)
                db.query("INSERT INTO family VALUES(?,?,?)").run(family.id, family.partition, JSON.stringify(family));
            for (const lock of locks)
                db.query("INSERT INTO setup_lock VALUES(?,?,?)").run(lock.familyId, digest(lock), JSON.stringify(lock));
            for (const fight of fights)
                db.query("INSERT INTO continuation VALUES(?,?,?,?,?,?)").run(
                    fight.familyId,
                    fight.arm,
                    fight.seat,
                    fight.future,
                    fight.score,
                    JSON.stringify(fight),
                );
        })();
        assert(
            db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check === "ok" &&
                db.query("PRAGMA foreign_key_check").all().length === 0,
            "Matched snapshot integrity failed",
        );
        return manifest;
    } finally {
        db.close();
    }
}
