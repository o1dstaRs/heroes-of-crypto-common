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

import {
    LUCK_CHANGE_FOR_SHIELD,
    MORALE_CHANGE_FOR_CLOCK,
    MORALE_CHANGE_FOR_KILL,
    MORALE_CHANGE_FOR_SHIELD,
} from "../constants";
import * as AbilityHelper from "../abilities/ability_helper";
import { evaluateAffectedUnits } from "../abilities/aoe_range_ability";
import { processCraftAbility } from "../abilities/craft_ability";
import * as EffectHelper from "../effects/effect_helper";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { AttackType, FactionType, TeamType } from "../generated/protobuf/v1/types_gen";
import {
    getCellsAroundCell,
    getCellsAroundFootprint,
    getCellForPosition,
    getFootprintAnchorForCells,
    getFootprintCellsForAnchor,
    getPositionForCell,
    getPositionForCells,
    isCellWithinGrid,
    isFootprintWithinGrid,
    resolveRangeAttackAimEdge,
} from "../grid/grid_math";
import type { IWeightedRoute } from "../grid/path_definitions";
import { PathHelper } from "../grid/path_helper";
import type { AttackHandler } from "../handlers/attack_handler";
import type { IAnimationData, ISecondaryDamage, IVisibleDamage } from "../scene/animations";
import { amplifyCastBuffForTarget } from "../spells/castable_buff";
import { Spell } from "../spells/spell";
import * as SpellHelper from "../spells/spell_helper";
import { SpellMultiplierType, SpellPowerType, SpellTargetType } from "../spells/spell_properties";
import { isSmokeableCell } from "../spells/smoke_clouds";
import { projectSpellRebound, spellDamageAgainstUnit, spellRawDamage } from "../spells/spell_cast_projection";
import { VINE_STRIDE_COST_MULTIPLIER, canVineTakeRoot, vinePathCells } from "../spells/vines";
import {
    fireWallBurnPercentage,
    fireWallCells,
    isFireWallableCell,
    normalizeFireWallOrientation,
} from "../spells/fire_walls";
import { getSpellConfig } from "../configuration/config_provider";
import { Unit } from "../units/unit";
import {
    beginEffectApplicationCapture,
    endEffectApplicationCapture,
    endWaterShieldAbsorbCapture,
    recordEffectApplication,
} from "../units/effect_application_capture";
import { getLapString, getRandomInt } from "../utils/lib";
import type { XY } from "../utils/math";
import type { GameAction } from "./actions";
import { isHeadlessSimulationEvent, type GameEvent, type IGameAnimationEvent } from "./events";
import { canWaitOnHourglass } from "./hourglass";
import {
    burnUnitOnFireWallCells,
    isMovePathFootprintOnly,
    moveCellsMatchAsSet,
    resolveMoveTargetCells,
    travelledMovePath,
} from "./post_move_actor_availability";
import { TurnEngine, type ITurnEngineContext, type TurnSkipReason } from "./turn_engine";

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
    | "additional_time_not_available"
    | "augment_not_available"
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
        spell?: Spell;
        sourceAbility?: string;
    }) => Unit | undefined;
    canPlaceUnit?: (unit: Unit, cells: XY[], action: Extract<GameAction, { type: "place_unit" }>) => boolean;
    canSplitUnit?: (unit: Unit, action: Extract<GameAction, { type: "split_unit" }>) => boolean;
    createSplitUnit?: (
        unit: Unit,
        amount: number,
        action: Extract<GameAction, { type: "split_unit" }>,
    ) => Unit | undefined;
}

/** Damage a spell actually dealt to one victim, after its magic resistance. */
// Fight actions whose applications are captured into an `effects_applied` event. defend_turn is
// excluded on purpose — see apply().
const EFFECT_CAPTURED_ACTION_TYPES: ReadonlySet<GameAction["type"]> = new Set<GameAction["type"]>([
    "end_turn",
    "wait_turn",
    "select_attack_type",
    "move_unit",
    "melee_attack",
    "range_attack",
    "obstacle_attack",
    "area_throw_attack",
    "cast_spell",
]);

const spellDamageDealt = (damaged: { unitId: string; amount: number }[], unitId: string): number =>
    damaged.find((entry) => entry.unitId === unitId)?.amount ?? 0;

/** Damage a splash spell actually dealt across everyone it caught, after each victim's magic resistance. */
const spellDamageTotal = (damaged: { unitId: string; amount: number; rebounded?: boolean }[]): number =>
    damaged.reduce((sum, entry) => sum + (entry.rebounded ? 0 : entry.amount), 0);

