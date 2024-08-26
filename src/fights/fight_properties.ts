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

import { v4 as uuidv4 } from "uuid";
import Denque from "denque";

import { GridType } from "../grid/grid";
import { TeamType } from "../units/unit_properties";
import { getRandomInt, getTimeMillis, uuidToUint8Array } from "../utils/lib";
import {
    MAX_TIME_TO_MAKE_TURN_MILLIS,
    MIN_TIME_TO_MAKE_TURN_MILLIS,
    NUMBER_OF_LAPS_TILL_NARROWING_BLOCK,
    NUMBER_OF_LAPS_TILL_NARROWING_NORMAL,
    STEPS_MORALE_MULTIPLIER,
    TOTAL_TIME_TO_MAKE_TURN_MILLIS,
} from "../constants";
import { Fight } from "../generated/protobuf/v1/fight_pb";
import { StringList } from "../generated/protobuf/v1/types_pb";

export class FightProperties {
    private readonly id: string;

    private currentLap: number;

    private readonly gridType: GridType;

    private firstTurnMade: boolean;

    private fightFinished: boolean;

    private previousTurnTeam: TeamType;

    private highestSpeedThisTurn: number;

    private readonly alreadyMadeTurn: Set<string>;

    private readonly alreadyMadeTurnByTeam: Map<TeamType, Set<string>>;

    private readonly alreadyHourGlass: Set<string>;

    private readonly alreadyRepliedAttack: Set<string>;

    private readonly teamUnitsAlive: Map<TeamType, number>;

    private readonly hourGlassQueue: Denque<string>;

    private readonly moralePlusQueue: Denque<string>;

    private readonly moraleMinusQueue: Denque<string>;

    private currentTurnStart: number;

    private currentTurnEnd: number;

    private readonly currentLapTotalTimePerTeam: Map<TeamType, number>;

    private readonly upNextQueue: Denque<string>;

    private stepsMoraleMultiplier: number;

    private readonly hasAdditionalTimeRequestedPerTeam: Map<TeamType, boolean>;

    public constructor() {
        this.id = uuidv4();
        this.currentLap = 1;
        this.gridType = this.getRandomGridType();
        this.firstTurnMade = false;
        this.fightFinished = false;
        this.previousTurnTeam = TeamType.NO_TEAM;
        this.highestSpeedThisTurn = 0;
        this.alreadyMadeTurn = new Set();
        this.alreadyMadeTurnByTeam = new Map();
        this.alreadyHourGlass = new Set();
        this.alreadyRepliedAttack = new Set();
        this.teamUnitsAlive = new Map();
        this.hourGlassQueue = new Denque();
        this.moralePlusQueue = new Denque();
        this.moraleMinusQueue = new Denque();
        this.currentTurnStart = 0;
        this.currentTurnEnd = 0;
        this.currentLapTotalTimePerTeam = new Map();
        this.upNextQueue = new Denque();
        this.stepsMoraleMultiplier = 0;
        this.hasAdditionalTimeRequestedPerTeam = new Map();
    }

    private getRandomGridType(): GridType {
        const randomValue = getRandomInt(0, 12);
        if (randomValue < 4) {
            return GridType.NORMAL;
        }
        if (randomValue > 7) {
            return GridType.BLOCK_CENTER;
        }
        if (randomValue < 6) {
            return GridType.WATER_CENTER;
        }

        return GridType.LAVA_CENTER;
    }

    public getId(): string {
        return this.id;
    }

    public getCurrentLap(): number {
        return this.currentLap;
    }

    public getGridType(): GridType {
        return this.gridType;
    }

    public getFirstTurnMade(): boolean {
        return this.firstTurnMade;
    }

    public getFightFinished(): boolean {
        return this.fightFinished;
    }

    public getPreviousTurnTeam(): TeamType {
        return this.previousTurnTeam;
    }

    public getHighestSpeedThisTurn(): number {
        return this.highestSpeedThisTurn;
    }

    public hasAlreadyMadeTurn(unitId: string): boolean {
        return this.alreadyMadeTurn.has(unitId);
    }

