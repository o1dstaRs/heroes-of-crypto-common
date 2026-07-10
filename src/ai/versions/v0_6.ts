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
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { auraRelevanceWeight, setPreferAttackOverMining } from "../ai";
import { GRID_SIZE } from "../../grid/grid_constants";
import { otherTeam } from "./v0_1";
import { StrategyV0_5 } from "./v0_5";
import { routeAreaThrow } from "./area_throw_router";
import { routeUniversalCaster } from "./caster_router";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;

// Adjacent-SPLASH ranged AOE: a shot deals % damage to every unit ADJACENT to the target cell, so a
// clustered deployment eats one blast across several stacks. Dispersing our army against these is a
// measured win (150k A/B: Gargantuan/Area Throw +5.58pp, Tsar Cannon/Large Caliber +0.47pp for the
// dispersing side). Deliberately NOT dispersing vs Fire Breath (a LINE — spreading doesn't dodge it and
// the lost cohesion cost -3.08pp) or Chain Lightning (bounce — neutral). So the trigger is splash-only.
const AOE_PLACEMENT_ABILITIES = ["Area Throw", "Large Caliber"];

/**
 * v0.6's OWN fight-weight vector, kept SEPARATE from v0.5's so v0.6 can be trained further while v0.5 stays
 * byte-for-byte frozen. Read from process.env.V06_WEIGHTS during a sim; falls back to this default on any
 * malformed input so a bad env can never crash live play.
 *
 * DEPLOYMENT-DISTRIBUTION champion (2026-07-07): trained on a 50/50 MIX of melee + random rosters
 * (FIGHT_MELEE_ROSTERS=0.5) via cem.mjs OPT=v0.6 BASE=v0.4, because the shipped melee draft makes LIVE armies
 * melee-heavy while the v0.5 champion was trained only on random rosters. Beats the v0.5 champion by
 * **+0.97pp on melee armies** (the distribution we actually field) across 9 fresh held-out seeds (8/9 positive,
 * ~5σ), with a statistically-zero effect on random rosters (-0.35 ± 0.36pp — NOT a regression). An earlier
 * ALL-melee vector gained more on melee but cratered -4.6pp on varied armies (fragile specialist, rejected);
 * this mixed-trained vector is the robust win. v0.5 (DEFAULT_V05_W) is untouched.
 */
export const DEFAULT_V06_W: readonly number[] = [
    1.4988647158738944, -0.5910087272415239, 0.2097601006630517, 1.7452804854334238, 2.16542605693082,
    5.743403823992855, 1.602189424260613, 0.6855127959862942, -1.7480291327672626, 1.4620468328764753,
    0.38001139143097323, 2.5409750188308164, 3.124719724241719, 1.6320770892411578, -0.030107250290171146,
    1.8681607730679253, 4.096705760150673, 5.572435627215912, -1.149135731477136, 0.22806599275532963,
    -1.3582679156796398, 1.3998191818966608, -2.0543741522611674, -2.125410620764743, -1.090570653158559,
    2.2486218345190974, -0.018287685456403264, 0.4211808557043179, 1.0878744716707025, -0.7826234799203378,
    -0.6060920991254477, 0.5107951707643916, -1.824425650872599, 2.695331079711184, -0.9652375927102732,
    0.7054122954412628, -0.42704814554939513, 2.2716833937408287, -0.09902588985700955, -0.4870612969172853,
    4.333268254490518, 2.1266469039736355, -0.8708994895616353, 0.7812127211154111, 0.397233221968303,
    0.5054064078311156, 1.951625586424147, -0.7168503825154638, 1.4148114632296496, 0.24884470489427854,
    -2.753057668341909, 0.3892462431626682, 0.7293253574050823, 0.3358745432824668, 0.26720797483195136,
    1.0411928379179989,
    // [56] Rapid Charge weight — anchor 0 (v0.5-equivalent, no charge-distance bias). v0.6 trains this on melee
    // fights so Champion/Wolf Rider/Nomad prefer a longer charge (more damage) instead of short/in-place strikes.
    0,
    // [57] Target-ranged (pre-emption) weight — anchor 0. v0.6 trains it to bias melee toward enemy shooters
    // (pre-empt/pin them before their firepower lands). Matters in mixed fights; 0 keeps current behavior.
    0,
];

