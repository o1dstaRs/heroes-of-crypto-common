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

// Native rollout identity and shadow check (src/simulation/native_rollouts.ts). Production-like battles, both seats on
// the bot seat's A19 deep-fit search inside the server's bot-search environment, offline deterministic work; each
// battle is played once per mode in this process and every searched decision (unit, actions, the decision's rollout
// turns) is compared with the first mode's, with winner and laps. Needs the library (HOC_SIM_LIB or zig/zig-out/lib).
//
//   bun scripts/native_rollouts_identity.ts <battles> <firstSeed> [keepRate=0.4] [out.jsonl]
//   NATIVE_MODES   comma list of HOC_NATIVE_ROLLOUTS values, default "0,1" (identity); "shadow" compares every bank
//   KEEP           creatures that keep their abilities and books: a preset (B13, B14, B15, B14C, B15C, ALL, NONE) or
//                  a comma list; every other creature plays without abilities and spells. Default B14C.
//   SPELLS         "wave1" (default: the books src/v08 casts), "all", or "none"
//   LIVE=1         the bot seat's live code path (single-call banks, no tail bounds) instead of offline work
//   BUDGET_STRESS=1  the deep search gets a third of its rollout turns (turn-budget stops)
import { appendFileSync, writeFileSync } from "node:fs";

const PRESETS: Record<string, string> = {
    B13: "Leprechaun,Nomad,Crusader,Fairy,Goblin Knight,Hyena,Scavenger,Wyvern,Pikeman,Peasant,Pegasus,Hydra,Zena,Arachna Queen,Arachna Spider,Squire,Troglodyte,Monk",
    B4: "Wolf,Berserker,Frenzied Boar,Griffin,White Tiger,Manticore,Behemoth,Troll",
    B5: "Arbalester,Elf,Medusa,Beholder,Cyclops,Tsar Cannon,Gargantuan,Centaur",
    CASTERS: "Healer,Battle Mage,Satyr,Magic Dragon,Trent",
};
const preset = (name: string): string | undefined =>
    ({
        B13: PRESETS.B13,
        B14: `${PRESETS.B13},${PRESETS.B4}`,
        B15: `${PRESETS.B13},${PRESETS.B4},${PRESETS.B5}`,
        B14C: `${PRESETS.B13},${PRESETS.B4},${PRESETS.CASTERS}`,
        B15C: `${PRESETS.B13},${PRESETS.B4},${PRESETS.B5},${PRESETS.CASTERS}`,
        NONE: "",
    })[name];
const WAVE1_SPELLS = new Set([
    "Heal",
    "Blessing",
    "Fire Strike",
    "Meteorite",
    "Lightning Strike",
    "Meteor Shower",
    "Summon Wolves",
    "Ring of Fire",
    "Vine Throw",
    "Battle Roar",
    "Wild Regeneration",
]);

const keepSpec = process.env.KEEP ?? "B14C";
const keepAll = keepSpec === "ALL";
const KEEP = new Set(
    (preset(keepSpec) ?? keepSpec)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
);
const spells = process.env.SPELLS ?? "wave1";

// The creature table is edited before any engine module reads it.
const creatures = (await import("../src/configuration/creatures.json")).default as unknown as Record<
    string,
    Record<string, { abilities: string[]; spells: string[] }> | string
>;
for (const [faction, byName] of Object.entries(creatures)) {
    if (faction === "version" || typeof byName !== "object") continue;
    for (const [name, creature] of Object.entries(byName)) {
        if (keepAll || KEEP.has(name)) {
            if (spells === "none") creature.spells = [];
            else if (spells === "wave1") {
                creature.spells = creature.spells.filter((entry) =>
                    WAVE1_SPELLS.has(entry.slice(entry.indexOf(":") + 1)),
                );
            }
            continue;
        }
        creature.abilities = [];
        creature.spells = [];
    }
}