    public hasAlreadyHourGlass(unitId: string): boolean {
        return this.alreadyHourGlass.has(unitId);
    }

    public hasAlreadyRepliedAttack(unitId: string): boolean {
        return this.alreadyRepliedAttack.has(unitId);
    }

    public getAlreadyMadeTurnSize(): number {
        return this.alreadyMadeTurn.size;
    }

    public getMoraleMinusQueueSize(): number {
        return this.moraleMinusQueue.length;
    }

    public getMoralePlusQueueSize(): number {
        return this.moralePlusQueue.length;
    }

    public getHourGlassQueueSize(): number {
        return this.hourGlassQueue.length;
    }

    public getUpNextQueueSize(): number {
        return this.upNextQueue.length;
    }

    public getCurrentTurnStart(): number {
        return this.currentTurnStart;
    }

    public getCurrentTurnEnd(): number {
        return this.currentTurnEnd;
    }

    public upNextIncludes(unitId: string): boolean {
        for (let i = 0; i < this.upNextQueue.length; i++) {
            if (this.upNextQueue.get(i) === unitId) {
                return true;
            }
        }

        return false;
    }

    public moralePlusIncludes(unitId: string): boolean {
        for (let i = 0; i < this.moralePlusQueue.length; i++) {
            if (this.moralePlusQueue.get(i) === unitId) {
                return true;
            }
        }

        return false;
    }

    public moraleMinusIncludes(unitId: string): boolean {
        for (let i = 0; i < this.moraleMinusQueue.length; i++) {
            if (this.moraleMinusQueue.get(i) === unitId) {
                return true;
            }
        }

        return false;
    }

    public hourGlassIncludes(unitId: string): boolean {
        for (let i = 0; i < this.hourGlassQueue.length; i++) {
            if (this.hourGlassQueue.get(i) === unitId) {
                return true;
            }
        }

        return false;
    }

    public getStepsMoraleMultiplier(): number {
        return this.stepsMoraleMultiplier;
    }

    public getHasAdditionalTimeRequestedPerTeam(): Map<TeamType, boolean> {
        return this.hasAdditionalTimeRequestedPerTeam;
    }

    public dequeueNextUnitId(): string | undefined {
        return this.upNextQueue.shift();
    }

    public dequeueMoraleMinus(): string | undefined {
        return this.moraleMinusQueue.shift();
    }

    public dequeueMoralePlus(): string | undefined {
        return this.moralePlusQueue.shift();
    }

    public dequeueHourGlassQueue(): string | undefined {
        return this.hourGlassQueue.shift();
    }

    public setHighestSpeedThisTurn(highestSpeedThisTurn: number): void {
        this.highestSpeedThisTurn = highestSpeedThisTurn;
    }

    public startTurn(teamType: TeamType): void {
        let currentTotalTimePerTeam = this.currentLapTotalTimePerTeam.get(teamType);
        if (currentTotalTimePerTeam === undefined) {
            currentTotalTimePerTeam = 0;
        }

        let alreadyMadeTurnTeamMembers = 0;
        const alreadyMadeTurnTeamMembersSet = this.alreadyMadeTurnByTeam.get(teamType);
        if (alreadyMadeTurnTeamMembersSet) {
            alreadyMadeTurnTeamMembers = alreadyMadeTurnTeamMembersSet.size;
        }
        const teamMembersAlive =
            teamType === TeamType.LOWER
                ? (this.teamUnitsAlive.get(TeamType.LOWER) ?? 0)
                : (this.teamUnitsAlive.get(TeamType.UPPER) ?? 0);
        let teamMembersToMakeTurn = teamMembersAlive - alreadyMadeTurnTeamMembers - 1;
        if (teamMembersToMakeTurn < 0) {
            teamMembersToMakeTurn = 0;
        }

        const allocatedForOtherUnits = MIN_TIME_TO_MAKE_TURN_MILLIS * teamMembersToMakeTurn;
        const timeRemaining = TOTAL_TIME_TO_MAKE_TURN_MILLIS - currentTotalTimePerTeam - allocatedForOtherUnits;

        let maxTimeToMakeTurn = MAX_TIME_TO_MAKE_TURN_MILLIS;
        if (teamMembersAlive > 0 && teamMembersAlive - alreadyMadeTurnTeamMembers > 0) {
            maxTimeToMakeTurn = Math.min(
                maxTimeToMakeTurn,
                Math.ceil(
                    (TOTAL_TIME_TO_MAKE_TURN_MILLIS - currentTotalTimePerTeam) /
                        (teamMembersAlive - alreadyMadeTurnTeamMembers),
                ),
            );
        }

        this.currentTurnStart = getTimeMillis();
        this.currentTurnEnd = this.currentTurnStart + Math.min(timeRemaining, maxTimeToMakeTurn);
        // console.log(
        // `timeRemaining:${timeRemaining} currentTotalTimePerTeam:${currentTotalTimePerTeam} maxTimeToMakeTurn:${maxTimeToMakeTurn} alreadyMadeTurnTeamMembers:${alreadyMadeTurnTeamMembers}`,
        // );
    }

