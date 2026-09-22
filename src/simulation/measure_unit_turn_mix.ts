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

/**
 * Per-unit turn-mix census: does the AI PLAY a creature badly, or is the creature simply weak?
 *
 * A low win rate in the AI-meta cohorts cannot tell those apart. This reads the recorded action stream of
 * ordinary a19 self-play matches and reports, for one forced creature: how many turns each of its stacks
 * takes, how those turns split across attack / move / wait / defend / cast, the damage it converts per turn,
 * and how often and how early it dies. A unit whose turns are mostly passive is an AI problem; a unit that
 * attacks as often as a strong peer but converts a fraction of the damage is a balance problem.
 *
 *   bun src/simulation/measure_unit_turn_mix.ts "4:Abomination" [games] [seedOffset]
 *
 * The creature is forced into both mirrored rosters through FORCE_CREATURES, so every game yields samples
 * and the comparison against a level-matched peer is like-for-like. Run a peer at the same level for a
 * control; the absolute numbers move with the roster distribution, the gap between peers is the signal.
 *
 * MEASURED 2026-09-21 on the deep budget (14 games per unit), bottom vs level-matched top of the 7,056-fight
 * cohort report: defend was 0% for every unit and wait was level-matched, so the passive-turn problem that
 * motivated the 2026-09 unit-release A/Bs is GONE. What remains is conversion — damage per turn:
 * Abomination 78 vs Frenzied Boar 328, Cyclops 103 vs Zena 137, Blacksmith 5 vs Peasant 14.
 */

import { buildRoster, makeRng } from "./army";
import { runMatch, type IRecordedAction } from "./battle_engine";

const ATTACK_ACTION_TYPES: ReadonlySet<IRecordedAction["actionType"]> = new Set([
    "melee_attack",
    "range_attack",
    "area_throw",
    "cast_spell",
] as IRecordedAction["actionType"][]);

export interface IUnitTurnMixCensus {
    readonly creatureName: string;
    readonly games: number;
    /** Stacks of this creature observed across both mirrored sides. */
    readonly stacks: number;
    readonly turns: number;
    readonly turnsPerStack: number;
    /** Share of completed turns spent on an attack or a cast, 0..1. */
    readonly attackShare: number;
    readonly moveShare: number;
    readonly waitShare: number;
    readonly defendShare: number;
    /** Impact damage this creature converted, per stack and per turn it took. */
    readonly damagePerStack: number;
    readonly damagePerTurn: number;
    readonly diedShare: number;
    readonly averageDeathLap: number;
    readonly averageLaps: number;
    readonly actionCounts: Readonly<Record<string, number>>;
}

/** Census one creature over `games` mirrored self-play matches. The creature is forced into both rosters. */
export function measureUnitTurnMix(
    creatureName: string,
    level: number,
    games: number,
    seedOffset = 0,
): IUnitTurnMixCensus {
    const previous = process.env.FORCE_CREATURES;
    process.env.FORCE_CREATURES = `${level}:${creatureName}`;
    const actionCounts: Record<string, number> = {};
    let turns = 0;
    let damage = 0;
    let stacks = 0;
    let deaths = 0;
    let deathLapSum = 0;
    let lapSum = 0;
    try {
        for (let index = 0; index < games; index += 1) {
            const seed = 930_000 + seedOffset + index;
            const result = runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster: buildRoster(makeRng(seed)),
                seed,
                searchOfflineDeterministicWork: true,
            });
            lapSum += result.laps;
            const ids = new Set<string>();
            for (const placement of [...result.placements.green, ...result.placements.red]) {
                if (placement.creatureName === creatureName) ids.add(placement.unitId);
            }
            if (!ids.size) continue;
            stacks += ids.size;
            const diedAtLap = new Map<string, number>();
            for (const action of result.actions) {
                for (const dead of action.unitIdsDied ?? []) {
                    if (ids.has(dead) && !diedAtLap.has(dead)) diedAtLap.set(dead, action.lap);
                }
                if (action.creatureName !== creatureName || !action.completed) continue;
                turns += 1;
                actionCounts[action.actionType] = (actionCounts[action.actionType] ?? 0) + 1;
                damage += action.impactDamage ?? action.damage ?? 0;
            }
            for (const lap of diedAtLap.values()) {
                deaths += 1;
                deathLapSum += lap;
            }
        }
    } finally {
        if (previous === undefined) delete process.env.FORCE_CREATURES;
        else process.env.FORCE_CREATURES = previous;
    }
    const share = (...types: string[]): number =>
        turns ? types.reduce((sum, type) => sum + (actionCounts[type] ?? 0), 0) / turns : 0;
    return {
        creatureName,
        games,
        stacks,
        turns,
        turnsPerStack: stacks ? turns / stacks : 0,
        attackShare: share(...ATTACK_ACTION_TYPES),
        moveShare: share("move_unit"),
        waitShare: share("wait_turn"),
        defendShare: share("defend_turn"),
        damagePerStack: stacks ? damage / stacks : 0,
        damagePerTurn: turns ? damage / turns : 0,
        diedShare: stacks ? deaths / stacks : 0,
        averageDeathLap: deaths ? deathLapSum / deaths : 0,
        averageLaps: games ? lapSum / games : 0,
        actionCounts,
    };
}

export function formatUnitTurnMix(census: IUnitTurnMixCensus): string {
    const percent = (value: number): string => `${(100 * value).toFixed(0)}%`;
    return (
        `${census.creatureName.padEnd(16)} turns/stack ${census.turnsPerStack.toFixed(1).padStart(5)}  ` +
        `attack ${percent(census.attackShare).padStart(4)} move ${percent(census.moveShare).padStart(4)} ` +
        `wait ${percent(census.waitShare).padStart(4)} defend ${percent(census.defendShare).padStart(4)}  ` +
        `dmg/turn ${census.damagePerTurn.toFixed(0).padStart(5)}  died ${percent(census.diedShare).padStart(4)} ` +
        `at lap ${census.averageDeathLap.toFixed(1)}`
    );
}

if (import.meta.main) {
    const spec = process.argv[2] ?? "";
    const [levelText, ...nameParts] = spec.split(":");
    const creatureName = nameParts.join(":");
    const level = Number(levelText);
    if (!creatureName || !Number.isInteger(level)) {
        console.error(
            'Usage: bun src/simulation/measure_unit_turn_mix.ts "<level>:<Creature Name>" [games] [seedOffset]',
        );
        process.exit(2);
    }
    const census = measureUnitTurnMix(creatureName, level, Number(process.argv[3] ?? 14), Number(process.argv[4] ?? 0));
    console.log(formatUnitTurnMix(census));
    console.log(JSON.stringify(census));
}
