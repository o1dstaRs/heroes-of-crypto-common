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

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
    buildArchetypeRoster,
    buildSharedArchetypeOffers,
    setupForArchetype,
    ARCHETYPE_NAMES,
    type ArchetypeName,
} from "./archetype_payoff";
import {
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
    type StackAmountMode,
} from "./army";
import { GREEN_TEAM, runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult } from "./battle_engine";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    canWaitOnHourglassMirror,
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    extractWaitFeatures,
    waitScore,
    waitScorerInSupport,
} from "../ai/versions/wait_scorer";

/**
 * MEASURE MIRROR COHORTS — version-vs-version A/B on FORCED SYMMETRIC rosters.
 *
 * Both seats field the IDENTICAL roster (a committed archetype from archetype_payoff.ts, or the fixed
 * 6/6 pure-shooter roster); only the AI version differs, with paired side-swap seeds (games 2k / 2k+1
 * share seed + roster and swap which seat runs version A). This isolates the VERSION effect per army
 * composition — the axis every melee-skewed draft gate misses (FIGHT_MELEE_ROSTERS=0 still yields
 * melee-heavy DRAFTED rosters, so "random cohort" gates never test ranged mirrors).
 *
 * WHY THIS EXISTS (2026-07-10 ranged-collapse reproduction): v0.7's baked wait-scorer was distilled from
 * 5,000 LIVETWIN MELEE-draft oracle games. On ranged armies it extrapolates out-of-distribution and
 * waits on ~40-48% of decisions (the incumbent v0.5 hourglass rule deliberately EXCLUDED RANGE units).
 * In a shootout, waiting does not dodge incoming fire — it cedes first-volley focus-fire every lap.
 * Measured v0.7 vs v0.6 (paired mirrors, LIVETWIN, fresh 78xx710 seeds): melee_coevo 72.1%±0.7,
 * hybrid 58.4%±0.8, ranged_max_sniper3 25.0%±0.7, pure_ranged 2.1%±0.3 (reproduces the 2.7% probe);
 * with V07_WAIT_WEIGHTS all-zero (scorer disabled, salvage kept) every ranged cohort returns to EXACT
 * 50.00% parity — the collapse is 100% the wait-scorer.
 *
 * FIXED (same day) by the wait_scorer.ts TRAINING-SUPPORT GUARD (default "support": melee-attack-type
 * acting unit AND majority-melee own army). Guarded v0.7 vs v0.6, 3k paired games per cell, seeds
 * 7815710/7816710/7817710/7818710: melee_coevo 71.5%±0.8 (edge retained), hybrid 60.2%±0.9,
 * ranged_max_sniper3 50.6%±0.9 (was 25.0), pure_ranged EXACT 50.00%±1.1 (was 2.1). The "class"-only
 * arm scored 48.9%±0.9 on ranged_max (paired seed 7817710) — the army-context clause is worth +1.7pp
 * there, so "support" ships as the default. Diag (200 games, seed 7821710): v0.7 wait rate 4.0% vs
 * v0.6 3.9% (was 40.9% vs 5.1%), shot damage/game 1011 vs 1008 (was 753 vs 1304), casualty curves
 * indistinguishable, cfScorerFiresInSupport = 0 on the armed seat.
 *
 * Usage:
 *   bun src/simulation/measure_mirror_cohorts.ts --cohort ranged_max_sniper3 --games 4000 --seed 7803710 \
 *       --concurrency 10 --out sim-out/mirror_ranged            # LIVETWIN exp-budget amounts (default)
 *   ... --livetwin 0 --amount-mode levelTable                   # historical {50,30,15,8} sanity config
 *   ... --diag                                                  # per-decision observer + full action logs:
 *       per-side wait rates per lap, wait-scorer counterfactual fires, first-volley stats, casualty curves
 *   ... --zero-scorer                                           # V07_WAIT_WEIGHTS=all-zero (disables ONLY
 *       v0.7's baked wait-scorer; caster salvage stays) — the scorer-attribution arm
 *   ... --guard off|class|support                               # V07_WAIT_GUARD arm: "off" reproduces the
 *       pre-fix unguarded scorer; empty = the code default ("support", the shipped training-support guard)
 */

