/*
 * Bridge smoke test: exports live TypeScript battles mid-fight, loads each through the C ABI, plays it out natively,
 * and checks the result against the TypeScript continuation of the same battle and against `hoc-sim play-state` (a
 * separate Zig process on the same export); runs a rollouts request through it; prints the per-call overheads.
 *
 *   cd zig && zig build -Drelease=true && zig build lib -Drelease=true && cd ..
 *   bun zig/ffi/smoke.ts [battles=24] [firstSeed=9000]
 *
 * Scope: v0.1 on both seats, side-oriented NORMAL / LAVA_CENTER / BLOCK_CENTER boards in turn, every creature's
 * abilities stripped except SMOKE_KEEP (default: batches 1 and 2; "none" for ability-free battles). Exits non-zero on
 * any difference.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import creaturesJson from "../../src/configuration/creatures.json";
import { GameActionEngine } from "../../src/engine/action_engine";
import { TurnEngine } from "../../src/engine/turn_engine";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import {
    captureDeterministicRandomState,
    getDeterministicRandomSource,
    setDeterministicRandomSource,
} from "../../src/utils/lib";
import { battleDigest } from "../parity/digest";
import { exportBattleState } from "../parity/state_export";
import { HocEngine, HOC_END_REASONS, hocNowNs, hocSymbols, type IHocRolloutRequest } from "./bridge";

const DEFAULT_KEEP =
    "Leprechaun,Nomad,Crusader,Fairy,Goblin Knight,Hyena,Scavenger,Wyvern,Pikeman,Peasant,Pegasus,Hydra,Trent";
const keepSpec = process.env.SMOKE_KEEP ?? DEFAULT_KEEP;
const KEEP = new Set(keepSpec === "none" ? [] : keepSpec.split(",").map((name) => name.trim()));
for (const [faction, creatures] of Object.entries(creaturesJson as Record<string, any>)) {
    if (faction === "version" || typeof creatures !== "object") continue;
    for (const [name, creature] of Object.entries(creatures as Record<string, any>)) {
        if (KEEP.has(name)) continue;
        creature.abilities = [];
        creature.spells = [];
    }
}

/** mulberry32 with an observable state (zig/src/rng.zig keeps the same state). */
class Mulberry {
    public state: number;
    public constructor(seed: number) {
        this.state = seed >>> 0;
    }
    public next = (): number => {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface IBattle {
    seed: number;
    json: string;
    exportMs: number;
    incumbent: unknown[];
    actorId: string;
    actingTeam: number;
    ts: { winner: number; lap: number; rng: number; endReason: string; digest: object };
}

/** Runs one battle, exporting it at decision `at`; undefined when the battle ends first. */
function recordBattle(seed: number, at: number): IBattle | undefined {
    let ctx: any;
    let rng: Mulberry | undefined;
    let depth = 0;
    let decisions = 0;
    let exported: Omit<IBattle, "ts"> | undefined;
    let lastDigest: object | undefined;
    let winner = -1;
    const wrap = (proto: any, method: string): (() => void) => {
        const original = proto[method];
        proto[method] = function (this: unknown, arg: unknown) {
            if (depth > 0 || !ctx) return original.call(this, arg);
            depth += 1;
            try {
                const result = original.call(this, arg);
                if (exported) {
                    lastDigest = battleDigest(ctx, { setup: true, terrain: true });
                    for (const e of result.events) if (e.type === "fight_finished") winner = e.winningTeam;
                }
                return result;
            } finally {
                depth -= 1;
            }
        };
        return () => {
            proto[method] = original;
        };
    };
    const decide = StrategyV0_1.prototype.decideTurn;
    StrategyV0_1.prototype.decideTurn = function (this: unknown, unit: any, context: any) {
        if (!ctx || !rng || depth > 0) return decide.call(this, unit, context);
        const index = decisions++;
        let json: string | undefined;
        let exportMs = 0;
        if (index === at) {
            const t0 = performance.now();
            json = JSON.stringify(
                exportBattleState(ctx, {
                    rng: rng.state,
                    activeUnitId: unit.getId(),
                    uuidSequence: captureDeterministicRandomState().uuidSequence,
                }),
            );
            exportMs = performance.now() - t0;
        }
        const actions = decide.call(this, unit, context);
        if (json) {
            exported = {
                seed,
                json,
                exportMs,
                incumbent: JSON.parse(JSON.stringify(actions)),
                actorId: unit.getId(),
                actingTeam: unit.getTeam(),
            };
        }
        return actions;
    };
    const unwrapApply = wrap(GameActionEngine.prototype, "apply");
    const unwrapAdvance = wrap(TurnEngine.prototype, "advanceAfterNoActiveUnit");
    try {
        const gridType = [1, 3, 4][seed % 3];
        const result = runMatch({
            greenVersion: "v0.1",
            redVersion: "v0.1",
            roster: buildRoster(makeRng(seed)),
            seed,
            maxLaps: 60,
            headlessEvents: true,
            gridType,
            sideOrientedPlacement: true,
            beforeFightStart: (context) => {
                ctx = context;
                if (!getDeterministicRandomSource()) throw new Error("expected a seeded match");
                rng = new Mulberry(Math.imul(seed, 0x9e3779b1) >>> 0);
                setDeterministicRandomSource(rng.next);
            },
        });
        if (!exported || !lastDigest) return undefined;
        return {
            ...exported,
            ts: { winner, lap: result.laps, rng: rng!.state, endReason: result.endReason, digest: lastDigest },
        };
    } finally {
        StrategyV0_1.prototype.decideTurn = decide;
        unwrapApply();
        unwrapAdvance();
    }
}

/** Exact equality of two digests, skipping buffs_sources (digest.zig prints only aura and augment rows there). */
function digestDiff(zig: any, ts: any): string | null {
    if (zig.units.length !== ts.units.length) return `units: zig ${zig.units.length}, ts ${ts.units.length}`;
    for (let i = 0; i < ts.units.length; i += 1) {
        for (let c = 0; c < ts.units[i].length; c += 1) {
            if (c === 46) continue;
            const a = zig.units[i][c];
            const b = ts.units[i][c];
            const same = typeof b === "string" ? String(a) === b || splitEqual(String(a), b) : Number(a) === Number(b);
            if (!same) return `unit ${i} column ${c}: zig ${JSON.stringify(a)}, ts ${JSON.stringify(b)}`;
        }
    }
    for (const [key, value] of Object.entries(ts.fight)) {
        if (JSON.stringify(zig.fight[key]) !== JSON.stringify(value)) return `fight ${key}`;
    }
    return null;
}

/** "1,15" against "1,15.0"-style lists: the same numbers or names in order. */
function splitEqual(a: string, b: string): boolean {
    const x = a.split(",");
    const y = b.split(",");
    return x.length === y.length && x.every((v, i) => v === y[i] || (v !== "" && Number(v) === Number(y[i])));
}

function main(): void {
    const battles = Number(process.argv[2] ?? 24);
    const firstSeed = Number(process.argv[3] ?? 9000);
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "zig-out", "bin", "hoc-sim");
    const haveCli = existsSync(cli);
    if (!haveCli) console.log(`note: ${cli} not built; skipping the play-state comparison`);
    const tmp = mkdtempSync(join(tmpdir(), "hoc-bridge-"));
    const engine = HocEngine.open();
    const failures: string[] = [];
    let checked = 0;
    let skipped = 0;
    let exportMs = 0;
    let exportBytes = 0;
    let loadMs = 0;
    let loads = 0;
    let rolloutNs = 0n;
    let rolloutPairs = 0;
    let rolloutTurns = 0;
    try {
        for (let g = 0; g < battles; g += 1) {
            const seed = firstSeed + g;
            const at = 3 + Math.floor(makeRng(Math.imul(seed, 0x2545f491) >>> 0)() * 30);
            const battle = recordBattle(seed, at);
            if (!battle) {
                skipped += 1;
                continue;
            }
            const fail = (why: string): void => {
                failures.push(`seed ${seed} (decision ${at}): ${why}`);
            };
            exportMs += battle.exportMs;
            exportBytes += battle.json.length;

            // Load (the raw call on a pre-encoded buffer, timed over a few repetitions), then play a clone out natively.
            let state = engine.load(battle.json);
            const reps = 10;
            const encoded = new TextEncoder().encode(battle.json);
            const t0 = performance.now();
            for (let i = 0; i < reps; i += 1) {
                hocSymbols.hoc_state_free(engine.ptr, hocSymbols.hoc_state_load(engine.ptr, encoded, encoded.length));
            }
            loadMs += performance.now() - t0;
            loads += reps;
            const played = state.clone();
            const r = played.playV01(60);
            const ts = battle.ts;
            if (r.rng !== ts.rng) fail(`final random state zig ${r.rng}, ts ${ts.rng}`);
            if (r.lap !== ts.lap) fail(`final lap zig ${r.lap}, ts ${ts.lap}`);
            if (r.winner !== ts.winner) fail(`winner zig ${r.winner}, ts ${ts.winner}`);
            if (HOC_END_REASONS[r.end] !== ts.endReason) fail(`end zig ${HOC_END_REASONS[r.end]}, ts ${ts.endReason}`);
            const why = played.checkDigest(ts.digest);
            if (why) fail(`final state: ${why}`);
            const zigDigest = played.digest();
            const diff = digestDiff(zigDigest, ts.digest);
            if (diff) fail(`digest JSON: ${diff}`);
            played.free();

            // The same export in a separate Zig process.
            if (haveCli) {
                const file = join(tmp, `state-${seed}.json`);
                writeFileSync(file, battle.json);
                const run = spawnSync(cli, ["play-state", file], { encoding: "utf8" });
                if (run.status !== 0) {
                    fail(`play-state failed: ${run.stderr}`);
                } else {
                    const out = JSON.parse(run.stdout);
                    if (JSON.stringify(out.result) !== JSON.stringify(r)) fail("play-state result differs from FFI");
                    const d = digestDiff(out.digest, ts.digest);
                    if (d) fail(`play-state digest: ${d}`);
                }
            }

            // Rollouts: the v0.1 incumbent, defend and wait, four paired rollouts each, three horizons.
            const candidates = [
                { kind: "incumbent", actions: battle.incumbent },
                { kind: "defend", actions: [{ type: "defend_turn", unitId: battle.actorId }] },
                { kind: "wait", actions: [{ type: "wait_turn", unitId: battle.actorId }] },
            ];
            const pairs: [number, number][] = [];
            for (let c = 0; c < candidates.length; c += 1) for (let rr = 0; rr < 4; rr += 1) pairs.push([c, rr]);
            for (const horizon of [
                { mode: "turns", turns: 12 },
                { mode: "lap" },
                { mode: "reply" },
            ] as IHocRolloutRequest["horizon"][]) {
                const request: IHocRolloutRequest = {
                    actor: battle.actorId,
                    actingTeam: battle.actingTeam,
                    seedBase: (seed * 2654435761) >>> 0,
                    chance: "plain",
                    horizon,
                    leaf: { kind: "material", exactTerminal: true },
                    policies: { "1": { version: "v0.1" }, "2": { version: "v0.1" } },
                    candidates,
                    pairs,
                };
                const t1 = hocNowNs();
                const a = engine.rollouts(state, request);
                rolloutNs += hocNowNs() - t1;
                rolloutPairs += a.values.length;
                rolloutTurns += a.turns;
                const b = engine.rollouts(state, request);
                if (a.values.length !== pairs.length || a.stop !== "done") fail(`rollouts stopped early (${a.stop})`);
                if (a.values.some((v, i) => !Object.is(v, b.values[i]))) fail("rollouts are not deterministic");
                if (a.values.some((v) => v !== -Infinity && !(v >= 0 && v <= 1)))
                    fail("a rollout value outside [0, 1]");
                if (a.values.slice(0, 4).some((v) => v === -Infinity)) fail("the incumbent was rejected");
                const cut = engine.rollouts(state, request, hocNowNs());
                if (cut.values.length !== 0 || cut.stop !== "deadline") fail("a past deadline did not stop the call");
                // A turn budget keeps the prefix of rollouts that fit (here: those whose fight ended in ply 0).
                const budget = engine.rollouts(state, { ...request, turnBudget: 0 });
                if (budget.values.some((v, i) => !Object.is(v, a.values[i]))) fail("turnBudget changed a value");
                if (budget.stop !== "turn_budget" && budget.values.length !== pairs.length) {
                    fail(`turnBudget 0 wrote ${budget.values.length} (${budget.stop})`);
                }
            }
            // The handle is unchanged by rollouts and play of a clone: playing it now gives the same result.
            const again = state.playV01(60);
            if (JSON.stringify(again) !== JSON.stringify(r)) fail("the loaded state changed under rollouts");
            state.free();
            state = undefined as any;
            checked += 1;
        }

        // Per-call overhead of the FFI boundary itself.
        const calls = 1_000_000;
        let t = performance.now();
        for (let i = 0; i < calls; i += 1) hocSymbols.hoc_abi_version();
        const noopNs = ((performance.now() - t) * 1e6) / calls;
        t = performance.now();
        for (let i = 0; i < calls; i += 1) hocSymbols.hoc_now_ns();
        const nowNs = ((performance.now() - t) * 1e6) / calls;

        console.log(
            `bridge smoke: ${checked} battles checked (${skipped} ended before their export point), ${failures.length} failures`,
        );
        if (checked) {
            console.log(
                `  export (exportBattleState + JSON.stringify): ${(exportMs / checked).toFixed(3)} ms, ${Math.round(exportBytes / checked / 1024)} KB per state`,
            );
            console.log(
                `  hoc_state_load (JSON parse + load in Zig, through FFI): ${((loadMs / loads) * 1000).toFixed(1)} us per call`,
            );
            console.log(
                `  hoc_rollouts: ${(Number(rolloutNs) / 1000 / rolloutPairs).toFixed(1)} us per rollout, ${(Number(rolloutNs) / Math.max(1, rolloutTurns)).toFixed(0)} ns per rollout turn (${rolloutPairs} rollouts, ${rolloutTurns} turns)`,
            );
        }
        console.log(`  FFI call: ${noopNs.toFixed(1)} ns (hoc_abi_version), ${nowNs.toFixed(1)} ns (hoc_now_ns)`);
    } finally {
        engine.free();
        rmSync(tmp, { recursive: true, force: true });
    }
    for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f}`);
    if (failures.length) process.exit(1);
}

main();
