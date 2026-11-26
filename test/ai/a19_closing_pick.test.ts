/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, test } from "bun:test";

import {
    A19_CLOSING_PICK_MARGIN,
    A19_CLOSING_PICK_POLICY,
    a19ClosingPickCreature,
    a19ClosingPickSynergyBonus,
} from "../../src/ai/setup/a19_closing_pick";
import { a19CounterDraftGateOpen } from "../../src/ai/setup/a19_counter_draft";
import { creatureIdForName, creatureInfo } from "../../src/ai/setup/creature_score";

import { CPC_GAMES } from "./fixtures/cpc_closing_pick_games";

const id = (name: string): number => {
    const found = creatureIdForName(name);
    if (found === undefined) throw new Error(`unknown creature ${name}`);
    return found;
};

describe(A19_CLOSING_PICK_POLICY, () => {
    test("with counter model v2 (the default) makes the recorded level-4 picks in the six human games of confirmation CPC", () => {
        for (const { game, expectedV2, ...input } of CPC_GAMES) {
            expect([game, a19ClosingPickCreature(input)]).toEqual([game, expectedV2]);
            if (expectedV2 !== undefined) expect(creatureInfo(expectedV2)?.level).toBe(4);
        }
    });

    test("A19_COUNTER_MODEL=v1 restores the research hook's picks of confirmation CPC", () => {
        const script = `
            const { a19ClosingPickCreature } = await import(${JSON.stringify(`${import.meta.dir}/../../src/ai/setup/a19_closing_pick.ts`)});
            const { A19_COUNTER_MODEL_ID } = await import(${JSON.stringify(`${import.meta.dir}/../../src/ai/setup/a19_counter_draft.ts`)});
            const { CPC_GAMES } = await import(${JSON.stringify(`${import.meta.dir}/fixtures/cpc_closing_pick_games.ts`)});
            console.log(JSON.stringify({ model: A19_COUNTER_MODEL_ID, picks: CPC_GAMES.map(({ expected, expectedV2, game, ...input }) => [game, a19ClosingPickCreature(input) ?? null]) }));
        `;
        const result = Bun.spawnSync([process.execPath, "-e", script], {
            env: { ...process.env, A19_COUNTER_MODEL: "v1" },
        });
        expect(result.exitCode).toBe(0);
        const out = JSON.parse(result.stdout.toString().trim().split("\n").pop()!);
        expect(out.model).toBe("a19-counter-draft-v1");
        expect(out.picks).toEqual(CPC_GAMES.map(({ game, expected }) => [game, expected]));
    });

    test("stays silent off level 4, with nothing seen, without a current choice and once the counter draft's gate opens", () => {
        const base = CPC_GAMES[2];
        expect(a19ClosingPickCreature({ ...base, level: 3 })).toBeUndefined();
        expect(a19ClosingPickCreature({ ...base, knownOpponentCreatureIds: [] })).toBeUndefined();
        expect(a19ClosingPickCreature({ ...base, current: undefined })).toBeUndefined();
        const melee = [id("Berserker"), id("Crusader"), id("Troll")];
        expect(a19CounterDraftGateOpen(melee)).toBe(true);
        expect(a19ClosingPickCreature({ ...base, knownOpponentCreatureIds: melee })).toBeUndefined();
    });

    test("keeps the current choice when it is already the best offer or the only one", () => {
        for (const { game, expectedV2, ...input } of CPC_GAMES) {
            const best = expectedV2 ?? input.current;
            expect([game, a19ClosingPickCreature({ ...input, current: best })]).toEqual([game, undefined]);
            expect([game, a19ClosingPickCreature({ ...input, available: [input.current!] })]).toEqual([
                game,
                undefined,
            ]);
        }
        expect(A19_CLOSING_PICK_MARGIN).toBe(0.05);
    });

    test("adds the synergy bonus for a faction's second and fourth distinct creature only", () => {
        const life = [id("Peasant"), id("Squire"), id("Arbalester"), id("Crusader")].filter(
            (creature) => creatureInfo(creature)?.faction === creatureInfo(id("Angel"))?.faction,
        );
        expect(a19ClosingPickSynergyBonus([], id("Angel"))).toBe(0);
        expect(a19ClosingPickSynergyBonus(life.slice(0, 1), id("Angel"))).toBe(0.04);
        expect(a19ClosingPickSynergyBonus(life.slice(0, 2), id("Angel"))).toBe(0);
        expect(a19ClosingPickSynergyBonus(life.slice(0, 3), id("Angel"))).toBe(0.045);
        expect(a19ClosingPickSynergyBonus([id("Angel")], id("Angel"))).toBe(0);
    });
});
