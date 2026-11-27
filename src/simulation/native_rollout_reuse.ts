import type { INativePairRecord } from "./native_rollouts";

type Sample = readonly [
    uuid: number,
    summon: number,
    turns: number,
    value: number,
    material: number | null,
    winner: number,
];
type ReuseRow = readonly [pairIndex: number, ...sample: Sample];

/** One bot decision's completed native samples. Keep identity at the native wire representation. */
export class NativeRolloutReuse {
    private root: string | undefined;
    private policy: string | undefined;
    private readonly samples = new Map<string, Array<Sample | undefined>>();
    public prepare(
        root: string,
        policy: string,
        candidates: readonly { kind: string; actions: readonly unknown[] }[],
        rollouts: number,
        material: boolean,
    ) {
        if (root !== this.root || policy !== this.policy) {
            this.samples.clear();
            this.root = root;
            this.policy = policy;
        }
        const rows = candidates.map((candidate) => {
            const key = JSON.stringify(candidate);
            const old = this.samples.get(key);
            if (old) return old;
            const row: Array<Sample | undefined> = [];
            this.samples.set(key, row);
            return row;
        });
        const hints: ReuseRow[] = [];
        for (const [index, row] of rows.entries()) {
            for (let r = 0; r < Math.min(row.length, rollouts); r += 1) {
                const sample = row[r];
                if (sample) hints.push([index * rollouts + r, ...sample]);
            }
        }
        return {
            hints,
            remember(records: readonly INativePairRecord[], played: number, uuid: number, summon: number): void {
                for (const [index, record] of records.entries()) {
                    const row = rows[Math.floor(index / rollouts)];
                    if (!row) break;
                    // Keep only complete samples that allocated no IDs. The native loop checks
                    // these starting counters again at the exact point where the pair would run.
                    if (
                        record.flags === played &&
                        record.uuidSequence === uuid &&
                        record.summonSequence === summon &&
                        Number.isFinite(record.value) &&
                        !Object.is(record.value, -0) &&
                        (!material || (Number.isFinite(record.material) && !Object.is(record.material, -0)))
                    ) {
                        row[index % rollouts] = [
                            uuid,
                            summon,
                            record.turns,
                            record.value,
                            material ? record.material : null,
                            record.winner,
                        ];
                    }
                    uuid = record.uuidSequence;
                    summon = record.summonSequence;
                }
            },
        };
    }
}