export function loadV06Weights(): number[] {
    const raw = process.env.V06_WEIGHTS;
    if (raw) {
        try {
            const arr = JSON.parse(raw);
            if (
                Array.isArray(arr) &&
                arr.length === DEFAULT_V06_W.length &&
                arr.every((x) => typeof x === "number" && Number.isFinite(x))
            ) {
                return arr as number[];
            }
        } catch {
            /* malformed -> fall through to default (== frozen v0.5 champion) */
        }
    }
    return DEFAULT_V06_W.slice();
}
const COMBAT_ACTIONS = new Set(["melee_attack", "range_attack", "cast_spell", "obstacle_attack", "area_throw_attack"]);

/**
 * v0.6 — the FULL-GAME AI generation, built on the v0.5 fight champion. Adds a trained DRAFT + setup (baked as
 * weight defaults) and a PROACTIVE RANGED KITE that v0.5 lacks: v0.5 only disengages a shooter once it is
 * already pinned, so a ranged unit out of range ADVANCES into melee (fallbackTurn minimises distance to the
 * enemy) and gets meleed before its range pays off. The kite makes a ranged unit that would walk into an
 * enemy's melee reach HOLD instead, so the enemy enters ITS shooting range first. Gated (V06_KITE=off →
 * byte-for-byte v0.5 fight). v0.6 is now the shipped DEFAULT_AI_VERSION; its draft + setup weights are the
 * live enhancement over the frozen v0.5 baseline.
 */
