import type { IAiMetaPairRecord } from "./ai_meta_cohorts_core";

export interface IAiMetaDoctrineRow {
    cohort: string;
    map: string | number;
    ownDoctrine: number;
    opponentDoctrine: number | "all";
    families: number;
    assignments: number;
    armyOutcomes: number;
    wins: number;
    draws: number;
    losses: number;
    scoreRate: number | null;
    ciLow: number;
    ciHigh: number;
}

export class AiMetaDoctrineCollector {
    private readonly tallies = new Map<string, IAiMetaDoctrineRow & { squaredFamilyWeight: number }>();
    public add(record: IAiMetaPairRecord): void {
        const groups = new Map<
            string,
            { row: IAiMetaDoctrineRow & { squaredFamilyWeight: number }; assignments: number }
        >();
        const maps = ["all", record.map, ...([1, 3, 4].includes(record.map) ? ["live"] : [])];
        for (const cohort of ["all", record.cohort])
            for (const map of maps) {
                for (const ownDoctrine of [1, 2, 3])
                    for (const opponentDoctrine of ["all", 1, 2, 3] as const) {
                        const key = JSON.stringify([cohort, map, ownDoctrine, opponentDoctrine]);
                        if (!this.tallies.has(key))
                            this.tallies.set(key, {
                                cohort,
                                map,
                                ownDoctrine,
                                opponentDoctrine,
                                families: 0,
                                assignments: 0,
                                armyOutcomes: 0,
                                wins: 0,
                                draws: 0,
                                losses: 0,
                                scoreRate: null,
                                ciLow: 0,
                                ciHigh: 1,
                                squaredFamilyWeight: 0,
                            });
                    }
                for (const [side, own, opponent] of [
                    ["a", record.armyA, record.armyB],
                    ["b", record.armyB, record.armyA],
                ] as const) {
                    for (const enemy of ["all", opponent.doctrine]) {
                        const key = JSON.stringify([cohort, map, own.doctrine, enemy]);
                        const row = this.tallies.get(key);
                        if (!row) throw new Error("Unknown doctrine in meta record");
                        const group = groups.get(key) ?? { row, assignments: 0 };
                        group.assignments++;
                        groups.set(key, group);
                        row.assignments++;
                        for (const game of record.games) {
                            row.armyOutcomes++;
                            if (game.winner === "draw") row.draws++;
                            else if (game.winner === side) row.wins++;
                            else row.losses++;
                        }
                    }
                }
            }
        for (const { row, assignments } of groups.values()) {
            row.families++;
            row.squaredFamilyWeight += assignments * assignments;
        }
    }
    public result() {
        return {
            schema: "ai-meta-doctrines-v1" as const,
            uncertainty: "weighted-whole-family-Hoeffding-95" as const,
            countScope: "army outcomes: both armies observed in each physical fight" as const,
            rows: [...this.tallies.values()].map(({ squaredFamilyWeight, ...row }) => {
                const score = row.armyOutcomes ? (row.wins + 0.5 * row.draws) / row.armyOutcomes : null;
                const radius = row.assignments
                    ? Math.sqrt((Math.log(40) * squaredFamilyWeight) / (2 * row.assignments ** 2))
                    : 1;
                return {
                    ...row,
                    scoreRate: score,
                    ciLow: score === null ? 0 : Math.max(0, score - radius),
                    ciHigh: score === null ? 1 : Math.min(1, score + radius),
                };
            }),
        };
    }
}