const { runMatch } = await import("../src/simulation/battle_engine");
const { buildRoster, creaturesByLevel, makeRng } = await import("../src/simulation/army");
const { createV08A19DeepFitSearchDriver } = await import("../src/simulation/v0_8_a19_deep_fit");
const { withScopedAIEnvironment } = await import("../src/simulation/v0_8_a13_search");
const { buildV08A19SearchEnvironment } = await import("../src/ai/versions/v0_8_a19_profile");
const { creatureIdForName } = await import("../src/ai/setup/creature_score");
const { a19ShooterlessAugments } = await import("../src/ai/setup/a19_shooterless_setup");
const { A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS, a19StrikerRushAugments, isA19StrikerRushSetup } =
    await import("../src/ai/setup/a19_striker_rush");
const { resolveSetupPolicy } = await import("../src/ai/setup/setup_ship");
const { getUpgradePoints } = await import("../src/doctrines/doctrine_properties");
const { ToFactionType } = await import("../src/factions/faction_type");
const { synergyVariantsForSeed } = await import("../src/synergies/synergy_properties");
const { NATIVE_ROLLOUTS_ENV, nativeFixtureWritten } = await import("../src/simulation/native_rollouts");

// The server's bot-search environment (heroes-of-crypto-server src/api/game/v1/bot_search.ts), scoped around every
// decision as the server scopes it.
const BOT_ENV = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () =>
    Object.freeze({
        ...buildV08A19SearchEnvironment(),
        SEARCH_A19_MATERIAL_ARBITRATION: "ties",
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
        SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "1",
        SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
        SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON: "0",
        V08_FLYER_BACKLINE_PRIORITY_LEFT: "0",
        V08_FLYER_BACKLINE_PRIORITY_RIGHT: "0",
        V08_A19_SEARCH_ENV_OVERRIDES: undefined,
    }),
);

type Spec = Record<string, unknown> & { creatureName: string; level: number };
const keepRate = Number(process.argv[4] ?? 0.4);
function rosterFor(seed: number): Spec[] {
    const base = buildRoster(makeRng(seed)) as unknown as Spec[];
    const rng = makeRng(Math.imul(seed, 7919) >>> 0);
    return base.map((spec) => {
        const pool = (creaturesByLevel(spec.level) as unknown as Spec[]).filter(
            (entry) => keepAll || KEEP.has(entry.creatureName),
        );
        if (!pool.length || rng() >= keepRate) return spec;
        const pick = pool[Math.floor(rng() * pool.length)];
        return {
            faction: pick.faction,
            creatureName: pick.creatureName,
            level: pick.level,
            size: pick.size,
            ...(pick.footprintWidth === undefined || pick.footprintHeight === undefined
                ? {}
                : { footprintWidth: pick.footprintWidth, footprintHeight: pick.footprintHeight }),
            amount: spec.amount,
        };
    });
}
const gridTypeFor = (seed: number): number => {
    const u = makeRng(Math.imul(seed ^ 0x51ed270b, 0x2c1b3c6d) >>> 0)();
    return u < 1 / 3 ? 1 : u < 2 / 3 ? 3 : 4;
};
const setupPolicy = resolveSetupPolicy("artifact-fit-v8:conditional-v1:sniper+t2a19");
const idsOf = (roster: Spec[]): number[] => [
    ...new Set(roster.map((spec) => creatureIdForName(spec.creatureName) ?? 0).filter((id: number) => id > 0)),
];
function augmentsFor(budget: number, own: Spec[], opponent: Spec[]): { kind: string; value: number }[] {
    const ownIds = idsOf(own);
    const base = setupPolicy.pickAugments(budget, ownIds) as { kind: string; value: number }[];
    const plan = isA19StrikerRushSetup(ownIds, idsOf(opponent), true, A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS)
        ? a19StrikerRushAugments(base as never, budget, ownIds)
        : a19ShooterlessAugments(base as never, ownIds);
    return (plan as { kind: string; value: number }[]).map(({ kind, value }) => ({ kind, value }));
}
const doctrineFor = (seed: number, team: number): number =>
    1 + (((Math.imul(seed ^ 0x9e37, 0x85ebca6b) >>> 0) + team * 7) % 3);
function synergiesFor(roster: Spec[], variants: Record<string, number>): { faction: number; synergy: number }[] {
    const distinct = new Map<string, Set<string>>();
    for (const spec of roster) {
        const names = distinct.get(spec.faction as string) ?? new Set<string>();
        names.add(spec.creatureName);
        distinct.set(spec.faction as string, names);
    }
    const out: { faction: number; synergy: number }[] = [];
    for (const faction of ["Life", "Nature", "Chaos", "Might"]) {
        if ((distinct.get(faction)?.size ?? 0) >= 2) {
            out.push({ faction: (ToFactionType as Record<string, number>)[faction], synergy: variants[faction] });
        }
    }
    return out;
}

