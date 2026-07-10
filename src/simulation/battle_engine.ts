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

import { getAIStrategy, type IDecisionContext } from "../ai";
import type { GameAction } from "../engine/actions";
import { GameActionEngine } from "../engine/action_engine";
import type { GameEvent } from "../engine/events";
import { createDefaultGameRuntime } from "../engine/runtime";
import { TurnEngine } from "../engine/turn_engine";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { Grid } from "../grid/grid";
import { GRID_SIZE, MAX_X, MAX_Y, MIN_X, MIN_Y, MOVEMENT_DELTA, UNIT_SIZE_DELTA } from "../grid/grid_constants";
import { GridSettings } from "../grid/grid_settings";
import type { IWeightedRoute } from "../grid/path_definitions";
import { PathHelper } from "../grid/path_helper";
import { PlacementPositionType } from "../grid/placement_properties";
import { RectanglePlacement } from "../grid/rectangle_placement";
import { AttackHandler } from "../handlers/attack_handler";
import { MoveHandler } from "../handlers/move_handler";
import type { IDamageStatistic } from "../scene/scene_stats";
import { SceneLogMock } from "../scene/scene_log_mock";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import { FightStateManager } from "../fights/fight_state_manager";
import { ArtifactTier } from "../artifacts/artifact_properties";
import { DefaultPlacementLevel1, type AugmentType } from "../augments/augment_properties";
import type { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";
import { ToFactionName } from "../factions/faction_type";
import { setDeterministicRandomSource } from "../utils/lib";
import { createCombatFactories, createUnitFromSpec, makeRng, type IArmyUnitSpec } from "./army";
import { appendFileSync } from "node:fs";

import { LookaheadDriver } from "./lookahead";
import { extractValueFeatures } from "./value_features";

// Learned-value data capture (gated by VALUE_DATA=<jsonl path>). When set, every acting turn snapshots the
// position features from the acting team's view; at game end each snapshot is labeled with whether that team
// won and appended to the file. Off => zero overhead. Used to fit the lookahead's leaf value function.
const VALUE_DATA_FILE = process.env.VALUE_DATA;

/** Green plays the LOWER team, red plays UPPER — matching the e2e/ranked convention. */
export type Side = "green" | "red";
export const GREEN_TEAM: TeamType = PBTypes.TeamVals.LOWER;
export const RED_TEAM: TeamType = PBTypes.TeamVals.UPPER;
const sideForTeam = (team: TeamType): Side => (team === GREEN_TEAM ? "green" : "red");

/** Synchronous, read-only view of one strategy decision before search or recovery modifies its execution. */
export interface IDecisionObservation {
    unit: Unit;
    context: IDecisionContext;
    incumbent: readonly GameAction[];
    strategyVersion: string;
}

export interface IMatchConfig {
    greenVersion: string;
    redVersion: string;
    /** Roster for the GREEN team. In a mirrored match the red team gets the same list. */
    roster: IArmyUnitSpec[];
    /** Optional distinct roster for the RED team (randomized-picks match). Defaults to `roster`. */
    redRoster?: IArmyUnitSpec[];
    /** Recorded for reproducibility (drives roster selection upstream; stored here as provenance). */
    seed: number;
    /** Hard cap on laps before the match is called a draw-on-points. Default 60. */
    maxLaps?: number;
    /** Board layout for this match. Defaults to NORMAL (GridVals: 1 NORMAL, 2 WATER_CENTER, 3 LAVA_CENTER, 4 BLOCK_CENTER). */
    gridType?: number;
    /**
     * Army-wide Tier-1 artifact (Tier1Artifact enum id; 0/undefined = none) granted to each team before the
     * fight, applied via UnitsHolder.applyArtifacts exactly as the live server does. Used by the artifact
     * A/B measurement (measure_artifacts.ts) to isolate each artifact's contribution to win rate.
     */
    greenArtifactT1?: number;
    redArtifactT1?: number;
    /** Army-wide Tier-2 artifact (Tier2Artifact enum id; 0/undefined = none). Same application path. */
    greenArtifactT2?: number;
    redArtifactT2?: number;
    /** Perk (Perk enum id) per team — seeds the augment upgrade-point budget (getUpgradePoints). */
    greenPerk?: number;
    redPerk?: number;
    /** Army augments per team ({kind,value}; kind = Placement/Armor/Might/Sniper/Movement, value = level).
     * Applied as whole-army stat buffs via UnitsHolder.applyAugments, budget-checked against the perk. */
    greenAugments?: ISetupAugment[];
    redAugments?: ISetupAugment[];
    /** Synergies per team ({faction, synergy, level}) — recorded on fightProperties; combat + adjustBaseStats
     * read them live. Effective level is composition-gated (needs enough units of the faction). */
    greenSynergies?: ISetupSynergy[];
    redSynergies?: ISetupSynergy[];
    /** Optional simulation instrumentation. Unset by default; observers must not mutate the live unit/context. */
    decisionObserver?: (observation: IDecisionObservation) => void;
}

export interface ISetupAugment {
    kind: "Placement" | "Armor" | "Might" | "Sniper" | "Movement";
    value: number;
}

export interface ISetupSynergy {
    faction: number;
    synergy: number;
    /** Ignored — the effective level is derived from the team's unit count in that faction. */
    level?: number;
}

export interface IPlacementRecord {
    unitId: string;
    creatureName: string;
    level: number;
    size: number;
    amount: number;
    cell: XY;
}

export interface IRecordedAction {
    index: number;
    lap: number;
    side: Side;
    unitId: string;
    creatureName: string;
    fromCell: XY;
    actionType: GameAction["type"];
    targetId?: string;
    targetCreature?: string;
    toCell?: XY;
    completed: boolean;
    /** Engine rejection reason when completed === false (for diagnosing non-smooth turns). */
    rejectionReason?: string;
    /** Extra enemy stacks hit beyond the primary target (AoE splash + line/secondary damage). */
    secondaryHits?: number;
    damage?: number;
    unitIdsDied?: string[];
}

export interface ISideOutcome {
    version: string;
    unitsAlive: number;
    creaturesAlive: number;
    hpRemaining: number;
}

/**
 * Attrition mechanics that end a fight by environment rather than clean combat: the board NARROWING
 * (from lap 3) and ARMAGEDDON (escalating damage to everyone from lap 12, 4 waves). A clean AI win
 * kills the enemy outright before these matter; `decidedByArmageddon` flags games where armageddon
 * deaths actually contributed to the result (what we want to minimise).
 */
export interface IAttritionInfo {
    reachedArmageddon: boolean;
    armageddonWaves: number;
    unitsKilledByArmageddon: number;
    unitsKilledByNarrowing: number;
    /** Armageddon killed units AND the game ended in/after the armageddon phase. */
    decidedByArmageddon: boolean;
}

export interface IMatchResult {
    seed: number;
    /** Board layout the match was played on (GridVals). */
    gridType: number;
    winner: Side | "draw";
    endReason: "elimination" | "turn_cap" | "stuck";
    laps: number;
    totalActions: number;
    /** Green-team roster. Equals the red roster in a mirrored match. */
    roster: IArmyUnitSpec[];
    /** Red-team roster — only present (and distinct) in a randomized-picks match. */
    redRoster?: IArmyUnitSpec[];
    placements: { green: IPlacementRecord[]; red: IPlacementRecord[] };
    actions: IRecordedAction[];
    outcome: { green: ISideOutcome; red: ISideOutcome };
    attrition: IAttritionInfo;
    /** Engine-rejected STRATEGY actions per side — must be 0 (a healthy AI never proposes a declined command). */
    rejectedGreen?: number;
    rejectedRed?: number;
    /** Per-rejection diagnostics (action type + engine reason) for driving the count to 0. */
    rejectedDetails?: {
        type: string;
        reason?: string;
        version: string;
        creature?: string;
        ammo?: number;
        possible?: string;
        cause?: string;
    }[];
    /** Tier-1 artifact each team fielded this match (Tier1Artifact enum id; 0 = none). Provenance for the
     * artifact A/B measurement so per-artifact win rates can be aggregated from the game record. */
    greenArtifactT1?: number;
    redArtifactT1?: number;
    /** Tier-2 artifact each team fielded (Tier2Artifact enum id; 0 = none). Same provenance role. */
    greenArtifactT2?: number;
    redArtifactT2?: number;
}

class DamageStatHolder implements IStatisticHolder<IDamageStatistic> {
    private readonly values: IDamageStatistic[] = [];
    public add(v: IDamageStatistic): void {
        this.values.push(v);
    }
    public get(): IDamageStatistic[] {
        return this.values;
    }
    public has(lap: number): boolean {
        return this.values.some((v) => v.lap === lap);
    }
    public clear(): void {
        this.values.length = 0;
    }
}

export function simulationGridSettings(): GridSettings {
    return new GridSettings(GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X, MOVEMENT_DELTA, UNIT_SIZE_DELTA);
}

const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;

const footprintCells = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ x: base.x, y: base.y }]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

