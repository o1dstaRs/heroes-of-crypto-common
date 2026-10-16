import {
    captureUnitHpChanges,
    unitVitalState,
    type IUnitHpChange,
    type IUnitVitalState,
    type IHpObservableUnit,
} from "../units/hp_change_capture";
import type { GameEvent } from "../engine/events";

export const PREMIUM_HEALTH_LEDGER_SCHEMA = "premium-health-ledger-v1";
export const PREMIUM_HEALTH_METRICS = {
    damageHp: "Actual HP removed by damage calls from drafted stacks, including retaliation",
    healingHp: "Actual HP restored by heal calls to drafted stacks",
    resurrectionHp: "Actual HP restored by resurrection calls to drafted stacks",
    regenerationHp: "Actual HP restored by Wild Regeneration at activation",
    damageHpWithSource: "Damage received with an explicitly recorded source unit",
    damageHpWithoutSource: "Damage received whose source was not supplied by the engine caller",
    zeroChangeDamageCalls: "Positive damage requests that changed no HP; not automatically a dodge or absorb",
    hpGainOutsideFunnels: "HP gained outside these funnels, including capacity/quantity changes; not labeled healing",
    hpLossOutsideFunnels: "HP lost outside these funnels, including capacity/quantity changes; not labeled damage",
} as const;
export const PREMIUM_HEALTH_UNIT_METRICS_SCHEMA = "premium-health-unit-metrics-v2";
export const PREMIUM_HEALTH_UNIT_METRICS = {
    ...PREMIUM_HEALTH_METRICS,
    damageDealtHpWithSource:
        "Actual HP removed by damage calls explicitly attributed to these drafted stacks, including retaliation",
    lethalDamageCallsWithSource:
        "Explicitly attributed damage calls that reduced a living stack to zero; not prevented deaths or unique enemy creatures",
} as const;
export interface IPremiumHealthFrame {
    unitId: string;
    team: number;
    before: IUnitVitalState | null;
    after: IUnitVitalState;
    presentAfter: boolean;
    /** Null for newly created stacks whose pre-creation state was not a living unit. */
    netHpChange: number | null;
    observedHpChange: number;
    /** Captures direct stat/quantity changes too; it must not be silently called healing or damage. */
    hpChangeOutsideFunnels: number | null;
}
export interface IPremiumHealthObservation {
    schema: typeof PREMIUM_HEALTH_LEDGER_SCHEMA;
    lap: number;
    operation: string;
    completed: boolean;
    eventTypes: string[];
    changes: IUnitHpChange[];
    frames: IPremiumHealthFrame[];
}

export function observeCommittedHealth<T extends { events: GameEvent[]; completed?: boolean }>(
    units: () => ReadonlyMap<string, IHpObservableUnit>,
    lap: () => number,
    operation: string,
    apply: () => T,
): { value: T; observation: IPremiumHealthObservation } {
    const beforeUnits = new Map(units());
    const before = new Map([...beforeUnits].map(([id, unit]) => [id, unitVitalState(unit)]));
    const { value, changes } = captureUnitHpChanges(apply);
    const afterUnits = units();
    const ids = new Set([...before.keys(), ...afterUnits.keys(), ...changes.map((change) => change.unitId)]);
    const frames: IPremiumHealthFrame[] = [];
    for (const unitId of ids) {
        const prior = before.get(unitId) ?? null;
        const actualUnit = afterUnits.get(unitId) ?? beforeUnits.get(unitId);
        const observations = changes.filter((change) => change.unitId === unitId);
        const last = observations.at(-1);
        const after = actualUnit ? unitVitalState(actualUnit) : last!.after;
        const presentAfter = afterUnits.has(unitId);
        if (prior && presentAfter && !observations.length && JSON.stringify(prior) === JSON.stringify(after)) continue;
        const netHpChange = prior ? after.hp - prior.hp : null;
        const observedHpChange = observations.reduce((sum, change) => sum + change.after.hp - change.before.hp, 0);
        frames.push({
            unitId,
            team: actualUnit?.getTeam() ?? last!.team,
            before: prior,
            after,
            presentAfter,
            netHpChange,
            observedHpChange,
            hpChangeOutsideFunnels: netHpChange === null ? null : netHpChange - observedHpChange,
        });
    }
    return {
        value,
        observation: {
            schema: PREMIUM_HEALTH_LEDGER_SCHEMA,
            lap: lap(),
            operation,
            completed: value.completed !== false,
            eventTypes: value.events.map((event) => event.type),
            changes,
            frames,
        },
    };
}