interface IDecisionRow {
    unit: string;
    team: number;
    actions: string;
    turns: number;
    ms: number;
}
interface IBattleRun {
    decisions: IDecisionRow[];
    winner: unknown;
    laps: unknown;
    native: Record<string, unknown>[];
    searchMs: number;
}
interface ISearchDriverLike {
    counters: { rolloutTurnsTotal: number };
    nativeRolloutStatistics: Record<string, unknown>;
}

function playBattle(seed: number, mode: string): IBattleRun {
    process.env[NATIVE_ROLLOUTS_ENV] = mode;
    const roster = rosterFor(seed);
    const redRoster = rosterFor((seed ^ 0x5bd1e995) >>> 0);
    const green = doctrineFor(seed, 0);
    const red = doctrineFor(seed, 1);
    const variants = synergyVariantsForSeed(`rec-${seed}`);
    const decisions: IDecisionRow[] = [];
    const drivers: ISearchDriverLike[] = [];
    let searchMs = 0;
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster,
        redRoster,
        seed,
        maxLaps: 60,
        headlessEvents: true,
        gridType: gridTypeFor(seed),
        sideOrientedPlacement: true,
        greenDoctrine: green,
        redDoctrine: red,
        greenAugments: augmentsFor(getUpgradePoints(green), roster, redRoster),
        redAugments: augmentsFor(getUpgradePoints(red), redRoster, roster),
        greenSynergies: synergiesFor(roster, variants),
        redSynergies: synergiesFor(redRoster, variants),
        synergyVariants: variants,
        placementAugmentTiming: "setup-before-placement",
        searchOfflineDeterministicWork: true,
        searchDriverFactory: (deps, match) => {
            const driver = withScopedAIEnvironment(BOT_ENV, () =>
                createV08A19DeepFitSearchDriver(
                    deps,
                    process.env.LIVE === "1" ? { ...match, offlineDeterministicWork: false } : match,
                ),
            );
            const inner = driver as unknown as { stock: ISearchDriverLike; deep: ISearchDriverLike & object };
            drivers.push(inner.stock, inner.deep);
            if (process.env.BUDGET_STRESS === "1") {
                const deep = inner.deep as unknown as {
                    chooseDecisionWithinBudget: (...args: unknown[]) => unknown;
                };
                const own = deep.chooseDecisionWithinBudget.bind(deep);
                deep.chooseDecisionWithinBudget = (u, v, incumbent, context, budget) =>
                    own(u, v, incumbent, context, {
                        ...(budget as object),
                        rolloutTurns: Math.floor(((budget as { rolloutTurns?: number }).rolloutTurns ?? 0) / 3),
                    });
            }
            return {
                chooseDecision: (unit, version, incumbent, context) => {
                    const startedAt = performance.now();
                    const turnsBefore = inner.stock.counters.rolloutTurnsTotal + inner.deep.counters.rolloutTurnsTotal;
                    const actions = withScopedAIEnvironment(BOT_ENV, () =>
                        driver.chooseDecision(unit, version, incumbent, context),
                    );
                    const ms = performance.now() - startedAt;
                    searchMs += ms;
                    decisions.push({
                        unit: unit.getId(),
                        team: unit.getTeam(),
                        actions: JSON.stringify(actions),
                        turns:
                            inner.stock.counters.rolloutTurnsTotal +
                            inner.deep.counters.rolloutTurnsTotal -
                            turnsBefore,
                        ms,
                    });
                    return actions;
                },
                onFightReady: () => driver.onFightReady(),
                onMatchEnd: (winner, reason) => driver.onMatchEnd(winner, reason),
            };
        },
    } as never) as unknown as { winner: unknown; laps?: unknown; lap?: unknown };
    return {
        decisions,
        winner: result.winner,
        laps: result.laps ?? result.lap,
        native: drivers.map((driver) => ({ ...driver.nativeRolloutStatistics })),
        searchMs,
    };
}