/**
 * A guaranteed-legal "advance toward the nearest enemy" move (closest reachable cell to any enemy),
 * used to recover a turn whose attack the engine declined — so the unit closes distance instead of
 * stalling. Returns undefined if the unit can't move or no enemy/route exists (caller then defends).
 */
function advanceTowardEnemyAction(
    unit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    pathHelper: PathHelper,
): GameAction | undefined {
    if (!unit.canMove()) {
        return undefined;
    }
    const enemyTeam = unit.getTeam() === GREEN_TEAM ? RED_TEAM : GREEN_TEAM;
    const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
    if (!enemies.length) {
        return undefined;
    }
    const movePath = pathHelper.getMovePath(
        unit.getBaseCell(),
        grid.getMatrix(),
        unit.getSteps(),
        grid.getAggrMatrixByTeam(enemyTeam),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );
    if (!movePath.knownPaths.size) {
        return undefined;
    }
    const base = unit.getBaseCell();
    let best: IWeightedRoute | undefined;
    let bestScore = Infinity;
    for (const routeList of movePath.knownPaths.values()) {
        const route = routeList[0];
        if (!route?.route.length || (route.cell.x === base.x && route.cell.y === base.y)) {
            continue;
        }
        const score = Math.min(
            ...enemies.map(
                (e) => Math.abs(route.cell.x - e.getBaseCell().x) + Math.abs(route.cell.y - e.getBaseCell().y),
            ),
        );
        if (score < bestScore) {
            bestScore = score;
            best = route;
        }
    }
    if (!best?.route.length) {
        return undefined;
    }
    return {
        type: "move_unit",
        unitId: unit.getId(),
        path: best.route.map((c) => ({ x: c.x, y: c.y })),
        targetCells: footprintCells(unit, best.cell),
        hasLavaCell: best.hasLavaCell,
        hasWaterCell: best.hasWaterCell,
    };
}