export const PURE_RANGED_ROSTER_NAMES: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Arbalester" },
    { level: 1, creatureName: "Orc" },
    { level: 2, creatureName: "Elf" },
    { level: 2, creatureName: "Medusa" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
];

export type MirrorCohortName = ArchetypeName | "pure_ranged";

export const MIRROR_COHORTS: readonly MirrorCohortName[] = [...ARCHETYPE_NAMES, "pure_ranged"];

export interface IMirrorRunConfig {
    cohort: MirrorCohortName;
    games: number;
    seed: number;
    vA: string;
    vB: string;
    amountMode: StackAmountMode;
    livetwin: boolean;
    diag: boolean;
    zeroScorer: boolean;
    /** V07_WAIT_GUARD arm for the run: "" = code default ("support"); "off" reproduces the pre-fix scorer. */
    guard?: "" | "support" | "class" | "off";
}

export interface IMirrorLapDiag {
    lap: number;
    decisions: number;
    waits: number;
    eligible: number;
    cfFires: number;
}

export interface IMirrorSideDiag {
    version: string;
    decisions: number;
    waits: number;
    waitsRangedUnit: number;
    eligible: number;
    cfFires: number;
    cfFiresRangedUnit: number;
    /** cfFires that are ALSO inside the training-support guard (wait_scorer.ts waitScorerInSupport). */
    cfFiresInSupport: number;
    byLap: IMirrorLapDiag[];
    shots: number;
    shotDamage: number;
    /** Adjacent completed move_unit -> range_attack pairs by the same side/unit/lap. */
    moveShotSequences: number;
    /** Recorded range-attack damage dealt by moveShotSequences. */
    moveShotRangeDamage: number;
    meleeDamage: number;
    firstVolleyLap: number | null;
    firstVolleyDamage: number | null;
    dmgByLap: Record<number, number>;
    /** Deaths SUFFERED by this side's units, by lap (action-attributed; narrowing/armageddon excluded). */
    deathsByLap: Record<number, number>;
}

export interface IMirrorGameRecord {
    game: number;
    seed: number;
    greenVersion: string;
    winnerVersion: string;
    laps: number;
    endReason: IMatchResult["endReason"];
    armageddon: boolean;
    rejectedGreen: number;
    rejectedRed: number;
    rosterSig?: string;
    diag?: { green: IMirrorSideDiag; red: IMirrorSideDiag };
}

export interface IMirrorDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
}

/** Pair seed rule shared with archetype_payoff: games 2k / 2k+1 replay the same seed with seats swapped. */
export const mirrorGameSeed = (baseSeed: number, game: number): number =>
    (baseSeed + Math.floor(game / 2) * 0x9e3779b1) >>> 0;

export function buildMirrorRoster(
    cohort: MirrorCohortName,
    seed: number,
    amountMode: StackAmountMode,
): IArmyUnitSpec[] {
    const base =
        cohort === "pure_ranged"
            ? PURE_RANGED_ROSTER_NAMES.map(({ level, creatureName }) => {
                  const spec = creaturesByLevel(level).find((c) => c.creatureName === creatureName);
                  if (!spec) {
                      throw new Error(`Catalog is missing ${creatureName} at level ${level}`);
                  }
                  return {
                      faction: spec.faction,
                      creatureName: spec.creatureName,
                      level: spec.level,
                      size: spec.size,
                      amount: 0,
                  };
              })
            : buildArchetypeRoster(cohort, buildSharedArchetypeOffers(makeRng(seed))).roster;
    return base.map((unit) => ({
        ...unit,
        amount: resolveStackAmount(unit.creatureName, unit.level, DEFAULT_AMOUNT_BY_LEVEL, amountMode),
    }));
}

/** pure_ranged fields the standard blind LiveTwin setup (the melee_coevo one) to isolate the version effect. */
const mirrorSetup = (cohort: MirrorCohortName): ReturnType<typeof setupForArchetype> =>
    setupForArchetype(cohort === "pure_ranged" ? "melee_coevo" : cohort);

