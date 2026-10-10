/** Optional synchronous research instrumentation. No RNG, game events or state mutations. */
export interface IHpObservableUnit {
    getId(): string;
    getName(): string;
    getTeam(): number;
    getCumulativeHp(): number;
    getMaxHp(): number;
    getAmountAlive(): number;
}
export interface IUnitVitalState {
    hp: number;
    maxHp: number;
    amount: number;
}
export interface IUnitHpChange {
    unitId: string;
    name: string;
    team: number;
    kind: "damage" | "heal" | "resurrection" | "regeneration";
    requestedHp: number;
    sourceUnitId: string | null;
    before: IUnitVitalState;
    after: IUnitVitalState;
}
let sink: ((change: IUnitHpChange) => void) | undefined;
export const unitVitalState = (unit: IHpObservableUnit): IUnitVitalState => ({
    hp: unit.getCumulativeHp(),
    maxHp: unit.getMaxHp(),
    amount: unit.getAmountAlive(),
});

/** The returned closure must run in finally, including blocked/zero-effect calls. */
export function observeUnitHpChange(
    unit: IHpObservableUnit,
    kind: IUnitHpChange["kind"],
    requestedHp: number,
    source?: IHpObservableUnit,
): (() => void) | undefined {
    if (!sink) return undefined;
    const emit = sink,
        before = unitVitalState(unit);
    return () =>
        emit({
            unitId: unit.getId(),
            name: unit.getName(),
            team: unit.getTeam(),
            kind,
            requestedHp,
            sourceUnitId: source?.getId() ?? null,
            before,
            after: unitVitalState(unit),
        });
}

/** Capture a single committed operation; nesting and exceptions restore the previous observer. */
export function captureUnitHpChanges<T>(operation: () => T): { value: T; changes: IUnitHpChange[] } {
    const previous = sink,
        changes: IUnitHpChange[] = [];
    sink = (change) => changes.push(change);
    try {
        return { value: operation(), changes };
    } finally {
        sink = previous;
    }
}