export function summarizePremiumHealth(observations: readonly IPremiumHealthObservation[]) {
    const totals = {
        operations: observations.length,
        damageHp: 0,
        healingHp: 0,
        resurrectionHp: 0,
        regenerationHp: 0,
        damageHpWithSource: 0,
        damageHpWithoutSource: 0,
        zeroChangeDamageCalls: 0,
        hpGainOutsideFunnels: 0,
        hpLossOutsideFunnels: 0,
        createdStacks: 0,
        removedStacks: 0,
    };
    for (const observation of observations) {
        for (const change of observation.changes) {
            const difference = change.after.hp - change.before.hp;
            if (change.kind === "damage") {
                const damage = Math.max(0, -difference);
                totals.damageHp += damage;
                totals[change.sourceUnitId ? "damageHpWithSource" : "damageHpWithoutSource"] += damage;
                totals.zeroChangeDamageCalls += Number(difference === 0 && change.requestedHp > 0);
            } else
                totals[
                    change.kind === "heal"
                        ? "healingHp"
                        : change.kind === "resurrection"
                          ? "resurrectionHp"
                          : "regenerationHp"
                ] += Math.max(0, difference);
        }
        for (const frame of observation.frames) {
            totals.hpGainOutsideFunnels += Math.max(0, frame.hpChangeOutsideFunnels ?? 0);
            totals.hpLossOutsideFunnels += Math.max(0, -(frame.hpChangeOutsideFunnels ?? 0));
            totals.createdStacks += Number(frame.before === null);
            totals.removedStacks += Number(!frame.presentAfter);
        }
    }
    return totals;
}

/** Physical drafted stacks, including split children; merged reinforcements cannot be separated. */
export function summarizePremiumUnitHealth(
    observations: readonly IPremiumHealthObservation[],
    unitIds: ReadonlySet<string>,
) {
    const result = {
        ...summarizePremiumHealth(
            observations.map((row) => ({
                ...row,
                changes: row.changes.filter((change) => unitIds.has(change.unitId)),
                frames: row.frames.filter((frame) => unitIds.has(frame.unitId)),
            })),
        ),
        damageDealtHpWithSource: 0,
        lethalDamageCallsWithSource: 0,
    };
    for (const row of observations)
        for (const change of row.changes) {
            if (change.kind !== "damage" || !change.sourceUnitId || !unitIds.has(change.sourceUnitId)) continue;
            result.damageDealtHpWithSource += Math.max(0, change.before.hp - change.after.hp);
            result.lethalDamageCallsWithSource += Number(change.before.hp > 0 && change.after.hp === 0);
        }
    return result;
}

export function validatePremiumHealthLedger(
    observations: readonly IPremiumHealthObservation[],
    eventBatches: readonly { events: readonly GameEvent[] }[],
) {
    const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
    const validState = (state: IUnitVitalState) =>
        state && [state.hp, state.maxHp, state.amount].every((value) => Number.isFinite(value) && value >= 0);
    if (
        JSON.stringify(observations.flatMap((row) => row.eventTypes)) !==
        JSON.stringify(eventBatches.flatMap((batch) => batch.events.map((event) => event.type)))
    )
        throw new Error("Premium health ledger does not match committed event boundaries");
    const lastStates = new Map<string, IUnitVitalState>();
    for (const row of observations) {
        if (
            row.schema !== PREMIUM_HEALTH_LEDGER_SCHEMA ||
            !Number.isSafeInteger(row.lap) ||
            row.lap < 0 ||
            typeof row.operation !== "string" ||
            !row.operation ||
            typeof row.completed !== "boolean" ||
            !Array.isArray(row.changes) ||
            !Array.isArray(row.frames) ||
            new Set(row.frames.map((frame) => frame.unitId)).size !== row.frames.length
        )
            throw new Error("Invalid Premium health ledger envelope");
        const totals = new Map<string, number>();
        for (const change of row.changes) {
            if (
                !validState(change.before) ||
                !validState(change.after) ||
                !Number.isFinite(change.requestedHp) ||
                !["damage", "heal", "resurrection", "regeneration"].includes(change.kind) ||
                !change.unitId
            )
                throw new Error("Invalid Premium health change");
            totals.set(change.unitId, (totals.get(change.unitId) ?? 0) + change.after.hp - change.before.hp);
        }
        for (const frame of row.frames) {
            if (
                !validState(frame.after) ||
                (frame.before && !validState(frame.before)) ||
                !frame.unitId ||
                typeof frame.presentAfter !== "boolean" ||
                !close(frame.observedHpChange, totals.get(frame.unitId) ?? 0) ||
                (frame.before
                    ? !close(frame.netHpChange!, frame.after.hp - frame.before.hp) ||
                      !close(frame.hpChangeOutsideFunnels!, frame.netHpChange! - frame.observedHpChange)
                    : frame.netHpChange !== null || frame.hpChangeOutsideFunnels !== null)
            )
                throw new Error("Premium health ledger reconciliation mismatch");
            const prior = lastStates.get(frame.unitId);
            if (
                prior &&
                frame.before &&
                (!close(prior.hp, frame.before.hp) ||
                    !close(prior.maxHp, frame.before.maxHp) ||
                    !close(prior.amount, frame.before.amount))
            )
                throw new Error("Premium health ledger has a gap between committed observations");
            lastStates.set(frame.unitId, frame.after);
            totals.delete(frame.unitId);
        }
        if (totals.size) throw new Error("Premium health ledger missing unit frames");
    }
}
