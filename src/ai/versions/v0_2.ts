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

import type { GameAction } from "../../engine/actions";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import {
    getRandomGridCellAroundPosition,
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { AttackHandler } from "../../handlers/attack_handler";
import { canCastSpell, canCastSummon, canMassCastSpell } from "../../spells/spell_helper";
import type { Spell } from "../../spells/spell";
import { SpellPowerType, SpellTargetType } from "../../spells/spell_properties";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import { getDistance, type XY } from "../../utils/math";
import { auraCoverageScore, planAuraMove } from "../ai";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { otherTeam, StrategyV0_1 } from "./v0_1";

const isAdjacent = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;
const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
// Hourglass costs the unit morale; A/B showed whether the patience is worth that cost.
const HOURGLASS_ENABLED = false;
// A target at or below this stack power (1..5 scale) retaliates for so little that dodging its
// counter-attack isn't worth re-targeting for.
const NEGLIGIBLE_COUNTER_STACK_POWER = 1;
// Rough melee threat of a stack, used to pick the most valuable no-counter victim.
const meleeThreat = (u: Unit): number => Math.max(1, u.getAttackDamageMax()) * Math.max(1, u.getAmountAlive());
// Griffin's aura ability: silences enemy range attacks within its range.
const NULL_FIELD_AURA_ABILITY = "Range Null Field Aura";

interface IShotPlan {
    aimCell: XY;
    aimSide: RangeAttackCellSide;
    targetId: string;
    /** Expected effective damage (capped at each hit unit's HP; allies hit subtract). */
    score: number;
    /** Whether the trajectory actually hits any enemy RANGE unit (vs only front-line melee). */
    hitsEnemyRange: boolean;
}

/** Σ remaining shots × max per-shot damage for a team's living range units (mirrors ai.ts firepower). */
function teamRangedFirepower(team: number, unitsHolder: UnitsHolder): number {
    let firepower = 0;
    for (const u of unitsHolder.getAllAllies(team)) {
        if (u.isDead() || u.getAttackType() !== RANGE || u.getRangeShots() <= 0) {
            continue;
        }
        firepower += u.getRangeShots() * Math.max(1, u.getAttackDamageMax());
    }
    return firepower;
}

/**
 * v0.2 — smarter ranged play AND a role-aware deployment over the v0.1 baseline.
 *
 * Placement (placeArmy):
 *  - Melee form a centred FRONT wall (highest "frontness", toward the enemy).
 *  - Range + squishy MAGIC support (Healer, Satyr, …) sit on the BACK rows, behind the wall, so the
 *    melee body screens them.
 *  - A "Sniper" range unit (Arbalester — no distance penalty) is tucked into a far BACK CORNER, away
 *    from the main army: it can hit anywhere on the board at full damage, so safety beats proximity.
 *
 * Per-turn ranged AI (decideTurn), all confined to RANGE units:
 *  1. Out of options: a ranged unit that can't LAND a shot (out of ammo, or boxed in) doesn't waste the
 *     turn on a doomed range attack. "No Melee" units advance/hold; others switch to melee.
 *  2. Best shot: when it CAN shoot, it iterates every VISIBLE EDGE of every enemy, scores each shot by
 *     the expected EFFECTIVE damage it deals (per-unit damage capped at that unit's HP, allies hit by
 *     splash subtracted), and fires the best one — sending the exact aim edge to the engine. AOE units
 *     (Cyclops' Large Caliber, Gargantuan's Area Throw) are evaluated with their splash, so a shot that
 *     clusters multiple enemies naturally wins.
 *  3. Patience: if our ranged firepower outclasses theirs but the only shots available hit front-line
 *     melee (their range units are screened), it hourglasses (waits) to fire once the formation opens —
 *     never more than the engine's once-per-lap, so it can't stall.
 */
export class StrategyV0_2 extends StrategyV0_1 {
    public override readonly version: string = "v0.2";
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const placements = new Map<string, XY>();
        const occupied = new Set<number>();
        const legal = context.placement.possibleCellHashes();
        const baseCells = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
        if (!baseCells.length) {
            return placements;
        }

        // "Frontness" grows toward the enemy (LOWER faces up, UPPER faces down). "Edgeness" is distance
        // from the zone's horizontal centre, so a high edgeness = toward a corner.
        const frontness = (c: XY): number => (context.team === PBTypes.TeamVals.LOWER ? c.y : GRID_SIZE - 1 - c.y);
        const xs = baseCells.map((c) => c.x);
        const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const edgeness = (c: XY): number => Math.abs(c.x - centreX);

        const footprintFor = (unit: Unit, base: XY): XY[] =>
            unit.isSmallSize()
                ? [base]
                : [
                      { x: base.x, y: base.y },
                      { x: base.x - 1, y: base.y },
                      { x: base.x, y: base.y - 1 },
                      { x: base.x - 1, y: base.y - 1 },
                  ];

        const placeBy = (unit: Unit, compare: (a: XY, b: XY) => number): void => {
            for (const base of [...baseCells].sort(compare)) {
                const footprint = footprintFor(unit, base);
                if (footprint.some((c) => !legal.has(cellKey(c)) || occupied.has(cellKey(c)))) {
                    continue;
                }
                for (const c of footprint) {
                    occupied.add(cellKey(c));
                }
                placements.set(unit.getId(), { x: base.x, y: base.y });
                return;
            }
        };

        const isSniperRange = (u: Unit): boolean => u.getAttackType() === RANGE && u.hasAbilityActive("Sniper");
        const isMelee = (u: Unit): boolean => u.getAttackType() === MELEE;
        const bySizeLargeFirst = (a: Unit, b: Unit): number => (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1); // large units are harder to fit, place them first

        const snipers = units.filter(isSniperRange).sort(bySizeLargeFirst);
        const melee = units.filter(isMelee).sort(bySizeLargeFirst);
        const backline = units.filter((u) => !isSniperRange(u) && !isMelee(u)).sort(bySizeLargeFirst); // range + magic/support

        // 1. Snipers (Arbalester) -> deepest, most-cornered cell, away from the clash.
        for (const u of snipers) {
            placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(b) - edgeness(a));
        }
        // 2. Melee -> front rows, centred: a wall that screens the backline.
        for (const u of melee) {
            placeBy(u, (a, b) => frontness(b) - frontness(a) || edgeness(a) - edgeness(b));
        }
        // 3. Backline (range + squishy casters/healers) -> back rows, centred, behind the wall.
        for (const u of backline) {
            placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(a) - edgeness(b));
        }

        return placements;
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const isRanged = unit.getAttackType() === RANGE;
        if (isRanged && !this.canLandRange(unit, context)) {
            if (unit.hasAbilityActive("No Melee")) {
                // No melee strike exists for this unit — advance toward the enemy, or hold if pinned.
                return this.fallbackTurn(unit, context);
            }
            return this.meleeFallback(unit, context);
        }
        if (isRanged && context.attackHandler) {
            return this.decideRangedTurn(unit, context, context.attackHandler);
        }
        // MAGIC units (Healer, Satyr) cast a beneficial spell when it's the best turn — heal the most
        // hurt ally, buff/summon, etc. (v0.1 never casts). Falls through to melee when no good cast.
        if (unit.getAttackType() === PBTypes.AttackVals.MAGIC) {
            const spell = this.decideSpellTurn(unit, context);
            if (spell) {
                return spell;
            }
        }
        // Melee defers to v0.1's findTarget for positioning (a custom melee scorer regressed the win
        // rate by throwing away its movement/backstab/engagement work), but refines the VICTIM of an
        // in-place strike: when several enemies are adjacent, prefer one that won't counter-attack.
        // Creature-specific openers: Ogre Mage / Behemoth cast their signature army-wide buff early.
        // They are MELEE_MAGIC, so they fall past the ranged/MAGIC branches above to here.
        const opener = this.decideCreatureOpener(unit, context);
        if (opener) {
            return opener;
        }
        // Griffin: dive the enemy range line, blanket their shooters with the Null Field aura, and
        // melee a ranged unit in the same move (with flying support; see decideGriffinDive).
        const griffin = this.decideGriffinDive(unit, context);
        if (griffin) {
            return griffin;
        }
        const melee = this.preferNoCounterMeleeTarget(unit, context, super.decideTurn(unit, context));
        return this.withAura(unit, context, melee);
    }
    /**
     * MAGIC unit casting (Healer, Satyr), restoring the live server's runAiBuffOrHeal that the port
     * dropped. Picks the highest-value beneficial cast and emits it; undefined when nothing is worth
     * casting (caller falls back to melee). Requested heuristics:
     *  - Satyr "Helping Hand" (HP + armor) → the most numerous LEVEL-1 ally (Fairy/Peasant/…); a big
     *    cheap stack benefits most. Only when a fight is imminent (timed buff won't expire unused).
     *  - Satyr "Summon Wolves" → preferred instead when our ranged army out-guns theirs: spawn bodies
     *    and let the enemy come onto our shots.
     *  - Healer → heal the most-wounded ally (Mass Heal when several are hurt).
     */
    private decideSpellTurn(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        const spells = unit.getSpells();
        if (!spells.length || unit.getStackPower() < 1) {
            return undefined;
        }
        const { grid, matrix, unitsHolder } = context;
        const gridSettings = grid.getSettings();
        const team = unit.getTeam();
        const allies = unitsHolder.getAllAllies(team).filter((u) => !u.isDead());
        if (!allies.length) {
            return undefined;
        }
        const enemies = unitsHolder.getAllEnemyUnits(team).filter((u) => !u.isDead() && !u.hasBuffActive("Hidden"));
        const rangedSuperior =
            teamRangedFirepower(team, unitsHolder) > teamRangedFirepower(otherTeam(team), unitsHolder);
        // "Fighting soon": an enemy is within ~half the board, so a timed buff won't expire unused.
        const nearestEnemyDist = enemies.length
            ? Math.min(...enemies.map((e) => getDistance(unit.getBaseCell(), e.getBaseCell())))
            : Infinity;
        const fightingSoon = nearestEnemyDist <= GRID_SIZE / 2;

        const canCast = (spell: Spell, target?: Unit): boolean =>
            !!canCastSpell(
                false,
                gridSettings,
                matrix,
                unit,
                target,
                spell,
                target?.getBaseCell(),
                target?.getMagicResist(),
                target?.hasMindAttackResistance(),
                target?.canBeHealed(),
                undefined,
            );

        let bestSpell: Spell | undefined;
        let bestTargetId: string | undefined;
        let bestTargetCell: XY | undefined;
        let bestValue = 0;
        const consider = (value: number, spell: Spell, targetId?: string, targetCell?: XY): void => {
            if (value > bestValue) {
                bestValue = value;
                bestSpell = spell;
                bestTargetId = targetId;
                bestTargetCell = targetCell;
            }
        };

        for (const spell of spells) {
            if (spell.getLapsTotal() <= 0 || !spell.isRemaining()) {
                continue;
            }
            if (spell.getMinimalCasterStackPower() > unit.getStackPower()) {
                continue;
            }
            const targetType = spell.getSpellTargetType();
            const isHeal = spell.getPowerType() === SpellPowerType.HEAL;
            const candidates = spell.isSelfCastAllowed() ? allies : allies.filter((a) => a.getId() !== unit.getId());

            // Summon Wolves: strongly preferred when our ranged army is stronger (stand and shoot), else low.
            if (spell.isSummon() && targetType === SpellTargetType.RANDOM_CLOSE_TO_CASTER) {
                const amount = Math.floor(unit.getAmountAlive() * spell.getPower());
                const cell = getRandomGridCellAroundPosition(gridSettings, matrix, team, unit.getPosition());
                if (amount > 0 && cell && canCastSummon(spell, matrix, cell)) {
                    consider(amount * (rangedSuperior ? 60 : 3), spell, undefined, cell);
                }
                continue;
            }

            if (!spell.isBuff() && !isHeal) {
                continue; // v0.2 casts only beneficial spells (heal/buff/summon)
            }
            if (targetType === SpellTargetType.ALL_ALLIES || targetType === SpellTargetType.ALL_FLYING) {
                const pool =
                    targetType === SpellTargetType.ALL_FLYING ? candidates.filter((a) => a.canFly()) : candidates;
                const beneficiaries = pool.filter((a) =>
                    isHeal ? a.getHp() < a.getMaxHp() : !a.hasBuffActive(spell.getName()),
                );
                if (beneficiaries.length && (isHeal || fightingSoon)) {
                    consider(beneficiaries.length * 200, spell);
                }
            } else if (targetType === SpellTargetType.ANY_ALLY) {
                let target: Unit | undefined;
                let value = 0;
                if (isHeal) {
                    for (const a of candidates) {
                        const missing = a.getMaxHp() - a.getHp();
                        if (missing > value) {
                            value = missing;
                            target = a;
                        }
                    }
                } else if (fightingSoon) {
                    // Buff (Helping Hand / Blessing / …): the most numerous LEVEL-1 stack benefits most.
                    const helpingHand = spell.getName() === "Helping Hand";
                    for (const a of candidates) {
                        if (a.hasBuffActive(spell.getName())) {
                            continue;
                        }
                        if (helpingHand && a.getLevel() !== PBTypes.UnitLevelVals.FIRST) {
                            continue;
                        }
                        const c = helpingHand ? a.getAmountAlive() * 10 : meleeThreat(a);
                        if (c > value) {
                            value = c;
                            target = a;
                        }
                    }
                }
                if (target && canCast(spell, target)) {
                    consider(value, spell, target.getId());
                }
            }
        }

        if (!bestSpell) {
            return undefined;
        }
        return [
            {
                type: "cast_spell",
                casterId: unit.getId(),
                spellName: bestSpell.getName(),
                targetId: bestTargetId,
                targetCell: bestTargetCell,
            },
        ];
    }
    /**
     * Aura emitters earn their keep by keeping the buff/debuff on as many allies as possible. When the
     * unit would otherwise just move (no attack worth taking), reposition for the best coverage; if no
     * move helps yet but more allies will come into range, HOURGLASS first to hold the aura up and
     * re-cover after the army shuffles (the user's "keep giving the aura for longer"); and never let the
     * default advance drag the aura OFF its current targets. Non-aura units pass straight through.
     */
    private withAura(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        // Attacking (or casting) is the better turn — don't trade it for positioning.
        if (decision.some((a) => a.type === "melee_attack" || a.type === "range_attack" || a.type === "cast_spell")) {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const gridSettings = grid.getSettings();
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(otherTeam(unit.getTeam())),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        const plan = planAuraMove(unit, movePath.knownPaths, gridSettings, matrix, unitsHolder);
        if (!plan) {
            return decision; // not an aura emitter
        }

        const base = unit.getBaseCell();
        const movesElsewhere = plan.bestCell.x !== base.x || plan.bestCell.y !== base.y;

        // 1) A reachable cell covers more allies — move there.
        if (plan.bestScore > plan.currentScore && movesElsewhere && unit.canMove()) {
            const route = movePath.knownPaths.get(cellKey(plan.bestCell))?.[0];
            if (route?.route.length) {
                return [
                    {
                        type: "move_unit",
                        unitId: unit.getId(),
                        path: route.route.map((c) => ({ x: c.x, y: c.y })),
                        targetCells: this.footprintForCell(unit, plan.bestCell, context),
                        hasLavaCell: route.hasLavaCell,
                        hasWaterCell: route.hasWaterCell,
                    },
                ];
            }
        }
        // 2) Hourglass first: nothing better to cover yet, but targets remain out of range and we're not
        //    under melee pressure — wait so allies move into the aura and we re-cover, keeping it up.
        if (
            plan.bestScore <= plan.currentScore &&
            plan.bestScore < plan.coverableTargets &&
            plan.currentThreats === 0 &&
            this.canHourglass(unit, context)
        ) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        // 3) The default advance would drag the aura OFF allies — hold position instead.
        const defaultMove = decision.find((a) => a.type === "move_unit");
        if (defaultMove?.type === "move_unit" && defaultMove.path?.length) {
            const dest = defaultMove.path[defaultMove.path.length - 1];
            if (auraCoverageScore(unit, dest, gridSettings, unitsHolder) < plan.currentScore) {
                return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
            }
        }
        return decision;
    }
    /** Whether the engine will accept a hourglass (wait) for this unit this lap. */
    private canHourglass(unit: Unit, context: IDecisionContext): boolean {
        const fp = context.fightProperties;
        return (
            !!fp &&
            fp.getTeamUnitsAlive(unit.getTeam()) > 1 &&
            !unit.isOnHourglass() &&
            !fp.hourglassIncludes(unit.getId()) &&
            !fp.hasAlreadyHourglass(unit.getId()) &&
            !fp.hasAlreadyMadeTurn(unit.getId())
        );
    }
    /**
     * Would attacking `target` in melee provoke a counter-attack worth dodging? No if it already used
     * its response this lap (engine bars a second), can't respond (stun/blind/no-melee), or its stack
     * is so small the retaliation is negligible.
     */
    private counterMatters(target: Unit): boolean {
        if (target.getStackPower() <= NEGLIGIBLE_COUNTER_STACK_POWER) {
            return false;
        }
        if (FightStateManager.getInstance().getFightProperties().hasAlreadyRepliedAttack(target.getId())) {
            return false;
        }
        return target.canRespond(MELEE);
    }
    /**
     * Refine the victim of an IN-PLACE melee strike to avoid a meaningful counter: if the chosen target
     * would retaliate but another equally-adjacent enemy wouldn't (already responded / can't respond /
     * tiny stack), hit that one instead — same position, no counter taken, so a free advantage. Picks
     * the most threatening such enemy. Never overrides a forced target, and never touches a
     * move-and-strike (whose stand cell was positioned for, e.g. a backstab).
     */
    private preferNoCounterMeleeTarget(unit: Unit, context: IDecisionContext, actions: GameAction[]): GameAction[] {
        if (unit.getTarget()) {
            return actions; // forced to attack a specific unit — respect it
        }
        const idx = actions.findIndex((a) => a.type === "melee_attack");
        if (idx < 0) {
            return actions;
        }
        const strike = actions[idx];
        if (strike.type !== "melee_attack") {
            return actions;
        }
        // In-place only: a move-and-strike carries a path and a non-current attackFrom.
        const unitCell = unit.getBaseCell();
        if (
            (strike.path && strike.path.length > 0) ||
            !strike.attackFrom ||
            strike.attackFrom.x !== unitCell.x ||
            strike.attackFrom.y !== unitCell.y
        ) {
            return actions;
        }

        const current = context.unitsHolder.getAllUnits().get(strike.targetId);
        if (!current || !this.counterMatters(current)) {
            return actions; // already a no-counter (or tiny) victim — nothing to gain
        }

        const myCells = unit.getCells();
        const alternatives = context.unitsHolder
            .getAllAllies(otherTeam(unit.getTeam()))
            .filter(
                (e) =>
                    e.getId() !== current.getId() &&
                    !e.isDead() &&
                    !e.hasBuffActive("Hidden") &&
                    // A meaningful stack (not a trivial one we'd waste the hit on) that still won't
                    // counter — i.e. it already responded or can't respond.
                    e.getStackPower() > NEGLIGIBLE_COUNTER_STACK_POWER &&
                    !this.counterMatters(e) &&
                    e.getCells().some((ec) => myCells.some((uc) => isAdjacent(ec, uc))),
            )
            .sort((p, q) => meleeThreat(q) - meleeThreat(p));

        if (!alternatives.length) {
            return actions;
        }
        const swapped = [...actions];
        swapped[idx] = { ...strike, targetId: alternatives[0].getId() };
        return swapped;
    }
    /** A ranged unit that CAN shoot: pick the best visible-edge shot, or hourglass to wait for a better one. */
    private decideRangedTurn(unit: Unit, context: IDecisionContext, attackHandler: AttackHandler): GameAction[] {
        const best = this.findBestShot(unit, context, attackHandler);
        if (!best) {
            // No worthwhile shot found — let v0.1 decide (it may move/engage).
            return super.decideTurn(unit, context);
        }
        if (HOURGLASS_ENABLED && this.shouldHourglass(unit, context, best)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        const actions: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== RANGE) {
            actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: RANGE });
        }
        actions.push({
            type: "range_attack",
            attackerId: unit.getId(),
            targetId: best.targetId,
            aimCell: best.aimCell,
            aimSide: best.aimSide,
        });
        return actions;
    }
    /**
     * Evaluate a shot at EVERY observable edge of EVERY enemy and return the one with the highest
     * expected effective damage. Effective damage = per-hit-unit expected damage (mean of min/max,
     * pure — no RNG, no ammo spent) capped at that unit's remaining HP, summed over everyone the shot
     * actually hits (occlusion handled by evaluateRangeAttack); allies caught in splash subtract.
     */
    private findBestShot(unit: Unit, context: IDecisionContext, attackHandler: AttackHandler): IShotPlan | undefined {
        const { grid, unitsHolder } = context;
        const matrix = grid.getMatrix();
        const gridSettings = grid.getSettings();
        const allUnits = unitsHolder.getAllUnits();
        const fromTeam = unit.getTeam();
        const enemyTeam = otherTeam(fromTeam);
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
        const isAOE = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
        const isThroughShot = unit.hasAbilityActive("Through Shot");
        const from = unit.getPosition();

        let best: IShotPlan | undefined;
        for (const enemy of enemies) {
            for (const cell of enemy.getCells()) {
                for (const side of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(matrix, cell, side, fromTeam, isThroughShot)) {
                        continue;
                    }
                    const to = getRangeAttackSideCenter(gridSettings, cell, side, from);
                    const evaluation = attackHandler.evaluateRangeAttack(
                        allUnits,
                        unit,
                        from,
                        to,
                        isThroughShot,
                        false,
                        isAOE,
                    );
                    const scored = this.scoreShot(unit, evaluation, fromTeam, enemyTeam);
                    if (scored.value <= 0) {
                        continue;
                    }
                    if (!best || scored.value > best.score) {
                        best = {
                            aimCell: { x: cell.x, y: cell.y },
                            aimSide: side,
                            targetId: enemy.getId(),
                            score: scored.value,
                            hitsEnemyRange: scored.hitsEnemyRange,
                        };
                    }
                }
            }
        }
        return best;
    }
    /** Sum expected effective damage over everyone a shot hits; enemies add, friendly-fire subtracts. */
    private scoreShot(
        unit: Unit,
        evaluation: ReturnType<AttackHandler["evaluateRangeAttack"]>,
        fromTeam: number,
        enemyTeam: number,
    ): { value: number; hitsEnemyRange: boolean } {
        let value = 0;
        let hitsEnemyRange = false;
        const counted = new Set<string>();
        for (let i = 0; i < evaluation.affectedUnits.length; i += 1) {
            const divisor = evaluation.rangeAttackDivisors[i] ?? 1;
            for (const target of evaluation.affectedUnits[i]) {
                if (counted.has(target.getId())) {
                    continue;
                }
                counted.add(target.getId());
                const min = unit.calculateAttackDamageMin(unit.getAttack(), target, true, 0, divisor);
                const max = unit.calculateAttackDamageMax(unit.getAttack(), target, true, 0, divisor);
                const targetHp = target.getCumulativeHp();
                const effective = Math.min((min + max) / 2, targetHp);
                if (target.getTeam() === enemyTeam) {
                    // Pure expected effective damage — A/B showed threat/finish weightings only hurt the
                    // win rate. AOE still wins naturally by summing every unit the splash hits.
                    value += effective;
                    if (target.getAttackType() === RANGE) {
                        hitsEnemyRange = true;
                    }
                } else if (target.getTeam() === fromTeam) {
                    value -= effective; // friendly fire (AOE splash) is a cost
                }
            }
        }
        return { value, hitsEnemyRange };
    }
    /**
     * Wait (hourglass) instead of firing when: we out-gun them on ranged firepower, the best shot can
     * only reach front-line melee (their range units are still screened), and the engine lets the unit
     * hourglass this lap. Mirrored armies have equal firepower, so this never triggers in self-play — it
     * only matters in asymmetric (real) matchups, where it lets a ranged-superior army wait for a better
     * shot once the enemy closes and the screen opens.
     */
    private shouldHourglass(unit: Unit, context: IDecisionContext, best: IShotPlan): boolean {
        const fp = context.fightProperties;
        if (!fp || best.hitsEnemyRange) {
            return false;
        }
        const fromTeam = unit.getTeam();
        const enemyTeam = otherTeam(fromTeam);
        const { unitsHolder } = context;

        // Only worth waiting if the enemy actually has a screened range unit to expose later.
        const enemyHasRange = unitsHolder
            .getAllAllies(enemyTeam)
            .some((u) => !u.isDead() && u.getAttackType() === RANGE && u.getRangeShots() > 0);
        if (!enemyHasRange) {
            return false;
        }
        if (teamRangedFirepower(fromTeam, unitsHolder) <= teamRangedFirepower(enemyTeam, unitsHolder)) {
            return false;
        }
        // Respect the engine's hourglass rules so the proposal is never rejected (which would waste the turn).
        return (
            fp.getTeamUnitsAlive(fromTeam) > 1 &&
            !unit.isOnHourglass() &&
            !fp.hourglassIncludes(unit.getId()) &&
            !fp.hasAlreadyHourglass(unit.getId()) &&
            !fp.hasAlreadyMadeTurn(unit.getId())
        );
    }
    /** Can the unit land a ranged shot right now (not boxed in / suppressed)? Falls back to ammo count. */
    protected canLandRange(unit: Unit, context: IDecisionContext): boolean {
        const handler = context.attackHandler;
        if (handler) {
            return handler.canLandRangeAttack(unit, context.grid.getEnemyAggrMatrixByUnitId(unit.getId()));
        }
        return unit.getRangeShots() > 0;
    }
    /** A ranged-but-can't-shoot unit that DOES have melee: strike / move-and-strike / advance. */
    private meleeFallback(unit: Unit, context: IDecisionContext): GameAction[] {
        const needSelect = unit.getAttackTypeSelection() !== PBTypes.AttackVals.MELEE;
        const selectAction: GameAction = {
            type: "select_attack_type",
            unitId: unit.getId(),
            attackType: PBTypes.AttackVals.MELEE,
        };
        const withSelect = (actions: GameAction[]): GameAction[] => (needSelect ? [selectAction, ...actions] : actions);

        // 1) Enemy already adjacent — strike in place.
        const adjacent = this.adjacentEnemy(unit, context);
        if (adjacent) {
            return withSelect([
                {
                    type: "melee_attack",
                    attackerId: unit.getId(),
                    targetId: adjacent,
                    attackFrom: { ...unit.getBaseCell() },
                },
            ]);
        }

        // 2) Can reach a cell next to an enemy this turn — move and strike.
        const approach = this.meleeApproach(unit, context);
        if (approach) {
            return withSelect([
                {
                    type: "melee_attack",
                    attackerId: unit.getId(),
                    targetId: approach.targetId,
                    attackFrom: approach.attackFrom,
                    path: approach.route,
                    hasLavaCell: approach.hasLavaCell,
                    hasWaterCell: approach.hasWaterCell,
                },
            ]);
        }

        // 3) Otherwise advance toward the enemy (fallbackTurn holds the turn if it can't move).
        const advance = this.fallbackTurn(unit, context);
        if (advance.length === 1 && advance[0].type === "end_turn") {
            return advance; // pinned: no point flipping to melee
        }
        return withSelect(advance);
    }
    /** The id of a living enemy whose footprint touches the unit's footprint, if any. */
    /** The army-wide opening buff a specific creature should cast at the start of the fight, if any. */
    private creatureOpenerSpell(unit: Unit): string | undefined {
        if (!unit.getCanCastSpells()) {
            return undefined;
        }
        const name = unit.getName();
        if (name === "Ogre Mage") {
            return "Mass Riot"; // almost always worth casting first (+25% damage to the whole army)
        }
        if (name === "Behemoth") {
            return "Battle Roar"; // first-turn army buff: +steps and guaranteed max damage
        }
        return undefined;
    }
    /**
     * Cast a creature's signature opener (Ogre Mage -> Mass Riot, Behemoth -> Battle Roar) when it's
     * still worth it. Ogre Mage prefers to melee an adjacent enemy instead (a guaranteed hit beats the
     * buff that turn). Returns undefined to fall through to normal melee logic.
     */
    private decideCreatureOpener(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        const spellName = this.creatureOpenerSpell(unit);
        if (!spellName) {
            return undefined;
        }
        // Ogre Mage: if it can strike an adjacent enemy this turn, do that rather than cast.
        if (unit.getName() === "Ogre Mage" && this.adjacentEnemy(unit, context)) {
            return undefined;
        }
        const spell = unit.getSpells().find((s) => s.getName() === spellName);
        if (
            !spell ||
            spell.getLapsTotal() <= 0 ||
            !spell.isRemaining() ||
            spell.getMinimalCasterStackPower() > unit.getStackPower()
        ) {
            return undefined;
        }
        // These are ALL_ALLIES mass buffs: only cast while the team isn't already covered (this is also
        // the engine's own gate, so a redundant cast is never proposed and the turn is never wasted).
        const team = unit.getTeam();
        const uh = context.unitsHolder;
        const castable = canMassCastSpell(
            spell,
            uh.getAllTeamUnitsBuffs(team),
            uh.getAllEnemyUnitsBuffs(team),
            uh.getAllEnemyUnitsDebuffs(team),
            uh.getAllTeamUnitsMagicResist(team),
            uh.getAllEnemyUnitsMagicResist(team),
            uh.getAllTeamUnitsHp(team),
            uh.getAllTeamUnitsMaxHp(team),
            uh.getAllTeamUnitsCanFly(team),
            uh.getAllEnemyUnitsCanFly(team),
        );
        if (!castable) {
            return undefined;
        }
        return [{ type: "cast_spell", casterId: unit.getId(), spellName }];
    }
    /** The range of this unit's Null Field (range-silencing) debuff aura, or 0 if it has none. */
    private nullFieldRange(unit: Unit): number {
        let range = 0;
        for (const aura of unit.getAuraEffects()) {
            if (!aura.getProperties().is_buff) {
                range = Math.max(range, aura.getRange());
            }
        }
        return range;
    }
    /** Living enemy RANGE units — the ones the Null Field silences. */
    private livingEnemyRanged(unit: Unit, context: IDecisionContext): Unit[] {
        return context.unitsHolder
            .getAllAllies(otherTeam(unit.getTeam()))
            .filter((e) => !e.isDead() && e.getAttackType() === RANGE);
    }
    /**
     * Don't dive the backline alone: only commit when another living flying ally is close enough to the
     * enemy range line to come in too (so the Griffin isn't focused down on its own).
     */
    private hasFlyingSupport(unit: Unit, context: IDecisionContext, enemyRanged: Unit[]): boolean {
        const auraR = this.nullFieldRange(unit);
        const nearestBackline = (a: Unit): number =>
            Math.min(...enemyRanged.map((r) => getDistance(a.getBaseCell(), r.getBaseCell())));
        return context.unitsHolder
            .getAllAllies(unit.getTeam())
            .some(
                (a) =>
                    a.getId() !== unit.getId() &&
                    !a.isDead() &&
                    a.canFly() &&
                    nearestBackline(a) <= a.getSteps() + auraR + 2,
            );
    }
    /**
     * Griffin (Range Null Field aura): fly to the enemy's range line, land where the MOST enemy RANGE
     * units fall inside the aura (silencing their shots) and melee one of them in the same move. Only
     * with flying support and only when the enemy actually fields ranged units; otherwise returns
     * undefined to behave like a normal melee unit. If it can't reach a strike cell yet, it advances
     * toward the coverage instead.
     */
    private decideGriffinDive(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        if (!unit.hasAbilityActive(NULL_FIELD_AURA_ABILITY) || !unit.canMove()) {
            return undefined;
        }
        const enemyRanged = this.livingEnemyRanged(unit, context);
        if (!enemyRanged.length) {
            return undefined; // no shooters to silence -> behave as a regular melee unit
        }
        if (!this.hasFlyingSupport(unit, context, enemyRanged)) {
            return undefined; // never dive the backline solo
        }
        const { grid, matrix, pathHelper } = context;
        const auraR = this.nullFieldRange(unit);
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(otherTeam(unit.getTeam())),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        const coverage = (cell: XY): number =>
            enemyRanged.filter((r) => getDistance(cell, r.getBaseCell()) <= auraR).length;

        let strike: { cell: XY; targetId: string; cover: number; weight: number } | undefined;
        let advance: { cell: XY; cover: number; weight: number } | undefined;
        for (const [key, routes] of movePath.knownPaths) {
            const cell = { x: (key >> 4) & 0xf, y: key & 0xf };
            const cover = coverage(cell);
            if (cover <= 0) {
                continue;
            }
            const weight = routes?.[0]?.weight ?? Infinity;
            if (!advance || cover > advance.cover || (cover === advance.cover && weight < advance.weight)) {
                advance = { cell, cover, weight };
            }
            const adj = enemyRanged.find((r) =>
                r.getCells().some((rc) => Math.abs(rc.x - cell.x) <= 1 && Math.abs(rc.y - cell.y) <= 1),
            );
            if (adj && (!strike || cover > strike.cover || (cover === strike.cover && weight < strike.weight))) {
                strike = { cell, targetId: adj.getId(), cover, weight };
            }
        }

        if (strike) {
            const route = movePath.knownPaths.get(cellKey(strike.cell))?.[0];
            const actions: GameAction[] = [];
            if (unit.getAttackTypeSelection() !== MELEE) {
                actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
            }
            actions.push({
                type: "melee_attack",
                attackerId: unit.getId(),
                targetId: strike.targetId,
                attackFrom: { x: strike.cell.x, y: strike.cell.y },
                path: route?.route.map((c) => ({ x: c.x, y: c.y })),
                hasLavaCell: route?.hasLavaCell,
                hasWaterCell: route?.hasWaterCell,
            });
            return actions;
        }
        const base = unit.getBaseCell();
        if (advance && (advance.cell.x !== base.x || advance.cell.y !== base.y)) {
            const route = movePath.knownPaths.get(cellKey(advance.cell))?.[0];
            if (route?.route.length) {
                return [
                    {
                        type: "move_unit",
                        unitId: unit.getId(),
                        path: route.route.map((c) => ({ x: c.x, y: c.y })),
                        targetCells: this.footprintForCell(unit, advance.cell, context),
                        hasLavaCell: route.hasLavaCell,
                        hasWaterCell: route.hasWaterCell,
                    },
                ];
            }
        }
        return undefined;
    }
    private adjacentEnemy(unit: Unit, context: IDecisionContext): string | undefined {
        const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((u) => !u.isDead());
        const myCells = unit.getCells();
        for (const enemy of enemies) {
            for (const ec of enemy.getCells()) {
                if (myCells.some((uc) => isAdjacent(ec, uc))) {
                    return enemy.getId();
                }
            }
        }
        return undefined;
    }
    /** Shortest reachable stand-cell whose footprint is adjacent to an enemy (a move-and-melee), if any. */
    private meleeApproach(
        unit: Unit,
        context: IDecisionContext,
    ): { attackFrom: XY; targetId: string; route: XY[]; hasLavaCell?: boolean; hasWaterCell?: boolean } | undefined {
        if (!unit.canMove()) {
            return undefined;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
        if (!enemies.length) {
            return undefined;
        }
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        if (!movePath.knownPaths.size) {
            return undefined;
        }

        let best: { attackFrom: XY; targetId: string; route: IWeightedRoute } | undefined;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            const footprint = this.footprintForCell(unit, route.cell, context);
            for (const enemy of enemies) {
                const touches = enemy.getCells().some((ec) => footprint.some((fc) => isAdjacent(ec, fc)));
                if (touches) {
                    if (!best || route.route.length < best.route.route.length) {
                        best = { attackFrom: { x: route.cell.x, y: route.cell.y }, targetId: enemy.getId(), route };
                    }
                    break;
                }
            }
        }
        if (!best) {
            return undefined;
        }
        return {
            attackFrom: best.attackFrom,
            targetId: best.targetId,
            route: best.route.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route.hasLavaCell,
            hasWaterCell: best.route.hasWaterCell,
        };
    }
}

export const STRATEGY_V0_2: IAIStrategy = new StrategyV0_2();
