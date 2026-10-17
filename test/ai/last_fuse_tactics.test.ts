import { afterEach, expect, test } from "bun:test";

import { enumerateCandidates } from "../../src/ai/candidates";
import {
    lastFuseCounterTradePotential,
    reserveLastFuseShortlistCandidate,
    includeImprovingLastFuseTrade,
} from "../../src/ai/last_fuse_tactics";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { lastFuseBoard } from "../helpers/last_fuse";

afterEach(() => setDeterministicRandomSource(undefined));

test("Last Fuse reserves the extra enemy damage earned by a kill", () => {
    const f = lastFuseBoard();
    expect(lastFuseCounterTradePotential(f.attacker, f.target, f.context, f.stand, f.actions)).toBe(25);
    const candidates = enumerateCandidates(
        f.attacker,
        f.context,
        [{ type: "defend_turn", unitId: f.attacker.getId() }],
        {
            includeLastFuseCounterTrades: true,
            enrichIncumbentMetadata: true,
            maxMeleePairs: 1,
        },
    ).candidates;
    const reserved = candidates.find((candidate) => candidate.lastFuseCounterTradeReserved);
    expect(reserved).toBeDefined();
    expect(reserveLastFuseShortlistCandidate(candidates, [])).toEqual([reserved!]);
});

test("being killed by a counter no longer earns an explosion opportunity", () => {
    const f = lastFuseBoard({
        response: true,
        attacker: { maxHp: 10, damageMin: 0, damageMax: 0 },
        target: { maxHp: 1000, damageMin: 1000, damageMax: 1000 },
    });
    expect(f.attacker.getLastFuseDamage()).toBe(0);
    expect(
        lastFuseCounterTradePotential(f.attacker, f.target, f.context, f.stand, f.actions, {
            includePrimaryTarget: true,
        }),
    ).toBe(0);
    expect(
        enumerateCandidates(f.attacker, f.context, [{ type: "defend_turn", unitId: f.attacker.getId() }], {
            includeLastFuseCounterTrades: true,
            enrichIncumbentMetadata: true,
            includeLastFusePrimaryTrades: true,
        }).candidates.some((candidate) => candidate.lastFuseCounterTradeReserved),
    ).toBe(false);
});

test("nonfatal hits and a shielded neighbor offer no splash opportunity", () => {
    for (const options of [
        { attacker: { damageMin: 1, damageMax: 1 } },
        { neighbor: { abilities: ["Water Shield"] } },
        { fuse: false, enemyFuse: true },
    ]) {
        const f = lastFuseBoard(options);
        expect(lastFuseCounterTradePotential(f.attacker, f.target, f.context, f.stand, f.actions)).toBe(0);
    }
});

test("a reserved kill still needs a better complete engine score to cross a selection tier", () => {
    const f = lastFuseBoard();
    const candidates = enumerateCandidates(
        f.attacker,
        f.context,
        [{ type: "defend_turn", unitId: f.attacker.getId() }],
        {
            includeLastFuseCounterTrades: true,
            enrichIncumbentMetadata: true,
        },
    ).candidates;
    const reserved = candidates.find((candidate) => candidate.lastFuseCounterTradeReserved)!;
    const plain = { ...reserved, lastFuseCounterTradeReserved: undefined };
    expect(includeImprovingLastFuseTrade([plain, reserved], [10, 9], [0])).toEqual([0]);
    expect(includeImprovingLastFuseTrade([plain, reserved], [10, 11], [0])).toEqual([0, 1]);
});
