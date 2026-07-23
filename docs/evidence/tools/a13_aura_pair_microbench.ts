#!/usr/bin/env bun

/**
 * A13 Workstream 3 sealed two-source-root aura refresh benchmark.
 *
 * The baseline arm always calls the production full-refresh oracle. The candidate arm calls
 * `refreshAuraEffectsIfNeeded` when the candidate exposes it, otherwise it fails the production-entry gate.
 * Both arms import their own production modules and `test/helpers/combat.ts` from distinct immutable roots.
 *
 * Evidence run:
 *   bun docs/evidence/tools/a13_aura_pair_microbench.ts \
 *     --baseline-root /absolute/path/to/baseline \
 *     --candidate-root /absolute/path/to/candidate \
 *     --out /tmp/a13-aura-pair.json
 *
 * Wiring smoke:
 *   bun docs/evidence/tools/a13_aura_pair_microbench.ts \
 *     --baseline-root /absolute/path/to/copy-a \
 *     --candidate-root /absolute/path/to/copy-b \
 *     --smoke --allow-identical-sources \
 *     --out /tmp/a13-aura-pair-smoke.json
 */

import { createHash } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = "heroes-of-crypto/a13-aura-pair-microbench/v1" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const DEFAULT_BLOCKS = 31;
const DEFAULT_TARGET_MS = 150;
const DEFAULT_WARMUP_MS = 750;
const DEFAULT_BOOTSTRAP_SAMPLES = 10_000;
const DEFAULT_BOOTSTRAP_SEED = 0xa13a_b005;
const SMOKE_BLOCKS = 3;
const SMOKE_TARGET_MS = 15;
const SMOKE_WARMUP_MS = 45;
const SMOKE_BOOTSTRAP_SAMPLES = 500;
const MAX_SHARED_CYCLES = 100_000;
const ALLOWED_SOURCE_DELTAS = new Set([
    "src/effects/effect_helper.ts",
    "src/simulation/battle_snapshot.ts",
    "src/units/units_holder.ts",
]);

type VariantName = "baseline" | "candidate";
type RefreshMode = "forced-full" | "conditional";
type ExactPrimitive = boolean | number | string | null | undefined;

interface IXY {
    x: number;
    y: number;
}

interface IAppliedSpellLike {
    getName(): string;
}

interface IAuraEffectLike {
    defaultProperties: Record<string, unknown>;
    getProperties(): Record<string, unknown>;
}

interface IUnitPropertiesLike extends Record<string, unknown> {
    id: string;
    attack_type: number;
    movement_type: number;
    luck: number;
    applied_buffs_descriptions: string[];
}

interface IUnitLike {
    getId(): string;
    getUnitProperties(): Readonly<IUnitPropertiesLike>;
    getAuraEffects(): IAuraEffectLike[];
    getBuffs(): IAppliedSpellLike[];
    getDebuffs(): IAppliedSpellLike[];
    setPosition(x: number, y: number): void;
    setStackPower(stackPower: number): void;
    applyEffect(effect: unknown): boolean;
    deleteEffect(effectName: string): void;
    deleteBuff(buffName: string): void;
    deleteDebuff(debuffName: string): void;
}

interface IUnitsHolderLike {
    getAllUnits(): ReadonlyMap<string, IUnitLike>;
    refreshAuraEffectsForAllUnits(): void;
    refreshAuraEffectsIfNeeded?: () => boolean;
}

interface IGridLike {
    readonly __gridBrand?: never;
}

interface IFightPropertiesLike {
    setGridType(gridType: number): void;
}

interface IFightStateManagerLike {
    getFightProperties(): IFightPropertiesLike;
}

interface IGridSettingsLike {
    getGridSize(): number;
    getMinX(): number;
    getStep(): number;
    getHalfStep(): number;
}

interface ICombatHelperModule {
    testGridSettings: IGridSettingsLike;
    createCombatTestContext(gridType?: number): {
        grid: IGridLike;
        unitsHolder: IUnitsHolderLike;
    };
    createTestUnit(options?: Record<string, unknown>): IUnitLike;
    placeUnit(grid: IGridLike, unitsHolder: IUnitsHolderLike, unit: IUnitLike, cell: IXY): void;
}

interface IEffectFactoryLike {
    makeEffect(name: string | null): unknown;
}

interface IEffectFactoryModule {
    EffectFactory: new () => IEffectFactoryLike;
}

interface IFightStateModule {
    FightStateManager: {
        getInstance(): IFightStateManagerLike;
    };
}

interface IPBTypesModule {
    PBTypes: {
        AttackVals: {
            MELEE: number;
            RANGE: number;
        };
        GridVals: {
            NORMAL: number;
        };
        MovementVals: {
            FLY: number;
            WALK: number;
        };
        TeamVals: {
            LOWER: number;
            UPPER: number;
        };
    };
}

interface IGridMathModule {
    getPositionForCell(cell: IXY, minX: number, step: number, halfStep: number): IXY;
}

interface IBattleSnapshot {
    units: Map<string, Record<string, unknown>>;
    unitOrder: string[];
    grid: Record<string, unknown>;
    fight: Record<string, unknown>;
    holder: Record<string, unknown>;
}

interface IBattleSnapshotModule {
    snapshotBattle(
        unitsHolder: IUnitsHolderLike,
        grid: IGridLike,
        fightProperties: IFightPropertiesLike,
    ): IBattleSnapshot;
    restoreBattle(
        snapshot: IBattleSnapshot,
        unitsHolder: IUnitsHolderLike,
        grid: IGridLike,
        fightProperties: IFightPropertiesLike,
    ): void;
}

interface IEffectHelperModule {
    getAuraCellKeys(gridSettings: IGridSettingsLike, cell: IXY, auraRange: number): number[];
}

interface IVariantRuntime {
    name: VariantName;
    root: string;
    realRoot: string;
    helper: ICombatHelperModule;
    effectFactory: IEffectFactoryModule;
    fightState: IFightStateModule;
    pb: IPBTypesModule["PBTypes"];
    gridMath: IGridMathModule;
    snapshot: IBattleSnapshotModule;
    effectHelper: IEffectHelperModule;
}

interface IFixture {
    runtime: IVariantRuntime;
    grid: IGridLike;
    holder: IUnitsHolderLike;
    fightProperties: IFightPropertiesLike;
    units: ReadonlyMap<string, IUnitLike>;
    effectFactory: IEffectFactoryLike;
    stableStateSha256?: string;
}

interface IFixtureUnitSpec {
    key: string;
    id: string;
    team: "LOWER" | "UPPER";
    cell: IXY;
    attackType: "MELEE" | "RANGE";
    movementType: "WALK" | "FLY";
    luck: number;
    stackPower: number;
    auraEffects: readonly string[];
    abilities?: readonly string[];
}