export class GameActionEngine {
    private readonly context: IGameActionEngineContext;
    private readonly turnEngine: TurnEngine;
    private readonly headlessEvents: boolean;
    /**
     * Built on first use and then kept: PathHelper owns nothing but the grid settings, and this engine's
     * Grid never swaps them, so one instance answers every footprint question for the whole fight.
     */
    private footprintRules?: PathHelper;
    public constructor(context: IGameActionEngineContext) {
        this.context = context;
        this.turnEngine = new TurnEngine(context);
        this.headlessEvents = context.eventMode === "headless";
    }
    /**
     * The shape rules live in PathHelper, beside the pather that produces the anchors and the pre-fight
     * preview that draws them. The engine asking the same object is what keeps "the board offered me this
     * block" and "the engine accepted this block" from ever being two different rules.
     */
    private getFootprintRules(): PathHelper {
        if (!this.footprintRules) {
            this.footprintRules = new PathHelper(this.context.grid.getSettings());
        }

        return this.footprintRules;
    }
    public apply(action: GameAction): IGameActionResult {
        // Fight actions run under an effect-application capture: everything the action lands on any
        // unit through applyBuff/applyDebuff/applyEffect — targeted casts, mass casts, on-hit riders —
        // is drained into ONE `effects_applied` event, spliced in BEFORE the trailing turn-handoff
        // events so log builders render the effects under the acting unit's turn, not the next one's.
        // defend_turn is deliberately NOT captured: its Luck Shield buff is already reported by the
        // unit_defended event ("uses Luck Shield"), and a second "gains Luck Shield" line is noise.
        if (this.headlessEvents || !EFFECT_CAPTURED_ACTION_TYPES.has(action.type)) {
            return this.compactResult(this.applyInner(action));
        }
        beginEffectApplicationCapture();
        let result: IGameActionResult;
        try {
            result = this.applyInner(action);
        } finally {
            // Always drained (even on a throw) so a failed action can never leak captured records into
            // the next action's event.
            const applications = endEffectApplicationCapture();
            if (typeof result! !== "undefined" && result.completed && applications.length) {
                const effectsEvent: GameEvent = { type: "effects_applied", applications };
                const handoffIndex = result.events.findIndex(
                    (event) => event.type === "turn_completed" || event.type === "next_unit_selected",
                );
                if (handoffIndex >= 0) {
                    result.events.splice(handoffIndex, 0, effectsEvent);
                } else {
                    result.events.push(effectsEvent);
                }
            }
            // Water Shield absorbs ride the action's damage payload as `secondary` entries (the
            // fire_shield/flesh_shield pattern): the absorb is decided deep in Unit.applyDamage where no
            // handler sees it, yet ranked's log — rebuilt from events, never engine text — must say the
            // shield broke and under whose blow (the event's attacker/caster names the striker).
            const waterShieldAbsorbs = endWaterShieldAbsorbCapture();
            if (typeof result! !== "undefined" && result.completed && waterShieldAbsorbs.length) {
                const attackEvent = result.events.find(
                    (event): event is Extract<GameEvent, { type: "unit_attacked" | "area_attacked" }> =>
                        event.type === "unit_attacked" || event.type === "area_attacked",
                );
                const spellEvent = attackEvent
                    ? undefined
                    : result.events.find(
                          (
                              event,
                          ): event is Extract<GameEvent, { type: "spell_cast" }> & {
                              secondary?: ISecondaryDamage[];
                          } => event.type === "spell_cast",
                      );
                for (const absorb of waterShieldAbsorbs) {
                    const owner = this.context.unitsHolder.getAllUnits().get(absorb.unitId);
                    const entry: ISecondaryDamage = {
                        source: "water_shield",
                        unitId: absorb.unitId,
                        position: owner?.getPosition() ?? { x: 0, y: 0 },
                        amount: absorb.amount,
                        unitsDied: 0,
                    };
                    if (attackEvent) {
                        (attackEvent.damage.secondary ??= []).push(entry);
                    } else if (spellEvent) {
                        (spellEvent.secondary ??= []).push(entry);
                    }
                }
            }
        }
        return this.compactResult(result);
    }
    private compactResult(result: IGameActionResult): IGameActionResult {
        return this.headlessEvents ? { ...result, events: result.events.filter(isHeadlessSimulationEvent) } : result;
    }
    private applyInner(action: GameAction): IGameActionResult {
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
            case "request_additional_time":
                return this.requestAdditionalTime(action.team);
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

        // Record each unit's starting cell so the fight log preserves the initial deployment.
        for (const unit of this.context.unitsHolder.getAllUnits().values()) {
            if (unit.isDead()) {
                continue;
            }
            const cell = unit.getBaseCell();
            this.context.sceneLog.updateLog(`${unit.getName()} spawned at (${cell.x}, ${cell.y})`);
        }

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
        // A "manual" end-of-turn after the unit MOVED is NOT a skip and must not incur the
        // MORALE_CHANGE_FOR_SKIP penalty — otherwise a move that ends the turn through this path silently
        // loses morale (moving toward the enemy netted -1 instead of +3). A genuine skip — the player
        // pressing Next without acting ("skip"), a forced effect, or a turn timeout — DOES drop morale,
        // mirroring the legacy (test_heroes.ts) skip penalty.
        const isForcedSkip = reason === "timeout" || reason === "effect" || reason === "skip";
        // Reaching end_turn means the unit didn't attack/cast (those complete the turn directly), so if it
        // also didn't move it did nothing this turn — treat that as a skip even for a "manual" end, e.g.
        // an AI-driven unit that ended without acting. So it reads as "<unit> skips turn" and is scored
        // like any other skip.
        const didNothing = !unit.hasMovedThisTurn();
        const isSkip = isForcedSkip || didNothing;
        const skipReason: TurnSkipReason | undefined = isForcedSkip ? reason : didNothing ? "skip" : undefined;
        const events = this.turnEngine.completeTurn(unit, {
            skipReason,
            skipLogMessage: isSkip ? `${unit.getName()} skips turn` : undefined,
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
            MORALE_CHANGE_FOR_CLOCK,
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

        unit.applyLuckShield();
        unit.decreaseMorale(
            MORALE_CHANGE_FOR_SHIELD,
            this.context.fightProperties.getAdditionalMoralePerTeam(unit.getTeam()),
        );
        this.context.sceneLog.updateLog(
            `${unit.getName()} uses Luck Shield (luck +${LUCK_CHANGE_FOR_SHIELD}, morale -${MORALE_CHANGE_FOR_SHIELD})`,
        );

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
    /**
     * Extend the acting team's running turn clock (once per lap per team). Only valid while a unit of
     * that team is the active unit — otherwise a team could pad the opponent's clock. Rejects if the
     * team already used its request this lap or there's no remaining budget (both surface as
     * requestAdditionalTurnTime() returning 0). Produces no game events — the extension lives entirely
     * in fightProperties.currentTurnEnd, which the snapshot re-broadcasts.
     */
    private requestAdditionalTime(team: TeamType): IGameActionResult {
        const activeUnitId = this.context.getCurrentActiveUnitId?.();
        const activeUnit = activeUnitId ? this.context.unitsHolder.getAllUnits().get(activeUnitId) : undefined;
        if (!activeUnit || activeUnit.getTeam() !== team) {
            return this.reject("additional_time_not_available");
        }
        const additionalTime = this.context.fightProperties.requestAdditionalTurnTime(team);
        if (additionalTime <= 0) {
            return this.reject("additional_time_not_available");
        }
        this.context.sceneLog.updateLog(`Team requested additional turn time (+${Math.round(additionalTime)}ms)`);
        return { completed: true, events: [] };
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
        // The mover's real shape, not a size bit. Reading a 1x2 as "not small" hands it a 2x2 body and
        // occupies two cells nothing ever checked; 1x1 and 2x2 are the W === H instances of the same rule,
        // so both shipped shapes resolve to exactly the block they always did.
        const footprintWidth = unit.getFootprintWidth();
        const footprintHeight = unit.getFootprintHeight();
        const targetCells = resolveMoveTargetCells(
            unit.isSmallSize(),
            action.path,
            action.targetCells,
            footprintWidth,
            footprintHeight,
        );
        // A move declares where the BODY lands, so the cells it names have to be that body: W*H distinct
        // on-board cells tiling the mover's own rectangle. Placement and split have always been held to this
        // (isValidPlacementFootprint); movement never was, because with only squares on the board the
        // supplied set could not name a different legal shape. It can now — a 1x2 and a 2x1 have the same
        // cell COUNT — and a mover whose registration is a different rectangle from its position is an
        // occupancy desync no later move repairs. Every legitimate move already satisfies this: the two
        // shipped shapes tile their own square, and the fallback below builds the set from the route itself.
        if (!this.isValidPlacementFootprint(unit, targetCells)) {
            return this.reject("invalid_move");
        }
        const pathIsFootprintOnly = isMovePathFootprintOnly(
            unit.isSmallSize(),
            action.path,
            action.targetCells,
            footprintWidth,
            footprintHeight,
        );
        const knownMoveRoute = this.resolveKnownMoveRoute(unit, action.path, targetCells, pathIsFootprintOnly);
        if (knownMoveRoute instanceof Error) {
            return this.reject("invalid_move");
        }
        const travelledPath = pathIsFootprintOnly
            ? action.path
            : travelledMovePath(unit.getBaseCell(), knownMoveRoute?.route ?? action.path);
        // The cell COUNT is a cheap sanity bound on the walk (real reachability is enforced by knownPaths
        // above). It assumed a cell costs at least one step — no longer true: a vine strider (Trent, "In Its
        // Own World") pays half a step per vined cell, so the same budget legitimately covers twice as many
        // cells. Bound by the cheapest cell THIS unit could pay for, or a legal vine walk is rejected as
        // invalid_move — which is exactly what "the range shows further but I cannot step there" looked like.
        const cheapestCellCost =
            unit.hasAbilityActive("In Its Own World") && this.context.fightProperties.getVines().size() > 0
                ? VINE_STRIDE_COST_MULTIPLIER
                : 1;
        const maxTravelledCells = Math.max(1, Math.ceil(unit.getSteps() / cheapestCellCost));
        if (
            !pathIsFootprintOnly &&
            (!travelledPath.length ||
                travelledPath.length > maxTravelledCells ||
                !this.isContinuousMovePath(unit, travelledPath))
        ) {
            return this.reject("invalid_move");
        }

        if (!(
            this.context.grid.areAllCellsEmpty(targetCells, unit.getId()) ||
            this.context.grid.canOccupyCells(
                targetCells,
                unit.canTraverseLava(),
                unit.hasAbilityActive("Made of Water"),
                unit.getId(),
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
        // A missing newPosition is the ONLY way a refused occupancy stamp reaches this side: the stamp is
        // made inside finishDirectedUnitMove, which owns it. Re-deriving the verdict here from the grid's
        // registration would be worse than useless — it cannot tell a genuine refusal apart from a caller
        // that registered the unit by hand on fewer cells than its body covers.
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

        // Vine Throw: standing in the enemy's vine is the same snare the throw itself applies. Charged on
        // ARRIVAL, not on crossing — the movement penalty already prices passing through, and this is the
        // price of ending up in it. Flyers are not spared here: they clear a vine they fly OVER, but one
        // they choose to land in grips them like anything else.
        //
        // Own-team vines never snare. Trent walks his own vines at half price, and a vine that also
        // punished his own side would fight the passive it exists to serve.
        const vinesOnBoard = this.context.fightProperties.getVines();
        if (vinesOnBoard.size() && !unit.hasDebuffActive("Vine Throw")) {
            const snaringCell = targetCells.find((cell) => vinesOnBoard.snares(cell, unit.getTeam()));
            if (snaringCell) {
                unit.applyDebuff(
                    new Spell({
                        // Same lifetime the throw itself grants: read straight off the spell config so the
                        // two can never drift apart.
                        spellProperties: getSpellConfig("System", "Vine Throw"),
                        amount: 1,
                    }),
                );
                this.context.sceneLog.updateLog(`${unit.getName()} is snared by the vine`);
            }
        }

        // Mark that the unit moved this turn so a later end_turn reads as a real "manual" finish (it
        // acted) rather than a do-nothing skip.
        unit.setMovedThisTurn(true);
        unit.setMovedRouteCellsThisTurn(pathIsFootprintOnly ? 1 : (knownMoveRoute?.route.length ?? action.path.length));

        const events: GameEvent[] = [];
        if (!this.headlessEvents) {
            events.push({
                type: "unit_moved",
                unitId: unit.getId(),
                from,
                to: { ...result.newPosition },
                path: structuredClone(action.path),
                targetCells: structuredClone(targetCells),
            });
        }
        if (!this.headlessEvents && result.dispelledSmokeCells?.length) {
            events.push({ type: "smoke_dispel", cells: result.dispelledSmokeCells });
        }
        // Fire Wall: sear the mover for every burning cell the walk entered. A footprint-only large-unit
        // move has no ordered step route, so its final footprint stands in for the cells it crossed.
        events.push(...this.applyFireWallBurn(unit, pathIsFootprintOnly ? targetCells : travelledPath));
        return { completed: true, events };
    }
    /**
     * Fire Wall: burn a unit once for every burning cell its move entered.
     *
     * Runs AFTER the move has resolved, so a stack that dies in the flames is cleaned up on the same action
     * instead of lingering as a corpse until its next turn. The starting cell is never counted — a unit that
     * began its turn standing in the fire is not charged for staying put (getTravelledMovePath already drops
     * it), only for cells it walks INTO.
     *
     * Damage is re-derived per cell rather than multiplied out, because a stack thinned by the first cell has
     * a smaller maximum health for the second to take its share of.
     */
    private applyFireWallBurn(unit: Unit, crossedCells: XY[]): GameEvent[] {
        const position = this.headlessEvents ? undefined : { ...unit.getPosition() };
        const { burning, total, unitsDied } = burnUnitOnFireWallCells(
            unit,
            crossedCells,
            this.context.fightProperties.getFireWalls(),
            this.context.sceneLog,
        );
        if (total <= 0) {
            return [];
        }

        const events: GameEvent[] = [];
        if (!this.headlessEvents) {
            events.push({
                type: "fire_wall_burned",
                unitId: unit.getId(),
                cells: burning,
                position: position!,
                amount: total,
                unitsDied,
            });
        }
        if (unit.isDead()) {
            events.push(...this.cleanupDeadUnits([unit.getId()]));
        }
        return events;
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
        const killAttributions = this.createDirectKillAttributions(unitIdsDied, [
            { victim: target, killer: attacker },
            { victim: attacker, killer: target },
        ]);
        const events: GameEvent[] = [];
        if (!this.headlessEvents) {
            events.push({
                type: "unit_attacked",
                attackType: "melee",
                attackerId: attacker.getId(),
                targetId: target.getId(),
                unitIdsDied,
                damage: this.cloneVisibleDamage(damage),
                animations: this.serializeAnimations(result.animationData ?? []),
            });
        }
        events.push(...this.createAbilityStolenEvents(result.abilityStolen));
        events.push(...this.cleanupDeadUnits(unitIdsDied, killAttributions));
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
        // A unit standing in an enemy's Range Null Field (or carrying Rangebane) cannot fire — the
        // ability/aura exists precisely to forbid this. The handler otherwise never re-checks the
        // attacker's range eligibility, so without this an AI (or a tampered client) can shoot through
        // the field and the shot animation plays. canLandRangeAttack enforces the same names.
        if (attacker.hasDebuffActive("Range Null Field Aura") || attacker.hasStatusApplied("Rangebane")) {
            return this.reject("attack_not_available");
        }

        // The shot travels from the attacker's center to the CENTER OF THE SELECTED VISIBLE EDGE of
        // the target, never to the target's center. The edge is reconstructed authoritatively here
        // from the client's bounded intent (aimCell + aimSide); malformed/occluded aim is clamped to
        // a legal edge, so the server geometry can never be compromised. No visible edge at all means
        // the target is fully screened by its own side and there is nothing legal to aim at — reject
        // rather than aim at its center.
        const toPosition = this.resolveRangeTargetPosition(attacker, target, action.aimCell, action.aimSide);
        if (!toPosition) {
            return this.reject("attack_not_available");
        }

        let evalResult = this.context.attackHandler.evaluateRangeAttack(
            this.context.unitsHolder.getAllUnits(),
            attacker,
            attacker.getPosition(),
            toPosition,
            attacker.hasAbilityActive("Through Shot"),
            false,
            attacker.hasAbilityActive("Large Caliber") || attacker.hasAbilityActive("Area Throw"),
        );
        const destroyedScatteredCells: XY[] = [];
        const doubleShot = AbilityHelper.getDoubleShotAbility(attacker);
        // "Ranged attacks ignore structures" (Large Caliber, Area Throw) outranks the Double Shot stone rule.
        // Gargantuan carries BOTH, and without this the stone branch ran first and spent its two projectiles
        // on tombstones, so a Cemetery lane with two stones left the declared creature untouched — the
        // ability read as doing nothing at all. Cyclops never showed it: Large Caliber comes without Double
        // Shot, so it always took the ignore-structures path below.
        const ignoresStructures = attacker.hasAbilityActive("Large Caliber") || attacker.hasAbilityActive("Area Throw");
        const doubleShotObstacleIntersections =
            this.context.grid.hasScatteredMountains() && doubleShot && !ignoresStructures
                ? this.context.attackHandler.getObstacleIntersections(attacker.getPosition(), toPosition).slice(0, 2)
                : [];
        const interceptedForDoubleShot = doubleShotObstacleIntersections.length > 0;
        if (interceptedForDoubleShot) {
            if (
                !this.context.attackHandler.canLandRangeAttack(
                    attacker,
                    this.context.grid.getEnemyAggrMatrixByUnitId(attacker.getId()),
                )
            ) {
                return this.reject("attack_not_available");
            }
            for (const obstacle of doubleShotObstacleIntersections) {
                const obstacleCell = getCellForPosition(this.context.grid.getSettings(), obstacle.position);
                if (obstacleCell && this.context.grid.clearScatteredMountainAt(obstacleCell.x, obstacleCell.y)) {
                    destroyedScatteredCells.push(obstacleCell);
                }
            }
            if (destroyedScatteredCells.length >= 2) {
                // Both projectiles were consumed by the first two stones. The declared creature remains
                // untouched, and a third stone (if present) continues to block the lane.
                attacker.decreaseNumberOfShots();
                this.context.unitsHolder.refreshStackPowerForAllUnits();
                const events: GameEvent[] = [
                    ...this.scatteredObstacleDestroyedEvents(attacker, destroyedScatteredCells),
                    ...this.turnEngine.completeTurn(attacker),
                ];
                return { completed: true, events };
            }
            // Exactly one blocker: projectile one removes it; projectile two continues to the creature.
            evalResult = this.context.attackHandler.evaluateRangeAttack(
                this.context.unitsHolder.getAllUnits(),
                attacker,
                attacker.getPosition(),
                toPosition,
                attacker.hasAbilityActive("Through Shot"),
                false,
                attacker.hasAbilityActive("Large Caliber") || attacker.hasAbilityActive("Area Throw"),
            );
        }
        if (this.context.grid.hasScatteredMountains() && ignoresStructures) {
            destroyedScatteredCells.push(
                ...this.context.grid.clearScatteredMountainsInCells(evalResult.affectedCells.flat()),
            );
        }
        // `target` is the declared aim anchor used to reconstruct the trajectory. Special shots may legally
        // aim at a rear stack while the authoritative first intersection is a different front stack. Response
        // ownership must follow that actual primary, exactly as damage does; using the aim anchor can suppress
        // a legal retaliation or attribute its kill to a unit that was never hit.
        const primaryRangeTarget = evalResult.affectedUnits[0]?.[0];
        let responseDivisor = 1;
        let responseUnits: Unit[] | undefined = undefined;
        if (
            primaryRangeTarget &&
            // isRangeCapable, not attack_type === RANGE: a melee unit holding a stolen Endless Quiver
            // counter-shoots like any other shooter.
            primaryRangeTarget.isRangeCapable() &&
            primaryRangeTarget.getRangeShots() > 0 &&
            !primaryRangeTarget.hasDebuffActive("Range Null Field Aura") &&
            !primaryRangeTarget.hasStatusApplied("Rangebane") &&
            !this.context.attackHandler.canBeAttackedByMelee(
                primaryRangeTarget.getPosition(),
                primaryRangeTarget,
                this.context.grid.getEnemyAggrMatrixByUnitId(primaryRangeTarget.getId()),
            )
        ) {
            const responseEval = this.context.attackHandler.evaluateRangeAttack(
                this.context.unitsHolder.getAllUnits(),
                primaryRangeTarget,
                primaryRangeTarget.getPosition(),
                attacker.getPosition(),
                primaryRangeTarget.hasAbilityActive("Through Shot"),
                false,
                primaryRangeTarget.hasAbilityActive("Large Caliber") ||
                    primaryRangeTarget.hasAbilityActive("Area Throw"),
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
            toPosition,
            false,
            true,
            interceptedForDoubleShot,
        );
        if (!result.completed) {
            return this.reject("attack_not_available");
        }

        const unitIdsDied = [...new Set(result.unitIdsDied)];
        const responseTarget = responseUnits?.[0];
        const killAttributions = this.createDirectKillAttributions(unitIdsDied, [
            ...(primaryRangeTarget ? [{ victim: primaryRangeTarget, killer: attacker }] : []),
            ...(responseTarget && primaryRangeTarget ? [{ victim: responseTarget, killer: primaryRangeTarget }] : []),
        ]);
        const events: GameEvent[] = [];
        if (!this.headlessEvents) {
            events.push(...this.scatteredObstacleDestroyedEvents(attacker, destroyedScatteredCells));
            events.push({
                type: "unit_attacked",
                attackType: "range",
                attackerId: attacker.getId(),
                targetId: target.getId(),
                unitIdsDied,
                damage: this.cloneVisibleDamage(damage),
                animations: this.serializeAnimations(result.animationData ?? []),
            });
        }
        events.push(...this.createAbilityStolenEvents(result.abilityStolen));
        events.push(...this.cleanupDeadUnits(unitIdsDied, killAttributions));
        events.push(...this.turnEngine.completeTurn(attacker));
        return { completed: true, events };
    }
    /**
     * Authoritative resolution of the ranged-shot trajectory endpoint. The client only ever sends
     * bounded intent (aimCell + aimSide) — this never trusts a raw position, so a tampered client
     * cannot bend the trajectory or inflate the distance-based damage divisor. The result is ALWAYS
     * the center of a real visible edge of the target's own footprint; malformed/occluded intent is
     * deterministically clamped (not honored), so the worst a compromised client can do is pick a
     * legal edge a normal player could have aimed at:
     *   - aimCell is used only when it is one of the target's own cells; otherwise the target cell
     *     nearest the attacker is used.
     *   - aimSide is honored only when it is a genuinely observable (non-occluded) side of that cell;
     *     otherwise the observable side nearest the attacker is used.
     * If the unit is fully hidden (no observable side) it falls back to the target center — the
     * trajectory still hits whatever occluder stands in front first.
     */
    /**
     * The visible-edge center this shot lands on, or undefined when the target presents NO visible edge.
     *
     * Undefined means the shot is ILLEGAL, not "aim somewhere else": a shot always flies to the center of a
     * visible edge, so a unit boxed in on every side by its own allies and/or BLOCK obstacles has no legal
     * aim point. This used to return target.getPosition() instead, which let a fully-screened unit be shot
     * straight through the middle — the one case where the trajectory ignored the cover around it.
     */
    private resolveRangeTargetPosition(attacker: Unit, target: Unit, aimCell?: XY, aimSide?: number): XY | undefined {
        return resolveRangeAttackAimEdge(
            this.context.grid.getMatrix(),
            this.context.grid.getSettings(),
            target.getCells(),
            attacker.getPosition(),
            attacker.getTeam(),
            attacker.hasAbilityActive("Through Shot"),
            aimCell,
            aimSide,
        )?.position;
    }
    private obstacleAttack(action: Extract<GameAction, { type: "obstacle_attack" }>): IGameActionResult {
        const attacker = this.validateTurnAction(action.attackerId);
        if (attacker instanceof Error) {
            return this.reject(attacker.message as GameActionRejectionReason);
        }
        if (!this.context.attackHandler) {
            return this.reject("attack_handler_missing");
        }
        // A scattered layout has no hit-point counters: what is left to hit is simply what still stands.
        const scattered = this.context.grid.hasScatteredMountains();
        const standingCellsBefore = scattered ? this.context.grid.getScatteredMountainsStanding() : [];
        const standingBefore = standingCellsBefore.length;
        if (
            this.context.grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            this.context.fightProperties.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            (scattered ? standingBefore <= 0 : this.context.fightProperties.getObstacleHitsLeft() <= 0)
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
        const standingAfter = scattered ? this.context.grid.getScatteredMountainsStanding().length : 0;
        // "Did the attack achieve anything?" — for scattered stones that is one fewer standing, not one
        // fewer hit point, because their counters never move.
        const landed = scattered ? standingAfter < standingBefore : hitsAfter < hitsBefore;
        if (!result.completed || !landed) {
            return this.reject("attack_not_available");
        }

        this.context.unitsHolder.refreshStackPowerForAllUnits();
        const standingCellsAfter = scattered ? this.context.grid.getScatteredMountainsStanding() : [];
        const removedCellCandidates = scattered
            ? standingCellsBefore.filter(
                  (before) => !standingCellsAfter.some((after) => after.x === before.x && after.y === before.y),
              )
            : [];
        // Preserve the actual projectile order, not the random layout-array order. Double Shot can clear two
        // aligned tombstones in one action; replay must emit the nearer impact first so clients can animate
        // shot one -> stone one, then shot two -> stone two. Any non-trajectory removals fall back to stable
        // layout order after the ordered impacts.
        const removedByKey = new Map(removedCellCandidates.map((cell) => [`${cell.x}:${cell.y}`, cell]));
        const removedCells: XY[] = [];
        for (const animation of result.animationData ?? []) {
            const cell = getCellForPosition(this.context.grid.getSettings(), animation.toPosition);
            const key = `${cell.x}:${cell.y}`;
            const removed = removedByKey.get(key);
            if (!removed) {
                continue;
            }
            removedCells.push(removed);
            removedByKey.delete(key);
        }
        removedCells.push(...removedByKey.values());
        const serializedAnimations = this.serializeAnimations(result.animationData ?? []);
        const events: GameEvent[] = [];
        if (!this.headlessEvents) {
            if (scattered) {
                events.push(
                    ...this.scatteredObstacleDestroyedEvents(attacker, removedCells).map((event, index) => ({
                        ...event,
                        attackFrom: action.attackFrom ? { ...action.attackFrom } : undefined,
                        animations: serializedAnimations[index] ? [serializedAnimations[index]] : [],
                    })),
                );
            } else {
                events.push({
                    type: "obstacle_attacked",
                    attackerId: attacker.getId(),
                    targetPosition: { ...action.targetPosition },
                    attackFrom: action.attackFrom ? { ...action.attackFrom } : undefined,
                    hitsBefore,
                    hitsAfter,
                    hitsAfterLeft: this.context.fightProperties.getObstacleHitsLeftLeft(),
                    hitsAfterRight: this.context.fightProperties.getObstacleHitsLeftRight(),
                    animations: serializedAnimations,
                });
            }
        }
        // Destroy whichever 2x2 mountain just ran out of hits (each is independent). clearMountainSide is
        // idempotent, so checking both after every obstacle attack is safe and cheap.
        let clearedMountain = false;
        if (scattered) {
            // The stone was removed from the board by the hit itself; this only reports it.
            clearedMountain = standingAfter < standingBefore;
        } else {
            if (
                this.context.fightProperties.getObstacleHitsLeftLeft() <= 0 &&
                this.context.grid.clearMountainSide(false)
            ) {
                clearedMountain = true;
            }
            if (
                this.context.fightProperties.getObstacleHitsLeftRight() <= 0 &&
                this.context.grid.clearMountainSide(true)
            ) {
                clearedMountain = true;
            }
        }
        if (!this.headlessEvents && clearedMountain) {
            events.push({ type: "center_obstacle_cleared", gridType: this.context.fightProperties.getGridType() });
        }
        events.push(...this.turnEngine.completeTurn(attacker));
        return { completed: true, events };
    }
    private scatteredObstacleDestroyedEvents(attacker: Unit, cells: readonly XY[]): GameEvent[] {
        if (!cells.length) {
            return [];
        }
        const fightProperties = this.context.fightProperties;
        const hits = fightProperties.getObstacleHitsLeft();
        const settings = this.context.grid.getSettings();
        return cells.map((cell) => ({
            type: "obstacle_attacked" as const,
            attackerId: attacker.getId(),
            targetPosition: getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
            hitsBefore: hits,
            hitsAfter: hits,
            hitsAfterLeft: fightProperties.getObstacleHitsLeftLeft(),
            hitsAfterRight: fightProperties.getObstacleHitsLeftRight(),
            animations: [],
        }));
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
        if (
            occupantId &&
            occupantId !== "L" &&
            occupantId !== "W" &&
            !(occupantId === "B" && this.context.grid.hasScatteredMountains())
        ) {
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
        const destroyedScatteredCells = this.context.grid.hasScatteredMountains()
            ? this.context.grid.clearScatteredMountainsInCells(affectedCells)
            : [];
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
        // Area Throw has no retaliation path: every enemy in its resolved affected set is directly damaged
        // by the acting thrower. Friendly/self deaths are intentionally not attributed.
        const areaVictims = (affectedUnits ?? [])
            .flat()
            .filter((unit) => unit.getTeam() !== attacker.getTeam())
            .map((victim) => ({ victim, killer: attacker }));
        const killAttributions = this.createDirectKillAttributions(unitIdsDied, areaVictims);
        const events: GameEvent[] = [];
        if (!this.headlessEvents) {
            events.push(...this.scatteredObstacleDestroyedEvents(attacker, destroyedScatteredCells));
            events.push({
                type: "area_attacked",
                attackType: "area_throw",
                attackerId: attacker.getId(),
                targetCell: { ...targetCell },
                targetPosition,
                affectedUnitIds,
                unitIdsDied,
                damage: this.cloneVisibleDamage(damage),
                animations: this.serializeAnimations(result.animationData ?? []),
            });
        }
        events.push(...this.createAbilityStolenEvents(result.abilityStolen));
        events.push(...this.cleanupDeadUnits(unitIdsDied, killAttributions));
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
        const targetedSpellLineIsClear =
            !target ||
            SpellHelper.isTargetedSpellLineOfSightClear(
                spell.getName(),
                this.context.grid,
                (cell) => isCellWithinGrid(this.context.grid.getSettings(), cell),
                caster.getBaseCell(),
                target.getBaseCell(),
                // Only Fire Strike arcs over the caster's own troops. Every other thrown spell is blocked by
                // ANY body, and each re-checks that strictly in its own handler — scoping the transparency
                // here keeps this gate from quietly becoming the more permissive of the two.
                spell.getName() === "Fire Strike" ? (unitId) => this.isAllyOfCaster(caster, unitId) : undefined,
                // The whole footprint, so a large target boxed in on one corner is still reachable by the
                // open edge of another of its cells.
                target.getCells(),
            );
        // Every unit-targeted spell must pass the same authoritative gate before dispatch. Most spells flow
        // through AttackHandler.handleMagicAttack, which rejects Hidden enemies and calls canCastSpell; the
        // custom handlers below bypass that path, so validating here prevents them from targeting an invisible
        // enemy, the wrong team, a forced-target violation, an immune unit, or any other illegal recipient.
        if (
            target &&
            ((target.getTeam() !== caster.getTeam() && target.hasBuffActive("Hidden")) ||
                !targetedSpellLineIsClear ||
                !SpellHelper.canCastSpell(
                    false,
                    this.context.grid.getSettings(),
                    this.context.grid.getMatrix(),
                    caster,
                    target,
                    spell,
                    target.getBaseCell(),
                    target.getMagicResist(),
                    target.hasMindAttackResistance(),
                    target.canBeHealed(),
                    this.context.getCurrentEnemiesCellsWithinMovementRange?.(),
                ))
        ) {
            return this.reject("spell_not_available");
        }
        if (!target && this.isSummonSpell(spell)) {
            return this.summonSpell(action, caster, spell);
        }
        if (!target && this.isMassSpell(spell)) {
            return this.massCastSpell(action, caster, spell);
        }
        if (!target && spell.getSpellTargetType() === SpellTargetType.ALLIES_AREA) {
            return this.craftCast(action, caster, spell);
        }
        // Smoke spell: a cell-targeted cloud cast anywhere on the field (no range gate — it throws freely).
        if (!target && spell.getName() === "Smoke") {
            return this.smokeCast(action, caster, spell);
        }
        // Fire Wall: a cell-targeted 3-cell line, laid anywhere on the field in one of four orientations.
        if (!target && spell.getName() === "Fire Wall") {
            return this.fireWallCast(action, caster, spell);
        }
        if (target && (spell.getName() === "Armor Rune" || spell.getName() === "Weapon Rune")) {
            return this.enchantCast(caster, target, spell);
        }
        // Vine Throw: a targeted enemy cast that also paints the cells it crossed on the way there.
        if (target && spell.getName() === "Vine Throw") {
            return this.vineThrowCast(caster, target, spell);
        }
        // Battle Mage's Fire Strike: a fireball at one enemy in line of sight.
        if (target && spell.getName() === "Fire Strike") {
            return this.fireStrikeCast(caster, target, spell);
        }
        // Battle Mage's Meteorite: a 2x2 impact aimed at a cell rather than a unit (no range gate).
        if (!target && spell.getName() === "Meteorite") {
            return this.meteoriteCast(action, caster, spell);
        }
        // Magic Dragon's Lightning Strike: a bolt at one enemy anywhere, with no line of sight to keep.
        if (target && spell.getName() === "Lightning Strike") {
            return this.lightningStrikeCast(caster, target, spell);
        }
        // Magic Dragon's Ring of Fire: a burst around one enemy, splashing every unit that touches it.
        if (target && spell.getName() === "Ring of Fire") {
            return this.ringOfFireCast(caster, target, spell);
        }
        // Magic Dragon's Meteor Shower: a 3x3 impact aimed at a cell rather than a unit (no range gate).
        if (!target && spell.getName() === "Meteor Shower") {
            return this.meteorShowerCast(action, caster, spell);
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
        const killAttributions = this.createDirectKillAttributions(
            unitIdsDied,
            target && target.getTeam() !== caster.getTeam() ? [{ victim: target, killer: caster }] : [],
        );
        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetId: target?.getId(),
                targetCell: target?.getBaseCell(),
                unitIdsDied,
                animations: this.serializeAnimations(result.animationData ?? []),
                healed: result.healed?.length ? result.healed : undefined,
                resurrected: result.resurrected?.length ? result.resurrected : undefined,
                abilityTransfers: result.abilityTransfers?.length ? result.abilityTransfers : undefined,
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied, killAttributions));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Blacksmith's Craft: a 2x2 area cast on allies. The clicked cell is the bottom-left of the block; every
     * ally occupying one of the four cells rolls an independent crafting outcome (see processCraftAbility).
     */
    private craftCast(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        if (!action.targetCell) {
            return this.reject("spell_not_available");
        }
        const c = action.targetCell;
        const cells: XY[] = [c, { x: c.x + 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x + 1, y: c.y + 1 }];
        const affected = evaluateAffectedUnits(cells, this.context.unitsHolder, this.context.grid)?.[0] ?? [];
        const allies = affected.filter((u) => u.getTeam() === caster.getTeam());
        const crafted = processCraftAbility(caster, allies, this.context.sceneLog);
        caster.useSpell(spell.getName());
        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: c,
                unitIdsDied: [],
                animations: [],
                // The rolls, so the client can SHOW them instead of re-rolling its own. "nothing" is the
                // outcome that matters most here: it changes no state, so it is invisible to a snapshot diff
                // and was simply unshowable in ranked before this.
                outcomes: crafted.map((r) => ({
                    unitId: r.unitId,
                    outcome: r.outcome,
                    ...(r.grantedAbility ? { grantedAbility: r.grantedAbility } : {}),
                })),
            },
        ];
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Smoke spell (Wandering Mage / Book of Chaos): throws a 2x2 smoke cloud onto FREE cells anywhere on the
     * battlefield. Only empty cells of the 2x2 block become smoked — cells already occupied by a creature (or
     * off-grid) are skipped, so the cloud shapes around whatever is standing in it. Ranged attacks crossing a
     * smoked cell have their damage halved (divisor x2); a creature stepping on a smoked cell dispels it; the
     * cloud lasts `spell.getLapsTotal()` laps. One cast = one charge.
     */
    private smokeCast(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        if (!action.targetCell) {
            return this.reject("spell_not_available");
        }
        const c = action.targetCell;
        const cells: XY[] = [c, { x: c.x + 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x + 1, y: c.y + 1 }];
        // The WHOLE 2x2 must be placeable — a partial cast is rejected outright rather than quietly
        // smoking two of four cells, so what the aim preview highlights is exactly what lands. Blocked by
        // the mountain, a narrowed-away cell, a creature, or the edge of the board; lava and water are
        // fine (smoking the lava lane is an intended play). See isSmokeableCell, shared with the client.
        const settings = this.context.grid.getSettings();
        const allPlaceable = cells.every((cell) =>
            isSmokeableCell(this.context.grid, isCellWithinGrid(settings, cell), cell),
        );
        if (!allPlaceable) {
            return this.reject("spell_not_available");
        }
        // "Lasts 3 laps" means three FULL laps (owner call 2026-08-02): a cast always lands mid-lap, and
        // the lap-flip decrement would otherwise charge that partial cast lap as the first of the three
        // (live report: smoke faded a lap early). One extra charge absorbs the partial lap; the wire
        // format (lapsRemaining) is unchanged.
        const laps = spell.getLapsTotal() + 1;
        const placed: XY[] = [];
        for (const cell of cells) {
            this.context.fightProperties.getSmokeClouds().add(cell, laps);
            placed.push({ x: cell.x, y: cell.y });
        }
        caster.useSpell(spell.getName());
        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: c,
                unitIdsDied: [],
                animations: [],
            },
        ];
        if (placed.length > 0) {
            // The event reports the NOMINAL duration (what the card promises, in full laps); the store
            // carries one extra charge to absorb the partial cast lap — an internal accounting detail.
            events.push({
                type: "smoke_placed",
                casterId: caster.getId(),
                cells: placed,
                lapsRemaining: spell.getLapsTotal(),
            });
        }
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Fire Wall (Nightmare / Book of Nightmares): lays a burning wall across 3 cells in a straight line,
     * anywhere on the battlefield, in whichever of the four orientations the player rotated the aim to.
     *
     * All-or-nothing like Smoke: the WHOLE line must be placeable or the cast is refused outright, so the
     * three cells the aim preview highlighted are exactly the three that light up. Lava and water are
     * ground the flames sit over; the mountain, a narrowed-away cell, a creature or the board edge are not.
     *
     * Two effects, both lasting `spell.getLapsTotal()` laps: entering a burning cell costs one extra step
     * (see FIRE_WALL_CROSS_PENALTY in path_helper) and sears the crossing stack for a share of its maximum
     * health (see applyFireWallBurn on the move path). Neither spares flyers. One cast = one charge.
     */
    private fireWallCast(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        if (!action.targetCell) {
            return this.reject("spell_not_available");
        }
        const orientation = normalizeFireWallOrientation(action.targetOrientation);
        const cells = fireWallCells(action.targetCell, orientation);
        const settings = this.context.grid.getSettings();
        const allPlaceable = cells.every((cell) =>
            isFireWallableCell(this.context.grid, isCellWithinGrid(settings, cell), cell),
        );
        if (!allPlaceable) {
            return this.reject("spell_not_available");
        }
        const laps = spell.getLapsTotal();
        // The caster's total magic bonus is baked into the wall at cast time: the flames keep that power
        // after an Empower buff expires, the caster leaves Sylvan Focus, or the source aura dies.
        this.context.fightProperties
            .getFireWalls()
            .addAll(cells, laps, fireWallBurnPercentage(caster.getMagicDamageBonusPercentage()));
        caster.useSpell(spell.getName());
        this.context.sceneLog.updateLog(`${caster.getName()} raised a Fire Wall for ${getLapString(laps)}`);

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: { ...action.targetCell },
                unitIdsDied: [],
                animations: [],
            },
            {
                type: "fire_wall_placed",
                casterId: caster.getId(),
                cells: cells.map((c) => ({ x: c.x, y: c.y })),
                lapsRemaining: laps,
            },
        ];
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Vine Throw (Trent / Grove Spellbook): a targeted enemy cast that leaves terrain behind it.
     *
     * The vine is thrown along the straight line to the target and lands on every cell it crossed plus the
     * target's own. Line of sight is gated like a ranged shot — the mountain or any creature standing between
     * caster and target stops the throw — but unlike an archer the caster needs no shot range: the vine is a
     * spell, so the only reach limit is what it can see.
     *
     * Two effects, both lasting `spell.getLapsTotal()` laps: every vined cell costs a non-flying creature an
     * extra step to enter (see VINE_CROSS_PENALTY in path_helper), and the struck creature is additionally
     * snared for a flat slice of its movement (the "Vine Throw" debuff, see Unit.adjustBaseStats).
     */
    private vineThrowCast(caster: Unit, target: Unit, spell: Spell): IGameActionResult {
        const from = caster.getBaseCell();
        const to = target.getBaseCell();
        if (!from || !to) {
            return this.reject("spell_not_available");
        }
        const pathCells = vinePathCells(from, to);
        if (!pathCells.length) {
            return this.reject("spell_not_available");
        }
        const settings = this.context.grid.getSettings();
        // Only a CREATURE standing in the lane can intercept the throw (owner 2026-08-08) — the arc clears
        // terrain. The shared per-spell walk decides, so the client's aim preview and the AI's enumeration
        // can never promise a throw this then refuses, and neither endpoint's own body counts (a 2x2
        // creature stands on four cells but is addressed by one).
        const blocker = SpellHelper.firstTargetedSpellSightBlocker(
            spell.getName(),
            this.context.grid,
            (cell) => isCellWithinGrid(settings, cell),
            from,
            to,
        );
        if (blocker) {
            return this.reject("spell_not_available");
        }

        const laps = spell.getLapsTotal();
        // The lane may now cross ground no vine can grip (the mountain, a narrowed hole): the throw still
        // happens, the vine just does not take root there.
        const rootedCells = pathCells.filter((cell) =>
            canVineTakeRoot(this.context.grid, isCellWithinGrid(settings, cell), cell),
        );
        this.context.fightProperties.getVines().addAll(rootedCells, laps, caster.getTeam());
        // The snare is a DEBUFF, so magic armor gets its usual save against it — the same roll every other
        // cast debuff takes (see the magic-attack path). Note what the save does NOT cover: the vines are
        // already on the ground by this point and stay there. The throw physically happened and painted the
        // cells it crossed; resisting means this creature shrugs off the grip, not that the terrain vanishes.
        const snareResisted = getRandomInt(0, 100) < Math.floor(target.getMagicResist());
        if (snareResisted) {
            this.context.sceneLog.updateLog(`${target.getName()} resisted from Vine Throw snare`);
        } else {
            target.applyDebuff(
                new Spell({
                    spellProperties: getSpellConfig("System", "Vine Throw", laps),
                    amount: 1,
                }),
            );
        }
        // Spent either way: the charge buys the throw, and the throw landed its terrain.
        caster.useSpell(spell.getName());
        if (!snareResisted) {
            this.context.sceneLog.updateLog(
                `${caster.getName()} snared ${target.getName()} with Vine Throw for ${getLapString(laps)}`,
            );
        }

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetId: target.getId(),
                targetCell: to,
                unitIdsDied: [],
                animations: [],
            },
            {
                type: "vine_placed",
                casterId: caster.getId(),
                targetId: target.getId(),
                cells: rootedCells,
                lapsRemaining: laps,
                // Ranked rebuilds its log from events, never from the text above, so the save has to ride
                // along or a resisted snare reads there as a snare that landed.
                snareResisted,
            },
        ];
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /** Line of sight for a thrown spell — the shared rule, so the aim preview cannot disagree with the cast. */
    private hasClearSpellLineOfSight(from: XY, to: XY): boolean {
        const settings = this.context.grid.getSettings();
        return SpellHelper.isSpellLineOfSightClear(
            this.context.grid,
            (cell) => isCellWithinGrid(settings, cell),
            from,
            to,
        );
    }
    /**
     * Land already-resolved MAGICAL spell damage on each victim and do the bookkeeping a normal attack does:
     * the per-unit payload the client draws floating numbers from, the damage statistic, and the morale swing a
     * kill causes (the caster gains, the victim's same-name stacks across its team lose).
     *
     * Each victim's position and stack size are snapshotted BEFORE applyDamage, because a stack that dies is
     * removed from the board before the visuals play — read it after and the number floats over nothing.
     */
    private applySpellDamageToUnits(
        caster: Unit,
        victims: Array<{ unit: Unit; damage: number; rebounded?: boolean; reboundedFromUnitId?: string }>,
    ): {
        damaged: {
            unitId: string;
            position: XY;
            amount: number;
            unitsDied: number;
            rebounded?: boolean;
            reboundedFromUnitId?: string;
        }[];
        unitIdsDied: string[];
        killed: Array<{ victim: Unit; killer: Unit }>;
    } {
        const damaged: {
            unitId: string;
            position: XY;
            amount: number;
            unitsDied: number;
            rebounded?: boolean;
            reboundedFromUnitId?: string;
        }[] = [];
        const unitIdsDied: string[] = [];
        const killed: Array<{ victim: Unit; killer: Unit }> = [];
        const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
        let casterPlusMorale = 0;

        // ABILITY Flesh Shield Aura (Abomination) does NOT apply here: the aura absorbs physical damage
        // only, and every point a spell deals is magical. A protected ally eats a cast spell in full, so
        // there is no owner-first impact ordering to arrange — victims resolve in their natural order.
        for (const { unit, damage, rebounded, reboundedFromUnitId } of victims) {
            // Several Magic Mirrors can enqueue the caster more than once. Once an earlier rebound has killed
            // it, do not call Unit.applyDamage on the dead stack again: that method deliberately assumes a live
            // stack and a second call can otherwise mutate a zero-sized stack or report phantom damage.
            if (unit.isDead()) {
                continue;
            }

            const positionAtImpact = { ...unit.getPosition() };
            const amountAliveBefore = unit.getAmountAlive();
            const damageDealt = unit.applyDamage(damage, 0 /* magic attack */, this.context.sceneLog, false, caster);
            const unitsDied = Math.max(0, amountAliveBefore - unit.getAmountAlive());

            damaged.push({
                unitId: unit.getId(),
                position: positionAtImpact,
                amount: damageDealt,
                unitsDied,
                ...(rebounded ? { rebounded: true } : {}),
                ...(reboundedFromUnitId ? { reboundedFromUnitId } : {}),
            });
            // A Magic Mirror rebound is defensive reflected damage, not offensive output produced by the
            // caster. Keep it out of damage statistics, consistently with the existing Chain Lightning mirror
            // path; reboundedFromUnitId is causal/VFX provenance, not a new analytics attribution rule.
            if (!rebounded) {
                this.context.attackHandler?.getDamageStatisticHolder().add({
                    unitName: caster.getName(),
                    damage: damageDealt,
                    team: caster.getTeam(),
                    lap: this.context.fightProperties.getCurrentLap(),
                });
            }

            if (unit.isDead()) {
                this.context.sceneLog.updateLog(`${unit.getName()} died`);
                if (!unitIdsDied.includes(unit.getId())) {
                    unitIdsDied.push(unit.getId());
                }
                // Morale is the reward for killing an ENEMY. Ring of Fire splashes onto allies and a spell
                // rebounded by a Magic Mirror can kill the caster itself; neither is a kill to be proud of,
                // so neither earns the caster morale nor demoralizes the victim's own side.
                if (unit.getTeam() !== caster.getTeam()) {
                    if (!killed.some(({ victim }) => victim.getId() === unit.getId())) {
                        killed.push({ victim: unit, killer: caster });
                    }
                    casterPlusMorale += MORALE_CHANGE_FOR_KILL;
                    const teamKey = `${unit.getName()}:${unit.getTeam()}`;
                    moraleDecreaseForTheUnitTeam[teamKey] =
                        (moraleDecreaseForTheUnitTeam[teamKey] ?? 0) + MORALE_CHANGE_FOR_KILL;
                }
            }
        }

        if (Object.keys(moraleDecreaseForTheUnitTeam).length) {
            this.context.unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
        }
        if (casterPlusMorale > 0) {
            caster.increaseMorale(
                casterPlusMorale,
                this.context.fightProperties.getAdditionalMoralePerTeam(caster.getTeam()),
            );
        }

        return { damaged, unitIdsDied, killed };
    }
    /**
     * Fire Strike (Battle Mage / Basic Tome of Battle Magic): a small fireball thrown at a single enemy.
     *
     * Reach is LINE OF SIGHT — aimed like an archer's shot, but with no shot range of its own, so whatever the
     * mage can see it can burn (see hasClearSpellLineOfSight). Damage is flat per surviving Battle Mage, shared
     * with the spellbook card and AI estimate. It is MAGICAL, so it ignores armor and only magic resistance
     * cuts it down. One cast = one charge.
     */
    /**
     * The caster's own side is transparent to a thrown fireball: only an ENEMY on the line intercepts it,
     * the same rule Area Throw interception already follows. Without this, opening up interception would
     * have handed players a way to burn their own front line by aiming past it.
     */
    private isAllyOfCaster(caster: Unit, unitId: string): boolean {
        const unit = this.context.unitsHolder.getAllUnits().get(unitId);
        return !!unit && unit.getTeam() === caster.getTeam();
    }
    private fireStrikeCast(caster: Unit, target: Unit, spell: Spell): IGameActionResult {
        const from = caster.getBaseCell();
        const to = target.getBaseCell();
        if (!from || !to) {
            return this.reject("spell_not_available");
        }
        // Every standard gate (enemy team, not self, 100% magic resist, stack power, charge left) in one call —
        // this path bypasses handleMagicAttack, so it must not bypass its validation too.
        if (
            !SpellHelper.canCastSpell(
                false,
                this.context.grid.getSettings(),
                this.context.grid.getMatrix(),
                caster,
                target,
                spell,
                to,
                target.getMagicResist(),
                target.hasMindAttackResistance(),
                target.canBeHealed(),
            )
        ) {
            return this.reject("spell_not_available");
        }
        // Like an archer's shot (owner 2026-08-09): a creature standing on the line INTERCEPTS the
        // fireball and takes it instead of the aimed target, rather than the cast being refused. Only
        // terrain still stops it outright — the fireball cannot fly through the mountain. The client's
        // aim preview resolves the impact through this same helper, so the trajectory a player watches
        // names the creature that actually burns.
        const settings = this.context.grid.getSettings();
        const impact = SpellHelper.resolveThrownSpellImpact(
            spell.getName(),
            this.context.grid,
            (cell) => isCellWithinGrid(settings, cell),
            from,
            to,
            (unitId) => this.isAllyOfCaster(caster, unitId),
        );
        if (impact.blockedByTerrain) {
            return this.reject("spell_not_available");
        }
        let victim = target;
        if (impact.interceptedBy && impact.interceptedBy !== target.getId()) {
            const intercepting = this.context.unitsHolder.getAllUnits().get(impact.interceptedBy);
            if (!intercepting || intercepting.isDead()) {
                return this.reject("spell_not_available");
            }
            victim = intercepting;
            this.context.sceneLog.updateLog(
                `${intercepting.getName()} intercepted ${spell.getName()} aimed at ${target.getName()}`,
            );
        }

        const rawDamage = spellRawDamage(spell, caster);
        const victims = this.resolveSpellVictims(caster, spell, rawDamage, [victim]);
        const { damaged, unitIdsDied, killed } = this.applySpellDamageToUnits(caster, victims);
        caster.useSpell(spell.getName());
        this.context.sceneLog.updateLog(
            `${caster.getName()} 🔥 ${victim.getName()} (${spellDamageDealt(damaged, victim.getId())})`,
        );

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                // The unit actually BURNED, which an interception makes different from the one aimed at.
                // Clients animate the fireball to this id and print its damage, so it must be the victim.
                targetId: victim.getId(),
                targetCell: impact.cell,
                unitIdsDied,
                animations: [],
                damaged,
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied, this.createDirectKillAttributions(unitIdsDied, killed)));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Meteorite (Battle Mage / Basic Tome of Battle Magic): a rock called down on a 2x2 block of the board.
     *
     * Aimed at a CELL rather than a unit, anywhere the mage likes — there is no range gate and no line of sight
     * to keep, because it falls out of the sky. `action.targetCell` is the bottom-left of the block, the same
     * corner convention Craft and Smoke use. Unlike Smoke it may be dropped straight onto occupied cells: that
     * is the entire point of it.
     *
     * Every ENEMY standing under the block takes the damage — allies are not caught, and a large creature
     * straddling two of the four cells is hit once (evaluateAffectedUnits dedupes by unit). Per target it is the
     * Fire Strike formula less 40%, the price of hitting a whole cluster at once.
     *
     * A drop that catches nobody is REJECTED rather than silently burning the only charge — the same courtesy
     * canMassCastSpell extends to a mass spell with no valid recipient.
     */
    private meteoriteCast(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        if (!action.targetCell) {
            return this.reject("spell_not_available");
        }
        const c = action.targetCell;
        // Footprint and fit both come from the shared helper the aim preview reads, so the block the player
        // saw highlighted is the block that lands and a drop the preview labelled is a drop that happens.
        // Occupancy is deliberately NOT checked — a meteor is meant to come down on somebody's head.
        const cells = SpellHelper.cellTargetedSpellBlockCells(spell.getName(), c);
        const settings = this.context.grid.getSettings();
        if (!SpellHelper.cellTargetedSpellBlockFitsGrid(settings, spell.getName(), c)) {
            return this.reject("spell_not_available");
        }

        const affected = evaluateAffectedUnits(cells, this.context.unitsHolder, this.context.grid)?.[0] ?? [];
        const enemies = affected.filter((unit) => unit.getTeam() !== caster.getTeam() && !unit.isDead());
        if (!enemies.length) {
            return this.reject("spell_not_available");
        }

        const rawDamage = spellRawDamage(spell, caster);
        const victims = this.resolveSpellVictims(caster, spell, rawDamage, enemies);
        const { damaged, unitIdsDied, killed } = this.applySpellDamageToUnits(caster, victims);
        caster.useSpell(spell.getName());
        this.context.sceneLog.updateLog(
            // Post-resistance total across everyone under the 2x2 — see the Lightning Strike log below.
            `${caster.getName()} called a Meteorite onto ${enemies.length} target(s) (${spellDamageTotal(damaged)})`,
        );

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: c,
                unitIdsDied,
                animations: [],
                damaged,
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied, this.createDirectKillAttributions(unitIdsDied, killed)));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Turn one raw (pre-resistance) spell-damage number into the units that actually take it, including each
     * Magic Mirror return. The spell buffs return their configured share deterministically; Magic Reflection
     * keeps its chance-based proc and uses that same advertised percentage as its returned share.
     *
     * A rebound is an EXTRA hit, not a redirection: the spell still lands on the holder in full, then the
     * caster takes the resolved share, cut down by the CASTER's own element and magic resistance. Two mirrored
     * targets in one splash therefore hit the caster twice. The caster is never asked to rebound a spell onto
     * itself, so a mirror-carrying caster caught in its own blast cannot loop.
     */
    /**
     * What `rawDamage` of this spell actually does to `unit`: element first, magic resistance second.
     *
     * A Fire Element caught in a Ring of Fire takes nothing at all and never reaches the resistance step —
     * it IS the fire. A Water Element takes half again as much and then resists that. Lightning passes
     * straight through a Wind Element, and a Whirlpool washes over a Water Element. Every spell that is not
     * elemental — which is all of them but the Tome of Elements' four — comes through here unchanged, right
     * down to the fractional raw damage the old call site passed through untouched.
     */
    private elementalDamageAgainst(spell: Spell, rawDamage: number, unit: Unit): number {
        // Shared with the client's hover projection so the number a player is shown and the number this
        // deals are produced by the same arithmetic, not two copies of it.
        return spellDamageAgainstUnit(spell, rawDamage, unit);
    }
    private resolveSpellVictims(
        caster: Unit,
        spell: Spell,
        rawDamage: number,
        targets: Unit[],
    ): Array<{ unit: Unit; damage: number; rebounded?: boolean; reboundedFromUnitId?: string }> {
        const victims: Array<{
            unit: Unit;
            damage: number;
            rebounded?: boolean;
            reboundedFromUnitId?: string;
        }> = [];
        for (const unit of targets) {
            const landedDamage = this.elementalDamageAgainst(spell, rawDamage, unit);
            victims.push({ unit, damage: landedDamage });
            // A mirror returns what it REFLECTS, not the whole spell: the caster takes the mirror's own share
            // (the percentage its card advertises) of the damage that actually landed on the holder.
            // Reflecting 100% made a 75% card a lie and turned every dragon into a death trap. The caster's
            // OWN element and magic resistance then cut the rebound down, so what comes back is what the
            // caster actually takes — projected by the same helper the client's aim preview draws over the
            // caster, so aiming at a mirror warns about the return hit before it is taken.
            const reflectionPercent =
                landedDamage > 0 && unit.getId() !== caster.getId() ? SpellHelper.rollMagicMirrorDamageShare(unit) : 0;
            const rebound = reflectionPercent
                ? projectSpellRebound({
                      spell,
                      caster,
                      holder: unit,
                      landedOnHolder: landedDamage,
                      reflectionPercent,
                  })
                : undefined;
            if (rebound) {
                const { reflectionPercent: share, landed: reboundDamage } = rebound;
                // The line used to name the rebound without a number, which left the player guessing what a
                // Magic Mirror had just cost them.
                this.context.sceneLog.updateLog(
                    `${unit.getName()} rebounded ${share}% of ${spell.getName()} back at ${caster.getName()} (${reboundDamage})`,
                );
                // Flagged so ranked can say the same thing: it rebuilds its scene log from events and never
                // reads the line above, so without this the caster's damage appeared with no explanation.
                // The holder rides along so both scenes can draw the beam back from the mirror that threw it.
                victims.push({
                    unit: caster,
                    damage: reboundDamage,
                    rebounded: true,
                    reboundedFromUnitId: unit.getId(),
                });
            }
        }

        return victims;
    }
    /**
     * Lightning Strike (Magic Dragon / Tome of Elements): a bolt called down on a single enemy.
     *
     * Where Fire Strike is aimed like an archer's shot, this one falls out of the sky: there is NO line of
     * sight to keep and no range of its own, so the mountain, a wall of bodies or the sheer width of the board
     * are all irrelevant — any enemy standing on the field is a legal target. Every other gate still applies
     * (enemy team, not self, 100% magic resist, stack power, charge left), because this path bypasses
     * handleMagicAttack and must not bypass its validation too.
     *
     * Damage is the stack-powered formula shared with the spellbook card, so the number the player read on the
     * page is the number that lands: 150 per living dragon at full stack power. It is MAGICAL — armor does
     * nothing, only the target's magic resistance cuts it down. One cast = one charge.
     */
    private lightningStrikeCast(caster: Unit, target: Unit, spell: Spell): IGameActionResult {
        const to = target.getBaseCell();
        if (!to) {
            return this.reject("spell_not_available");
        }
        if (
            !SpellHelper.canCastSpell(
                false,
                this.context.grid.getSettings(),
                this.context.grid.getMatrix(),
                caster,
                target,
                spell,
                to,
                target.getMagicResist(),
                target.hasMindAttackResistance(),
                target.canBeHealed(),
            )
        ) {
            return this.reject("spell_not_available");
        }

        const rawDamage = spellRawDamage(spell, caster);
        const victims = this.resolveSpellVictims(caster, spell, rawDamage, [target]);
        const { damaged, unitIdsDied, killed } = this.applySpellDamageToUnits(caster, victims);
        caster.useSpell(spell.getName());
        // The number the victim ACTUALLY took, not the pre-resistance roll. Logging rawDamage printed the
        // same figure whatever the target's magic resistance was, which read as "mdef does nothing" even
        // though resolveSpellVictims had already cut the damage down. Fire Strike logs its reduced value
        // the same way.
        this.context.sceneLog.updateLog(
            `${caster.getName()} ⚡ ${target.getName()} (${spellDamageDealt(damaged, target.getId())})`,
        );

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetId: target.getId(),
                targetCell: to,
                unitIdsDied,
                animations: [],
                damaged,
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied, this.createDirectKillAttributions(unitIdsDied, killed)));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Ring of Fire (Magic Dragon / Tome of Elements): flame bursts around one enemy in line of sight.
     *
     * The ring is every cell TOUCHING the aimed enemy, and the aimed enemy itself is deliberately NOT in it:
     * the spell bursts AROUND a creature, so the one it is pointed at takes nothing while everything hugging
     * it burns. Like the Cyclops' Large Caliber splash it does not care whose side anyone is on — an ally
     * standing next to the target burns for exactly the same amount. Only the dragon is never caught in its
     * own ring.
     *
     * The ring scales to the target's SIZE: a 1x1 enemy is ringed by the 8 cells around it, a 2x2 enemy by
     * the 12 cells around its whole block. Ringing only the base cell would both miss half a large target's
     * neighbours and aim the burst at cells the target itself occupies.
     *
     * Reach is LINE OF SIGHT, the gate Fire Strike uses, because unlike Lightning Strike this one is thrown
     * rather than called down. Its explicit 25 multiplier prices the wider footprint below Lightning Strike's
     * 30 without deriving one spell from the other. The cast is allowed on ANY enemy in line of sight (owner
     * 2026-08-08): a lone target with nothing standing around it is spared like every other aim point and the
     * ring simply burns no one — the dragon still spends the charge. The only aim point that is refused is a
     * fully magic-immune one (a Black Dragon at 100% resist), and that gate lives in canCastSpell, not here.
     */
    private ringOfFireCast(caster: Unit, target: Unit, spell: Spell): IGameActionResult {
        const from = caster.getBaseCell();
        const to = target.getBaseCell();
        if (!from || !to) {
            return this.reject("spell_not_available");
        }
        if (
            !SpellHelper.canCastSpell(
                false,
                this.context.grid.getSettings(),
                this.context.grid.getMatrix(),
                caster,
                target,
                spell,
                to,
                target.getMagicResist(),
                target.hasMindAttackResistance(),
                target.canBeHealed(),
            )
        ) {
            return this.reject("spell_not_available");
        }
        if (!this.hasClearSpellLineOfSight(from, to)) {
            return this.reject("spell_not_available");
        }

        // The ring is lifted from the target's own cells whatever its shape. For a 1x1 that IS `[to]` (its
        // single cell is its base cell), so nothing about the shipped shapes changes, but a rectangle would
        // otherwise be ringed as the 2x2 the size bit claims it is.
        const cells = getCellsAroundFootprint(this.context.grid.getSettings(), target.getCells());
        // evaluateAffectedUnits dedupes by unit, so a large creature straddling two of the ring's cells burns
        // once. The aimed target owns none of these cells, so it is already absent; it is filtered by id too
        // so the "spares its target" rule survives any future change to how occupancy is reported.
        const caught = (evaluateAffectedUnits(cells, this.context.unitsHolder, this.context.grid)?.[0] ?? []).filter(
            (unit) => !unit.isDead() && unit.getId() !== caster.getId() && unit.getId() !== target.getId(),
        );
        // An empty ring is NOT a refusal: the owner wants Ring of Fire castable at any enemy in sight, so a
        // lone target simply spends the charge and burns no one. Refusing here was the "sometimes it will not
        // cast — with no barrier in the way" report: the barrier was this neighbour requirement, invisible to
        // the player. canCastSpell above already turns a fully magic-immune aim point (Black Dragon) away.

        const rawDamage = spellRawDamage(spell, caster);
        const victims = this.resolveSpellVictims(caster, spell, rawDamage, caught);
        const { damaged, unitIdsDied, killed } = this.applySpellDamageToUnits(caster, victims);
        caster.useSpell(spell.getName());
        this.context.sceneLog.updateLog(
            // Post-resistance total across everyone caught — see the Lightning Strike log above. Each victim
            // resists separately, so the sum is the honest single number for a splash.
            `${caster.getName()} ringed ${target.getName()} in fire, catching ${caught.length} target(s) (${spellDamageTotal(damaged)})`,
        );

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetId: target.getId(),
                targetCell: to,
                unitIdsDied,
                animations: [],
                damaged,
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied, this.createDirectKillAttributions(unitIdsDied, killed)));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * Meteor Shower (Magic Dragon / Tome of Elements): meteors rained over a 3x3 block of the board.
     *
     * Aimed at a CELL rather than a unit, anywhere the dragon likes — no range gate and no line of sight,
     * because it falls out of the sky. `action.targetCell` is the CENTRE of the block: an odd-sided footprint
     * pivots around the cursor the way the Fire Wall's 3-cell line does, unlike the even-sided 2x2 of Meteorite
     * and Craft, which have no centre cell to anchor on and take a corner instead.
     *
     * Every ENEMY standing under the block takes the damage — allies are not caught (that is Ring of Fire's
     * job), and a large creature straddling several of the nine cells is hit once. Its explicit 20 multiplier
     * prices the nine-cell footprint below Ring of Fire without coupling either spell's future balance.
     *
     * A drop that catches nobody is REJECTED rather than silently burning the only charge — the same courtesy
     * canMassCastSpell extends to a mass spell with no valid recipient.
     */
    private meteorShowerCast(
        action: Extract<GameAction, { type: "cast_spell" }>,
        caster: Unit,
        spell: Spell,
    ): IGameActionResult {
        if (!action.targetCell) {
            return this.reject("spell_not_available");
        }
        const c = action.targetCell;
        // Footprint and fit both come from the shared helper the aim preview reads — see meteoriteCast. The
        // 3x3 is CENTRED on the aimed cell, which is what makes it different from Meteorite's cornered 2x2.
        const cells = SpellHelper.cellTargetedSpellBlockCells(spell.getName(), c);
        const settings = this.context.grid.getSettings();
        if (!SpellHelper.cellTargetedSpellBlockFitsGrid(settings, spell.getName(), c)) {
            return this.reject("spell_not_available");
        }

        const affected = evaluateAffectedUnits(cells, this.context.unitsHolder, this.context.grid)?.[0] ?? [];
        const enemies = affected.filter((unit) => unit.getTeam() !== caster.getTeam() && !unit.isDead());
        if (!enemies.length) {
            return this.reject("spell_not_available");
        }

        const rawDamage = spellRawDamage(spell, caster);
        const victims = this.resolveSpellVictims(caster, spell, rawDamage, enemies);
        const { damaged, unitIdsDied, killed } = this.applySpellDamageToUnits(caster, victims);
        caster.useSpell(spell.getName());
        this.context.sceneLog.updateLog(
            // Post-resistance total, as with Ring of Fire above.
            `${caster.getName()} called a Meteor Shower onto ${enemies.length} target(s) (${spellDamageTotal(damaged)})`,
        );

        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: c,
                unitIdsDied,
                animations: [],
                damaged,
            },
        ];
        events.push(...this.cleanupDeadUnits(unitIdsDied, this.createDirectKillAttributions(unitIdsDied, killed)));
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * +1 flat armor / attack. The bonus STACKS — the running total lives in the buff's first spell property, so
     * re-casting reads the current total, deletes the old buff, and re-applies it at +1 (see adjustBaseStats,
     * which folds that property into armor_mod / attack_mod, and the card's Buffs section, which shows "+N").
     */
    private enchantCast(caster: Unit, target: Unit, spell: Spell): IGameActionResult {
        const isArmor = spell.getName() === "Armor Rune";
        const buffName = spell.getName();
        // Reported on the event below: a FAILED rune changes nothing, so like Craft's "nothing" it can only
        // reach a ranked client if the server states it outright.
        let outcome = "failed";
        let total: number | undefined;
        if (getRandomInt(0, 100) < 50) {
            const next = (target.getBuff(buffName)?.getFirstSpellProperty() ?? 0) + 1;
            target.deleteBuff(buffName); // idempotent when absent; re-applied below carrying the new total
            target.applyBuff(spell, next);
            this.context.sceneLog.updateLog(`${target.getName()} enchanted: +${next} ${isArmor ? "armor" : "attack"}`);
            outcome = "enchanted";
            total = next;
        } else {
            this.context.sceneLog.updateLog(`${target.getName()}'s ${isArmor ? "armor" : "weapon"} enchant failed`);
        }
        caster.useSpell(spell.getName());
        const events: GameEvent[] = [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetId: target.getId(),
                targetCell: target.getBaseCell(),
                unitIdsDied: [],
                animations: [],
                outcomes: [{ unitId: target.getId(), outcome, ...(total !== undefined ? { amount: total } : {}) }],
            },
        ];
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
        let healed: { unitId: string; amount: number }[] = [];
        if (targetType === SpellTargetType.ALL_FLYING) {
            this.massCastOnFlyers(spell, caster, team);
        } else if (targetType === SpellTargetType.ALL_ALLIES) {
            healed = this.massCastOnAllies(spell, caster, team);
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
                healed: healed.length ? healed : undefined,
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
        // The gate at the top of this cast could only prove the ANCHOR cell was free: the creature that
        // would stand on it did not exist yet. It does now, so put its whole body through the same
        // authoritative gate. Every shipped summon is a 1x1, for which this re-asks the identical question
        // and gets the identical answer; for anything wider it is the difference between refusing the cast
        // and dropping a body across cells that were never looked at.
        if (
            !SpellHelper.canCastSummon(
                spell,
                this.context.grid.getMatrix(),
                targetCell,
                summoned.getFootprintWidth(),
                summoned.getFootprintHeight(),
            )
        ) {
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
            summoned.canTraverseLava(),
            summoned.hasAbilityActive("Made of Water"),
        );
        if (!occupied) {
            return this.reject("spell_not_available", `No room to summon ${unitName}`);
        }

        summoned.setPosition(position.x, position.y);
        this.context.unitsHolder.addUnit(summoned);
        this.context.sceneLog.updateLog(`${caster.getName()} summoned ${amount} x ${unitName}`);
        const summonCell = summoned.getBaseCell();
        this.context.sceneLog.updateLog(`${unitName} spawned at (${summonCell.x}, ${summonCell.y})`);
        caster.useSpell(spell.getName());

        const events = this.createSummonEvents(caster, spell, summoned, amount, cells, false);
        events.push(...this.turnEngine.completeTurn(caster));
        return { completed: true, events };
    }
    /**
     * The cells a summoned creature stands on with its ANCHOR (top-right cell) on `targetCell`.
     *
     * The 2x2 list is kept hand-written, cell ORDER included: it is the order Unit.getCells produces for a
     * large body and it travels out on the `unit_summoned` event into every recorded fight, so reproducing
     * it exactly is what keeps existing replays and the seeded runs behind the baked AI weights readable.
     * Only a genuinely rectangular summon takes the shared expansion.
     */
    private resolveSummonCells(unit: Unit, targetCell?: XY): XY[] {
        if (!targetCell) {
            return [];
        }
        if (unit.isSmallSize()) {
            return [{ ...targetCell }];
        }
        const width = unit.getFootprintWidth();
        const height = unit.getFootprintHeight();
        if (width === 2 && height === 2) {
            return [
                { x: targetCell.x - 1, y: targetCell.y },
                { x: targetCell.x, y: targetCell.y },
                { x: targetCell.x - 1, y: targetCell.y - 1 },
                { x: targetCell.x, y: targetCell.y - 1 },
            ];
        }

        return getFootprintCellsForAnchor(targetCell, width, height);
    }
    private createSummonEvents(
        caster: Unit,
        spell: Spell,
        summoned: Unit,
        amount: number,
        cells: XY[],
        merged: boolean,
    ): GameEvent[] {
        // The anchor, never `cells[0]`. A footprint is an unordered set of cells and the list a large body
        // produces starts at its top-LEFT cell, so index 0 named a cell the summon is not anchored on —
        // while everything downstream (the log line, the client's cast animation) reads this as "where the
        // spell landed". For a 1x1 the two are the same cell, which is every summon shipped today.
        const anchorCell = getFootprintAnchorForCells(cells);
        return [
            {
                type: "spell_cast",
                casterId: caster.getId(),
                spellName: spell.getName(),
                targetCell: anchorCell ? { ...anchorCell } : undefined,
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
                    unit.applyBuff(
                        amplifyCastBuffForTarget(spell, caster, unit),
                        undefined,
                        undefined,
                        unit.getId() === caster.getId(),
                    );
                }
            }
        };
        applyTo(this.context.unitsHolder.getAllAllies(team));
        applyTo(this.context.unitsHolder.getAllEnemyUnits(team));
    }
    private massCastOnAllies(spell: Spell, caster: Unit, team: number): { unitId: string; amount: number }[] {
        const healed: { unitId: string; amount: number }[] = [];
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
                    // ARTIFACT Holy Cross: +50% mass healing when the caster's army holds it.
                    const holyCrossBuff = caster.getBuff("Holy Cross");
                    const holyCrossFactor = holyCrossBuff ? 1 + holyCrossBuff.getPower() / 100 : 1;
                    const healPower = unit.applyHeal(
                        Math.floor(spell.getPower() * caster.getAmountAlive() * holyCrossFactor),
                    );
                    if (healPower) {
                        this.context.sceneLog.updateLog(
                            `${caster.getName()} mass healed ${unit.getName()} for ${healPower} hp`,
                        );
                        healed.push({ unitId: unit.getId(), amount: healPower });
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
                unit.applyBuff(
                    amplifyCastBuffForTarget(scaledSpell, caster, unit),
                    undefined,
                    undefined,
                    unit.getId() === caster.getId(),
                );
            } else {
                unit.applyBuff(
                    amplifyCastBuffForTarget(spell, caster, unit),
                    undefined,
                    undefined,
                    unit.getId() === caster.getId(),
                );
            }
            // Name every ally the mass buff actually reached — without this the sandbox log said only
            // "cast X on allies" and the recipients were invisible (ranked reads them from the
            // effects_applied event instead).
            this.context.sceneLog.updateLog(
                `${unit.getName()} gains ${spell.getName()} for ${getLapString(
                    spell.getLapsTotal() + (unit.getId() === caster.getId() ? 1 : 0),
                )}`,
            );
        }

