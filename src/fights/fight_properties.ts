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

import Denque from "denque";

import { createSecureUuid, getRandomInt, getTimeMillis, uuidFromBytes, uuidToUint8Array } from "../utils/lib";
import {
    HITS_PER_MOUNTAIN,
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
import { PBTypes as PBFight } from "../generated/protobuf/v1/fight";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType, GridType, FactionType } from "../generated/protobuf/v1/types_gen";
import {
    ArmorAugment,
    type AugmentType,
    DefaultPlacementLevel1,
    EmpowerAugment,
    getPlacementSizes,
    MightAugment,
    MovementAugment,
    PlacementAugment,
    SniperAugment,
} from "../augments/augment_properties";
import {
    ArtifactTier,
    BROKEN_AEGIS_BREAK_CHANCE,
    Tier1Artifact,
    Tier2Artifact,
} from "../artifacts/artifact_properties";
import { getUpgradePoints, Doctrine } from "../doctrines/doctrine_properties";
import { Perk } from "../perks/perk_properties";
import { isPositionWithinGrid } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { Unit } from "../units/unit";
import { PlacementType } from "../grid/placement_properties";
import {
    ChaosSynergy,
    LifeSynergy,
    MightSynergy,
    NatureSynergy,
    type SpecificSynergy,
    DEFAULT_SYNERGY_VARIANTS,
    SynergyKeysToPower,
    SynergyLevel,
    type SynergyWithLevel,
    ToChaosSynergy,
    ToLifeSynergy,
    ToMightSynergy,
    ToNatureSynergy,
    UNITS_TO_SYNERGY_LEVEL,
} from "../synergies/synergy_properties";
import { ToFactionName, ToFactionType } from "../factions/faction_type";
import { SmokeClouds } from "../spells/smoke_clouds";
import { Vines } from "../spells/vines";
import { FireWalls } from "../spells/fire_walls";

type RandomIntFn = (min: number, max: number) => number;

interface IParsedSynergyKey {
    faction: FactionType;
    specificSynergy: SpecificSynergy;
    level: number;
}

// Production synergy keys come from this immutable configuration table. Parse those 24 keys once at module
// load instead of splitting the same four per-team strings throughout every battle stat refresh. Raw legacy or
// authoritative keys that are not in the table retain the permissive historical parseInt behavior below.
const PARSED_CANONICAL_SYNERGY_KEYS: ReadonlyMap<string, IParsedSynergyKey> = new Map(
    Object.keys(SynergyKeysToPower).map((key) => {
        const [factionName, specificSynergy, level] = key.split(":");
        return [
            key,
            {
                faction: ToFactionType[factionName],
                specificSynergy: parseInt(specificSynergy) as SpecificSynergy,
                level: parseInt(level),
            },
        ];
    }),
);

const parseLegacySynergyKey = (synergy: string): IParsedSynergyKey | undefined => {
    const factionSeparator = synergy.indexOf(":");
    if (factionSeparator < 0) {
        return undefined;
    }
    const levelSeparator = synergy.indexOf(":", factionSeparator + 1);
    // This is the allocation-free equivalent of the historical `split(":").length === 3` shape guard.
    if (levelSeparator < 0 || synergy.indexOf(":", levelSeparator + 1) >= 0) {
        return undefined;
    }
    return {
        faction: ToFactionType[synergy.slice(0, factionSeparator) as keyof typeof ToFactionType],
        specificSynergy: parseInt(synergy.slice(factionSeparator + 1, levelSeparator)) as SpecificSynergy,
        level: parseInt(synergy.slice(levelSeparator + 1)),
    };
};

