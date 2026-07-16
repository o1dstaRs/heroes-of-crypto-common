/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import {
    aggregateV07AlignedV2,
    V07_ALIGNED_96H_V2_CELLS,
    V07_ALIGNED_96H_V2_SEATS,
    type IV07AlignedV2GameObservation,
    type V07AlignedV2CandidateSeat,
    type V07AlignedV2CellId,
    type V07AlignedV2Cohort,
} from "./v0_7_aligned_96h_v2_core";
import { normalizeV0796hGenome, type IV0796hGenome } from "./v0_7_96h_core";

export type V07AlignedV2PanelPurpose = "train" | "confirm" | "final";
export type V07AlignedV2Distribution = "ranked_taxonomy" | "fixed_template";
export type V07AlignedV2ScenarioProtocol = "independent_seat_conditioned" | "fixed_physical_side_swap";
export type V07AlignedV2Archetype = "mage" | "meleeMage" | "aura" | "ranged";
export type V07AlignedV2Template =
    | "mage_frontline"
    | "mage_fireline"
    | "melee_magic_utility"
    | "melee_magic_brawler"
    | "aura_support"
    | "aura_offense"
    | "ranged_precision"
    | "ranged_control";

export interface IV07AlignedV2EvaluatorCell {
    id: V07AlignedV2CellId;
    cohort: V07AlignedV2Cohort;
    distribution: V07AlignedV2Distribution;
    scenarioProtocol: V07AlignedV2ScenarioProtocol;
    archetype: V07AlignedV2Archetype;
    template?: V07AlignedV2Template;
    candidate: "v0.7s";
    opponent: "v0.6";
}

const V07_ALIGNED_V2_EVALUATOR_CELL_VALUES: IV07AlignedV2EvaluatorCell[] = [
    {
        id: "ranked_mage",
        cohort: "mage",
        distribution: "ranked_taxonomy",
        scenarioProtocol: "independent_seat_conditioned",
        archetype: "mage",
        candidate: "v0.7s",
        opponent: "v0.6",
    },
    {
        id: "ranked_melee_mage",
        cohort: "melee_mage",
        distribution: "ranked_taxonomy",
        scenarioProtocol: "independent_seat_conditioned",
        archetype: "meleeMage",
        candidate: "v0.7s",
        opponent: "v0.6",
    },
    {
        id: "ranked_aura",
        cohort: "aura",
        distribution: "ranked_taxonomy",
        scenarioProtocol: "independent_seat_conditioned",
        archetype: "aura",
        candidate: "v0.7s",
        opponent: "v0.6",
    },
    {
        id: "ranked_ranged",
        cohort: "ranged",
        distribution: "ranked_taxonomy",
        scenarioProtocol: "independent_seat_conditioned",
        archetype: "ranged",
        candidate: "v0.7s",
        opponent: "v0.6",
    },
    ...(
        [
            ["fixed_mage_frontline", "mage", "mage", "mage_frontline"],
            ["fixed_mage_fireline", "mage", "mage", "mage_fireline"],
            ["fixed_melee_magic_utility", "melee_mage", "meleeMage", "melee_magic_utility"],
            ["fixed_melee_magic_brawler", "melee_mage", "meleeMage", "melee_magic_brawler"],
            ["fixed_aura_support", "aura", "aura", "aura_support"],
            ["fixed_aura_offense", "aura", "aura", "aura_offense"],
            ["fixed_ranged_precision", "ranged", "ranged", "ranged_precision"],
            ["fixed_ranged_control", "ranged", "ranged", "ranged_control"],
        ] as const
    ).map(([id, cohort, archetype, template]): IV07AlignedV2EvaluatorCell => ({
        id,
        cohort,
        distribution: "fixed_template",
        scenarioProtocol: "fixed_physical_side_swap",
        archetype,
        template,
        candidate: "v0.7s",
        opponent: "v0.6",
    })),
];

export const V07_ALIGNED_V2_EVALUATOR_CELLS: readonly Readonly<IV07AlignedV2EvaluatorCell>[] = Object.freeze(
    V07_ALIGNED_V2_EVALUATOR_CELL_VALUES.map((cell) => Object.freeze({ ...cell })),
);

const CORE_CELL_IDENTITY = V07_ALIGNED_96H_V2_CELLS.map(({ id, cohort, distribution }) => ({
    id,
    cohort,
    distribution,
}));
const EVALUATOR_CELL_IDENTITY = V07_ALIGNED_V2_EVALUATOR_CELLS.map(({ id, cohort, distribution }) => ({
    id,
    cohort,
    distribution,
}));
if (JSON.stringify(CORE_CELL_IDENTITY) !== JSON.stringify(EVALUATOR_CELL_IDENTITY)) {
    throw new Error("aligned v2 evaluator registry drifted from the 24-claim policy core");
}

const CELL_BY_ID = new Map(V07_ALIGNED_V2_EVALUATOR_CELLS.map((cell) => [cell.id, cell]));
const CELL_ORDER = new Map(V07_ALIGNED_V2_EVALUATOR_CELLS.map((cell, index) => [cell.id, index]));
const SEAT_ORDER = new Map(V07_ALIGNED_96H_V2_SEATS.map((seat, index) => [seat, index]));

export const V07_ALIGNED_V2_TAXONOMY_SETUP_ATTEMPTS = 128;
export const V07_ALIGNED_V2_BEHAVIOR_ENV_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
export const V07_ALIGNED_V2_BEHAVIOR_ENV_EXACT = [
    "AUGCA_NOVISION",
    "BASE_VERSION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LEAGUE_INITIAL_POOL",
    "LEAGUE_MATRIX_FIGHT_VERSION",
    "LEAGUE_MATRIX_MAPS",
    "LIVETWIN",
    "MAPS",
    "OPT_VERSION",
    "OPT_WEIGHTS_ENV",
    "PHASE_B_RUN_FINGERPRINT",
    "RANDOM",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "SIM_NO_ACTIONS",
    "SYNERGY_DUMP",
    "TEAM_WR_RANDOM",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
] as const;

export const V07_ALIGNED_V2_FORBIDDEN_RUNTIME_ENV = [
    "BUN_CONFIG",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TS_NODE_PROJECT",
    "TS_NODE_TRANSPILE_ONLY",
] as const;

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