export class StrategyV0_6 extends StrategyV0_5 {
    public override readonly version: string = "v0.6";
    /** Load v0.6's OWN fight weights (V06_WEIGHTS env or DEFAULT_V06_W) — decoupled from v0.5's V05_WEIGHTS. */
    public constructor() {
        super(loadV06Weights());
        // v0.6 improvement: aura-bearers weight covered targets by relevance, so Griffin's range-null aura
        // chases enemy SHOOTERS instead of blanketing the most bodies. V06_AURA_FLAT=1 restores v0.5's flat
        // count for A/B measurement.
        this.auraWeight = process.env.V06_AURA_FLAT === "1" ? () => 1 : auraRelevanceWeight;
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        // v0.6: an idle melee unit that can instead reach + attack an enemy this turn does that rather than
        // mining the center mountain ("why is the AI attacking the mountain?"). On by default; V06_LEGACY_MINE=1
        // restores the old attack-preempting mining so a tournament can A/B the change against the same v0.5.
        setPreferAttackOverMining(process.env.V06_LEGACY_MINE !== "1");
        let decision: GameAction[];
        try {
            decision = super.decideTurn(unit, context);
        } finally {
            setPreferAttackOverMining(false);
        }
        decision = routeUniversalCaster(unit, context, decision);
        decision = routeAreaThrow(unit, context, decision);
        // Kite is OPT-IN (V06_KITE=on). The minimal "hold instead of advance" version measured neutral-to-slightly
        // negative (melee 64.8%→66.2% vs ranged) — too crude; a real kite needs advance-to-range→shoot→retreat.
        // Default off keeps v0.6's fight byte-for-byte v0.5 (only the draft/setup weights differ).
        if (process.env.V06_KITE !== "on") {
            return decision;
        }
        return this.rangedKite(unit, context, decision);
    }
    /**
     * Proactive kite: if a RANGED unit's chosen turn is a pure ADVANCE (a move with no attack/shot) and it can't
     * land a shot this turn, and advancing would put it inside an enemy's melee reach, HOLD position instead —
     * wait for the enemy to walk into shooting range rather than marching into melee. Never overrides a real
     * shot/melee/cast; only converts a self-destructive advance into a hold.
     */
    private rangedKite(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (unit.getAttackType() !== RANGE || !unit.canMove()) {
            return decision;
        }
        if (decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // already shooting/attacking — leave it
        }
        if (this.canLandRange(unit, context)) {
            return decision; // it can shoot from here; don't interfere
        }
        const move = decision.find((a) => a.type === "move_unit");
        if (!move || move.type !== "move_unit" || !move.path?.length) {
            return decision; // no advance to fix (a hold / non-move) — leave it
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = context.unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const distTo = (fp: XY[]): number =>
            Math.min(
                ...enemies.flatMap((e) =>
                    e
                        .getCells()
                        .map((ec) => Math.min(...fp.map((fc) => Math.abs(fc.x - ec.x) + Math.abs(fc.y - ec.y)))),
                ),
            );
        // Only intervene when the base decision ADVANCES toward the enemy (v0.1 fallbackTurn minimising distance
        // — the self-destructive march). A retreat/disengage (v0.5 noMeleeRetreat) or lateral move is left alone.
        const base = unit.getBaseCell();
        const baseDist = distTo(this.footprintForCell(unit, base, context));
        const destDist = distTo(this.footprintForCell(unit, move.path[move.path.length - 1], context));
        if (destDist >= baseDist) {
            return decision;
        }
        // Enemy melee reach next turn = its move range + one step onto an adjacent cell. Staying strictly beyond
        // it keeps the shooter safe for a turn while it closes to firing range.
        const maxEnemyReach = Math.max(...enemies.map((e) => e.getSteps())) + 1;
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        if (!movePath.knownPaths.size) {
            return decision;
        }
        // Kite target = the reachable cell CLOSEST to the enemy that is still outside melee reach (the "safe
        // frontier"). Advance as far as we safely can so the enemy walks into our shot range next turn, instead
        // of marching into melee (base's advance) OR sitting still out of range (the old crude hold).
        let best: IWeightedRoute | undefined;
        let bestDist = Infinity;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            const dist = distTo(this.footprintForCell(unit, route.cell, context));
            if (dist <= maxEnemyReach) {
                continue; // enemy could reach melee here next turn — not a safe firing perch
            }
            if (dist < bestDist) {
                bestDist = dist;
                best = route;
            }
        }
        if (!best || (best.cell.x === base.x && best.cell.y === base.y)) {
            // No safe cell closer than we already are — don't march into melee; hold and let the enemy approach.
            return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.hasLavaCell,
                hasWaterCell: best.hasWaterCell,
            },
        ];
    }
    /**
     * Enemy-AOE-aware deployment. If the opponent fields an adjacent-SPLASH shooter (Area Throw / Large
     * Caliber — Gargantuan, Tsar Cannon), spread our stacks so one blast can't catch several — otherwise
     * keep v0.5's formation. Placement is otherwise enemy-BLIND, so this is the first time deployment
     * reacts to who it's facing. Splash-only by design: a 150k A/B showed dispersion HELPS vs splash
     * (+5.58pp Gargantuan) but HURTS vs Fire Breath's line (-3.08pp, cohesion loss). Gated per-team by
     * V06_DISPERSE_TEAM for A/B; unset = production default (disperse whenever the enemy has splash AOE).
     * v0.5 is untouched.
     */
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const gate = process.env.V06_DISPERSE_TEAM;
        const teamName = context.team === PBTypes.TeamVals.LOWER ? "lower" : "upper";
        const gateOn = gate ? gate === "both" || gate === teamName : true;
        if (gateOn && this.enemyHasAoe(context)) {
            return placeArmyDispersed(units, context);
        }
        return super.placeArmy(units, context);
    }
    private enemyHasAoe(context: IPlacementContext): boolean {
        return context.unitsHolder
            .getAllEnemyUnits(context.team)
            .some((u) => !u.isDead() && AOE_PLACEMENT_ABILITIES.some((ab) => u.hasAbilityActive(ab)));
    }
}

