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
import { PBTypes } from "../../generated/protobuf/v1/types";
import { canCastSpell } from "../../spells/spell_helper";
import { SpellPowerType, SpellTargetType } from "../../spells/spell_properties";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { teamRangedFirepower } from "./v0_2";
import { StrategyV0_3 } from "./v0_3";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;
const isAdjacentCell = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;

// Enemy "siege" units: huge ranged threats worth muting on sight by diving them with our flyers.
const SIEGE_UNITS = new Set(["Gargantuan", "Tsar Cannon"]);
// Only spend a single-target heal on a stack that is down more than this fraction of its full HP.
const HEAL_WOUND_THRESHOLD = 0.25;
const firepowerOf = (u: Unit): number => Math.max(1, u.getRangeShots()) * Math.max(1, u.getAttackDamageMax());
// Mass Riot wants a big army to be worth it; below this many living allies an Ogre Mage prefers single Riot.
const OGRE_BIG_ARMY = 3;

// Flyer "mute the siege" tactic — DISABLED. A 10k mirror A/B showed it LOSES 65% of the games where it
// fires: the flyer over-extends to dive an enemy Gargantuan/Tsar Cannon, dies at lap ~3.6 (vs 8.3 when
// off) to enemy focus-fire, and ends up landing FEWER siege strikes than just playing normally. Net
// ~-3.6pp vs v0.3. Flag kept so the behaviour can be re-tested behind a survival/support gate later.
const MUTE_SIEGE_ENABLED = false;

// AoE / multi-hit threats: against these, clustered or cornered stacks get caught by one blow, so we spread
// out at deployment. Detected by signature ability (robust to renames) or by unit name.
const AOE_ABILITIES = ["Area Throw", "Fire Breath", "Through Shot", "Skewer Strike", "Large Caliber"];
const AOE_NAMES = new Set(["Black Dragon", "Pikeman", "Gargantuan", "Cyclops", "Tsar Cannon"]);
const isAoEUnit = (u: Unit): boolean =>
    AOE_NAMES.has(u.getName()) || AOE_ABILITIES.some((ab) => u.hasAbilityActive(ab));

/**
 * v0.4 — extends the v0.3 champion with four requested human-tactics overrides. Each is a guarded branch
 * that falls through to v0.3 when it does not apply, and every action it emits is built from the same
 * validated path/strike machinery v0.2/v0.3 use (so the engine never rejects one). The four tactics:
 *
 *  1. Healer focus: a single-target heal goes to the BIGGEST-HP stack that is down >25% of its HP (keep the
 *     most valuable stacks topped up; don't waste a heal on a scratch).
 *  2. Ranged-superiority patience: once our remaining ranged firepower out-guns theirs, a shooter that
 *     cannot fire this turn HOLDS (waits for them to walk onto our shots) rather than advancing into them.
 *  3. Mute the siege: when the enemy fields a Gargantuan or Tsar Cannon, our flyers rush and strike it
 *     immediately (backline support stays put) to shut its firepower down.
 *  4. Buffed strikes: a melee "move + attack" relocates its stand cell to one still adjacent to the target
 *     but inside MORE friendly buff auras, so the attacker fights under the buff (auras win fights).
 *
 * Note: a fifth idea — deploying a Wolf Rider roster fully forward — was tried and dropped: it measured
 * ~2.2pp WORSE than v0.3 (it throws away v0.3's cornered-shooter placement edge), so v0.4 keeps v0.3's
 * deployment. These four are ~win-rate-neutral vs v0.3 (which already focus-fires shooters, advances
 * cohesively, and keeps aura emitters covering); they encode the requested behaviour at no measurable cost.
 * See PROTOCOL.md / the v0.4 tests.
 */