function newSideDiag(version: string): IMirrorSideDiag {
    return {
        version,
        decisions: 0,
        waits: 0,
        waitsRangedUnit: 0,
        eligible: 0,
        cfFires: 0,
        cfFiresRangedUnit: 0,
        cfFiresInSupport: 0,
        byLap: [],
        shots: 0,
        shotDamage: 0,
        moveShotSequences: 0,
        moveShotRangeDamage: 0,
        meleeDamage: 0,
        firstVolleyLap: null,
        firstVolleyDamage: null,
        dmgByLap: {},
        deathsByLap: {},
    };
}

function lapSlot(side: IMirrorSideDiag, lap: number): IMirrorLapDiag {
    let slot = side.byLap.find((entry) => entry.lap === lap);
    if (!slot) {
        slot = { lap, decisions: 0, waits: 0, eligible: 0, cfFires: 0 };
        side.byLap.push(slot);
    }
    return slot;
}

/** Play one independently addressable mirror game. Exported for tests (inject a fake matchRunner). */
export function playMirrorGame(
    cfg: IMirrorRunConfig,
    game: number,
    dependencies: IMirrorDependencies = {},
): IMirrorGameRecord {
    const seed = mirrorGameSeed(cfg.seed, game);
    const roster = buildMirrorRoster(cfg.cohort, seed, cfg.amountMode);
    const setup = mirrorSetup(cfg.cohort);
    const aIsGreen = game % 2 === 0;
    const greenVersion = aIsGreen ? cfg.vA : cfg.vB;
    const redVersion = aIsGreen ? cfg.vB : cfg.vA;

    const diag = cfg.diag ? { green: newSideDiag(greenVersion), red: newSideDiag(redVersion) } : undefined;
    const observer = diag
        ? (obs: IDecisionObservation): void => {
              const side = obs.unit.getTeam() === GREEN_TEAM ? diag.green : diag.red;
              const fp = obs.context.fightProperties;
              const slot = lapSlot(side, fp ? fp.getCurrentLap() : 0);
              side.decisions += 1;
              slot.decisions += 1;
              const isRangedUnit = obs.unit.getAttackType() === PBTypes.AttackVals.RANGE;
              if (obs.incumbent.some((a) => a.type === "wait_turn")) {
                  side.waits += 1;
                  slot.waits += 1;
                  if (isRangedUnit) {
                      side.waitsRangedUnit += 1;
                  }
                  return;
              }
              if (!fp || !canWaitOnHourglassMirror(obs.unit, fp, obs.context.unitsHolder.getAllUnits())) {
                  return;
              }
              side.eligible += 1;
              slot.eligible += 1;
              const features = extractWaitFeatures(obs.unit, obs.context.unitsHolder, fp, obs.incumbent);
              if (waitScore(DISTILLED_WAIT_WEIGHTS_2026_07_10, features) > 0) {
                  side.cfFires += 1;
                  slot.cfFires += 1;
                  if (isRangedUnit) {
                      side.cfFiresRangedUnit += 1;
                  }
                  if (waitScorerInSupport(obs.unit, obs.context.unitsHolder)) {
                      side.cfFiresInSupport += 1;
                  }
              }
          }
        : undefined;

    // Prime the lazy singleton outside runMatch's seeded scope (archetype_payoff.ts rationale).
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IMatchResult => {
            FightStateManager.getInstance();
            return runMatch(config);
        });
    const result = matchRunner({
        greenVersion,
        redVersion,
        roster: roster.map((unit) => ({ ...unit })),
        redRoster: roster.map((unit) => ({ ...unit })),
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: setup.perk,
        redPerk: setup.perk,
        greenAugments: setup.augments.map((augment) => ({ ...augment })),
        redAugments: setup.augments.map((augment) => ({ ...augment })),
        ...(observer ? { decisionObserver: observer } : {}),
    });

    if (diag) {
        const sideOf = new Map<string, "green" | "red">();
        for (const p of result.placements.green) {
            sideOf.set(p.unitId, "green");
        }
        for (const p of result.placements.red) {
            sideOf.set(p.unitId, "red");
        }
        for (let actionIndex = 0; actionIndex < result.actions.length; actionIndex += 1) {
            const action = result.actions[actionIndex];
            if (!action.completed) {
                continue;
            }
            const actor = action.side === "green" ? diag.green : diag.red;
            const damage = action.impactDamage ?? action.damage ?? 0;
            if (action.actionType === "range_attack") {
                actor.shots += 1;
                actor.shotDamage += damage;
                const preceding = result.actions[actionIndex - 1];
                if (
                    preceding?.completed &&
                    preceding.actionType === "move_unit" &&
                    preceding.side === action.side &&
                    preceding.unitId === action.unitId &&
                    preceding.lap === action.lap
                ) {
                    actor.moveShotSequences += 1;
                    actor.moveShotRangeDamage += damage;
                }
                if (actor.firstVolleyLap === null) {
                    actor.firstVolleyLap = action.lap;
                    actor.firstVolleyDamage = damage;
                }
            } else if (action.actionType === "melee_attack") {
                actor.meleeDamage += damage;
            }
            if (damage > 0) {
                actor.dmgByLap[action.lap] = (actor.dmgByLap[action.lap] ?? 0) + damage;
            }
            for (const died of action.unitIdsDied ?? []) {
                const victimSide = sideOf.get(died);
                if (victimSide) {
                    const victim = victimSide === "green" ? diag.green : diag.red;
                    victim.deathsByLap[action.lap] = (victim.deathsByLap[action.lap] ?? 0) + 1;
                }
            }
        }
        diag.green.byLap.sort((x, y) => x.lap - y.lap);
        diag.red.byLap.sort((x, y) => x.lap - y.lap);
    }

    const winnerVersion = result.winner === "draw" ? "draw" : result.winner === "green" ? greenVersion : redVersion;
    return {
        game,
        seed,
        greenVersion,
        winnerVersion,
        laps: result.laps,
        endReason: result.endReason,
        armageddon: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen ?? 0,
        rejectedRed: result.rejectedRed ?? 0,
        ...(game === 0 ? { rosterSig: roster.map((u) => `L${u.level}:${u.creatureName}x${u.amount}`).join("|") } : {}),
        ...(diag ? { diag } : {}),
    };
}

