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
import { PBTypes } from "../../generated/protobuf/v1/types";
import { canCastSpell, canMassCastSpell } from "../../spells/spell_helper";
import { SpellPowerType, SpellTargetType } from "../../spells/spell_properties";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { teamRangedFirepower } from "./v0_2";
import { StrategyV0_3 } from "./v0_3";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
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
        const base = super.decideTurn(unit, context);
        const healed = this.retargetHeal(unit, context, base);
        const goblin = this.preferLowLevelMelee(unit, context, healed);
        const positioned = this.auraRepositionMelee(unit, context, goblin);
        const meleeTuned = this.rapidChargeReposition(unit, context, positioned);
        const fhTuned = this.aoeMeleeReposition(unit, context, meleeTuned);
        const hunted = this.flyerPatientHunt(unit, context, fhTuned);
        const spun = this.hydraSpinReposition(unit, context, hunted);
        const tuned = this.preferValidMove(unit, context, this.chainLightningTarget(unit, context, spun), base);
        return this.enforceMeleeLegality(unit, context, tuned);
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
        const target = uh.getAllUnits().get(strike.targetId);
        if (!target || target.isDead()) {
            return this.fallbackTurn(unit, context);
        }
        const myCells = unit.getCells();
        const adjacentInPlace = (e: Unit): boolean =>
            e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(ec, mc)));
        const cowardlyVs = (e: Unit): boolean =>
            unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp();
        const inPlaceStrike = (targetId: string): GameAction[] => {
            const acts: GameAction[] = [];
            if (unit.getAttackTypeSelection() !== MELEE) {
                acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
            }
            acts.push({
                type: "melee_attack",
                attackerId: unit.getId(),
                targetId,
                attackFrom: { ...unit.getBaseCell() },
            });
            return acts;
        };

        // Forced target (Aggr/taunt): only that unit may be struck.
        const forcedId = unit.getTarget();
        if (forcedId && forcedId !== strike.targetId) {
            const forced = uh.getAllUnits().get(forcedId);
            if (forced && !forced.isDead()) {
                if (adjacentInPlace(forced) && !cowardlyVs(forced)) {
                    return inPlaceStrike(forcedId);
                }
                return this.fallbackTurn(unit, context); // can't legally strike the forced target this turn
            }
        }
        // Cowardice: cannot attack a stronger stack.
        if (cowardlyVs(target)) {
            if (forcedId === strike.targetId) {
                return this.fallbackTurn(unit, context); // forced onto a stronger target — can't, so advance
            }
            const weaker = uh
                .getAllAllies(otherTeam(unit.getTeam()))
                .find((e) => !e.isDead() && e.getId() !== target.getId() && !cowardlyVs(e) && adjacentInPlace(e));
            return weaker ? inPlaceStrike(weaker.getId()) : this.fallbackTurn(unit, context);
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
     * Footprint guard (V04_MVGUARD): the move-emitting tactics use getMovePath, whose reachability model is
     * slightly looser than the engine's execution-time check, so a few proposed moves land on an occupied
     * footprint and get rejected `move_blocked` (wasting the turn). If the tuned decision's move would be
     * blocked, fall back to the validated core decision; if that is also blocked, hold instead of emitting a
     * rejected move. Mirrors the engine's own areAllCellsEmpty / canOccupyCells gate.
     */
    private preferValidMove(
        unit: Unit,
        context: IDecisionContext,
        decision: GameAction[],
        fallback: GameAction[],
    ): GameAction[] {
        if (!mvGuardOn || !this.moveIsBlocked(unit, context, decision)) {
            return decision;
        }
        if (!this.moveIsBlocked(unit, context, fallback)) {
            return fallback;
        }
        return this.canHourglass(unit, context)
            ? [{ type: "wait_turn", unitId: unit.getId() }]
            : [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
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
            unit.hasAbilityActive("Made of Fire"),
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
            unit.hasAbilityActive("Made of Fire"),
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
            unit.hasAbilityActive("Made of Fire"),
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
            unit.hasAbilityActive("Made of Fire"),
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

        // Only LEVEL 3-4 stacks that have lost more than 30% of their HP are worth a heal.
        const critical = allies
            .filter((a) => a.canBeHealed() && a.getLevel() >= 3 && lostFrac(a) > 0.3)
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
            unit.hasAbilityActive("Made of Fire"),
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
