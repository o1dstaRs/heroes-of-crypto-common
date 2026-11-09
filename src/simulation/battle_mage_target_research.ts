/** Isolated synchronous research only. Importing this module does not change the default AI. */
import { V08_BATTLE_MAGE_TARGETS_ENV } from "../ai/battle_mage_targets";
import { StrategyV0_8 } from "../ai/versions/v0_8";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { withScopedAIEnvironment } from "./v0_8_a13_search";

export const BATTLE_MAGE_LEGACY_ROLLOUT_RESEARCH_ID = "battle-mage-root-coverage-legacy-rollouts-v1" as const;
let active = false;

/**
 * Keep the accepted target coverage on actual turns and A19 root enumeration, but use the former native
 * Meteorite choice for this team's simulated Mage continuations. The opponent, other actors, root fallback,
 * search budget and weights are unchanged. One isolated worker only; never wrap an asynchronous server.
 */
export function withBattleMageLegacyRollouts<T>(team: TeamType, run: () => T, onLegacyRollout?: () => void): T {
    if (active) throw new Error("Battle Mage rollout research cannot be nested");
    if (team !== PBTypes.TeamVals.LEFT && team !== PBTypes.TeamVals.RIGHT)
        throw new Error("Battle Mage rollout research requires a physical team");
    const previous = StrategyV0_8.prototype.decideTurn;
    active = true;
    StrategyV0_8.prototype.decideTurn = function (unit, context) {
        if (
            this.version !== "v0.8" ||
            unit.getTeam() !== team ||
            unit.getName() !== "Battle Mage" ||
            context.decisionOrigin !== "rollout"
        )
            return previous.call(this, unit, context);
        return withScopedAIEnvironment({ [V08_BATTLE_MAGE_TARGETS_ENV]: "off" }, () => {
            onLegacyRollout?.();
            return previous.call(this, unit, context);
        });
    };
    try {
        const result = run();
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Battle Mage rollout research requires a synchronous callback");
        return result;
    } finally {
        StrategyV0_8.prototype.decideTurn = previous;
        active = false;
    }
}