export interface IMirrorSummary {
    kind: "mirror_cohort_ab";
    cohort: MirrorCohortName;
    versions: { A: string; B: string };
    games: number;
    baseSeed: number;
    amountMode: StackAmountMode;
    livetwin: boolean;
    zeroScorer: boolean;
    guard: string;
    pairedSideSwap: true;
    symmetricRosters: true;
    winsA: number;
    winsB: number;
    draws: number;
    decisive: number;
    winRateA: number;
    winRateAPp: number;
    sePp: number;
    deltaFromParityPp: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    rejectedActions: number;
    exampleRoster?: string;
    wallSeconds?: number;
    diagAggregate?: Record<string, unknown>;
}

export function summarizeMirrorRecords(records: readonly IMirrorGameRecord[], cfg: IMirrorRunConfig): IMirrorSummary {
    const winsA = records.filter((r) => r.winnerVersion === cfg.vA).length;
    const winsB = records.filter((r) => r.winnerVersion === cfg.vB).length;
    const draws = records.filter((r) => r.winnerVersion === "draw").length;
    const decisive = winsA + winsB;
    const rate = decisive ? winsA / decisive : 0.5;
    const endReasons: Record<string, number> = {};
    for (const r of records) {
        endReasons[r.endReason] = (endReasons[r.endReason] ?? 0) + 1;
    }
    return {
        kind: "mirror_cohort_ab",
        cohort: cfg.cohort,
        versions: { A: cfg.vA, B: cfg.vB },
        games: records.length,
        baseSeed: cfg.seed,
        amountMode: cfg.amountMode,
        livetwin: cfg.livetwin,
        zeroScorer: cfg.zeroScorer,
        guard: cfg.guard || "default(support)",
        pairedSideSwap: true,
        symmetricRosters: true,
        winsA,
        winsB,
        draws,
        decisive,
        winRateA: rate,
        winRateAPp: rate * 100,
        sePp: decisive ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY,
        deltaFromParityPp: (rate - 0.5) * 100,
        avgLaps: records.length ? records.reduce((s, r) => s + r.laps, 0) / records.length : 0,
        endReasons,
        armageddonDecided: records.filter((r) => r.armageddon).length,
        rejectedActions: records.reduce((s, r) => s + r.rejectedGreen + r.rejectedRed, 0),
        ...(records.find((r) => r.rosterSig) ? { exampleRoster: records.find((r) => r.rosterSig)!.rosterSig } : {}),
    };
}