// --- Skip audit -------------------------------------------------------------
// Env/flag-gated instrumentation to answer "why do units skip turns". Every acting turn is bucketed into
// exactly one category. A "skip_*" bucket = decideTurn landed NOTHING (no move/attack/hourglass) — i.e. the
// exact situation the CLIENT renders as "skips turn" (the client has no advance/defend recovery net that the
// sim uses below). Buckets are split by unit size and whether the turn is a hourglass re-up, and by whether
// the sim could still ADVANCE (client would skip, sim moves) or only DEFEND (truly stuck). Zero overhead when
// disabled. Toggle via SKIP_AUDIT.enabled = true (or V05_SKIP_AUDIT env) before running matches.
export const SKIP_AUDIT: {
    enabled: boolean;
    total: number;
    cat: Record<string, number>;
    byUnit: Record<string, Record<string, number>>;
} = { enabled: !!process.env.V05_SKIP_AUDIT, total: 0, cat: {}, byUnit: {} };

export function resetSkipAudit(): void {
    SKIP_AUDIT.total = 0;
    SKIP_AUDIT.cat = {};
    SKIP_AUDIT.byUnit = {};
}

function auditTurn(category: string, unitName: string): void {
    if (!SKIP_AUDIT.enabled) {
        return;
    }
    SKIP_AUDIT.total += 1;
    SKIP_AUDIT.cat[category] = (SKIP_AUDIT.cat[category] ?? 0) + 1;
    const u = (SKIP_AUDIT.byUnit[unitName] ??= {});
    u[category] = (u[category] ?? 0) + 1;
}

/**
 * Run one headless AI-vs-AI battle to completion and return a fully recorded match (placements, every
 * action both sides took, and the winner). Pure in-process — no network, no rendering. The two sides
 * receive the SAME roster, so the only variable is the AI version driving each.
 */
export function runMatch(config: IMatchConfig): IMatchResult {
    // Seed combat randomness deterministically so a (versions, seed) pair reproduces EXACTLY — this turns
    // AI-vs-AI measurement into a paired, noise-free comparison. Simulation-only: production code never sets
    // a deterministic source, so live matches keep crypto-secure randomness. Cleared in `finally` so a
    // thrown match can't leak the seeded source into the next game on this worker (which would desync it).
    if (config.seed !== undefined) {
        setDeterministicRandomSource(makeRng((config.seed ^ 0x6d2b79f5) >>> 0));
    }
    try {
        return runMatchInner(config);
    } finally {
        setDeterministicRandomSource(undefined);
    }
}