export function canonicalV07AlignedV2Json(value: unknown): string {
    return JSON.stringify(canonicalValue(value));
}

export function fingerprintV07AlignedV2(value: unknown): string {
    return createHash("sha256").update(canonicalV07AlignedV2Json(value)).digest("hex");
}

function stableEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}

export function isV07AlignedV2BehaviorEnvironmentKey(key: string): boolean {
    return (
        V07_ALIGNED_V2_BEHAVIOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        (V07_ALIGNED_V2_BEHAVIOR_ENV_EXACT as readonly string[]).includes(key)
    );
}

export const V07_ALIGNED_V2_CIRCUIT_BREAKER_MS = 275 as const;
export const V07_ALIGNED_V2_DECISION_DEADLINES_MS = [125, 150, 175, 200] as const;
export const V07_ALIGNED_V2_SHORTLISTS = [2, 3, 4] as const;
export const V07_ALIGNED_V2_LATE_RANGED_FINISH_WEIGHTS = [0, 2, 4] as const;
export const V07_ALIGNED_V2_PURE_RANGED_TERMINAL_WEIGHTS = [0, 0.5, 1] as const;
export const V07_ALIGNED_V2_MELEE_RANGED_TARGET_WEIGHTS = [0, 2] as const;
export const V07_ALIGNED_V2_AURA_CASTER_MODES = ["off", "windflow", "resurrection_windflow"] as const;

export type V07AlignedV2DecisionDeadlineMs = (typeof V07_ALIGNED_V2_DECISION_DEADLINES_MS)[number];
export type V07AlignedV2Shortlist = (typeof V07_ALIGNED_V2_SHORTLISTS)[number];
export type V07AlignedV2LateRangedFinishWeight = (typeof V07_ALIGNED_V2_LATE_RANGED_FINISH_WEIGHTS)[number];
export type V07AlignedV2PureRangedTerminalWeight = (typeof V07_ALIGNED_V2_PURE_RANGED_TERMINAL_WEIGHTS)[number];
export type V07AlignedV2MeleeRangedTargetWeight = (typeof V07_ALIGNED_V2_MELEE_RANGED_TARGET_WEIGHTS)[number];
export type V07AlignedV2AuraCasterMode = (typeof V07_ALIGNED_V2_AURA_CASTER_MODES)[number];

export interface IV07AlignedV2CandidateControls {
    activeChallengers: boolean;
    shortlist: V07AlignedV2Shortlist | null;
    decisionDeadlineMs: V07AlignedV2DecisionDeadlineMs;
    lateRangedFinishWeight: V07AlignedV2LateRangedFinishWeight;
    pureRangedTerminalWeight: V07AlignedV2PureRangedTerminalWeight;
    meleeRangedTargetWeight: V07AlignedV2MeleeRangedTargetWeight;
    placementReveal: boolean;
    denseMeleeMagicIsolation: boolean;
    auraCasterMode: V07AlignedV2AuraCasterMode;
}

/** Aligned-only behavior genome. Keep the generic 96-hour CEM vector/schema unchanged. */
export interface IV07AlignedV2CandidateGenome {
    search: IV0796hGenome;
    controls: IV07AlignedV2CandidateControls;
}

const SEARCH_GENOME_KEYS = [
    "leafMode",
    "leaf",
    "gate",
    "horizon",
    "rollouts",
    "includeMoves",
    "maxMelee",
    "maxShots",
    "maxThrows",
    "label",
] as const;
const CONTROL_KEYS = [
    "activeChallengers",
    "shortlist",
    "decisionDeadlineMs",
    "lateRangedFinishWeight",
    "pureRangedTerminalWeight",
    "meleeRangedTargetWeight",
    "placementReveal",
    "denseMeleeMagicIsolation",
    "auraCasterMode",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every((key) => allowed.includes(key));
}

export function normalizeV07AlignedV2CandidateGenome(
    genome: IV07AlignedV2CandidateGenome,
): IV07AlignedV2CandidateGenome {
    if (
        !isRecord(genome) ||
        !hasOnlyKeys(genome, ["search", "controls"]) ||
        !isRecord(genome.search) ||
        !hasOnlyKeys(genome.search, SEARCH_GENOME_KEYS) ||
        !isRecord(genome.controls) ||
        Object.keys(genome.controls).length !== CONTROL_KEYS.length ||
        !hasOnlyKeys(genome.controls, CONTROL_KEYS)
    ) {
        throw new Error("aligned v2 candidate genome fields are not exact");
    }
    const search = genome.search;
    if (
        !(search.leafMode === "off" || search.leafMode === "material" || search.leafMode === "model") ||
        ![search.gate, search.horizon, search.rollouts, search.maxMelee, search.maxShots, search.maxThrows].every(
            Number.isFinite,
        ) ||
        typeof search.includeMoves !== "boolean" ||
        (search.label !== undefined && typeof search.label !== "string")
    ) {
        throw new Error("aligned v2 search genome values are invalid");
    }
    const normalizedSearch = normalizeV0796hGenome(search as unknown as IV0796hGenome);
    const controls = genome.controls;
    if (
        typeof controls.activeChallengers !== "boolean" ||
        !(controls.shortlist === null || V07_ALIGNED_V2_SHORTLISTS.includes(controls.shortlist)) ||
        !V07_ALIGNED_V2_DECISION_DEADLINES_MS.includes(controls.decisionDeadlineMs) ||
        controls.decisionDeadlineMs >= V07_ALIGNED_V2_CIRCUIT_BREAKER_MS ||
        !V07_ALIGNED_V2_LATE_RANGED_FINISH_WEIGHTS.includes(controls.lateRangedFinishWeight) ||
        !V07_ALIGNED_V2_PURE_RANGED_TERMINAL_WEIGHTS.includes(controls.pureRangedTerminalWeight) ||
        !V07_ALIGNED_V2_MELEE_RANGED_TARGET_WEIGHTS.includes(controls.meleeRangedTargetWeight) ||
        (controls.lateRangedFinishWeight > 0 && controls.pureRangedTerminalWeight > 0) ||
        typeof controls.placementReveal !== "boolean" ||
        typeof controls.denseMeleeMagicIsolation !== "boolean" ||
        !V07_ALIGNED_V2_AURA_CASTER_MODES.includes(controls.auraCasterMode)
    ) {
        throw new Error("aligned v2 candidate controls are invalid");
    }
    return {
        search: {
            leafMode: normalizedSearch.leafMode,
            ...(normalizedSearch.leaf ? { leaf: { b: normalizedSearch.leaf.b, w: [...normalizedSearch.leaf.w] } } : {}),
            gate: normalizedSearch.gate,
            horizon: normalizedSearch.horizon,
            rollouts: normalizedSearch.rollouts,
            includeMoves: normalizedSearch.includeMoves,
            maxMelee: normalizedSearch.maxMelee,
            maxShots: normalizedSearch.maxShots,
            maxThrows: normalizedSearch.maxThrows,
            ...(normalizedSearch.label === undefined ? {} : { label: normalizedSearch.label }),
        },
        controls: { ...controls },
    };
}

