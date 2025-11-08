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

import { getRandomInt, getTimeMillis, uuidFromBytes, uuidToUint8Array } from "../utils/lib";
import {
    MAX_AUGMENT_POINTS,
    MAX_HITS_MOUNTAIN,
    MAX_SYNERGY_LEVEL,
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
import { StringList, TeamVals } from "../generated/protobuf/v1/types_pb";
import { TeamType } from "../generated/protobuf/v1/types_gen";
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
import { isPositionWithinGrid } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { Unit } from "../units/unit";
import { PlacementType } from "../grid/placement_properties";
import {
    ChaosSynergy,
    LifeSynergy,
    MightSynergy,
    NatureSynergy,
    SpecificSynergy,
    SynergyKeysToPower,
    SynergyLevel,
    SynergyWithLevel,
    ToChaosSynergy,
    ToLifeSynergy,
    ToMightSynergy,
    ToNatureSynergy,
    UNITS_TO_SYNERGY_LEVEL,
} from "../synergies/synergy_properties";
import { AllFactionsType, FactionType, ToFactionType } from "../factions/faction_type";

export class FightProperties {
    private id: string;
    private currentLap: number;
    private gridType: GridType;
    private placementType: PlacementType;
    private firstTurnMade: boolean;
    private fightStarted: boolean;
    private fightFinished: boolean;
    private previousTurnTeam: TeamType;
    private highestSpeedThisTurn: number;
    private alreadyMadeTurn: Set<string>;
    private alreadyMadeTurnByTeam: Map<TeamType, Set<string>>;
    private alreadyHourglass: Set<string>;
    private alreadyRepliedAttack: Set<string>;
    private teamUnitsAlive: Map<TeamType, number>;
    private hourglassQueue: Denque<string>;
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
    private synergyUnitsLifePerTeam: Map<TeamType, number>;
    private synergyUnitsChaosPerTeam: Map<TeamType, number>;
    private synergyUnitsMightPerTeam: Map<TeamType, number>;
    private synergyUnitsNaturePerTeam: Map<TeamType, number>;
    private damageDealFactPerLap: Map<number, boolean>;
    private synergiesPerTeam: Map<TeamType, string[]>;
    private obstacleHitsLeft: number = 0;
    private additionalNarrowingLaps: number = 0;
    public constructor() {
        this.id = uuidv4();
        this.currentLap = 1;
        this.gridType = this.getRandomGridType();
        this.placementType = PlacementType.RECTANGLE;
        if (this.gridType === GridType.BLOCK_CENTER) {
            this.obstacleHitsLeft = MAX_HITS_MOUNTAIN;
        }
        this.firstTurnMade = false;
        this.fightStarted = false;
        this.fightFinished = false;
        this.previousTurnTeam = TeamVals.NO_TEAM;
        this.highestSpeedThisTurn = 0;
        this.alreadyMadeTurn = new Set();
        this.alreadyMadeTurnByTeam = new Map();
        this.alreadyHourglass = new Set();
        this.alreadyRepliedAttack = new Set();
        this.teamUnitsAlive = new Map();
        this.hourglassQueue = new Denque();
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
        this.synergyUnitsLifePerTeam = new Map();
        this.synergyUnitsChaosPerTeam = new Map();
        this.synergyUnitsMightPerTeam = new Map();
        this.synergyUnitsNaturePerTeam = new Map();
        this.synergiesPerTeam = new Map();
        this.damageDealFactPerLap = new Map();
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
    public getPlacementType(): PlacementType {
        return this.placementType;
    }
    public getFirstTurnMade(): boolean {
        return this.firstTurnMade;
    }
    public hasFightFinished(): boolean {
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
    public hasAlreadyHourglass(unitId: string): boolean {
        return this.alreadyHourglass.has(unitId);
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
    public getHourglassQueueSize(): number {
        return this.hourglassQueue.length;
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
    public getObstacleHitsLeft(): number {
        return this.obstacleHitsLeft;
    }
    public hasDamageDealFactPerLap(lap: number): boolean {
        return this.damageDealFactPerLap.get(lap) ?? false;
    }
    public encounterDamageDealFact(): void {
        this.damageDealFactPerLap.set(this.currentLap, true);
    }
    public encounterObstacleHit(): void {
        if (this.obstacleHitsLeft > 0) {
            this.damageDealFactPerLap.set(this.currentLap, true);
        }

        this.obstacleHitsLeft--;
        if (this.obstacleHitsLeft < 0) {
            this.obstacleHitsLeft = 0;
        }
    }
    public getNumberOfUnitsAvailableForPlacement(teamType: TeamType): number {
        return (
            MAX_UNITS_PER_TEAM +
            this.getAdditionalBoardUnitsPerTeam(teamType) -
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
    public hourglassIncludes(unitId: string): boolean {
        for (let i = 0; i < this.hourglassQueue.length; i++) {
            if (this.hourglassQueue.get(i) === unitId) {
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
            if (this.gridType === GridType.BLOCK_CENTER) {
                this.obstacleHitsLeft = MAX_HITS_MOUNTAIN;
            } else {
                this.obstacleHitsLeft = 0;
            }
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
    public dequeueHourglassQueue(): string | undefined {
        return this.hourglassQueue.shift();
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
            teamType === TeamVals.LOWER
                ? (this.teamUnitsAlive.get(TeamVals.LOWER) ?? 0)
                : (this.teamUnitsAlive.get(TeamVals.UPPER) ?? 0);
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
            teamType === TeamVals.LOWER
                ? (this.teamUnitsAlive.get(TeamVals.LOWER) ?? 0)
                : (this.teamUnitsAlive.get(TeamVals.UPPER) ?? 0);

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
        this.alreadyHourglass.clear();
        this.alreadyRepliedAttack.clear();
        this.currentLap++;
        this.hourglassQueue.clear();
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
            const narrowedTimes =
                Math.floor((this.currentLap - 1) / numberOfLapsTillNarrowing) + this.additionalNarrowingLaps;
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
    public encounterAdditionalNarrowingLap(): void {
        this.additionalNarrowingLaps++;
    }
    public getAdditionalNarrowingLaps(): number {
        return this.additionalNarrowingLaps;
    }
    public getLapsNarrowed(): number {
        return Math.floor((this.currentLap - 1) / this.getNumberOfLapsTillNarrowing()) + this.additionalNarrowingLaps;
    }
    public setTeamUnitsAlive(teamType: TeamType, unitsAlive: number): void {
        if (teamType) {
            this.teamUnitsAlive.set(teamType, unitsAlive);
        }
    }
    public setSynergyUnitsPerFactions(
        teamType: TeamType,
        nLife: number,
        nChaos: number,
        nMight: number,
        nNature: number,
    ): void {
        if (teamType === TeamVals.NO_TEAM) {
            return;
        }

        const numberOfUnitsLife = Math.floor(nLife);
        this.synergyUnitsLifePerTeam.set(teamType, numberOfUnitsLife);
        const synergyLevelLife = Math.min(Math.floor(numberOfUnitsLife / 2), MAX_SYNERGY_LEVEL);
        if (synergyLevelLife) {
            const firstSynergyLevel = this.findSynergyLevel(
                teamType,
                FactionType.LIFE,
                LifeSynergy.PLUS_MORALE_AND_LUCK,
            );
            if (firstSynergyLevel) {
                this.updateSynergyPerTeam(
                    teamType,
                    FactionType.LIFE,
                    LifeSynergy.PLUS_MORALE_AND_LUCK,
                    synergyLevelLife,
                );
            } else {
                const secondSynergyLevel = this.findSynergyLevel(
                    teamType,
                    FactionType.LIFE,
                    LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
                );
                if (secondSynergyLevel) {
                    this.updateSynergyPerTeam(
                        teamType,
                        FactionType.LIFE,
                        LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
                        synergyLevelLife,
                    );
                }
            }
        } else {
            this.updateSynergyPerTeam(
                teamType,
                FactionType.LIFE,
                LifeSynergy.PLUS_MORALE_AND_LUCK,
                SynergyLevel.NO_SYNERGY,
            );
            this.updateSynergyPerTeam(
                teamType,
                FactionType.LIFE,
                LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
                SynergyLevel.NO_SYNERGY,
            );
        }

        const numberOfUnitsChaos = Math.floor(nChaos);
        this.synergyUnitsChaosPerTeam.set(teamType, numberOfUnitsChaos);
        const synergyLevelChaos = Math.min(Math.floor(numberOfUnitsChaos / 2), MAX_SYNERGY_LEVEL);
        if (synergyLevelChaos) {
            const firstSynergyLevel = this.findSynergyLevel(teamType, FactionType.CHAOS, ChaosSynergy.BREAK_ON_ATTACK);
            if (firstSynergyLevel) {
                this.updateSynergyPerTeam(teamType, FactionType.CHAOS, ChaosSynergy.BREAK_ON_ATTACK, synergyLevelChaos);
            } else {
                const secondSynergyLevel = this.findSynergyLevel(teamType, FactionType.CHAOS, ChaosSynergy.MOVEMENT);
                if (secondSynergyLevel) {
                    this.updateSynergyPerTeam(teamType, FactionType.CHAOS, ChaosSynergy.MOVEMENT, synergyLevelChaos);
                }
            }
        } else {
            this.updateSynergyPerTeam(
                teamType,
                FactionType.CHAOS,
                ChaosSynergy.BREAK_ON_ATTACK,
                SynergyLevel.NO_SYNERGY,
            );
            this.updateSynergyPerTeam(teamType, FactionType.CHAOS, ChaosSynergy.MOVEMENT, SynergyLevel.NO_SYNERGY);
        }

        const numberOfUnitsMight = Math.floor(nMight);
        this.synergyUnitsMightPerTeam.set(teamType, numberOfUnitsMight);
        const synergyLevelMight = Math.min(Math.floor(numberOfUnitsMight / 2), MAX_SYNERGY_LEVEL);
        if (synergyLevelMight) {
            const firstSynergyLevel = this.findSynergyLevel(teamType, FactionType.MIGHT, MightSynergy.PLUS_AURAS_RANGE);
            if (firstSynergyLevel) {
                this.updateSynergyPerTeam(
                    teamType,
                    FactionType.MIGHT,
                    MightSynergy.PLUS_AURAS_RANGE,
                    synergyLevelMight,
                );
            } else {
                const secondSynergyLevel = this.findSynergyLevel(
                    teamType,
                    FactionType.MIGHT,
                    MightSynergy.PLUS_STACK_ABILITIES_POWER,
                );
                if (secondSynergyLevel) {
                    this.updateSynergyPerTeam(
                        teamType,
                        FactionType.MIGHT,
                        MightSynergy.PLUS_STACK_ABILITIES_POWER,
                        synergyLevelMight,
                    );
                }
            }
        } else {
            this.updateSynergyPerTeam(
                teamType,
                FactionType.MIGHT,
                MightSynergy.PLUS_AURAS_RANGE,
                SynergyLevel.NO_SYNERGY,
            );
            this.updateSynergyPerTeam(
                teamType,
                FactionType.MIGHT,
                MightSynergy.PLUS_STACK_ABILITIES_POWER,
                SynergyLevel.NO_SYNERGY,
            );
        }

        const numberOfUnitsNature = Math.floor(nNature);
        this.synergyUnitsNaturePerTeam.set(teamType, numberOfUnitsNature);
        const synergyLevelNature = Math.min(Math.floor(numberOfUnitsNature / 2), MAX_SYNERGY_LEVEL);
        if (synergyLevelNature) {
            const firstSynergyLevel = this.findSynergyLevel(
                teamType,
                FactionType.NATURE,
                NatureSynergy.INCREASE_BOARD_UNITS,
            );
            if (firstSynergyLevel) {
                this.updateSynergyPerTeam(
                    teamType,
                    FactionType.NATURE,
                    NatureSynergy.INCREASE_BOARD_UNITS,
                    synergyLevelNature,
                );
            } else {
                const secondSynergyLevel = this.findSynergyLevel(
                    teamType,
                    FactionType.NATURE,
                    NatureSynergy.PLUS_FLY_ARMOR,
                );
                if (secondSynergyLevel) {
                    this.updateSynergyPerTeam(
                        teamType,
                        FactionType.NATURE,
                        NatureSynergy.PLUS_FLY_ARMOR,
                        synergyLevelNature,
                    );
                }
            }
        } else {
            this.updateSynergyPerTeam(
                teamType,
                FactionType.NATURE,
                NatureSynergy.INCREASE_BOARD_UNITS,
                SynergyLevel.NO_SYNERGY,
            );
            this.updateSynergyPerTeam(
                teamType,
                FactionType.NATURE,
                NatureSynergy.PLUS_FLY_ARMOR,
                SynergyLevel.NO_SYNERGY,
            );
        }
    }
    public getAdditionalAuraRangePerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.MIGHT, MightSynergy.PLUS_AURAS_RANGE);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Might:${MightSynergy.PLUS_AURAS_RANGE}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalMovementStepsPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.CHAOS, ChaosSynergy.MOVEMENT);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Chaos:${ChaosSynergy.MOVEMENT}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getBreakChancePerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.CHAOS, ChaosSynergy.BREAK_ON_ATTACK);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Chaos:${ChaosSynergy.BREAK_ON_ATTACK}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalAbilityPowerPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(
            teamType,
            FactionType.MIGHT,
            MightSynergy.PLUS_STACK_ABILITIES_POWER,
        );
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Might:${MightSynergy.PLUS_STACK_ABILITIES_POWER}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalFlyArmorPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.NATURE, NatureSynergy.PLUS_FLY_ARMOR);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Nature:${NatureSynergy.PLUS_FLY_ARMOR}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalMoralePerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.LIFE, LifeSynergy.PLUS_MORALE_AND_LUCK);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Life:${LifeSynergy.PLUS_MORALE_AND_LUCK}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalLuckPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.LIFE, LifeSynergy.PLUS_MORALE_AND_LUCK);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Life:${LifeSynergy.PLUS_MORALE_AND_LUCK}:${synergyLevel}`]?.[1] ?? 0;
    }
    public getAdditionalSupplyPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.LIFE, LifeSynergy.PLUS_SUPPLY_PERCENTAGE);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Life:${LifeSynergy.PLUS_SUPPLY_PERCENTAGE}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getSynergiesPerTeam(teamType: TeamType): string[] {
        return this.synergiesPerTeam.get(teamType) ?? [];
    }
    public updateSynergyPerTeam(
        teamType: TeamType,
        faction: FactionType,
        synergy: SpecificSynergy,
        synergyLevel: number,
    ): boolean {
        const synergyLevelInt = Math.floor(synergyLevel);

        if (synergyLevelInt < 0) {
            return false;
        }

        if (synergyLevelInt > MAX_SYNERGY_LEVEL) {
            return false;
        }

        if (
            faction !== FactionType.LIFE &&
            faction !== FactionType.CHAOS &&
            faction !== FactionType.MIGHT &&
            faction !== FactionType.NATURE
        ) {
            return false;
        }

        let foundSynergy = false;
        if (synergyLevelInt) {
            for (const ps of this.getPossibleSynergies(teamType)) {
                let specificSynergy: SpecificSynergy | undefined = undefined;
                if (faction === FactionType.LIFE) {
                    specificSynergy = ToLifeSynergy[ps.synergy];
                } else if (faction === FactionType.CHAOS) {
                    specificSynergy = ToChaosSynergy[ps.synergy];
                } else if (faction === FactionType.MIGHT) {
                    specificSynergy = ToMightSynergy[ps.synergy];
                } else if (faction === FactionType.NATURE) {
                    specificSynergy = ToNatureSynergy[ps.synergy];
                }
                if (
                    synergy &&
                    specificSynergy &&
                    specificSynergy === synergy &&
                    ps.level &&
                    ps.level === synergyLevelInt &&
                    ps.faction === faction
                ) {
                    foundSynergy = true;
                }
            }
        } else {
            foundSynergy = true;
        }

        if (!foundSynergy) {
            return false;
        }

        const arr = this.synergiesPerTeam.get(teamType) ?? [];

        const newArray = [];

        let prefix: string;
        let synergyStr: string;
        if (synergyLevelInt) {
            prefix = `${faction}:`;
            synergyStr = `${synergy}:`;
        } else {
            prefix = `${faction}:${synergy}:`;
            synergyStr = "";
        }

        for (const a of arr) {
            if (!a.startsWith(prefix)) {
                newArray.push(a);
            }
        }

        if (synergyLevelInt) {
            newArray.push(`${prefix}${synergyStr}${synergyLevelInt}`);
        }

        this.synergiesPerTeam.set(teamType, newArray);

        return true;
    }
    public getPossibleSynergies(teamType: TeamType): SynergyWithLevel[] {
        const synergies: SynergyWithLevel[] = [];
        const sizes = [6, 4, 2, 0]; // Check higher levels first
        // Iterate over synergy units for each faction and determine the highest synergy level
        const synergyTypes: {
            unitsPerTeam: Map<TeamType, number>;
            synergyEnum: { [key: number]: string };
            faction: FactionType;
        }[] = [
            {
                unitsPerTeam: this.synergyUnitsLifePerTeam,
                synergyEnum: LifeSynergy as { [key: number]: string },
                faction: FactionType.LIFE,
            },
            {
                unitsPerTeam: this.synergyUnitsChaosPerTeam,
                synergyEnum: ChaosSynergy as { [key: number]: string },
                faction: FactionType.CHAOS,
            },
            {
                unitsPerTeam: this.synergyUnitsMightPerTeam,
                synergyEnum: MightSynergy as { [key: number]: string },
                faction: FactionType.MIGHT,
            },
            {
                unitsPerTeam: this.synergyUnitsNaturePerTeam,
                synergyEnum: NatureSynergy as { [key: number]: string },
                faction: FactionType.NATURE,
            },
        ];

        synergyTypes.forEach(({ unitsPerTeam, synergyEnum, faction }) => {
            const unitsCount = unitsPerTeam.get(teamType) ?? 0;
            let added = false;
            for (const size of sizes) {
                if (unitsCount >= size && !added) {
                    const synergyLevel = UNITS_TO_SYNERGY_LEVEL[size];
                    // Add highest level synergyEnum type
                    Object.keys(synergyEnum)
                        .map(Number)
                        .filter((index) => index > 0)
                        .forEach((index) => {
                            synergies.push({
                                synergy: synergyEnum[index],
                                level: synergyLevel,
                                faction: faction,
                            });
                            added = true;
                        });
                }
            }
        });

        return synergies;
    }
    public addRepliedAttack(unitId: string): void {
        this.alreadyRepliedAttack.add(unitId);
    }
    public addAlreadyMadeTurn(teamType: TeamType, unitId: string): void {
        if (teamType === TeamVals.NO_TEAM) {
            return;
        }

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
    public enqueueHourglass(unitId: string) {
        this.alreadyHourglass.add(unitId);
        this.hourglassQueue.push(unitId);
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
    public removeFromHourglassQueue(unitId: string): void {
        this.removeItemOnce(this.hourglassQueue, unitId);
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
        if (teamType === TeamVals.NO_TEAM) {
            return;
        }

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
        if (teamType === TeamVals.NO_TEAM) {
            return false;
        }

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
        if (teamType === TeamVals.NO_TEAM) {
            return [];
        }

        const defaultPlacement = this.defaultPlacementPerTeam.get(teamType);
        if (defaultPlacement === undefined || defaultPlacement === null) {
            throw new Error(`Default placement not found for team ${teamType}`);
        }

        const augmentPlacement = this.augmentPlacementPerTeam.get(teamType);
        if (augmentPlacement === undefined || augmentPlacement === null) {
            throw new Error(`Augment placement not found for team ${teamType}`);
        }

        return getPlacementSizes(this.placementType, augmentPlacement, defaultPlacement);
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
        if (teamType === TeamVals.NO_TEAM || !augmentType || augmentType.value < 0 || !augmentType.type) {
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
        alreadyMadeTurnByTeamMap.forEach((value: StringList, key: number) => {
            fightProperties.alreadyMadeTurnByTeam.set(key as TeamType, new Set(value.getValuesList()));
        });

        fightProperties.alreadyHourglass = new Set(fight.getAlreadyHourglassList());
        fightProperties.alreadyRepliedAttack = new Set(fight.getAlreadyRepliedAttackList());

        // Deserialize teamUnitsAlive
        const teamUnitsAliveMap = fight.getTeamUnitsAliveMap();
        teamUnitsAliveMap.forEach((value: number, key: number) => {
            fightProperties.teamUnitsAlive.set(key as TeamType, value);
        });

        fightProperties.hourglassQueue = new Denque(fight.getHourglassQueueList());
        fightProperties.moralePlusQueue = new Denque(fight.getMoralePlusQueueList());
        fightProperties.moraleMinusQueue = new Denque(fight.getMoraleMinusQueueList());

        fightProperties.currentTurnStart = fight.getCurrentTurnStart();
        fightProperties.currentTurnEnd = fight.getCurrentTurnEnd();

        // Deserialize currentLapTotalTimePerTeam
        const currentLapTotalTimePerTeamMap = fight.getCurrentLapTotalTimePerTeamMap();
        currentLapTotalTimePerTeamMap.forEach((value: number, key: number) => {
            fightProperties.currentLapTotalTimePerTeam.set(key as TeamType, value);
        });

        fightProperties.upNextQueue = new Denque(fight.getUpNextList());
        fightProperties.stepsMoraleMultiplier = fight.getStepsMoraleMultiplier();
        // Deserialize hasAdditionalTimeRequestedPerTeam
        const hasAdditionalTimeRequestedPerTeamMap = fight.getHasAdditionalTimeRequestedPerTeamMap();
        hasAdditionalTimeRequestedPerTeamMap.forEach((value: boolean, key: number) => {
            fightProperties.hasAdditionalTimeRequestedPerTeam.set(key as TeamType, value);
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
        const alreadyMadeTurnByUpperTeam = this.alreadyMadeTurnByTeam.get(TeamVals.UPPER);
        const alreadyMadeTurnByLowerTeam = this.alreadyMadeTurnByTeam.get(TeamVals.LOWER);
        const alreadyMadeTurnByUpperTeamList = new StringList();
        const alreadyMadeTurnByLowerTeamList = new StringList();
        if (alreadyMadeTurnByUpperTeam?.size) {
            alreadyMadeTurnByUpperTeamList.setValuesList(Array.from(alreadyMadeTurnByUpperTeam));
        }
        if (alreadyMadeTurnByLowerTeam?.size) {
            alreadyMadeTurnByLowerTeamList.setValuesList(Array.from(alreadyMadeTurnByLowerTeam));
        }
        const alreadyMadeTurnByTeamMap = fight.getAlreadyMadeTurnByTeamMap();
        alreadyMadeTurnByTeamMap.set(TeamVals.UPPER, alreadyMadeTurnByUpperTeamList);
        alreadyMadeTurnByTeamMap.set(TeamVals.LOWER, alreadyMadeTurnByLowerTeamList);
        fight.setAlreadyHourglassList(Array.from(this.alreadyHourglass));
        fight.setAlreadyRepliedAttackList(Array.from(this.alreadyRepliedAttack));
        const upperTeamUnitsAlive = this.teamUnitsAlive.get(TeamVals.UPPER) ?? 0;
        const lowerTeamUnitsAlive = this.teamUnitsAlive.get(TeamVals.LOWER) ?? 0;
        const teamUnitsAliveMap = fight.getTeamUnitsAliveMap();
        teamUnitsAliveMap.set(TeamVals.UPPER, upperTeamUnitsAlive);
        teamUnitsAliveMap.set(TeamVals.LOWER, lowerTeamUnitsAlive);
        fight.setHourglassQueueList(this.hourglassQueue.toArray());
        fight.setMoralePlusQueueList(this.moralePlusQueue.toArray());
        fight.setMoraleMinusQueueList(this.moraleMinusQueue.toArray());
        fight.setCurrentTurnStart(Math.round(this.currentTurnStart));
        fight.setCurrentTurnEnd(Math.round(this.currentTurnEnd));
        const currentLapTotalTimePerTeam = fight.getCurrentLapTotalTimePerTeamMap();
        const upperCurrentLapTotalTime = this.currentLapTotalTimePerTeam.get(TeamVals.UPPER) ?? 0;
        const lowerCurrentLapTotalTime = this.currentLapTotalTimePerTeam.get(TeamVals.LOWER) ?? 0;
        currentLapTotalTimePerTeam.set(TeamVals.UPPER, upperCurrentLapTotalTime);
        currentLapTotalTimePerTeam.set(TeamVals.LOWER, lowerCurrentLapTotalTime);
        fight.setUpNextList(this.upNextQueue.toArray());
        const hasAdditionalTimeRequestedPerTeam = fight.getHasAdditionalTimeRequestedPerTeamMap();
        const upperAdditionalTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(TeamVals.UPPER) ?? false;
        const lowerAdditionalTimeRequested = this.hasAdditionalTimeRequestedPerTeam.get(TeamVals.LOWER) ?? false;
        hasAdditionalTimeRequestedPerTeam.set(TeamVals.UPPER, upperAdditionalTimeRequested);
        hasAdditionalTimeRequestedPerTeam.set(TeamVals.LOWER, lowerAdditionalTimeRequested);
        fight.setStepsMoraleMultiplier(this.stepsMoraleMultiplier);

        return fight.serializeBinary();
    }
    public prefetchNextUnitsToTurn(allUnits: ReadonlyMap<string, Unit>, unitsUpper: Unit[], unitsLower: Unit[]): void {
        const upNextUnitsCount = unitsUpper.length + unitsLower.length;

        if (this.upNextQueue.length >= upNextUnitsCount) {
            return;
        }

        while (this.upNextQueue.length < upNextUnitsCount) {
            const nextUnitId = this.getNextTurnUnitId(allUnits, unitsUpper, unitsLower);

            if (nextUnitId) {
                const unit = allUnits.get(nextUnitId);
                if (
                    unit &&
                    !unit.isDead() &&
                    !this.upNextIncludes(nextUnitId) &&
                    !this.alreadyMadeTurn.has(nextUnitId)
                ) {
                    this.upNextQueue.push(nextUnitId);
                    this.updatePreviousTurnTeam(unit.getTeam());
                }
            } else {
                break;
            }
        }
    }
    public setUnitsCalculatedStacksPower(gridSettings: GridSettings, allUnits: Map<string, Unit>): void {
        let maxTotalExp = Number.MIN_SAFE_INTEGER;
        for (const u of allUnits.values()) {
            if (!isPositionWithinGrid(gridSettings, u.getPosition())) {
                continue;
            }
            const totalExp = u.getExp() * u.getAmountAlive();
            maxTotalExp = maxTotalExp < totalExp ? totalExp : maxTotalExp;
        }
        for (const u of allUnits.values()) {
            if (!isPositionWithinGrid(gridSettings, u.getPosition())) {
                continue;
            }
            const percentage = ((u.getExp() * u.getAmountAlive()) / maxTotalExp) * 100;
            if (percentage <= 20) {
                u.setStackPower(1);
            } else if (percentage <= 40) {
                u.setStackPower(2);
            } else if (percentage <= 60) {
                u.setStackPower(3);
            } else if (percentage <= 80) {
                u.setStackPower(4);
            } else {
                u.setStackPower(5);
            }
        }
    }
    private findSynergyLevel(teamType: TeamType, faction: FactionType, specificSynergy: SpecificSynergy): number {
        let synergyLevel = 0;
        const synergies = this.synergiesPerTeam.get(teamType);

        if (!synergies?.length) {
            return synergyLevel;
        }

        for (const synergy of synergies) {
            const synergySplitArr = synergy.split(":");
            if (synergySplitArr.length !== 3) {
                continue;
            }

            const factionPart = ToFactionType[synergySplitArr[0] as AllFactionsType];
            if (factionPart !== faction) {
                continue;
            }

            const specificSynergyPart = parseInt(synergySplitArr[1]) as SpecificSynergy;
            if (specificSynergy === specificSynergyPart) {
                const synergyLevelPart = parseInt(synergySplitArr[2]);
                if (synergyLevelPart && synergyLevelPart <= MAX_SYNERGY_LEVEL) {
                    return synergyLevelPart;
                }
            }
        }

        return synergyLevel;
    }
    private getAdditionalBoardUnitsPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, FactionType.NATURE, NatureSynergy.INCREASE_BOARD_UNITS);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Nature:${NatureSynergy.INCREASE_BOARD_UNITS}:${synergyLevel}`]?.[0] ?? 0;
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
    private getNextTurnUnitId(
        allUnits: ReadonlyMap<string, Unit>,
        unitsUpper: Unit[],
        unitsLower: Unit[],
    ): string | undefined {
        if (!unitsLower.length || !unitsUpper.length) {
            return undefined;
        }

        // plus morale
        while (this.moralePlusQueue.length) {
            const nextUnitId = this.moralePlusQueue.shift();
            if (nextUnitId && !this.alreadyMadeTurn.has(nextUnitId) && !this.upNextIncludes(nextUnitId)) {
                return nextUnitId;
            }
        }

        let totalArmyMoraleUpper = 0;
        let totalArmyMoraleLower = 0;
        let firstBatch: Unit[];
        let secondBatch: Unit[];

        // total morale based
        if (this.previousTurnTeam == TeamVals.NO_TEAM) {
            for (const u of unitsUpper) {
                this.setHighestSpeedThisTurn(Math.max(this.highestSpeedThisTurn, u.getSpeed()));
                totalArmyMoraleUpper += u.getMorale();
            }
            for (const u of unitsLower) {
                this.setHighestSpeedThisTurn(Math.max(this.highestSpeedThisTurn, u.getSpeed()));
                totalArmyMoraleLower += u.getMorale();
            }

            const avgArmyMoraleUpper = unitsUpper.length ? totalArmyMoraleUpper / unitsUpper.length : 0;
            const avgArmyMoraleLower = unitsLower.length ? totalArmyMoraleLower / unitsUpper.length : 0;

            if (avgArmyMoraleUpper > avgArmyMoraleLower) {
                firstBatch = unitsUpper;
                secondBatch = unitsLower;
            } else if (avgArmyMoraleUpper < avgArmyMoraleLower) {
                firstBatch = unitsLower;
                secondBatch = unitsUpper;
            } else {
                let lowerMaxSpeed = Number.MIN_SAFE_INTEGER;
                for (const u of unitsLower) {
                    lowerMaxSpeed = u.getSpeed() > lowerMaxSpeed ? u.getSpeed() : lowerMaxSpeed;
                }
                let upperMaxSpeed = Number.MIN_SAFE_INTEGER;
                for (const u of unitsUpper) {
                    upperMaxSpeed = u.getSpeed() > upperMaxSpeed ? u.getSpeed() : upperMaxSpeed;
                }

                if (lowerMaxSpeed > upperMaxSpeed) {
                    firstBatch = unitsLower;
                    secondBatch = unitsUpper;
                } else if (lowerMaxSpeed < upperMaxSpeed) {
                    firstBatch = unitsUpper;
                    secondBatch = unitsLower;
                } else {
                    const rnd = getRandomInt(0, 2);
                    if (rnd) {
                        firstBatch = unitsUpper;
                        secondBatch = unitsLower;
                    } else {
                        firstBatch = unitsLower;
                        secondBatch = unitsUpper;
                    }
                }
            }
        } else if (this.previousTurnTeam === TeamVals.LOWER) {
            firstBatch = unitsUpper;
            secondBatch = unitsLower;
        } else {
            firstBatch = unitsLower;
            secondBatch = unitsUpper;
        }

        for (const u of firstBatch) {
            const unitId = u.getId();
            if (
                !this.alreadyMadeTurn.has(unitId) &&
                !this.upNextIncludes(unitId) &&
                !this.hourglassIncludes(unitId) &&
                !this.moraleMinusIncludes(unitId)
            ) {
                return unitId;
            }
        }
        for (const u of secondBatch) {
            const unitId = u.getId();
            if (
                !this.alreadyMadeTurn.has(unitId) &&
                !this.upNextIncludes(unitId) &&
                !this.hourglassIncludes(unitId) &&
                !this.moraleMinusIncludes(unitId)
            ) {
                return unitId;
            }
        }

        // minus morale
        while (this.moraleMinusQueue.length) {
            const nextUnitId = this.moraleMinusQueue.shift();
            if (nextUnitId && !this.alreadyMadeTurn.has(nextUnitId) && !this.upNextIncludes(nextUnitId)) {
                return nextUnitId;
            }
        }

        // hourglass
        if (
            this.hourglassQueue.length &&
            this.alreadyMadeTurn.size + this.hourglassQueue.length + this.upNextQueue.length >= allUnits.size
        ) {
            while (this.hourglassQueue.length) {
                const nextUnitId = this.hourglassQueue.shift();
                if (nextUnitId && !this.alreadyMadeTurn.has(nextUnitId) && !this.upNextIncludes(nextUnitId)) {
                    return nextUnitId;
                }
            }
        }

        return undefined;
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
            // return GridType.WATER_CENTER;
            return GridType.LAVA_CENTER;
        }

        return GridType.LAVA_CENTER;
    }
}