type TimedEvent =
    | { id: string; kind: "noop" }
    | { id: string; kind: "set-cell"; unit: string; cell: IXY }
    | { id: string; kind: "set-stack"; unit: string; value: number }
    | { id: string; kind: "set-luck"; unit: string; value: number }
    | { id: string; kind: "set-break"; unit: string; active: boolean }
    | { id: string; kind: "set-attack"; unit: string; value: "MELEE" | "RANGE" }
    | { id: string; kind: "set-movement"; unit: string; value: "WALK" | "FLY" }
    | { id: string; kind: "cleanse-aura"; unit: string; aura: string };

interface IManifestEntry {
    path: string;
    kind: "file" | "symlink";
    mode: number;
    bytes: number;
    sha256: string;
    linkTarget?: string;
}

interface ISourceSeal {
    root: string;
    realRoot: string;
    srcEntries: IManifestEntry[];
    srcFileCount: number;
    srcBytes: number;
    srcTreeManifestSha256: string;
    combatHelperSha256: string;
}

interface IRunnerSeal {
    path: string;
    bytes: number;
    sha256: string;
}

interface ICliOptions {
    baselineRoot: string;
    candidateRoot: string;
    outPath: string;
    smoke: boolean;
    allowIdenticalSources: boolean;
    enforce: boolean;
    blocks: number;
    targetMs: number;
    warmupMs: number;
    bootstrapSamples: number;
}

interface ISemanticRow {
    phase: "live-shaped" | "snapshot-restore" | "malformed-state" | "malformed-geometry";
    eventId: string;
    baselineStateSha256: string;
    candidateStateSha256: string;
    identical: boolean;
    candidateRebuilt?: boolean;
}

interface IBatchSample {
    block: number;
    variant: VariantName;
    order: "AB" | "BA";
    cycles: number;
    calls: number;
    elapsedNs: number;
    nsPerCall: number;
    dirtyCalls: number;
    dirtyElapsedNs: number;
    dirtyNsPerCall: number;
    noOpCalls: number;
    noOpElapsedNs: number;
    noOpNsPerCall: number;
    candidateRebuilds: number;
    candidateNoops: number;
    stateSha256: string;
}

interface IInterval {
    lower95: number;
    median: number;
    upper95: number;
}