export function fingerprintV07AlignedV2CandidateGenome(genome: IV07AlignedV2CandidateGenome): string {
    const normalized = normalizeV07AlignedV2CandidateGenome(genome);
    const search = { ...normalized.search };
    delete search.label;
    return fingerprintV07AlignedV2({ search, controls: normalized.controls });
}

export interface IV07AlignedV2CandidateBinding {
    schemaVersion: 3;
    candidate: "v0.7s";
    candidateBase: "v0.7";
    opponent: "v0.6";
    profile: "candidate_scoped_aligned_controls_melee57_fixed_275";
    genome: IV07AlignedV2CandidateGenome;
    genomeSha256: string;
    searchEnabled: boolean;
    behaviorEnvironment: Record<string, string>;
    behaviorEnvironmentSha256: string;
}

/** Build the exact worker environment. auditPath is the only worker-local behavior value. */
export function buildV07AlignedV2CandidateEnvironment(
    genome: IV07AlignedV2CandidateGenome,
    auditPath: string,
): Record<string, string> {
    if (!auditPath.trim()) throw new Error("auditPath must not be empty");
    const normalized = normalizeV07AlignedV2CandidateGenome(genome);
    const { search, controls } = normalized;
    const searchEnabled = search.leafMode !== "off";
    return stableEnvironment({
        V07_SEARCH: searchEnabled ? "1" : "0",
        SEARCH_VERSIONS: "v0.7s",
        SEARCH_GATE: String(search.gate),
        SEARCH_HORIZON: String(search.horizon),
        SEARCH_ROLLOUTS: String(search.rollouts),
        SEARCH_INCLUDE_MOVES: search.includeMoves ? "1" : "0",
        SEARCH_MAX_MOVES: "1",
        SEARCH_MAX_MELEE: String(search.maxMelee),
        SEARCH_MAX_SHOTS: String(search.maxShots),
        SEARCH_MAX_THROWS: String(search.maxThrows),
        SEARCH_ACTIVE_CHALLENGERS: controls.activeChallengers ? "1" : "0",
        SEARCH_SHORTLIST: controls.shortlist === null ? "" : String(controls.shortlist),
        SEARCH_DECISION_DEADLINE_MS: String(controls.decisionDeadlineMs),
        SEARCH_CIRCUIT_BREAKER_MS: String(V07_ALIGNED_V2_CIRCUIT_BREAKER_MS),
        SEARCH_OPP_MODEL: "",
        SEARCH_AUDIT: auditPath,
        SEARCH_AUDIT_TURNS: "0",
        SEARCH_LATE_RANGED_FINISH_WEIGHT: String(controls.lateRangedFinishWeight),
        SEARCH_PURE_RANGED_TERMINAL_WEIGHT: String(controls.pureRangedTerminalWeight),
        V06_MELEE_DIMS: controls.meleeRangedTargetWeight === 0 ? "" : `0,${controls.meleeRangedTargetWeight}`,
        V06_MELEE_DIMS_VERSIONS: controls.meleeRangedTargetWeight === 0 ? "" : "v0.7s",
        V07_PLACEMENT_REVEAL: controls.placementReveal ? "on" : "off",
        V07_DENSE_MM_SALVAGE_ISOLATION: controls.denseMeleeMagicIsolation ? "1" : "0",
        V07_AURA_CASTER_ROUTER: controls.auraCasterMode === "off" ? "off" : "on",
        V07_AURA_CASTER_SPELLS:
            controls.auraCasterMode === "windflow"
                ? "windflow"
                : controls.auraCasterMode === "resurrection_windflow"
                  ? "resurrection,windflow"
                  : "",
        ...(search.leafMode === "material" ? { V07_VALUE_WEIGHTS: "material" } : {}),
        ...(search.leafMode === "model" && search.leaf ? { V07_VALUE_WEIGHTS_V2: JSON.stringify(search.leaf) } : {}),
        Q2_ORACLE: "0",
        Q2_WAIT_ABLATION: "0",
    });
}

export function bindV07AlignedV2Candidate(genome: IV07AlignedV2CandidateGenome): IV07AlignedV2CandidateBinding {
    const normalized = normalizeV07AlignedV2CandidateGenome(genome);
    const behaviorEnvironment = buildV07AlignedV2CandidateEnvironment(normalized, "<worker-audit-path>");
    return {
        schemaVersion: 3,
        candidate: "v0.7s",
        candidateBase: "v0.7",
        opponent: "v0.6",
        profile: "candidate_scoped_aligned_controls_melee57_fixed_275",
        genome: normalized,
        genomeSha256: fingerprintV07AlignedV2CandidateGenome(normalized),
        searchEnabled: normalized.search.leafMode !== "off",
        behaviorEnvironment,
        behaviorEnvironmentSha256: fingerprintV07AlignedV2(behaviorEnvironment),
    };
}

export function validateV07AlignedV2CandidateBinding(
    binding: IV07AlignedV2CandidateBinding,
): IV07AlignedV2CandidateBinding {
    const expected = bindV07AlignedV2Candidate(binding.genome);
    if (canonicalV07AlignedV2Json(binding) !== canonicalV07AlignedV2Json(expected)) {
        throw new Error("aligned v2 candidate binding does not match its canonical genome and search profile");
    }
    return binding;
}