        return healed;
    }
    private massCastOnEnemies(spell: Spell, caster: Unit, team: number): void {
        this.context.sceneLog.updateLog(`${caster.getName()} cast ${spell.getName()} on enemies`);
        for (const enemy of this.context.unitsHolder.getAllEnemyUnits(team)) {
            const absorptionTarget = EffectHelper.getAbsorptionTarget(
                enemy,
                this.context.grid,
                this.context.unitsHolder,
                this.context.sceneLog,
            );
            const debuffTarget = absorptionTarget ?? enemy;

            if (debuffTarget.getMagicResist() === 100) {
                continue;
            }
            if (getRandomInt(0, 100) < Math.floor(debuffTarget.getMagicResist())) {
                this.context.sceneLog.updateLog(`${debuffTarget.getName()} resisted from ${spell.getName()}`);
                recordEffectApplication({
                    unitId: debuffTarget.getId(),
                    name: spell.getName(),
                    kind: "debuff",
                    resisted: true,
                });
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
            // Name every enemy the mass debuff actually landed on — mirrors the "gains" line in
            // massCastOnAllies; resists above already have their own line.
            this.context.sceneLog.updateLog(
                `${debuffTarget.getName()} suffers ${spell.getName()} for ${getLapString(
                    laps + (debuffTarget.getId() === caster.getId() ? 1 : 0),
                )}`,
            );

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
            unit.canTraverseLava(),
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

        // Before removing it, find the biggest OTHER stack of the same creature+level on this team so the
        // deleted models fold back into it (e.g. a split-off single you no longer want returns to the main
        // stack: 89 / 1 / 1, delete a 1 -> 90 / 1). exp identifies the level/tier and a split copies it, so
        // merging same-exp stacks only recombines what was split — it never inflates experience or upgrades
        // models across levels, and it lowers (never raises) the team's same-unit stack count.
        const deletedAmount = unit.getAmountAlive();
        const deletedName = unit.getName();
        const deletedExp = unit.getExp();
        let mergeTarget: Unit | undefined;
        for (const other of this.context.unitsHolder.getAllUnits().values()) {
            if (
                other.getId() === unit.getId() ||
                other.getTeam() !== team ||
                other.getName() !== deletedName ||
                other.getExp() !== deletedExp
            ) {
                continue;
            }
            if (!mergeTarget || other.getAmountAlive() > mergeTarget.getAmountAlive()) {
                mergeTarget = other;
            }
        }

        if (!this.context.unitsHolder.deleteUnitById(action.unitId)) {
            return this.reject("delete_not_available");
        }
        if (mergeTarget && deletedAmount > 0) {
            mergeTarget.setAmountAlive(mergeTarget.getAmountAlive() + deletedAmount);
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

        // Where the peeled stack lands. A drag-split names its own cells and must get exactly those or
        // nothing. A plain split (the sidebar's "Split Selected") names none, so we walk the ring around the
        // source and take the nearest cell that fits — the new stack appears beside the unit it came from
        // instead of at the board origin. Either way the target is validated and occupied BEFORE the source
        // is mutated, so a refusal leaves the action a clean no-op rather than a halved stack with nowhere
        // to stand.
        const explicitCells = action.cells?.length ? action.cells : undefined;
        const candidates = explicitCells ? [explicitCells] : this.splitCellsBesideSource(splitUnit, sourceUnit);

        let placement: { position: XY; cells: XY[] } | undefined;
        let refusal: GameActionRejectionReason | undefined;
        for (const cells of candidates) {
            const attempt = this.occupyForSplit(splitUnit, cells);
            if (typeof attempt === "string") {
                refusal = attempt;
                continue;
            }
            placement = attempt;
            break;
        }
        // An explicit target is the whole point of the gesture, so failing it fails the split. An
        // auto-picked cell is only a convenience: if the ring is full, still split and leave the new stack
        // unplaced for the player to position, rather than refusing a legal split.
        if (!placement && explicitCells) {
            return this.reject(refusal ?? "invalid_placement");
        }

        const sourceAmount = sourceUnit.getAmountAlive() - action.amount;
        sourceUnit.setAmountAlive(sourceAmount);
        this.context.unitsHolder.addUnit(splitUnit);

        const events: GameEvent[] = [
            {
                type: "unit_split",
                sourceUnitId: sourceUnit.getId(),
                newUnitId: splitUnit.getId(),
                team: sourceUnit.getTeam(),
                sourceAmount,
                splitAmount: action.amount,
            },
        ];
        // Emit the placement too, so every listener that already knows how to render/track a placed unit
        // (grid occupancy mirrors, the ranked scene's hydrate) picks the new stack up with no special case.
        if (placement) {
            events.push({
                type: "unit_placed",
                unitId: splitUnit.getId(),
                team: splitUnit.getTeam(),
                position: { ...placement.position },
                cells: placement.cells,
            });
        }

        return { completed: true, events };
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
        return canWaitOnHourglass(unit, this.context.fightProperties, this.context.unitsHolder.getAllUnits());
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
            return this.findKnownRouteForFootprint(unit, targetCells, knownPaths) ?? new Error("invalid_move");
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
        if (matchingRoute) {
            return matchingRoute;
        }
        // Same reasoning as resolveKnownPaths: the DESTINATION is reachable (`routes` is non-empty and was
        // fetched by the destination's own key, so the server itself found a legal route there), but the
        // client's intermediate `path` doesn't match cell-for-cell — a benign client/server pather divergence
        // on which equal-cost detour to take. Refusing here (invalid_move) wrongly rejects a legal move that
        // the client correctly shows as reachable. Fall back to the server's canonical route to that cell,
        // which is authoritative for terrain flags. Note this does NOT weaken reachability enforcement: an
        // UNreachable destination has no entry in knownPaths, so line 1300 above still rejects it.
        return this.canonicalRoute(routes) ?? new Error("invalid_move");
    }
    /**
     * The known route whose destination footprint IS the move's target cells.
     *
     * `route.cell` is an anchor the pather reached, so the body it implies is the unit's own footprint hung
     * off it. That used to be spelled as a literal 2x2 block, which answered "no route" for every other
     * shape — and a footprint-only move with no route is rejected as invalid_move.
     */
    private findKnownRouteForFootprint(
        unit: Unit,
        targetCells: XY[],
        knownPaths: ReadonlyMap<number, IWeightedRoute[]>,
    ): IWeightedRoute | undefined {
        for (const cell of targetCells) {
            const routes = knownPaths.get(this.cellKey(cell));
            const matchingRoute = routes?.find((route) =>
                this.cellsMatchAsSet(targetCells, unit.getFootprintCellsForAnchor(route.cell)),
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
            travelledMovePath(unit.getBaseCell(), knownRoute),
            travelledMovePath(unit.getBaseCell(), actionPath),
        );
    }
    /**
     * The server's preferred (authoritative) route among all known routes to a single reachable cell: the
     * lowest-weight one (shortest travelled distance), tie-broken by iteration order for determinism. Used
     * as the fallback when the client's animated path to a reachable attack-from / move destination doesn't
     * match any known route cell-for-cell — we accept the move but substitute the server's own route (with
     * its authoritative terrain flags) so no client-supplied path is ever trusted. Every route in the list
     * is already a legal, fully-reachable route produced by the pather, so any choice is safe; shortest is
     * the most conservative.
     */
    private canonicalRoute(routes?: IWeightedRoute[]): IWeightedRoute | undefined {
        if (!routes?.length) {
            return undefined;
        }
        let best = routes[0];
        for (const route of routes) {
            if (route.weight < best.weight) {
                best = route;
            }
        }
        return best;
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
    private cellsMatchInOrder(left: XY[], right: XY[]): boolean {
        return (
            left.length === right.length &&
            left.every((cell, index) => cell.x === right[index]?.x && cell.y === right[index]?.y)
        );
    }
    /** Compatibility seam for existing diagnostics; production logic delegates to the shared pure helper. */
    private cellsMatchAsSet(left: XY[], right: XY[]): boolean {
        return moveCellsMatchAsSet(left, right);
    }
    private cellKey(cell: XY): number {
        return (cell.x << 4) | cell.y;
    }
    private sameCell(left: XY, right: XY): boolean {
        return left.x === right.x && left.y === right.y;
    }
    /**
     * Validate + occupy `cells` for a freshly split stack, or say why it could not be done. Mirrors the
     * checks placeUnit runs, so a split-with-placement is held to exactly the same rules as a placement.
     */
    private occupyForSplit(splitUnit: Unit, cells: XY[]): { position: XY; cells: XY[] } | GameActionRejectionReason {
        if (!this.isValidPlacementFootprint(splitUnit, cells)) {
            return "invalid_placement";
        }
        // The hook asks "may this unit stand on these cells", so hand it the placement this split performs
        // rather than the split action it cannot read.
        const asPlacement: Extract<GameAction, { type: "place_unit" }> = {
            type: "place_unit",
            unitId: splitUnit.getId(),
            team: splitUnit.getTeam(),
            unitName: splitUnit.getName(),
            cells,
        };
        if (this.context.canPlaceUnit && !this.context.canPlaceUnit(splitUnit, cells, asPlacement)) {
            return "placement_not_available";
        }
        const position = getPositionForCells(this.context.grid.getSettings(), cells);
        if (!position) {
            return "invalid_placement";
        }
        const occupied = this.context.grid.occupyCells(
            cells,
            splitUnit.getId(),
            splitUnit.getTeam(),
            splitUnit.getAttackRange(),
            splitUnit.canTraverseLava(),
            splitUnit.hasAbilityActive("Made of Water"),
        );
        if (!occupied) {
            return "placement_blocked";
        }
        splitUnit.setPosition(position.x, position.y);
        return { position, cells: structuredClone(cells) };
    }
    /**
     * Candidate footprints for a split stack that names no target, nearest-first around the source's own
     * footprint. Mirrors the sandbox's clone placement so ranked and sandbox drop the new stack in the same
     * place. Cells already held by the source are skipped; everything else is left for occupyForSplit to
     * judge, so an occupied or out-of-zone candidate simply loses to the next one.
     */
    private splitCellsBesideSource(splitUnit: Unit, sourceUnit: Unit): XY[][] {
        const sourceCells = sourceUnit.getCells();
        if (!sourceCells.length) {
            return [];
        }
        const centerX = sourceCells.reduce((sum, cell) => sum + cell.x, 0) / sourceCells.length;
        const centerY = sourceCells.reduce((sum, cell) => sum + cell.y, 0) / sourceCells.length;
        const sourceKeys = new Set(sourceCells.map((cell) => `${cell.x}:${cell.y}`));

        // Each candidate is the peeled stack's ANCHOR — its top-right cell — because that is the one
        // convention the rest of the engine reads a body from. This used to grow the block from the
        // candidate towards +x/+y, i.e. treat it as the MINIMUM corner, which is the opposite reading:
        // legal landings next to the donor were reported as overlapping it and the block actually offered
        // sat a cell away from where the ring said it would.
        const width = splitUnit.getFootprintWidth();
        const height = splitUnit.getFootprintHeight();
        const gridSettings = this.context.grid.getSettings();
        const anchors: XY[] = [];
        const seen = new Set<string>();
        for (const cell of sourceCells) {
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dy = -1; dy <= 1; dy += 1) {
                    if (dx === 0 && dy === 0) {
                        continue;
                    }
                    const anchor = { x: cell.x + dx, y: cell.y + dy };
                    // An anchor whose body hangs off the board is not a candidate at all. The old
                    // `x < 0 || y < 0` test is the 1x1 instance of this; a 1x2 additionally needs a cell
                    // below the anchor, which is what used to be offered and then silently refused.
                    if (!isFootprintWithinGrid(gridSettings, anchor, width, height)) {
                        continue;
                    }
                    const key = `${anchor.x}:${anchor.y}`;
                    if (sourceKeys.has(key) || seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    anchors.push(anchor);
                }
            }
        }
        anchors.sort(
            (left, right) =>
                (left.x - centerX) ** 2 +
                (left.y - centerY) ** 2 -
                ((right.x - centerX) ** 2 + (right.y - centerY) ** 2),
        );

        return anchors.map((anchor) => splitUnit.getFootprintCellsForAnchor(anchor));
    }
    /**
     * Whether `cells` is exactly the block this unit stands on: W*H DISTINCT on-board cells tiling its own
     * W x H rectangle, nothing more and nothing less.
     *
     * This one gate is why a rectangle could not be placed, split or summoned: the rule it replaced was
     * literally "one cell, or four cells forming a square", so a 1x2's two cells were refused before any
     * other check ran. Asking PathHelper keeps the engine's answer identical to the one the pre-fight
     * preview and the pather already give, instead of a third hand-rolled copy of the same rectangle test.
     */
    private isValidPlacementFootprint(unit: Unit, cells: XY[]): boolean {
        return this.getFootprintRules().areCellsFormingFootprint(
            cells,
            unit.getFootprintWidth(),
            unit.getFootprintHeight(),
        );
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
            unit.canTraverseLava(),
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
            if (matchingRoute) {
                return new Map([[key, [matchingRoute]]]);
            }
            // CORRECTNESS (legit move-attack refused as attack_not_available): reaching HERE means the
            // attack-from cell IS reachable — the server's own authoritative reach (getCurrentActiveKnownPaths)
            // has one or more routes to `key` — but NONE of them matches the client's supplied `path`
            // cell-for-cell. That happens routinely and legitimately: the client and server pathers can pick
            // DIFFERENT equal-cost detours around a threatened cell / obstacle, so the client animates
            // e.g. (2,5)->(1,5)->(2,4) while the server's canonical route is (2,5)->(2,4). The old code
            // returned `undefined` here, which made handleMeleeAttack's move-then-strike fail and the whole
            // turn get rejected — even though the destination is provably reachable and adjacent to the target.
            //
            // The path check exists ONLY to stop a tampered client from spoofing the route it travelled (e.g.
            // faking hasLavaCell/hasWaterCell for a free terrain buff, or claiming a cell it can't actually
            // reach). Reachability is already guaranteed by `knownRoutes` being non-empty, so we do NOT need
            // the client's path to be legal — we substitute the SERVER's own canonical route to that cell
            // (its authoritative terrain flags, never the client's). This preserves the full anti-spoof
            // guarantee while accepting a genuinely-legal move whose animation route merely differed.
            const canonical = this.canonicalRoute(knownRoutes);
            return canonical ? new Map([[key, [canonical]]]) : undefined;
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
            secondary: damage.secondary?.map((entry) => ({ ...entry, position: { ...entry.position } })),
        };
    }
    private serializeAnimations(animationData: IAnimationData[]): IGameAnimationEvent[] {
        if (this.headlessEvents) {
            return [];
        }
        return animationData.map((animation): IGameAnimationEvent => ({
            toPosition: { ...animation.toPosition },
            fromPosition: animation.fromPosition ? { ...animation.fromPosition } : undefined,
            affectedUnitId: animation.affectedUnit instanceof Unit ? animation.affectedUnit.getId() : undefined,
            bodyUnitId: animation.bodyUnit?.getId(),
        }));
    }
    private createAbilityStolenEvents(
        stolen: Array<{ thiefId: string; targetId: string; abilityName: string }> | undefined,
    ): GameEvent[] {
        if (this.headlessEvents) {
            return [];
        }
        return (stolen ?? []).map((entry) => ({ type: "ability_stolen", ...entry }));
    }
    /** Only explicitly resolved hit/response pairs may trigger Infest; unrelated exchange deaths stay unattributed. */
    private createDirectKillAttributions(
        unitIdsDied: string[],
        candidates: Array<{ victim: Unit; killer: Unit }>,
    ): Map<string, Unit> {
        const attributions = new Map<string, Unit>();
        const died = new Set(unitIdsDied);
        for (const { victim, killer } of candidates) {
            if (victim.isDead() && died.has(victim.getId())) {
                attributions.set(victim.getId(), killer);
            }
        }
        return attributions;
    }
    private cleanupDeadUnits(unitIdsDied: string[], killAttributions = new Map<string, Unit>()): GameEvent[] {
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

            const unitName = this.headlessEvents ? "" : unit.getName();
            const corpseCells = unit.getCells();
            const corpseLevel = unit.getLevel();
            const deleted = this.context.unitsHolder.deleteUnitById(unitId, true);
            if (deleted) {
                events.push({ type: "unit_destroyed", unitId, reason: "dead_cleanup" });
                const killer = killAttributions.get(unitId);
                if (killer?.hasAbilityActive("Infest")) {
                    const infested = this.spawnInfestedUnit(killer, corpseLevel, corpseCells);
                    if (infested) {
                        events.push(infested);
                    }
                }
                continue;
            }

            const resurrected = this.context.unitsHolder.getAllUnits().get(unitId);
            if (!this.headlessEvents && resurrected && !resurrected.isDead()) {
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
    private spawnInfestedUnit(killer: Unit, corpseLevel: number, corpseCells: XY[]): GameEvent | undefined {
        if (!this.context.createSummonedUnit || !corpseCells.length) {
            return undefined;
        }

        let unitName: "Arachna Queen" | "Arachna Spider";
        if (corpseLevel === PBTypes.UnitLevelVals.FOURTH) {
            unitName = "Arachna Queen";
        } else if (
            corpseLevel === PBTypes.UnitLevelVals.FIRST ||
            corpseLevel === PBTypes.UnitLevelVals.SECOND ||
            corpseLevel === PBTypes.UnitLevelVals.THIRD
        ) {
            unitName = "Arachna Spider";
        } else {
            return undefined;
        }
        const spawned = this.context.createSummonedUnit({
            team: killer.getTeam(),
            faction: PBTypes.FactionVals.NATURE,
            unitName,
            amount: 1,
            caster: killer,
            sourceAbility: "Infest",
        });
        if (!spawned || this.context.unitsHolder.getAllUnits().has(spawned.getId())) {
            return undefined;
        }

        // Reuse the corpse's own cells when they are exactly the shape the spawn needs, otherwise anchor the
        // spawn on the corpse's ANCHOR cell. Two things were wrong with counting cells: a 1x2 corpse has the
        // same cell COUNT as a 2x1 one, and `corpseCells[0]` is not the anchor — a large body lists its
        // top-LEFT cell first — so a spider rising from a large corpse appeared a column off the body it
        // came from.
        const corpseAnchor = getFootprintAnchorForCells(corpseCells);
        if (!corpseAnchor) {
            return undefined;
        }
        const cells = this.isValidPlacementFootprint(spawned, corpseCells)
            ? corpseCells
            : this.resolveSummonCells(spawned, corpseAnchor);
        const position = getPositionForCells(this.context.grid.getSettings(), cells);
        if (!cells.length || !position) {
            return undefined;
        }
        const occupied = this.context.grid.occupyCells(
            cells,
            spawned.getId(),
            spawned.getTeam(),
            spawned.getAttackRange(),
            spawned.canTraverseLava(),
            spawned.hasAbilityActive("Made of Water"),
        );
        if (!occupied) {
            if (!this.headlessEvents) {
                this.context.sceneLog.updateLog(`${killer.getName()}'s Infest found no room for ${unitName}`);
            }
            return undefined;
        }

        spawned.setPosition(position.x, position.y);
        this.context.unitsHolder.addUnit(spawned);
        if (this.headlessEvents) {
            return undefined;
        }
        this.context.sceneLog.updateLog(`${killer.getName()} infested the fallen stack with ${unitName}`);
        const spawnCell = spawned.getBaseCell();
        this.context.sceneLog.updateLog(`${unitName} spawned at (${spawnCell.x}, ${spawnCell.y})`);
        return {
            type: "unit_summoned",
            casterId: killer.getId(),
            unitId: spawned.getId(),
            team: spawned.getTeam(),
            unitName,
            amount: 1,
            position: { ...spawned.getPosition() },
            cells: structuredClone(cells),
            merged: false,
            sourceAbility: "Infest",
        };
    }
    private reject(rejectionReason: GameActionRejectionReason, message?: string): IGameActionResult {
        return { completed: false, events: [], rejectionReason, message };
    }
}
