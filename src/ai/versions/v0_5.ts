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

import { AbilityPowerType } from "../../abilities/ability_properties";
import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { AttackHandler } from "../../handlers/attack_handler";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import { canCastSpell } from "../../spells/spell_helper";
import { auraCoverageScore, countMeleeThreatsToCell, planAuraMove } from "../ai";
import type { IDecisionContext, IAIStrategy } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { StrategyV0_4 } from "./v0_4";
import { loadV05Weights } from "./v0_5_weights";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
/** Action types that mean the unit is striking/casting this turn (so a move is a combat reposition, not a free one). */
const COMBAT_ACTIONS = new Set(["melee_attack", "range_attack", "cast_spell", "obstacle_attack", "area_throw_attack"]);
/** Rough single-stack firepower proxy (shots * max hit), matching v0.4's firepowerOf. */
const firepowerOf = (u: Unit): number => Math.max(1, u.getRangeShots()) * Math.max(1, u.getAttackDamageMax());
const isAdjacentCell = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
/** A "Hidden" stack (via Disguise Aura) is UNTARGETABLE — the engine rejects any attack on it
 * (attack_not_available). Check both buff and ability forms so we never select it for a strike. */
const isHidden = (u: Unit): boolean => u.hasBuffActive("Hidden") || u.hasAbilityActive("Hidden");
const cellKey = (c: XY): number => (c.x << 4) | c.y;
// A fragile aura-emitting FLYER (e.g. Pegasus) is worth more keeping its aura on the army than diving in to
// melee for a marginal hit — measured: Pegasus attacked 81% of turns, supporting only ~3%. ON by default.
const auraFlyOn = process.env.V05_AURAFLY !== "off";
// Auras that mainly help the MELEE line: Sharpened Weapons (+melee damage, Crusader) and Wolf Trail / walk
// steps (+movement, Wolf Rider). (Pegasus Might is +attack&armor for ALL incl. ranged -> flyer balance play.)
const MELEE_AURA_TYPES = new Set<number>([
    AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE,
    AbilityPowerType.ADDITIONAL_STEPS,
    AbilityPowerType.ADDITIONAL_STEPS_WALK,
]);
// REFUTED, default OFF: explicitly repositioning these emitters to cover the melee line measured WORSE
// (50.9/51.0% vs 51.4/52.1% on two seeds). They're melee ATTACKERS that already advance with the army, so
// overriding their advance/attack to chase aura coverage costs more than the extra coverage is worth. Kept
// behind V05_AURASUPPORT=on for future refinement (e.g. only when truly sitting behind the line).
const auraSupportOn = process.env.V05_AURASUPPORT === "on";
// Healer spell-choice policy. Battery (forced-Healer vs v0.4) ranked single plays:
//   healL4 56.7/57.0% > base 56.2/56.4% > armor 55.8% > bless 54.6% >> heal-anyone 50.3% (over-healing is bad).
// Default "smart": heal a hurt L4 first; keep any heal of a wounded stack; otherwise BALANCE armour vs
// Blessing — bless a ranged unit whose attack spread is large %-wise (gains most from a forced-max hit),
// else armour the most valuable ally. Modes "armor"|"heal"|"bless"|"healL4"|"base" kept for A/B.
const healPolicy = process.env.V05_HEALPOLICY ?? "smart";
// Minimum RELATIVE attack spread ((max-min)/max) for a ranged unit to be worth Blessing over armour.
const blessRelThresh = Number(process.env.V05_BLESS_REL ?? 0.33);

/**
 * v0.5 — the first REINFORCEMENT-LEARNED AI version.
 *
 * It extends the v0.4 champion unchanged (inheriting every validated builder, footprint/legality guard
 * and human-tactic override) and replaces ONE hand-tuned decision — the ranged shot/target scorer — with
 * a parameterised evaluator whose coefficients are searched by SELF-PLAY. The engine cannot clone/roll
 * back board state, so lookahead/MCTS is impossible; instead the Cross-Entropy Method
 * (src/simulation/optimizer/cem.mjs) plays many games of v0.5(weights) vs a frozen v0.4 and climbs the
 * decisive-win-rate reward toward better weights. The winning vector is baked into v0_5_weights.ts.
 *
 * With the DEFAULT weight vector v0.5 is byte-for-byte v0.4 (same shot scores), so registering it can
 * never regress live play; only a trained vector (or process.env.V05_WEIGHTS during a sim) changes
 * behaviour. scoreShot is the proven seam for this — v0.2 introduced it, v0.3 specialised it for
 * range-focus, and it drives which enemy a shooter aims at (a high-leverage, always-valid decision).
 */