export function verifyV07AlignedV2WorkerEnvironment(
    expected: Readonly<Record<string, string>>,
    source: NodeJS.ProcessEnv = process.env,
): { effective: Record<string, string>; sha256: string } {
    const effective = stableEnvironment(
        Object.fromEntries(
            Object.entries(source).filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined && isV07AlignedV2BehaviorEnvironmentKey(entry[0]),
            ),
        ),
    );
    if (canonicalV07AlignedV2Json(effective) !== canonicalV07AlignedV2Json(expected)) {
        throw new Error("worker behavior environment does not match its exact candidate binding");
    }
    return { effective, sha256: fingerprintV07AlignedV2(effective) };
}

export interface IV07AlignedV2SeatSeedStream {
    setupSeeds: number[];
    combatSeed: number;
}

export interface IV07AlignedV2ScenarioPair {
    cellId: V07AlignedV2CellId;
    scenarioOrdinal: number;
    scenarioId: string;
    seats: Record<V07AlignedV2CandidateSeat, IV07AlignedV2SeatSeedStream>;
}

export interface IV07AlignedV2InjectedSeedPlan {
    schemaVersion: 1;
    panelId: string;
    purpose: V07AlignedV2PanelPurpose;
    scenariosPerCell: number;
    denysetSha256: string;
    pairs: IV07AlignedV2ScenarioPair[];
}

export interface IV07AlignedV2TaskCoordinates {
    panelId: string;
    cellId: V07AlignedV2CellId;
    scenarioOrdinal: number;
    scenarioId: string;
    candidateSeat: V07AlignedV2CandidateSeat;
}

export interface IV07AlignedV2ExecutionTask extends IV07AlignedV2TaskCoordinates {
    purpose: V07AlignedV2PanelPurpose;
    setupSeeds: number[];
    combatSeed: number;
}

export interface IV07AlignedV2TaskIdentity extends IV07AlignedV2TaskCoordinates {
    /** Null is permitted only for the inert two-row preflight. */
    seedMaterialSha256: string | null;
}