function runMatchInner(config: IMatchConfig): IMatchResult {
    const maxLaps = config.maxLaps ?? 60;
    const gridSettings = simulationGridSettings();

    FightStateManager.getInstance().reset();
    const grid = new Grid(gridSettings, config.gridType ?? PBTypes.GridVals.NORMAL);
    const unitsHolder = new UnitsHolder(grid);
    const sceneLog = new SceneLogMock();
    const damageStatisticHolder = new DamageStatHolder();
    const attackHandler = new AttackHandler(gridSettings, grid, sceneLog, damageStatisticHolder);
    const moveHandler = new MoveHandler(gridSettings, grid, unitsHolder);
    const pathHelper = new PathHelper(gridSettings);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const runtime = createDefaultGameRuntime();
    const { abilityFactory, effectFactory } = createCombatFactories();

    const greenZone = new RectanglePlacement(gridSettings, PlacementPositionType.LOWER_LEFT, 3);
    const redZone = new RectanglePlacement(gridSettings, PlacementPositionType.UPPER_RIGHT, 3);
    const zoneHashesFor = (team: TeamType): Set<number> =>
        team === GREEN_TEAM ? greenZone.possibleCellHashes() : redZone.possibleCellHashes();

    let currentActiveUnitId = "";
    const engineContext = {
        fightProperties,
        grid,
        unitsHolder,
        moveHandler,
        sceneLog,
        attackHandler,
        getCurrentActiveUnitId: () => currentActiveUnitId || undefined,
        // Mirror the live server: a unit's selectable attack types are refreshed on activation using
        // whether it can actually land a ranged shot (boxed-in shooters lose RANGE), so the AI/engine
        // agree on what's legal. Without this the turn engine defaults to "can always range".
        canLandRangeAttack: (unit: Unit) =>
            attackHandler.canLandRangeAttack(unit, grid.getEnemyAggrMatrixByUnitId(unit.getId())),
        // No known-paths provider: the engine trusts the legal path the AI computed (mirrors the live
        // server, which also omits it). canPlaceUnit restricts placement to each team's zone.
        canPlaceUnit: (unit: Unit, cells: XY[]) => cells.every((c) => zoneHashesFor(unit.getTeam()).has(cellKey(c))),
        // Spell summons (e.g. Satyr's Summon Wolves) build a real creature stack of the summoned type.
        // The engine passes the numeric FactionType; getCreatureConfig keys by faction NAME, so map it.
        createSummonedUnit: (opts: { team: TeamType; faction: number; unitName: string; amount: number }) => {
            const factionName = ToFactionName[opts.faction];
            if (!factionName) {
                return undefined;
            }
            try {
                return createUnitFromSpec(
                    { faction: factionName, creatureName: opts.unitName, level: 0, size: 0, amount: opts.amount },
                    opts.team,
                    gridSettings,
                    abilityFactory,
                    effectFactory,
                    true,
                );
            } catch {
                return undefined; // unknown summon creature -> engine rejects the cast cleanly
            }
        },
        runtime,
    };

    const engine = new GameActionEngine(engineContext);
    const turnEngine = new TurnEngine(engineContext);

    const greenStrategy = getAIStrategy(config.greenVersion);
    const redStrategy = getAIStrategy(config.redVersion);

    // STAGE 2: 2-ply lookahead driver (env-gated V05_LOOKAHEAD, default OFF -> baseline unchanged). When
    // enabled it replaces a v0.5 unit's single decision with the best-by-simulation candidate (see
    // ./lookahead.ts). It reads/writes `currentActiveUnitId` (so simulated engine applies validate) and
    // snapshots the per-lap damage stat log (not covered by battle_snapshot) alongside the battle state.
    const lookahead = new LookaheadDriver({
        engine,
        turnEngine,
        grid,
        unitsHolder,
        fightProperties,
        pathHelper,
        attackHandler,
        strategyForTeam: (team) => (team === GREEN_TEAM ? greenStrategy : redStrategy),
        getActiveUnitId: () => currentActiveUnitId,
        setActiveUnitId: (id) => {
            currentActiveUnitId = id;
        },
        damageDealtThisLap: () => damageStatisticHolder.has(fightProperties.getCurrentLap()),
        captureDamageStats: () => [...damageStatisticHolder.get()],
        restoreDamageStats: (saved) => {
            damageStatisticHolder.clear();
            for (const v of saved) {
                damageStatisticHolder.add(v);
            }
        },
    });

    // --- build armies (per-team rosters; identical lists in a mirrored match) ---
    const greenRoster = config.roster;
    const redRoster = config.redRoster ?? config.roster;
    const greenUnits = greenRoster.map((spec) =>
        createUnitFromSpec(spec, GREEN_TEAM, gridSettings, abilityFactory, effectFactory),
    );
    const redUnits = redRoster.map((spec) =>
        createUnitFromSpec(spec, RED_TEAM, gridSettings, abilityFactory, effectFactory),
    );
    for (const unit of [...greenUnits, ...redUnits]) {
        unitsHolder.addUnit(unit);
    }

    const placements = {
        green: placeArmy(
            greenUnits,
            GREEN_TEAM,
            greenZone,
            greenStrategy,
            greenRoster,
            engine,
            grid,
            unitsHolder,
            pathHelper,
        ),
        red: placeArmy(redUnits, RED_TEAM, redZone, redStrategy, redRoster, engine, grid, unitsHolder, pathHelper),
    };

    // --- army-wide setup (optional): perk budget, artifacts (both tiers), augments, synergies ---
    // Mirror the live server: seed each team's chosen setup into fightProperties, then apply the buffs +
    // refreshStackPowerForAllUnits so adjustBaseStats folds everything in before combat. Combat runs through
    // the real handlers (which read the FightStateManager singleton this sim uses), so every mechanic behaves
    // exactly as in a live fight — stat artifacts/augments fold into base stats, combat markers (Dual Strike,
    // Warlords Edge, …) fire at their hooks, and synergies are read live from fightProperties.
    const teamHasSetup = (
        t1?: number,
        t2?: number,
        perk?: number,
        augs?: ISetupAugment[],
        syn?: ISetupSynergy[],
    ): boolean => !!(t1 || t2 || perk || augs?.length || syn?.length);
    const greenSetup = teamHasSetup(
        config.greenArtifactT1,
        config.greenArtifactT2,
        config.greenPerk,
        config.greenAugments,
        config.greenSynergies,
    );
    const redSetup = teamHasSetup(
        config.redArtifactT1,
        config.redArtifactT2,
        config.redPerk,
        config.redAugments,
        config.redSynergies,
    );
    if (greenSetup || redSetup) {
        const applyTeamSetup = (
            team: TeamType,
            units: Unit[],
            perk?: number,
            t1?: number,
            t2?: number,
            augments?: ISetupAugment[],
            synergies?: ISetupSynergy[],
        ): void => {
            if (perk) {
                fightProperties.setPerkPerTeam(team, perk);
            }
            if (t1) {
                fightProperties.setArtifactPerTeam(team, ArtifactTier.TIER_1, t1);
            }
            if (t2) {
                fightProperties.setArtifactPerTeam(team, ArtifactTier.TIER_2, t2);
            }
            if (augments?.length) {
                // Init the augment maps (canAugment/applyAugments read them); units are already placed so the
                // default-placement value only affects budget accounting, not where units sit.
                fightProperties.setDefaultPlacementPerTeam(team, DefaultPlacementLevel1.THREE_BY_THREE);
                for (const a of augments) {
                    fightProperties.setAugmentPerTeam(team, { type: a.kind, value: a.value } as AugmentType);
                }
            }
            if (synergies?.length) {
                const countByFaction = new Map<number, number>();
                for (const u of units) {
                    const f = u.getFaction();
                    countByFaction.set(f, (countByFaction.get(f) ?? 0) + 1);
                }
                const cnt = (f: number): number => countByFaction.get(f) ?? 0;
                // Establish per-faction counts (drives possible synergies + effective levels), then select the
                // chosen synergy for each fielded faction. The effective level is composition-derived exactly
                // as setSynergyUnitsPerFactions computes it, so updateSynergyPerTeam validates against the same
                // possible-synergy set (a passed s.level would be rejected if it didn't match).
                fightProperties.setSynergyUnitsPerFactions(
                    team,
                    cnt(PBTypes.FactionVals.LIFE),
                    cnt(PBTypes.FactionVals.CHAOS),
                    cnt(PBTypes.FactionVals.MIGHT),
                    cnt(PBTypes.FactionVals.NATURE),
                );
                for (const s of synergies) {
                    const level = Math.min(Math.floor(cnt(s.faction) / 2), 3);
                    if (level >= 1) {
                        fightProperties.updateSynergyPerTeam(team, s.faction, s.synergy, level);
                    }
                }
            }
        };
        applyTeamSetup(
            GREEN_TEAM,
            greenUnits,
            config.greenPerk,
            config.greenArtifactT1,
            config.greenArtifactT2,
            config.greenAugments,
            config.greenSynergies,
        );
        applyTeamSetup(
            RED_TEAM,
            redUnits,
            config.redPerk,
            config.redArtifactT1,
            config.redArtifactT2,
            config.redAugments,
            config.redSynergies,
        );
        unitsHolder.applyArtifacts(fightProperties);
        unitsHolder.applyAugments(fightProperties);
        unitsHolder.refreshStackPowerForAllUnits();
    }

    // --- run the fight ---
    const actions: IRecordedAction[] = [];
    let rejectedGreen = 0;
    let rejectedRed = 0;
    const rejectedDetails: NonNullable<IMatchResult["rejectedDetails"]> = [];
    let finished = false;
    const attrition: IAttritionInfo = {
        reachedArmageddon: false,
        armageddonWaves: 0,
        unitsKilledByArmageddon: 0,
        unitsKilledByNarrowing: 0,
        decidedByArmageddon: false,
    };
    const applyEvents = (events: GameEvent[]): void => {
        for (const event of events) {
            if (event.type === "turn_completed") {
                if (currentActiveUnitId === event.unitId) {
                    currentActiveUnitId = "";
                }
            } else if (event.type === "next_unit_selected") {
                currentActiveUnitId = event.unitId;
            } else if (event.type === "fight_finished") {
                currentActiveUnitId = "";
                finished = true;
            } else if (event.type === "armageddon_applied") {
                attrition.reachedArmageddon = true;
                attrition.armageddonWaves = Math.max(attrition.armageddonWaves, event.wave);
            } else if (event.type === "unit_destroyed") {
                // If the ACTIVE unit is destroyed environmentally (narrowing/armageddon) its turn ends with
                // it — clear the active id like turn_completed does, so we never run decideTurn on a corpse
                // (which then proposes an attack the engine rejects as "attacker dead").
                if (currentActiveUnitId === event.unitId) {
                    currentActiveUnitId = "";
                }
                if (event.reason === "armageddon") {
                    attrition.unitsKilledByArmageddon += 1;
                } else if (event.reason === "narrowing") {
                    attrition.unitsKilledByNarrowing += 1;
                }
            }
        }
    };

    const startResult = engine.apply({ type: "start_fight" });
    applyEvents(startResult.events);

    const advance = (): void => {
        const maxAttempts = unitsHolder.getAllUnits().size + 2;
        for (let i = 0; i < maxAttempts && !finished && !currentActiveUnitId; i += 1) {
            const result = turnEngine.advanceAfterNoActiveUnit({
                damageDealtThisLap: damageStatisticHolder.has(fightProperties.getCurrentLap()),
            });
            applyEvents(result.events);
            if (result.fightFinished) {
                finished = true;
                return;
            }
            if (currentActiveUnitId) {
                return;
            }
            if (!result.events.length && fightProperties.getUpNextQueueSize() === 0) {
                break;
            }
        }
    };

    const valueSnaps: { f: number[]; team: TeamType }[] = [];
    let endReason: IMatchResult["endReason"] = "elimination";
    const maxTotalActions = maxLaps * unitsHolder.getAllUnits().size * 4 + 64;

    while (!finished) {
        if (fightProperties.getCurrentLap() > maxLaps) {
            endReason = "turn_cap";
            break;
        }
        if (actions.length > maxTotalActions) {
            endReason = "stuck";
            break;
        }
        if (!currentActiveUnitId) {
            advance();
            if (finished) {
                break;
            }
            if (!currentActiveUnitId) {
                // The turn engine wedged with no next unit while the fight is live (a queue can stall
                // after deaths/hourglass). Mirror the server's recovery: force a lap transition by
                // marking every living unit as having taken its turn, then advance again. This reuses
                // the normal lap-flip (re-seeds the queue) instead of stranding the match.
                let forced = false;
                for (const u of unitsHolder.getAllUnits().values()) {
                    if (!u.isDead()) {
                        fightProperties.addAlreadyMadeTurn(u.getTeam(), u.getId());
                        forced = true;
                    }
                }
                if (forced) {
                    advance();
                }
                if (finished) {
                    break;
                }
                if (!currentActiveUnitId) {
                    endReason = "stuck";
                    break;
                }
            }
            continue;
        }

        const unit = unitsHolder.getAllUnits().get(currentActiveUnitId);
        if (!unit || unit.isDead()) {
            // Never decide a turn for a missing or dead unit — abandon its turn and let the queue advance.
            currentActiveUnitId = "";
            continue;
        }
        const actingUnitId = currentActiveUnitId;
        if (VALUE_DATA_FILE) {
            valueSnaps.push({
                f: extractValueFeatures(unitsHolder, fightProperties, unit.getTeam()),
                team: unit.getTeam(),
            });
        }
        const strategy = unit.getTeam() === GREEN_TEAM ? greenStrategy : redStrategy;
        const matrix = grid.getMatrix();
        const decisionContext: IDecisionContext = {
            grid,
            matrix,
            unitsHolder,
            pathHelper,
            attackHandler,
            fightProperties,
        };
        const decided0 = strategy.decideTurn(unit, decisionContext);
        if (config.decisionObserver) {
            config.decisionObserver({
                unit,
                context: decisionContext,
                incumbent: decided0,
                strategyVersion: strategy.version,
            });
        }
        // Lookahead only re-decides for the v0.5 side, so a v0.5-vs-v0.4 run measures exactly whether
        // adding search to v0.5 beats its own single-decision baseline (the opponent replies with its own
        // policy inside the simulation, but plays its real turns un-searched). Default OFF -> decided0.
        const decided =
            lookahead.enabled && strategy.version === "v0.5" ? lookahead.chooseDecision(unit, decided0) : decided0;

        let didSomething = false;
        // Skip-audit bookkeeping (only meaningful when SKIP_AUDIT.enabled): what actually landed this turn,
        // and what the strategy PROPOSED, so the recovery branch can label WHY a turn landed nothing.
        let auditWaited = false;
        let auditAttacked = false;
        let auditMoved = false;
        const auditProposedAttack = decided.some((a) => a.type === "melee_attack" || a.type === "range_attack");
        const auditProposedMove = decided.some((a) => a.type === "move_unit");
        for (const action of decided) {
            const fromCell = { ...unit.getBaseCell() };
            const result = engine.apply(action);
            if (result.completed && action.type !== "select_attack_type") {
                didSomething = true; // a real action landed (a move or an attack)
                if (action.type === "wait_turn") {
                    auditWaited = true;
                } else if (action.type === "move_unit") {
                    auditMoved = true;
                } else if (
                    action.type === "melee_attack" ||
                    action.type === "range_attack" ||
                    action.type === "cast_spell"
                ) {
                    auditAttacked = true;
                }
            }
            if (!result.completed && action.type !== "select_attack_type") {
                // The strategy proposed a command the engine declined — a smooth AI should never do this.
                if (unit.getTeam() === GREEN_TEAM) {
                    rejectedGreen += 1;
                } else {
                    rejectedRed += 1;
                }
                let cause: string | undefined;
                if (action.type === "melee_attack") {
                    const tgt = unitsHolder.getAllUnits().get(action.targetId);
                    const af = action.attackFrom ?? unit.getBaseCell();
                    const afCells = unit.isSmallSize()
                        ? [af]
                        : [af, { x: af.x, y: af.y - 1 }, { x: af.x - 1, y: af.y }, { x: af.x - 1, y: af.y - 1 }];
                    const bc = unit.getBaseCell();
                    const stationary = af.x === bc.x && af.y === bc.y;
                    const sel = unit.getAttackTypeSelection();
                    const forced = unit.getTarget();
                    if (!tgt || tgt.isDead()) {
                        cause = "target_gone";
                    } else if (tgt.hasBuffActive("Hidden")) {
                        cause = "hidden";
                    } else if (sel !== PBTypes.AttackVals.MELEE && sel !== PBTypes.AttackVals.MELEE_MAGIC) {
                        cause = "not_melee_selected";
                    } else if (forced && forced !== tgt.getId()) {
                        cause = "forced_target_mismatch";
                    } else if (unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < tgt.getCumulativeHp()) {
                        cause = "cowardice";
                    } else if (!grid.areCellsAdjacent(afCells, tgt.getCells())) {
                        cause = "not_adjacent";
                    } else if (!stationary && !unit.canMove()) {
                        cause = "cannot_move";
                    } else if (!stationary && (!action.path || !action.path.length)) {
                        cause = "no_path";
                    } else if (
                        !stationary &&
                        !grid.areAllCellsEmpty(afCells, unit.getId()) &&
                        !grid.canOccupyCells(
                            afCells,
                            unit.hasAbilityActive("Made of Fire"),
                            unit.hasAbilityActive("Made of Water"),
                        )
                    ) {
                        cause = "cell_occupied";
                    } else {
                        cause = "other";
                    }
                } else if (action.type === "range_attack") {
                    const tgt = unitsHolder.getAllUnits().get(action.targetId);
                    if (!tgt || tgt.isDead()) {
                        cause = "target_gone";
                    } else if (tgt.hasBuffActive("Hidden")) {
                        cause = "hidden";
                    } else if (unit.hasDebuffActive("Range Null Field Aura")) {
                        cause = "null_field";
                    } else if (unit.hasDebuffActive("Rangebane")) {
                        cause = "rangebane";
                    } else if (unit.getAttackTypeSelection() !== PBTypes.AttackVals.RANGE) {
                        cause = "not_range_selected";
                    } else if (unit.getRangeShots() <= 0) {
                        cause = "no_ammo";
                    } else {
                        cause = action.aimCell ? "shot_no_hit_aimed" : "shot_no_hit_noaim";
                    }
                } else if (action.type === "cast_spell") {
                    cause = `spell:${action.spellName}${action.targetId ? "" : ":self/mass"}`;
                }
                rejectedDetails.push({
                    type: action.type,
                    reason: result.rejectionReason,
                    version: (unit.getTeam() === GREEN_TEAM ? greenStrategy : redStrategy).version,
                    creature: unit.getName(),
                    ammo: unit.getRangeShots(),
                    possible: unit.getPossibleAttackTypes().join("|"),
                    cause,
                });
            }
            recordAction(actions, action, unit, fromCell, result, unitsHolder, fightProperties.getCurrentLap());
            applyEvents(result.events);
            if (finished) {
                break;
            }
        }

        // A move_unit leaves the unit ACTIVE (it may attack after moving), so a turn can be incomplete
        // even though the unit acted. Only RECOVER when nothing landed — i.e. the engine declined every
        // proposal (a doomed attack) — so the turn isn't wasted: advance toward the enemy, else defend.
        // Then close out the turn. Only completed actions are recorded, so a declined proposal never
        // shows up as a "rejected" turn.
        if (SKIP_AUDIT.enabled && didSomething) {
            // The turn landed something: hourglass park, an attack, or a plain move.
            auditTurn(
                auditWaited ? "hourglass" : auditAttacked ? "attack" : auditMoved ? "move" : "acted",
                unit.getName(),
            );
        }
        if (!finished && currentActiveUnitId === actingUnitId && !didSomething) {
            const recover = (action: GameAction): boolean => {
                if (finished || currentActiveUnitId !== actingUnitId) {
                    return false;
                }
                const r = engine.apply(action);
                recordAction(
                    actions,
                    action,
                    unit,
                    { ...unit.getBaseCell() },
                    r,
                    unitsHolder,
                    fightProperties.getCurrentLap(),
                );
                applyEvents(r.events);
                return r.completed;
            };
            const advance = advanceTowardEnemyAction(unit, grid, unitsHolder, pathHelper);
            const advanced = !!advance && recover(advance);
            if (!advanced) {
                recover({ type: "defend_turn", unitId: actingUnitId });
            }
            if (SKIP_AUDIT.enabled) {
                // decideTurn landed NOTHING — this is exactly what the client renders as "skips turn" (it has
                // no advance/defend net). Label by what was proposed, whether the sim could still advance
                // (client would skip, sim moves) or only defend (truly stuck), unit size, and re-up state.
                const proposed = auditProposedAttack ? "atkrej" : auditProposedMove ? "movrej" : "idle";
                const recovery = advanced ? "advance" : "defend";
                const size = unit.isSmallSize() ? "small" : "large";
                const reup = fightProperties.hasAlreadyHourglass(unit.getId()) ? "_reup" : "";
                auditTurn(`skip_${proposed}_${recovery}_${size}${reup}`, unit.getName());
            }
        }
        if (!finished && currentActiveUnitId === actingUnitId) {
            const endResult = engine.apply({ type: "end_turn", unitId: actingUnitId, reason: "manual" });
            applyEvents(endResult.events);
            if (!endResult.completed) {
                currentActiveUnitId = ""; // could not even end the turn — bail rather than loop forever
            }
        }
    }

    // Armageddon "decided" the game when it both reached that phase and actually destroyed units —
    // i.e. the result leaned on environmental attrition rather than a clean combat kill.
    attrition.decidedByArmageddon = attrition.reachedArmageddon && attrition.unitsKilledByArmageddon > 0;

    const matchResult = buildResult(
        config,
        endReason,
        actions,
        placements,
        unitsHolder,
        fightProperties,
        greenStrategy.version,
        redStrategy.version,
        attrition,
    );
    matchResult.rejectedGreen = rejectedGreen;
    matchResult.rejectedRed = rejectedRed;
    matchResult.rejectedDetails = rejectedDetails;
    if (VALUE_DATA_FILE && valueSnaps.length && matchResult.winner !== "draw") {
        // Label each position by whether the acting team ultimately won, then append as JSONL. One write per
        // game keeps concurrent-worker appends atomic enough for data gen (each line is a self-contained row).
        const rows = valueSnaps
            .map((s) => `${JSON.stringify([...s.f, sideForTeam(s.team) === matchResult.winner ? 1 : 0])}`)
            .join("\n");
        try {
            appendFileSync(VALUE_DATA_FILE, rows + "\n");
        } catch {
            /* best-effort data capture */
        }
    }
    return matchResult;
}