    public requestAdditionalTurnTime(teamType?: TeamType, justCheck = false): number {
        if (!teamType) {
            return 0;
        }

        const hasAdditionaTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(teamType);
        if (hasAdditionaTimeRequested) {
            return 0;
        }

        let currentTotalTimePerTeam = this.currentLapTotalTimePerTeam.get(teamType);
        if (currentTotalTimePerTeam === undefined) {
            currentTotalTimePerTeam = 0;
        }

        let alreadyMadeTurnTeamMembers = 0;
        const alreadyMadeTurnTeamMembersSet = this.alreadyMadeTurnByTeam.get(teamType);
        if (alreadyMadeTurnTeamMembersSet) {
            alreadyMadeTurnTeamMembers = alreadyMadeTurnTeamMembersSet.size;
        }
        const teamMembersAlive =
            teamType === TeamType.LOWER
                ? (this.teamUnitsAlive.get(TeamType.LOWER) ?? 0)
                : (this.teamUnitsAlive.get(TeamType.UPPER) ?? 0);

        let teamMembersToMakeTurn = teamMembersAlive - alreadyMadeTurnTeamMembers;
        if (teamMembersToMakeTurn < 0) {
            teamMembersToMakeTurn = 0;
        }
        const allocatedForOtherUnits = MIN_TIME_TO_MAKE_TURN_MILLIS * (teamMembersToMakeTurn - 1);
        const timeRemaining = TOTAL_TIME_TO_MAKE_TURN_MILLIS - currentTotalTimePerTeam - allocatedForOtherUnits;
        if (timeRemaining > 0 && teamMembersAlive - alreadyMadeTurnTeamMembers > 0) {
            const additionalTime = Math.min(
                MAX_TIME_TO_MAKE_TURN_MILLIS,
                Math.ceil(
                    (TOTAL_TIME_TO_MAKE_TURN_MILLIS - currentTotalTimePerTeam) /
                        (teamMembersAlive - alreadyMadeTurnTeamMembers),
                ),
            );
            if (!justCheck) {
                this.currentTurnEnd += additionalTime;
                this.hasAdditionalTimeRequestedPerTeam.set(teamType, true);
            }

            return additionalTime;
        }

        return 0;
    }

    public markFirstTurn(): void {
        this.firstTurnMade = true;
    }

    public finishFight(): void {
        this.fightFinished = true;
    }

    public flipLap(): void {
        this.alreadyMadeTurn.clear();
        this.alreadyMadeTurnByTeam.clear();
        this.alreadyHourGlass.clear();
        this.alreadyRepliedAttack.clear();
        this.currentLap++;
        this.hourGlassQueue.clear();
        this.moraleMinusQueue.clear();
        this.moralePlusQueue.clear();
        this.upNextQueue.clear();
        this.currentLapTotalTimePerTeam.clear();
        this.hasAdditionalTimeRequestedPerTeam.clear();
    }

