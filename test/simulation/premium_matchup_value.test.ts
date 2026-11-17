import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    createDraftMatchupValue,
    draftMatchupFeatures,
    type IDraftMatchupModel,
} from "../../src/ai/setup/draft_matchup_value";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { createHistoricalFinalPickAdvisor, type IHistoricalFinalPickView } from "../../src/ai/setup/draft_matchup_pick";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    PREMIUM_SNAPSHOT_SCHEMA,
    PREMIUM_SNAPSHOT_SQL,
    PremiumEvidenceSnapshot,
} from "../../src/simulation/premium_evidence_snapshot";

const a = CreatureLevelList[1].slice(0, 3);
const b = CreatureLevelList[2].slice(0, 3);
const input = { ownCreatureIds: a, opponentCreatureIds: b, ownDoctrine: 2, map: 1 };
const source = "a".repeat(64);

describe("historical matchup value", () => {
    it("limits advice to legal complete-information final picks and preserves the view and incumbent on ties", () => {
        const own = [...CreatureLevelList[1].slice(0, 2), ...CreatureLevelList[2].slice(0, 2), CreatureLevelList[3][0]];
        const enemy = [
            ...CreatureLevelList[1].slice(2, 4),
            ...CreatureLevelList[2].slice(2, 4),
            CreatureLevelList[3][1],
            CreatureLevelList[4][0],
        ];
        const available = CreatureLevelList[4].slice(1);
        const view: IHistoricalFinalPickView = {
            phaseSequence: 10,
            phase: PBTypes.PickPhaseVals.PICK,
            actors: [PBTypes.TeamVals.LEFT],
            requiredCreatureLevel: 4,
            complete: false,
            creaturesBanned: [],
            creaturesPicked: own,
            knownOpponentCreatures: enemy,
            doctrine: 2,
            bundles: [],
            tier2Offers: [],
            artifacts: [],
            availableCreatureIds: available,
            revealedMap: 1,
        };
        const model: IDraftMatchupModel = {
            schema: "draft-matchup-value-v1",
            recipe: "interactions",
            sourceSha256: source,
            snapshotSha256: source,
            trainingFamilies: 10,
            weights: { [`unit:${available[1]}`]: 0.1 },
        };
        const advise = createHistoricalFinalPickAdvisor(model);
        const before = JSON.stringify(view);
        expect(advise(view, PBTypes.TeamVals.LEFT, available[0])?.selectedCreatureId).toBe(available[1]);
        expect(advise(view, PBTypes.TeamVals.LEFT, available[1])?.changed).toBe(false);
        expect(
            createHistoricalFinalPickAdvisor({ ...model, weights: {} })(view, PBTypes.TeamVals.LEFT, available[0])
                ?.changed,
        ).toBe(false);
        expect(
            advise({ ...view, knownOpponentCreatures: enemy.slice(0, 3) }, PBTypes.TeamVals.LEFT, available[0]),
        ).toBeNull();
        expect(advise({ ...view, phaseSequence: 9 }, PBTypes.TeamVals.LEFT, available[0])).toBeNull();
        expect(
            advise({ ...view, availableCreatureIds: available.slice(0, 2) }, PBTypes.TeamVals.LEFT, available[0]),
        ).toBeNull();
        expect(advise(view, PBTypes.TeamVals.RIGHT, available[0])).toBeNull();
        expect(JSON.stringify(view)).toBe(before);
    });
    it("encodes army and counter interactions with side symmetry and no hidden context", () => {
        const full = draftMatchupFeatures(input, true);
        const reversed = draftMatchupFeatures({ ...input, ownCreatureIds: b, opponentCreatureIds: a }, true);
        for (const [key, value] of Object.entries(full))
            expect(reversed[key]).toBe(key === "doctrine:2" ? value : -value);
        expect(draftMatchupFeatures({ ...input, ownCreatureIds: [...a].reverse() }, true)).toEqual(full);
        expect(draftMatchupFeatures({ ...input, enemyDoctrine: 3, enemyArtifact: 99 } as typeof input, true)).toEqual(
            full,
        );
        expect(
            Object.keys(draftMatchupFeatures(input, false)).some(
                (key) => key.startsWith("counter:") || key.startsWith("ally:"),
            ),
        ).toBe(false);
        const shared = draftMatchupFeatures({ ...input, opponentCreatureIds: a }, true);
        expect(shared).toEqual({ "doctrine:2": 1 });
    });

    it("compiles finite immutable weights and declines malformed rosters", () => {
        const model: IDraftMatchupModel = {
            schema: "draft-matchup-value-v1",
            recipe: "interactions",
            sourceSha256: source,
            snapshotSha256: source,
            trainingFamilies: 10,
            weights: { [`unit:${a[0]}`]: 0.2 },
        };
        const score = createDraftMatchupValue(model);
        expect(score(input)).toBe(0.7);
        model.weights[`unit:${a[0]}`] = -1;
        expect(score(input)).toBe(0.7);
        expect(score({ ...input, map: 1000 })).toBeNull();
        expect(score({ ...input, ownCreatureIds: [a[0], a[0]] })).toBeNull();
        expect(score({ ...input, ownCreatureIds: [999999] })).toBeNull();
        expect(() => createDraftMatchupValue({ ...model, weights: { invalid: NaN } })).toThrow();
    });

    it("exports complete paired training families and never reads poisoned held-out outcomes", () => {
        const dir = mkdtempSync(join(tmpdir(), "hoc-matchup-test-"));
        const file = join(dir, "snapshot.sqlite");
        try {
            const db = new Database(file);
            db.exec(PREMIUM_SNAPSHOT_SQL);
            db.query("INSERT INTO metadata VALUES ('manifest',?)").run(
                JSON.stringify({
                    schema: PREMIUM_SNAPSHOT_SCHEMA,
                    snapshotId: "test",
                    sourceSha256: source,
                    studyProfile: "premium-ranked-v3",
                    status: "development",
                }),
            );
            db.query("INSERT INTO source VALUES (1,'fixture',?,3)").run(source);
            for (const [index, partition] of ["train", "validation", "test"].entries()) {
                db.query("INSERT INTO family VALUES (?,?,?,?,?,?,?)").run(
                    `f${index}`,
                    "ranked-draft",
                    index,
                    1,
                    partition,
                    1,
                    index,
                );
                for (const [side, units] of [
                    ["a", a],
                    ["b", b],
                ] as const) {
                    const id = index * 2 + (side === "a" ? 1 : 2);
                    db.query("INSERT INTO army VALUES (?,?,?,?,?,?,?,?)").run(
                        id,
                        `f${index}`,
                        side,
                        partition !== "train" ? 1 : side === "a" ? 0.75 : 0.25,
                        2,
                        0,
                        0,
                        "test",
                    );
                    for (const unit of partition === "train" ? units : [999999])
                        db.query("INSERT INTO unit VALUES (?,?)").run(id, unit);
                }
            }
            db.close();
            const snapshot = new PremiumEvidenceSnapshot(file, source, { allowDevelopment: true });
            try {
                const rows = [...snapshot.trainingMatchups(["ranked-draft"])];
                expect(rows).toHaveLength(1);
                expect(rows[0].armies.map((row) => row.target.seatPairedScore)).toEqual([0.75, 0.25]);
                expect(rows[0].armies[0].input).toEqual(input);
                expect(Object.keys(rows[0].armies[0].input)).toEqual([
                    "ownCreatureIds",
                    "opponentCreatureIds",
                    "ownDoctrine",
                    "map",
                ]);
                expect(() => [...snapshot.trainingMatchups([])]).toThrow();
            } finally {
                snapshot.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