export class StrategyV0_4 extends StrategyV0_3 {
    public override readonly version: string = "v0.4";
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        // (3) Flyers rush an enemy siege unit (Gargantuan / Tsar Cannon) to mute it. DISABLED via flag:
        // it over-extends the flyer and loses (see MUTE_SIEGE_ENABLED). Kept gated for future re-testing.
        if (MUTE_SIEGE_ENABLED && unit.canFly() && unit.getAttackType() === MELEE && unit.canMove()) {
            const mute = this.flyerMuteSiege(unit, context);
            if (mute) {
                return mute;
            }
        }
        // (2) Once we out-gun them at range, a shooter that can't fire yet holds instead of closing.
        if (unit.getAttackType() === RANGE && unit.getRangeShots() > 0 && unit.canMove()) {
            const hold = this.holdWhenRangedSuperior(unit, context);
            if (hold) {
                return hold;
            }
        }
        // (1) v0.3's decision, then re-aim a single-target heal at the biggest sufficiently-wounded stack,
        // and (4) when landing a melee strike, prefer an equally-good stand cell that sits inside a friendly
        // aura (so the attacker fights buffed).
        // (6) Ogre Mage opener: it melees from its current cell if it can (a strong unit) -> v0.2 handles
        // that and the big-army Mass Riot. The gap we fill: a small-army Ogre Mage that can't melee and is
        // not yet riot-buffed still self-buffs with single Riot (+25% damage) instead of doing nothing.
        if (unit.getName() === "Ogre Mage" && unit.canMove()) {
            const riot = this.ogreMageSingleRiot(unit, context);
            if (riot) {
                return riot;
            }
        }
        const base = super.decideTurn(unit, context);
        return this.auraRepositionMelee(unit, context, this.retargetHeal(unit, context, base));
    }
    /**
     * (5b) Don't clump into AoE: when the enemy fields an AoE / multi-hit unit, suppress v0.3's melee
     * cohesion so the army stays spread (paired with the spread deployment) and no single blow catches the
     * pack. With no enemy AoE, cohesion stays on (v0.3's +9.7pp behaviour).
     */
    protected override shouldCohere(unit: Unit, context: IDecisionContext): boolean {
        return !context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).some((e) => !e.isDead() && isAoEUnit(e));
    }
    /**
     * (6) A lone/small-army Ogre Mage that can't strike from where it stands, and isn't already riot-buffed,
     * self-casts single Riot (+25% damage). Mass Riot is left to v0.2's opener for big armies; melee-if-
     * adjacent is left to v0.2 too. Validated with canCastSpell so the engine never rejects it.
     */
    private ogreMageSingleRiot(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        const myCells = unit.getCells();
        const canMeleeHere = context.unitsHolder
            .getAllAllies(otherTeam(unit.getTeam()))
            .some((e) => !e.isDead() && e.getCells().some((ec) => myCells.some((uc) => isAdjacentCell(ec, uc))));
        if (canMeleeHere || unit.hasBuffActive("Riot") || unit.hasBuffActive("Mass Riot")) {
            return undefined; // melee beats casting, or already riot-buffed -> let v0.2 decide
        }
        const livingAllies = context.unitsHolder.getAllAllies(unit.getTeam()).filter((a) => !a.isDead()).length;
        if (livingAllies >= OGRE_BIG_ARMY) {
            return undefined; // big army -> v0.2's opener casts Mass Riot instead
        }
        const spell = unit.getSpells().find((s) => s.getName() === "Riot");
        if (
            !spell ||
            !spell.isRemaining() ||
            spell.getLapsTotal() <= 0 ||
            spell.getMinimalCasterStackPower() > unit.getStackPower()
        ) {
            return undefined;
        }
        const ok = canCastSpell(
            false,
            context.grid.getSettings(),
            context.matrix,
            unit,
            unit,
            spell,
            unit.getBaseCell(),
            unit.getMagicResist(),
            unit.hasMindAttackResistance(),
            unit.canBeHealed(),
            undefined,
        );
        if (!ok) {
            return undefined;
        }
        return [{ type: "cast_spell", casterId: unit.getId(), spellName: "Riot", targetId: unit.getId() }];
    }
    /** How many friendly BUFF auras cover a cell (receiver-side: is the unit standing inside an ally's aura). */
    private friendlyAuraCover(cell: XY, unit: Unit, context: IDecisionContext): number {
        let n = 0;
        for (const a of context.unitsHolder.getAllAllies(unit.getTeam())) {
            if (a.isDead() || a.getId() === unit.getId()) {
                continue;
            }
            for (const aura of a.getAuraEffects()) {
                if (aura.getProperties().is_buff && getDistance(cell, a.getBaseCell()) <= aura.getRange()) {
                    n += 1;
                    break; // one buff aura from this ally is enough to count it as a covering ally
                }
            }
        }
        return n;
    }
    /**
     * (4) Auras are powerful and keeping them on our units wins fights. When v0.3's decision is a melee
     * strike, relocate the stand cell to one that is ALSO adjacent to the same target (so the strike still
     * lands) but sits inside MORE friendly buff auras — turning a "move + attack" into one that finishes
     * buffed. Only ever swaps to a reachable, still-valid strike cell, and only when it strictly increases
     * aura coverage, so it never trades the attack away.
     */
    private auraRepositionMelee(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (unit.getTarget()) {
            return decision; // a forced target was positioned deliberately — don't second-guess it
        }
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack" || !unit.canMove()) {
            return decision;
        }
        const target = context.unitsHolder.getAllUnits().get(strike.targetId);
        if (!target) {
            return decision;
        }
        const currentCell = strike.attackFrom ?? unit.getBaseCell();
        const currentCover = this.friendlyAuraCover(currentCell, unit, context);
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(otherTeam(unit.getTeam())),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        const adjToTarget = (cell: XY): boolean => target.getCells().some((tc) => isAdjacentCell(tc, cell));
        let best: { cell: XY; cover: number; weight: number } | undefined;
        for (const [key, routes] of movePath.knownPaths) {
            const cell = { x: (key >> 4) & 0xf, y: key & 0xf };
            const route = routes?.[0];
            if (!route?.route.length || !adjToTarget(cell)) {
                continue;
            }
            const cover = this.friendlyAuraCover(cell, unit, context);
            const weight = route.weight ?? Infinity;
            if (!best || cover > best.cover || (cover === best.cover && weight < best.weight)) {
                best = { cell, cover, weight };
            }
        }
        if (!best || best.cover <= currentCover) {
            return decision; // already as buffed as we can be, or no buffed strike cell within reach
        }
        const route = movePath.knownPaths.get(cellKey(best.cell))?.[0];
        const swapped = [...decision];
        swapped[idx] = {
            ...strike,
            attackFrom: { x: best.cell.x, y: best.cell.y },
            path: route?.route.map((c) => ({ x: c.x, y: c.y })) ?? strike.path,
            hasLavaCell: route?.hasLavaCell ?? strike.hasLavaCell,
            hasWaterCell: route?.hasWaterCell ?? strike.hasWaterCell,
        };
        return swapped;
    }
    /** (1) Re-aim a single-target HEAL onto the biggest-HP ally that is down more than 25% of its HP. */
    private retargetHeal(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const only = decision.length === 1 ? decision[0] : undefined;
        if (!only || only.type !== "cast_spell" || !only.targetId) {
            return decision; // not a single-target cast we should second-guess
        }
        const spell = unit.getSpells().find((s) => s.getName() === only.spellName);
        if (
            !spell ||
            spell.getPowerType() !== SpellPowerType.HEAL ||
            spell.getSpellTargetType() !== SpellTargetType.ANY_ALLY
        ) {
            return decision;
        }
        const fullCap = (a: Unit): number => a.getMaxHp() * Math.max(1, a.getAmountAlive() + a.getAmountDied());
        const woundFrac = (a: Unit): number => {
            const cap = fullCap(a);
            return cap > 0 ? 1 - a.getCumulativeHp() / cap : 0;
        };
        // Only retarget to a unit the engine will actually ACCEPT the heal on — mirrors the engine's gate
        // (range / resist / can-be-healed). Without this the swap can pick a valid-looking but un-castable
        // target and the engine rejects it ("spell_not_available").
        const gridSettings = context.grid.getSettings();
        const canHeal = (a: Unit): boolean =>
            !!canCastSpell(
                false,
                gridSettings,
                context.matrix,
                unit,
                a,
                spell,
                a.getBaseCell(),
                a.getMagicResist(),
                a.hasMindAttackResistance(),
                a.canBeHealed(),
                undefined,
            );
        const eligible = context.unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.canBeHealed() && woundFrac(a) > HEAL_WOUND_THRESHOLD && canHeal(a))
            .sort((p, q) => fullCap(q) - fullCap(p)); // biggest-HP stack first
        if (!eligible.length || eligible[0].getId() === only.targetId) {
            return decision; // nobody hurt enough (keep v0.2's valid heal), or already optimal
        }
        return [{ ...only, targetId: eligible[0].getId() }];
    }
    /** (2) When we out-gun them at range and this shooter can't fire yet, hold for them to come to us. */
    private holdWhenRangedSuperior(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        const uh = context.unitsHolder;
        const team = unit.getTeam();
        if (teamRangedFirepower(team, uh) <= teamRangedFirepower(otherTeam(team), uh)) {
            return undefined; // not (yet) ranged-superior — play normally
        }
        if (this.canLandRange(unit, context)) {
            return undefined; // it can shoot this turn — let v0.2 take the shot
        }
        // Only hold if we are NOT under melee pressure; a boxed-in shooter still defers to v0.3's retreat.
        const myCells = unit.getCells();
        const boxed = uh
            .getAllAllies(otherTeam(team))
            .some((e) => !e.isDead() && e.getCells().some((ec) => myCells.some((uc) => isAdjacentCell(ec, uc))));
        if (boxed) {
            return undefined;
        }
        // Safe and out-gunning them: don't walk onto their shots — wait for them to close the distance.
        if (this.canHourglass(unit, context)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /** (3) Fly to and strike the most dangerous enemy siege unit; if unreachable, advance toward it. */
    private flyerMuteSiege(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        const enemyTeam = otherTeam(unit.getTeam());
        const siege = context.unitsHolder
            .getAllAllies(enemyTeam)
            .filter(
                (e) =>
                    !e.isDead() && !e.hasBuffActive("Hidden") && SIEGE_UNITS.has(e.getName()) && e.getRangeShots() > 0,
            )
            .sort((a, b) => firepowerOf(b) - firepowerOf(a));
        if (!siege.length) {
            return undefined; // no live siege to mute -> behave like a normal flyer
        }
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        const nearestSiegeDist = (cell: XY): number =>
            Math.min(...siege.map((s) => getDistance(cell, s.getBaseCell())));
        let strike: { cell: XY; targetId: string; weight: number } | undefined;
        let advance: { cell: XY; dist: number; weight: number } | undefined;
        for (const [key, routes] of movePath.knownPaths) {
            const cell = { x: (key >> 4) & 0xf, y: key & 0xf };
            const route = routes?.[0];
            if (!route?.route.length) {
                continue;
            }
            const weight = route.weight ?? Infinity;
            const dist = nearestSiegeDist(cell);
            if (!advance || dist < advance.dist || (dist === advance.dist && weight < advance.weight)) {
                advance = { cell, dist, weight };
            }
            const adj = siege.find((s) => s.getCells().some((sc) => isAdjacentCell(sc, cell)));
            if (adj && (!strike || weight < strike.weight)) {
                strike = { cell, targetId: adj.getId(), weight };
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
        return undefined; // can't make progress toward the siege this turn -> normal behaviour
    }
    /**
     * (5) Anti-AoE deployment. v0.3 corners its shooters and clusters the army — strong in general, but a
     * gift to AoE / multi-hit attackers (Black Dragon, Pikeman, Gargantuan, Cyclops, Tsar Cannon), where one
     * blow catches a whole pile. When such a unit is on the board, deploy SPREAD instead: greedily place each
     * stack on the legal cell farthest from the stacks already placed, so no single AoE hit lands on two of
     * ours. (Mirror tournaments field the same roster on both sides, so "our roster has AoE" stands in for
     * "the enemy has AoE".) No AoE present → defer to v0.3's clustered deployment. Measured on NORMAL maps.
     */
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        if (!units.some(isAoEUnit)) {
            return super.placeArmy(units, context);
        }
        const placements = new Map<string, XY>();
        const occupied = new Set<number>();
        const legal = context.placement.possibleCellHashes();
        const baseCells = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
        if (!baseCells.length) {
            return placements;
        }
        // Deeper = safer first-pick (farther from the enemy); used only to break ties (and to seed unit 1).
        const frontness = (cc: XY): number => (context.team === PBTypes.TeamVals.LOWER ? cc.y : -cc.y);
        const footprintFor = (u: Unit, base: XY): XY[] =>
            u.isSmallSize()
                ? [base]
                : [
                      { x: base.x, y: base.y },
                      { x: base.x - 1, y: base.y },
                      { x: base.x, y: base.y - 1 },
                      { x: base.x - 1, y: base.y - 1 },
                  ];
        const bySizeLargeFirst = (a: Unit, b: Unit): number => (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1);
        const placed: XY[] = [];
        for (const u of [...units].sort(bySizeLargeFirst)) {
            let bestBase: XY | undefined;
            let bestSpacing = -Infinity;
            let bestFront = -Infinity;
            for (const base of baseCells) {
                const footprint = footprintFor(u, base);
                if (footprint.some((cc) => !legal.has(cellKey(cc)) || occupied.has(cellKey(cc)))) {
                    continue;
                }
                const spacing = placed.length ? Math.min(...placed.map((p) => getDistance(base, p))) : 0;
                const front = frontness(base);
                if (spacing > bestSpacing || (spacing === bestSpacing && front > bestFront)) {
                    bestSpacing = spacing;
                    bestFront = front;
                    bestBase = base;
                }
            }
            if (!bestBase) {
                continue;
            }
            for (const cc of footprintFor(u, bestBase)) {
                occupied.add(cellKey(cc));
            }
            placements.set(u.getId(), bestBase);
            placed.push(bestBase);
        }
        return placements;
    }
}

export const STRATEGY_V0_4: IAIStrategy = new StrategyV0_4();