export class FightProperties {
    private id: string;
    private currentLap: number;
    private gridType: GridType;
    private placementType: PlacementType;
    private firstTurnMade: boolean;
    private fightStarted: boolean;
    private fightFinished: boolean;
    private previousTurnTeam: TeamType;
    private highestInitiativeThisTurn: number;
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
    private augmentEmpowerPerTeam: Map<TeamType, EmpowerAugment>;
    private augmentSniperPerTeam: Map<TeamType, SniperAugment>;
    private augmentMovementPerTeam: Map<TeamType, MovementAugment>;
    private artifactTier1PerTeam: Map<TeamType, Tier1Artifact>;
    private artifactTier2PerTeam: Map<TeamType, Tier2Artifact>;
    private doctrinePerTeam: Map<TeamType, Doctrine>;
    // Which synergy of each faction's pair this match fields. Drawn once from the game id so the draft can
    // show them before the first pick; sandbox and tests keep the default set.
    private synergyVariants: { [factionName: string]: SpecificSynergy } = { ...DEFAULT_SYNERGY_VARIANTS };
    private synergyUnitsLifePerTeam: Map<TeamType, number>;
    private synergyUnitsChaosPerTeam: Map<TeamType, number>;
    private synergyUnitsMightPerTeam: Map<TeamType, number>;
    private synergyUnitsNaturePerTeam: Map<TeamType, number>;
    private damageDealFactPerLap: Map<number, boolean>;
    private synergiesPerTeam: Map<TeamType, string[]>;
    // Two independent 2x2 mountains (BLOCK_CENTER): left cols and right cols each have their own hit points.
    private obstacleHitsLeftLeft: number = 0;
    private obstacleHitsLeftRight: number = 0;
    private additionalNarrowingLaps: number = 0;
    // Transient cell-resident smoke clouds (Smoke spell). Carried on the fight so it snapshots with the rest
    // of the state and the ranked server can replay from a snapshot across restarts.
    private smokeClouds: SmokeClouds = new SmokeClouds();
    // Transient cell-resident vines (Vine Throw). Same lifecycle as the smoke store above; unlike smoke, a
    // vine is not dispelled by a creature standing on it.
    private vines: Vines = new Vines();
    // Transient cell-resident fire walls (Fire Wall spell). Same lifecycle as the two stores above; like a
    // vine and unlike smoke, fire is not put out by a creature standing on it.
    private fireWalls: FireWalls = new FireWalls();
    public constructor() {
        this.id = createSecureUuid();
        this.currentLap = 1;
        this.gridType = this.getRandomGridType();
        this.placementType = PlacementType.RECTANGLE;
        if (this.gridType === PBTypes.GridVals.BLOCK_CENTER) {
            this.obstacleHitsLeftLeft = HITS_PER_MOUNTAIN;
            this.obstacleHitsLeftRight = HITS_PER_MOUNTAIN;
        }
        this.firstTurnMade = false;
        this.fightStarted = false;
        this.fightFinished = false;
        this.previousTurnTeam = PBTypes.TeamVals.NO_TEAM;
        this.highestInitiativeThisTurn = 0;
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
        this.augmentEmpowerPerTeam = new Map();
        this.augmentSniperPerTeam = new Map();
        this.augmentMovementPerTeam = new Map();
        this.artifactTier1PerTeam = new Map();
        this.artifactTier2PerTeam = new Map();
        this.doctrinePerTeam = new Map();
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
    public getSmokeClouds(): SmokeClouds {
        return this.smokeClouds;
    }
    // Replace the smoke store wholesale — used when restoring a fight from a snapshot (ranked server replay).
    public setSmokeClouds(clouds: SmokeClouds): void {
        this.smokeClouds = clouds;
    }
    public getVines(): Vines {
        return this.vines;
    }
    // Replace the vine store wholesale — used when restoring a fight from a snapshot (ranked server replay).
    public setVines(vines: Vines): void {
        this.vines = vines;
    }
    public getFireWalls(): FireWalls {
        return this.fireWalls;
    }
    // Replace the fire store wholesale — used when restoring a fight from a snapshot (ranked server replay).
    public setFireWalls(fireWalls: FireWalls): void {
        this.fireWalls = fireWalls;
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
    public getHighestInitiativeThisTurn(): number {
        return this.highestInitiativeThisTurn;
    }
    public hasAlreadyMadeTurn(unitId: string): boolean {
        return this.alreadyMadeTurn.has(unitId);
    }
    /**
     * Whether another living unit on `teamType` still has its real turn pending in this lap.
     * Hourglassed units count because waiting does not mark their turn complete.
     */
    public hasUnactedTeammate(teamType: TeamType, currentUnitId: string, allUnits: ReadonlyMap<string, Unit>): boolean {
        if ((this.teamUnitsAlive.get(teamType) ?? 0) <= 1) {
            return false;
        }
        for (const [unitId, unit] of allUnits) {
            if (
                unitId !== currentUnitId &&
                !unit.isDead() &&
                unit.getTeam() === teamType &&
                !this.alreadyMadeTurn.has(unitId)
            ) {
                return true;
            }
        }
        return false;
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
    public getCurrentLapTotalTime(teamType: TeamType): number {
        return this.currentLapTotalTimePerTeam.get(teamType) ?? 0;
    }
    // Total remaining mountain hit points across BOTH 2x2 mountains (0..2*HITS_PER_MOUNTAIN). Kept as the sum
    // so existing "is any mountain still standing" guards, the AI, and the snapshot keep working unchanged.
    public getObstacleHitsLeft(): number {
        return this.obstacleHitsLeftLeft + this.obstacleHitsLeftRight;
    }
    public getObstacleHitsLeftLeft(): number {
        return this.obstacleHitsLeftLeft;
    }
    public getObstacleHitsLeftRight(): number {
        return this.obstacleHitsLeftRight;
    }
    /**
     * Authoritatively set the remaining mountain hit points from a serialized TOTAL. Used by the client
     * replay to reflect the recorded `obstacle_attacked` event's `hitsAfter` without re-running the attack.
     * The wire only carries the total, so split it left-first across the two mountains (an approximation
     * that's exact at full/empty; ranked would need a per-mountain field to be pixel-perfect mid-mine).
     */
    public setObstacleHitsLeft(hits: number): void {
        const total = Math.max(0, Math.min(2 * HITS_PER_MOUNTAIN, Math.floor(hits)));
        this.obstacleHitsLeftLeft = Math.min(HITS_PER_MOUNTAIN, total);
        this.obstacleHitsLeftRight = total - this.obstacleHitsLeftLeft;
    }
    /**
     * Authoritatively set the remaining hit points of EACH mountain independently. Preferred over
     * setObstacleHitsLeft when the source knows both sides (the obstacle_attacked event carries them), so
     * the mountain that was actually struck loses HP instead of the total being re-split left-first.
     */
    public setObstacleHitsPerMountain(left: number, right: number): void {
        this.obstacleHitsLeftLeft = Math.max(0, Math.min(HITS_PER_MOUNTAIN, Math.floor(left)));
        this.obstacleHitsLeftRight = Math.max(0, Math.min(HITS_PER_MOUNTAIN, Math.floor(right)));
    }
    public hasDamageDealFactPerLap(lap: number): boolean {
        return this.damageDealFactPerLap.get(lap) ?? false;
    }
    public encounterDamageDealFact(): void {
        this.damageDealFactPerLap.set(this.currentLap, true);
    }
    public encounterObstacleHit(isRightMountain: boolean): void {
        if (isRightMountain) {
            if (this.obstacleHitsLeftRight > 0) {
                this.damageDealFactPerLap.set(this.currentLap, true);
            }
            this.obstacleHitsLeftRight = Math.max(0, this.obstacleHitsLeftRight - 1);
        } else {
            if (this.obstacleHitsLeftLeft > 0) {
                this.damageDealFactPerLap.set(this.currentLap, true);
            }
            this.obstacleHitsLeftLeft = Math.max(0, this.obstacleHitsLeftLeft - 1);
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
    /** Restore the server-authoritative no-progress movement multiplier from a ranked snapshot. */
    public restoreStepsMoraleMultiplier(value: number): void {
        if (!Number.isFinite(value) || value < 0) {
            throw new RangeError("Steps morale multiplier must be a finite non-negative number");
        }

        this.stepsMoraleMultiplier = value;
    }
    public getHasAdditionalTimeRequestedPerTeam(): Map<TeamType, boolean> {
        return this.hasAdditionalTimeRequestedPerTeam;
    }
    public setGridType(gridType: GridType): void {
        if (!this.fightStarted) {
            this.gridType = gridType;
            if (this.gridType === PBTypes.GridVals.BLOCK_CENTER) {
                this.obstacleHitsLeftLeft = HITS_PER_MOUNTAIN;
                this.obstacleHitsLeftRight = HITS_PER_MOUNTAIN;
            } else {
                this.obstacleHitsLeftLeft = 0;
                this.obstacleHitsLeftRight = 0;
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
    public setHighestInitiativeThisTurn(highestInitiativeThisTurn: number): void {
        this.highestInitiativeThisTurn = highestInitiativeThisTurn;
    }
    public startTurn(teamType: TeamType, nowMillis: number = getTimeMillis()): void {
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
            teamType === PBTypes.TeamVals.LOWER
                ? (this.teamUnitsAlive.get(PBTypes.TeamVals.LOWER) ?? 0)
                : (this.teamUnitsAlive.get(PBTypes.TeamVals.UPPER) ?? 0);
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

        this.currentTurnStart = nowMillis;
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
            teamType === PBTypes.TeamVals.LOWER
                ? (this.teamUnitsAlive.get(PBTypes.TeamVals.LOWER) ?? 0)
                : (this.teamUnitsAlive.get(PBTypes.TeamVals.UPPER) ?? 0);

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
        if (this.gridType === PBTypes.GridVals.LAVA_CENTER || this.gridType === PBTypes.GridVals.WATER_CENTER) {
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
        return this.getGridType() === PBTypes.GridVals.BLOCK_CENTER
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
    /**
     * Synergies are automatic: every faction has exactly ONE synergy and it switches itself on purely from
     * how many units of that faction the army fields (2/4/6 units -> level 1/2/3). There is nothing to pick
     * any more, so this both records the per-faction counts and writes the four fixed synergies.
     *
     * Life -> supply (army size), Chaos -> movement, Might -> aura range, Nature -> flying armor. The other
     * variant of each pair stays permanently cleared so no stale choice from an older session survives.
     */
    public setSynergyVariants(variants: { [factionName: string]: SpecificSynergy }): void {
        this.synergyVariants = { ...DEFAULT_SYNERGY_VARIANTS, ...variants };
    }
    public getSynergyVariants(): { [factionName: string]: SpecificSynergy } {
        return { ...this.synergyVariants };
    }
    public setSynergyUnitsPerFactions(
        teamType: TeamType,
        nLife: number,
        nChaos: number,
        nMight: number,
        nNature: number,
    ): void {
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
            return;
        }

        const levelOf = (numberOfUnits: number): SynergyLevel =>
            Math.min(Math.floor(numberOfUnits / 2), MAX_SYNERGY_LEVEL) as SynergyLevel;

        const numberOfUnitsLife = Math.floor(nLife);
        this.synergyUnitsLifePerTeam.set(teamType, numberOfUnitsLife);
        const chosenLife = this.synergyVariants.Life;
        for (const variant of [
            LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
            LifeSynergy.PLUS_MORALE_AND_LUCK,
        ] as SpecificSynergy[]) {
            this.updateSynergyPerTeam(
                teamType,
                PBTypes.FactionVals.LIFE,
                variant,
                variant === chosenLife ? levelOf(numberOfUnitsLife) : SynergyLevel.NO_SYNERGY,
            );
        }

        const numberOfUnitsChaos = Math.floor(nChaos);
        this.synergyUnitsChaosPerTeam.set(teamType, numberOfUnitsChaos);
        const chosenChaos = this.synergyVariants.Chaos;
        for (const variant of [ChaosSynergy.MOVEMENT, ChaosSynergy.BREAK_ON_ATTACK] as SpecificSynergy[]) {
            this.updateSynergyPerTeam(
                teamType,
                PBTypes.FactionVals.CHAOS,
                variant,
                variant === chosenChaos ? levelOf(numberOfUnitsChaos) : SynergyLevel.NO_SYNERGY,
            );
        }

        const numberOfUnitsMight = Math.floor(nMight);
        this.synergyUnitsMightPerTeam.set(teamType, numberOfUnitsMight);
        const chosenMight = this.synergyVariants.Might;
        for (const variant of [
            MightSynergy.PLUS_AURAS_RANGE,
            MightSynergy.PLUS_STACK_ABILITIES_POWER,
        ] as SpecificSynergy[]) {
            this.updateSynergyPerTeam(
                teamType,
                PBTypes.FactionVals.MIGHT,
                variant,
                variant === chosenMight ? levelOf(numberOfUnitsMight) : SynergyLevel.NO_SYNERGY,
            );
        }

        const numberOfUnitsNature = Math.floor(nNature);
        this.synergyUnitsNaturePerTeam.set(teamType, numberOfUnitsNature);
        const chosenNature = this.synergyVariants.Nature;
        for (const variant of [NatureSynergy.PLUS_FLY_ARMOR, NatureSynergy.INCREASE_BOARD_UNITS] as SpecificSynergy[]) {
            this.updateSynergyPerTeam(
                teamType,
                PBTypes.FactionVals.NATURE,
                variant,
                variant === chosenNature ? levelOf(numberOfUnitsNature) : SynergyLevel.NO_SYNERGY,
            );
        }
    }
    public getAdditionalAuraRangePerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, PBTypes.FactionVals.MIGHT, MightSynergy.PLUS_AURAS_RANGE);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Might:${MightSynergy.PLUS_AURAS_RANGE}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalMovementStepsPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, PBTypes.FactionVals.CHAOS, ChaosSynergy.MOVEMENT);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Chaos:${ChaosSynergy.MOVEMENT}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getBreakChancePerTeam(teamType: TeamType): number {
        let chance = 0;

        // ARTIFACT Broken Aegis (offensive): the wielder's attacks have a chance to Break the ENEMY they
        // hit. This is the attacker's team chance; the attack handlers pass it as chanceToBreak into the
        // target's applyDamage, so it mutes the enemy, never the wielder.
        if (this.hasArtifactTier1(teamType, Tier1Artifact.BROKEN_AEGIS)) {
            chance += BROKEN_AEGIS_BREAK_CHANCE;
        }

        // Chaos BREAK_ON_ATTACK synergy (also offensive, stacks with the artifact).
        const synergyLevel = this.findSynergyLevel(teamType, PBTypes.FactionVals.CHAOS, ChaosSynergy.BREAK_ON_ATTACK);
        if (synergyLevel) {
            chance += SynergyKeysToPower[`Chaos:${ChaosSynergy.BREAK_ON_ATTACK}:${synergyLevel}`]?.[0] ?? 0;
        }

        return Math.min(100, chance);
    }
    public getAdditionalAbilityPowerPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(
            teamType,
            PBTypes.FactionVals.MIGHT,
            MightSynergy.PLUS_STACK_ABILITIES_POWER,
        );
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Might:${MightSynergy.PLUS_STACK_ABILITIES_POWER}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalFlyArmorPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(teamType, PBTypes.FactionVals.NATURE, NatureSynergy.PLUS_FLY_ARMOR);
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Nature:${NatureSynergy.PLUS_FLY_ARMOR}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalMoralePerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(
            teamType,
            PBTypes.FactionVals.LIFE,
            LifeSynergy.PLUS_MORALE_AND_LUCK,
        );
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Life:${LifeSynergy.PLUS_MORALE_AND_LUCK}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getAdditionalLuckPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(
            teamType,
            PBTypes.FactionVals.LIFE,
            LifeSynergy.PLUS_MORALE_AND_LUCK,
        );
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Life:${LifeSynergy.PLUS_MORALE_AND_LUCK}:${synergyLevel}`]?.[1] ?? 0;
    }
    public getAdditionalSupplyPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(
            teamType,
            PBTypes.FactionVals.LIFE,
            LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
        );
        if (!synergyLevel) {
            return 0;
        }

        return SynergyKeysToPower[`Life:${LifeSynergy.PLUS_SUPPLY_PERCENTAGE}:${synergyLevel}`]?.[0] ?? 0;
    }
    public getSynergiesPerTeam(teamType: TeamType): string[] {
        return this.synergiesPerTeam.get(teamType) ?? [];
    }
    // Restore a team's active synergy list wholesale (raw "Faction:synergyId:level" keys, as findSynergyLevel
    // reads them). Used by the client to carry synergies across a FightStateManager.reset() on snapshot
    // hydrate — the authoritative snapshot doesn't re-seed them, so without this the aura-range / movement /
    // ability-power synergies silently drop at fight start in ranked.
    public setSynergiesPerTeam(teamType: TeamType, synergies: string[]): void {
        this.synergiesPerTeam.set(teamType, [...synergies]);
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
            faction !== PBTypes.FactionVals.LIFE &&
            faction !== PBTypes.FactionVals.CHAOS &&
            faction !== PBTypes.FactionVals.MIGHT &&
            faction !== PBTypes.FactionVals.NATURE
        ) {
            return false;
        }

        let foundSynergy = false;
        if (synergyLevelInt) {
            for (const ps of this.getPossibleSynergies(teamType)) {
                let specificSynergy: SpecificSynergy | undefined = undefined;
                if (faction === PBTypes.FactionVals.LIFE) {
                    specificSynergy = ToLifeSynergy[ps.synergy];
                } else if (faction === PBTypes.FactionVals.CHAOS) {
                    specificSynergy = ToChaosSynergy[ps.synergy];
                } else if (faction === PBTypes.FactionVals.MIGHT) {
                    specificSynergy = ToMightSynergy[ps.synergy];
                } else if (faction === PBTypes.FactionVals.NATURE) {
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
            prefix = `${ToFactionName[faction]}:`;
            synergyStr = `${synergy}:`;
        } else {
            prefix = `${ToFactionName[faction]}:${synergy}:`;
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
                faction: PBTypes.FactionVals.LIFE,
            },
            {
                unitsPerTeam: this.synergyUnitsChaosPerTeam,
                synergyEnum: ChaosSynergy as { [key: number]: string },
                faction: PBTypes.FactionVals.CHAOS,
            },
            {
                unitsPerTeam: this.synergyUnitsMightPerTeam,
                synergyEnum: MightSynergy as { [key: number]: string },
                faction: PBTypes.FactionVals.MIGHT,
            },
            {
                unitsPerTeam: this.synergyUnitsNaturePerTeam,
                synergyEnum: NatureSynergy as { [key: number]: string },
                faction: PBTypes.FactionVals.NATURE,
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
    public addAlreadyMadeTurn(teamType: TeamType, unitId: string, nowMillis: number = getTimeMillis()): void {
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
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
        currentTotalTimePerTeam += Math.floor(nowMillis - this.currentTurnStart);
        this.currentLapTotalTimePerTeam.set(teamType, currentTotalTimePerTeam);
    }
    public enqueueHourglass(unitId: string) {
        this.alreadyHourglass.add(unitId);
        this.hourglassQueue.push(unitId);
    }
    /**
     * Authoritatively rebuild the "already used a hourglass this lap" set (ranked). The ranked client follows
     * the server's fight state via snapshots instead of running the turn engine, so it never calls flipLap()
     * (which clears this set) nor enqueueHourglass() (which fills it). Without this, alreadyHourglass is
     * perpetually empty on the client → canHourglass is always true → the AI re-requests a hourglass on a
     * unit's re-up, the server rejects it (hourglass_not_available), and the turn is wasted as a skip. The
     * server sends each unit's hasHourglassed flag in the snapshot; rebuilding from it every snapshot also
     * clears the set correctly at lap change (the server resets the flags in flipLap()).
     */
    public restoreAlreadyHourglass(unitIds: Iterable<string>): void {
        this.alreadyHourglass = new Set(unitIds);
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
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
            return;
        }

        if (!this.defaultPlacementPerTeam.has(teamType)) {
            this.defaultPlacementPerTeam.set(teamType, placement);
            this.augmentPlacementPerTeam.set(teamType, PlacementAugment.LEVEL_1);
            this.augmentArmorPerTeam.set(teamType, ArmorAugment.NO_AUGMENT);
            this.augmentMightPerTeam.set(teamType, MightAugment.NO_AUGMENT);
            this.augmentEmpowerPerTeam.set(teamType, EmpowerAugment.NO_AUGMENT);
            this.augmentSniperPerTeam.set(teamType, SniperAugment.NO_AUGMENT);
            this.augmentMovementPerTeam.set(teamType, MovementAugment.NO_AUGMENT);
            this.artifactTier1PerTeam.set(teamType, Tier1Artifact.NO_ARTIFACT);
            this.artifactTier2PerTeam.set(teamType, Tier2Artifact.NO_ARTIFACT);
        }
    }
    public setArtifactPerTeam(teamType: TeamType, tier: number, artifactId: number): boolean {
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
            return false;
        }

        if (tier === ArtifactTier.TIER_1) {
            if (!(artifactId in Tier1Artifact)) {
                return false;
            }
            this.artifactTier1PerTeam.set(teamType, artifactId as Tier1Artifact);
            return true;
        }
        if (tier === ArtifactTier.TIER_2) {
            if (!(artifactId in Tier2Artifact)) {
                return false;
            }
            this.artifactTier2PerTeam.set(teamType, artifactId as Tier2Artifact);
            return true;
        }
        return false;
    }
    public getArtifactTier1(teamType: TeamType): Tier1Artifact {
        return this.artifactTier1PerTeam.get(teamType) ?? Tier1Artifact.NO_ARTIFACT;
    }
    public getArtifactTier2(teamType: TeamType): Tier2Artifact {
        return this.artifactTier2PerTeam.get(teamType) ?? Tier2Artifact.NO_ARTIFACT;
    }
    public hasArtifactTier1(teamType: TeamType, artifactId: Tier1Artifact): boolean {
        return artifactId !== Tier1Artifact.NO_ARTIFACT && this.getArtifactTier1(teamType) === artifactId;
    }
    public hasArtifactTier2(teamType: TeamType, artifactId: Tier2Artifact): boolean {
        return artifactId !== Tier2Artifact.NO_ARTIFACT && this.getArtifactTier2(teamType) === artifactId;
    }
    public setDoctrinePerTeam(teamType: TeamType, doctrine: Doctrine): void {
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
            return;
        }
        this.doctrinePerTeam.set(teamType, doctrine);
    }
    public getDoctrine(teamType: TeamType): Doctrine {
        return this.doctrinePerTeam.get(teamType) ?? Doctrine.NO_DOCTRINE;
    }
    /** Compatibility alias for clients that still render the approved Perk-labelled draft UI. */
    public setPerkPerTeam(teamType: TeamType, perk: Perk): void {
        this.setDoctrinePerTeam(teamType, perk as unknown as Doctrine);
    }
    /** Compatibility alias for clients that still render the approved Perk-labelled draft UI. */
    public getPerk(teamType: TeamType): Perk {
        return this.getDoctrine(teamType) as unknown as Perk;
    }
    // Upgrade (augment) point budget for the team, determined by its chosen doctrine.
    public getUpgradePoints(teamType: TeamType): number {
        return getUpgradePoints(this.getDoctrine(teamType));
    }
    public setAugmentPerTeam(teamType: TeamType, augmentType: AugmentType): boolean {
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
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
            } else if (augmentType.type === "Empower") {
                this.augmentEmpowerPerTeam.set(teamType, augmentType.value);
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
        if (teamType === PBTypes.TeamVals.NO_TEAM) {
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
    // Raw chosen placement-augment LEVEL (not the computed grid sizes getAugmentPlacement returns) — used to
    // serialize/display the team's current Placement selection alongside the other augment levels.
    public getAugmentPlacementLevel(teamType: TeamType): PlacementAugment {
        return this.augmentPlacementPerTeam.get(teamType) ?? PlacementAugment.LEVEL_1;
    }
    public getAugmentArmor(teamType: TeamType): ArmorAugment {
        return this.augmentArmorPerTeam.get(teamType) ?? ArmorAugment.NO_AUGMENT;
    }
    public getAugmentMight(teamType: TeamType): MightAugment {
        return this.augmentMightPerTeam.get(teamType) ?? MightAugment.NO_AUGMENT;
    }
    public getAugmentEmpower(teamType: TeamType): EmpowerAugment {
        return this.augmentEmpowerPerTeam.get(teamType) ?? EmpowerAugment.NO_AUGMENT;
    }
    public getAugmentSniper(teamType: TeamType): SniperAugment {
        return this.augmentSniperPerTeam.get(teamType) ?? SniperAugment.NO_AUGMENT;
    }
    public getAugmentMovement(teamType: TeamType): MovementAugment {
        return this.augmentMovementPerTeam.get(teamType) ?? MovementAugment.NO_AUGMENT;
    }
    public canAugment(teamType: TeamType, augmentType: AugmentType): boolean {
        if (teamType === PBTypes.TeamVals.NO_TEAM || !augmentType || augmentType.value < 0 || !augmentType.type) {
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

        let augmentEmpower;
        if (augmentType.type === "Empower") {
            augmentEmpower = EmpowerAugment.NO_AUGMENT;
        } else {
            augmentEmpower = this.augmentEmpowerPerTeam.get(teamType) ?? EmpowerAugment.NO_AUGMENT;
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

        const currentAugmentPoints =
            augmentPlacement + augmentArmor + augmentMight + augmentEmpower + augmentSniper + augmentMovement;
        if (currentAugmentPoints + augmentPoints > this.getUpgradePoints(teamType)) {
            return false;
        }

        return true;
    }
    public static deserialize(bytes: Uint8Array): FightProperties {
        const fight = PBFight.Fight.deserializeBinary(bytes);
        const fightProperties = new FightProperties();

        fightProperties.id = uuidFromBytes(fight.id);
        fightProperties.currentLap = fight.current_lap;
        fightProperties.gridType = fight.grid_type;
        fightProperties.firstTurnMade = fight.first_turn_made;
        fightProperties.fightStarted = fight.fight_started;
        fightProperties.fightFinished = fight.fight_finished;
        fightProperties.previousTurnTeam = fight.previous_turn_team;
        fightProperties.highestInitiativeThisTurn = fight.highest_initiative_this_turn;
        fightProperties.alreadyMadeTurn = new Set(fight.already_made_turn);

        // Deserialize alreadyMadeTurnByTeam
        fightProperties.alreadyMadeTurnByTeam = new Map(
            Array.from(fight.already_made_turn_by_team.entries()).map(([key, value]) => {
                return [key, new Set(value.values as string[])];
            }),
        );

        fightProperties.alreadyHourglass = new Set(fight.already_hourglass);
        fightProperties.alreadyRepliedAttack = new Set(fight.already_replied_attack);

        // Deserialize teamUnitsAlive
        fightProperties.teamUnitsAlive = new Map(Array.from(fight.team_units_alive.entries()));

        fightProperties.hourglassQueue = new Denque(fight.hourglass_queue);
        fightProperties.moralePlusQueue = new Denque(fight.morale_plus_queue);
        fightProperties.moraleMinusQueue = new Denque(fight.morale_minus_queue);

        fightProperties.currentTurnStart = fight.current_turn_start;
        fightProperties.currentTurnEnd = fight.current_turn_end;

        // Deserialize currentLapTotalTimePerTeam
        fightProperties.currentLapTotalTimePerTeam = new Map(
            Array.from(fight.current_lap_total_time_per_team.entries()),
        );

        fightProperties.upNextQueue = new Denque(fight.up_next);
        fightProperties.stepsMoraleMultiplier = fight.steps_morale_multiplier;
        // Deserialize hasAdditionalTimeRequestedPerTeam
        fightProperties.hasAdditionalTimeRequestedPerTeam = new Map(
            Array.from(fight.has_additional_time_requested_per_team.entries()),
        );

        // Deserialize smokeClouds (transient cell-resident Smoke spell effect).
        fightProperties.smokeClouds = SmokeClouds.fromJSON(
            fight.smoke_clouds.map((c) => ({ x: c.x, y: c.y, l: c.laps_remaining })),
        );

        // Deserialize vines (Vine Throw). `vine_cells` is field 24 in fight.proto, but the checked-in
        // generated protobuf predates it — regenerating needs a `protoc` binary that is not installed here.
        // Read it defensively so this compiles and runs today and starts restoring vines across snapshots the
        // moment someone runs `bun run build:proto`. Until then a restored fight simply has no vines.
        fightProperties.vines = Vines.fromJSON(
            (fight as unknown as { vine_cells?: (PBFight.SmokeCell & { team?: number })[] }).vine_cells?.map((c) => ({
                x: c.x,
                y: c.y,
                l: c.laps_remaining,
                // `team` joins the wire shape when build:proto next runs; until then a restored vine
                // defaults to team 0, which snares both sides — see the note in serialize().
                t: c.team ?? 0,
            })),
        );

        // Deserialize fire walls (Fire Wall). Read defensively for the same reason as vines above —
        // `fire_wall_cells` is field 25 in fight.proto and the checked-in generated protobuf predates it.
        fightProperties.fireWalls = FireWalls.fromJSON(
            (fight as unknown as { fire_wall_cells?: PBFight.SmokeCell[] }).fire_wall_cells?.map((c) => ({
                x: c.x,
                y: c.y,
                l: c.laps_remaining,
            })),
        );

        return fightProperties;
    }
    public serialize(): Uint8Array {
        const fight = new PBFight.Fight({
            id: uuidToUint8Array(this.id),
            current_lap: this.currentLap,
            grid_type: this.gridType,
            first_turn_made: this.firstTurnMade,
            fight_started: this.fightStarted,
            fight_finished: this.fightFinished,
            previous_turn_team: this.previousTurnTeam,
            // Round: proto int field, but unit initiative buffs (augments/synergies) make the highest initiative
            // fractional (e.g. 11.4) and serializeBinary asserts on non-integers — dropping the whole
            // serialized fight for any consumer (e.g. the ranked journal's FIGHT_INITIALIZED snapshot).
            highest_initiative_this_turn: Math.round(this.highestInitiativeThisTurn),
            already_made_turn: Array.from(this.alreadyMadeTurn),
            already_made_turn_by_team: new Map(
                Array.from(this.alreadyMadeTurnByTeam).map(([key, value]) => [
                    key,
                    new PBTypes.StringList({ values: Array.from(value) }),
                ]),
            ),
            already_hourglass: Array.from(this.alreadyHourglass),
            already_replied_attack: Array.from(this.alreadyRepliedAttack),
            team_units_alive: new Map(Array.from(this.teamUnitsAlive)),
            hourglass_queue: this.hourglassQueue.toArray(),
            morale_plus_queue: this.moralePlusQueue.toArray(),
            morale_minus_queue: this.moraleMinusQueue.toArray(),
            current_turn_start: Math.round(this.currentTurnStart),
            current_turn_end: Math.round(this.currentTurnEnd),
            // Round values: same integer assert as above; the per-lap totals accumulate fractional ms.
            current_lap_total_time_per_team: new Map(
                Array.from(this.currentLapTotalTimePerTeam).map(([team, ms]) => [team, Math.round(ms)]),
            ),
            up_next: this.upNextQueue.toArray(),
            steps_morale_multiplier: this.stepsMoraleMultiplier,
            has_additional_time_requested_per_team: new Map(Array.from(this.hasAdditionalTimeRequestedPerTeam)),
            smoke_clouds: this.smokeClouds
                .toJSON()
                .map((c) => new PBFight.SmokeCell({ x: c.x, y: c.y, laps_remaining: c.l })),
            // See the matching note in deserialize(): the generated Fight message ignores this key until
            // `bun run build:proto` adds field 24, at which point vines start persisting with no code change.
            vine_cells: this.vines.toJSON().map((c) => new PBFight.SmokeCell({ x: c.x, y: c.y, laps_remaining: c.l })),
            // Same story as vine_cells: ignored by the generated message until field 25 is built.
            fire_wall_cells: this.fireWalls
                .toJSON()
                .map((c) => new PBFight.SmokeCell({ x: c.x, y: c.y, laps_remaining: c.l })),
        } as unknown as ConstructorParameters<typeof PBFight.Fight>[0]);

        return fight.serializeBinary();
    }
    public prefetchNextUnitsToTurn(
        allUnits: ReadonlyMap<string, Unit>,
        unitsUpper: Unit[],
        unitsLower: Unit[],
        randomInt: RandomIntFn = getRandomInt,
    ): void {
        // The holder can temporarily retain a dead stack while attack cleanup/resurrection resolves. Turn-order
        // cardinality must use only the living units supplied by TurnEngine; otherwise a dead map entry prevents
        // the hourglass queue from reaching the old allUnits.size threshold and the surviving waiter is dropped
        // when the simulator recovers the apparently stalled lap. Keep the map intersection so stale caller lists
        // cannot make a removed unit eligible, while living summons remain eligible immediately.
        const eligibleUnits = [...unitsUpper, ...unitsLower].filter((unit) => {
            const stored = allUnits.get(unit.getId());
            return stored !== undefined && !stored.isDead() && !unit.isDead();
        });
        const eligibleUnitIds = new Set(eligibleUnits.map((unit) => unit.getId()));
        const eligibleUpper = unitsUpper.filter((unit) => eligibleUnitIds.has(unit.getId()));
        const eligibleLower = unitsLower.filter((unit) => eligibleUnitIds.has(unit.getId()));
        const upNextUnitsCount = eligibleUnitIds.size;
        const eligibleUpNextCount = (): number => {
            const queued = new Set<string>();
            for (let i = 0; i < this.upNextQueue.length; i++) {
                const unitId = this.upNextQueue.get(i);
                if (unitId && eligibleUnitIds.has(unitId)) queued.add(unitId);
            }
            return queued.size;
        };

        if (eligibleUpNextCount() >= upNextUnitsCount) {
            return;
        }

        while (eligibleUpNextCount() < upNextUnitsCount) {
            const nextUnitId = this.getNextTurnUnitId(eligibleUnitIds, eligibleUpper, eligibleLower, randomInt);

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
            const parsed = PARSED_CANONICAL_SYNERGY_KEYS.get(synergy) ?? parseLegacySynergyKey(synergy);
            if (!parsed) {
                continue;
            }

            if (parsed.faction !== faction) {
                continue;
            }

            if (specificSynergy === parsed.specificSynergy) {
                if (parsed.level && parsed.level <= MAX_SYNERGY_LEVEL) {
                    return parsed.level;
                }
            }
        }

        return synergyLevel;
    }
    private getAdditionalBoardUnitsPerTeam(teamType: TeamType): number {
        const synergyLevel = this.findSynergyLevel(
            teamType,
            PBTypes.FactionVals.NATURE,
            NatureSynergy.INCREASE_BOARD_UNITS,
        );
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
        eligibleUnitIds: ReadonlySet<string>,
        unitsUpper: Unit[],
        unitsLower: Unit[],
        randomInt: RandomIntFn,
    ): string | undefined {
        if (!unitsLower.length || !unitsUpper.length) {
            return undefined;
        }

        // plus morale
        while (this.moralePlusQueue.length) {
            const nextUnitId = this.moralePlusQueue.shift();
            if (
                nextUnitId &&
                eligibleUnitIds.has(nextUnitId) &&
                !this.alreadyMadeTurn.has(nextUnitId) &&
                !this.upNextIncludes(nextUnitId)
            ) {
                return nextUnitId;
            }
        }

        let totalArmyMoraleUpper = 0;
        let totalArmyMoraleLower = 0;
        let firstBatch: Unit[];
        let secondBatch: Unit[];

        // total morale based
        if (this.previousTurnTeam == PBTypes.TeamVals.NO_TEAM) {
            for (const u of unitsUpper) {
                this.setHighestInitiativeThisTurn(Math.max(this.highestInitiativeThisTurn, u.getInitiative()));
                totalArmyMoraleUpper += u.getMorale();
            }
            for (const u of unitsLower) {
                this.setHighestInitiativeThisTurn(Math.max(this.highestInitiativeThisTurn, u.getInitiative()));
                totalArmyMoraleLower += u.getMorale();
            }

            const avgArmyMoraleUpper = unitsUpper.length ? totalArmyMoraleUpper / unitsUpper.length : 0;
            const avgArmyMoraleLower = unitsLower.length ? totalArmyMoraleLower / unitsLower.length : 0;

            if (avgArmyMoraleUpper > avgArmyMoraleLower) {
                firstBatch = unitsUpper;
                secondBatch = unitsLower;
            } else if (avgArmyMoraleUpper < avgArmyMoraleLower) {
                firstBatch = unitsLower;
                secondBatch = unitsUpper;
            } else {
                let lowerMaxInitiative = Number.MIN_SAFE_INTEGER;
                for (const u of unitsLower) {
                    lowerMaxInitiative =
                        u.getInitiative() > lowerMaxInitiative ? u.getInitiative() : lowerMaxInitiative;
                }
                let upperMaxInitiative = Number.MIN_SAFE_INTEGER;
                for (const u of unitsUpper) {
                    upperMaxInitiative =
                        u.getInitiative() > upperMaxInitiative ? u.getInitiative() : upperMaxInitiative;
                }

                if (lowerMaxInitiative > upperMaxInitiative) {
                    firstBatch = unitsLower;
                    secondBatch = unitsUpper;
                } else if (lowerMaxInitiative < upperMaxInitiative) {
                    firstBatch = unitsUpper;
                    secondBatch = unitsLower;
                } else {
                    const rnd = randomInt(0, 2);
                    if (rnd) {
                        firstBatch = unitsUpper;
                        secondBatch = unitsLower;
                    } else {
                        firstBatch = unitsLower;
                        secondBatch = unitsUpper;
                    }
                }
            }
        } else if (this.previousTurnTeam === PBTypes.TeamVals.LOWER) {
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
            if (
                nextUnitId &&
                eligibleUnitIds.has(nextUnitId) &&
                !this.alreadyMadeTurn.has(nextUnitId) &&
                !this.upNextIncludes(nextUnitId)
            ) {
                return nextUnitId;
            }
        }

        // hourglass
        const hasEligibleHourglassUnit = this.hourglassQueue.toArray().some((unitId) => eligibleUnitIds.has(unitId));
        const allEligibleUnitsAccountedFor = Array.from(eligibleUnitIds).every(
            (unitId) =>
                this.alreadyMadeTurn.has(unitId) || this.hourglassIncludes(unitId) || this.upNextIncludes(unitId),
        );
        if (hasEligibleHourglassUnit && allEligibleUnitsAccountedFor) {
            while (this.hourglassQueue.length) {
                const nextUnitId = this.hourglassQueue.shift();
                if (
                    nextUnitId &&
                    eligibleUnitIds.has(nextUnitId) &&
                    !this.alreadyMadeTurn.has(nextUnitId) &&
                    !this.upNextIncludes(nextUnitId)
                ) {
                    return nextUnitId;
                }
            }
        }

        return undefined;
    }
    private getRandomGridType(): GridType {
        // Randomized maps — an equal 1/3 (33.333%) chance of each of the three board types. getRandomInt is
        // upper-exclusive, so getRandomInt(0, 3) yields 0/1/2 uniformly. The raw source is crypto-secure in
        // production and a seeded PRNG only when a sim/test installed one. Both the client (sandbox) and the
        // server construct FightProperties, so this single site covers every mode.
        const roll = getRandomInt(0, 3);
        if (roll === 0) {
            return PBTypes.GridVals.NORMAL;
        }
        if (roll === 1) {
            return PBTypes.GridVals.BLOCK_CENTER;
        }
        // roll === 2 — LAVA_CENTER (WATER_CENTER is not yet enabled)
        return PBTypes.GridVals.LAVA_CENTER;
    }
}
