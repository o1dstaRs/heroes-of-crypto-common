import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MatchedDraftView } from "./premium_matched_draft_model";
import {
    premiumMatchedPickDigest,
    type IMatchedPickLock,
    type IMatchedPickRegistration,
    type IMatchedPickRepeatedRegistration,
    type IMatchedPickUniformRegistration,
} from "./premium_matched_draft_snapshot";

export interface IMatchedDraftTrainingCase {
    familyId: string;
    /** Only this public draft input may enter a feature builder. */
    input: { view: MatchedDraftView; ownTeam: number; incumbent: number; alternative: number };
    /** Observed outcomes and grouping indices are targets, never draft features. */
    targets: {
        seat: number;
        future: number;
        candidateScore: number;
        incumbentScore: number;
        pairedGain: number;
        familyWeight: number;
    }[];
}

function requireValue(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}

function publicView(view: MatchedDraftView): MatchedDraftView {
    return structuredClone({
        phaseSequence: view.phaseSequence,
        phase: view.phase,
        actors: view.actors,
        requiredCreatureLevel: view.requiredCreatureLevel,
        complete: view.complete,
        creaturesBanned: view.creaturesBanned,
        creaturesPicked: view.creaturesPicked,
        knownOpponentCreatures: view.knownOpponentCreatures,
        doctrine: view.doctrine,
        bundles: view.bundles,
        tier2Offers: view.tier2Offers,
        artifacts: view.artifacts,
        availableCreatureIds: view.availableCreatureIds,
        revealedMap: view.revealedMap,
        synergyVariants: view.synergyVariants,
    });
}

/**
 * Read an independently admitted, hash-pinned snapshot without opening validation labels.
 * Hidden opponent doctrine, combat seeds and native setup observations are deliberately omitted.
 * The historical prior or next feature contract is supplied separately by the fitting campaign.
 */
export function readPremiumMatchedDraftTraining(path: string, expectedSnapshotSha256: string) {
    const actualSha = createHash("sha256").update(readFileSync(path)).digest("hex");
    requireValue(
        /^[a-f0-9]{64}$/.test(expectedSnapshotSha256) && actualSha === expectedSnapshotSha256,
        "Unadmitted matched-pick snapshot",
    );
    const db = new Database(path, { readonly: true, strict: true });
    try {
        const metadata = (key: string) => {
            const row = db.query<{ payload: string }, [string]>("SELECT payload FROM metadata WHERE key=?").get(key);
            requireValue(row, "Missing matched-pick metadata");
            return JSON.parse(row.payload);
        };
        const manifest = metadata("manifest"),
            reg: IMatchedPickRegistration | IMatchedPickRepeatedRegistration | IMatchedPickUniformRegistration =
                metadata("registration");
        const uniform = reg.schema === "premium-matched-pick-registration-v3";
        const repeated = reg.schema === "premium-matched-pick-registration-v2" || uniform;
        requireValue(
            (repeated || reg.schema === "premium-matched-pick-registration-v1") &&
                manifest.schema ===
                    (uniform
                        ? "premium-matched-final-pick-snapshot-v3"
                        : repeated
                          ? "premium-matched-final-pick-snapshot-v2"
                          : "premium-matched-final-pick-snapshot-v1") &&
                (!uniform || reg.slateSampling === "two-uniform-alternatives-without-replacement") &&
                manifest.status === "development" &&
                manifest.automaticallyPublished === false &&
                manifest.sourceSha256 === reg.sourceSha256 &&
                manifest.runtimeSha256 === reg.runtimeSha256 &&
                manifest.profileSha256 === reg.profileSha256 &&
                manifest.registrationSha256 === premiumMatchedPickDigest(reg),
            "Invalid matched-pick training contract",
        );
        const declared = reg.families.filter((f) => f.partition === "train");
        requireValue(new Set(declared.map((f) => f.id)).size === declared.length, "Duplicate training family");
        const training = db
            .query<{ id: string; payload: string; lock_payload: string; lock_sha: string }, []>(
                `SELECT f.id,f.payload,l.payload lock_payload,l.sha256 lock_sha
                 FROM family f JOIN choice_lock l ON l.family_id=f.id
                 WHERE f.partition='train' ORDER BY f.id`,
            )
            .all();
        requireValue(training.length === declared.length && training.length > 0, "Missing training families");
        const cases: IMatchedDraftTrainingCase[] = [];
        let comparisons = 0;
        for (const row of training) {
            const family = declared.find((f) => f.id === row.id),
                lock: IMatchedPickLock = JSON.parse(row.lock_payload);
            requireValue(
                family &&
                    premiumMatchedPickDigest(JSON.parse(row.payload)) === premiumMatchedPickDigest(family) &&
                    (repeated ? family.combatSeeds.length >= 2 : family.combatSeeds.length === 2) &&
                    lock.familyId === row.id &&
                    premiumMatchedPickDigest(lock) === row.lock_sha,
                "Changed training family or public lock",
            );
            // Do not trust a modified view to introduce held-out rows. Read only explicit train joins.
            const labels = db
                .query<
                    { arm: number; seat: number; future: number; candidate_score: number; incumbent_score: number },
                    [string]
                >(
                    `SELECT c.arm,c.seat,c.future,c.score candidate_score,b.score incumbent_score
                     FROM continuation c JOIN continuation b
                     ON b.family_id=c.family_id AND b.arm=0 AND b.seat=c.seat AND b.future=c.future
                     JOIN family f ON f.id=c.family_id
                     WHERE c.family_id=? AND c.arm>0 AND f.partition='train'
                     ORDER BY c.arm,c.seat,c.future`,
                )
                .all(row.id);
            requireValue(labels.length === family.combatSeeds.length * 4, "Incomplete training comparisons");
            const keys = new Set<string>();
            for (const label of labels) {
                const key = `${label.arm}:${label.seat}:${label.future}`;
                requireValue(
                    [1, 2].includes(label.arm) &&
                        [0, 1].includes(label.seat) &&
                        Number.isInteger(label.future) &&
                        label.future >= 0 &&
                        label.future < family.combatSeeds.length &&
                        [0, 0.5, 1].includes(label.candidate_score) &&
                        [0, 0.5, 1].includes(label.incumbent_score) &&
                        !keys.has(key),
                    "Invalid training comparison",
                );
                keys.add(key);
            }
            for (const arm of [1, 2])
                cases.push({
                    familyId: family.id,
                    input: {
                        view: publicView(lock.view),
                        ownTeam: lock.ownTeam,
                        incumbent: lock.incumbent,
                        alternative: lock.slate.creatureIds[arm],
                    },
                    targets: labels
                        .filter((label) => label.arm === arm)
                        .map((label) => ({
                            seat: label.seat,
                            future: label.future,
                            candidateScore: label.candidate_score,
                            incumbentScore: label.incumbent_score,
                            pairedGain: label.candidate_score - label.incumbent_score,
                            familyWeight: 1 / (4 * family.combatSeeds.length),
                        })),
                });
            comparisons += labels.length;
        }
        return {
            snapshotSha256: actualSha,
            sourceSha256: reg.sourceSha256,
            runtimeSha256: reg.runtimeSha256,
            profileSha256: reg.profileSha256,
            historicalModelCanonicalSha256: reg.historicalModelCanonicalSha256,
            trainingFamilies: training.length,
            comparisons,
            familyWeighting: "equal-total-weight-per-family" as const,
            cases,
        };
    } finally {
        db.close();
    }
}