/**
 * v0.5's formation (ranged deep, melee front wall, flyer wing, support back) but each stack is placed on a
 * cell with NO already-placed ally in its 8-neighbourhood — a 1-cell gap that breaks the adjacency an AOE
 * blast needs to chain across stacks. Falls back to the tightest free cell when the zone is too small to
 * keep gaps. Mirrors StrategyV0_3.placeArmy; only the placeBy adds the anti-cluster pass.
 */
function placeArmyDispersed(units: Unit[], context: IPlacementContext): Map<string, XY> {
    const placements = new Map<string, XY>();
    const occupied = new Set<number>();
    const legal = context.placement.possibleCellHashes();
    const baseCells = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
    if (!baseCells.length) {
        return placements;
    }
    const key = (c: XY): number => (c.x << 4) | c.y;
    const frontness = (c: XY): number => (context.team === PBTypes.TeamVals.LOWER ? c.y : GRID_SIZE - 1 - c.y);
    const xs = baseCells.map((c) => c.x);
    const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const edgeness = (c: XY): number => Math.abs(c.x - centreX);
    const footprintFor = (u: Unit, base: XY): XY[] =>
        u.isSmallSize()
            ? [base]
            : [
                  { x: base.x, y: base.y },
                  { x: base.x - 1, y: base.y },
                  { x: base.x, y: base.y - 1 },
                  { x: base.x - 1, y: base.y - 1 },
              ];
    const footprintFree = (fp: XY[]): boolean => fp.every((c) => legal.has(key(c)) && !occupied.has(key(c)));
    const clusters = (fp: XY[]): boolean => {
        for (const c of fp) {
            for (let dx = -1; dx <= 1; dx += 1) {
                for (let dy = -1; dy <= 1; dy += 1) {
                    if ((dx || dy) && occupied.has(key({ x: c.x + dx, y: c.y + dy }))) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    const commit = (u: Unit, base: XY, fp: XY[]): void => {
        for (const c of fp) {
            occupied.add(key(c));
        }
        placements.set(u.getId(), { x: base.x, y: base.y });
    };
    const placeBy = (u: Unit, compare: (a: XY, b: XY) => number): void => {
        const sorted = [...baseCells].sort(compare);
        for (const base of sorted) {
            const fp = footprintFor(u, base);
            if (footprintFree(fp) && !clusters(fp)) {
                commit(u, base, fp);
                return;
            }
        }
        for (const base of sorted) {
            const fp = footprintFor(u, base);
            if (footprintFree(fp)) {
                commit(u, base, fp);
                return;
            }
        }
    };
    const bySizeLargeFirst = (a: Unit, b: Unit): number => (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1);
    const isRange = (u: Unit): boolean => u.getAttackType() === RANGE;
    const isMeleeU = (u: Unit): boolean => u.getAttackType() === MELEE;
    const ranged = units.filter(isRange).sort(bySizeLargeFirst);
    const melee = units.filter(isMeleeU).sort(bySizeLargeFirst);
    const support = units.filter((u) => !isRange(u) && !isMeleeU(u)).sort(bySizeLargeFirst);
    for (const u of ranged) {
        placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(b) - edgeness(a));
    }
    const isFlyer = (u: Unit): boolean => u.canFly();
    for (const u of melee.filter((u) => !isFlyer(u))) {
        placeBy(u, (a, b) => frontness(b) - frontness(a) || edgeness(a) - edgeness(b));
    }
    for (const u of melee.filter(isFlyer)) {
        placeBy(u, (a, b) => frontness(b) - frontness(a) || a.x - b.x);
    }
    for (const u of support) {
        placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(a) - edgeness(b));
    }
    return placements;
}

export const STRATEGY_V0_6: IAIStrategy = new StrategyV0_6();
