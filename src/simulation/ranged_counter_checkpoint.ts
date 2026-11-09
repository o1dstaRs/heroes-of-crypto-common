import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const LOCKED_RANGED_COUNTER_ID = "ranged-counter-promising-20261109";
export const LOCKED_RANGED_COUNTER_POLICIES = ["free-spread", "placement1-sniper"] as const;
export const LOCKED_RANGED_COUNTER_EVIDENCE_SHA256 = "834ccf859d581ed013268452bf2f0c4d519545a804decce042d1d37ab7f1ade6";

interface ILockedCounterEvidence {
    checkpointId: string;
    productionPromotion: false;
    completedBattles: number;
    independentBoards: number;
    retainedPolicies: string[];
    sourceFiles: { path: string; sha256: string }[];
    reservedNewChannels: number[];
    boardScores: {
        board: number;
        population: string;
        seed: number;
        opponent: string;
        scores: Record<string, number[]>;
    }[];
}

/** Immutable research references. Positive point estimates did not pass the original strength gates. */
export function lockedRangedCounterCheckpoint() {
    const bytes = readFileSync(new URL("../../docs/evidence/ranged_counter_20261109.json", import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== LOCKED_RANGED_COUNTER_EVIDENCE_SHA256)
        throw new Error("Locked ranged counter evidence changed");
    const evidence = JSON.parse(bytes.toString("utf8")) as ILockedCounterEvidence;
    if (
        evidence.checkpointId !== LOCKED_RANGED_COUNTER_ID ||
        evidence.productionPromotion !== false ||
        evidence.completedBattles !== 1512 ||
        evidence.independentBoards !== 54 ||
        evidence.retainedPolicies.join(",") !== LOCKED_RANGED_COUNTER_POLICIES.join(",")
    )
        throw new Error("Locked ranged counter research changed");
    for (const source of evidence.sourceFiles) {
        const actual = createHash("sha256")
            .update(readFileSync(new URL(`../../${source.path}`, import.meta.url)))
            .digest("hex");
        if (actual !== source.sha256) throw new Error(`Locked counter policy changed: ${source.path}`);
    }
    return evidence;
}
