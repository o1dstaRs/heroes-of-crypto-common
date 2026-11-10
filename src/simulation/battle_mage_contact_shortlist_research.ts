/** Offline-only follow-up to the failed eight-choice Battle Mage study. Importing is inert. */
import type { IEnumeratedCandidate } from "../ai/candidates";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { SearchDriver } from "./search_driver";

export const BATTLE_MAGE_CONTACT_SHORTLIST_ID = "battle-mage-contact-shortlist6-v1" as const;
type ContactUnit = Pick<
    Unit,
    | "getId"
    | "getTeam"
    | "getCells"
    | "getAmountAlive"
    | "getCumulativeHp"
    | "getAttackDamageMin"
    | "getAttackDamageMax"
>;
export interface IMageContactReservation {
    removedIndex: number;
    addedIndex: number;
    adjacentAllies: number;
    pressureProxy: number;
}

/**
 * Reserve one omitted legal Fire Strike on an enemy already touching a friendly footprint. Replace only
 * the last nonlethal Meteorite finalist; preserve the incumbent, all lethal choices and the six-slot cap.
 * The pressure proxy is a shortlist heuristic, not an exact prevented-damage estimate or a forced cast.
 */
export function reserveMageContactSpell(
    actor: Pick<Unit, "getTeam">,
    units: ReadonlyMap<string, ContactUnit>,
    candidates: readonly IEnumeratedCandidate[],
    original: readonly IEnumeratedCandidate[],
    observe?: (reservation: IMageContactReservation) => void,
): readonly IEnumeratedCandidate[] {
    if (original.length !== 6 || original[0] !== candidates[0]) return original;
    let replace = -1;
    for (let i = original.length - 1; i > 0; i--) {
        if (
            original[i].features.expectedKill === 0 &&
            original[i].actions.some((a) => a.type === "cast_spell" && a.spellName === "Meteorite")
        ) {
            replace = i;
            break;
        }
    }
    if (replace < 0) return original;
    let best: IEnumeratedCandidate | undefined;
    let bestProxy = 0;
    let bestContacts = 0;
    for (const candidate of candidates) {
        if (original.includes(candidate) || candidate.features.expectedDamage <= 0) continue;
        const cast = candidate.actions.find((a) => a.type === "cast_spell" && a.spellName === "Fire Strike");
        if (cast?.type !== "cast_spell" || !cast.targetId) continue;
        // Candidate generation already enforces visible, legal targets; never manufacture a hidden target.
        const target = units.get(cast.targetId);
        if (!target || target.getTeam() === actor.getTeam() || target.getCumulativeHp() <= 0) continue;
        let contacts = 0;
        for (const ally of units.values()) {
            if (ally.getTeam() !== actor.getTeam() || ally.getAmountAlive() <= 0) continue;
            if (
                target
                    .getCells()
                    .some((enemyCell) =>
                        ally
                            .getCells()
                            .some(
                                (cell) =>
                                    Math.max(Math.abs(cell.x - enemyCell.x), Math.abs(cell.y - enemyCell.y)) === 1,
                            ),
                    )
            )
                contacts++;
        }
        if (!contacts) continue;
        const fraction = Math.min(1, candidate.features.expectedDamage / target.getCumulativeHp());
        const proxy =
            ((fraction * target.getAmountAlive() * (target.getAttackDamageMin() + target.getAttackDamageMax())) / 2) *
            contacts;
        if (Number.isFinite(proxy) && proxy > bestProxy) {
            best = candidate;
            bestProxy = proxy;
            bestContacts = contacts;
        }
    }
    if (!best) return original;
    const result = original.slice();
    result[replace] = best;
    observe?.({
        removedIndex: candidates.indexOf(original[replace]),
        addedIndex: candidates.indexOf(best),
        adjacentAllies: bestContacts,
        pressureProxy: bestProxy,
    });
    return result;
}

type ResearchDriver = {
    deps: { unitsHolder: { getAllUnits(): ReadonlyMap<string, Unit> } };
};
type ShortlistMethod = (
    this: ResearchDriver,
    unit: Unit,
    candidates: readonly IEnumeratedCandidate[],
    seed: number,
    deadline: number | null,
    version: string,
    ...flags: boolean[]
) => readonly IEnumeratedCandidate[];
let active = false;
export function withMageContactShortlistResearch<T>(
    team: TeamType | null,
    run: () => T,
    observe?: (reservation: IMageContactReservation & { unitId: string; team: TeamType }) => void,
): T {
    if (active) throw new Error("Mage contact research cannot be nested");
    if (team !== null && team !== PBTypes.TeamVals.LEFT && team !== PBTypes.TeamVals.RIGHT)
        throw new Error("Mage contact research requires a physical team or null");
    const prototype = SearchDriver.prototype as unknown as { shortlistCandidates: ShortlistMethod };
    const original = prototype.shortlistCandidates;
    active = true;
    prototype.shortlistCandidates = function (unit, candidates, seed, deadline, version, ...flags) {
        const result = original.call(this, unit, candidates, seed, deadline, version, ...flags);
        if (team === null || unit.getTeam() !== team || unit.getName() !== "Battle Mage" || version !== "v0.8")
            return result;
        return reserveMageContactSpell(unit, this.deps.unitsHolder.getAllUnits(), candidates, result, (reservation) =>
            observe?.({ ...reservation, unitId: unit.getId(), team: unit.getTeam() }),
        );
    };
    try {
        const result = run();
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Mage contact research requires a synchronous callback");
        return result;
    } finally {
        prototype.shortlistCandidates = original;
        active = false;
    }
}
