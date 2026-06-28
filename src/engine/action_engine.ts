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

import { MORALE_CHANGE_FOR_SHIELD_OR_CLOCK } from "../constants";
import { evaluateAffectedUnits } from "../abilities/aoe_range_ability";
import * as EffectHelper from "../effects/effect_helper";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { AttackType, FactionType, TeamType } from "../generated/protobuf/v1/types_gen";
import { getCellsAroundCell, getPositionForCell, getPositionForCells, isCellWithinGrid } from "../grid/grid_math";
import type { IWeightedRoute } from "../grid/path_definitions";
import type { AttackHandler } from "../handlers/attack_handler";
import type { IAnimationData, IVisibleDamage } from "../scene/animations";
import { Spell } from "../spells/spell";
import * as SpellHelper from "../spells/spell_helper";
import { SpellMultiplierType, SpellPowerType, SpellTargetType } from "../spells/spell_properties";
import { Unit } from "../units/unit";
import { getLapString, getRandomInt } from "../utils/lib";
import type { XY } from "../utils/math";
import type { GameAction } from "./actions";
import type { GameEvent, IGameAnimationEvent } from "./events";
import { TurnEngine, type ITurnEngineContext } from "./turn_engine";

export type GameActionRejectionReason =
    | "fight_not_started"
    | "fight_finished"
    | "unit_not_found"
    | "unit_not_active"
    | "unit_already_acted"
    | "hourglass_not_available"
    | "move_not_available"
    | "invalid_move"
    | "move_blocked"
    | "attack_handler_missing"
    | "attack_not_available"
    | "attack_type_not_available"
    | "obstacle_not_available"
    | "spell_not_found"
    | "spell_not_available"
    | "summon_unit_factory_missing"
    | "placement_not_available"
    | "invalid_placement"
    | "placement_blocked"
    | "split_not_available"
    | "invalid_split"
    | "split_unit_factory_missing"
    | "unit_limit_reached"
    | "delete_not_available"
    | "start_not_available"
    | "unsupported_action";

export interface IGameActionResult {
    completed: boolean;
    events: GameEvent[];
    rejectionReason?: GameActionRejectionReason;
    message?: string;
}

export interface IGameActionEngineContext extends ITurnEngineContext {
    attackHandler?: AttackHandler;
    getCurrentActiveKnownPaths?: () => Map<number, IWeightedRoute[]> | undefined;
    getCurrentEnemiesCellsWithinMovementRange?: () => XY[] | undefined;
    getSummonTargetCell?: (
        caster: Unit,
        spell: Spell,
        action: Extract<GameAction, { type: "cast_spell" }>,
    ) => XY | undefined;
    createSummonedUnit?: (opts: {
        team: TeamType;
        faction: FactionType;
        unitName: string;
        amount: number;
        caster: Unit;
        spell: Spell;
    }) => Unit | undefined;
    canPlaceUnit?: (unit: Unit, cells: XY[], action: Extract<GameAction, { type: "place_unit" }>) => boolean;
    canSplitUnit?: (unit: Unit, action: Extract<GameAction, { type: "split_unit" }>) => boolean;
    createSplitUnit?: (
        unit: Unit,
        amount: number,
        action: Extract<GameAction, { type: "split_unit" }>,
    ) => Unit | undefined;
}