interface IVersionAggregate {
    decisions: number;
    waits: number;
    waitsRangedUnit: number;
    eligible: number;
    cfFires: number;
    cfFiresRangedUnit: number;
    cfFiresInSupport: number;
    byLap: Map<number, { decisions: number; waits: number; eligible: number; cfFires: number }>;
    firstVolleyLaps: number[];
    shots: number;
    shotDamage: number;
    moveShotSequences: number;
    moveShotRangeDamage: number;
    meleeDamage: number;
    deathsByLap: Map<number, number>;
    dmgByLap: Map<number, number>;
    games: number;
}

export function aggregateMirrorDiag(
    records: readonly IMirrorGameRecord[],
    cfg: IMirrorRunConfig,
): Record<string, unknown> {
    const agg = new Map<string, IVersionAggregate>();
    const versionAgg = (v: string): IVersionAggregate => {
        let a = agg.get(v);
        if (!a) {
            a = {
                decisions: 0,
                waits: 0,
                waitsRangedUnit: 0,
                eligible: 0,
                cfFires: 0,
                cfFiresRangedUnit: 0,
                cfFiresInSupport: 0,
                byLap: new Map(),
                firstVolleyLaps: [],
                shots: 0,
                shotDamage: 0,
                moveShotSequences: 0,
                moveShotRangeDamage: 0,
                meleeDamage: 0,
                deathsByLap: new Map(),
                dmgByLap: new Map(),
                games: 0,
            };
            agg.set(v, a);
        }
        return a;
    };
    for (const r of records) {
        if (!r.diag) {
            continue;
        }
        for (const side of [r.diag.green, r.diag.red]) {
            const a = versionAgg(side.version);
            a.games += 1;
            a.decisions += side.decisions;
            a.waits += side.waits;
            a.waitsRangedUnit += side.waitsRangedUnit;
            a.eligible += side.eligible;
            a.cfFires += side.cfFires;
            a.cfFiresRangedUnit += side.cfFiresRangedUnit;
            a.cfFiresInSupport += side.cfFiresInSupport ?? 0;
            a.shots += side.shots;
            a.shotDamage += side.shotDamage;
            a.moveShotSequences += side.moveShotSequences ?? 0;
            a.moveShotRangeDamage += side.moveShotRangeDamage ?? 0;
            a.meleeDamage += side.meleeDamage;
            if (side.firstVolleyLap !== null) {
                a.firstVolleyLaps.push(side.firstVolleyLap);
            }
            for (const lapEntry of side.byLap) {
                const slot = a.byLap.get(lapEntry.lap) ?? { decisions: 0, waits: 0, eligible: 0, cfFires: 0 };
                slot.decisions += lapEntry.decisions;
                slot.waits += lapEntry.waits;
                slot.eligible += lapEntry.eligible;
                slot.cfFires += lapEntry.cfFires;
                a.byLap.set(lapEntry.lap, slot);
            }
            for (const [lap, n] of Object.entries(side.deathsByLap)) {
                a.deathsByLap.set(Number(lap), (a.deathsByLap.get(Number(lap)) ?? 0) + n);
            }
            for (const [lap, n] of Object.entries(side.dmgByLap)) {
                a.dmgByLap.set(Number(lap), (a.dmgByLap.get(Number(lap)) ?? 0) + n);
            }
        }
    }
    const out: Record<string, unknown> = {};
    for (const [version, a] of agg) {
        const laps = [...a.byLap.keys()].sort((x, y) => x - y);
        out[version] = {
            games: a.games,
            decisions: a.decisions,
            waitRate: a.waits / Math.max(1, a.decisions),
            waits: a.waits,
            waitsRangedUnit: a.waitsRangedUnit,
            scorerEligibleNonWait: a.eligible,
            cfScorerFires: a.cfFires,
            cfScorerFireRate: a.cfFires / Math.max(1, a.eligible),
            cfScorerFiresRangedUnit: a.cfFiresRangedUnit,
            cfScorerFiresInSupport: a.cfFiresInSupport,
            meanFirstVolleyLap: a.firstVolleyLaps.length
                ? a.firstVolleyLaps.reduce((s, x) => s + x, 0) / a.firstVolleyLaps.length
                : null,
            gamesWithVolley: a.firstVolleyLaps.length,
            shotsPerGame: a.shots / Math.max(1, a.games),
            shotDamagePerGame: a.shotDamage / Math.max(1, a.games),
            moveShotSequences: a.moveShotSequences,
            moveShotSequencesPerGame: a.moveShotSequences / Math.max(1, a.games),
            moveShotRangeDamage: a.moveShotRangeDamage,
            moveShotRangeDamagePerGame: a.moveShotRangeDamage / Math.max(1, a.games),
            meanMoveShotRangeDamage: a.moveShotSequences > 0 ? a.moveShotRangeDamage / a.moveShotSequences : null,
            meleeDamagePerGame: a.meleeDamage / Math.max(1, a.games),
            perLap: laps.map((lap) => {
                const slot = a.byLap.get(lap)!;
                return {
                    lap,
                    decisions: slot.decisions,
                    waitRate: slot.waits / Math.max(1, slot.decisions),
                    eligible: slot.eligible,
                    cfFires: slot.cfFires,
                    deaths: a.deathsByLap.get(lap) ?? 0,
                    dmgDealt: a.dmgByLap.get(lap) ?? 0,
                };
            }),
        };
    }
    return {
        versions: out,
        note:
            "cfScorerFires = counterfactual z>0 (baked weights, UNGUARDED) on non-wait eligible points; " +
            `on the armed ${cfg.vA} seat cfScorerFiresInSupport must be ~0 (in-support fires are already ` +
            `converted) while cfScorerFires-cfScorerFiresInSupport counts points the training-support guard ` +
            `suppressed; on ${cfg.vB} cfScorerFires estimates the unguarded would-fire rate`,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Worker entry — this file spawns itself; workers only ever see the message loop below.
// ---------------------------------------------------------------------------------------------------------
if (!isMainThread && parentPort) {
    const port = parentPort;
    const cfg = workerData as IMirrorRunConfig;
    port.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const record = playMirrorGame(cfg, message.game);
            port.postMessage({ type: "result", record });
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    port.postMessage({ type: "ready" });
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            cohort: { type: "string", default: "ranged_max_sniper3" },
            games: { type: "string", default: "4000" },
            seed: { type: "string", default: "1" },
            concurrency: { type: "string", default: "10" },
            "amount-mode": { type: "string", default: "expBudget" },
            livetwin: { type: "string", default: "1" },
            vA: { type: "string", default: "v0.7" },
            vB: { type: "string", default: "v0.6" },
            diag: { type: "boolean", default: false },
            "zero-scorer": { type: "boolean", default: false },
            guard: { type: "string", default: "" },
            out: { type: "string", default: "sim-out/mirror_cohort" },
        },
        strict: true,
        allowPositionals: false,
    });
    const cfg: IMirrorRunConfig = {
        cohort: values.cohort as MirrorCohortName,
        games: Number(values.games),
        seed: Number(values.seed),
        vA: values.vA!,
        vB: values.vB!,
        amountMode: values["amount-mode"] as StackAmountMode,
        livetwin: values.livetwin === "1",
        diag: values.diag!,
        zeroScorer: values["zero-scorer"]!,
        guard: values.guard as IMirrorRunConfig["guard"],
    };
    if (cfg.guard && !["support", "class", "off"].includes(cfg.guard)) {
        throw new Error(`--guard must be support|class|off (or empty for the code default); got ${cfg.guard}`);
    }
    if (!MIRROR_COHORTS.includes(cfg.cohort)) {
        throw new Error(`--cohort must be one of ${MIRROR_COHORTS.join(", ")}; got ${String(cfg.cohort)}`);
    }
    if (!Number.isSafeInteger(cfg.games) || cfg.games < 2 || cfg.games % 2 !== 0) {
        throw new Error("--games must be a positive even integer (paired side swaps)");
    }
    if (!Number.isSafeInteger(cfg.seed)) {
        throw new Error(`--seed must be a safe integer; got ${values.seed}`);
    }

    // Environment BEFORE spawning workers (they inherit it at spawn).
    if (cfg.livetwin) {
        process.env.LIVETWIN = "1";
    } else {
        delete process.env.LIVETWIN;
    }
    if (cfg.diag) {
        delete process.env.SIM_NO_ACTIONS;
    } else {
        process.env.SIM_NO_ACTIONS = "1";
    }
    if (cfg.zeroScorer) {
        process.env.V07_WAIT_WEIGHTS = JSON.stringify({ b: 0, w: new Array(41).fill(0) });
    } else {
        delete process.env.V07_WAIT_WEIGHTS;
    }
    if (cfg.guard) {
        process.env.V07_WAIT_GUARD = cfg.guard;
    } else {
        delete process.env.V07_WAIT_GUARD;
    }

    const outBase = resolve(String(values.out));
    mkdirSync(dirname(outBase), { recursive: true });
    const jsonlPath = `${outBase}.records.jsonl`;
    writeFileSync(jsonlPath, "");

    const concurrency = Math.max(1, Math.min(Number(values.concurrency), cfg.games));
    const started = Date.now();
    console.error(
        `[mirror_cohort] cohort=${cfg.cohort} games=${cfg.games} seed=${cfg.seed} ` +
            `${cfg.vA} vs ${cfg.vB} amountMode=${cfg.amountMode} LIVETWIN=${cfg.livetwin ? 1 : 0} ` +
            `diag=${cfg.diag} zeroScorer=${cfg.zeroScorer} guard=${cfg.guard || "default"} conc=${concurrency}`,
    );

    const records: IMirrorGameRecord[] = [];
    await new Promise<void>((resolvePromise, rejectPromise) => {
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const workers: Worker[] = [];
        const cleanup = (): void => {
            for (const w of workers) void w.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatchNext = (worker: Worker): void => {
            if (dispatched >= cfg.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched });
            dispatched += 1;
        };
        for (let i = 0; i < concurrency; i += 1) {
            const worker = new Worker(new URL(import.meta.url), { workerData: cfg });
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; record: IMirrorGameRecord }
                        | { type: "error"; error: string },
                ) => {
                    if (settled) {
                        return;
                    }
                    if (message.type === "error") {
                        fail(new Error(message.error));
                        return;
                    }
                    if (message.type === "ready") {
                        dispatchNext(worker);
                        return;
                    }
                    records.push(message.record);
                    appendFileSync(jsonlPath, `${JSON.stringify(message.record)}\n`);
                    completed += 1;
                    if (completed % Math.max(50, Math.floor(cfg.games / 20)) === 0 || completed === cfg.games) {
                        const rate = completed / ((Date.now() - started) / 1000);
                        console.error(`  ${completed}/${cfg.games} (${rate.toFixed(1)} games/s)`);
                    }
                    if (completed >= cfg.games) {
                        settled = true;
                        cleanup();
                        resolvePromise();
                        return;
                    }
                    dispatchNext(worker);
                },
            );
            worker.on("error", fail);
        }
    });

    const summary = summarizeMirrorRecords(records, cfg);
    summary.wallSeconds = (Date.now() - started) / 1000;
    if (cfg.diag) {
        summary.diagAggregate = aggregateMirrorDiag(records, cfg);
    }
    writeFileSync(`${outBase}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.error(
        `RESULT ${cfg.cohort} ${cfg.vA} vs ${cfg.vB}: ${(summary.winRateA * 100).toFixed(2)}% ± ` +
            `${summary.sePp.toFixed(2)}pp (W${summary.winsA}/L${summary.winsB}/D${summary.draws}, ` +
            `avgLaps ${summary.avgLaps.toFixed(1)}, armageddon ${summary.armageddonDecided}, ` +
            `rej ${summary.rejectedActions})`,
    );
    console.error(`Summary: ${outBase}.summary.json`);
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