    public isNarrowingLap(): boolean {
        return (
            this.currentLap > this.getNumberOfLapsTillNarrowing() &&
            this.currentLap % this.getNumberOfLapsTillNarrowing() === 1
        );
    }

    public getTeamUnitsAlive(teamType: TeamType): number {
        return this.teamUnitsAlive.get(teamType) ?? 0;
    }

    public getNumberOfLapsTillNarrowing(): number {
        return this.getGridType() === GridType.BLOCK_CENTER
            ? NUMBER_OF_LAPS_TILL_NARROWING_BLOCK
            : NUMBER_OF_LAPS_TILL_NARROWING_NORMAL;
    }

    public setTeamUnitsAlive(teamType: TeamType, unitsAlive: number): void {
        if (teamType) {
            this.teamUnitsAlive.set(teamType, unitsAlive);
        }
    }

    public addRepliedAttack(unitId: string): void {
        this.alreadyRepliedAttack.add(unitId);
    }

    public addAlreadyMadeTurn(teamType: TeamType, unitId: string): void {
        let unitIdsSet = this.alreadyMadeTurnByTeam.get(teamType);
        if (!unitIdsSet) {
            unitIdsSet = new Set();
        }
        unitIdsSet.add(unitId);

        this.alreadyMadeTurn.add(unitId);
        this.alreadyMadeTurnByTeam.set(teamType, unitIdsSet);
        let currentTotalTimePerTeam = this.currentLapTotalTimePerTeam.get(teamType);
        if (currentTotalTimePerTeam === undefined) {
            currentTotalTimePerTeam = 0;
        }
        currentTotalTimePerTeam += Math.floor(getTimeMillis() - this.currentTurnStart);
        this.currentLapTotalTimePerTeam.set(teamType, currentTotalTimePerTeam);
    }

    public enqueueHourGlass(unitId: string) {
        this.alreadyHourGlass.add(unitId);
        this.hourGlassQueue.push(unitId);
    }

    public enqueueMoraleMinus(unitId: string) {
        this.moraleMinusQueue.push(unitId);
    }

    public enqueueMoralePlus(unitId: string) {
        this.moralePlusQueue.push(unitId);
    }

    public enqueueUpNext(unitId: string) {
        this.upNextQueue.push(unitId);
    }

    public getUpNextQueueIterable(): Iterable<string> {
        return {
            [Symbol.iterator]: () => this.upNextQueue.toArray()[Symbol.iterator](),
        };
    }

    public removeFromUpNext(unitId: string): boolean {
        return this.removeItemOnce(this.upNextQueue, unitId);
    }

    public removeFromHourGlassQueue(unitId: string): void {
        this.removeItemOnce(this.hourGlassQueue, unitId);
    }

    public removeFromMoraleMinusQueue(unitId: string): void {
        this.removeItemOnce(this.moraleMinusQueue, unitId);
    }

    public removeFromMoralePlusQueue(unitId: string): void {
        this.removeItemOnce(this.moralePlusQueue, unitId);
    }

    public increaseStepsMoraleMultiplier(): void {
        this.stepsMoraleMultiplier += STEPS_MORALE_MULTIPLIER;
    }

    public updatePreviousTurnTeam(teamType: TeamType): void {
        this.previousTurnTeam = teamType;
    }