export class GameActionEngine {
    private readonly context: IGameActionEngineContext;
    private readonly turnEngine: TurnEngine;
    public constructor(context: IGameActionEngineContext) {
        this.context = context;
        this.turnEngine = new TurnEngine(context);
    }
    public apply(action: GameAction): IGameActionResult {
        switch (action.type) {
            case "start_fight":
                return this.startFight();
            case "end_turn":
                return this.endTurn(action);
            case "wait_turn":
                return this.waitTurn(action.unitId);
            case "defend_turn":
                return this.defendTurn(action.unitId);
            case "select_attack_type":
                return this.selectAttackType(action.unitId, action.attackType);
            case "move_unit":
                return this.moveUnit(action);
            case "melee_attack":
                return this.meleeAttack(action);
            case "range_attack":
                return this.rangeAttack(action);
            case "obstacle_attack":
                return this.obstacleAttack(action);
            case "area_throw_attack":
                return this.areaThrowAttack(action);
            case "cast_spell":
                return this.castSpell(action);
            case "place_unit":
                return this.placeUnit(action);
            case "split_unit":
                return this.splitUnit(action);
            case "delete_unit":
                return this.deleteUnit(action);
            default:
                return this.reject(
                    "unsupported_action",
                    `${(action as { type: string }).type} is not implemented in the common action engine`,
                );
        }
    }
    private startFight(): IGameActionResult {
        if (this.context.fightProperties.hasFightStarted() || this.context.fightProperties.hasFightFinished()) {
            return this.reject("start_not_available");
        }

        const lowerUnitsAlive = this.context.unitsHolder
            .getAllAllies(PBTypes.TeamVals.LOWER)
            .filter((unit) => !unit.isDead()).length;
        const upperUnitsAlive = this.context.unitsHolder
            .getAllAllies(PBTypes.TeamVals.UPPER)
            .filter((unit) => !unit.isDead()).length;
        if (!lowerUnitsAlive || !upperUnitsAlive) {
            return this.reject("start_not_available");
        }

        this.context.unitsHolder.increaseUnitsSupplyIfNeededPerTeam(PBTypes.TeamVals.LOWER);
        this.context.unitsHolder.increaseUnitsSupplyIfNeededPerTeam(PBTypes.TeamVals.UPPER);
        this.context.unitsHolder.haveDistancesToClosestEnemiesDecreased();
        this.context.fightProperties.startFight();
        this.context.fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, lowerUnitsAlive);
        this.context.fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, upperUnitsAlive);
        this.context.unitsHolder.refreshStackPowerForAllUnits();

        return {
            completed: true,
            events: [{ type: "fight_started", lowerUnitsAlive, upperUnitsAlive }],
        };
    }
    private endTurn(action: Extract<GameAction, { type: "end_turn" }>): IGameActionResult {
        const unit = this.validateTurnAction(action.unitId);
        if (unit instanceof Error) {
            return this.reject(unit.message as GameActionRejectionReason);
        }

        const reason = action.reason ?? "manual";
        // A "manual" end-of-turn (the unit moved/attacked, or the player simply ended the turn) is
        // NOT a skip and must not incur the MORALE_CHANGE_FOR_SKIP penalty or the "skips turn" log.
        // This matches the legacy, which only penalized on turn timeout. Only forced skips
        // (timeout / effect) count as a skip here. Without this, every move ended the turn through
        // this path and silently lost morale (e.g. moving toward the enemy netted -1 instead of +3).
        const isForcedSkip = reason === "timeout" || reason === "effect";
        const events = this.turnEngine.completeTurn(unit, {
            skipReason: isForcedSkip ? reason : undefined,
            skipLogMessage: isForcedSkip ? `${unit.getName()} skips turn` : undefined,
        });
        return { completed: true, events };
    }
    private waitTurn(unitId: string): IGameActionResult {
        const unit = this.validateTurnAction(unitId);
        if (unit instanceof Error) {
            return this.reject(unit.message as GameActionRejectionReason);
        }
        if (!this.canWaitOnHourglass(unit)) {
            return this.reject("hourglass_not_available");
        }

        unit.decreaseMorale(
            MORALE_CHANGE_FOR_SHIELD_OR_CLOCK,
            this.context.fightProperties.getAdditionalMoralePerTeam(unit.getTeam()),
        );
        unit.setOnHourglass(true);
        this.context.fightProperties.enqueueHourglass(unit.getId());
        this.context.sceneLog.updateLog(`${unit.getName()} waits (hourglass)`);

        const events: GameEvent[] = [{ type: "unit_waited", unitId: unit.getId(), team: unit.getTeam() }];
        events.push(...this.turnEngine.completeTurn(unit, { hourglass: true }));
        return { completed: true, events };
    }
    private defendTurn(unitId: string): IGameActionResult {
        const unit = this.validateTurnAction(unitId);
        if (unit instanceof Error) {
            return this.reject(unit.message as GameActionRejectionReason);
        }

        unit.cleanupLuckPerTurn();
        unit.decreaseMorale(
            MORALE_CHANGE_FOR_SHIELD_OR_CLOCK,
            this.context.fightProperties.getAdditionalMoralePerTeam(unit.getTeam()),
        );
        this.context.sceneLog.updateLog(`${unit.getName()} uses Luck Shield`);

        const events: GameEvent[] = [{ type: "unit_defended", unitId: unit.getId(), team: unit.getTeam() }];
        events.push(...this.turnEngine.completeTurn(unit));
        return { completed: true, events };
    }
    private selectAttackType(unitId: string, attackType: AttackType): IGameActionResult {
        const unit = this.validateActionUnit(unitId);
        if (unit instanceof Error) {
            return this.reject(unit.message as GameActionRejectionReason);
        }
        if (unit.getAttackTypeSelection() === attackType) {
            return { completed: true, events: [] };
        }
        if (!unit.selectAttackType(attackType)) {
            return this.reject("attack_type_not_available");
        }

        return {
            completed: true,
            events: [{ type: "attack_type_selected", unitId: unit.getId(), team: unit.getTeam(), attackType }],
        };
    }
    private moveUnit(action: Extract<GameAction, { type: "move_unit" }>): IGameActionResult {
        const unit = this.validateTurnAction(action.unitId);
        if (unit instanceof Error) {
            return this.reject(unit.message as GameActionRejectionReason);
        }
        if (!unit.canMove()) {
            return this.reject("move_not_available");
        }
        if (!action.path.length) {
            return this.reject("invalid_move");
        }
        const targetCells = this.resolveMoveTargetCells(unit, action.path, action.targetCells);
        if (!targetCells.length) {
            return this.reject("invalid_move");
        }
        const pathIsFootprintOnly =
            !unit.isSmallSize() &&
            !!action.targetCells?.length &&
            this.cellsMatchAsSet(action.path, action.targetCells);
        const knownMoveRoute = this.resolveKnownMoveRoute(unit, action.path, targetCells, pathIsFootprintOnly);
        if (knownMoveRoute instanceof Error) {
            return this.reject("invalid_move");
        }
        const travelledPath = pathIsFootprintOnly
            ? action.path
            : this.getTravelledMovePath(unit, knownMoveRoute?.route ?? action.path);
        if (
            !pathIsFootprintOnly &&
            (!travelledPath.length ||
                travelledPath.length > Math.max(1, Math.ceil(unit.getSteps())) ||
                !this.isContinuousMovePath(unit, travelledPath))
        ) {
            return this.reject("invalid_move");
        }

        if (!(
            this.context.grid.areAllCellsEmpty(targetCells, unit.getId()) ||
            this.context.grid.canOccupyCells(
                targetCells,
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            )
        )) {
            return this.reject("move_blocked");
        }

        const from = { ...unit.getPosition() };
        const to = getPositionForCells(this.context.grid.getSettings(), targetCells);
        if (!to) {
            return this.reject("invalid_move");
        }

        const result = this.context.moveHandler.finishDirectedUnitMove(unit, targetCells, to);
        if (result.deleteUnit || !result.newPosition) {
            return this.reject("move_blocked", result.log || undefined);
        }

        if (!pathIsFootprintOnly) {
            this.context.moveHandler.applyRouteMoveModifiers(
                travelledPath,
                unit,
                this.context.fightProperties.getAdditionalAbilityPowerPerTeam(unit.getTeam()),
                this.context.fightProperties.getAdditionalMoralePerTeam(unit.getTeam()),
                knownMoveRoute?.hasLavaCell ?? action.hasLavaCell ?? false,
                knownMoveRoute?.hasWaterCell ?? action.hasWaterCell ?? false,
                from,
            );
        } else {
            // Footprint-only large-unit move: there's no ordered step route to derive a travelled
            // distance from, but morale-by-distance must still apply (previously these moves got no
            // morale at all). Use the explicit pre/post-move centers — the same from/to as the move.
            this.context.moveHandler.applyDistanceMoraleModifier(
                unit,
                from,
                to,
                this.context.fightProperties.getAdditionalMoralePerTeam(unit.getTeam()),
            );
        }

        return {
            completed: true,
            events: [
                {
                    type: "unit_moved",
                    unitId: unit.getId(),
                    from,
                    to: { ...result.newPosition },
                    path: structuredClone(action.path),
                    targetCells: structuredClone(targetCells),
                },
            ],
        };
    }
    private meleeAttack(action: Extract<GameAction, { type: "melee_attack" }>): IGameActionResult {
        const attacker = this.validateTurnAction(action.attackerId);
        if (attacker instanceof Error) {
            return this.reject(attacker.message as GameActionRejectionReason);
        }
        const target = this.context.unitsHolder.getAllUnits().get(action.targetId);
        if (!target) {
            return this.reject("unit_not_found");
        }
        if (!this.context.attackHandler) {
            return this.reject("attack_handler_missing");
        }

        const damage = this.createVisibleDamage();
        const knownPaths = this.resolveKnownPaths(
            attacker,
            action.attackFrom,
            action.path,
            action.hasLavaCell,
            action.hasWaterCell,
        );
        const result = this.context.attackHandler.handleMeleeAttack(
            this.context.unitsHolder,
            this.context.moveHandler,
            damage,
            knownPaths,
            attacker,
            target,
            action.attackFrom,
        );
        if (!result.completed) {
            return this.reject("attack_not_available");
        }

        const unitIdsDied = [...new Set(result.unitIdsDied)];
        const events: GameEvent[] = [
            {
                type: "unit_attacked",
                attackType: "melee",
                attackerId: attacker.getId(),
                targetId: target.getId(),
                unitIdsDied,
                damage: this.cloneVisibleDamage(damage),
                animations: this.serializeAnimations(result.animationData ?? []),
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied));
        events.push(...this.turnEngine.completeTurn(attacker));
        return { completed: true, events };
    }
    private rangeAttack(action: Extract<GameAction, { type: "range_attack" }>): IGameActionResult {
        const attacker = this.validateTurnAction(action.attackerId);
        if (attacker instanceof Error) {
            return this.reject(attacker.message as GameActionRejectionReason);
        }
        const target = this.context.unitsHolder.getAllUnits().get(action.targetId);
        if (!target) {
            return this.reject("unit_not_found");
        }
        if (!this.context.attackHandler) {
            return this.reject("attack_handler_missing");
        }

        const evalResult = this.context.attackHandler.evaluateRangeAttack(
            this.context.unitsHolder.getAllUnits(),
            attacker,
            attacker.getPosition(),
            target.getPosition(),
            attacker.hasAbilityActive("Through Shot"),
            false,
            attacker.hasAbilityActive("Large Caliber") || attacker.hasAbilityActive("Area Throw"),
        );
        let responseDivisor = 1;
        let responseUnits: Unit[] | undefined = undefined;
        if (
            target.getAttackType() === PBTypes.AttackVals.RANGE &&
            target.getRangeShots() > 0 &&
            !target.hasDebuffActive("Range Null Field Aura") &&
            !target.hasDebuffActive("Rangebane") &&
            !this.context.attackHandler.canBeAttackedByMelee(
                target.getPosition(),
                target.isSmallSize(),
                this.context.grid.getEnemyAggrMatrixByUnitId(target.getId()),
            )
        ) {
            const responseEval = this.context.attackHandler.evaluateRangeAttack(
                this.context.unitsHolder.getAllUnits(),
                target,
                target.getPosition(),
                attacker.getPosition(),
                target.hasAbilityActive("Through Shot"),
                false,
                target.hasAbilityActive("Large Caliber") || target.hasAbilityActive("Area Throw"),
            );
            responseDivisor = responseEval.rangeAttackDivisors[0] ?? 1;
            responseUnits = responseEval.affectedUnits[0];
        }

        const damage = this.createVisibleDamage();
        const result = this.context.attackHandler.handleRangeAttack(
            this.context.unitsHolder,
            evalResult.rangeAttackDivisors,
            responseDivisor,
            damage,
            attacker,
            evalResult.affectedUnits,
            responseUnits,
            target.getPosition(),
            false,
            true,
        );
        if (!result.completed) {
            return this.reject("attack_not_available");
        }

        const unitIdsDied = [...new Set(result.unitIdsDied)];
        const events: GameEvent[] = [
            {
                type: "unit_attacked",
                attackType: "range",
                attackerId: attacker.getId(),
                targetId: target.getId(),
                unitIdsDied,
                damage: this.cloneVisibleDamage(damage),
                animations: this.serializeAnimations(result.animationData ?? []),
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied));
        events.push(...this.turnEngine.completeTurn(attacker));
        return { completed: true, events };
    }
    private obstacleAttack(action: Extract<GameAction, { type: "obstacle_attack" }>): IGameActionResult {
        const attacker = this.validateTurnAction(action.attackerId);
        if (attacker instanceof Error) {
            return this.reject(attacker.message as GameActionRejectionReason);
        }
        if (!this.context.attackHandler) {
            return this.reject("attack_handler_missing");
        }
        if (
            this.context.grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            this.context.fightProperties.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            this.context.fightProperties.getObstacleHitsLeft() <= 0
        ) {
            return this.reject("obstacle_not_available");
        }

        const canLandRangeHit =
            attacker.getAttackTypeSelection() === PBTypes.AttackVals.RANGE &&
            this.context.attackHandler.canLandRangeAttack(
                attacker,
                this.context.grid.getEnemyAggrMatrixByUnitId(attacker.getId()),
            );
        if (!canLandRangeHit && !action.attackFrom) {
            return this.reject("attack_not_available");
        }

        const hitsBefore = this.context.fightProperties.getObstacleHitsLeft();
        const knownPaths = action.attackFrom
            ? this.resolveKnownPaths(attacker, action.attackFrom, action.path, action.hasLavaCell, action.hasWaterCell)
            : undefined;
        const result = this.context.attackHandler.handleObstacleAttack(
            action.targetPosition,
            this.context.unitsHolder,
            this.context.moveHandler,
            attacker,
            action.attackFrom,
            knownPaths,
        );
        const hitsAfter = this.context.fightProperties.getObstacleHitsLeft();
        if (!result.completed || hitsAfter >= hitsBefore) {
            return this.reject("attack_not_available");
        }

        this.context.unitsHolder.refreshStackPowerForAllUnits();
        const events: GameEvent[] = [
            {
                type: "obstacle_attacked",
                attackerId: attacker.getId(),
                targetPosition: { ...action.targetPosition },
                attackFrom: action.attackFrom ? { ...action.attackFrom } : undefined,
                hitsBefore,
                hitsAfter,
                animations: this.serializeAnimations(result.animationData ?? []),
            },
        ];
        if (hitsAfter <= 0) {
            this.context.grid.cleanupCenterObstacle();
            events.push({ type: "center_obstacle_cleared", gridType: this.context.fightProperties.getGridType() });
        }
        events.push(...this.turnEngine.completeTurn(attacker));
        return { completed: true, events };
    }
    private areaThrowAttack(action: Extract<GameAction, { type: "area_throw_attack" }>): IGameActionResult {
        const attacker = this.validateTurnAction(action.attackerId);
        if (attacker instanceof Error) {
            return this.reject(attacker.message as GameActionRejectionReason);
        }
        if (!this.context.attackHandler) {
            return this.reject("attack_handler_missing");
        }
        if (
            !attacker.hasAbilityActive("Area Throw") ||
            attacker.getAttackTypeSelection() !== PBTypes.AttackVals.RANGE ||
            attacker.getRangeShots() <= 0 ||
            !isCellWithinGrid(this.context.grid.getSettings(), action.targetCell)
        ) {
            return this.reject("attack_not_available");
        }
        const occupantId = this.context.grid.getOccupantUnitId(action.targetCell);
        if (occupantId && occupantId !== "L" && occupantId !== "W") {
            return this.reject("attack_not_available");
        }

        // Project the throw onto the first enemy standing on the trajectory between the attacker and
        // the aimed (empty) cell. A unit on the line intercepts the throw instead of it passing
        // through to the cell behind — matching legacy test_heroes.ts. With a clear path the aimed
        // cell is used unchanged.
        const targetCell = this.context.attackHandler.projectAreaThrowTargetCell(
            this.context.unitsHolder.getAllUnits(),
            attacker,
            action.targetCell,
        );
        const targetPosition = getPositionForCell(
            targetCell,
            this.context.grid.getSettings().getMinX(),
            this.context.grid.getSettings().getStep(),
            this.context.grid.getSettings().getHalfStep(),
        );
        const affectedCells = [...getCellsAroundCell(this.context.grid.getSettings(), targetCell), targetCell];
        const affectedUnits = evaluateAffectedUnits(affectedCells, this.context.unitsHolder, this.context.grid);
        const divisor = this.context.attackHandler.getRangeAttackDivisor(attacker, targetPosition);
        const damage = this.createVisibleDamage();
        const result = this.context.attackHandler.handleRangeAttack(
            this.context.unitsHolder,
            [divisor, divisor],
            1,
            damage,
            attacker,
            affectedUnits,
            undefined,
            targetPosition,
            true,
            true,
        );
        if (!result.completed) {
            return this.reject("attack_not_available");
        }

        const affectedUnitIds = affectedUnits?.[0]?.map((unit) => unit.getId()) ?? [];
        const unitIdsDied = [...new Set(result.unitIdsDied)];
        const events: GameEvent[] = [
            {
                type: "area_attacked",
                attackType: "area_throw",
                attackerId: attacker.getId(),
                targetCell: { ...targetCell },
                targetPosition,
                affectedUnitIds,
                unitIdsDied,
                damage: this.cloneVisibleDamage(damage),
                animations: this.serializeAnimations(result.animationData ?? []),
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied));
        events.push(...this.turnEngine.completeTurn(attacker));
        return { completed: true, events };
    }
    private castSpell(action: Extract<GameAction, { type: "cast_spell" }>): IGameActionResult {
        const caster = this.validateTurnAction(action.casterId);
        if (caster instanceof Error) {
            return this.reject(caster.message as GameActionRejectionReason);
        }
        if (!this.context.attackHandler) {
            return this.reject("attack_handler_missing");
        }

        const spell = caster.getSpells().find((candidate) => candidate.getName() === action.spellName);
        if (!spell) {
            return this.reject("spell_not_found");
        }
        if (!this.canUseSpell(caster, spell)) {
            return this.reject("spell_not_available");
        }

        const target = action.targetId ? this.context.unitsHolder.getAllUnits().get(action.targetId) : undefined;
        if (action.targetId && !target) {
            return this.reject("unit_not_found");
        }
        if (target && action.targetCell && !this.sameCell(action.targetCell, target.getBaseCell())) {
            return this.reject("spell_not_available");
        }
        if (!target && this.isSummonSpell(spell)) {
            return this.summonSpell(action, caster, spell);
        }
        if (!target && this.isMassSpell(spell)) {
            return this.massCastSpell(action, caster, spell);
        }

        const result = this.context.attackHandler.handleMagicAttack(
            this.context.grid.getMatrix(),
            this.context.unitsHolder,
            spell,
            caster,
            target,
            this.context.getCurrentEnemiesCellsWithinMovementRange?.(),
        );
        if (!result.completed) {
            return this.reject("spell_not_available");
        }

        const unitIdsDied = [...new Set(result.unitIdsDied)];
        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetId: target?.getId(),
                targetCell: target?.getBaseCell(),
                unitIdsDied,
                animations: this.serializeAnimations(result.animationData ?? []),
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    private isMassSpell(spell: Spell): boolean {
        return (
            spell.getSpellTargetType() === SpellTargetType.ALL_FLYING ||
            spell.getSpellTargetType() === SpellTargetType.ALL_ALLIES ||
            spell.getSpellTargetType() === SpellTargetType.ALL_ENEMIES
        );
    }
    private isSummonSpell(spell: Spell): boolean {
        return spell.isSummon() && spell.getSpellTargetType() === SpellTargetType.RANDOM_CLOSE_TO_CASTER;
    }
    private canUseSpell(caster: Unit, spell: Spell): boolean {
        return (
            spell.getLapsTotal() > 0 &&
            spell.isRemaining() &&
            spell.getMinimalCasterStackPower() <= caster.getStackPower()
        );
    }
    private massCastSpell(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        const team = caster.getTeam();
        if (
            !SpellHelper.canMassCastSpell(
                spell,
                this.context.unitsHolder.getAllTeamUnitsBuffs(team),
                this.context.unitsHolder.getAllEnemyUnitsBuffs(team),
                this.context.unitsHolder.getAllEnemyUnitsDebuffs(team),
                this.context.unitsHolder.getAllTeamUnitsMagicResist(team),
                this.context.unitsHolder.getAllEnemyUnitsMagicResist(team),
                this.context.unitsHolder.getAllTeamUnitsHp(team),
                this.context.unitsHolder.getAllTeamUnitsMaxHp(team),
                this.context.unitsHolder.getAllTeamUnitsCanFly(team),
                this.context.unitsHolder.getAllEnemyUnitsCanFly(team),
            )
        ) {
            return this.reject("spell_not_available");
        }

        const targetType = spell.getSpellTargetType();
        if (targetType === SpellTargetType.ALL_FLYING) {
            this.massCastOnFlyers(spell, caster, team);
        } else if (targetType === SpellTargetType.ALL_ALLIES) {
            this.massCastOnAllies(spell, caster, team);
        } else {
            this.massCastOnEnemies(spell, caster, team);
        }

        caster.useSpell(spell.getName());
        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: action.targetCell ? { ...action.targetCell } : undefined,
                unitIdsDied: [],
                animations: [],
            },
        ];
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    private summonSpell(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        const amount = Math.floor(caster.getAmountAlive() * spell.getPower());
        if (amount <= 0) {
            return this.reject("spell_not_available");
        }

        const targetCell = action.targetCell ?? this.context.getSummonTargetCell?.(caster, spell, action);
        if (!SpellHelper.canCastSummon(spell, this.context.grid.getMatrix(), targetCell)) {
            return this.reject("spell_not_available");
        }

        const unitName = spell.getSummonUnitName();
        const team = caster.getTeam();
        const existing = this.context.unitsHolder.getSummonedUnitByName(team, unitName);
        if (existing) {
            existing.increaseAmountAlive(amount);
            this.context.sceneLog.updateLog(`${caster.getName()} summoned ${amount} x ${unitName}`);
            caster.useSpell(spell.getName());

            const events = this.createSummonEvents(caster, spell, existing, amount, existing.getCells(), true);
            events.push(...this.turnEngine.completeTurn(caster));
            return { completed: true, events };
        }

        if (!this.context.createSummonedUnit) {
            return this.reject("summon_unit_factory_missing");
        }

        const summoned = this.context.createSummonedUnit({
            team,
            faction: spell.getSummonUnitRace(),
            unitName,
            amount,
            caster,
            spell,
        });
        if (!summoned || this.context.unitsHolder.getAllUnits().has(summoned.getId())) {
            return this.reject("spell_not_available");
        }

        const cells = this.resolveSummonCells(summoned, targetCell);
        if (!cells.length) {
            return this.reject("spell_not_available");
        }
        const position = getPositionForCells(this.context.grid.getSettings(), cells);
        if (!position) {
            return this.reject("spell_not_available");
        }

        const occupied = this.context.grid.occupyCells(
            cells,
            summoned.getId(),
            team,
            summoned.getAttackRange(),
            summoned.hasAbilityActive("Made of Fire"),
            summoned.hasAbilityActive("Made of Water"),
        );
        if (!occupied) {
            return this.reject("spell_not_available", `No room to summon ${unitName}`);
        }

        summoned.setPosition(position.x, position.y);
        this.context.unitsHolder.addUnit(summoned);
        this.context.sceneLog.updateLog(`${caster.getName()} summoned ${amount} x ${unitName}`);
        caster.useSpell(spell.getName());

        const events = this.createSummonEvents(caster, spell, summoned, amount, cells, false);
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    private resolveSummonCells(unit: Unit, targetCell?: XY): XY[] {
        if (!targetCell) {
            return [];
        }
        if (unit.isSmallSize()) {
            return [{ ...targetCell }];
        }

        return [
            { x: targetCell.x - 1, y: targetCell.y },
            { x: targetCell.x, y: targetCell.y },
            { x: targetCell.x - 1, y: targetCell.y - 1 },
            { x: targetCell.x, y: targetCell.y - 1 },
        ];
    }
    private createSummonEvents(
        caster: Unit,
        spell: Spell,
        summoned: Unit,
        amount: number,
        cells: XY[],
        merged: boolean,
    ): GameEvent[] {
        return [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: cells[0] ? { ...cells[0] } : undefined,
                unitIdsDied: [],
                animations: [],
            },
            {
                type: "unit_summoned",
                casterId: caster.getId(),
                unitId: summoned.getId(),
                team: summoned.getTeam(),
                unitName: summoned.getName(),
                amount,
                position: { ...summoned.getPosition() },
                cells: structuredClone(cells),
                merged,
            },
        ];
    }
    private massCastOnFlyers(spell: Spell, caster: Unit, team: number): void {
        const applyTo = (units: Unit[]) => {
            for (const unit of units) {
                if (unit.getMagicResist() === 100 || !unit.canFly()) {
                    continue;
                }
                if (!SpellHelper.hasAlreadyAppliedSpell(unit, spell)) {
                    unit.applyBuff(spell, undefined, undefined, unit.getId() === caster.getId());
                }
            }
        };
        applyTo(this.context.unitsHolder.getAllAllies(team));
        applyTo(this.context.unitsHolder.getAllEnemyUnits(team));
    }
    private massCastOnAllies(spell: Spell, caster: Unit, team: number): void {
        const isHeal = spell.getPowerType() === SpellPowerType.HEAL;
        if (!isHeal) {
            this.context.sceneLog.updateLog(`${caster.getName()} cast ${spell.getName()} on allies`);
        }

        for (const unit of this.context.unitsHolder.getAllAllies(team)) {
            if (unit.getMagicResist() === 100) {
                continue;
            }
            if (isHeal) {
                if (unit.canBeHealed()) {
                    const healPower = unit.applyHeal(Math.floor(spell.getPower() * caster.getAmountAlive()));
                    if (healPower) {
                        this.context.sceneLog.updateLog(
                            `${caster.getName()} mass healed ${unit.getName()} for ${healPower} hp`,
                        );
                    }
                }
                continue;
            }
            if (SpellHelper.hasAlreadyAppliedSpell(unit, spell)) {
                continue;
            }
            if (spell.getMultiplierType() === SpellMultiplierType.UNIT_AMOUNT) {
                const scaledSpell = new Spell({
                    spellProperties: spell.getSpellProperties(),
                    amount: spell.getAmount(),
                });
                scaledSpell.setPower(caster.getAmountAlive());
                scaledSpell.setDesc(
                    spell
                        .getDesc()
                        .map((description) => description.replace(/\{\}/g, caster.getAmountAlive().toString())),
                );
                unit.applyBuff(scaledSpell, undefined, undefined, unit.getId() === caster.getId());
            } else {
                unit.applyBuff(spell, undefined, undefined, unit.getId() === caster.getId());
            }
        }
    }
    private massCastOnEnemies(spell: Spell, caster: Unit, team: number): void {
        this.context.sceneLog.updateLog(`${caster.getName()} cast ${spell.getName()} on enemies`);
        for (const enemy of this.context.unitsHolder.getAllEnemyUnits(team)) {
            const absorptionTarget = EffectHelper.getAbsorptionTarget(
                enemy,
                this.context.grid,
                this.context.unitsHolder,
            );
            const debuffTarget = absorptionTarget ?? enemy;

            if (debuffTarget.getMagicResist() === 100) {
                continue;
            }
            if (getRandomInt(0, 100) < Math.floor(debuffTarget.getMagicResist())) {
                this.context.sceneLog.updateLog(`${debuffTarget.getName()} resisted from ${spell.getName()}`);
                continue;
            }
            if (
                SpellHelper.hasAlreadyAppliedSpell(debuffTarget, spell) ||
                (spell.getPowerType() === SpellPowerType.MIND && debuffTarget.hasMindAttackResistance())
            ) {
                continue;
            }

            const laps = spell.getLapsTotal();
            debuffTarget.applyDebuff(spell, undefined, undefined, debuffTarget.getId() === caster.getId());

            if (
                SpellHelper.isMirrored(debuffTarget) &&
                !SpellHelper.hasAlreadyAppliedSpell(caster, spell) &&
                !(spell.getPowerType() === SpellPowerType.MIND && caster.hasMindAttackResistance())
            ) {
                caster.applyDebuff(spell, undefined, undefined, true);
                this.context.sceneLog.updateLog(
                    `${debuffTarget.getName()} mirrored ${spell.getName()} to ${caster.getName()} for ${getLapString(
                        laps,
                    )}`,
                );
            }
        }
    }
    private placeUnit(action: Extract<GameAction, { type: "place_unit" }>): IGameActionResult {
        if (this.context.fightProperties.hasFightStarted() || this.context.fightProperties.hasFightFinished()) {
            return this.reject("placement_not_available");
        }

        const unit = this.context.unitsHolder.getAllUnits().get(action.unitId);
        if (!unit) {
            return this.reject("unit_not_found");
        }
        if (unit.getTeam() !== action.team || unit.getName() !== action.unitName) {
            return this.reject("invalid_placement");
        }
        if (!this.isValidPlacementFootprint(unit, action.cells)) {
            return this.reject("invalid_placement");
        }
        if (this.context.canPlaceUnit && !this.context.canPlaceUnit(unit, action.cells, action)) {
            return this.reject("placement_not_available");
        }

        const position = getPositionForCells(this.context.grid.getSettings(), action.cells);
        if (!position) {
            return this.reject("invalid_placement");
        }

        const previousPosition = { ...unit.getPosition() };
        const previousCells = this.getOccupiedCellsForUnit(unit);
        if (previousCells.length) {
            this.context.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
        }

        const occupied = this.context.grid.occupyCells(
            action.cells,
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.hasAbilityActive("Made of Fire"),
            unit.hasAbilityActive("Made of Water"),
        );
        if (!occupied) {
            this.rollbackPlacement(unit, previousCells, previousPosition);
            return this.reject("placement_blocked");
        }

        unit.setPosition(position.x, position.y);

        return {
            completed: true,
            events: [
                {
                    type: "unit_placed",
                    unitId: unit.getId(),
                    team: unit.getTeam(),
                    position: { ...position },
                    cells: structuredClone(action.cells),
                },
            ],
        };
    }
    private deleteUnit(action: Extract<GameAction, { type: "delete_unit" }>): IGameActionResult {
        if (this.context.fightProperties.hasFightStarted()) {
            return this.reject("delete_not_available");
        }

        const unit = this.context.unitsHolder.getAllUnits().get(action.unitId);
        if (!unit) {
            return this.reject("unit_not_found");
        }
        const team = unit.getTeam();
        if (!this.context.unitsHolder.deleteUnitById(action.unitId)) {
            return this.reject("delete_not_available");
        }

        return {
            completed: true,
            events: [{ type: "unit_deleted", unitId: action.unitId, team }],
        };
    }
    private splitUnit(action: Extract<GameAction, { type: "split_unit" }>): IGameActionResult {
        if (this.context.fightProperties.hasFightStarted() || this.context.fightProperties.hasFightFinished()) {
            return this.reject("split_not_available");
        }

        const sourceUnit = this.context.unitsHolder.getAllUnits().get(action.unitId);
        if (!sourceUnit) {
            return this.reject("unit_not_found");
        }

        if (
            !Number.isSafeInteger(action.amount) ||
            action.amount <= 0 ||
            action.amount >= sourceUnit.getAmountAlive()
        ) {
            return this.reject("invalid_split");
        }

        if (this.context.canSplitUnit && !this.context.canSplitUnit(sourceUnit, action)) {
            return this.reject("unit_limit_reached");
        }

        const splitUnit = this.context.createSplitUnit?.(sourceUnit, action.amount, action);
        if (!splitUnit) {
            return this.reject("split_unit_factory_missing");
        }

        const sourceAmount = sourceUnit.getAmountAlive() - action.amount;
        sourceUnit.setAmountAlive(sourceAmount);
        this.context.unitsHolder.addUnit(splitUnit);

        return {
            completed: true,
            events: [
                {
                    type: "unit_split",
                    sourceUnitId: sourceUnit.getId(),
                    newUnitId: splitUnit.getId(),
                    team: sourceUnit.getTeam(),
                    sourceAmount,
                    splitAmount: action.amount,
                },
            ],
        };
    }
    private validateTurnAction(unitId: string): Unit | Error {
        const unit = this.validateActionUnit(unitId);
        if (unit instanceof Error) {
            return unit;
        }
        if (this.context.fightProperties.hasAlreadyMadeTurn(unitId)) {
            return new Error("unit_already_acted");
        }

        return unit;
    }
    private validateActionUnit(unitId: string): Unit | Error {
        if (!this.context.fightProperties.hasFightStarted()) {
            return new Error("fight_not_started");
        }
        if (this.context.fightProperties.hasFightFinished()) {
            return new Error("fight_finished");
        }

        const unit = this.context.unitsHolder.getAllUnits().get(unitId);
        if (!unit) {
            return new Error("unit_not_found");
        }

        const activeUnitId = this.context.getCurrentActiveUnitId?.();
        if (activeUnitId !== undefined && activeUnitId !== unitId) {
            return new Error("unit_not_active");
        }

        return unit;
    }
    private canWaitOnHourglass(unit: Unit): boolean {
        const teamUnitsAlive = this.context.fightProperties.getTeamUnitsAlive(unit.getTeam());
        if (unit.getTeam() !== PBTypes.TeamVals.LOWER && unit.getTeam() !== PBTypes.TeamVals.UPPER) {
            return false;
        }

        return (
            teamUnitsAlive > 1 &&
            !this.context.fightProperties.hourglassIncludes(unit.getId()) &&
            !this.context.fightProperties.hasAlreadyMadeTurn(unit.getId()) &&
            !this.context.fightProperties.hasAlreadyHourglass(unit.getId())
        );
    }
    private getTravelledMovePath(unit: Unit, path: XY[]): XY[] {
        const currentCell = unit.getBaseCell();
        const firstCell = path[0];
        if (firstCell && firstCell.x === currentCell.x && firstCell.y === currentCell.y) {
            return path.slice(1);
        }

        return path;
    }
    private resolveKnownMoveRoute(
        unit: Unit,
        path: XY[],
        targetCells: XY[],
        pathIsFootprintOnly: boolean,
    ): IWeightedRoute | undefined | Error {
        const knownPaths = this.context.getCurrentActiveKnownPaths?.();
        if (!knownPaths) {
            return undefined;
        }
        if (!knownPaths.size) {
            return new Error("invalid_move");
        }

        if (pathIsFootprintOnly) {
            return this.findKnownRouteForLargeFootprint(targetCells, knownPaths) ?? new Error("invalid_move");
        }

        const destination = path[path.length - 1];
        if (!destination) {
            return new Error("invalid_move");
        }
        const routes = knownPaths.get(this.cellKey(destination));
        if (!routes?.length) {
            return new Error("invalid_move");
        }

        const matchingRoute = routes.find((route) => this.routeMatchesActionPath(unit, route.route, path));
        return matchingRoute ?? new Error("invalid_move");
    }
    private findKnownRouteForLargeFootprint(
        targetCells: XY[],
        knownPaths: ReadonlyMap<number, IWeightedRoute[]>,
    ): IWeightedRoute | undefined {
        for (const cell of targetCells) {
            const routes = knownPaths.get(this.cellKey(cell));
            const matchingRoute = routes?.find((route) =>
                this.cellsMatchAsSet(targetCells, this.getLargeRouteFootprint(route.cell)),
            );
            if (matchingRoute) {
                return matchingRoute;
            }
        }

        return undefined;
    }
    private routeMatchesActionPath(unit: Unit, knownRoute: XY[], actionPath: XY[]): boolean {
        if (this.cellsMatchInOrder(knownRoute, actionPath)) {
            return true;
        }

        return this.cellsMatchInOrder(
            this.getTravelledMovePath(unit, knownRoute),
            this.getTravelledMovePath(unit, actionPath),
        );
    }
    private isContinuousMovePath(unit: Unit, travelledPath: XY[]): boolean {
        let previous = unit.getBaseCell();
        for (const cell of travelledPath) {
            if (!isCellWithinGrid(this.context.grid.getSettings(), cell)) {
                return false;
            }

            const dx = Math.abs(cell.x - previous.x);
            const dy = Math.abs(cell.y - previous.y);
            if ((dx === 0 && dy === 0) || dx > 1 || dy > 1) {
                return false;
            }
            previous = cell;
        }

        return true;
    }
    private getLargeRouteFootprint(anchorCell: XY): XY[] {
        return [
            { x: anchorCell.x - 1, y: anchorCell.y - 1 },
            { x: anchorCell.x, y: anchorCell.y - 1 },
            { x: anchorCell.x - 1, y: anchorCell.y },
            { x: anchorCell.x, y: anchorCell.y },
        ];
    }
    private cellsMatchInOrder(left: XY[], right: XY[]): boolean {
        return (
            left.length === right.length &&
            left.every((cell, index) => cell.x === right[index]?.x && cell.y === right[index]?.y)
        );
    }
    private cellsMatchAsSet(left: XY[], right: XY[]): boolean {
        if (left.length !== right.length) {
            return false;
        }

        const rightCells = new Set(right.map((cell) => this.cellKey(cell)));
        return left.every((cell) => rightCells.has(this.cellKey(cell)));
    }
    private cellKey(cell: XY): number {
        return (cell.x << 4) | cell.y;
    }
    private sameCell(left: XY, right: XY): boolean {
        return left.x === right.x && left.y === right.y;
    }
    private resolveMoveTargetCells(unit: Unit, path: XY[], targetCells?: XY[]): XY[] {
        if (targetCells?.length) {
            return structuredClone(targetCells);
        }
        const destination = path[path.length - 1];
        if (!destination) {
            return [];
        }
        if (unit.isSmallSize()) {
            return [{ ...destination }];
        }

        return [
            { x: destination.x, y: destination.y },
            { x: destination.x + 1, y: destination.y },
            { x: destination.x, y: destination.y + 1 },
            { x: destination.x + 1, y: destination.y + 1 },
        ];
    }
    private isValidPlacementFootprint(unit: Unit, cells: XY[]): boolean {
        if (unit.isSmallSize()) {
            return cells.length === 1;
        }
        if (cells.length !== 4) {
            return false;
        }

        const xs = new Set(cells.map((cell) => cell.x));
        const ys = new Set(cells.map((cell) => cell.y));
        if (xs.size !== 2 || ys.size !== 2) {
            return false;
        }
        const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
        const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
        if (maxX - minX !== 1 || maxY - minY !== 1) {
            return false;
        }

        const required = new Set([`${minX}:${minY}`, `${maxX}:${minY}`, `${minX}:${maxY}`, `${maxX}:${maxY}`]);
        return cells.every((cell) => required.has(`${cell.x}:${cell.y}`));
    }
    private getOccupiedCellsForUnit(unit: Unit): XY[] {
        return unit.getCells().filter((cell) => this.context.grid.getOccupantUnitId(cell) === unit.getId());
    }
    private rollbackPlacement(unit: Unit, previousCells: XY[], previousPosition: XY): void {
        if (!previousCells.length) {
            return;
        }

        this.context.grid.occupyCells(
            previousCells,
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.hasAbilityActive("Made of Fire"),
            unit.hasAbilityActive("Made of Water"),
        );
        unit.setPosition(previousPosition.x, previousPosition.y);
    }
    private resolveKnownPaths(
        unit: Unit,
        targetCell: XY,
        path?: XY[],
        hasLavaCell = false,
        hasWaterCell = false,
    ): Map<number, IWeightedRoute[]> | undefined {
        const currentKnownPaths = this.context.getCurrentActiveKnownPaths?.();
        if (!path?.length) {
            return currentKnownPaths;
        }

        const key = this.cellKey(targetCell);
        const knownRoutes = currentKnownPaths?.get(key);
        if (currentKnownPaths) {
            const matchingRoute = knownRoutes?.find((route) => this.routeMatchesActionPath(unit, route.route, path));
            return matchingRoute ? new Map([[key, [matchingRoute]]]) : undefined;
        }

        const knownPaths = new Map<number, IWeightedRoute[]>();
        knownPaths.set(key, [
            {
                cell: targetCell,
                route: path,
                weight: path.length,
                firstAggrMet: false,
                hasLavaCell,
                hasWaterCell,
            },
        ]);
        return knownPaths;
    }
    private createVisibleDamage(): IVisibleDamage {
        return {
            amount: 0,
            render: false,
            unitPosition: { x: 0, y: 0 },
            unitIsSmall: true,
            hits: [],
        };
    }
    private cloneVisibleDamage(damage: IVisibleDamage): IVisibleDamage {
        return {
            ...damage,
            unitPosition: { ...damage.unitPosition },
            hits: damage.hits?.map((hit) => ({ ...hit })),
            splash: damage.splash?.map((entry) => ({ ...entry, position: { ...entry.position } })),
        };
    }
    private serializeAnimations(animationData: IAnimationData[]): IGameAnimationEvent[] {
        return animationData.map((animation): IGameAnimationEvent => ({
            toPosition: { ...animation.toPosition },
            fromPosition: animation.fromPosition ? { ...animation.fromPosition } : undefined,
            affectedUnitId: animation.affectedUnit instanceof Unit ? animation.affectedUnit.getId() : undefined,
            bodyUnitId: animation.bodyUnit?.getId(),
        }));
    }
    private cleanupDeadUnits(unitIdsDied: string[]): GameEvent[] {
        const events: GameEvent[] = [];
        const processed = new Set<string>();

        for (const unitId of unitIdsDied) {
            if (processed.has(unitId)) {
                continue;
            }
            processed.add(unitId);

            const unit = this.context.unitsHolder.getAllUnits().get(unitId);
            if (!unit?.isDead()) {
                continue;
            }

            const unitName = unit.getName();
            const deleted = this.context.unitsHolder.deleteUnitById(unitId, true);
            if (deleted) {
                events.push({ type: "unit_destroyed", unitId, reason: "dead_cleanup" });
                continue;
            }

            const resurrected = this.context.unitsHolder.getAllUnits().get(unitId);
            if (resurrected && !resurrected.isDead()) {
                this.context.sceneLog.updateLog(`${unitName} is resurrecting!`);
                events.push({
                    type: "unit_resurrected",
                    unitId,
                    team: resurrected.getTeam(),
                    amount: resurrected.getAmountAlive(),
                    hp: resurrected.getHp(),
                    position: { ...resurrected.getPosition() },
                });
            }
        }

        return events;
    }
    private reject(rejectionReason: GameActionRejectionReason, message?: string): IGameActionResult {
        return { completed: false, events: [], rejectionReason, message };
    }
}