export class StrategyV0_5 extends StrategyV0_4 {
    public override readonly version: string = "v0.5";
    /** Learned coefficients; see V05_WEIGHT_KEYS for the layout. */
    private readonly w: number[];
    public constructor(weights?: number[]) {
        super();
        this.w = weights ?? loadV05Weights();
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        // v0.4's full decision (which already used v0.5's learned scoreShot via inheritance), then two learned
        // post-processes: re-rank a melee strike's (target, stand cell), then re-rank a standalone move's
        // destination. They're mutually exclusive (a turn is either a strike or a pure move), and both anchor
        // to v0.4's own pick, so with the default weights v0.5 == v0.4 (a strict, validity-preserving extension).
        const base = this.healerPolicy(unit, context, super.decideTurn(unit, context));
        const melee = this.meleeByPolicy(unit, context, base);
        const repos = this.repositionByPolicy(unit, context, melee);
        // Final safety net: never emit an attack on a Hidden (untargetable) stack — the engine rejects it.
        const safe = this.excludeHiddenAttack(unit, context, repos);
        // A fragile aura-flyer keeps its aura on the army instead of diving for a marginal melee hit.
        const flyer = this.auraFlyerSupport(unit, context, safe);
        // A melee-buff aura emitter (Crusader/Wolf Rider) covers the FRONT melee line, not the backline.
        const auraM = this.meleeAuraSupport(unit, context, flyer);
        // Final catch-all: never emit a move whose footprint is occupied (the engine rejects move_blocked).
        return this.dropBlockedMove(unit, context, auraM);
    }
    /**
     * Catch-all validity guard for moves. Some aura-repositioning paths (the inherited withAura, and large
     * flyers like Angel/Pegasus/Griffin) build a move from a reachable ANCHOR whose full footprint can still
     * clip an occupied cell — the engine then rejects it as move_blocked and the turn is wasted. If the final
     * decision carries such a move, drop it and hold instead (hourglass if allowed, else end turn). Measured:
     * eliminates the ~0.013/game move_blocked seen with asymmetric armies (mostly size-2 units).
     */
    private dropBlockedMove(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const mv = decision.find((a) => a.type === "move_unit");
        if (!mv || mv.type !== "move_unit") {
            return decision;
        }
        const fp = mv.targetCells ?? [];
        if (!fp.length) {
            return decision;
        }
        const valid =
            context.grid.areAllCellsEmpty(fp, unit.getId()) ||
            context.grid.canOccupyCells(
                fp,
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        if (valid) {
            return decision;
        }
        return this.canHourglass(unit, context)
            ? [{ type: "wait_turn", unitId: unit.getId() }]
            : [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * First-mover exposure: fraction of LIVING enemies that haven't acted yet this lap. 1 = we commit before
     * any of them react (the disadvantaged "first-mover" seat); 0 = they've all acted and we're reacting.
     * Measured: moving first wins ~41% vs ~59% second — a structural seat edge. The fmExposure-scaled
     * interaction weights let CEM learn to play more conservatively (advance less, avoid reactable trades)
     * exactly when this is high, to claw back some of the first-mover losses. Default weights = no change.
     */
    private fmExposure(unit: Unit, context: IDecisionContext): number {
        const fp = context.fightProperties;
        if (!fp) {
            return 0;
        }
        const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((e) => !e.isDead());
        if (!enemies.length) {
            return 0;
        }
        let yetToAct = 0;
        for (const e of enemies) {
            if (!fp.hasAlreadyMadeTurn(e.getId())) {
                yetToAct += 1;
            }
        }
        return yetToAct / enemies.length;
    }
    /**
     * Melee-line aura support. Crusader (Sharpened Weapons, +melee damage) and Wolf Rider (Wolf Trail, +move)
     * carry auras that only help MELEE allies, so the base "max total coverage" positioning wastes them on
     * the backline. On a pure move (not a strike), reposition this ground emitter to the reachable cell that
     * covers the most MELEE allies, tie-breaking toward the melee centroid — so it advances WITH the front
     * line instead of sitting back with the ranged units. Pegasus (flyer, all-ally aura) is excluded.
     */
    private meleeAuraSupport(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!auraSupportOn || unit.canFly()) {
            return decision;
        }
        const meleeAuras = unit.getAuraEffects().filter((a) => MELEE_AURA_TYPES.has(a.getPowerType()));
        if (!meleeAuras.length || decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // not a melee-aura emitter, or it's striking/casting this turn
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const team = unit.getTeam();
        const enemyTeam = otherTeam(team);
        const meleeAllies = unitsHolder
            .getAllAllies(team)
            .filter((a) => !a.isDead() && a.getId() !== unit.getId() && a.getAttackType() === MELEE);
        if (!meleeAllies.length) {
            return decision; // no melee line to support
        }
        const auraRange = Math.max(...meleeAuras.map((a) => a.getRange()));
        const centroid = {
            x: meleeAllies.reduce((s, a) => s + a.getBaseCell().x, 0) / meleeAllies.length,
            y: meleeAllies.reduce((s, a) => s + a.getBaseCell().y, 0) / meleeAllies.length,
        };
        const cover = (cell: XY): number =>
            meleeAllies.filter((a) => getDistance(cell, a.getBaseCell()) <= auraRange).length;
        const footprintOk = (cell: XY): boolean => {
            const f = this.footprintForCell(unit, cell, context);
            return (
                f.length > 0 &&
                (grid.areAllCellsEmpty(f, unit.getId()) ||
                    grid.canOccupyCells(
                        f,
                        unit.hasAbilityActive("Made of Fire"),
                        unit.hasAbilityActive("Made of Water"),
                    ))
            );
        };
        const base = unit.getBaseCell();
        let best: { cell: XY; route?: IWeightedRoute; cover: number; dist: number } = {
            cell: base,
            cover: cover(base),
            dist: getDistance(base, centroid),
        };
        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        for (const routes of movePath.knownPaths.values()) {
            const route = routes[0];
            if (!route?.route.length || !footprintOk(route.cell)) {
                continue;
            }
            const c = cover(route.cell);
            const d = getDistance(route.cell, centroid);
            // Prefer covering more melee allies; tie-break toward the melee centroid (advance with the line).
            if (c > best.cover || (c === best.cover && d < best.dist)) {
                best = { cell: route.cell, route, cover: c, dist: d };
            }
        }
        if (!best.route || (best.cell.x === base.x && best.cell.y === base.y)) {
            return decision; // already best-positioned for the melee line
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            },
        ];
    }
    /**
     * Experimental Healer spell-choice policy (V05_HEALPOLICY). The base Healer heals a hurt L3-4 stack
     * (>30% lost) else casts Spiritual Armor, and never uses Blessing. This forces a single play so each can
     * be measured head-to-head: "armor" (always armour the top attacker), "heal" (heal anyone hurt), "bless"
     * (max-damage buff the highest-spread attacker), "healL4" (eagerly heal a hurt level-4 stack first, else
     * fall back to the inherited play). "base" (default) leaves v0.4's decision untouched.
     */
    private healerPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (healPolicy === "base" || unit.getName() !== "Healer" || unit.getStackPower() < 1) {
            return decision;
        }
        const { grid, matrix, unitsHolder } = context;
        const gridSettings = grid.getSettings();
        const team = unit.getTeam();
        const allies = unitsHolder.getAllAllies(team).filter((a) => !a.isDead());
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
        const canCastOn = (spell: ReturnType<typeof usable>, t: Unit): boolean =>
            !!spell &&
            !!canCastSpell(
                false,
                gridSettings,
                matrix,
                unit,
                t,
                spell,
                t.getBaseCell(),
                t.getMagicResist(),
                t.hasMindAttackResistance(),
                t.canBeHealed(),
                undefined,
            );
        const lostFrac = (a: Unit): number => {
            const cap = a.getMaxHp() * Math.max(1, a.getAmountAlive() + a.getAmountDied());
            return cap > 0 ? 1 - a.getCumulativeHp() / cap : 0;
        };
        const healEligible = (a: Unit): boolean =>
            a.canBeHealed() && a.getMagicResist() !== 100 && a.getHp() < a.getMaxHp();
        const castHeal = (minLost: number, minLevel: number): GameAction[] | undefined => {
            const heal = usable("Heal");
            const t = allies
                .filter((a) => healEligible(a) && a.getLevel() >= minLevel && lostFrac(a) > minLost)
                .sort((p, q) => lostFrac(q) - lostFrac(p))
                .find((a) => canCastOn(heal, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Heal", targetId: t.getId() }]
                : undefined;
        };
        const castArmor = (): GameAction[] | undefined => {
            const armor = usable("Spiritual Armor");
            const t = allies
                .filter((a) => a.getId() !== unit.getId() && !a.hasBuffActive("Spiritual Armor"))
                .sort(
                    (p, q) => q.getAttackDamageMax() * q.getAmountAlive() - p.getAttackDamageMax() * p.getAmountAlive(),
                )
                .find((a) => canCastOn(armor, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Spiritual Armor", targetId: t.getId() }]
                : undefined;
        };
        const castBless = (): GameAction[] | undefined => {
            const bless = usable("Blessing");
            const gain = (a: Unit): number =>
                Math.max(0, a.getAttackDamageMax() - a.getAttackDamageMin()) *
                Math.max(1, a.getAmountAlive()) *
                (a.getAttackType() === RANGE && a.getRangeShots() > 0 ? Math.max(1, a.getRangeShots()) : 1);
            const t = allies
                .filter((a) => a.getId() !== unit.getId() && !a.hasBuffActive("Blessing") && gain(a) > 0)
                .sort((p, q) => gain(q) - gain(p))
                .find((a) => canCastOn(bless, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Blessing", targetId: t.getId() }]
                : undefined;
        };
        // Bless a RANGED unit whose attack spread is large RELATIVE to its max ((max-min)/max) — those gain
        // the most % from a forced-max hit (e.g. Orc 80%, Arbalester 50% vs Cyclops 23%). Among qualifiers,
        // pick the one whose total damage gain (abs spread x stack x shots) is biggest.
        const castBlessRanged = (relThresh: number): GameAction[] | undefined => {
            const bless = usable("Blessing");
            if (!bless) {
                return undefined;
            }
            const relSpread = (a: Unit): number => {
                const mx = a.getAttackDamageMax();
                return mx > 0 ? (mx - a.getAttackDamageMin()) / mx : 0;
            };
            const absGain = (a: Unit): number =>
                (a.getAttackDamageMax() - a.getAttackDamageMin()) *
                Math.max(1, a.getAmountAlive()) *
                Math.max(1, a.getRangeShots());
            const t = allies
                .filter(
                    (a) =>
                        a.getId() !== unit.getId() &&
                        a.getAttackType() === RANGE &&
                        a.getRangeShots() > 0 &&
                        !a.hasBuffActive("Blessing") &&
                        relSpread(a) >= relThresh,
                )
                .sort((p, q) => absGain(q) - absGain(p))
                .find((a) => canCastOn(bless, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Blessing", targetId: t.getId() }]
                : undefined;
        };
        switch (healPolicy) {
            case "armor":
                return castArmor() ?? decision;
            case "heal":
                return castHeal(0.05, 1) ?? decision;
            case "bless":
                return castBless() ?? decision;
            case "healL4":
                return castHeal(0.2, 4) ?? decision; // eagerly heal a hurt L4, else inherited play
            case "smart": {
                // 1) heal a hurt L4 first; 2) keep any inherited heal (wounded stacks); 3) otherwise bless a
                // high-%-spread ranged unit, else armour the most valuable ally.
                const l4 = castHeal(0.2, 4);
                if (l4) {
                    return l4;
                }
                const inh = decision.find((a) => a.type === "cast_spell");
                if (inh?.type === "cast_spell" && (inh.spellName === "Heal" || inh.spellName === "Mass Heal")) {
                    return decision;
                }
                return castBlessRanged(blessRelThresh) ?? castArmor() ?? decision;
            }
            default:
                return decision;
        }
    }
    /**
     * Keep a fragile aura-emitting FLYER (Pegasus etc.) in its support role. The base AI prefers any
     * available attack over aura positioning — fine for ground bruisers, wrong for a glass-cannon flyer that
     * can reach an enemy almost every turn and so dives in instead of buffing the army (measured 81% attacks,
     * 3% support). When such a flyer's turn is a MARGINAL melee strike (not a guaranteed kill, not a free /
     * retaliation-spent hit) and its aura currently covers allies, reposition for the best coverage instead
     * (planAuraMove), else hold the aura up (hourglass / stay). Kills and free hits are still taken.
     */
    private auraFlyerSupport(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!auraFlyOn || !unit.canFly() || !unit.getAuraEffects().length) {
            return decision;
        }
        const strike = decision.find((a) => a.type === "melee_attack");
        if (!strike || strike.type !== "melee_attack") {
            return decision; // only converts a diving MELEE strike (a flyer shooting from range is fine)
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const target = unitsHolder.getAllUnits().get(strike.targetId);
        if (!target) {
            return decision;
        }
        // A guaranteed kill or a retaliation-free hit is always worth taking, even diving.
        const kill = unit.calculateAttackDamageMin(unit.getAttack(), target, false, 0, 1) >= target.getCumulativeHp();
        const retalFree = context.fightProperties?.hasAlreadyRepliedAttack(target.getId()) ?? false;
        if (kill || retalFree) {
            return decision;
        }
        const gridSettings = grid.getSettings();
        const base = unit.getBaseCell();
        // Nothing to protect right now -> just attack as before.
        if (auraCoverageScore(unit, base, gridSettings, unitsHolder) < 1) {
            return decision;
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        const plan = planAuraMove(unit, movePath.knownPaths, gridSettings, matrix, unitsHolder);
        // 1) A reachable cell covers more allies -> reposition there (stay in support).
        if (
            plan &&
            plan.bestScore > plan.currentScore &&
            unit.canMove() &&
            (plan.bestCell.x !== base.x || plan.bestCell.y !== base.y)
        ) {
            const route = movePath.knownPaths.get(cellKey(plan.bestCell))?.[0];
            if (route?.route.length) {
                return [
                    {
                        type: "move_unit",
                        unitId: unit.getId(),
                        path: route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                        targetCells: this.footprintForCell(unit, plan.bestCell, context),
                        hasLavaCell: route.hasLavaCell,
                        hasWaterCell: route.hasWaterCell,
                    },
                ];
            }
        }
        // 2) Already at the best coverage: hold the aura up rather than dive (hourglass if allowed, else stay).
        if (this.canHourglass(unit, context)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * Guarantee v0.5 never selects a Hidden (Disguise Aura) stack for a strike — the engine refuses such
     * attacks (attack_not_available), wasting the turn. If the chosen melee/range target is Hidden, retarget
     * a melee strike to a legal adjacent non-Hidden enemy; otherwise drop the strike (keep any move, else
     * hold). The base AI already filters Hidden in most paths, so this is a belt-and-suspenders catch-all.
     */
    private excludeHiddenAttack(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const idx = decision.findIndex((a) => a.type === "melee_attack" || a.type === "range_attack");
        if (idx < 0) {
            return decision;
        }
        const atk = decision[idx];
        if (atk.type !== "melee_attack" && atk.type !== "range_attack") {
            return decision;
        }
        const target = context.unitsHolder.getAllUnits().get(atk.targetId);
        if (!target || !isHidden(target)) {
            return decision; // targeting a normal stack — fine
        }
        // Melee: retarget to a legal in-place non-Hidden enemy if one is adjacent now.
        if (atk.type === "melee_attack") {
            const enemyTeam = otherTeam(unit.getTeam());
            const myCells = unit.getCells();
            const alt = context.unitsHolder
                .getAllAllies(enemyTeam)
                .find(
                    (e) =>
                        !e.isDead() &&
                        !isHidden(e) &&
                        !(unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp()) &&
                        e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(mc, ec))),
                );
            if (alt) {
                const acts: GameAction[] = [];
                if (unit.getAttackTypeSelection() !== MELEE) {
                    acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
                }
                acts.push({
                    type: "melee_attack",
                    attackerId: unit.getId(),
                    targetId: alt.getId(),
                    attackFrom: { ...unit.getBaseCell() },
                });
                return acts;
            }
        }
        // No legal retarget (or a Hidden ranged shot): drop the strike, keep any non-attack action, else hold.
        const rest = decision.filter((a, i) => i !== idx && a.type !== "select_attack_type");
        if (rest.some((a) => a.type === "move_unit")) {
            return rest;
        }
        return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * Stage-4 learned melee. When this turn lands a melee strike, re-pick WHICH enemy to hit and FROM WHICH
     * cell among the legal options — in-place-adjacent enemies and reachable cells adjacent to an enemy — by
     * a learned score (damage / focus-kill / free-hit-if-retaliation-spent / target firepower / don't-
     * overextend) anchored to v0.4's own pick. Candidates are footprint-guarded and adjacency-checked, so
     * every emitted strike (and any move into it) is valid by construction. Forced targets (Aggr/taunt) and
     * the default weights both keep v0.4's exact strike.
     */
    private meleeByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const strike = decision.find((a) => a.type === "melee_attack");
        if (!strike || strike.type !== "melee_attack" || unit.getTarget()) {
            return decision; // not a melee strike, or a forced target we may not retarget
        }
        const [
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            wDmg,
            wKill,
            wRetal,
            wThreat,
            wStand,
            wIncumbent,
            wRetalCost,
            wFocus,
            wStandSupport,
            wTargetWounded,
        ] = this.w;
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const base = unit.getBaseCell();
        const myCells = unit.getCells();
        const myAllies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        const fp = context.fightProperties;
        const v4target = strike.targetId;
        const v4from = strike.attackFrom ?? base;
        const cowardlyVs = (e: Unit): boolean =>
            unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp();
        const enemies = unitsHolder
            .getAllAllies(enemyTeam)
            .filter((e) => !e.isDead() && !isHidden(e) && !cowardlyVs(e));
        if (!enemies.length) {
            return decision;
        }
        const footprintOk = (cell: XY): boolean => {
            const f = this.footprintForCell(unit, cell, context);
            return (
                f.length > 0 &&
                (grid.areAllCellsEmpty(f, unit.getId()) ||
                    grid.canOccupyCells(
                        f,
                        unit.hasAbilityActive("Made of Fire"),
                        unit.hasAbilityActive("Made of Water"),
                    ))
            );
        };
        const adjacentFrom = (cell: XY, e: Unit): boolean => {
            const f = this.footprintForCell(unit, cell, context);
            return f.some((mc) => e.getCells().some((ec) => isAdjacentCell(mc, ec)));
        };

        type Cand = { target: Unit; cell: XY; route?: IWeightedRoute };
        const cands: Cand[] = [];
        // ANCHOR: v0.4's own (target, stand cell) is always a candidate, so the meleeIncumbent weight can
        // make it win (default behaviour). Without this, a tie at 0 could deviate from v0.4 even at default.
        const v4targetUnit = unitsHolder.getAllUnits().get(v4target);
        if (v4targetUnit && !v4targetUnit.isDead() && !isHidden(v4targetUnit)) {
            cands.push({ target: v4targetUnit, cell: v4from });
        }
        // In-place strikes: any enemy already adjacent to the unit's current footprint.
        for (const e of enemies) {
            if (e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(mc, ec)))) {
                cands.push({ target: e, cell: base });
            }
        }
        // Move-and-strike: reachable cells whose footprint sits adjacent to an enemy (skip if can't move).
        if (unit.canMove()) {
            const movePath = pathHelper.getMovePath(
                base,
                matrix,
                unit.getSteps(),
                grid.getAggrMatrixByTeam(enemyTeam),
                unit.canFly(),
                unit.isSmallSize(),
                unit.hasAbilityActive("Made of Fire"),
            );
            for (const routes of movePath.knownPaths.values()) {
                const route = routes[0];
                if (!route?.route.length || !footprintOk(route.cell)) {
                    continue;
                }
                for (const e of enemies) {
                    if (adjacentFrom(route.cell, e)) {
                        cands.push({ target: e, cell: route.cell, route });
                    }
                }
            }
        }
        if (!cands.length) {
            return decision;
        }
        const myHp = Math.max(1, unit.getCumulativeHp());
        // First-mover mitigation: when most enemies haven't acted yet (we commit before they react), avoid
        // reactable trades more strongly. wRetalCostFM scales the retaliation cost by that exposure.
        const fm = this.fmExposure(unit, context);
        const wRetalCostFM = this.w[25] ?? 0;
        const score = (c: Cand): number => {
            const min = unit.calculateAttackDamageMin(unit.getAttack(), c.target, false, 0, 1);
            const max = unit.calculateAttackDamageMax(unit.getAttack(), c.target, false, 0, 1);
            const hp = c.target.getCumulativeHp();
            const effective = Math.min((min + max) / 2, hp);
            const dmg = effective / Math.max(1, c.target.getMaxHp());
            const kill = effective >= hp ? 1 : 0;
            const replied = fp?.hasAlreadyRepliedAttack(c.target.getId()) ?? false;
            const retalFree = replied ? 1 : 0;
            const threat = firepowerOf(c.target) / 1000;
            const standThreat = countMeleeThreatsToCell(c.cell, matrix, enemyTeam) / 3;
            const incumbent = c.target.getId() === v4target && c.cell.x === v4from.x && c.cell.y === v4from.y ? 1 : 0;
            // Focus-fire: how many of OUR other stacks are already adjacent to this target (so the army can
            // wipe it together). Concentrating melee on an already-engaged stack finishes it faster.
            const focusFire =
                myAllies.filter((a) =>
                    a.getCells().some((ac) => c.target.getCells().some((tc) => isAdjacentCell(ac, tc))),
                ).length / 2;
            // Expected retaliation damage taken (as a fraction of our HP) — 0 if this strike kills the stack
            // or the target already retaliated this lap. The core favorable-trade signal: avoid striking a
            // hard-hitting survivor. Weight is learned (expected negative).
            const counter =
                kill || replied
                    ? 0
                    : Math.min(
                          (c.target.calculateAttackDamageMin(c.target.getAttack(), unit, false, 0, 1) +
                              c.target.calculateAttackDamageMax(c.target.getAttack(), unit, false, 0, 1)) /
                              2,
                          myHp,
                      ) / myHp;
            // Stand-support: how many of OUR stacks sit adjacent to the stand cell (screen/protect us there).
            const fpCells = this.footprintForCell(unit, c.cell, context);
            const standSupport =
                myAllies.filter((a) => a.getCells().some((ac) => fpCells.some((fc) => isAdjacentCell(ac, fc)))).length /
                2;
            // Target-wounded: fraction of the target stack already dead — finishing a nearly-dead stack removes
            // a whole unit from the board (worth more than chip damage on a fresh one).
            const tDead = c.target.getAmountDied();
            const tAlive = c.target.getAmountAlive();
            const targetWounded = tDead + tAlive > 0 ? tDead / (tDead + tAlive) : 0;
            return (
                wDmg * dmg +
                wKill * kill +
                wRetal * retalFree +
                wThreat * threat +
                wStand * standThreat +
                wIncumbent * incumbent +
                wRetalCost * counter +
                wFocus * focusFire +
                wStandSupport * standSupport +
                wTargetWounded * targetWounded +
                wRetalCostFM * counter * fm
            );
        };
        let best: Cand | undefined;
        let bestScore = -Infinity;
        for (const c of cands) {
            const s = score(c);
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        // Policy agrees with v0.4 (or nothing better) -> keep v0.4's exact strike (incl. any move it built).
        if (!best || (best.target.getId() === v4target && best.cell.x === v4from.x && best.cell.y === v4from.y)) {
            return decision;
        }
        const acts: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        if (best.route && (best.cell.x !== base.x || best.cell.y !== base.y)) {
            acts.push({
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            });
        }
        acts.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: best.target.getId(),
            attackFrom: { ...best.cell },
        });
        return acts;
    }
    /**
     * Stage-2 learned positioning. When this turn is a pure reposition (a single move_unit, no strike or
     * cast), re-pick the destination among the engine's reachable cells by a learned linear score over
     * cell features (advance toward the enemy, cohesion with allies, lava/water hazard, and an incumbency
     * bias toward v0.4's own pick). Candidates come straight from pathHelper.getMovePath — exactly the set
     * v0.3 moves within — so every emitted move is valid by construction (no new engine rejections). With
     * the default weights v0.4's destination always wins, so untrained v0.5 == v0.4.
     */
    private repositionByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const move = decision.find((a) => a.type === "move_unit");
        if (!move || move.type !== "move_unit") {
            return decision; // not a move turn
        }
        if (decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // move is part of a strike/cast — leave the (target-constrained) stand cell alone
        }
        const [, , , , , , wAdvance, wCohesion, wHazard, wIncumbent, wThreat, wAggrZone, wShoot, wAura] = this.w;
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const base = unit.getBaseCell();
        const dest = move.path.length ? move.path[move.path.length - 1] : base; // v0.4's chosen anchor cell
        const allies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        const centroid = allies.length
            ? {
                  x: allies.reduce((s, a) => s + a.getBaseCell().x, 0) / allies.length,
                  y: allies.reduce((s, a) => s + a.getBaseCell().y, 0) / allies.length,
              }
            : base;
        const steps = Math.max(1, unit.getSteps());
        const minEnemyDist = (c: XY): number => Math.min(...enemies.map((e) => getDistance(c, e.getBaseCell())));
        const baseEnemyDist = minEnemyDist(base);
        const baseCentroidDist = getDistance(base, centroid);
        // Per-unit constants for the shoot-readiness feature: a shooter with ammo wants a cell within its
        // shot distance of an enemy but NOT boxed in melee (dist >= 2).
        const isShooter = unit.getAttackType() === RANGE && unit.getRangeShots() > 0;
        const shotDist = unit.getRangeShotDistance();
        const gridSettings = grid.getSettings();
        // First-mover mitigation: when committing before the enemy reacts (high fmExposure), let CEM dial back
        // the advance (don't over-extend into a reactable position). wAdvanceFM modulates advance by exposure.
        const fm = this.fmExposure(unit, context);
        const wAdvanceFM = this.w[24] ?? 0;
        const score = (cell: XY, route: IWeightedRoute): number => {
            const advance = (baseEnemyDist - minEnemyDist(cell)) / steps; // + => closer to the enemy
            const cohesion = (baseCentroidDist - getDistance(cell, centroid)) / steps; // + => toward allies
            const hazard = route.hasLavaCell || route.hasWaterCell ? 1 : 0;
            const incumbent = cell.x === dest.x && cell.y === dest.y ? 1 : 0;
            // Richer (stage-3) features — what v0.4's hand-tuned positioning can't express directly.
            const threat = countMeleeThreatsToCell(cell, matrix, enemyTeam) / 3; // enemy melee that can reach this cell
            const aggrZone = route.firstAggrMet ? 1 : 0; // route steps into the enemy threat zone
            const ed = minEnemyDist(cell);
            const shootReady = isShooter && ed >= 2 && ed <= shotDist ? 1 : 0; // can likely fire from here
            const aura = auraCoverageScore(unit, cell, gridSettings, unitsHolder) / 4; // aura emitters cover more allies
            return (
                wAdvance * advance +
                wCohesion * cohesion +
                wHazard * hazard +
                wIncumbent * incumbent +
                wThreat * threat +
                wAggrZone * aggrZone +
                wShoot * shootReady +
                wAura * aura +
                wAdvanceFM * advance * fm
            );
        };

        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        // A candidate's full footprint must be occupiable — getMovePath keys on the anchor, but a large
        // unit's footprint can still clip an occupied cell. Mirror v0.4's moveIsBlocked guard exactly so we
        // never emit a move the engine would reject (validity by construction == 0 added rejections).
        const footprintOk = (cell: XY): boolean => {
            const fp = this.footprintForCell(unit, cell, context);
            return (
                fp.length > 0 &&
                (grid.areAllCellsEmpty(fp, unit.getId()) ||
                    grid.canOccupyCells(
                        fp,
                        unit.hasAbilityActive("Made of Fire"),
                        unit.hasAbilityActive("Made of Water"),
                    ))
            );
        };
        let best: { cell: XY; route: IWeightedRoute } | undefined;
        let bestScore = -Infinity;
        for (const routes of movePath.knownPaths.values()) {
            const route = routes[0];
            if (!route?.route.length) {
                continue;
            }
            const s = score(route.cell, route);
            if (s > bestScore && footprintOk(route.cell)) {
                bestScore = s;
                best = { cell: route.cell, route };
            }
        }
        // No better-or-equal alternative, or the policy agrees with v0.4's pick -> keep v0.4's decision verbatim.
        if (!best || (best.cell.x === dest.x && best.cell.y === dest.y)) {
            return decision;
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            },
        ];
    }
    /**
     * Learned shot scorer. Sums a weighted feature vector over every unit a candidate shot hits — enemies
     * add value, our own units (AOE splash) subtract. The default weights reproduce v0.4's "2x range,
     * pure-damage" scoring exactly; the trained weights additionally bias toward finishing a stack
     * (shotKill), silencing high-firepower shooters (shotFirepower) and higher-tier targets (shotLevel).
     * hitsEnemyRange is reported whenever a shot touches any enemy RANGE unit, independent of the weights,
     * so the inherited hourglass/hold logic is unaffected.
     */
    protected override scoreShot(
        unit: Unit,
        evaluation: ReturnType<AttackHandler["evaluateRangeAttack"]>,
        fromTeam: number,
        enemyTeam: number,
    ): { value: number; hitsEnemyRange: boolean } {
        const [wDamage, wKill, wRange, wFirepower, wLevel, wFriendlyFire] = this.w;
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
                    value += wDamage * effective;
                    if (effective >= targetHp) {
                        value += wKill * targetHp; // this shot wipes the whole stack
                    }
                    if (target.getAttackType() === RANGE) {
                        value += wRange * effective; // silence their shooters
                        hitsEnemyRange = true;
                    }
                    value += wFirepower * (firepowerOf(target) / 1000);
                    value += wLevel * target.getLevel();
                } else if (target.getTeam() === fromTeam) {
                    value -= wFriendlyFire * effective; // friendly fire (AOE splash) is a cost
                }
            }
        }
        return { value, hitsEnemyRange };
    }
}

export const STRATEGY_V0_5: IAIStrategy = new StrategyV0_5();