    public serialize(): Uint8Array {
        const fight = new Fight();
        fight.setId(uuidToUint8Array(this.id));
        fight.setCurrentLap(this.currentLap);
        fight.setGridType(this.gridType);
        fight.setFirstTurnMade(this.firstTurnMade);
        fight.setFightFinished(this.fightFinished);
        fight.setPreviousTurnTeam(this.previousTurnTeam);
        fight.setHighestSpeedThisTurn(this.highestSpeedThisTurn);
        fight.setAlreadyMadeTurnList(Array.from(this.alreadyMadeTurn));
        const alreadyMadeTurnByUpperTeam = this.alreadyMadeTurnByTeam.get(TeamType.UPPER);
        const alreadyMadeTurnByLowerTeam = this.alreadyMadeTurnByTeam.get(TeamType.LOWER);
        const alreadyMadeTurnByUpperTeamList = new StringList();
        const alreadyMadeTurnByLowerTeamList = new StringList();
        if (alreadyMadeTurnByUpperTeam?.size) {
            alreadyMadeTurnByUpperTeamList.setValuesList(Array.from(alreadyMadeTurnByUpperTeam));
        }
        if (alreadyMadeTurnByLowerTeam?.size) {
            alreadyMadeTurnByLowerTeamList.setValuesList(Array.from(alreadyMadeTurnByLowerTeam));
        }
        const alreadyMadeTurnByTeamMap = fight.getAlreadyMadeTurnByTeamMap();
        alreadyMadeTurnByTeamMap.set(TeamType.UPPER, alreadyMadeTurnByUpperTeamList);
        alreadyMadeTurnByTeamMap.set(TeamType.LOWER, alreadyMadeTurnByLowerTeamList);
        fight.setAlreadyHourGlassList(Array.from(this.alreadyHourGlass));
        fight.setAlreadyRepliedAttackList(Array.from(this.alreadyRepliedAttack));
        const upperTeamUnitsAlive = this.teamUnitsAlive.get(TeamType.UPPER) ?? 0;
        const lowerTeamUnitsAlive = this.teamUnitsAlive.get(TeamType.LOWER) ?? 0;
        const teamUnitsAliveMap = fight.getTeamUnitsAliveMap();
        teamUnitsAliveMap.set(TeamType.UPPER, upperTeamUnitsAlive);
        teamUnitsAliveMap.set(TeamType.LOWER, lowerTeamUnitsAlive);
        fight.setHourGlassQueueList(this.hourGlassQueue.toArray());
        fight.setMoralePlusQueueList(this.moralePlusQueue.toArray());
        fight.setMoraleMinusQueueList(this.moraleMinusQueue.toArray());
        fight.setCurrentTurnStart(Math.round(this.currentTurnStart));
        fight.setCurrentTurnEnd(Math.round(this.currentTurnEnd));
        const currentLapTotalTimePerTeam = fight.getCurrentLapTotalTimePerTeamMap();
        const upperCurrentLapTotalTime = this.currentLapTotalTimePerTeam.get(TeamType.UPPER) ?? 0;
        const lowerCurrentLapTotalTime = this.currentLapTotalTimePerTeam.get(TeamType.LOWER) ?? 0;
        currentLapTotalTimePerTeam.set(TeamType.UPPER, upperCurrentLapTotalTime);
        currentLapTotalTimePerTeam.set(TeamType.LOWER, lowerCurrentLapTotalTime);
        fight.setUpNextList(this.upNextQueue.toArray());
        fight.setStepsMoraleMultiplier(this.stepsMoraleMultiplier);
        const hasAdditionalTimeRequestedPerTeam = fight.getHasAdditionalTimeRequestedPerTeamMap();
        const upperAdditionalTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(TeamType.UPPER) ?? false;
        const lowerAdditionalTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(TeamType.LOWER) ?? false;
        hasAdditionalTimeRequestedPerTeam.set(TeamType.UPPER, upperAdditionalTimeRequested);
        hasAdditionalTimeRequestedPerTeam.set(TeamType.LOWER, lowerAdditionalTimeRequested);

        return fight.serializeBinary();
    }

    private removeItemOnce(deque: Denque<string>, item: string): boolean {
        const index = deque.toArray().indexOf(item); // Find the index of the item
        let removed = false;

        if (index !== -1) {
            // Rebuild the deque without the found item
            const temp = new Denque();
            for (let i = 0; i < deque.length; i++) {
                if (i !== index) {
                    temp.push(deque.get(i));
                }
            }
            deque.clear(); // Clear the original deque
            while (temp.length > 0) {
                deque.push(temp.shift()); // Refill the original deque
            }
            removed = true;
        }

        return removed;
    }
}