function placeArmy(
    units: Unit[],
    team: TeamType,
    zone: RectanglePlacement,
    strategy: ReturnType<typeof getAIStrategy>,
    roster: IArmyUnitSpec[],
    engine: GameActionEngine,
    grid: Grid,
    unitsHolder: UnitsHolder,
    pathHelper: PathHelper,
): IPlacementRecord[] {
    const records: IPlacementRecord[] = [];
    const legal = zone.possibleCellHashes();
    const occupied = new Set<number>();

    const desired = strategy.placeArmy(units, { team, grid, unitsHolder, pathHelper, placement: zone });

    const tryPlaceAt = (unit: Unit, base: XY): boolean => {
        const cells = footprintCells(unit, base);
        if (cells.some((c) => !legal.has(cellKey(c)) || occupied.has(cellKey(c)))) {
            return false;
        }
        const result = engine.apply({
            type: "place_unit",
            unitId: unit.getId(),
            team,
            unitName: unit.getName(),
            cells,
        });
        if (!result.completed) {
            return false;
        }
        for (const c of cells) {
            occupied.add(cellKey(c));
        }
        return true;
    };

    const legalBaseCells: XY[] = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));

    for (const unit of units) {
        const base = desired.get(unit.getId());
        let placed = base ? tryPlaceAt(unit, base) : false;
        if (!placed) {
            for (const candidate of legalBaseCells) {
                if (tryPlaceAt(unit, candidate)) {
                    placed = true;
                    break;
                }
            }
        }
        if (placed) {
            const spec = roster[units.indexOf(unit)];
            records.push({
                unitId: unit.getId(),
                creatureName: unit.getName(),
                level: spec?.level ?? 0,
                size: spec?.size ?? (unit.isSmallSize() ? 1 : 2),
                amount: unit.getAmountAlive(),
                cell: { ...unit.getBaseCell() },
            });
        }
    }
    return records;
}

