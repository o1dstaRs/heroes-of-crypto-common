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

import { getAIStrategy } from "../ai";
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
import { PathHelper } from "../grid/path_helper";
import { PlacementPositionType } from "../grid/placement_properties";
import { RectanglePlacement } from "../grid/rectangle_placement";
import { AttackHandler } from "../handlers/attack_handler";
import { MoveHandler } from "../handlers/move_handler";
import type { IDamageStatistic } from "../scene/scene_stats";
import { SceneLogMock } from "../scene/scene_log_mock";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import { FightStateManager } from "../fights/fight_state_manager";
import type { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";
import { ToFactionName } from "../factions/faction_type";
import { createCombatFactories, createUnitFromSpec, type IArmyUnitSpec } from "./army";

/** Green plays the LOWER team, red plays UPPER — matching the e2e/ranked convention. */
export type Side = "green" | "red";
export const GREEN_TEAM: TeamType = PBTypes.TeamVals.LOWER;
export const RED_TEAM: TeamType = PBTypes.TeamVals.UPPER;
const sideForTeam = (team: TeamType): Side => (team === GREEN_TEAM ? "green" : "red");

export interface IMatchConfig {
    greenVersion: string;
    redVersion: string;
    /** Identical roster handed to BOTH teams (mirrored match). */
    roster: IArmyUnitSpec[];
    /** Recorded for reproducibility (drives roster selection upstream; stored here as provenance). */
    seed: number;
    /** Hard cap on laps before the match is called a draw-on-points. Default 60. */
    maxLaps?: number;
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
    winner: Side | "draw";
    endReason: "elimination" | "turn_cap" | "stuck";
    laps: number;
    totalActions: number;
    roster: IArmyUnitSpec[];
    placements: { green: IPlacementRecord[]; red: IPlacementRecord[] };
    actions: IRecordedAction[];
    outcome: { green: ISideOutcome; red: ISideOutcome };
    attrition: IAttritionInfo;
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
 * Run one headless AI-vs-AI battle to completion and return a fully recorded match (placements, every
 * action both sides took, and the winner). Pure in-process — no network, no rendering. The two sides
 * receive the SAME roster, so the only variable is the AI version driving each.
 */
export function runMatch(config: IMatchConfig): IMatchResult {
    const maxLaps = config.maxLaps ?? 60;
    const gridSettings = simulationGridSettings();

    FightStateManager.getInstance().reset();
    const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
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

    // --- build armies (identical rosters for both teams) ---
    const greenUnits = config.roster.map((spec) =>
        createUnitFromSpec(spec, GREEN_TEAM, gridSettings, abilityFactory, effectFactory),
    );
    const redUnits = config.roster.map((spec) =>
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
            config.roster,
            engine,
            grid,
            unitsHolder,
            pathHelper,
        ),
        red: placeArmy(redUnits, RED_TEAM, redZone, redStrategy, config.roster, engine, grid, unitsHolder, pathHelper),
    };

    // --- run the fight ---
    const actions: IRecordedAction[] = [];
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
        if (!unit) {
            currentActiveUnitId = "";
            continue;
        }
        const actingUnitId = currentActiveUnitId;
        const strategy = unit.getTeam() === GREEN_TEAM ? greenStrategy : redStrategy;
        const matrix = grid.getMatrix();
        const decided = strategy.decideTurn(unit, {
            grid,
            matrix,
            unitsHolder,
            pathHelper,
            attackHandler,
            fightProperties,
        });

        for (const action of decided) {
            const fromCell = { ...unit.getBaseCell() };
            const result = engine.apply(action);
            recordAction(actions, action, unit, fromCell, result, unitsHolder, fightProperties.getCurrentLap());
            applyEvents(result.events);
            if (finished) {
                break;
            }
        }

        // Safety net: a unit must always yield its turn. If its chosen actions didn't complete it (e.g.
        // an attack the engine rejected), DON'T waste the turn — DEFEND (a valid, useful action: a
        // defense bonus) so the fight always flows smoothly. end_turn is the last-resort guarantee.
        if (!finished && currentActiveUnitId === actingUnitId) {
            const defendAction: GameAction = { type: "defend_turn", unitId: actingUnitId };
            const defendResult = engine.apply(defendAction);
            recordAction(
                actions,
                defendAction,
                unit,
                { ...unit.getBaseCell() },
                defendResult,
                unitsHolder,
                fightProperties.getCurrentLap(),
            );
            applyEvents(defendResult.events);
            if (!finished && currentActiveUnitId === actingUnitId) {
                const endResult = engine.apply({ type: "end_turn", unitId: actingUnitId, reason: "manual" });
                applyEvents(endResult.events);
                if (!endResult.completed) {
                    // Could not even end the turn — bail rather than loop forever.
                    currentActiveUnitId = "";
                }
            }
        }
    }

    // Armageddon "decided" the game when it both reached that phase and actually destroyed units —
    // i.e. the result leaned on environmental attrition rather than a clean combat kill.
    attrition.decidedByArmageddon = attrition.reachedArmageddon && attrition.unitsKilledByArmageddon > 0;

    return buildResult(
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
    if (action.type === "select_attack_type") {
        return; // bookkeeping action, not a turn move
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
        winner,
        endReason,
        laps: fightProperties.getCurrentLap(),
        totalActions: actions.length,
        roster: config.roster,
        placements,
        actions,
        outcome: { green, red },
        attrition,
    };
}
