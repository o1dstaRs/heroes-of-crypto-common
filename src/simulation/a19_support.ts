import type { IDecisionContext } from "../ai/ai_strategy";
import { chooseA19SatyrContactDecision } from "../ai/satyr_contact_support";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import type { ILookaheadDeps } from "./lookahead";
import { SearchRollbackError, type SearchDriver } from "./search_driver";

const attached = new WeakSet<SearchDriver>();

/** Match-local outer layer, after neural correction. Never patches a global prototype. */
export function attachA19SupportDecision(driver: SearchDriver, deps: ILookaheadDeps, offline: boolean): SearchDriver {
    if (attached.has(driver)) return driver;
    const choose = driver.chooseDecision;
    driver.chooseDecision = function (
        unit: Unit,
        version: string,
        incumbent: GameAction[],
        context?: IDecisionContext,
    ) {
        const selected = choose.call(this, unit, version, incumbent, context);
        if (version !== "v0.8" || unit.getName() !== "Satyr" || !context || !this.appliesTo(version, unit.getTeam()))
            return selected;
        const started = context.decisionStartedAtMs;
        if (!offline && (started === undefined || !Number.isFinite(started) || started > performance.now()))
            return selected;
        const deadlineAt = offline ? null : started! + 1000;
        try {
            const result = chooseA19SatyrContactDecision(unit, context, selected, deps, deadlineAt);
            return deadlineAt !== null && performance.now() >= deadlineAt ? selected : result.actions;
        } catch (error) {
            if (error instanceof SearchRollbackError) throw error;
            return selected;
        }
    };
    attached.add(driver);
    return driver;
}