function recordAction(
    actions: IRecordedAction[],
    action: GameAction,
    unit: Unit,
    fromCell: XY,
    result: { completed: boolean; events: GameEvent[]; rejectionReason?: string },
    unitsHolder: UnitsHolder,
    lap: number,
): void {
    // Large/long runs (e.g. 1M-game per-unit win-rate sweeps) don't need the per-action log; skipping it
    // keeps each match record tiny so the worker->main serialisation stays cheap. Winner/attrition/outcome
    // are computed from unit state, not from this array, so they're unaffected.
    if (process.env.SIM_NO_ACTIONS) {
        return;
    }
    if (action.type === "select_attack_type") {
        return; // bookkeeping action, not a turn move
    }
    if (!result.completed) {
        return; // the engine declined this proposal — it isn't an action the unit took, so don't log it
    }
    const attackEvent = result.events.find((e) => e.type === "unit_attacked");
    let targetId: string | undefined;
    let toCell: XY | undefined;
    if (action.type === "melee_attack" || action.type === "range_attack") {
        targetId = action.targetId;
    }
    if (action.type === "melee_attack" && action.attackFrom) {
        toCell = { ...action.attackFrom };
    }
    if (action.type === "move_unit" && action.path?.length) {
        toCell = { ...action.path[action.path.length - 1] };
    }
    const targetUnit = targetId ? unitsHolder.getAllUnits().get(targetId) : undefined;
    actions.push({
        index: actions.length,
        lap,
        side: sideForTeam(unit.getTeam()),
        unitId: unit.getId(),
        creatureName: unit.getName(),
        fromCell,
        actionType: action.type,
        targetId,
        targetCreature: targetUnit?.getName(),
        toCell,
        completed: result.completed,
        rejectionReason: result.completed ? undefined : result.rejectionReason,
        damage: attackEvent?.type === "unit_attacked" ? attackEvent.damage.amount : undefined,
        unitIdsDied:
            attackEvent?.type === "unit_attacked" && attackEvent.unitIdsDied.length
                ? [...attackEvent.unitIdsDied]
                : undefined,
        secondaryHits:
            attackEvent?.type === "unit_attacked"
                ? (attackEvent.damage.secondary?.length ?? 0) + (attackEvent.damage.splash?.length ?? 0)
                : undefined,
    });
}