const FIXTURE_UNITS: readonly IFixtureUnitSpec[] = [
    {
        key: "lower-emitter-a",
        id: "00000000-0000-4000-8000-000000000001",
        team: "LOWER",
        cell: { x: 4, y: 4 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 4,
        stackPower: 3,
        auraEffects: ["Luck", "Flesh Shield", "Sharpened Weapons"],
    },
    {
        key: "lower-ranged",
        id: "00000000-0000-4000-8000-000000000002",
        team: "LOWER",
        cell: { x: 6, y: 4 },
        attackType: "RANGE",
        movementType: "WALK",
        luck: -2,
        stackPower: 2,
        auraEffects: [],
    },
    {
        key: "lower-emitter-b",
        id: "00000000-0000-4000-8000-000000000003",
        team: "LOWER",
        cell: { x: 4, y: 8 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 1,
        stackPower: 4,
        auraEffects: ["Disguise", "Tie up the Horses", "War Anger"],
        abilities: ["Disguise Aura"],
    },
    {
        key: "lower-flyer",
        id: "00000000-0000-4000-8000-000000000004",
        team: "LOWER",
        cell: { x: 6, y: 8 },
        attackType: "MELEE",
        movementType: "FLY",
        luck: 0,
        stackPower: 2,
        auraEffects: [],
    },
    {
        key: "lower-emitter-c",
        id: "00000000-0000-4000-8000-000000000005",
        team: "LOWER",
        cell: { x: 7, y: 6 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 3,
        stackPower: 5,
        auraEffects: ["Absorb Penalties", "Arrows Wingshield", "Pegasus Might"],
    },
    {
        key: "lower-melee",
        id: "00000000-0000-4000-8000-000000000006",
        team: "LOWER",
        cell: { x: 5, y: 6 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 2,
        stackPower: 2,
        auraEffects: [],
    },
    {
        key: "upper-emitter-a",
        id: "00000000-0000-4000-8000-000000000007",
        team: "UPPER",
        cell: { x: 8, y: 4 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: -1,
        stackPower: 4,
        auraEffects: ["Range Null Field", "Poison Cloud", "Web"],
    },
    {
        key: "upper-ranged",
        id: "00000000-0000-4000-8000-000000000008",
        team: "UPPER",
        cell: { x: 10, y: 4 },
        attackType: "RANGE",
        movementType: "WALK",
        luck: -3,
        stackPower: 3,
        auraEffects: [],
    },
    {
        key: "upper-emitter-b",
        id: "00000000-0000-4000-8000-000000000009",
        team: "UPPER",
        cell: { x: 8, y: 8 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 5,
        stackPower: 3,
        auraEffects: ["Luck", "Flesh Shield", "Sharpened Weapons"],
    },
    {
        key: "upper-flyer",
        id: "00000000-0000-4000-8000-00000000000a",
        team: "UPPER",
        cell: { x: 10, y: 8 },
        attackType: "MELEE",
        movementType: "FLY",
        luck: 0,
        stackPower: 2,
        auraEffects: [],
    },
    {
        key: "upper-emitter-c",
        id: "00000000-0000-4000-8000-00000000000b",
        team: "UPPER",
        cell: { x: 8, y: 6 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 2,
        stackPower: 4,
        auraEffects: ["Disguise", "Tie up the Horses", "War Anger"],
        abilities: ["Disguise Aura"],
    },
    {
        key: "upper-melee",
        id: "00000000-0000-4000-8000-00000000000c",
        team: "UPPER",
        cell: { x: 10, y: 6 },
        attackType: "MELEE",
        movementType: "WALK",
        luck: 1,
        stackPower: 2,
        auraEffects: [],
    },
] as const;

const DIRTY_EVENTS: readonly TimedEvent[] = [
    {
        id: "emitter-move-out",
        kind: "set-cell",
        unit: "lower-emitter-a",
        cell: { x: 2, y: 2 },
    },
    {
        id: "emitter-move-back",
        kind: "set-cell",
        unit: "lower-emitter-a",
        cell: { x: 4, y: 4 },
    },
    { id: "emitter-stack-up", kind: "set-stack", unit: "lower-emitter-a", value: 5 },
    { id: "emitter-stack-back", kind: "set-stack", unit: "lower-emitter-a", value: 3 },
    { id: "emitter-luck-up", kind: "set-luck", unit: "lower-emitter-a", value: 8 },
    { id: "emitter-luck-back", kind: "set-luck", unit: "lower-emitter-a", value: 4 },
    { id: "emitter-break-on", kind: "set-break", unit: "lower-emitter-a", active: true },
    { id: "emitter-break-off", kind: "set-break", unit: "lower-emitter-a", active: false },
    { id: "recipient-range-off", kind: "set-attack", unit: "upper-ranged", value: "MELEE" },
    { id: "recipient-range-back", kind: "set-attack", unit: "upper-ranged", value: "RANGE" },
    { id: "recipient-fly-off", kind: "set-movement", unit: "upper-flyer", value: "WALK" },
    { id: "recipient-fly-back", kind: "set-movement", unit: "upper-flyer", value: "FLY" },
    { id: "recipient-cleanse", kind: "cleanse-aura", unit: "lower-ranged", aura: "Luck Aura" },
] as const;

const TIMED_EVENTS: readonly TimedEvent[] = DIRTY_EVENTS.flatMap((event, index) => [
    event,
    { id: `noop-after-${index.toString().padStart(2, "0")}`, kind: "noop" as const },
]);

const MALFORMED_GEOMETRY_CASES = [
    { id: "negative-range", cell: { x: 5, y: 5 }, range: -1 },
    { id: "fractional-range", cell: { x: 5, y: 5 }, range: 1.5 },
    { id: "nan-range", cell: { x: 5, y: 5 }, range: Number.NaN },
    { id: "negative-cell", cell: { x: -1, y: 5 }, range: 2 },
    { id: "fractional-cell", cell: { x: 5.5, y: 5 }, range: 2 },
    { id: "off-grid-cell", cell: { x: 16, y: 5 }, range: 2 },
] as const;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function float64Bits(value: number): string {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

function exactValue(value: unknown, ancestors: ReadonlySet<object> = new Set()): unknown {
    if (value === undefined) {
        return { $undefined: true };
    }
    if (typeof value === "number") {
        return { $float64: float64Bits(value) };
    }
    if (typeof value === "bigint") {
        return { $bigint: value.toString() };
    }
    if (typeof value === "function" || typeof value === "symbol") {
        throw new Error(`Cannot canonicalize ${typeof value}`);
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (ancestors.has(value)) {
        throw new Error("Unexpected cycle in exact-value canonicalization");
    }
    if (value instanceof WeakMap || value instanceof WeakSet || value instanceof WeakRef) {
        throw new Error(`Cannot canonicalize ${value.constructor.name}`);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    if (value instanceof Map) {
        return {
            $map: [...value.entries()].map(([key, entry]) => [
                exactValue(key, nextAncestors),
                exactValue(entry, nextAncestors),
            ]),
        };
    }
    if (value instanceof Set) {
        return { $set: [...value].map((entry) => exactValue(entry, nextAncestors)) };
    }
    if (ArrayBuffer.isView(value)) {
        const view = value as unknown as { readonly length: number; readonly [index: number]: number };
        return {
            $typedArray: value.constructor.name,
            values: Array.from({ length: view.length }, (_, index) => exactValue(view[index], nextAncestors)),
        };
    }
    if (Array.isArray(value)) {
        return value.map((entry) => exactValue(entry, nextAncestors));
    }

    const maybeQueue = value as { toArray?: () => unknown[] };
    if (value.constructor?.name === "Denque" && typeof maybeQueue.toArray === "function") {
        return { $denque: maybeQueue.toArray().map((entry) => exactValue(entry, nextAncestors)) };
    }

    const record = value as Record<string, unknown>;
    return {
        $type: value.constructor?.name ?? "Object",
        fields: Object.keys(record)
            .sort()
            .map((key) => [key, exactValue(record[key], nextAncestors)]),
    };
}

const canonicalJson = (value: unknown): string => JSON.stringify(exactValue(value));
const digest = (value: unknown): string => sha256(canonicalJson(value));

function parseCli(): ICliOptions {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            "allow-identical-sources": { type: "boolean", default: false },
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            "no-enforce": { type: "boolean", default: false },
            out: { type: "string" },
            smoke: { type: "boolean", default: false },
        },
        strict: true,
    });
    const baselineRoot = parsed.values["baseline-root"];
    const candidateRoot = parsed.values["candidate-root"];
    const outPath = parsed.values.out;
    if (!baselineRoot || !candidateRoot || !outPath) {
        throw new Error("--baseline-root, --candidate-root, and --out are required");
    }
    const smoke = parsed.values.smoke;
    const allowIdenticalSources = parsed.values["allow-identical-sources"];
    if (allowIdenticalSources && !smoke) {
        throw new Error("--allow-identical-sources is restricted to --smoke");
    }

    return {
        baselineRoot: resolve(baselineRoot),
        candidateRoot: resolve(candidateRoot),
        outPath: resolve(outPath),
        smoke,
        allowIdenticalSources,
        enforce: !parsed.values["no-enforce"],
        blocks: smoke ? SMOKE_BLOCKS : DEFAULT_BLOCKS,
        targetMs: smoke ? SMOKE_TARGET_MS : DEFAULT_TARGET_MS,
        warmupMs: smoke ? SMOKE_WARMUP_MS : DEFAULT_WARMUP_MS,
        bootstrapSamples: smoke ? SMOKE_BOOTSTRAP_SAMPLES : DEFAULT_BOOTSTRAP_SAMPLES,
    };
}

function walkManifest(root: string, directory: string, output: IManifestEntry[]): void {
    for (const name of readdirSync(directory).sort()) {
        const absolute = join(directory, name);
        const info = lstatSync(absolute);
        if (info.isDirectory()) {
            walkManifest(root, absolute, output);
            continue;
        }
        const path = relative(root, absolute).split("\\").join("/");
        if (info.isSymbolicLink()) {
            const target = readlinkSync(absolute);
            output.push({
                path,
                kind: "symlink",
                mode: info.mode,
                bytes: Buffer.byteLength(target),
                sha256: sha256(target),
                linkTarget: target,
            });
            continue;
        }
        if (!info.isFile()) {
            throw new Error(`Unsupported source entry ${absolute}`);
        }
        const bytes = readFileSync(absolute);
        output.push({
            path,
            kind: "file",
            mode: info.mode,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
        });
    }
}

function sealSource(root: string): ISourceSeal {
    const realRoot = realpathSync(root);
    const src = join(realRoot, "src");
    const helper = join(realRoot, "test/helpers/combat.ts");
    if (!statSync(src).isDirectory() || !statSync(helper).isFile()) {
        throw new Error(`Source root is missing src or test/helpers/combat.ts: ${root}`);
    }
    const srcEntries: IManifestEntry[] = [];
    walkManifest(realRoot, src, srcEntries);
    return {
        root,
        realRoot,
        srcEntries,
        srcFileCount: srcEntries.length,
        srcBytes: srcEntries.reduce((sum, entry) => sum + entry.bytes, 0),
        srcTreeManifestSha256: digest(srcEntries),
        combatHelperSha256: sha256(readFileSync(helper)),
    };
}

function sealRunner(): IRunnerSeal {
    const bytes = readFileSync(RUNNER_PATH);
    return { path: RUNNER_PATH, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sameSourceSeal(left: ISourceSeal, right: ISourceSeal): boolean {
    return (
        left.realRoot === right.realRoot &&
        left.srcTreeManifestSha256 === right.srcTreeManifestSha256 &&
        left.combatHelperSha256 === right.combatHelperSha256
    );
}

function sourceDelta(
    baseline: ISourceSeal,
    candidate: ISourceSeal,
): {
    changed: string[];
    added: string[];
    deleted: string[];
    allowed: boolean;
    identical: boolean;
} {
    const left = new Map(baseline.srcEntries.map((entry) => [entry.path, entry]));
    const right = new Map(candidate.srcEntries.map((entry) => [entry.path, entry]));
    const changed: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const [path, entry] of left) {
        const other = right.get(path);
        if (!other) {
            deleted.push(path);
        } else if (canonicalJson(entry) !== canonicalJson(other)) {
            changed.push(path);
        }
    }
    for (const path of right.keys()) {
        if (!left.has(path)) {
            added.push(path);
        }
    }
    changed.sort();
    added.sort();
    deleted.sort();
    return {
        changed,
        added,
        deleted,
        allowed:
            added.length === 0 &&
            deleted.length === 0 &&
            changed.every((path) => ALLOWED_SOURCE_DELTAS.has(path)) &&
            baseline.combatHelperSha256 === candidate.combatHelperSha256,
        identical: changed.length === 0 && added.length === 0 && deleted.length === 0,
    };
}

async function importFrom<T>(root: string, path: string): Promise<T> {
    return (await import(pathToFileURL(join(root, path)).href)) as T;
}

async function loadRuntime(name: VariantName, root: string): Promise<IVariantRuntime> {
    const realRoot = realpathSync(root);
    const [helper, effectFactory, fightState, pbModule, gridMath, snapshot, effectHelper] = await Promise.all([
        importFrom<ICombatHelperModule>(realRoot, "test/helpers/combat.ts"),
        importFrom<IEffectFactoryModule>(realRoot, "src/effects/effect_factory.ts"),
        importFrom<IFightStateModule>(realRoot, "src/fights/fight_state_manager.ts"),
        importFrom<IPBTypesModule>(realRoot, "src/generated/protobuf/v1/types.ts"),
        importFrom<IGridMathModule>(realRoot, "src/grid/grid_math.ts"),
        importFrom<IBattleSnapshotModule>(realRoot, "src/simulation/battle_snapshot.ts"),
        importFrom<IEffectHelperModule>(realRoot, "src/effects/effect_helper.ts"),
    ]);
    return {
        name,
        root,
        realRoot,
        helper,
        effectFactory,
        fightState,
        pb: pbModule.PBTypes,
        gridMath,
        snapshot,
        effectHelper,
    };
}

function forceUnitId(unit: IUnitLike, id: string): void {
    const properties = unit.getUnitProperties() as IUnitPropertiesLike;
    properties.id = id;
    const internals = unit as unknown as { initialUnitProperties: { id: string } };
    internals.initialUnitProperties.id = id;
}

function buildFixture(runtime: IVariantRuntime): IFixture {
    const { grid, unitsHolder } = runtime.helper.createCombatTestContext(runtime.pb.GridVals.NORMAL);
    const fightProperties = runtime.fightState.FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(runtime.pb.GridVals.NORMAL);
    const units = new Map<string, IUnitLike>();

    for (const spec of FIXTURE_UNITS) {
        const unit = runtime.helper.createTestUnit({
            name: spec.key,
            team: runtime.pb.TeamVals[spec.team],
            attackType: runtime.pb.AttackVals[spec.attackType],
            movementType: runtime.pb.MovementVals[spec.movementType],
            luck: spec.luck,
            stackPower: spec.stackPower,
            rangeShots: spec.attackType === "RANGE" ? 8 : 0,
            auraEffects: [...spec.auraEffects],
            abilities: [...(spec.abilities ?? [])],
            amountAlive: 10,
            exp: 10,
        });
        forceUnitId(unit, spec.id);
        runtime.helper.placeUnit(grid, unitsHolder, unit, { ...spec.cell });
        units.set(spec.key, unit);
    }

    return {
        runtime,
        grid,
        holder: unitsHolder,
        fightProperties,
        units,
        effectFactory: new runtime.effectFactory.EffectFactory(),
    };
}

function fixtureUnit(fixture: IFixture, key: string): IUnitLike {
    const unit = fixture.units.get(key);
    if (!unit) {
        throw new Error(`Unknown fixture unit ${key}`);
    }
    return unit;
}

function positionForCell(fixture: IFixture, cell: IXY): IXY {
    const settings = fixture.runtime.helper.testGridSettings;
    return fixture.runtime.gridMath.getPositionForCell(
        cell,
        settings.getMinX(),
        settings.getStep(),
        settings.getHalfStep(),
    );
}

function applyEvent(fixture: IFixture, event: TimedEvent): void {
    if (event.kind === "noop") {
        return;
    }
    const unit = fixtureUnit(fixture, event.unit);
    if (event.kind === "set-cell") {
        const position = positionForCell(fixture, event.cell);
        unit.setPosition(position.x, position.y);
        return;
    }
    if (event.kind === "set-stack") {
        unit.setStackPower(event.value);
        return;
    }
    if (event.kind === "set-luck") {
        (unit.getUnitProperties() as IUnitPropertiesLike).luck = event.value;
        return;
    }
    if (event.kind === "set-break") {
        if (event.active) {
            const effect = fixture.effectFactory.makeEffect("Break");
            if (!effect || !unit.applyEffect(effect)) {
                throw new Error(`Could not apply Break for ${event.id}`);
            }
        } else {
            unit.deleteEffect("Break");
        }
        return;
    }
    if (event.kind === "set-attack") {
        (unit.getUnitProperties() as IUnitPropertiesLike).attack_type = fixture.runtime.pb.AttackVals[event.value];
        return;
    }
    if (event.kind === "set-movement") {
        (unit.getUnitProperties() as IUnitPropertiesLike).movement_type = fixture.runtime.pb.MovementVals[event.value];
        return;
    }

    const auraBuff = unit.getBuffs().find((buff) => buff.getName() === event.aura);
    const auraDebuff = unit.getDebuffs().find((debuff) => debuff.getName() === event.aura);
    if (auraBuff) {
        unit.deleteBuff(event.aura);
    } else if (auraDebuff) {
        unit.deleteDebuff(event.aura);
    } else {
        throw new Error(`Expected ${event.aura} on ${event.unit} before ${event.id}`);
    }
}

function refreshFixture(fixture: IFixture, mode: RefreshMode): boolean {
    if (mode === "conditional") {
        const conditional = fixture.holder.refreshAuraEffectsIfNeeded;
        if (typeof conditional !== "function") {
            fixture.holder.refreshAuraEffectsForAllUnits();
            return true;
        }
        return conditional.call(fixture.holder);
    }
    fixture.holder.refreshAuraEffectsForAllUnits();
    return true;
}

function semanticState(fixture: IFixture): unknown {
    const snapshot = fixture.runtime.snapshot.snapshotBattle(fixture.holder, fixture.grid, fixture.fightProperties);
    const fight = { ...snapshot.fight };
    delete fight.id;
    delete fight.currentTurnStart;
    delete fight.currentTurnEnd;
    delete fight.currentLapTotalTimePerTeam;
    const holder = { ...snapshot.holder };
    delete holder.auraRefreshFingerprint;
    delete holder.auraRefreshKnownEmpty;
    return {
        unitOrder: snapshot.unitOrder,
        units: snapshot.units,
        grid: snapshot.grid,
        fight,
        holder,
    };
}

function stateJson(fixture: IFixture): string {
    return canonicalJson(semanticState(fixture));
}

function compareSemanticState(
    phase: ISemanticRow["phase"],
    eventId: string,
    baseline: IFixture,
    candidate: IFixture,
    rows: ISemanticRow[],
    candidateRebuilt?: boolean,
): void {
    const baselineJson = stateJson(baseline);
    const candidateJson = stateJson(candidate);
    rows.push({
        phase,
        eventId,
        baselineStateSha256: sha256(baselineJson),
        candidateStateSha256: sha256(candidateJson),
        identical: baselineJson === candidateJson,
        ...(candidateRebuilt === undefined ? {} : { candidateRebuilt }),
    });
}

function runLiveSemantics(
    baselineRuntime: IVariantRuntime,
    candidateRuntime: IVariantRuntime,
): {
    rows: ISemanticRow[];
    passed: boolean;
    traceSha256: string;
    workloadSha256: string;
} {
    const baseline = buildFixture(baselineRuntime);
    const candidate = buildFixture(candidateRuntime);
    const rows: ISemanticRow[] = [];

    refreshFixture(baseline, "forced-full");
    const candidatePrime = refreshFixture(candidate, "conditional");
    compareSemanticState("live-shaped", "initial-refresh", baseline, candidate, rows, candidatePrime);

    for (const event of TIMED_EVENTS) {
        applyEvent(baseline, event);
        applyEvent(candidate, event);
        refreshFixture(baseline, "forced-full");
        const candidateRebuilt = refreshFixture(candidate, "conditional");
        compareSemanticState("live-shaped", event.id, baseline, candidate, rows, candidateRebuilt);
    }

    const baselineSnapshot = baselineRuntime.snapshot.snapshotBattle(
        baseline.holder,
        baseline.grid,
        baseline.fightProperties,
    );
    const candidateSnapshot = candidateRuntime.snapshot.snapshotBattle(
        candidate.holder,
        candidate.grid,
        candidate.fightProperties,
    );
    const dirtyEvent: TimedEvent = {
        id: "restore-probe-move",
        kind: "set-cell",
        unit: "upper-emitter-a",
        cell: { x: 13, y: 13 },
    };
    applyEvent(baseline, dirtyEvent);
    applyEvent(candidate, dirtyEvent);
    refreshFixture(baseline, "forced-full");
    const candidateDirty = refreshFixture(candidate, "conditional");
    compareSemanticState("snapshot-restore", dirtyEvent.id, baseline, candidate, rows, candidateDirty);

    baselineRuntime.snapshot.restoreBattle(baselineSnapshot, baseline.holder, baseline.grid, baseline.fightProperties);
    candidateRuntime.snapshot.restoreBattle(
        candidateSnapshot,
        candidate.holder,
        candidate.grid,
        candidate.fightProperties,
    );
    compareSemanticState("snapshot-restore", "restored-before-refresh", baseline, candidate, rows);
    refreshFixture(baseline, "forced-full");
    const candidateRestored = refreshFixture(candidate, "conditional");
    compareSemanticState("snapshot-restore", "restored-after-refresh", baseline, candidate, rows, candidateRestored);

    return {
        rows,
        passed: rows.every((row) => row.identical),
        traceSha256: digest(rows),
        workloadSha256: digest({
            fixtureUnits: FIXTURE_UNITS,
            timedEvents: TIMED_EVENTS,
            snapshotRestoreEvent: dirtyEvent,
        }),
    };
}

function runMalformedSemantics(
    baselineRuntime: IVariantRuntime,
    candidateRuntime: IVariantRuntime,
): {
    rows: ISemanticRow[];
    passed: boolean;
    traceSha256: string;
    workloadSha256: string;
} {
    const rows: ISemanticRow[] = [];
    const baseline = buildFixture(baselineRuntime);
    const candidate = buildFixture(candidateRuntime);
    refreshFixture(baseline, "forced-full");
    refreshFixture(candidate, "conditional");

    for (const fixture of [baseline, candidate]) {
        const aura = fixtureUnit(fixture, "lower-emitter-a").getAuraEffects()[0];
        if (!aura) {
            throw new Error("Malformed-state fixture is missing its first aura");
        }
        aura.defaultProperties.experimental = 1;
    }
    refreshFixture(baseline, "forced-full");
    const candidateExtended = refreshFixture(candidate, "conditional");
    compareSemanticState("malformed-state", "extended-aura-properties", baseline, candidate, rows, candidateExtended);

    for (const fixture of [baseline, candidate]) {
        const aura = fixtureUnit(fixture, "lower-emitter-a").getAuraEffects()[0];
        delete aura.defaultProperties.experimental;
    }
    refreshFixture(baseline, "forced-full");
    const candidateRecovered = refreshFixture(candidate, "conditional");
    compareSemanticState("malformed-state", "restored-aura-properties", baseline, candidate, rows, candidateRecovered);

    for (const fixture of [baseline, candidate]) {
        const properties = fixtureUnit(fixture, "lower-ranged").getUnitProperties() as IUnitPropertiesLike;
        properties.applied_buffs_descriptions.push("malformed-extra-description");
    }
    refreshFixture(baseline, "forced-full");
    const candidateMalformedArray = refreshFixture(candidate, "conditional");
    compareSemanticState(
        "malformed-state",
        "misaligned-applied-buff-arrays",
        baseline,
        candidate,
        rows,
        candidateMalformedArray,
    );

    refreshFixture(baseline, "forced-full");
    const candidateMalformedNoop = refreshFixture(candidate, "conditional");
    compareSemanticState(
        "malformed-state",
        "misaligned-applied-buff-arrays-repeat",
        baseline,
        candidate,
        rows,
        candidateMalformedNoop,
    );

    for (const geometryCase of MALFORMED_GEOMETRY_CASES) {
        const baselineCell = { ...geometryCase.cell };
        const candidateCell = { ...geometryCase.cell };
        const baselineBefore = canonicalJson(baselineCell);
        const candidateBefore = canonicalJson(candidateCell);
        const baselineResult = baselineRuntime.effectHelper.getAuraCellKeys(
            baselineRuntime.helper.testGridSettings,
            baselineCell,
            geometryCase.range,
        );
        const candidateResult = candidateRuntime.effectHelper.getAuraCellKeys(
            candidateRuntime.helper.testGridSettings,
            candidateCell,
            geometryCase.range,
        );
        const baselineState = canonicalJson({
            result: baselineResult,
            inputUnchanged: baselineBefore === canonicalJson(baselineCell),
        });
        const candidateState = canonicalJson({
            result: candidateResult,
            inputUnchanged: candidateBefore === canonicalJson(candidateCell),
        });
        rows.push({
            phase: "malformed-geometry",
            eventId: geometryCase.id,
            baselineStateSha256: sha256(baselineState),
            candidateStateSha256: sha256(candidateState),
            identical: baselineState === candidateState,
        });
    }

    return {
        rows,
        passed: rows.every((row) => row.identical),
        traceSha256: digest(rows),
        workloadSha256: digest({
            malformedStateCases: [
                "extended-aura-properties",
                "restored-aura-properties",
                "misaligned-applied-buff-arrays",
                "misaligned-applied-buff-arrays-repeat",
            ],
            malformedGeometryCases: MALFORMED_GEOMETRY_CASES,
        }),
    };
}

function runBatch(
    fixture: IFixture,
    mode: RefreshMode,
    cycles: number,
    block: number,
    order: "AB" | "BA",
): IBatchSample {
    let elapsedNs = 0n;
    let dirtyElapsedNs = 0n;
    let noOpElapsedNs = 0n;
    let candidateRebuilds = 0;
    let candidateNoops = 0;

    for (let cycle = 0; cycle < cycles; cycle++) {
        for (const event of TIMED_EVENTS) {
            applyEvent(fixture, event);
            const started = process.hrtime.bigint();
            const rebuilt = refreshFixture(fixture, mode);
            const duration = process.hrtime.bigint() - started;
            elapsedNs += duration;
            if (event.kind === "noop") {
                noOpElapsedNs += duration;
            } else {
                dirtyElapsedNs += duration;
            }
            if (mode === "conditional") {
                if (rebuilt) {
                    candidateRebuilds++;
                } else {
                    candidateNoops++;
                }
            }
        }
    }

    const stateSha256 = digest(semanticState(fixture));
    if (fixture.stableStateSha256 && stateSha256 !== fixture.stableStateSha256) {
        throw new Error(
            `${fixture.runtime.name} timed workload did not return to its stable state: ` +
                `${stateSha256} != ${fixture.stableStateSha256}`,
        );
    }
    const calls = cycles * TIMED_EVENTS.length;
    const dirtyCalls = cycles * DIRTY_EVENTS.length;
    const noOpCalls = calls - dirtyCalls;
    return {
        block,
        variant: fixture.runtime.name,
        order,
        cycles,
        calls,
        elapsedNs: Number(elapsedNs),
        nsPerCall: Number(elapsedNs) / calls,
        dirtyCalls,
        dirtyElapsedNs: Number(dirtyElapsedNs),
        dirtyNsPerCall: Number(dirtyElapsedNs) / dirtyCalls,
        noOpCalls,
        noOpElapsedNs: Number(noOpElapsedNs),
        noOpNsPerCall: Number(noOpElapsedNs) / noOpCalls,
        candidateRebuilds,
        candidateNoops,
        stateSha256,
    };
}

function quantile(values: readonly number[], probability: number): number {
    if (!values.length) {
        return Number.NaN;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function summarize(values: readonly number[]): {
    count: number;
    min: number;
    median: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
} {
    return {
        count: values.length,
        min: Math.min(...values),
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        p99: quantile(values, 0.99),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
}

function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function interval(values: readonly number[]): IInterval {
    return {
        lower95: quantile(values, 0.025),
        median: quantile(values, 0.5),
        upper95: quantile(values, 0.975),
    };
}

function pairedBootstrap(
    baseline: readonly IBatchSample[],
    candidate: readonly IBatchSample[],
    samples: number,
): {
    method: string;
    samples: number;
    seedHex: string;
    medianReduction: IInterval;
    medianRatio: IInterval;
    p95Ratio: IInterval;
    p99Ratio: IInterval;
} {
    if (baseline.length !== candidate.length || !baseline.length) {
        throw new Error("Paired bootstrap requires equal non-empty block arrays");
    }
    const random = makeRng(DEFAULT_BOOTSTRAP_SEED);
    const medianReductions: number[] = [];
    const medianRatios: number[] = [];
    const p95Ratios: number[] = [];
    const p99Ratios: number[] = [];

    for (let sample = 0; sample < samples; sample++) {
        const baselineResample: number[] = [];
        const candidateResample: number[] = [];
        for (let i = 0; i < baseline.length; i++) {
            const index = Math.floor(random() * baseline.length);
            baselineResample.push(baseline[index].nsPerCall);
            candidateResample.push(candidate[index].nsPerCall);
        }
        const baselineMedian = quantile(baselineResample, 0.5);
        const candidateMedian = quantile(candidateResample, 0.5);
        const medianRatio = candidateMedian / baselineMedian;
        medianRatios.push(medianRatio);
        medianReductions.push(1 - medianRatio);
        p95Ratios.push(quantile(candidateResample, 0.95) / quantile(baselineResample, 0.95));
        p99Ratios.push(quantile(candidateResample, 0.99) / quantile(baselineResample, 0.99));
    }

    return {
        method: "paired nonparametric bootstrap; whole alternating AB/BA blocks resampled with replacement",
        samples,
        seedHex: `0x${DEFAULT_BOOTSTRAP_SEED.toString(16)}`,
        medianReduction: interval(medianReductions),
        medianRatio: interval(medianRatios),
        p95Ratio: interval(p95Ratios),
        p99Ratio: interval(p99Ratios),
    };
}

function runBenchmark(
    baselineRuntime: IVariantRuntime,
    candidateRuntime: IVariantRuntime,
    cli: ICliOptions,
): {
    candidateConditionalAvailable: boolean;
    calibration: Record<string, unknown>;
    warmup: Record<string, unknown>;
    settling: Record<string, unknown>;
    blocks: { baseline: IBatchSample[]; candidate: IBatchSample[] };
    summaries: Record<string, unknown>;
    observed: Record<string, number>;
    bootstrap: ReturnType<typeof pairedBootstrap>;
    checksumsEqual: boolean;
} {
    const baseline = buildFixture(baselineRuntime);
    const candidate = buildFixture(candidateRuntime);
    refreshFixture(baseline, "forced-full");
    refreshFixture(candidate, "conditional");
    const stableBaselineSha = digest(semanticState(baseline));
    const stableCandidateSha = digest(semanticState(candidate));
    if (stableBaselineSha !== stableCandidateSha) {
        throw new Error(`Benchmark fixtures differ after prime: ${stableBaselineSha} != ${stableCandidateSha}`);
    }
    baseline.stableStateSha256 = stableBaselineSha;
    candidate.stableStateSha256 = stableCandidateSha;

    const candidateConditionalAvailable = typeof candidate.holder.refreshAuraEffectsIfNeeded === "function";
    const pilotCycles = cli.smoke ? 1 : 3;
    const pilotBaseline = runBatch(baseline, "forced-full", pilotCycles, -3, "AB");
    const pilotCandidate = runBatch(candidate, "conditional", pilotCycles, -3, "AB");
    const slowerNsPerCycle = Math.max(pilotBaseline.elapsedNs, pilotCandidate.elapsedNs) / Math.max(1, pilotCycles);
    const sharedCycles = Math.max(
        1,
        Math.min(MAX_SHARED_CYCLES, Math.ceil((cli.targetMs * 1_000_000) / slowerNsPerCycle)),
    );
    const estimatedSlowerBatchMs = (slowerNsPerCycle * sharedCycles) / 1_000_000;
    const warmupBatches = Math.max(1, Math.ceil(cli.warmupMs / estimatedSlowerBatchMs));
    const warmupSamples: IBatchSample[] = [];
    for (let batch = 0; batch < warmupBatches; batch++) {
        if (batch % 2 === 0) {
            warmupSamples.push(runBatch(baseline, "forced-full", sharedCycles, -2, "AB"));
            warmupSamples.push(runBatch(candidate, "conditional", sharedCycles, -2, "AB"));
        } else {
            warmupSamples.push(runBatch(candidate, "conditional", sharedCycles, -2, "BA"));
            warmupSamples.push(runBatch(baseline, "forced-full", sharedCycles, -2, "BA"));
        }
    }

    const settlingBaseline: IBatchSample[] = [];
    const settlingCandidate: IBatchSample[] = [];
    settlingBaseline.push(runBatch(baseline, "forced-full", sharedCycles, -1, "AB"));
    settlingCandidate.push(runBatch(candidate, "conditional", sharedCycles, -1, "AB"));
    settlingCandidate.push(runBatch(candidate, "conditional", sharedCycles, -1, "BA"));
    settlingBaseline.push(runBatch(baseline, "forced-full", sharedCycles, -1, "BA"));

    const baselineBlocks: IBatchSample[] = [];
    const candidateBlocks: IBatchSample[] = [];
    for (let block = 0; block < cli.blocks; block++) {
        const order = block % 2 === 0 ? "AB" : "BA";
        if (order === "AB") {
            baselineBlocks.push(runBatch(baseline, "forced-full", sharedCycles, block, order));
            candidateBlocks.push(runBatch(candidate, "conditional", sharedCycles, block, order));
        } else {
            candidateBlocks.push(runBatch(candidate, "conditional", sharedCycles, block, order));
            baselineBlocks.push(runBatch(baseline, "forced-full", sharedCycles, block, order));
        }
    }

    const baselineValues = baselineBlocks.map((sample) => sample.nsPerCall);
    const candidateValues = candidateBlocks.map((sample) => sample.nsPerCall);
    const baselineSummary = summarize(baselineValues);
    const candidateSummary = summarize(candidateValues);
    const baselineDirtySummary = summarize(baselineBlocks.map((sample) => sample.dirtyNsPerCall));
    const candidateDirtySummary = summarize(candidateBlocks.map((sample) => sample.dirtyNsPerCall));
    const baselineNoOpSummary = summarize(baselineBlocks.map((sample) => sample.noOpNsPerCall));
    const candidateNoOpSummary = summarize(candidateBlocks.map((sample) => sample.noOpNsPerCall));
    const bootstrap = pairedBootstrap(baselineBlocks, candidateBlocks, cli.bootstrapSamples);
    const checksumsEqual =
        stableBaselineSha === stableCandidateSha &&
        settlingBaseline.every((sample, index) => sample.stateSha256 === settlingCandidate[index]?.stateSha256) &&
        baselineBlocks.every((sample, index) => sample.stateSha256 === candidateBlocks[index]?.stateSha256);

    return {
        candidateConditionalAvailable,
        calibration: {
            pilotCycles,
            pilotBaseline,
            pilotCandidate,
            sharedCycles,
            sharedCallsPerBlock: sharedCycles * TIMED_EVENTS.length,
            targetMs: cli.targetMs,
            estimatedSlowerBatchMs,
        },
        warmup: {
            targetMsPerArm: cli.warmupMs,
            identicalLogicalBatchesPerArm: warmupBatches,
            samples: warmupSamples,
        },
        settling: {
            description: "two full-size blocks after calibration in AB then BA order",
            baseline: settlingBaseline,
            candidate: settlingCandidate,
        },
        blocks: { baseline: baselineBlocks, candidate: candidateBlocks },
        summaries: {
            baselineNsPerCall: baselineSummary,
            candidateNsPerCall: candidateSummary,
            dirtyNsPerCall: {
                baseline: baselineDirtySummary,
                candidate: candidateDirtySummary,
                medianRatio: candidateDirtySummary.median / baselineDirtySummary.median,
            },
            noOpNsPerCall: {
                baseline: baselineNoOpSummary,
                candidate: candidateNoOpSummary,
                medianRatio: candidateNoOpSummary.median / baselineNoOpSummary.median,
            },
            candidateRefreshDecisions: {
                rebuilds: candidateBlocks.reduce((sum, sample) => sum + sample.candidateRebuilds, 0),
                noops: candidateBlocks.reduce((sum, sample) => sum + sample.candidateNoops, 0),
            },
        },
        observed: {
            medianRatio: candidateSummary.median / baselineSummary.median,
            medianReduction: 1 - candidateSummary.median / baselineSummary.median,
            p95Ratio: candidateSummary.p95 / baselineSummary.p95,
            p99Ratio: candidateSummary.p99 / baselineSummary.p99,
        },
        bootstrap,
        checksumsEqual,
    };
}

function hostSnapshot(): Record<string, unknown> {
    return {
        capturedAt: new Date().toISOString(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        loadAverage: loadavg(),
        freeMemoryBytes: freemem(),
        totalMemoryBytes: totalmem(),
    };
}

async function main(): Promise<void> {
    const cli = parseCli();
    if (existsSync(cli.outPath)) {
        throw new Error(`Refusing to overwrite ${cli.outPath}`);
    }
    const runnerBefore = sealRunner();
    const baselineBefore = sealSource(cli.baselineRoot);
    const candidateBefore = sealSource(cli.candidateRoot);
    if (baselineBefore.realRoot === candidateBefore.realRoot && !cli.allowIdenticalSources) {
        throw new Error("Baseline and candidate roots resolve to the same directory");
    }
    const delta = sourceDelta(baselineBefore, candidateBefore);
    if (!delta.allowed) {
        throw new Error(
            `Unexpected source delta: changed=${delta.changed.join(",")} added=${delta.added.join(",")} ` +
                `deleted=${delta.deleted.join(",")}`,
        );
    }
    if (delta.identical && !cli.allowIdenticalSources) {
        throw new Error("Baseline and candidate source trees are identical");
    }

    const integrityChecks: Array<Record<string, unknown>> = [];
    const assertIntegrity = (phase: string): void => {
        const baseline = sealSource(cli.baselineRoot);
        const candidate = sealSource(cli.candidateRoot);
        const runner = sealRunner();
        const passed =
            sameSourceSeal(baselineBefore, baseline) &&
            sameSourceSeal(candidateBefore, candidate) &&
            runner.sha256 === runnerBefore.sha256;
        integrityChecks.push({
            phase,
            passed,
            baselineSrcTreeManifestSha256: baseline.srcTreeManifestSha256,
            candidateSrcTreeManifestSha256: candidate.srcTreeManifestSha256,
            runnerSha256: runner.sha256,
        });
        if (!passed) {
            throw new Error(`Source or runner integrity changed during ${phase}`);
        }
    };

    const hostBefore = hostSnapshot();
    const [baselineRuntime, candidateRuntime] = await Promise.all([
        loadRuntime("baseline", cli.baselineRoot),
        loadRuntime("candidate", cli.candidateRoot),
    ]);
    const liveSemantics = runLiveSemantics(baselineRuntime, candidateRuntime);
    assertIntegrity("after-live-semantics");

    const benchmark = runBenchmark(baselineRuntime, candidateRuntime, cli);
    assertIntegrity("after-timing");

    // Edge-only and malformed shapes intentionally execute after all timing so they cannot poison JIT feedback.
    const malformedSemantics = runMalformedSemantics(baselineRuntime, candidateRuntime);
    assertIntegrity("after-malformed-semantics");
    assertIntegrity("final");

    const semanticPassed = liveSemantics.passed && malformedSemantics.passed;
    const performanceApplicable =
        !cli.smoke && !delta.identical && benchmark.candidateConditionalAvailable && cli.blocks === DEFAULT_BLOCKS;
    const gates = [
        {
            id: "source-delta",
            threshold: `only modified files within ${[...ALLOWED_SOURCE_DELTAS].sort().join(", ")}`,
            observed: delta,
            applicable: true,
            passed: delta.allowed && (!delta.identical || cli.allowIdenticalSources),
        },
        {
            id: "source-runner-integrity",
            threshold: "all recursive src seals, combat helper bytes, and runner bytes unchanged at every phase",
            observed: integrityChecks.every((check) => check.passed === true),
            applicable: true,
            passed: integrityChecks.every((check) => check.passed === true),
        },
        {
            id: "exact-semantic-state",
            threshold: "zero exact state mismatch at every live, restore, and post-timing malformed boundary",
            observed: semanticPassed,
            applicable: true,
            passed: semanticPassed,
        },
        {
            id: "timed-checksums",
            threshold: "all baseline/candidate stable-state checksums equal",
            observed: benchmark.checksumsEqual,
            applicable: true,
            passed: benchmark.checksumsEqual,
        },
        {
            id: "candidate-production-entry",
            threshold: "candidate exposes refreshAuraEffectsIfNeeded",
            observed: benchmark.candidateConditionalAvailable,
            applicable: !cli.smoke,
            passed: cli.smoke || benchmark.candidateConditionalAvailable,
        },
        {
            id: "median-aura-reduction",
            threshold: "point estimate >= 30%",
            observed: benchmark.observed.medianReduction,
            applicable: performanceApplicable,
            passed: !performanceApplicable || benchmark.observed.medianReduction >= 0.3,
        },
        {
            id: "median-aura-reduction-lower95",
            threshold: "paired-bootstrap lower95 >= 25%",
            observed: benchmark.bootstrap.medianReduction.lower95,
            applicable: performanceApplicable,
            passed: !performanceApplicable || benchmark.bootstrap.medianReduction.lower95 >= 0.25,
        },
        {
            id: "block-average-p95-ratio-upper95",
            threshold: "paired-bootstrap upper95 <= 1.05",
            observed: benchmark.bootstrap.p95Ratio.upper95,
            applicable: performanceApplicable,
            passed: !performanceApplicable || benchmark.bootstrap.p95Ratio.upper95 <= 1.05,
        },
        {
            id: "block-average-p99-ratio-upper95",
            threshold: "paired-bootstrap upper95 <= 1.05",
            observed: benchmark.bootstrap.p99Ratio.upper95,
            applicable: performanceApplicable,
            passed: !performanceApplicable || benchmark.bootstrap.p99Ratio.upper95 <= 1.05,
        },
    ];
    const gatesPassed = gates.every((gate) => gate.passed);
    const workload = {
        schema: `${SCHEMA}/workload`,
        fixtureUnits: FIXTURE_UNITS,
        timedEvents: TIMED_EVENTS,
        dirtyEventCount: DIRTY_EVENTS.length,
        noOpEventCount: TIMED_EVENTS.filter((event) => event.kind === "noop").length,
        noOpFraction: TIMED_EVENTS.filter((event) => event.kind === "noop").length / TIMED_EVENTS.length,
        malformedGeometryCases: MALFORMED_GEOMETRY_CASES,
        liveSemanticWorkloadSha256: liveSemantics.workloadSha256,
        malformedSemanticWorkloadSha256: malformedSemantics.workloadSha256,
    };
    const report = {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        mode: cli.smoke ? "smoke" : "evidence",
        qualifying: performanceApplicable && gatesPassed,
        protocol: {
            blocks: cli.blocks,
            order: "31 alternating AB/BA timed blocks",
            settling: "two full-size blocks in AB then BA order after shared calibration",
            targetMsPerSlowerArm: cli.targetMs,
            warmupMsPerArm: cli.warmupMs,
            bootstrapSamples: cli.bootstrapSamples,
            bootstrapSeedHex: `0x${DEFAULT_BOOTSTRAP_SEED.toString(16)}`,
            timingScope:
                "sum of process.hrtime.bigint durations around aura refresh entry only; event mutation and state hashing excluded",
            malformedPhase:
                "all malformed aura-property, applied-array, and geometry cases execute only after timed blocks",
        },
        workload,
        workloadSha256: digest(workload),
        source: {
            allowedDeltaPaths: [...ALLOWED_SOURCE_DELTAS].sort(),
            delta,
            baseline: baselineBefore,
            candidate: candidateBefore,
            runnerBefore,
            integrityChecks,
        },
        host: {
            before: hostBefore,
            after: hostSnapshot(),
            qualification:
                "descriptive only; paired statistical gates determine local microbenchmark qualification, while release-level wall-clock claims require a separate idle/thermal/power-controlled run",
        },
        semantics: {
            passed: semanticPassed,
            live: liveSemantics,
            malformed: malformedSemantics,
            combinedTraceSha256: digest([...liveSemantics.rows, ...malformedSemantics.rows]),
        },
        benchmark,
        gates: {
            performanceApplicable,
            passed: gatesPassed,
            details: gates,
        },
    };

    mkdirSync(dirname(cli.outPath), { recursive: true });
    writeFileSync(cli.outPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(
        `${SCHEMA} mode=${report.mode} semantics=${semanticPassed ? "pass" : "fail"} ` +
            `medianReduction=${(benchmark.observed.medianReduction * 100).toFixed(2)}% ` +
            `gates=${gatesPassed ? "pass" : "fail"} out=${cli.outPath}`,
    );
    if (cli.enforce && !gatesPassed) {
        process.exitCode = 1;
    }
}

await main();
