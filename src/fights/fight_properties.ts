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

import { TeamType } from "../units/unit_properties";
import { getRandomInt, getTimeMillis, uuidFromBytes, uuidToUint8Array } from "../utils/lib";
import {
    MAX_AUGMENT_POINTS,
    MAX_TIME_TO_MAKE_TURN_MILLIS,
    MAX_UNITS_PER_TEAM,
    MIN_TIME_TO_MAKE_TURN_MILLIS,
    NUMBER_OF_LAPS_FIRST_ARMAGEDDON,
    NUMBER_OF_LAPS_TILL_NARROWING_BLOCK,
    NUMBER_OF_LAPS_TILL_NARROWING_NORMAL,
    STEPS_MORALE_MULTIPLIER,
    TOTAL_TIME_TO_MAKE_TURN_MILLIS,
} from "../constants";
import { Fight } from "../generated/protobuf/v1/fight_pb";
import { StringList } from "../generated/protobuf/v1/types_pb";
import { GridType } from "../grid/grid_type";
import {
    ArmorAugment,
    AugmentType,
    DefaultPlacementLevel1,
    getPlacementSizes,
    MightAugment,
    MovementAugment,
    PlacementAugment,
    SniperAugment,
} from "../augments/augment_properties";

export class FightProperties {
    private id: string;

    private currentLap: number;

    private gridType: GridType;

    private firstTurnMade: boolean;

    private fightStarted: boolean;

    private fightFinished: boolean;

    private previousTurnTeam: TeamType;

    private highestSpeedThisTurn: number;

    private alreadyMadeTurn: Set<string>;

    private alreadyMadeTurnByTeam: Map<TeamType, Set<string>>;

    private alreadyHourGlass: Set<string>;

    private alreadyRepliedAttack: Set<string>;

    private teamUnitsAlive: Map<TeamType, number>;

    private hourGlassQueue: Denque<string>;

    private moralePlusQueue: Denque<string>;

    private moraleMinusQueue: Denque<string>;

    private currentTurnStart: number;

    private currentTurnEnd: number;

    private currentLapTotalTimePerTeam: Map<TeamType, number>;

    private upNextQueue: Denque<string>;

    private stepsMoraleMultiplier: number;
    private hasAdditionalTimeRequestedPerTeam: Map<TeamType, boolean>;

    private defaultPlacementPerTeam: Map<TeamType, DefaultPlacementLevel1>;

    private augmentPlacementPerTeam: Map<TeamType, PlacementAugment>;

    private augmentArmorPerTeam: Map<TeamType, ArmorAugment>;

    private augmentMightPerTeam: Map<TeamType, MightAugment>;

    private augmentSniperPerTeam: Map<TeamType, SniperAugment>;

    private augmentMovementPerTeam: Map<TeamType, MovementAugment>;

    public constructor() {
        this.id = uuidv4();
        this.currentLap = 1;
        this.gridType = this.getRandomGridType();
        this.firstTurnMade = false;
        this.fightStarted = false;
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
        this.hasAdditionalTimeRequestedPerTeam = new Map();
        this.stepsMoraleMultiplier = 0;
        this.defaultPlacementPerTeam = new Map();
        this.augmentPlacementPerTeam = new Map();
        this.augmentArmorPerTeam = new Map();
        this.augmentMightPerTeam = new Map();
        this.augmentSniperPerTeam = new Map();
        this.augmentMovementPerTeam = new Map();
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

    public getNumberOfUnitsAvailableForPlacement(teamType: TeamType): number {
        return (
            MAX_UNITS_PER_TEAM -
            PlacementAugment.LEVEL_3 +
            (this.augmentPlacementPerTeam.get(teamType) ?? PlacementAugment.LEVEL_1)
        );
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

    public setGridType(gridType: GridType): void {
        if (!this.fightStarted) {
            this.gridType = gridType;
        }
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
                this.hasAdditionalTimeRequestedPerTeam.set(teamType, true);
                this.currentTurnEnd += additionalTime;
            }

            return additionalTime;
        }

        return 0;
    }

    public markFirstTurn(): void {
        this.firstTurnMade = true;
    }

    public startFight(): void {
        this.fightStarted = true;
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
        this.hasAdditionalTimeRequestedPerTeam.clear();
        this.currentLapTotalTimePerTeam.clear();
    }

    public isNarrowingLap(): boolean {
        return (
            this.currentLap > this.getNumberOfLapsTillNarrowing() &&
            this.currentLap % this.getNumberOfLapsTillNarrowing() === 1
        );
    }

    public getArmageddonWave(): number {
        return Math.floor(this.currentLap - NUMBER_OF_LAPS_FIRST_ARMAGEDDON + 1);
    }

