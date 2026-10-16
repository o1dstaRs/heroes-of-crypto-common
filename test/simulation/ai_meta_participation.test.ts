import { describe, expect, test } from "bun:test";
import type { GameEvent } from "../../src/engine/events";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { IAiMetaFormationEvidence } from "../../src/simulation/ai_meta_evidence";
import { summarizePremiumParticipation } from "../../src/simulation/ai_meta_participation";

const left = PBTypes.TeamVals.LEFT;
const formation = (ids: string[], creatures: number[]): IAiMetaFormationEvidence => ({
    unitIdsByStack: ids,
    draftedCreatureIdsByStack: creatures,
    expandedRoster: ids.map((id) => ({ creatureName: id, faction: "Life", level: 1, size: 1, amount: 10 })),
    placements: [],
    splitRoles: [],
    augments: [],
});
const fixture = (events?: GameEvent[], aIsGreen = true) => ({
    aIsGreen,
    formations: { a: formation(["healer", "angel", "split"], [11, 22, 11]), b: formation(["enemy"], [33]) },
    ...(events ? { committedEventBatches: [{ lap: 1, events }] } : {}),
});
const cast = (extra: Partial<Extract<GameEvent, { type: "spell_cast" }>> = {}): GameEvent => ({
    type: "spell_cast",
    casterId: "healer",
    spellName: "Heal",
    animations: [],
    unitIdsDied: [],
    ...extra,
});
const summon = (casterId: string, unitId: string, merged = false): GameEvent => ({
    type: "unit_summoned",
    casterId,
    unitId,
    team: left,
    unitName: "Summon",
    amount: 3,
    position: { x: 1, y: 1 },
    cells: [{ x: 1, y: 1 }],
    merged,
});

describe("Premium committed combat participation", () => {
    test("keeps absent capture unknown instead of claiming no actions or zero healing", () => {
        const result = summarizePremiumParticipation(fixture());
        expect(result.eventCoverage).toBe("unavailable");
        expect(result.eventCount).toBe(0);
        expect(result.stacks).toHaveLength(4);
        expect(result.stacks.every((row) => row.terminal === null && row.firstAction === null)).toBe(true);
        expect(result.unknownStackIds).toEqual([]);
    });

    test("attributes spell support once, separates resurrection, and keeps split ancestry", () => {
        const input = fixture([
            { type: "next_unit_selected", unitId: "healer", team: left },
            cast({
                healed: [
                    { unitId: "angel", amount: 13 },
                    { unitId: "split", amount: 2 },
                ],
            }),
            { type: "unit_resurrected", unitId: "split", team: left, amount: 1, hp: 8, position: { x: 1, y: 1 } },
            cast({
                casterId: "angel",
                spellName: "Resurrection",
                resurrected: [{ unitId: "split", amount: 1, hp: 8, position: { x: 1, y: 1 } }],
            }),
        ]);
        const before = structuredClone(input);
        const result = summarizePremiumParticipation(input);
        const healer = result.stacks.find((row) => row.unitId === "healer")!;
        const split = result.stacks.find((row) => row.unitId === "split")!;
        expect(healer.spellHealingGiven).toBe(15);
        expect(healer.firstActivation).toEqual({ lap: 1, eventIndex: 0 });
        expect(healer.firstAction).toEqual({ lap: 1, eventIndex: 1 });
        expect(split.spellHealingReceived).toBe(2);
        expect(split.spellResurrectionHpReceived).toBe(8);
        expect(split.draftedCreatureIds).toEqual([11]);
        expect(result.stacks.reduce((sum, row) => sum + row.spellHealingGiven, 0)).toBe(
            result.stacks.reduce((sum, row) => sum + row.spellHealingReceived, 0),
        );
        expect(result.stacks.reduce((sum, row) => sum + row.spellResurrectionHpGiven, 0)).toBe(8);
        expect(input).toEqual(before);
    });

    test("does not turn a resisted debuff or a friendly heal into hostile targeting", () => {
        const result = summarizePremiumParticipation(
            fixture([
                cast({ healed: [{ unitId: "split", amount: 5 }] }),
                {
                    type: "effects_applied",
                    applications: [
                        { unitId: "split", kind: "debuff", name: "Stun", resisted: true },
                        { unitId: "enemy", kind: "debuff", name: "Break", resisted: false },
                    ],
                },
                cast({
                    spellName: "Fire Strike",
                    damaged: [{ unitId: "enemy", amount: 7, unitsDied: 0, position: { x: 1, y: 1 } }],
                }),
            ]),
        );
        const split = result.stacks.find((row) => row.unitId === "split")!;
        expect(split.firstTargeted).toBeNull();
        expect(split.receivedEffects).toEqual({});
        expect(split.resistedEffects).toEqual({ "debuff:Stun": 1 });
        expect(result.stacks.find((row) => row.unitId === "enemy")!.firstTargeted).toEqual({ lap: 1, eventIndex: 2 });
    });

    test("retains multiple summoners and recursively resolves descendants without inventing exclusive credit", () => {
        const result = summarizePremiumParticipation(
            fixture([
                summon("healer", "child"),
                summon("child", "grandchild"),
                summon("angel", "child", true),
                summon("unrecorded-caster", "orphan"),
            ]),
        );
        expect(result.stacks.find((row) => row.unitId === "child")!.summonerIds).toEqual(["angel", "healer"]);
        expect(result.stacks.find((row) => row.unitId === "grandchild")!.draftedCreatureIds).toEqual([11, 22]);
        expect(result.stacks.find((row) => row.unitId === "grandchild")!.army).toBe("a");
        expect(result.stacks.find((row) => row.unitId === "healer")!.summonedAmount).toBe(3);
        expect(result.unknownStackIds).toEqual(["orphan", "unrecorded-caster"]);
    });

    test("keeps logical armies stable when their physical seats swap", () => {
        const normal = summarizePremiumParticipation(fixture([], true));
        const swapped = summarizePremiumParticipation(fixture([], false));
        const healer = swapped.stacks.find((row) => row.unitId === "healer")!;
        expect(healer.army).toBe("a");
        expect(healer.team).toBe(PBTypes.TeamVals.RIGHT);
        expect(normal.stacks.find((row) => row.unitId === "healer")!.team).toBe(left);
    });

    test("keeps first death separate from resurrection and never counts the turn trace twice", () => {
        const events: GameEvent[] = [
            { type: "unit_destroyed", unitId: "split", reason: "dead_cleanup" },
            cast({
                casterId: "angel",
                spellName: "Resurrection",
                resurrected: [{ unitId: "split", amount: 1, hp: 8, position: { x: 1, y: 1 } }],
            }),
            { type: "unit_destroyed", unitId: "split", reason: "poison" },
        ];
        const input = { ...fixture(events), executionTrace: [{ events }] };
        const result = summarizePremiumParticipation(input);
        const split = result.stacks.find((row) => row.unitId === "split")!;
        expect(result.eventCount).toBe(3);
        expect(split.firstDeath).toEqual({ lap: 1, eventIndex: 0 });
        expect(split.spellResurrectionHpReceived).toBe(8);
        expect(split.terminal).toBeNull();
    });
});
