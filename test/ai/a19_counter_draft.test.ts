import { describe, expect, test } from "bun:test";

import {
    a19CounterDraftCreature,
    a19CounterDraftEnabled,
    a19CounterDraftGateOpen,
    a19CounterDraftLogit,
} from "../../src/ai/setup/a19_counter_draft";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import MODEL from "../../src/ai/setup/draft_models/a19_counter_draft_v1.json";

const id = (name: string): number => MODEL.creatureIds.find((c) => creatureInfo(c)?.name === name)!;
const level = (l: number): number[] => MODEL.creatureIds.filter((c) => creatureInfo(c)?.level === l);

describe("a19-counter-draft-v1", () => {
    test("the model is complete and antisymmetric", () => {
        expect(MODEL.creatureIds.length).toBe(57);
        expect(MODEL.strength.length).toBe(57);
        for (let i = 0; i < 57; i++)
            for (let j = 0; j < 57; j++) expect(MODEL.counter[i][j]).toBeCloseTo(-MODEL.counter[j][i], 9);
        const a = [id("Zena"), id("Hydra")];
        const b = [id("Crusader"), id("Griffin")];
        expect(a19CounterDraftLogit(a, b)).toBeCloseTo(-a19CounterDraftLogit(b, a), 9);
    });

    test("the gate needs two visible creatures and a melee read", () => {
        expect(a19CounterDraftGateOpen([])).toBe(false);
        expect(a19CounterDraftGateOpen([id("Crusader")])).toBe(false);
        expect(a19CounterDraftGateOpen([id("Crusader"), id("Hydra")])).toBe(true);
        // Two shooters read as a shooter army: the striker draft keeps the rush.
        expect(a19CounterDraftGateOpen([id("Elf"), id("Arbalester")])).toBe(false);
    });

    test("a closed gate leaves the caller's choice; an open one picks from the offer, deterministically", () => {
        const available = level(3).slice(0, 6);
        const base = {
            available,
            ownCreatureIds: [id("Peasant"), id("Squire")],
            bannedCreatureIds: [],
            remainingPickLevels: [3, 4],
            level: 3,
            seed: "game:2",
        };
        expect(a19CounterDraftCreature({ ...base, knownOpponentCreatureIds: [id("Elf")] })).toBeUndefined();
        const open = { ...base, knownOpponentCreatureIds: [id("Crusader"), id("Hydra")] };
        const chosen = a19CounterDraftCreature(open);
        expect(chosen).toBeDefined();
        expect(available).toContain(chosen!);
        expect(a19CounterDraftCreature(open)).toBe(chosen);
    });

    test("per-seat switch: on unless 0", () => {
        const saved = process.env.A19_COUNTER_DRAFT_LEFT;
        try {
            delete process.env.A19_COUNTER_DRAFT_LEFT;
            expect(a19CounterDraftEnabled(2)).toBe(true);
            process.env.A19_COUNTER_DRAFT_LEFT = "0";
            expect(a19CounterDraftEnabled(2)).toBe(false);
        } finally {
            if (saved === undefined) delete process.env.A19_COUNTER_DRAFT_LEFT;
            else process.env.A19_COUNTER_DRAFT_LEFT = saved;
        }
    });
});