    public isTimeToDryCenter(): boolean {
        let isTimeToDryCenter = false;
        if (this.gridType === GridType.LAVA_CENTER || this.gridType === GridType.WATER_CENTER) {
            const numberOfLapsTillNarrowing = this.getNumberOfLapsTillNarrowing();
            const narrowedTimes = Math.floor((this.currentLap - 1) / numberOfLapsTillNarrowing);
            if (narrowedTimes === numberOfLapsTillNarrowing) {
                return true;
            }
        }

        return isTimeToDryCenter;
    }

    public hasFightStarted(): boolean {
        return this.fightStarted;
    }

    public getTeamUnitsAlive(teamType: TeamType): number {
        return this.teamUnitsAlive.get(teamType) ?? 0;
    }

    public getNumberOfLapsTillNarrowing(): number {
        return this.getGridType() === GridType.BLOCK_CENTER
            ? NUMBER_OF_LAPS_TILL_NARROWING_BLOCK
            : NUMBER_OF_LAPS_TILL_NARROWING_NORMAL;
    }

    public getLapsNarrowed(): number {
        return Math.floor((this.currentLap - 1) / this.getNumberOfLapsTillNarrowing());
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

    public setDefaultPlacementPerTeam(teamType: TeamType, placement: DefaultPlacementLevel1): void {
        if (!this.defaultPlacementPerTeam.has(teamType)) {
            this.defaultPlacementPerTeam.set(teamType, placement);
            this.augmentPlacementPerTeam.set(teamType, PlacementAugment.LEVEL_1);
            this.augmentArmorPerTeam.set(teamType, ArmorAugment.NO_AUGMENT);
            this.augmentMightPerTeam.set(teamType, MightAugment.NO_AUGMENT);
            this.augmentSniperPerTeam.set(teamType, SniperAugment.NO_AUGMENT);
            this.augmentMovementPerTeam.set(teamType, MovementAugment.NO_AUGMENT);
        }
    }

    public setAugmentPerTeam(teamType: TeamType, augmentType: AugmentType): boolean {
        if (this.canAugment(teamType, augmentType)) {
            if (augmentType.type === "Placement") {
                this.augmentPlacementPerTeam.set(teamType, augmentType.value);
                return true;
            } else if (augmentType.type === "Armor") {
                this.augmentArmorPerTeam.set(teamType, augmentType.value);
                return true;
            } else if (augmentType.type === "Might") {
                this.augmentMightPerTeam.set(teamType, augmentType.value);
                return true;
            } else if (augmentType.type === "Sniper") {
                this.augmentSniperPerTeam.set(teamType, augmentType.value);
                return true;
            } else if (augmentType.type === "Movement") {
                this.augmentMovementPerTeam.set(teamType, augmentType.value);
                return true;
            }
        }

        return false;
    }

    public getAugmentPlacement(teamType: TeamType): number[] {
        const defaultPlacement = this.defaultPlacementPerTeam.get(teamType);
        if (defaultPlacement === undefined || defaultPlacement === null) {
            throw new Error(`Default placement not found for team ${teamType}`);
        }

        const augmentPlacement = this.augmentPlacementPerTeam.get(teamType);
        if (augmentPlacement === undefined || augmentPlacement === null) {
            throw new Error(`Augment placement not found for team ${teamType}`);
        }

        return getPlacementSizes(augmentPlacement, defaultPlacement);
    }

    public getAugmentArmor(teamType: TeamType): ArmorAugment {
        return this.augmentArmorPerTeam.get(teamType) ?? ArmorAugment.NO_AUGMENT;
    }

    public getAugmentMight(teamType: TeamType): MightAugment {
        return this.augmentMightPerTeam.get(teamType) ?? MightAugment.NO_AUGMENT;
    }

    public getAugmentSniper(teamType: TeamType): SniperAugment {
        return this.augmentSniperPerTeam.get(teamType) ?? SniperAugment.NO_AUGMENT;
    }

    public getAugmentMovement(teamType: TeamType): MovementAugment {
        return this.augmentMovementPerTeam.get(teamType) ?? MovementAugment.NO_AUGMENT;
    }

    public canAugment(teamType: TeamType, augmentType: AugmentType): boolean {
        if (!augmentType || augmentType.value < 0 || !augmentType.type) {
            return false;
        }

        const augmentPoints = Math.floor(augmentType.value);
        let augmentPlacement;
        if (augmentType.type === "Placement") {
            augmentPlacement = PlacementAugment.LEVEL_1;
        } else {
            augmentPlacement = this.augmentPlacementPerTeam.get(teamType) ?? PlacementAugment.LEVEL_1;
        }

        let augmentArmor;
        if (augmentType.type === "Armor") {
            augmentArmor = ArmorAugment.NO_AUGMENT;
        } else {
            augmentArmor = this.augmentArmorPerTeam.get(teamType) ?? ArmorAugment.NO_AUGMENT;
        }

        let augmentMight;
        if (augmentType.type === "Might") {
            augmentMight = MightAugment.NO_AUGMENT;
        } else {
            augmentMight = this.augmentMightPerTeam.get(teamType) ?? MightAugment.NO_AUGMENT;
        }

        let augmentSniper;
        if (augmentType.type === "Sniper") {
            augmentSniper = SniperAugment.NO_AUGMENT;
        } else {
            augmentSniper = this.augmentSniperPerTeam.get(teamType) ?? SniperAugment.NO_AUGMENT;
        }

        let augmentMovement;
        if (augmentType.type === "Movement") {
            augmentMovement = MovementAugment.NO_AUGMENT;
        } else {
            augmentMovement = this.augmentMovementPerTeam.get(teamType) ?? MovementAugment.NO_AUGMENT;
        }

        const currentAugmentPoints = augmentPlacement + augmentArmor + augmentMight + augmentSniper + augmentMovement;
        if (currentAugmentPoints + augmentPoints > MAX_AUGMENT_POINTS) {
            return false;
        }

        return true;
    }

    public static deserialize(bytes: Uint8Array): FightProperties {
        const fight = Fight.deserializeBinary(bytes);
        const fightProperties = new FightProperties();

        fightProperties.id = uuidFromBytes(fight.getId_asU8());
        fightProperties.currentLap = fight.getCurrentLap();
        fightProperties.gridType = fight.getGridType();
        fightProperties.firstTurnMade = fight.getFirstTurnMade();
        fightProperties.fightStarted = fight.getFightStarted();
        fightProperties.fightFinished = fight.getFightFinished();
        fightProperties.previousTurnTeam = fight.getPreviousTurnTeam();
        fightProperties.highestSpeedThisTurn = fight.getHighestSpeedThisTurn();
        fightProperties.alreadyMadeTurn = new Set(fight.getAlreadyMadeTurnList());

        // Deserialize alreadyMadeTurnByTeam
        const alreadyMadeTurnByTeamMap = fight.getAlreadyMadeTurnByTeamMap();
        alreadyMadeTurnByTeamMap.forEach((value: StringList, key: TeamType) => {
            fightProperties.alreadyMadeTurnByTeam.set(key, new Set(value.getValuesList()));
        });

        fightProperties.alreadyHourGlass = new Set(fight.getAlreadyHourGlassList());
        fightProperties.alreadyRepliedAttack = new Set(fight.getAlreadyRepliedAttackList());

        // Deserialize teamUnitsAlive
        const teamUnitsAliveMap = fight.getTeamUnitsAliveMap();
        teamUnitsAliveMap.forEach((value: number, key: TeamType) => {
            fightProperties.teamUnitsAlive.set(key, value);
        });

        fightProperties.hourGlassQueue = new Denque(fight.getHourGlassQueueList());
        fightProperties.moralePlusQueue = new Denque(fight.getMoralePlusQueueList());
        fightProperties.moraleMinusQueue = new Denque(fight.getMoraleMinusQueueList());

        fightProperties.currentTurnStart = fight.getCurrentTurnStart();
        fightProperties.currentTurnEnd = fight.getCurrentTurnEnd();

        // Deserialize currentLapTotalTimePerTeam
        const currentLapTotalTimePerTeamMap = fight.getCurrentLapTotalTimePerTeamMap();
        currentLapTotalTimePerTeamMap.forEach((value: number, key: TeamType) => {
            fightProperties.currentLapTotalTimePerTeam.set(key, value);
        });

        fightProperties.upNextQueue = new Denque(fight.getUpNextList());
        fightProperties.stepsMoraleMultiplier = fight.getStepsMoraleMultiplier();
        // Deserialize hasAdditionalTimeRequestedPerTeam
        const hasAdditionalTimeRequestedPerTeamMap = fight.getHasAdditionalTimeRequestedPerTeamMap();
        hasAdditionalTimeRequestedPerTeamMap.forEach((value: boolean, key: TeamType) => {
            fightProperties.hasAdditionalTimeRequestedPerTeam.set(key, value);
        });

        return fightProperties;
    }

    public serialize(): Uint8Array {
        const fight = new Fight();
        fight.setId(uuidToUint8Array(this.id));
        fight.setCurrentLap(this.currentLap);
        fight.setGridType(this.gridType);
        fight.setFirstTurnMade(this.firstTurnMade);
        fight.setFightStarted(this.fightStarted);
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
        const hasAdditionalTimeRequestedPerTeam = fight.getHasAdditionalTimeRequestedPerTeamMap();
        const upperAdditionalTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(TeamType.UPPER) ?? false;
        const lowerAdditionalTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(TeamType.LOWER) ?? false;
        hasAdditionalTimeRequestedPerTeam.set(TeamType.UPPER, upperAdditionalTimeRequested);
        hasAdditionalTimeRequestedPerTeam.set(TeamType.LOWER, lowerAdditionalTimeRequested);
        fight.setStepsMoraleMultiplier(this.stepsMoraleMultiplier);

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