const merge = (into: Record<string, number>, from: unknown): void => {
    for (const [key, value] of Object.entries((from ?? {}) as Record<string, number>)) {
        into[key] = (into[key] ?? 0) + value;
    }
};

const battles = Number(process.argv[2] ?? 1);
const firstSeed = Number(process.argv[3] ?? 47000000);
const outPath = process.argv[5];
const modes = (process.env.NATIVE_MODES ?? "0,1").split(",").map((mode) => mode.trim());
if (outPath) writeFileSync(outPath, "");
const totals = {
    battles: 0,
    identicalBattles: 0,
    decisions: 0,
    identicalDecisions: 0,
    identicalTurns: 0,
    searchMs: Object.fromEntries(modes.map((mode) => [mode, 0])) as Record<string, number>,
    native: {} as Record<string, number>,
    fallback: {} as Record<string, number>,
    rootFallback: {} as Record<string, number>,
    stops: {} as Record<string, number>,
    failures: [] as string[],
};
for (let index = 0; index < battles; index += 1) {
    const seed = firstSeed + index;
    const runs = modes.map((mode) => playBattle(seed, mode));
    const [reference, ...others] = runs;
    totals.battles += 1;
    let identical = true;
    for (const [k, run] of others.entries()) {
        const mode = modes[k + 1];
        if (run.winner !== reference.winner || run.laps !== reference.laps) {
            identical = false;
            totals.failures.push(
                `seed ${seed} ${mode}: winner ${String(run.winner)} laps ${String(run.laps)} vs ${String(reference.winner)} ${String(reference.laps)}`,
            );
        }
        if (run.decisions.length !== reference.decisions.length) {
            identical = false;
            totals.failures.push(
                `seed ${seed} ${mode}: ${run.decisions.length} decisions vs ${reference.decisions.length}`,
            );
        }
        const compared = Math.min(run.decisions.length, reference.decisions.length);
        for (let i = 0; i < compared; i += 1) {
            const a = reference.decisions[i];
            const b = run.decisions[i];
            totals.decisions += 1;
            if (a.unit === b.unit && a.team === b.team && a.actions === b.actions) totals.identicalDecisions += 1;
            else {
                identical = false;
                totals.failures.push(
                    `seed ${seed} ${mode} decision ${i}: ${a.actions.slice(0, 140)} vs ${b.actions.slice(0, 140)}`,
                );
                break;
            }
            if (a.turns === b.turns) totals.identicalTurns += 1;
            else totals.failures.push(`seed ${seed} ${mode} decision ${i}: rollout turns ${b.turns} vs ${a.turns}`);
        }
    }
    if (identical) totals.identicalBattles += 1;
    for (const [k, run] of runs.entries()) {
        totals.searchMs[modes[k]] += run.searchMs;
        for (const stats of run.native) {
            const { fallback, rootFallback, stops, mode: _mode, ...counts } = stats as Record<string, unknown>;
            merge(totals.native, counts);
            merge(totals.fallback, fallback);
            merge(totals.rootFallback, rootFallback);
            merge(totals.stops, stops);
        }
    }
    const row = {
        seed,
        identical,
        decisions: reference.decisions.length,
        winner: reference.winner,
        laps: reference.laps,
        searchMs: Object.fromEntries(runs.map((run, k) => [modes[k], Math.round(run.searchMs)])),
    };
    if (outPath) appendFileSync(outPath, `${JSON.stringify(row)}\n`);
    console.error(
        `seed ${seed}: ${identical ? "identical" : "DIFFERS"}, ${row.decisions} decisions, ${JSON.stringify(row.searchMs)} ms`,
    );
}
const summary = {
    ...totals,
    searchMs: Object.fromEntries(Object.entries(totals.searchMs).map(([mode, ms]) => [mode, Math.round(ms)])),
    native: Object.fromEntries(Object.entries(totals.native).map(([key, value]) => [key, Math.round(value)])),
    failures: totals.failures.slice(0, 30),
    fixture: nativeFixtureWritten(),
};
if (outPath) appendFileSync(outPath, `${JSON.stringify({ summary })}\n`);
console.log(JSON.stringify(summary, null, 1));
process.exit(totals.identicalBattles === totals.battles ? 0 : 1);
