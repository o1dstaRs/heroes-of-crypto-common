import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";

/** Compare Meteorite impact groups in the engine instead of discarding all but the largest raw hit. */
export const BATTLE_MAGE_TARGET_POLICY = "battle-mage-impact-coverage-v1" as const;
export const V08_BATTLE_MAGE_TARGETS_ENV = "V08_BATTLE_MAGE_TARGETS" as const;

/** Live seat scope keeps root search, fallback and every continuation on the same policy in paired checks. */
export function battleMageTargetsEnabled(unit: Pick<Unit, "getName" | "getTeam">): boolean {
    if (unit.getName() !== "Battle Mage") return false;
    const gate = process.env[V08_BATTLE_MAGE_TARGETS_ENV];
    if (gate === "off") return false;
    if (gate === "green" || gate === "red") {
        return gate === (unit.getTeam() === PBTypes.TeamVals.LEFT ? "green" : "red");
    }
    return true;
}
