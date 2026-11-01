/** Producer-only correctness guard. Evaluation timing does not install this observer. */
import type { GameAction } from "../../engine/actions";
import type { FightProperties } from "../../fights/fight_properties";
import type { Grid } from "../../grid/grid";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import { captureDeterministicRandomState } from "../../utils/lib";
import { snapshotBattle } from "../battle_snapshot";
import { SearchDriver } from "../search_driver";
import { fingerprintV09 } from "./protocol";

interface IRootDriver {
    deps: { unitsHolder: UnitsHolder; grid: Grid; fightProperties: FightProperties; captureDamageStats(): unknown };
    chooseDecision(unit: Unit, ...args: unknown[]): GameAction[];
}

/** Canonical object graph retains shared edges; wall-clock bookkeeping is outside offline decisions. */
function witness(driver: IRootDriver): string {
    const { unitRefs: _refs, ...battle } = snapshotBattle(
        driver.deps.unitsHolder,
        driver.deps.grid,
        driver.deps.fightProperties,
    );
    void _refs;
    const seen = new Map<object, number>();
    const clocks = new Set(["currentTurnStart", "currentTurnEnd", "currentLapTotalTimePerTeam"]);
    const visit = (value: unknown): unknown => {
        if (value === undefined) return ["undefined"];
        if (typeof value === "function") return ["function", value.name];
        if (typeof value === "bigint" || typeof value === "symbol") return [typeof value, String(value)];
        if (typeof value === "number" && !Number.isFinite(value)) return ["number", String(value)];
        if (value === null || typeof value !== "object") return value;
        if (seen.has(value)) return ["ref", seen.get(value)];
        const id = seen.size;
        seen.set(value, id);
        if (value instanceof Map) return ["map", id, [...value].map(([key, item]) => [visit(key), visit(item)])];
        if (value instanceof Set) return ["set", id, [...value].map(visit)];
        if (ArrayBuffer.isView(value))
            return [value.constructor.name, id, Array.from(value as unknown as ArrayLike<number>)];
        if (Array.isArray(value))
            return [
                "array",
                id,
                Array.from({ length: value.length }, (_, i) => (i in value ? visit(value[i]) : ["hole"])),
            ];
        return [
            Object.getPrototypeOf(value)?.constructor?.name ?? "null",
            id,
            Object.keys(value)
                .sort()
                .filter((key) => !clocks.has(key))
                .map((key) => [key, visit((value as Record<string, unknown>)[key])]),
        ];
    };
    return fingerprintV09(visit({ ...battle, damageStats: driver.deps.captureDamageStats() }));
}

/** A broken root aborts the board before any labels can be accepted or a GPU fit can qualify. */
export function withV09RootRestoreAudit<T>(run: () => T): { value: T; checks: number } {
    const prototype = SearchDriver.prototype as unknown as IRootDriver;
    const native = prototype.chooseDecision;
    let checks = 0;
    prototype.chooseDecision = function (...args) {
        const units = [...this.deps.unitsHolder.getAllUnits()];
        const random = captureDeterministicRandomState();
        const before = witness(this);
        const chosen = native.apply(this, args);
        const afterRandom = captureDeterministicRandomState();
        const afterUnits = [...this.deps.unitsHolder.getAllUnits()];
        if (
            random.source !== afterRandom.source ||
            random.uuidSequence !== afterRandom.uuidSequence ||
            units.length !== afterUnits.length ||
            units.some(([id, unit], i) => id !== afterUnits[i][0] || unit !== afterUnits[i][1]) ||
            before !== witness(this)
        )
            throw new Error("A19 producer root restoration failed; board rejected and GPU admission blocked");
        checks++;
        return chosen;
    };
    try {
        return { value: run(), checks };
    } finally {
        prototype.chooseDecision = native;
    }
}
