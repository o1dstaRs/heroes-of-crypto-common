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

import { getSpellConfig } from "../configuration/config_provider";
import {
    MAX_HOLE_LAYERS,
    MORALE_CHANGE_FOR_SKIP,
    NUMBER_OF_ARMAGEDDON_WAVES,
    NUMBER_OF_LAPS_TILL_STOP_NARROWING,
} from "../constants";
import { FightProperties } from "../fights/fight_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { Grid } from "../grid/grid";
import { UPDATE_DOWN, UPDATE_LEFT, UPDATE_RIGHT, UPDATE_UP } from "../grid/grid_constants";
import { MoveHandler, type ISystemMoveResult } from "../handlers/move_handler";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Spell } from "../spells/spell";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import type { GameEvent } from "./events";
import { createDefaultGameRuntime, type IGameRuntime, shuffleWithRng } from "./runtime";

export interface ITurnEngineContext {
    fightProperties: FightProperties;
    grid: Grid;
    unitsHolder: UnitsHolder;
    moveHandler: MoveHandler;
    sceneLog: ISceneLog;
    getCurrentActiveUnitId?: () => string | undefined;
    canLandRangeAttack?: (unit: Unit) => boolean;
    runtime?: IGameRuntime;
}

export interface IAdvanceTurnOptions {
    centerAlreadyDried?: boolean;
    damageDealtThisLap?: boolean;
}

export interface IAdvanceTurnResult {
    events: GameEvent[];
    nextUnit?: Unit;
    fightFinished: boolean;
}

export type TurnSkipReason = "effect" | "timeout" | "manual";

interface IOrderedTurnUnits {
    allUnits: Unit[];
    unitsUpper: Unit[];
    unitsLower: Unit[];
}

