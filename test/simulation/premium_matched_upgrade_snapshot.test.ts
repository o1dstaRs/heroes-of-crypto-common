import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { premiumUpgradeSlate } from "../../src/simulation/premium_upgrade_neighborhood";
import {
    buildPremiumMatchedUpgradeSnapshot,
    premiumMatchedUpgradeLockHash,
    validatePremiumMatchedUpgradeBank,
    type IPremiumMatchedUpgradeFight,
    type IPremiumMatchedUpgradeLock,
    type IPremiumMatchedUpgradeRegistration,
} from "../../src/simulation/premium_matched_upgrade_snapshot";

const sha = (n: number) => n.toString(16).padStart(64, "0");
function fixture() {
    const registration: IPremiumMatchedUpgradeRegistration = {
        schema: "premium-matched-upgrade-registration-v1",
        studyId: "synthetic-only",
        sourceSha256: sha(1),
        runtimeSha256: sha(2),
        profileSha256: sha(3),
        setupLocksSha256: sha(4),
        families: [
            {
                id: "train",
                partition: "train",
                map: 1,
                ownDoctrine: 2,
                opponentDoctrine: 1,
                pickOrder: 0,
                selectionSeed: 1001,
                combatSeeds: [1002, 1003],
            },
            {
                id: "held-out",
                partition: "validation",
                map: 4,
                ownDoctrine: 2,
                opponentDoctrine: 3,
                pickOrder: 1,
                selectionSeed: 2001,
                combatSeeds: [2002, 2003],
            },
        ],
    };
    const locks: IPremiumMatchedUpgradeLock[] = registration.families.map((family) => {
        const incumbentPurchases = [
            { kind: "Placement" as const, value: 1 },
            { kind: "Armor" as const, value: 2 },
            { kind: "Might" as const, value: 2 },
        ];
        return {
            familyId: family.id,
            incumbentPurchases,
            slate: premiumUpgradeSlate(incumbentPurchases, 5, family.selectionSeed),
            observation: {
                ownCreatureIds: [1, 2, 3, 4, 5, 6],
                publicOpponentCreatureIds: [11, 12, 13, 14, 15, 16],
                ownArtifactIds: [1, 2],
                ownDoctrine: family.ownDoctrine,
                gridType: family.map,
                synergyVariants: { Life: 1, Nature: 2, Chaos: 1, Might: 2 },
            },
            seats: [0, 1].map((seat) => ({
                geometrySha256: sha(100 + seat),
                ownBodiesSha256: sha(200 + seat),
                opponentSetupSha256: sha(300 + seat),
            })),
        };
    });
    registration.setupLocksSha256 = premiumMatchedUpgradeLockHash(locks);
    const fights: IPremiumMatchedUpgradeFight[] = registration.families.flatMap((family, i) =>
        [0, 1, 2, 3].flatMap((arm) =>
            [0, 1].flatMap((seat) =>
                [0, 1].map((future) => ({
                    familyId: family.id,
                    arm,
                    seat,
                    future,
                    combatSeed: family.combatSeeds[future],
                    lockSha256: premiumMatchedUpgradeLockHash(locks[i]),
                    sourceSha256: registration.sourceSha256,
                    runtimeSha256: registration.runtimeSha256,
                    profileSha256: registration.profileSha256,
                    planKey: locks[i].slate.plans[arm].key,
                    score: (family.partition === "validation" ? 1 : arm === 0 ? 0.5 : future === 0 ? 1 : 0) as
                        0 | 0.5 | 1,
                    nativePublicSetup: true as const,
                    exactFundedPlan: true as const,
                    bothTeamsFullA19: true as const,
                    rejectedActions: 0 as const,
                    ...locks[i].seats[seat],
                    rawFightSha256: sha(1000 + i * 16 + arm * 4 + seat * 2 + future),
                })),
            ),
        ),
    );
    return { registration, locks, fights };
}

