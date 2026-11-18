import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IContextualDraftContext } from "./contextual_draft_research";

export const LOCKED_REVEALED_RANGED_CHECKPOINTS = [
    "revealed-ranged-draft-only-20261117",
    "revealed-ranged-setup-only-20261117",
] as const;
const seals = {
    registration: "95ceaffea72a109fe6d37d828fd2a6f3147da34ce7f2b17f15f071fe6dd7d933",
    result: "c5309e96805bbfa253d4a1d4c351cc8e1341f806ca486dbe08a3e7cdb7dd9e92",
} as const;
type Arm = "native" | "draft" | "setup" | "combined" | "free";
interface IRegistration {
    registrationSha256: string;
    registrationText: string;
    baseline: { common: string; server: string };
    reservedScannedPreimages: number[];
    runtimeSources: Record<string, { sha256: string; text: string }>;
}
interface IResult {
    status: "closed-failed-no-promotion";
    analysis: {
        families: number;
        logicalBattles: number;
        contrasts: Record<string, { differencePp: number; simultaneous95IntervalPp: number[] }>;
    };
    verifiedResults: {
        rows: {
            id: string;
            task: { id: string; d1: number; map: number };
            seat: number;
            scores: Record<Arm, number>;
            proposal: {
                native: number;
                available: number[];
                context: IContextualDraftContext;
                pool: number[];
                consumedBefore: boolean;
                variants: IContextualDraftContext["synergyVariants"];
            };
        }[];
    };
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Immutable original estimates; subsequent explicit adoption does not rewrite failed statistical gates. */
export function lockedRevealedRangedDeliveryCheckpoints() {
    const bytes = (kind: keyof typeof seals) => {
        const value = readFileSync(
            new URL(`../../docs/evidence/revealed_ranged_delivery_${kind}_20261117.json`, import.meta.url),
        );
        if (hash(value) !== seals[kind]) throw new Error(`Locked revealed-ranged ${kind} changed`);
        return value.toString("utf8");
    };
    const registration = JSON.parse(bytes("registration")) as IRegistration;
    const result = JSON.parse(bytes("result")) as IResult;
    if (
        hash(registration.registrationText) !== registration.registrationSha256 ||
        result.status !== "closed-failed-no-promotion" ||
        result.analysis.families !== 27 ||
        result.analysis.logicalBattles !== 270 ||
        result.verifiedResults.rows.length !== 54 ||
        registration.reservedScannedPreimages.length !== 20480
    )
        throw new Error("Locked revealed-ranged contract changed");
    for (const [file, source] of Object.entries(registration.runtimeSources))
        if (hash(source.text) !== source.sha256) throw new Error(`Locked revealed-ranged source changed: ${file}`);
    return {
        checkpointIds: LOCKED_REVEALED_RANGED_CHECKPOINTS,
        registration,
        result,
        draftOnly: {
            arm: "draft" as const,
            setup: "native" as const,
            evidence: result.analysis.contrasts["draft-native"],
        },
        setupOnly: {
            arm: "setup" as const,
            draft: "native" as const,
            evidence: result.analysis.contrasts["setup-native"],
        },
        rejectedCombination: result.analysis.contrasts["combined-native"],
    };
}