function sideOutcome(team: TeamType, version: string, unitsHolder: UnitsHolder): ISideOutcome {
    const alive = unitsHolder.getAllAllies(team).filter((u) => !u.isDead());
    return {
        version,
        unitsAlive: alive.length,
        creaturesAlive: alive.reduce((sum, u) => sum + u.getAmountAlive(), 0),
        hpRemaining: alive.reduce((sum, u) => sum + u.getCumulativeHp(), 0),
    };
}

function buildResult(
    config: IMatchConfig,
    endReason: IMatchResult["endReason"],
    actions: IRecordedAction[],
    placements: { green: IPlacementRecord[]; red: IPlacementRecord[] },
    unitsHolder: UnitsHolder,
    fightProperties: ReturnType<FightStateManager["getFightProperties"]>,
    greenVersion: string,
    redVersion: string,
    attrition: IAttritionInfo,
): IMatchResult {
    const green = sideOutcome(GREEN_TEAM, greenVersion, unitsHolder);
    const red = sideOutcome(RED_TEAM, redVersion, unitsHolder);

    let winner: Side | "draw";
    if (green.unitsAlive > 0 && red.unitsAlive === 0) {
        winner = "green";
    } else if (red.unitsAlive > 0 && green.unitsAlive === 0) {
        winner = "red";
    } else if (green.unitsAlive === 0 && red.unitsAlive === 0) {
        winner = "draw";
    } else {
        // Both sides still standing (turn cap / stuck): decide on points (surviving HP), else draw.
        winner = green.hpRemaining > red.hpRemaining ? "green" : red.hpRemaining > green.hpRemaining ? "red" : "draw";
    }

    return {
        seed: config.seed,
        gridType: config.gridType ?? PBTypes.GridVals.NORMAL,
        winner,
        endReason,
        laps: fightProperties.getCurrentLap(),
        totalActions: actions.length,
        roster: config.roster,
        redRoster: config.redRoster,
        placements,
        actions,
        outcome: { green, red },
        attrition,
        greenArtifactT1: config.greenArtifactT1,
        redArtifactT1: config.redArtifactT1,
        greenArtifactT2: config.greenArtifactT2,
        redArtifactT2: config.redArtifactT2,
    };
}