describe("fixed matched upgrade snapshot admission", () => {
    it("requires every arm, seat and future and rejects duplicates instead of shrinking the bank", () => {
        const f = fixture();
        expect(validatePremiumMatchedUpgradeBank(f.registration, f.locks, f.fights).cases.size).toBe(32);
        expect(() => validatePremiumMatchedUpgradeBank(f.registration, f.locks, f.fights.slice(1))).toThrow(
            "Incomplete",
        );
        f.fights[1] = f.fights[0];
        expect(() => validatePremiumMatchedUpgradeBank(f.registration, f.locks, f.fights)).toThrow("Duplicate fight");
    });

    it("rejects mixed sources, unmatched futures, rejects and altered native geometry/opponent setups", () => {
        for (const field of [
            "sourceSha256",
            "runtimeSha256",
            "profileSha256",
            "lockSha256",
            "geometrySha256",
            "ownBodiesSha256",
            "opponentSetupSha256",
        ] as const) {
            const f = fixture();
            f.fights[4][field] = sha(99999);
            expect(() => validatePremiumMatchedUpgradeBank(f.registration, f.locks, f.fights)).toThrow();
        }
        for (const change of [
            { combatSeed: 99 },
            { rejectedActions: 1 },
            { exactFundedPlan: false },
            { bothTeamsFullA19: false },
            { nativePublicSetup: false },
            { planKey: "unplayed" },
            { score: 0.2 },
        ]) {
            const f = fixture();
            Object.assign(f.fights[4], change);
            expect(() => validatePremiumMatchedUpgradeBank(f.registration, f.locks, f.fights)).toThrow();
        }
    });

    it("binds the global pre-outcome lock and rejects private inputs and reused selection/future channels", () => {
        const changed = fixture();
        changed.locks[0].observation.ownArtifactIds[0] = 3;
        expect(() => validatePremiumMatchedUpgradeBank(changed.registration, changed.locks, changed.fights)).toThrow(
            "Global pre-outcome",
        );
        const privateInput = fixture();
        Object.assign(privateInput.locks[0].observation, { hiddenEnemyArtifacts: [1, 2] });
        privateInput.registration.setupLocksSha256 = premiumMatchedUpgradeLockHash(privateInput.locks);
        expect(() =>
            validatePremiumMatchedUpgradeBank(privateInput.registration, privateInput.locks, privateInput.fights),
        ).toThrow("private");
        const overlap = fixture();
        overlap.registration.families[1].combatSeeds[1] = overlap.registration.families[0].selectionSeed;
        expect(() => validatePremiumMatchedUpgradeBank(overlap.registration, overlap.locks, overlap.fights)).toThrow(
            "channels",
        );
    });

    it("writes immutable development SQLite with exact paired labels and train-only comparisons", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-matched-upgrades-"));
        const output = join(directory, "matched.sqlite");
        try {
            const f = fixture();
            expect(() =>
                buildPremiumMatchedUpgradeSnapshot(f.registration, f.locks, f.fights.slice(1), output),
            ).toThrow();
            expect(existsSync(output)).toBe(false);
            const manifest = buildPremiumMatchedUpgradeSnapshot(f.registration, f.locks, f.fights, output);
            expect(manifest).toMatchObject({
                families: 2,
                fights: 32,
                status: "development",
                modelsFitted: 0,
                promoted: false,
            });
            const before = readFileSync(output);
            const db = new Database(output, { readonly: true });
            try {
                const rows = db
                    .query<{ family_id: string; paired_gain: number }, []>("SELECT * FROM training_comparison")
                    .all();
                expect(rows).toHaveLength(12);
                expect(rows.every((row) => row.family_id === "train")).toBe(true);
                expect(rows.filter((row) => row.paired_gain === 0.5)).toHaveLength(6);
                expect(rows.filter((row) => row.paired_gain === -0.5)).toHaveLength(6);
                expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM continuation").get()!.n).toBe(32);
            } finally {
                db.close();
            }
            expect(() => buildPremiumMatchedUpgradeSnapshot(f.registration, f.locks, f.fights, output)).toThrow(
                "overwrite",
            );
            expect(readFileSync(output)).toEqual(before);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
