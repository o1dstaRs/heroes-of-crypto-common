/** Offline harness adapter; never imported by serving code. */
import type { IEnumeratedCandidate } from "../ai/candidates";
import { nightmareWallOpportunityAllowed } from "./nightmare_route_preservation_research";

/**
 * SearchDriver's material evidence retains the returned score array by reference. Mask that SAME
 * array so subsequent material arbitration and final neural correction share the selection decision.
 * Keep an independent raw-forecast copy for audits; only the added wall's eligibility may change.
 */
export function applyNightmareWallOpportunityGate(
    candidates: readonly IEnumeratedCandidate[],
    selectionMeans: number[],
    completed: readonly number[],
    wallIndex: number,
): { allowed: boolean; rawMeans: number[] } {
    if (
        !Number.isInteger(wallIndex) ||
        wallIndex < 0 ||
        wallIndex >= candidates.length ||
        selectionMeans.length !== candidates.length ||
        completed.length !== candidates.length
    )
        throw new Error("Invalid Nightmare wall selection evidence");
    const rawMeans = [...selectionMeans];
    const allowed = nightmareWallOpportunityAllowed(candidates, rawMeans, completed, wallIndex);
    if (!allowed) selectionMeans[wallIndex] = -Infinity;
    return { allowed, rawMeans };
}