function requireUint32(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${label} must be a uint32`);
    }
}

function compareTaskIdentity(left: IV07AlignedV2TaskCoordinates, right: IV07AlignedV2TaskCoordinates): number {
    return (
        CELL_ORDER.get(left.cellId)! - CELL_ORDER.get(right.cellId)! ||
        left.scenarioOrdinal - right.scenarioOrdinal ||
        SEAT_ORDER.get(left.candidateSeat)! - SEAT_ORDER.get(right.candidateSeat)!
    );
}

export function v07AlignedV2TaskIdentity(
    task: IV07AlignedV2ExecutionTask | IV07AlignedV2GameObservation,
    panelId?: string,
): IV07AlignedV2TaskIdentity {
    if ("panelId" in task) {
        return {
            panelId: task.panelId,
            cellId: task.cellId,
            scenarioOrdinal: task.scenarioOrdinal,
            scenarioId: task.scenarioId,
            candidateSeat: task.candidateSeat,
            seedMaterialSha256: fingerprintV07AlignedV2({
                setupSeeds: task.setupSeeds,
                combatSeed: task.combatSeed,
            }),
        };
    }
    if (panelId === undefined) throw new Error("panelId is required for observation task identity");
    const match = /^(?:scenario-)?(\d+)$/.exec(task.scenarioId);
    if (!match) throw new Error(`observation scenarioId ${task.scenarioId} does not encode an ordinal`);
    return {
        panelId,
        cellId: task.cellId,
        scenarioOrdinal: Number(match[1]),
        scenarioId: task.scenarioId,
        candidateSeat: task.candidateSeat,
        seedMaterialSha256: null,
    };
}

export function v07AlignedV2TaskKey(identity: IV07AlignedV2TaskCoordinates): string {
    return `${identity.panelId}|${identity.cellId}|${identity.scenarioOrdinal}|${identity.scenarioId}|${identity.candidateSeat}`;
}

export function validateV07AlignedV2SeedPlan(plan: IV07AlignedV2InjectedSeedPlan): void {
    if (plan.schemaVersion !== 1) throw new Error("aligned v2 seed plan must use schemaVersion 1");
    if (!plan.panelId.trim()) throw new Error("aligned v2 seed plan panelId must not be empty");
    if (!(["train", "confirm", "final"] as const).includes(plan.purpose)) {
        throw new Error("aligned v2 seed plan purpose is invalid");
    }
    if (!Number.isSafeInteger(plan.scenariosPerCell) || plan.scenariosPerCell < 1) {
        throw new RangeError("aligned v2 scenariosPerCell must be a positive integer");
    }
    if (!/^[0-9a-f]{64}$/.test(plan.denysetSha256)) {
        throw new Error("aligned v2 seed plan must bind a lowercase SHA-256 denyset");
    }
    if (plan.pairs.length !== V07_ALIGNED_V2_EVALUATOR_CELLS.length * plan.scenariosPerCell) {
        throw new Error("aligned v2 seed plan does not contain the exact twelve-cell scenario family");
    }

    const seenPairKeys = new Set<string>();
    const seenScenarioIds = new Set<string>();
    const seenSeedTokens = new Map<number, string>();
    const registerSeed = (seed: number, label: string): void => {
        requireUint32(seed, label);
        const prior = seenSeedTokens.get(seed);
        if (prior) throw new Error(`aligned v2 seed collision: ${prior} and ${label}`);
        seenSeedTokens.set(seed, label);
    };
    for (const pair of plan.pairs) {
        const cell = CELL_BY_ID.get(pair.cellId);
        if (!cell) throw new Error(`aligned v2 seed plan contains unknown cell ${pair.cellId}`);
        if (!Number.isSafeInteger(pair.scenarioOrdinal) || pair.scenarioOrdinal < 0) {
            throw new RangeError(`${pair.cellId} scenarioOrdinal must be a nonnegative integer`);
        }
        if (!pair.scenarioId.trim()) throw new Error(`${pair.cellId} scenarioId must not be empty`);
        const pairKey = `${pair.cellId}|${pair.scenarioOrdinal}|${pair.scenarioId}`;
        if (seenPairKeys.has(pairKey)) throw new Error(`duplicate aligned v2 scenario pair ${pairKey}`);
        seenPairKeys.add(pairKey);
        const scenarioKey = `${pair.cellId}|${pair.scenarioId}`;
        if (seenScenarioIds.has(scenarioKey)) {
            throw new Error(`duplicate aligned v2 observation scenario ${scenarioKey}`);
        }
        seenScenarioIds.add(scenarioKey);
        const green = pair.seats?.candidate_green;
        const red = pair.seats?.candidate_red;
        if (!green || !red) throw new Error(`${pairKey} must contain both candidate seats`);
        const expectedSetupSeeds = cell.distribution === "ranked_taxonomy" ? V07_ALIGNED_V2_TAXONOMY_SETUP_ATTEMPTS : 1;
        for (const [seat, stream] of [
            ["candidate_green", green],
            ["candidate_red", red],
        ] as const) {
            if (stream.setupSeeds.length !== expectedSetupSeeds) {
                throw new Error(`${pairKey}/${seat} must reserve exactly ${expectedSetupSeeds} setup seeds`);
            }
        }
        if (cell.scenarioProtocol === "fixed_physical_side_swap") {
            if (
                green.combatSeed !== red.combatSeed ||
                canonicalV07AlignedV2Json(green.setupSeeds) !== canonicalV07AlignedV2Json(red.setupSeeds)
            ) {
                throw new Error(`${pairKey} fixed-template seats must share exact setup and combat seeds`);
            }
            green.setupSeeds.forEach((seed, index) => registerSeed(seed, `${pairKey}/fixed/setup/${index}`));
            registerSeed(green.combatSeed, `${pairKey}/fixed/combat`);
        } else {
            for (const [seat, stream] of [
                ["candidate_green", green],
                ["candidate_red", red],
            ] as const) {
                stream.setupSeeds.forEach((seed, index) => registerSeed(seed, `${pairKey}/${seat}/setup/${index}`));
                registerSeed(stream.combatSeed, `${pairKey}/${seat}/combat`);
            }
        }
    }
    for (const cell of V07_ALIGNED_V2_EVALUATOR_CELLS) {
        const entries = plan.pairs
            .filter((pair) => pair.cellId === cell.id)
            .sort((left, right) => left.scenarioOrdinal - right.scenarioOrdinal);
        if (
            entries.length !== plan.scenariosPerCell ||
            entries.some((entry, index) => entry.scenarioOrdinal !== index)
        ) {
            throw new Error(`${cell.id} must contain contiguous scenario ordinals 0..${plan.scenariosPerCell - 1}`);
        }
    }
}

export function flattenV07AlignedV2SeedPlan(plan: IV07AlignedV2InjectedSeedPlan): IV07AlignedV2ExecutionTask[] {
    validateV07AlignedV2SeedPlan(plan);
    return plan.pairs
        .flatMap((pair) =>
            V07_ALIGNED_96H_V2_SEATS.map((candidateSeat): IV07AlignedV2ExecutionTask => ({
                panelId: plan.panelId,
                purpose: plan.purpose,
                cellId: pair.cellId,
                scenarioOrdinal: pair.scenarioOrdinal,
                scenarioId: pair.scenarioId,
                candidateSeat,
                setupSeeds: [...pair.seats[candidateSeat].setupSeeds],
                combatSeed: pair.seats[candidateSeat].combatSeed,
            })),
        )
        .sort(compareTaskIdentity);
}

export function fingerprintV07AlignedV2SeedPlan(plan: IV07AlignedV2InjectedSeedPlan): string {
    validateV07AlignedV2SeedPlan(plan);
    return fingerprintV07AlignedV2(plan);
}

export interface IV07AlignedV2CheckpointPanelBinding {
    schemaVersion: 1;
    mode: "seed_plan" | "synthetic_preflight";
    panelId: string;
    purpose: V07AlignedV2PanelPurpose | "preflight";
    denysetSha256: string | null;
    scenariosPerCell: number;
    panelFingerprint: string;
    taskCount: number;
    tasksSha256: string;
}

export interface IV07AlignedV2CheckpointShardSpec {
    schemaVersion: 1;
    shardIndex: number;
    shardCount: number;
    pairStart: number;
    pairEndExclusive: number;
    maxScenarioPairsPerShard: number;
    runFingerprint: string;
    panel: IV07AlignedV2CheckpointPanelBinding;
    genomeSha256: string;
    behaviorEnvironmentSha256: string;
    searchEnabled: boolean;
    tasks: IV07AlignedV2TaskIdentity[];
    tasksSha256: string;
    shardSha256: string;
}

export interface IV07AlignedV2Checkpoint {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_checkpoint";
    completed: true;
    shard: IV07AlignedV2CheckpointShardSpec;
    observationsSha256: string;
    observations: IV07AlignedV2GameObservation[];
}

function requireSha256(value: string, label: string): void {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...expected].sort());
}

const TASK_IDENTITY_KEYS = [
    "panelId",
    "cellId",
    "scenarioOrdinal",
    "scenarioId",
    "candidateSeat",
    "seedMaterialSha256",
] as const;

function exactTaskIdentity(value: unknown, label: string): IV07AlignedV2TaskIdentity {
    if (!isObjectRecord(value) || !hasExactKeys(value, TASK_IDENTITY_KEYS)) {
        throw new Error(`${label} fields are not exact`);
    }
    return {
        panelId: value.panelId as string,
        cellId: value.cellId as V07AlignedV2CellId,
        scenarioOrdinal: value.scenarioOrdinal as number,
        scenarioId: value.scenarioId as string,
        candidateSeat: value.candidateSeat as V07AlignedV2CandidateSeat,
        seedMaterialSha256: value.seedMaterialSha256 as string | null,
    };
}

function validateTaskIdentityFields(task: IV07AlignedV2TaskIdentity, label: string): void {
    if (
        typeof task.panelId !== "string" ||
        !task.panelId.trim() ||
        typeof task.scenarioId !== "string" ||
        !task.scenarioId.trim() ||
        !Number.isSafeInteger(task.scenarioOrdinal) ||
        task.scenarioOrdinal < 0 ||
        !CELL_BY_ID.has(task.cellId) ||
        !SEAT_ORDER.has(task.candidateSeat)
    ) {
        throw new Error(`${label} is malformed`);
    }
    if (task.seedMaterialSha256 !== null) {
        if (typeof task.seedMaterialSha256 !== "string") throw new Error(`${label} seed binding is malformed`);
        requireSha256(task.seedMaterialSha256, `${label}.seedMaterialSha256`);
    }
}

export function bindV07AlignedV2SeedPlan(plan: IV07AlignedV2InjectedSeedPlan): IV07AlignedV2CheckpointPanelBinding {
    const tasks = flattenV07AlignedV2SeedPlan(plan).map((task) => v07AlignedV2TaskIdentity(task));
    return {
        schemaVersion: 1,
        mode: "seed_plan",
        panelId: plan.panelId,
        purpose: plan.purpose,
        denysetSha256: plan.denysetSha256,
        scenariosPerCell: plan.scenariosPerCell,
        panelFingerprint: fingerprintV07AlignedV2(plan),
        taskCount: tasks.length,
        tasksSha256: fingerprintV07AlignedV2(tasks),
    };
}

export function validateV07AlignedV2CheckpointPanelBinding(value: unknown): IV07AlignedV2CheckpointPanelBinding {
    if (
        !isObjectRecord(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "mode",
            "panelId",
            "purpose",
            "denysetSha256",
            "scenariosPerCell",
            "panelFingerprint",
            "taskCount",
            "tasksSha256",
        ])
    ) {
        throw new Error("aligned v2 checkpoint panel binding fields are not exact");
    }
    if (
        value.schemaVersion !== 1 ||
        typeof value.panelId !== "string" ||
        !value.panelId.trim() ||
        !Number.isSafeInteger(value.scenariosPerCell) ||
        (value.scenariosPerCell as number) < 1 ||
        !Number.isSafeInteger(value.taskCount) ||
        (value.taskCount as number) < 2 ||
        (value.taskCount as number) % 2 !== 0 ||
        typeof value.panelFingerprint !== "string" ||
        typeof value.tasksSha256 !== "string"
    ) {
        throw new Error("aligned v2 checkpoint panel binding is malformed");
    }
    requireSha256(value.panelFingerprint, "panel.panelFingerprint");
    requireSha256(value.tasksSha256, "panel.tasksSha256");
    if (value.mode === "seed_plan") {
        if (
            !(["train", "confirm", "final"] as const).includes(value.purpose as V07AlignedV2PanelPurpose) ||
            typeof value.denysetSha256 !== "string"
        ) {
            throw new Error("aligned v2 seed-plan panel metadata is malformed");
        }
        requireSha256(value.denysetSha256, "panel.denysetSha256");
        if (
            value.taskCount !==
            V07_ALIGNED_V2_EVALUATOR_CELLS.length * (value.scenariosPerCell as number) * V07_ALIGNED_96H_V2_SEATS.length
        ) {
            throw new Error("aligned v2 seed-plan panel task count does not cover the exact twelve-cell family");
        }
    } else if (value.mode === "synthetic_preflight") {
        if (
            value.purpose !== "preflight" ||
            value.denysetSha256 !== null ||
            value.scenariosPerCell !== 1 ||
            value.taskCount !== 2
        ) {
            throw new Error("aligned v2 synthetic preflight panel metadata is malformed");
        }
    } else {
        throw new Error("aligned v2 checkpoint panel mode is invalid");
    }
    return value as unknown as IV07AlignedV2CheckpointPanelBinding;
}

function buildCheckpointShardSpecs(options: {
    runFingerprint: string;
    panel: IV07AlignedV2CheckpointPanelBinding;
    binding: IV07AlignedV2CandidateBinding;
    tasks: readonly IV07AlignedV2TaskIdentity[];
    maxScenarioPairsPerShard: number;
}): IV07AlignedV2CheckpointShardSpec[] {
    validateV07AlignedV2CandidateBinding(options.binding);
    validateV07AlignedV2CheckpointPanelBinding(options.panel);
    requireSha256(options.runFingerprint, "runFingerprint");
    if (!Number.isSafeInteger(options.maxScenarioPairsPerShard) || options.maxScenarioPairsPerShard < 1) {
        throw new RangeError("maxScenarioPairsPerShard must be a positive integer");
    }
    if (!options.tasks.length) throw new Error("checkpoint plan must contain at least one task");
    const tasks = options.tasks.map((task, index) => exactTaskIdentity(task, `tasks[${index}]`));
    tasks.forEach((task, index) => validateTaskIdentityFields(task, `tasks[${index}]`));
    if (tasks.some((task) => task.panelId !== options.panel.panelId)) {
        throw new Error("checkpoint tasks do not belong to their bound panel id");
    }
    tasks.sort(compareTaskIdentity);
    if (tasks.length !== options.panel.taskCount || fingerprintV07AlignedV2(tasks) !== options.panel.tasksSha256) {
        throw new Error("checkpoint tasks do not match their full bound panel task set");
    }
    const keys = tasks.map(v07AlignedV2TaskKey);
    if (new Set(keys).size !== keys.length) throw new Error("checkpoint plan contains duplicate task identities");
    const observationKeys = tasks.map(
        (task) => `${task.panelId}|${task.cellId}|${task.scenarioId}|${task.candidateSeat}`,
    );
    if (new Set(observationKeys).size !== observationKeys.length) {
        throw new Error("checkpoint plan contains duplicate observation identities");
    }
    const seedBindingModes = new Set(tasks.map((task) => (task.seedMaterialSha256 === null ? "none" : "bound")));
    const expectedSeedMode = options.panel.mode === "seed_plan" ? "bound" : "none";
    if (seedBindingModes.size !== 1 || !seedBindingModes.has(expectedSeedMode)) {
        throw new Error("checkpoint plan cannot mix seed-bound execution tasks with seedless preflight tasks");
    }
    if (tasks.length % 2) throw new Error("checkpoint plan must contain complete two-seat scenario pairs");
    for (let index = 0; index < tasks.length; index += 2) {
        const green = tasks[index];
        const red = tasks[index + 1];
        if (
            green.panelId !== red.panelId ||
            green.cellId !== red.cellId ||
            green.scenarioOrdinal !== red.scenarioOrdinal ||
            green.scenarioId !== red.scenarioId ||
            green.candidateSeat !== "candidate_green" ||
            red.candidateSeat !== "candidate_red"
        ) {
            throw new Error("checkpoint plan must keep both canonical candidate seats on every scenario boundary");
        }
    }
    const pairCount = tasks.length / 2;
    const shardCount = Math.ceil(pairCount / options.maxScenarioPairsPerShard);
    return Array.from({ length: shardCount }, (_, shardIndex) => {
        const pairStart = shardIndex * options.maxScenarioPairsPerShard;
        const pairEndExclusive = Math.min(pairCount, pairStart + options.maxScenarioPairsPerShard);
        const shardTasks = tasks.slice(pairStart * 2, pairEndExclusive * 2);
        const unsigned = {
            schemaVersion: 1 as const,
            shardIndex,
            shardCount,
            pairStart,
            pairEndExclusive,
            maxScenarioPairsPerShard: options.maxScenarioPairsPerShard,
            runFingerprint: options.runFingerprint,
            panel: { ...options.panel },
            genomeSha256: options.binding.genomeSha256,
            behaviorEnvironmentSha256: options.binding.behaviorEnvironmentSha256,
            searchEnabled: options.binding.searchEnabled,
            tasks: shardTasks,
            tasksSha256: fingerprintV07AlignedV2(shardTasks),
        };
        return validateV07AlignedV2CheckpointShardSpec({
            ...unsigned,
            shardSha256: fingerprintV07AlignedV2(unsigned),
        });
    });
}

export function buildV07AlignedV2CheckpointShardSpecs(options: {
    runFingerprint: string;
    seedPlan: IV07AlignedV2InjectedSeedPlan;
    binding: IV07AlignedV2CandidateBinding;
    maxScenarioPairsPerShard: number;
}): IV07AlignedV2CheckpointShardSpec[] {
    const executionTasks = flattenV07AlignedV2SeedPlan(options.seedPlan);
    const tasks = executionTasks.map((task) => v07AlignedV2TaskIdentity(task));
    return buildCheckpointShardSpecs({
        runFingerprint: options.runFingerprint,
        panel: bindV07AlignedV2SeedPlan(options.seedPlan),
        binding: options.binding,
        tasks,
        maxScenarioPairsPerShard: options.maxScenarioPairsPerShard,
    });
}

export function buildV07AlignedV2SyntheticPreflightShardSpecs(options: {
    runFingerprint: string;
    panelId: string;
    binding: IV07AlignedV2CandidateBinding;
    tasks: readonly IV07AlignedV2TaskIdentity[];
    maxScenarioPairsPerShard: number;
}): IV07AlignedV2CheckpointShardSpec[] {
    const tasks = options.tasks.map((task, index) => exactTaskIdentity(task, `tasks[${index}]`));
    tasks.forEach((task, index) => validateTaskIdentityFields(task, `tasks[${index}]`));
    tasks.sort(compareTaskIdentity);
    const panel: IV07AlignedV2CheckpointPanelBinding = {
        schemaVersion: 1,
        mode: "synthetic_preflight",
        panelId: options.panelId,
        purpose: "preflight",
        denysetSha256: null,
        scenariosPerCell: 1,
        panelFingerprint: fingerprintV07AlignedV2({
            panelId: options.panelId,
            seedMaterial: "none",
            tasks,
        }),
        taskCount: tasks.length,
        tasksSha256: fingerprintV07AlignedV2(tasks),
    };
    return buildCheckpointShardSpecs({ ...options, panel, tasks });
}

export function validateV07AlignedV2CheckpointShardSpec(value: unknown): IV07AlignedV2CheckpointShardSpec {
    if (!isObjectRecord(value)) throw new Error("aligned v2 checkpoint shard must be an object");
    if (
        !hasExactKeys(value, [
            "schemaVersion",
            "shardIndex",
            "shardCount",
            "pairStart",
            "pairEndExclusive",
            "maxScenarioPairsPerShard",
            "runFingerprint",
            "panel",
            "genomeSha256",
            "behaviorEnvironmentSha256",
            "searchEnabled",
            "tasks",
            "tasksSha256",
            "shardSha256",
        ])
    ) {
        throw new Error("aligned v2 checkpoint shard fields are not exact");
    }
    for (const [key, entry] of Object.entries({
        shardIndex: value.shardIndex,
        shardCount: value.shardCount,
        pairStart: value.pairStart,
        pairEndExclusive: value.pairEndExclusive,
        maxScenarioPairsPerShard: value.maxScenarioPairsPerShard,
    })) {
        if (!Number.isSafeInteger(entry) || (entry as number) < 0) {
            throw new Error(`aligned v2 checkpoint shard ${key} must be a nonnegative integer`);
        }
    }
    if (
        (value.shardCount as number) < 1 ||
        (value.shardIndex as number) >= (value.shardCount as number) ||
        (value.pairEndExclusive as number) <= (value.pairStart as number) ||
        (value.maxScenarioPairsPerShard as number) < 1
    ) {
        throw new Error("aligned v2 checkpoint shard range metadata is invalid");
    }
    for (const key of [
        "runFingerprint",
        "genomeSha256",
        "behaviorEnvironmentSha256",
        "tasksSha256",
        "shardSha256",
    ] as const) {
        if (typeof value[key] !== "string") throw new Error(`aligned v2 checkpoint shard ${key} must be a string`);
        requireSha256(value[key], key);
    }
    if (value.schemaVersion !== 1) throw new Error("aligned v2 checkpoint shard schemaVersion is invalid");
    const panel = validateV07AlignedV2CheckpointPanelBinding(value.panel);
    const panelPairCount = panel.taskCount / 2;
    const expectedShardCount = Math.ceil(panelPairCount / (value.maxScenarioPairsPerShard as number));
    const expectedPairStart = (value.shardIndex as number) * (value.maxScenarioPairsPerShard as number);
    const expectedPairEndExclusive = Math.min(
        panelPairCount,
        expectedPairStart + (value.maxScenarioPairsPerShard as number),
    );
    if (
        value.shardCount !== expectedShardCount ||
        value.pairStart !== expectedPairStart ||
        value.pairEndExclusive !== expectedPairEndExclusive
    ) {
        throw new Error("aligned v2 checkpoint shard range is not the deterministic panel partition");
    }
    if (typeof value.searchEnabled !== "boolean") {
        throw new Error("aligned v2 checkpoint shard searchEnabled must be boolean");
    }
    if (!Array.isArray(value.tasks)) throw new Error("aligned v2 checkpoint shard tasks must be an array");
    const tasks = value.tasks.map((task, index) => exactTaskIdentity(task, `shard.tasks[${index}]`));
    if (tasks.length !== ((value.pairEndExclusive as number) - (value.pairStart as number)) * 2) {
        throw new Error("aligned v2 checkpoint shard task count violates its pair range");
    }
    if (value.tasksSha256 !== fingerprintV07AlignedV2(tasks)) {
        throw new Error("aligned v2 checkpoint shard task hash mismatch");
    }
    const taskKeys = tasks.map(v07AlignedV2TaskKey);
    if (new Set(taskKeys).size !== taskKeys.length) {
        throw new Error("aligned v2 checkpoint shard contains duplicate task identities");
    }
    for (const [index, task] of tasks.entries()) {
        validateTaskIdentityFields(task, `aligned v2 checkpoint shard task ${index}`);
        if (task.panelId !== panel.panelId) throw new Error(`aligned v2 checkpoint shard task ${index} changed panel`);
        if (index > 0 && compareTaskIdentity(tasks[index - 1], task) > 0) {
            throw new Error("aligned v2 checkpoint shard tasks are not in canonical order");
        }
    }
    const seedBindingModes = new Set(tasks.map((task) => (task.seedMaterialSha256 === null ? "none" : "bound")));
    const expectedSeedMode = panel.mode === "seed_plan" ? "bound" : "none";
    if (seedBindingModes.size !== 1 || !seedBindingModes.has(expectedSeedMode)) {
        throw new Error("aligned v2 checkpoint shard mixes seed-bound and seedless tasks");
    }
    if (panel.mode === "synthetic_preflight") {
        if (
            panel.tasksSha256 !== fingerprintV07AlignedV2(tasks) ||
            panel.panelFingerprint !== fingerprintV07AlignedV2({ panelId: panel.panelId, seedMaterial: "none", tasks })
        ) {
            throw new Error("aligned v2 synthetic preflight panel binding does not match its two rows");
        }
    }
    for (let index = 0; index < tasks.length; index += 2) {
        const green = tasks[index];
        const red = tasks[index + 1];
        if (
            !green ||
            !red ||
            !CELL_BY_ID.has(green.cellId) ||
            !CELL_BY_ID.has(red.cellId) ||
            green.panelId !== red.panelId ||
            green.cellId !== red.cellId ||
            green.scenarioOrdinal !== red.scenarioOrdinal ||
            green.scenarioId !== red.scenarioId ||
            green.candidateSeat !== "candidate_green" ||
            red.candidateSeat !== "candidate_red"
        ) {
            throw new Error("aligned v2 checkpoint shard split or malformed a two-seat scenario pair");
        }
    }
    const unsigned = { ...value };
    delete unsigned.shardSha256;
    if (value.shardSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 checkpoint shard self-hash mismatch");
    }
    return value as unknown as IV07AlignedV2CheckpointShardSpec;
}

function checkpointObservationIdentity(
    observation: IV07AlignedV2GameObservation,
    task: IV07AlignedV2TaskIdentity,
): boolean {
    return (
        observation.cellId === task.cellId &&
        observation.candidateSeat === task.candidateSeat &&
        observation.scenarioId === task.scenarioId
    );
}

export function validateV07AlignedV2Checkpoint(
    value: unknown,
    expectedShard: IV07AlignedV2CheckpointShardSpec,
): IV07AlignedV2Checkpoint {
    validateV07AlignedV2CheckpointShardSpec(expectedShard);
    if (!isObjectRecord(value)) throw new Error("aligned v2 checkpoint must be an object");
    if (
        !hasExactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "completed",
            "shard",
            "observationsSha256",
            "observations",
        ])
    ) {
        throw new Error("aligned v2 checkpoint fields are not exact");
    }
    if (
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_checkpoint" ||
        value.completed !== true
    ) {
        throw new Error("aligned v2 checkpoint header is invalid or incomplete");
    }
    if (canonicalV07AlignedV2Json(value.shard) !== canonicalV07AlignedV2Json(expectedShard)) {
        throw new Error("aligned v2 checkpoint shard binding mismatch");
    }
    if (!Array.isArray(value.observations)) throw new Error("aligned v2 checkpoint observations must be an array");
    if (value.observationsSha256 !== fingerprintV07AlignedV2(value.observations)) {
        throw new Error("aligned v2 checkpoint observation hash mismatch");
    }
    const observations = value.observations as IV07AlignedV2GameObservation[];
    if (observations.length !== expectedShard.tasks.length) {
        throw new Error("aligned v2 checkpoint observation count does not match its shard");
    }
    aggregateV07AlignedV2(observations);
    observations.forEach((observation, index) => {
        if (!checkpointObservationIdentity(observation, expectedShard.tasks[index])) {
            throw new Error(`aligned v2 checkpoint observation ${index} does not match its deterministic task`);
        }
        if (observation.candidateRejections === undefined || observation.opponentRejections === undefined) {
            throw new Error(`aligned v2 checkpoint observation ${index} omitted rejection counts`);
        }
        if (expectedShard.searchEnabled !== (observation.searchAudit !== undefined)) {
            throw new Error(`aligned v2 checkpoint observation ${index} audit presence disagrees with search mode`);
        }
    });
    return value as unknown as IV07AlignedV2Checkpoint;
}

export function createV07AlignedV2Checkpoint(
    shard: IV07AlignedV2CheckpointShardSpec,
    observations: readonly IV07AlignedV2GameObservation[],
): IV07AlignedV2Checkpoint {
    const checkpoint: IV07AlignedV2Checkpoint = {
        schemaVersion: 1,
        artifactKind: "v0_7_aligned_96h_v2_checkpoint",
        completed: true,
        shard: structuredClone(shard),
        observationsSha256: fingerprintV07AlignedV2(observations),
        observations: observations.map((observation) => structuredClone(observation)),
    };
    return validateV07AlignedV2Checkpoint(checkpoint, shard);
}

export function evaluatorCellV07AlignedV2(cellId: V07AlignedV2CellId): Readonly<IV07AlignedV2EvaluatorCell> {
    const cell = CELL_BY_ID.get(cellId);
    if (!cell) throw new Error(`unknown aligned v2 evaluator cell ${cellId}`);
    return cell;
}
