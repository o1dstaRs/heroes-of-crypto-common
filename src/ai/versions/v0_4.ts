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
import type { IWeightedRoute } from "../../grid/path_definitions";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import {
    getPositionForCell,
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import { canCastSpell, canMassCastSpell } from "../../spells/spell_helper";
import { SpellPowerType, SpellTargetType } from "../../spells/spell_properties";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import { canUnitLandAt } from "../ai";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { teamRangedFirepower } from "./v0_2";
import { StrategyV0_3 } from "./v0_3";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const boxHoldOn = process.env.V04_BOXHOLD === "on"; // NEUTRAL: +0.06pp overall, +0.05pp range-heavy (v0.3 already handles boxed shooters)
const frontlineOn = process.env.V04_FRONTLINE === "on";
const frontMoveOn = process.env.V04_FRONTMOVE !== "off"; // range-heavy bait/lead: +0.99pp on forced range-heavy (gated to >=3 ranged so no dilution) // measured NEUTRAL (+0.27pp on forced Unicorn+Scavenger); placement-only doesn't move it
const FRONT_TANKS = new Set(["Unicorn", "Scavenger"]);
const buffWaitOn = process.env.V04_BUFFWAIT !== "off";
const beheSelfOn = process.env.V04_BEHESELF === "on";
const ogreSelfOn = process.env.V04_OGRESELF === "on"; // measured below // DISABLED by default: measured -2.66pp on 20k forced-Behemoth games
const mvGuardOn = process.env.V04_MVGUARD !== "off";
const MAGIC_FH = PBTypes.AttackVals.MAGIC;
const enabledFH = (name: string): boolean => process.env[`V04_${name}`] !== "off";
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
        // (7) Healer policy: only heal a LEVEL 3-4 stack that has lost >30% HP (Mass Heal if several),
        // otherwise armor is the better play. Preempts the generic heal/buff logic for the Healer.
        if (unit.getName() === "Healer") {
            const healerPlay = this.decideHealerSpell(unit, context);
            if (healerPlay) {
                return healerPlay;
            }
        }
        // (8) Troll "Wild Regeneration" gift: a MELEE_MAGIC unit the base AI never casts. Gift the
        // full-heal-each-turn buff to the highest-HP level<=3 ally (max effect; lasts the whole fight),
        // hourglassing the very first turn — unless the Troll can strike an enemy right now.
        if (unit.getName() === "Troll") {
            const regen = this.trollWildRegen(unit, context);
            if (regen) {
                return regen;
            }
        }
        // (EXP) Boxed shooter: an enemy adjacent blocks our shot. Hourglass FIRST — an ally may clear the
        // blocker this lap (saving us a wasted retreat); only after we've waited does v0.3 melee-kill it or
        // retreat to safety.
        if (boxHoldOn && unit.getAttackType() === RANGE && unit.getRangeShots() > 0 && unit.canMove()) {
            const boxed = this.holdBoxedShooter(unit, context);
            if (boxed) return boxed;
        }
        const base = super.decideTurn(unit, context);
        const healed = this.retargetHeal(unit, context, base);
        const goblin = this.preferLowLevelMelee(unit, context, healed);
        const positioned = this.auraRepositionMelee(unit, context, goblin);
        const meleeTuned = this.rapidChargeReposition(unit, context, positioned);
        const fhTuned = this.aoeMeleeReposition(unit, context, meleeTuned);
        const hunted = this.flyerPatientHunt(unit, context, fhTuned);
        const spun = this.hydraSpinReposition(unit, context, hunted);
        const tuned = this.preferValidMove(unit, context, this.chainLightningTarget(unit, context, spun), base);
        const legal = this.enforceMeleeLegality(unit, context, tuned);
        const finalDecision = this.frontMove(unit, context, this.waitForMassBuff(unit, context, legal));
        return this.enforceRangeLegality(unit, context, finalDecision);
    }
    /**
     * Final range-legality guard. The engine declines a range_attack whose resolved shot hits NOTHING (an
     * occluded / off-target aim) or whose target is "Hidden". v0.4 re-resolves the shot with the engine's
     * exact aim logic (resolveRangeTargetPosition + evaluateRangeAttack) and, if it wouldn't land, drops it
     * for a safe advance — so the engine never rejects what we emit.
     */
    private enforceRangeLegality(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const shot = decision.find((a) => a.type === "range_attack");
        if (!shot || shot.type !== "range_attack" || this.rangeShotLands(unit, context, shot)) {
            return decision;
        }
        return this.fallbackTurn(unit, context);
    }
    /** Mirrors the engine: does this exact range shot land on something (and not on a Hidden/None target)? */
    private rangeShotLands(
        unit: Unit,
        context: IDecisionContext,
        action: Extract<GameAction, { type: "range_attack" }>,
    ): boolean {
        const ah = context.attackHandler;
        if (!ah) {
            return true; // can't validate without the handler — trust the proposal
        }
        const uh = context.unitsHolder;
        const grid = context.grid;
        const target = uh.getAllUnits().get(action.targetId);
        if (!target || target.isDead() || target.hasBuffActive("Hidden")) {
            return false;
        }
        // Pinned in melee, out of shots, or range-suppressed → the engine won't land the shot (line 465).
        if (!ah.canLandRangeAttack(unit, grid.getEnemyAggrMatrixByUnitId(unit.getId()))) {
            return false;
        }
        const gs = grid.getSettings();
        const matrix = grid.getMatrix();
        const from = unit.getPosition();
        const fromTeam = unit.getTeam();
        const through = unit.hasAbilityActive("Through Shot");
        const isAOE = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
        // Replicate resolveRangeTargetPosition EXACTLY so our verdict matches the engine's handler.
        const closestCell = (cells: XY[]): XY | undefined => {
            let best: XY | undefined;
            let bestD = Number.MAX_VALUE;
            for (const c of cells) {
                const d = getDistance(from, getPositionForCell(c, gs.getMinX(), gs.getStep(), gs.getHalfStep()));
                if (d < bestD) {
                    bestD = d;
                    best = c;
                }
            }
            return best;
        };
        const closestSide = (cell: XY, sides: RangeAttackCellSide[]): RangeAttackCellSide => {
            let best = sides[0];
            let bestD = Number.MAX_VALUE;
            for (const s of sides) {
                const d = getDistance(from, getRangeAttackSideCenter(gs, cell, s, from));
                if (d < bestD) {
                    bestD = d;
                    best = s;
                }
            }
            return best;
        };
        const cells = target.getCells();
        const cell =
            (action.aimCell && cells.find((c) => c.x === action.aimCell?.x && c.y === action.aimCell?.y)) ??
            closestCell(cells);
        if (!cell) {
            return false;
        }
        const observableSides = RANGE_ATTACK_CELL_SIDES.filter((s) =>
            isRangeAttackSideObservable(matrix, cell, s, fromTeam, through),
        );
        const to = !observableSides.length
            ? target.getPosition()
            : getRangeAttackSideCenter(
                  gs,
                  cell,
                  action.aimSide !== undefined && observableSides.includes(action.aimSide as RangeAttackCellSide)
                      ? (action.aimSide as RangeAttackCellSide)
                      : closestSide(cell, observableSides),
                  from,
              );
        const evaluation = ah.evaluateRangeAttack(uh.getAllUnits(), unit, from, to, through, false, isAOE);
        const groups = evaluation.affectedUnits;
        // The engine keys off the FIRST group (targetUnits[0]); a later non-empty group can't save an empty
        // first one (line 483). The divisor count must also match the group count (lines 462/477).
        const firstGroup = groups[0];
        if (!firstGroup?.length || evaluation.rangeAttackDivisors.length !== groups.length) {
            return false;
        }
        // handleRangeAttack always runs with isAOE=false (action_engine.ts line 484) — the splash flag is only
        // fed to evaluateRangeAttack, never to the handler — so EVEN Large Caliber / Area Throw shots must pass
        // the non-AOE gate: the FIRST unit struck must be a live ENEMY it's allowed to hit (not a friendly it's
        // blocked behind, not Cowardice-barred, and the forced Aggr target if one exists).
        const firstHit = firstGroup[0];
        if (firstHit.isDead() || firstHit.getTeam() === unit.getTeam()) {
            return false;
        }
        // A single affected group whose first unit is Hidden is declined (line 494), even when the AIMED enemy
        // isn't Hidden — an AOE splash (Area Throw / Large Caliber) can lead with a Hidden neighbour.
        if (groups.length === 1 && firstHit.hasBuffActive("Hidden")) {
            return false;
        }
        if (unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < firstHit.getCumulativeHp()) {
            return false;
        }
        const forced = unit.getTarget();
        if (forced && firstHit.getId() !== forced) {
            const forcedUnit = uh.getAllUnits().get(forced);
            if (forcedUnit && !forcedUnit.isDead()) {
                return false;
            }
        }
        return true;
    }
    // FINDING (measured): the ARMY should wait to act with the mass buff up (+0.95pp overall / +3.9pp on
    // Behemoth/Ogre rosters), but the CASTER should fire the buff IMMEDIATELY. Delaying the caster only
    // shortens how long the buff is live: Behemoth self-delay = -2.66pp on 20k forced-Behemoth games
    // (FORCE_CREATURES=4:Behemoth). Ogre-Mage self-delay (Mass Riot) measured -0.17pp on 20k forced-Ogre rosters (neutral). Caster always casts now; both self-delays kept off by default.
    /**
     * (EXP) Act with the mass buff ON (V04_BUFFWAIT). On lap 1, a non-caster unit hourglasses while our
     * Behemoth's Battle Roar / Ogre Mage's Mass Riot is still pending, so when it finally acts the army-wide
     * buff is already live. Only redirects an idle/move turn (never a strike); lap 1 only.
     */
    /**
     * (EXP) Frontline soak (V04_FRONTLINE). Unicorn (Blindness) and Scavenger (Dodge/Backstab) are good at
     * trading the FIRST hits, so put them on the front line: swap each forward with a same-size regular melee
     * that v0.3 placed deeper, so the tanks meet the enemy first and the rest follow. Same-size swap keeps
     * footprints valid. No tank / no swap partner -> unchanged.
     */
    /**
     * (EXP) Frontline lead + range bait (V04_FRONTMOVE). On a pure-move (no strike) for a melee unit:
     *  - if our ranged firepower out-guns theirs, HOLD (bait) and let them walk onto our shots;
     *  - else Unicorn/Scavenger LEAD the advance (toward the nearest enemy) to consume the first hits while
     *    the rest of the melee follows normally.
     */
    // REMOVED (refuted in every context): Angel resurrect. Measured -28pp blunt, -3.65pp strictly gated
    // (no-attack + heavily-dead target), and -14.16pp even gated to a range-heavy defensive army on 20k
    // forced Angel+ranged rosters. The Angel is too valuable a fighter to ever stand and resurrect — a
    // restored stack re-dies and we cede its combat contribution (in a mirror the enemy Angel keeps fighting).
    private holdBoxedShooter(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        if (unit.hasAbilityActive("No Melee") || unit.hasAbilityActive("Handyman")) return undefined;
        if (this.canLandRange(unit, context)) return undefined; // it can actually shoot -> not boxed
        const myCells = unit.getCells();
        const boxed = context.unitsHolder
            .getAllAllies(otherTeam(unit.getTeam()))
            .some((e) => !e.isDead() && e.getCells().some((ec) => myCells.some((uc) => isAdjacentCell(ec, uc))));
        if (!boxed) return undefined;
        // Hourglass on the first slot to give an ally a chance to clear the blocker. Once we've already
        // hourglassed (canHourglass false), fall through to v0.3 (melee the blocker if it pays, else retreat).
        if (this.canHourglass(unit, context)) return [{ type: "wait_turn", unitId: unit.getId() }];
        return undefined;
    }
    protected frontMove(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!frontMoveOn || unit.getAttackType() !== MELEE || !unit.canMove()) return decision;
        const myRanged = context.unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getAttackType() === RANGE).length;
        if (myRanged < 3) return decision; // only a range-heavy army baits + leads with tanks
        if (decision.some((a) => a.type === "melee_attack" || a.type === "range_attack" || a.type === "cast_spell"))
            return decision;
        const uh = context.unitsHolder;
        const team = unit.getTeam();
        const enemyTeam = otherTeam(team);
        const enemies = uh.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) return decision;
        if (teamRangedFirepower(team, uh) > teamRangedFirepower(enemyTeam, uh)) {
            return this.canHourglass(unit, context) ? [{ type: "wait_turn", unitId: unit.getId() }] : decision;
        }
        if (!FRONT_TANKS.has(unit.getName())) return decision;
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const nearest = (cell: XY): number => Math.min(...enemies.map((e) => getDistance(cell, e.getBaseCell())));
        let best: { cell: XY; route: IWeightedRoute } | undefined;
        let bestDist = nearest(unit.getBaseCell());
        for (const [key, routes] of movePath.knownPaths) {
            const cell = { x: (key >> 4) & 0xf, y: key & 0xf };
            const route = routes?.[0];
            if (!route?.route.length) continue;
            const d = nearest(cell);
            if (d < bestDist) {
                bestDist = d;
                best = { cell, route };
            }
        }
        if (!best) return decision;
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            },
        ];
    }
    private frontlineTanks(units: Unit[], context: IPlacementContext, placed: Map<string, XY>): Map<string, XY> {
        if (!frontlineOn) return placed;
        const tanks = units.filter((u) => FRONT_TANKS.has(u.getName()));
        if (!tanks.length) return placed;
        const front = (cc: XY): number => (context.team === PBTypes.TeamVals.LOWER ? cc.y : -cc.y);
        for (const t of tanks) {
            const tc = placed.get(t.getId());
            if (!tc) continue;
            let best: Unit | undefined;
            let bestFront = front(tc);
            for (const u of units) {
                if (u.getId() === t.getId() || u.getAttackType() !== MELEE || FRONT_TANKS.has(u.getName())) continue;
                if (u.isSmallSize() !== t.isSmallSize()) continue;
                const uc = placed.get(u.getId());
                if (uc && front(uc) > bestFront) {
                    bestFront = front(uc);
                    best = u;
                }
            }
            if (best) {
                const bc = placed.get(best.getId())!;
                placed.set(t.getId(), bc);
                placed.set(best.getId(), tc);
            }
        }
        return placed;
    }
    private waitForMassBuff(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!buffWaitOn) return decision;
        if (FightStateManager.getInstance().getFightProperties().getCurrentLap() > 1) return decision;
        // Behemoth self-delay: hourglass its first lap-1 slot so Battle Roar lands a beat later (army hourglasses
        // too), i.e. it acts WITH the roar rather than spending its opening slot on the cast. Casts on its 2nd slot.
        // Ogre Mage analog of the Behemoth self-delay — measured the same way (see note above).
        if (
            ogreSelfOn &&
            unit.getName() === "Ogre Mage" &&
            decision.some((a) => a.type === "cast_spell" && a.spellName === "Mass Riot") &&
            this.canHourglass(unit, context)
        ) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        if (
            beheSelfOn &&
            unit.getName() === "Behemoth" &&
            decision.some((a) => a.type === "cast_spell" && a.spellName === "Battle Roar") &&
            this.canHourglass(unit, context)
        ) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        if (decision.some((a) => a.type === "melee_attack" || a.type === "range_attack" || a.type === "cast_spell"))
            return decision;
        const allies = context.unitsHolder.getAllAllies(unit.getTeam()).filter((a) => !a.isDead());
        // Battle Roar (+steps, melee-flavored) is NOT worth a shooter losing a volley, so skip the wait when
        // we're range-heavy. Mass Riot (+25% dmg) compounds over shots, so the Ogre wait is kept regardless.
        // Measured on 20k forced-roster runs: Behemoth range-heavy army-wait -2.57pp, Ogre range-heavy +2.38pp.
        const rangeHeavy = allies.filter((a) => a.getAttackType() === RANGE).length >= 3;
        const roarPending =
            !rangeHeavy &&
            allies.some((a) => a.getName() === "Behemoth") &&
            !allies.some((a) => a.hasBuffActive("Battle Roar"));
        const riotPending =
            allies.some((a) => a.getName() === "Ogre Mage") &&
            !allies.some((a) => a.hasBuffActive("Mass Riot") || a.hasBuffActive("Riot"));
        const wait = (roarPending && unit.getName() !== "Behemoth") || (riotPending && unit.getName() !== "Ogre Mage");
        if (wait && this.canHourglass(unit, context)) return [{ type: "wait_turn", unitId: unit.getId() }];
        return decision;
    }
    /**
     * (11) Final melee-legality guard. The engine forbids two melees the base heuristic sometimes
     * proposes: attacking while "Cowardice"-debuffed a target STRONGER than us, and attacking anything
     * other than a FORCED target (Aggr/taunt). v0.4 honours both — it retargets in place to the forced
     * unit (or, under Cowardice, a weaker adjacent enemy) when one is reachable, else falls back to a safe
     * advance — so the engine never rejects the strike.
     */
    private enforceMeleeLegality(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack") {
            return decision;
        }
        const uh = context.unitsHolder;
        const base = unit.getBaseCell();
        const myCells = unit.getCells();
        const adjacentInPlace = (e: Unit): boolean =>
            e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(ec, mc)));
        const cowardlyVs = (e: Unit): boolean =>
            unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp();
        // A target we can legally strike RIGHT HERE this turn — the exact set of conditions the engine's
        // melee handler enforces: alive, not "Hidden" (engine refuses), not a Cowardice-blocked stronger
        // stack, and adjacent now (so no move is needed, valid even if the unit can't move).
        const strikableInPlace = (e: Unit | undefined): e is Unit =>
            !!e && !e.isDead() && !e.hasBuffActive("Hidden") && !cowardlyVs(e) && adjacentInPlace(e);
        const inPlaceStrike = (targetId: string): GameAction[] => {
            const acts: GameAction[] = [];
            if (unit.getAttackTypeSelection() !== MELEE) {
                acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
            }
            acts.push({ type: "melee_attack", attackerId: unit.getId(), targetId, attackFrom: { ...base } });
            return acts;
        };
        const forcedId = unit.getTarget();
        // When forced (Aggr/taunt) we may strike ONLY that unit — so we can't retarget elsewhere; advance.
        const retargetOrFallback = (): GameAction[] => {
            if (forcedId) {
                return this.fallbackTurn(unit, context);
            }
            const alt = uh.getAllAllies(otherTeam(unit.getTeam())).find((e) => strikableInPlace(e));
            return alt ? inPlaceStrike(alt.getId()) : this.fallbackTurn(unit, context);
        };

        const target = uh.getAllUnits().get(strike.targetId);
        const attackFrom = strike.attackFrom ?? base;
        const movesToStrike = attackFrom.x !== base.x || attackFrom.y !== base.y;

        // Forced target (Aggr/taunt): only that unit may be struck — hit it in place if we legally can.
        if (forcedId && forcedId !== strike.targetId) {
            const forced = uh.getAllUnits().get(forcedId);
            if (forced && !forced.isDead()) {
                return strikableInPlace(forced) ? inPlaceStrike(forcedId) : this.fallbackTurn(unit, context);
            }
        }
        // The engine would reject this strike if: the target is gone / "Hidden", Cowardice bars it (stronger
        // stack), or it needs a move the unit can't make. In any of those, hit a legal adjacent enemy
        // instead, else advance — so the engine never declines what we emit.
        if (
            !target ||
            target.isDead() ||
            target.hasBuffActive("Hidden") ||
            cowardlyVs(target) ||
            (movesToStrike && !unit.canMove())
        ) {
            return retargetOrFallback();
        }
        return decision;
    }
    /**
     * (10) Thunderbird "Chain Lightning": the strike arcs from the primary target to ADJACENT enemies,
     * then to THEIR neighbours (up to 4 layers, damage falling off; Wind-immune stacks break the chain).
     * So v0.4 attacks the reachable enemy embedded in the LARGEST connected enemy cluster, maximising the
     * arc. Only swaps when it strictly increases the stacks the chain reaches.
     */
    /**
     * Footprint guard: the move-emitting tactics use getMovePath, whose reachability model is slightly looser
     * than the engine's execution-time landing check. If a tuned move or path-bearing melee would stop on an
     * illegal footprint, preserve the validated core decision; if that is also blocked, hold. V04_MVGUARD still
     * controls the historical pure-move check, while attack legality is unconditional.
     */
    private preferValidMove(
        unit: Unit,
        context: IDecisionContext,
        decision: GameAction[],
        fallback: GameAction[],
    ): GameAction[] {
        if (!this.decisionLandingIsBlocked(unit, context, decision)) {
            return decision;
        }
        if (!this.decisionLandingIsBlocked(unit, context, fallback)) {
            return fallback;
        }
        return this.canHourglass(unit, context)
            ? [{ type: "wait_turn", unitId: unit.getId() }]
            : [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    private decisionLandingIsBlocked(unit: Unit, context: IDecisionContext, decision: GameAction[]): boolean {
        const strike = decision.find((action) => action.type === "melee_attack");
        if (
            strike?.type === "melee_attack" &&
            strike.path?.length &&
            strike.attackFrom &&
            !canUnitLandAt(unit, context.grid, strike.attackFrom)
        ) {
            return true;
        }
        return mvGuardOn && this.moveIsBlocked(unit, context, decision);
    }
    private moveIsBlocked(unit: Unit, context: IDecisionContext, decision: GameAction[]): boolean {
        const mv = decision.find((a) => a.type === "move_unit");
        if (!mv || mv.type !== "move_unit") {
            return false;
        }
        const fp = mv.targetCells ?? [];
        if (!fp.length) {
            return false;
        }
        return !(
            context.grid.areAllCellsEmpty(fp, unit.getId()) ||
            context.grid.canOccupyCells(
                fp,
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            )
        );
    }
    private chainLightningTarget(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!unit.hasAbilityActive("Chain Lightning") || unit.getTarget() || !unit.canMove()) {
            return decision;
        }
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack") {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (enemies.length < 2) {
            return decision;
        }
        // Wind-immune / fully magic-resistant stacks neither take the arc nor pass it on.
        const chainable = enemies.filter((e) => !e.hasAbilityActive("Wind Element") && e.getMagicResist() < 100);
        // BFS the chain out from `target` through adjacent enemy clusters (≤4 layers); count stacks reached.
        const chainReach = (target: Unit): number => {
            const affected = new Set<string>([target.getId()]);
            let frontier: Unit[] = [target];
            for (let layer = 0; layer < 4 && frontier.length; layer += 1) {
                const next: Unit[] = [];
                for (const u of frontier) {
                    for (const e of chainable) {
                        if (affected.has(e.getId())) {
                            continue;
                        }
                        if (e.getCells().some((ec) => u.getCells().some((uc) => isAdjacentCell(ec, uc)))) {
                            affected.add(e.getId());
                            next.push(e);
                        }
                    }
                }
                frontier = next;
            }
            return affected.size;
        };
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const baseTarget = unitsHolder.getAllUnits().get(strike.targetId);
        const baseReach = baseTarget ? chainReach(baseTarget) : 1;
        const cands: { cell: XY; route?: IWeightedRoute }[] = [{ cell: unit.getBaseCell() }];
        for (const routes of movePath.knownPaths.values()) {
            const r = routes[0];
            if (r?.route.length) {
                cands.push({ cell: r.cell, route: r });
            }
        }
        let best: { cell: XY; target: Unit; route?: IWeightedRoute; reach: number } | undefined;
        for (const cand of cands) {
            const fp = this.footprintForCell(unit, cand.cell, context);
            for (const e of enemies) {
                if (!e.getCells().some((ec) => fp.some((fc) => isAdjacentCell(ec, fc)))) {
                    continue;
                }
                const reach = chainReach(e);
                const len = cand.route?.route.length ?? 0;
                if (!best || reach > best.reach || (reach === best.reach && len < (best.route?.route.length ?? 0))) {
                    best = { cell: cand.cell, target: e, route: cand.route, reach };
                }
            }
        }
        if (!best || best.reach < 2 || best.reach <= baseReach) {
            return decision;
        }
        const actions: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        actions.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: best.target.getId(),
            attackFrom: { x: best.cell.x, y: best.cell.y },
            path: best.route?.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route?.hasLavaCell,
            hasWaterCell: best.route?.hasWaterCell,
        });
        return actions;
    }
    /**
     * (9) Hydra "Lightning Spin": her melee hits EVERY enemy around her footprint and provokes NO counter,
     * so position matters more than which target she nominally strikes. v0.4 moves her into the reachable
     * cell adjacent to the MOST enemy stacks and strikes from there — turning a single hit into an
     * all-around blow. Only swaps when it strictly increases the enemies caught.
     */
    private hydraSpinReposition(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!unit.hasAbilityActive("Lightning Spin") || unit.getTarget() || !unit.canMove()) {
            return decision;
        }
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack") {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (enemies.length < 2) {
            return decision; // nothing to cleave around
        }
        // Enemy stacks adjacent to the Hydra's footprint at `cell` — exactly the engine's spin zone.
        const adjEnemies = (cell: XY): Unit[] => {
            const fp = this.footprintForCell(unit, cell, context);
            return enemies.filter((e) => e.getCells().some((ec) => fp.some((fc) => isAdjacentCell(ec, fc))));
        };
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const baseCount = adjEnemies(strike.attackFrom ?? unit.getBaseCell()).length;
        const cands: { cell: XY; route?: IWeightedRoute }[] = [{ cell: unit.getBaseCell() }];
        for (const routes of movePath.knownPaths.values()) {
            const r = routes[0];
            if (r?.route.length) {
                cands.push({ cell: r.cell, route: r });
            }
        }
        let best: { cell: XY; target: Unit; route?: IWeightedRoute; count: number } | undefined;
        for (const cand of cands) {
            const adj = adjEnemies(cand.cell);
            if (!adj.length) {
                continue;
            }
            const len = cand.route?.route.length ?? 0;
            if (
                !best ||
                adj.length > best.count ||
                (adj.length === best.count && len < (best.route?.route.length ?? 0))
            ) {
                best = { cell: cand.cell, target: adj[0], route: cand.route, count: adj.length };
            }
        }
        if (!best || best.count < 2 || best.count <= baseCount) {
            return decision; // no strictly-better cluster within reach
        }
        const actions: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        actions.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: best.target.getId(),
            attackFrom: { x: best.cell.x, y: best.cell.y },
            path: best.route?.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route?.hasLavaCell,
            hasWaterCell: best.route?.hasWaterCell,
        });
        return actions;
    }
    /**
     * (8) Melee AoE targeting for Black Dragon (Fire Breath, line depth = unit size) and Pikeman (Skewer
     * Strike, hits the stack behind the target). Both splash in a LINE from the attacker THROUGH the
     * target, so v0.4 picks the stand cell + target whose line catches the MOST enemy stacks — turning a
     * single hit into a 2+-stack blow. Only swaps when it strictly increases the stacks hit.
     */
    private flyerPatientHunt(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!enabledFH("FHUNT2") || !unit.canFly() || unit.getAttackType() !== MELEE || !unit.canMove())
            return decision;
        if (decision.some((a) => a.type === "melee_attack" || a.type === "range_attack" || a.type === "cast_spell"))
            return decision;
        const uh = context.unitsHolder;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = uh.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        const ranges = enemies.filter((e) => e.getAttackType() === RANGE || e.getAttackType() === MAGIC_FH);
        if (!ranges.length) return decision;
        const clash = uh
            .getAllAllies(unit.getTeam())
            .some(
                (a) =>
                    !a.isDead() &&
                    a.getId() !== unit.getId() &&
                    enemies.some((e) => e.getCells().some((ec) => a.getCells().some((ac) => isAdjacentCell(ec, ac)))),
            );
        if (!clash) return this.canHourglass(unit, context) ? [{ type: "wait_turn", unitId: unit.getId() }] : decision;
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const nearest = (cell: XY): number => Math.min(...ranges.map((t) => getDistance(cell, t.getBaseCell())));
        let best: { cell: XY; route: IWeightedRoute } | undefined;
        let bestDist = nearest(unit.getBaseCell());
        for (const [key, routes] of movePath.knownPaths) {
            const cell = { x: (key >> 4) & 0xf, y: key & 0xf };
            const route = routes?.[0];
            if (!route?.route.length) continue;
            const d = nearest(cell);
            if (d < bestDist) {
                bestDist = d;
                best = { cell, route };
            }
        }
        if (!best) return decision;
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            },
        ];
    }
    private aoeMeleeReposition(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const fireBreath = unit.hasAbilityActive("Fire Breath");
        const skewer = unit.hasAbilityActive("Skewer Strike");
        if ((!fireBreath && !skewer) || unit.getTarget() || !unit.canMove()) {
            return decision;
        }
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack") {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (enemies.length < 2) {
            return decision; // need at least two enemies for a multi-stack hit
        }
        const depth = fireBreath ? (unit.isSmallSize() ? 1 : 2) : 1;
        const occupantEnemy = (cell: XY): Unit | undefined => {
            if (cell.x < 0 || cell.y < 0) {
                return undefined;
            }
            const id = grid.getOccupantUnitId(cell);
            const u = id ? unitsHolder.getAllUnits().get(id) : undefined;
            return u && !u.isDead() && u.getTeam() === enemyTeam ? u : undefined;
        };
        // Enemy stacks caught by the line from `cell` through `target` and `depth` cells beyond it.
        const lineHits = (cell: XY, target: Unit): number => {
            const tc = target.getBaseCell();
            const dx = Math.sign(tc.x - cell.x);
            const dy = Math.sign(tc.y - cell.y);
            const hit = new Set<string>([target.getId()]);
            for (let k = 1; k <= depth; k += 1) {
                const occ = occupantEnemy({ x: tc.x + dx * k, y: tc.y + dy * k });
                if (occ) {
                    hit.add(occ.getId());
                }
            }
            return hit.size;
        };
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const baseTarget = unitsHolder.getAllUnits().get(strike.targetId);
        const baseHits = baseTarget ? lineHits(strike.attackFrom ?? unit.getBaseCell(), baseTarget) : 1;

        const cands: { cell: XY; route?: IWeightedRoute }[] = [{ cell: unit.getBaseCell() }];
        for (const routes of movePath.knownPaths.values()) {
            const r = routes[0];
            if (r?.route.length) {
                cands.push({ cell: r.cell, route: r });
            }
        }
        let best: { cell: XY; target: Unit; route?: IWeightedRoute; hits: number } | undefined;
        for (const cand of cands) {
            const footprint = this.footprintForCell(unit, cand.cell, context);
            for (const e of enemies) {
                if (!e.getCells().some((ec) => footprint.some((fc) => isAdjacentCell(ec, fc)))) {
                    continue;
                }
                const hits = lineHits(cand.cell, e);
                const len = cand.route?.route.length ?? 0;
                if (!best || hits > best.hits || (hits === best.hits && len < (best.route?.route.length ?? 0))) {
                    best = { cell: cand.cell, target: e, route: cand.route, hits };
                }
            }
        }
        if (!best || best.hits < 2 || best.hits <= baseHits) {
            return decision; // no strictly-better multi-stack line available
        }
        const actions: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        actions.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: best.target.getId(),
            attackFrom: { x: best.cell.x, y: best.cell.y },
            path: best.route?.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route?.hasLavaCell,
            hasWaterCell: best.route?.hasWaterCell,
        });
        return actions;
    }
    /**
     * (8) Troll "Wild Regeneration" gift. The ability is GIFTABLE (max gift level 3) and lasts the whole
     * fight, so gifting it to the highest-HP level<=3 ally makes that stack restore to full HP every turn —
     * a near-unkillable frontliner. The base AI never casts it (Troll is MELEE_MAGIC -> treated as melee).
     * Conditions (per domain guidance): only when we're DEFENDING with a ranged-heavy army (out-gun them at
     * range) — the regen tank holds while our shooters out-attrition; never when we can strike an adjacent
     * enemy. Sequencing: hourglass the very first turn, then gift to the best <=3 ally (falls to L2/L1 if no
     * L3; never L4 — the engine forbids it, and we filter it out so there are zero rejections). Validated
     * with canCastSpell. Measured neutral: forced-Troll A/B was -1.1pp ungated -> -0.2pp with the
     * ranged-superiority gate (encodes the right play at no cost in mirror). On by default; V04_TROLL=off.
     */
    private trollWildRegen(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        if (process.env.V04_TROLL === "off" || unit.getTarget()) {
            return undefined;
        }
        const regen = unit.getSpells().find((s) => s.getName() === "Wild Regeneration");
        if (!regen) {
            return undefined;
        }
        const { unitsHolder } = context;
        const enemies = unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((e) => !e.isDead());
        const myCells = unit.getCells();
        // If we can strike an adjacent enemy, do that — don't waste the Troll's turn on the gift.
        if (enemies.some((e) => e.getCells().some((ec) => myCells.some((uc) => isAdjacentCell(ec, uc))))) {
            return undefined;
        }
        // Only worth the gift when we're DEFENDING with a ranged-heavy army (we out-gun them at range): the
        // regen tank holds the line while our shooters out-attrition them. Otherwise the Troll just fights.
        if (
            teamRangedFirepower(unit.getTeam(), unitsHolder) <=
            teamRangedFirepower(otherTeam(unit.getTeam()), unitsHolder)
        ) {
            return undefined;
        }
        const allies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        // Already gifted to a living ally -> nothing to do; fall through to normal play.
        if (allies.some((a) => a.hasBuffActive("Wild Regeneration"))) {
            return undefined;
        }
        // Hourglass the very first turn (let the fight develop), then gift on the next Troll turn.
        if (
            FightStateManager.getInstance().getFightProperties().getCurrentLap() <= 1 &&
            this.canHourglass(unit, context)
        ) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        // Gift to the highest-HP ally within the max gift level (<=3) for maximum effect.
        const gridSettings = context.grid.getSettings();
        const maxGift = regen.getMaximumGiftLevel();
        const canCast = (target: Unit): boolean =>
            !!canCastSpell(
                false,
                gridSettings,
                context.matrix,
                unit,
                target,
                regen,
                target.getBaseCell(),
                target.getMagicResist(),
                target.hasMindAttackResistance(),
                target.canBeHealed(),
                undefined,
            );
        const target = allies
            .filter((a) => a.getLevel() <= maxGift && !a.hasBuffActive("Wild Regeneration"))
            .sort((p, q) => q.getMaxHp() * q.getAmountAlive() - p.getMaxHp() * p.getAmountAlive())
            .find((a) => canCast(a));
        if (!target) {
            return undefined;
        }
        return [
            { type: "cast_spell", casterId: unit.getId(), spellName: "Wild Regeneration", targetId: target.getId() },
        ];
    }
    /**
     * (7) Healer spell policy (requested): a single-target HEAL is only worth it on a LEVEL 3-4 stack that
     * has lost >30% of its HP — cheap low-level stacks aren't worth a heal. If SEVERAL such stacks are hurt,
     * Mass Heal instead. Otherwise the stronger play is armor: Spiritual Armor on the most valuable
     * uncovered ally. Every branch is validated (canCastSpell / canMassCastSpell) so the engine never
     * rejects it; returns undefined when nothing is worth casting (fall through to normal play).
     */
    private decideHealerSpell(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        if (unit.getStackPower() < 1) {
            return undefined;
        }
        const { grid, matrix, unitsHolder } = context;
        const gridSettings = grid.getSettings();
        const team = unit.getTeam();
        const allies = unitsHolder.getAllAllies(team).filter((a) => !a.isDead());
        if (!allies.length) {
            return undefined;
        }
        const usable = (name: string) =>
            unit
                .getSpells()
                .find(
                    (s) =>
                        s.getName() === name &&
                        s.getLapsTotal() > 0 &&
                        s.isRemaining() &&
                        s.getMinimalCasterStackPower() <= unit.getStackPower(),
                );
        const fullCap = (a: Unit): number => a.getMaxHp() * Math.max(1, a.getAmountAlive() + a.getAmountDied());
        const lostFrac = (a: Unit): number => {
            const cap = fullCap(a);
            return cap > 0 ? 1 - a.getCumulativeHp() / cap : 0;
        };
        const canCast = (spell: ReturnType<typeof usable>, target: Unit): boolean =>
            !!spell &&
            !!canCastSpell(
                false,
                gridSettings,
                matrix,
                unit,
                target,
                spell,
                target.getBaseCell(),
                target.getMagicResist(),
                target.hasMindAttackResistance(),
                target.canBeHealed(),
                undefined,
            );

        // The engine only heals a unit whose FRONT creature is actually damaged and that isn't magic-immune
        // (canMassCastSpell/handleMagicAttack require getHp() < getMaxHp() && magicResist !== 100). canBeHealed()
        // alone lets a magic-immune stack (e.g. a hurt Black Dragon, mr=100) through, so the cast is then
        // declined as "spell_not_available". Gate on the exact engine predicate to never propose a dead heal.
        const healEligible = (a: Unit): boolean =>
            a.canBeHealed() && a.getMagicResist() !== 100 && a.getHp() < a.getMaxHp();
        // Only LEVEL 3-4 stacks that have lost more than 30% of their HP are worth a heal.
        const critical = allies
            .filter((a) => healEligible(a) && a.getLevel() >= 3 && lostFrac(a) > 0.3)
            .sort((p, q) => lostFrac(q) - lostFrac(p));

        // 1) Several such stacks -> Mass Heal.
        if (critical.length >= 2) {
            const mass = usable("Mass Heal");
            if (
                mass &&
                canMassCastSpell(
                    mass,
                    unitsHolder.getAllTeamUnitsBuffs(team),
                    unitsHolder.getAllEnemyUnitsBuffs(team),
                    unitsHolder.getAllEnemyUnitsDebuffs(team),
                    unitsHolder.getAllTeamUnitsMagicResist(team),
                    unitsHolder.getAllEnemyUnitsMagicResist(team),
                    unitsHolder.getAllTeamUnitsHp(team),
                    unitsHolder.getAllTeamUnitsMaxHp(team),
                    unitsHolder.getAllTeamUnitsCanFly(team),
                    unitsHolder.getAllEnemyUnitsCanFly(team),
                )
            ) {
                return [{ type: "cast_spell", casterId: unit.getId(), spellName: "Mass Heal" }];
            }
        }
        // 2) One such stack -> single Heal on the most-hurt of them.
        const heal = usable("Heal");
        if (critical.length >= 1 && canCast(heal, critical[0])) {
            return [{ type: "cast_spell", casterId: unit.getId(), spellName: "Heal", targetId: critical[0].getId() }];
        }
        // 3) Otherwise armor is the better play -> Spiritual Armor on the most valuable uncovered ally.
        const armor = usable("Spiritual Armor");
        if (armor) {
            const target = allies
                .filter((a) => a.getId() !== unit.getId() && !a.hasBuffActive("Spiritual Armor"))
                .sort(
                    (p, q) => q.getAttackDamageMax() * q.getAmountAlive() - p.getAttackDamageMax() * p.getAmountAlive(),
                )
                .find((a) => canCast(armor, a));
            if (target) {
                return [
                    {
                        type: "cast_spell",
                        casterId: unit.getId(),
                        spellName: "Spiritual Armor",
                        targetId: target.getId(),
                    },
                ];
            }
        }
        return undefined;
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
    /**
     * (8) Rapid Charge rewards distance: the longer the run-up, the more bonus damage. When a Rapid Charge
     * unit does a move-and-strike, relocate the stand cell to the reachable cell adjacent to the same target
     * with the LONGEST approach path (without giving up the strike). Reuses validated move-path cells -> 0 rej.
     */
    private rapidChargeReposition(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!unit.hasAbilityActive("Rapid Charge") || unit.getTarget() || !unit.canMove()) {
            return decision;
        }
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack") {
            return decision;
        }
        const target = context.unitsHolder.getAllUnits().get(strike.targetId);
        if (!target) {
            return decision;
        }
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(otherTeam(unit.getTeam())),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const adjToTarget = (cell: XY): boolean => target.getCells().some((tc) => isAdjacentCell(tc, cell));
        let best: { cell: XY; route: IWeightedRoute } | undefined;
        let bestLen = strike.path && strike.path.length > 0 ? strike.path.length : 0;
        for (const [key, routes] of movePath.knownPaths) {
            const cell = { x: (key >> 4) & 0xf, y: key & 0xf };
            const route = routes?.[0];
            if (!route?.route.length || !adjToTarget(cell)) {
                continue;
            }
            if (route.route.length > bestLen) {
                bestLen = route.route.length;
                best = { cell, route };
            }
        }
        if (!best) {
            return decision;
        }
        const swapped = [...decision];
        swapped[idx] = {
            ...strike,
            attackFrom: { x: best.cell.x, y: best.cell.y },
            path: best.route.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route.hasLavaCell,
            hasWaterCell: best.route.hasWaterCell,
        };
        return swapped;
    }
    /**
     * (7) Goblin Knight prefers low-level victims. Its strike deducts attack from the target, so spending
     * it on a low-level stack is almost always the better trade. Among equally-adjacent enemies of an
     * in-place strike, swap to the lowest-LEVEL one below the currently-chosen target's level. Same engine
     * validation (an adjacent enemy is always a valid in-place melee target), so it adds no rejections.
     */
    private preferLowLevelMelee(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (unit.getName() !== "Goblin Knight" || unit.getTarget()) {
            return decision;
        }
        const idx = decision.findIndex((a) => a.type === "melee_attack");
        const strike = idx >= 0 ? decision[idx] : undefined;
        if (!strike || strike.type !== "melee_attack") {
            return decision;
        }
        const unitCell = unit.getBaseCell();
        if (
            (strike.path && strike.path.length > 0) ||
            !strike.attackFrom ||
            strike.attackFrom.x !== unitCell.x ||
            strike.attackFrom.y !== unitCell.y
        ) {
            return decision; // in-place strikes only (a move-and-strike was positioned deliberately)
        }
        const current = context.unitsHolder.getAllUnits().get(strike.targetId);
        if (!current) {
            return decision;
        }
        const myCells = unit.getCells();
        const lower = context.unitsHolder
            .getAllAllies(otherTeam(unit.getTeam()))
            .filter(
                (e) =>
                    !e.isDead() &&
                    !e.hasBuffActive("Hidden") &&
                    e.getLevel() < current.getLevel() &&
                    e.getCells().some((ec) => myCells.some((uc) => isAdjacentCell(ec, uc))),
            )
            .sort((a, b) => a.getLevel() - b.getLevel());
        if (!lower.length) {
            return decision;
        }
        const swapped = [...decision];
        swapped[idx] = { ...strike, targetId: lower[0].getId() };
        return swapped;
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
            unit.canTraverseLava(),
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
            unit.canTraverseLava(),
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
            return this.frontlineTanks(units, context, super.placeArmy(units, context));
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
        return this.frontlineTanks(units, context, placements);
    }
}

export const STRATEGY_V0_4: IAIStrategy = new StrategyV0_4();