export class TurnEngine {
    private readonly fightProperties: FightProperties;
    private readonly grid: Grid;
    private readonly unitsHolder: UnitsHolder;
    private readonly moveHandler: MoveHandler;
    private readonly sceneLog: ISceneLog;
    private readonly canLandRangeAttack?: (unit: Unit) => boolean;
    private readonly runtime: IGameRuntime;
    public constructor(context: ITurnEngineContext) {
        this.fightProperties = context.fightProperties;
        this.grid = context.grid;
        this.unitsHolder = context.unitsHolder;
        this.moveHandler = context.moveHandler;
        this.sceneLog = context.sceneLog;
        this.canLandRangeAttack = context.canLandRangeAttack;
        this.runtime = context.runtime ?? createDefaultGameRuntime();
    }
    public completeTurn(
        unit: Unit,
        opts: { hourglass?: boolean; skipReason?: TurnSkipReason; skipLogMessage?: string } = {},
    ): GameEvent[] {
        const hourglass = opts.hourglass ?? false;
        const events: GameEvent[] = [];

        if (opts.skipReason) {
            unit.decreaseMorale(
                MORALE_CHANGE_FOR_SKIP,
                this.fightProperties.getAdditionalMoralePerTeam(unit.getTeam()),
            );
            this.sceneLog.updateLog(opts.skipLogMessage ?? `${unit.getName()} skips turn`);
            events.push({ type: "unit_skipped", unitId: unit.getId(), team: unit.getTeam(), reason: opts.skipReason });
        }

        if (!hourglass) {
            unit.minusLap();
            this.fightProperties.addAlreadyMadeTurn(unit.getTeam(), unit.getId(), this.runtime.clock.nowMillis());
            this.fightProperties.removeFromUpNext(unit.getId());
            unit.setOnHourglass(false);
        }

        this.unitsHolder.refreshStackPowerForAllUnits();

        events.push({
            type: "turn_completed",
            unitId: unit.getId(),
            team: unit.getTeam(),
            hourglass,
        });

        return events;
    }
    public advanceAfterNoActiveUnit(opts: IAdvanceTurnOptions = {}): IAdvanceTurnResult {
        const events: GameEvent[] = [];
        let ordered = this.getOrderedTurnUnits();

        const finishEvent = this.finishFightIfNeeded(ordered.unitsLower, ordered.unitsUpper);
        if (finishEvent) {
            events.push(finishEvent);
            return { events, fightFinished: true };
        }

        const initFirstLap =
            this.fightProperties.getCurrentLap() === 1 &&
            !this.fightProperties.getHourglassQueueSize() &&
            !this.fightProperties.getUpNextQueueSize();
        const allUnitsMadeTurn =
            ordered.unitsUpper.every((u) => this.fightProperties.hasAlreadyMadeTurn(u.getId())) &&
            ordered.unitsLower.every((u) => this.fightProperties.hasAlreadyMadeTurn(u.getId()));

        if ((initFirstLap || allUnitsMadeTurn) && !this.fightProperties.hasFightFinished()) {
            events.push(...this.handleLapTransition(ordered.unitsUpper, ordered.unitsLower, allUnitsMadeTurn, opts));
            ordered = this.getOrderedTurnUnits();
        }

        if (this.fightProperties.hasFightFinished()) {
            return { events, fightFinished: true };
        }

        const afterTransitionFinish = this.finishFightIfNeeded(ordered.unitsLower, ordered.unitsUpper);
        if (afterTransitionFinish) {
            events.push(afterTransitionFinish);
            return { events, fightFinished: true };
        }

        this.fightProperties.prefetchNextUnitsToTurn(
            this.unitsHolder.getAllUnits(),
            ordered.unitsUpper,
            ordered.unitsLower,
            (min, max) => this.runtime.rng.int(min, max),
        );

        let nextUnitId = this.fightProperties.dequeueNextUnitId();
        let nextUnit = nextUnitId ? this.unitsHolder.getAllUnits().get(nextUnitId) : undefined;
        // Skip stale queue entries: an id can outlive its unit in upNext, and a stale id at the front
        // would otherwise return no next unit (and no events), stranding the turn order with valid
        // units still queued behind it. Drain past any such entries to the next real unit.
        while (nextUnitId && !nextUnit && this.fightProperties.getUpNextQueueSize() > 0) {
            nextUnitId = this.fightProperties.dequeueNextUnitId();
            nextUnit = nextUnitId ? this.unitsHolder.getAllUnits().get(nextUnitId) : undefined;
        }

        if (nextUnit) {
            const activationEvents = this.activateNextUnit(nextUnit);
            events.push({ type: "next_unit_selected", unitId: nextUnit.getId(), team: nextUnit.getTeam() });
            events.push(...activationEvents);
            if (activationEvents.some((event) => event.type === "unit_skipped")) {
                return { events, fightFinished: false };
            }
        }

        return { events, nextUnit, fightFinished: false };
    }
    private handleLapTransition(
        unitsUpper: Unit[],
        unitsLower: Unit[],
        allUnitsMadeTurn: boolean,
        opts: IAdvanceTurnOptions,
    ): GameEvent[] {
        const events: GameEvent[] = [];
        const allCurrentUnits = [...unitsUpper, ...unitsLower];

        for (const unit of allCurrentUnits) {
            unit.setResponded(false);
            unit.setOnHourglass(false);
        }

        if (opts.damageDealtThisLap) {
            this.fightProperties.encounterDamageDealFact();
        }

        if (this.fightProperties.getFirstTurnMade()) {
            const previousLap = this.fightProperties.getCurrentLap();
            this.fightProperties.flipLap();
            events.push({
                type: "lap_flipped",
                previousLap,
                currentLap: this.fightProperties.getCurrentLap(),
            });

            const gridType = this.fightProperties.getGridType();
            const meltable = gridType === PBTypes.GridVals.LAVA_CENTER || gridType === PBTypes.GridVals.WATER_CENTER;
            if (
                meltable &&
                !opts.centerAlreadyDried &&
                this.fightProperties.getLapsNarrowed() >= this.fightProperties.getNumberOfLapsTillNarrowing()
            ) {
                this.grid.cleanupCenterObstacle();
                events.push({ type: "center_dried", gridType });
            }
        } else {
            events.push({ type: "lap_initialized", lap: this.fightProperties.getCurrentLap() });
        }

        events.push(...this.applyArmageddonIfNeeded([...unitsLower, ...unitsUpper]));
        let refreshed = this.getOrderedTurnUnits();
        const finishEvent = this.finishFightIfNeeded(refreshed.unitsLower, refreshed.unitsUpper);
        if (finishEvent) {
            events.push(finishEvent);
            return events;
        }

        const distancesDecreased = this.unitsHolder.haveDistancesToClosestEnemiesDecreased();
        if (allUnitsMadeTurn && (!distancesDecreased || this.fightProperties.isNarrowingLap())) {
            let encounterCurrent = false;
            if (
                !distancesDecreased &&
                !this.fightProperties.hasDamageDealFactPerLap(this.fightProperties.getCurrentLap() - 1) &&
                !this.fightProperties.isNarrowingLap()
            ) {
                this.fightProperties.encounterAdditionalNarrowingLap();
                encounterCurrent = true;
            }
            events.push(...this.applyNarrowing(encounterCurrent));
            this.fightProperties.increaseStepsMoraleMultiplier();
            this.unitsHolder.refreshStackPowerForAllUnits();
            refreshed = this.getOrderedTurnUnits();
        }

        events.push(...this.applyMoraleRolls(refreshed.allUnits));

        this.fightProperties.prefetchNextUnitsToTurn(
            this.unitsHolder.getAllUnits(),
            refreshed.unitsUpper,
            refreshed.unitsLower,
            (min, max) => this.runtime.rng.int(min, max),
        );

        return events;
    }
    private applyNarrowing(encounterCurrent: boolean): GameEvent[] {
        const events: GameEvent[] = [];

        if (this.fightProperties.getCurrentLap() > NUMBER_OF_LAPS_TILL_STOP_NARROWING) {
            return events;
        }

        const calculatedLaps =
            Math.floor(
                (this.fightProperties.getCurrentLap() - (encounterCurrent ? 1 : 0)) /
                    this.fightProperties.getNumberOfLapsTillNarrowing(),
            ) + this.fightProperties.getAdditionalNarrowingLaps();

        if (calculatedLaps < 1) {
            return events;
        }

        const totalLaps = Math.min(calculatedLaps, MAX_HOLE_LAYERS);
        const gridSettings = this.grid.getSettings();
        const minCellX = gridSettings.getMinX() / gridSettings.getCellSize();
        const maxCellX = gridSettings.getMaxX() / gridSettings.getCellSize();
        const minCellY = gridSettings.getMinY() / gridSettings.getCellSize();
        const maxCellY = gridSettings.getMaxY() / gridSettings.getCellSize();

        events.push({
            type: "narrowing_applied",
            lap: this.fightProperties.getCurrentLap(),
            layers: totalLaps,
            encounterCurrent,
        });

        for (let layer = 1; layer <= totalLaps; layer++) {
            const offset = layer - 1;

            for (let i = minCellX + offset; i < maxCellX - offset; i++) {
                const cell = { x: i + maxCellX, y: offset };
                events.push(
                    ...this.handleSystemMoveResult(this.moveHandler.moveUnitTowardsCenter(cell, UPDATE_UP, layer)),
                );
                this.grid.occupyByHole(cell);
            }

            for (let i = minCellX + offset; i < maxCellX - offset; i++) {
                const cell = { x: i + maxCellX, y: maxCellY - layer };
                events.push(
                    ...this.handleSystemMoveResult(this.moveHandler.moveUnitTowardsCenter(cell, UPDATE_DOWN, layer)),
                );
                this.grid.occupyByHole(cell);
            }

            for (let i = minCellY + offset; i < maxCellY - offset; i++) {
                const cell = { x: offset, y: i };
                events.push(
                    ...this.handleSystemMoveResult(this.moveHandler.moveUnitTowardsCenter(cell, UPDATE_RIGHT, layer)),
                );
                this.grid.occupyByHole(cell);
            }

            for (let i = minCellY + offset; i < maxCellY - offset; i++) {
                const cell = { x: (maxCellX << 1) - layer, y: i };
                events.push(
                    ...this.handleSystemMoveResult(this.moveHandler.moveUnitTowardsCenter(cell, UPDATE_LEFT, layer)),
                );
                this.grid.occupyByHole(cell);
            }
        }

        return events;
    }
    private handleSystemMoveResult(result: ISystemMoveResult): GameEvent[] {
        const events: GameEvent[] = [];

        if (result.log) {
            for (const line of result.log.split("\n")) {
                if (line) this.sceneLog.updateLog(line);
            }
        }

        for (const [unitId, position] of result.unitIdToNewPosition.entries()) {
            events.push({ type: "unit_moved_by_system", unitId, position, reason: "narrowing" });
        }

        for (const unitId of result.unitIdsDestroyed) {
            if (this.unitsHolder.deleteUnitById(unitId)) {
                events.push({ type: "unit_destroyed", unitId, reason: "narrowing" });
            }
        }

        return events;
    }
    private applyArmageddonIfNeeded(units: Unit[]): GameEvent[] {
        const events: GameEvent[] = [];
        const wave = this.fightProperties.getArmageddonWave();

        if (wave <= 0 || wave > NUMBER_OF_ARMAGEDDON_WAVES) {
            return events;
        }

        for (const unit of units) {
            const amountAliveBefore = unit.getAmountAlive();
            const damage = unit.applyArmageddonDamage(wave, this.sceneLog);
            const unitsDied = Math.max(0, amountAliveBefore - unit.getAmountAlive());
            events.push({ type: "armageddon_applied", unitId: unit.getId(), wave, damage, unitsDied });
            if (unit.isDead() && this.unitsHolder.deleteUnitById(unit.getId(), wave === 1)) {
                events.push({ type: "unit_destroyed", unitId: unit.getId(), reason: "armageddon" });
            }
        }

        return events;
    }
    private applyMoraleRolls(units: Unit[]): GameEvent[] {
        const events: GameEvent[] = [];
        const lap = this.fightProperties.getCurrentLap();

        for (const unit of units) {
            if (!unit.getMorale()) continue;
            const isPlusMorale = unit.getMorale() > 0;
            const chance = this.runtime.rng.int(0, 100);
            if (chance >= Math.abs(unit.getMorale()) || unit.hasMindAttackResistance()) {
                continue;
            }

            if (isPlusMorale) {
                const buff = new Spell({
                    spellProperties: getSpellConfig("System", "Morale"),
                    amount: 1,
                });
                unit.applyBuff(buff);
                this.fightProperties.enqueueMoralePlus(unit.getId());
                this.sceneLog.updateLog(`${unit.getName()} is on Morale this lap!`);
                events.push({ type: "morale_applied", unitId: unit.getId(), kind: "plus", lap });
            } else {
                const debuff = new Spell({
                    spellProperties: getSpellConfig("System", "Dismorale"),
                    amount: 1,
                });
                unit.applyDebuff(debuff);
                this.fightProperties.enqueueMoraleMinus(unit.getId());
                this.sceneLog.updateLog(`${unit.getName()} is on Dismorale this lap!`);
                events.push({ type: "morale_applied", unitId: unit.getId(), kind: "minus", lap });
            }
        }

        return events;
    }
    private activateNextUnit(unit: Unit): GameEvent[] {
        const events: GameEvent[] = [];
        if (unit.isOnHourglass()) {
            unit.setOnHourglass(false);
        }
        this.fightProperties.startTurn(unit.getTeam(), this.runtime.clock.nowMillis());
        unit.refreshPreTurnState(this.sceneLog);
        unit.refreshPossibleAttackTypes(this.canLandRangeAttack?.(unit) ?? true);
        this.fightProperties.markFirstTurn();

        if (unit.isSkippingThisTurn()) {
            events.push(...this.completeTurn(unit, { skipReason: "effect" }));
        }

        return events;
    }
    private finishFightIfNeeded(unitsLower: Unit[], unitsUpper: Unit[]): GameEvent | undefined {
        if (unitsLower.length && unitsUpper.length) {
            return undefined;
        }

        // Both sides can be wiped out on the same lap (e.g. armageddon kills everyone at once) — that's
        // a draw, NOT an UPPER win. Only award a team the win when it's the sole side with units left.
        let winningTeam: TeamType;
        if (unitsLower.length) {
            winningTeam = PBTypes.TeamVals.LOWER;
        } else if (unitsUpper.length) {
            winningTeam = PBTypes.TeamVals.UPPER;
        } else {
            winningTeam = PBTypes.TeamVals.NO_TEAM;
        }
        this.fightProperties.finishFight();
        return { type: "fight_finished", winningTeam };
    }
    private getOrderedTurnUnits(): IOrderedTurnUnits {
        const unitsUpper = this.getAliveTeamUnits(PBTypes.TeamVals.UPPER);
        const unitsLower = this.getAliveTeamUnits(PBTypes.TeamVals.LOWER);
        const allUnits = shuffleWithRng([...unitsUpper, ...unitsLower], this.runtime.rng).sort(
            (a, b) => b.getSpeed() - a.getSpeed(),
        );

        return {
            allUnits,
            unitsUpper: shuffleWithRng(unitsUpper, this.runtime.rng).sort((a, b) => b.getSpeed() - a.getSpeed()),
            unitsLower: shuffleWithRng(unitsLower, this.runtime.rng).sort((a, b) => b.getSpeed() - a.getSpeed()),
        };
    }
    private getAliveTeamUnits(team: TeamType): Unit[] {
        return this.unitsHolder.getAllAllies(team).filter((unit) => !unit.isDead());
    }
}
