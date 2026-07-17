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

import { LUCK_CHANGE_FOR_SHIELD, MORALE_CHANGE_FOR_CLOCK, MORALE_CHANGE_FOR_SHIELD } from "../constants";
import { evaluateAffectedUnits } from "../abilities/aoe_range_ability";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    getCellsAroundCell,
    getCellsAroundPosition,
    getPositionForCell,
    getRangeAttackSideCenter,
    isCellWithinGrid,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../grid/grid_math";
import type { IWeightedRoute } from "../grid/path_definitions";
import type { AttackHandler } from "../handlers/attack_handler";
import { canCastSpell, canCastSummon, canMassCastSpell } from "../spells/spell_helper";
import type { Spell } from "../spells/spell";
import { SpellTargetType } from "../spells/spell_properties";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import { meleeAttackTypeSelectionPrefix } from "./melee_attack_type";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

const otherTeam = (team: number): number => (team === LOWER ? UPPER : LOWER);
const isAdjacentCell = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
const isHidden = (u: Unit): boolean => u.hasBuffActive("Hidden") || u.hasAbilityActive("Hidden");

/**
 * F4 — THE shared enumerated candidate generator (v0.7 roadmap).
 *
 * One enumeration of every ENGINE-LEGAL candidate turn for the acting unit, consumed by the tactical
 * capability modules (Q1), the wide-candidate rollout search (B2/RAWS) and any future learned policy
 * (B3/NEURO). It supersedes lookahead.ts buildCandidates (<=5, melee-only). Design rules:
 *
 *  - CANDIDATE 0 IS ALWAYS THE INCUMBENT decision (the strategy's own v0.6 pick, passed in), so every
 *    consumer inherits the anchor pattern: a consumer that always scores candidate 0 highest reproduces
 *    the shipped behaviour byte-for-byte.
 *  - LEGALITY FIRST: every candidate mirrors the exact checks the GameActionEngine / AttackHandler /
 *    spell_helper run on apply, so a candidate the ranked server would reject is a bug (see the
 *    obstacle-attack world-pos incident: a silently-rejected action class cost days). Enumerated classes:
 *      move          — every reachable destination (pathHelper.getMovePath, footprint-checked)
 *      melee         — every legal (target x stand-cell) pair, in-place and move-and-strike, emitted as
 *                      the measured-better separate move_unit + stationary melee_attack pair
 *      shot          — every enemy x visible-edge aim (incl. alternative aims with DIFFERENT hit sets;
 *                      redundant aims hitting the identical unit set at identical divisors are deduped)
 *      area_throw    — Area Throw (Gargantuan): every legal empty target cell whose splash reaches >=1
 *                      enemy (previously ZERO AI emission for this whole action class)
 *      spell         — every castable spell x target, incl. the MELEE_MAGIC-granted ones: Angel's
 *                      Resurrection (targets living allies with dead bodies; BURNS the on-death passive
 *                      charge — exposed as an opportunity-cost feature), Valkyrie's Wind Flow
 *                      (ALL_FLYING mass), Harpy's Castling (ENEMY_WITHIN_MOVEMENT_RANGE), plus
 *                      heals/buffs/debuffs/summons
 *      defend        — luck shield (always legal for the acting unit)
 *      wait          — hourglass, when the engine would accept it
 *    (obstacle_attack — mountain mining on BLOCK_CENTER — is NOT enumerated yet; the incumbent decision
 *    carries it when v0.6's mining policy picks it. Backlog.)
 *  - Enumeration is COMPLETE by default; per-class caps are opt-in and every applied cap is reported in
 *    `truncated` so consumers can log it (the "principled top-K with the cap logged" contract).
 *  - DETERMINISTIC and RNG-FREE: never draws from the seeded tournament stream (summon target cells are
 *    picked deterministically, not via getRandomGridCellAroundPosition), so generating candidates cannot
 *    desync a paired A/B or a replay.
 *
 * FEATURIZATION STUB (ICandidateFeatures): every candidate carries the morale/luck-economy and
 * initiative-order fields that were flagged invisible in every prior feature set, plus cheap value/cost
 * stubs. Backlog for consumers to extend: morale-from-move-distance, luck-aura coverage deltas, the
 * target's own morale/luck state, deny-turn (target hasn't acted yet), spell power economy.
 */
export type CandidateKind = "incumbent" | "wait" | "defend" | "move" | "melee" | "shot" | "area_throw" | "spell";

export interface ICandidateFeatures {
    /** Immediate morale cost/gain of the action ITSELF (wait -3, defend -2; 0 stub for the rest). */
    moraleDelta: number;
    /** Immediate luck gain (defend/luck-shield +3; 0 otherwise). */
    luckDelta: number;
    /** Fraction of LIVING enemies that have not yet acted this lap (v0.5's hourglass/first-mover signal). */
    enemiesNotYetActedFrac: number;
    /** Fraction of LIVING allies (excl. the acting unit) that have not yet acted this lap. */
    alliesNotYetActedFrac: number;
    /** Current lap number (0 when fightProperties is unavailable). */
    lap: number;
    /** 1 when this candidate spends the unit's once-per-lap hourglass. */
    hourglassSpent: 0 | 1;
    /** 1 when this candidate consumes a ranged shot (range_attack / area_throw_attack). */
    spendsRangeShot: 0 | 1;
    /** 1 when this candidate consumes a spell charge (cast_spell). */
    spendsSpellCharge: 0 | 1;
    /**
     * 1 when this cast burns the caster's own on-death Resurrection charge (Angel: the 50%-on-death
     * passive and the castable spell share ONE charge — units_holder.deleteUnitById useSpell()s it).
     * The opportunity cost of casting Resurrection on an ally is losing the Angel's own auto-res.
     */
    burnsResurrectionCharge: 0 | 1;
    /** Hit-weighted damage estimate using engine miss/AOE modifiers; splash friendly-fire subtracts. */
    expectedDamage: number;
    /** 1 when the estimate kills the primary target stack outright. */
    expectedKill: 0 | 1;
}

/**
 * Shot-only observations that are useful to a same-class target/aim scorer. They deliberately stay outside
 * `ICandidateFeatures`: the hardened IL v2 corpus has a fixed 11-value feature vector, and extending that
 * serialized schema requires a separately versioned corpus. These values are deterministic views of signals
 * the v0.5 shot scorer already reads; they do not affect candidate generation or live decisions.
 */
export interface IShotCandidateFeatures {
    /** Expected effective damage to all enemies before friendly-fire is subtracted. */
    enemyDamage: number;
    /** Expected effective damage to allied stacks caught by the shot. */
    friendlyFireDamage: number;
    /** Expected effective damage dealt specifically to the aimed stack. */
    primaryTargetDamage: number;
    /** v0.5's target firepower proxy, normalized by 1,000. */
    targetFirepower: number;
    targetLevel: number;
    targetIsRanged: 0 | 1;
    targetCanCastSpells: 0 | 1;
    targetNotYetActed: 0 | 1;
    /** Fraction of the target stack already dead. */
    targetWoundedFraction: number;
    /** v0.5's focus-fire signal: adjacent allied stacks divided by two. */
    targetFocusFire: number;
}

export interface IEnumeratedCandidate {
    kind: CandidateKind;
    /** Ordered engine actions implementing the candidate (same convention as IAIStrategy.decideTurn). */
    actions: GameAction[];
    /** Primary target unit id (attacks, targeted spells). */
    targetId?: string;
    /** Spell name for kind === "spell". */
    spellName?: string;
    /** Move destination / area-throw aim cell / summon cell (base cell for large units). */
    targetCell?: XY;
    /** Melee stand cell (the attackFrom base cell). */
    standCell?: XY;
    /** Deterministic shot-only metadata; absent for non-shot candidates. */
    shotFeatures?: IShotCandidateFeatures;
    features: ICandidateFeatures;
}

export interface IEnumerateOptions {
    /** Cap on move destinations, kept nearest-to-enemy first (0/undefined = all reachable). */
    maxMoveDestinations?: number;
    /** Cap on melee (target x stand-cell) pairs, kept by expected damage (0/undefined = all). */
    maxMeleePairs?: number;
    /** Cap on ranged aims, kept by expected damage (0/undefined = all distinct hit sets). */
    maxShotAims?: number;
    /** Cap on area-throw target cells, kept by expected damage (0/undefined = all relevant). */
    maxAreaThrowCells?: number;
    /**
     * Dataset-only metadata enrichment for candidate 0. When its exact action is rediscovered by the
     * generator, copy the generated candidate's observations onto the incumbent anchor. Default false;
     * actions, ordering, deduplication, caps, and live scoring are unchanged.
     */
    enrichIncumbentMetadata?: boolean;
}

export interface ICandidateSet {
    /** Candidate 0 is ALWAYS the incumbent decision passed in. */
    candidates: IEnumeratedCandidate[];
    /** Candidate classes whose enumeration hit a cap — consumers should log these. */
    truncated: CandidateKind[];
}

/**
 * Base cells of SMALL living enemies standing within the unit's movement range — the legality input for
 * ENEMY_WITHIN_MOVEMENT_RANGE spells (Harpy's Castling). Mirrors the client's arming path
 * (Sandbox.currentEnemiesCellsWithinMovementRange): pathing runs on grid.getMatrixNoUnits() (enemy-occupied
 * cells must be REACHABLE-through, not blocked), no aggro board, small/fly/lava flags from the unit.
 *
 * Exported for consumers to wire into IGameActionEngineContext.getCurrentEnemiesCellsWithinMovementRange —
 * the engine's castSpell re-validates against that context callback, so the SAME list must be visible on
 * both sides or the cast is rejected (battle_engine currently wires neither; see roadmap F4/Q1-M1).
 */
export function getEnemiesCellsWithinMovementRange(unit: Unit, context: IDecisionContext): XY[] {
    const provided = context.getCurrentEnemiesCellsWithinMovementRange?.();
    if (provided) {
        return provided;
    }
    if (!unit.canMove()) {
        return [];
    }
    const moveCells = context.pathHelper.getMovePath(
        unit.getBaseCell(),
        context.grid.getMatrixNoUnits(),
        unit.getSteps(),
        undefined,
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    ).cells;
    const out: XY[] = [];
    for (const c of moveCells) {
        const enemyId = context.grid.getOccupantUnitId(c);
        if (!enemyId) {
            continue;
        }
        const enemy = context.unitsHolder.getAllUnits().get(enemyId);
        if (!enemy || enemy.isDead() || enemy.getTeam() === unit.getTeam() || !enemy.isSmallSize()) {
            continue;
        }
        out.push(enemy.getBaseCell());
    }
    return out;
}

export function enumerateCandidates(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    options: IEnumerateOptions = {},
): ICandidateSet {
    const gen = new CandidateGenerator(unit, context, options);
    return gen.enumerate(incumbent);
}

/** Internal single-use builder (one instance per decision; caches shared per-decision state). */
class CandidateGenerator {
    private readonly unit: Unit;
    private readonly context: IDecisionContext;
    private readonly options: IEnumerateOptions;
    private readonly enemyTeam: number;
    private readonly enemies: Unit[];
    private readonly allies: Unit[];
    private readonly candidates: IEnumeratedCandidate[] = [];
    private readonly truncated: CandidateKind[] = [];
    private readonly seen = new Set<string>();
    private readonly shared: Pick<ICandidateFeatures, "enemiesNotYetActedFrac" | "alliesNotYetActedFrac" | "lap">;
    private movePathCache?: ReturnType<IDecisionContext["pathHelper"]["getMovePath"]>;
    public constructor(unit: Unit, context: IDecisionContext, options: IEnumerateOptions) {
        this.unit = unit;
        this.context = context;
        this.options = options;
        this.enemyTeam = otherTeam(unit.getTeam());
        this.enemies = context.unitsHolder.getAllAllies(this.enemyTeam).filter((e) => !e.isDead());
        this.allies = context.unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        this.shared = this.sharedFeatures();
    }
    public enumerate(incumbent: GameAction[]): ICandidateSet {
        // Candidate 0 — the incumbent (anchor). Never deduped away; everything else dedupes against it.
        this.push({
            kind: "incumbent",
            actions: incumbent,
            features: this.features(this.incumbentFeatureOverrides(incumbent)),
        });
        this.addWait();
        this.addDefend();
        this.addMelee();
        this.addShots();
        this.addAreaThrows();
        this.addSpells();
        this.addMoves();
        return { candidates: this.candidates, truncated: this.truncated };
    }
    // ---- shared feature plumbing ---------------------------------------------------------------
    private sharedFeatures(): Pick<ICandidateFeatures, "enemiesNotYetActedFrac" | "alliesNotYetActedFrac" | "lap"> {
        const fp = this.context.fightProperties;
        const frac = (units: Unit[]): number => {
            if (!fp || !units.length) {
                return 0;
            }
            const notActed = units.filter((u) => !fp.hasAlreadyMadeTurn(u.getId())).length;
            return notActed / units.length;
        };
        return {
            enemiesNotYetActedFrac: frac(this.enemies),
            alliesNotYetActedFrac: frac(this.allies),
            lap: fp?.getCurrentLap() ?? 0,
        };
    }
    private features(overrides: Partial<ICandidateFeatures> = {}): ICandidateFeatures {
        return {
            moraleDelta: 0,
            luckDelta: 0,
            hourglassSpent: 0,
            spendsRangeShot: 0,
            spendsSpellCharge: 0,
            burnsResurrectionCharge: 0,
            expectedDamage: 0,
            expectedKill: 0,
            ...this.shared,
            ...overrides,
        };
    }
    /**
     * Resurrection's cast and Angel's on-death passive share one stored charge. Active-ability queries are
     * intentionally unsuitable here: Break temporarily hides abilities but does not remove the castable spell,
     * and casting while Broken still permanently consumes both the spell and the persisted passive.
     */
    private ownsResurrectionCharge(): boolean {
        return (
            this.unit.getUnitProperties().abilities.includes("Resurrection") &&
            this.unit.getSpells().some((spell) => spell.getName() === "Resurrection" && spell.isRemaining())
        );
    }
    /** Derive the cheap economy features of an arbitrary (incumbent) action list. */
    private incumbentFeatureOverrides(actions: GameAction[]): Partial<ICandidateFeatures> {
        const o: Partial<ICandidateFeatures> = {};
        for (const a of actions) {
            if (a.type === "wait_turn") {
                o.moraleDelta = -MORALE_CHANGE_FOR_CLOCK;
                o.hourglassSpent = 1;
            } else if (a.type === "defend_turn") {
                o.moraleDelta = -MORALE_CHANGE_FOR_SHIELD;
                o.luckDelta = LUCK_CHANGE_FOR_SHIELD;
            } else if (a.type === "range_attack" || a.type === "area_throw_attack") {
                o.spendsRangeShot = 1;
            } else if (a.type === "cast_spell") {
                o.spendsSpellCharge = 1;
                if (a.spellName === "Resurrection" && this.ownsResurrectionCharge()) {
                    o.burnsResurrectionCharge = 1;
                }
            }
        }
        return o;
    }
    // ---- dedupe ---------------------------------------------------------------------------------
    /** Canonical identity of an action list (field-order independent), for dedupe vs the incumbent. */
    private signature(actions: GameAction[]): string {
        const cell = (c?: XY): string => (c ? `${c.x},${c.y}` : "-");
        return actions
            .map((a) => {
                switch (a.type) {
                    case "select_attack_type":
                        return `sel:${a.attackType}`;
                    case "move_unit":
                        return `mv:${cell(a.path[a.path.length - 1])}`;
                    case "melee_attack":
                        return `ml:${a.targetId}@${cell(a.attackFrom)}`;
                    case "range_attack":
                        return `rg:${a.targetId}@${cell(a.aimCell)}/${a.aimSide ?? "-"}`;
                    case "area_throw_attack":
                        return `at:${cell(a.targetCell)}`;
                    case "cast_spell":
                        return `cs:${a.spellName}>${a.targetId ?? "-"}@${cell(a.targetCell)}`;
                    default:
                        return a.type;
                }
            })
            .join("|");
    }
    private push(cand: IEnumeratedCandidate): boolean {
        const sig = this.signature(cand.actions);
        if (this.seen.has(sig)) {
            this.enrichIncumbentCandidate(cand, sig);
            return false;
        }
        this.seen.add(sig);
        this.candidates.push(cand);
        return true;
    }
    /**
     * Candidate 0 is intentionally retained when enumeration rediscovers the incumbent action. A duplicate
     * generated candidate nevertheless has information the raw incumbent action list cannot carry, so copy
     * that observation onto the anchor without changing its kind, actions, identity, or position. Shot
     * enrichment predates IL v3 and remains unconditional; other classes are dataset-only and opt-in.
     */
    private enrichIncumbentCandidate(cand: IEnumeratedCandidate, sig = this.signature(cand.actions)): void {
        const incumbent = this.candidates[0];
        if (!incumbent || incumbent.kind !== "incumbent" || this.signature(incumbent.actions) !== sig) {
            return;
        }
        if (!this.options.enrichIncumbentMetadata) {
            if (cand.kind === "shot") {
                // Preserve the historical shot-only enrichment object shape and assignments exactly.
                incumbent.targetId = cand.targetId;
                incumbent.shotFeatures = cand.shotFeatures;
                incumbent.features.spendsRangeShot = cand.features.spendsRangeShot;
                incumbent.features.expectedDamage = cand.features.expectedDamage;
                incumbent.features.expectedKill = cand.features.expectedKill;
            }
            return;
        }
        incumbent.targetId = cand.targetId;
        incumbent.spellName = cand.spellName;
        incumbent.targetCell = cand.targetCell ? { ...cand.targetCell } : undefined;
        incumbent.standCell = cand.standCell ? { ...cand.standCell } : undefined;
        incumbent.shotFeatures = cand.shotFeatures;
        incumbent.features = { ...cand.features };
    }
    // ---- wait / defend ---------------------------------------------------------------------------
    /** Hourglass — mirrors GameActionEngine.canWaitOnHourglass exactly. */
    private addWait(): void {
        const fp = this.context.fightProperties;
        const team = this.unit.getTeam();
        const id = this.unit.getId();
        if (
            !fp ||
            (team !== LOWER && team !== UPPER) ||
            fp.getTeamUnitsAlive(team) <= 1 ||
            fp.hourglassIncludes(id) ||
            fp.hasAlreadyMadeTurn(id) ||
            fp.hasAlreadyHourglass(id)
        ) {
            return;
        }
        this.push({
            kind: "wait",
            actions: [{ type: "wait_turn", unitId: id }],
            features: this.features({ moraleDelta: -MORALE_CHANGE_FOR_CLOCK, hourglassSpent: 1 }),
        });
    }
    /** Luck shield — always accepted for the acting unit (validateTurnAction only). */
    private addDefend(): void {
        this.push({
            kind: "defend",
            actions: [{ type: "defend_turn", unitId: this.unit.getId() }],
            features: this.features({ moraleDelta: -MORALE_CHANGE_FOR_SHIELD, luckDelta: LUCK_CHANGE_FOR_SHIELD }),
        });
    }
    // ---- movement --------------------------------------------------------------------------------
    private movePath(): ReturnType<IDecisionContext["pathHelper"]["getMovePath"]> | undefined {
        if (!this.unit.canMove()) {
            return undefined;
        }
        if (!this.movePathCache) {
            this.movePathCache = this.context.pathHelper.getMovePath(
                this.unit.getBaseCell(),
                this.context.grid.getMatrix(),
                this.unit.getSteps(),
                this.context.grid.getAggrMatrixByTeam(this.enemyTeam),
                this.unit.canFly(),
                this.unit.isSmallSize(),
                this.unit.canTraverseLava(),
            );
        }
        return this.movePathCache;
    }
    private footprintForCell(cell: XY): XY[] {
        if (this.unit.isSmallSize()) {
            return [{ x: cell.x, y: cell.y }];
        }
        const gs = this.context.grid.getSettings();
        const position = getPositionForCell(cell, gs.getMinX(), gs.getStep(), gs.getHalfStep());
        return getCellsAroundPosition(gs, { x: position.x - gs.getHalfStep(), y: position.y - gs.getHalfStep() });
    }
    private footprintOk(cell: XY): boolean {
        const f = this.footprintForCell(cell);
        return (
            f.length > 0 &&
            (this.context.grid.areAllCellsEmpty(f, this.unit.getId()) ||
                this.context.grid.canOccupyCells(
                    f,
                    this.unit.hasAbilityActive("Made of Fire"),
                    this.unit.hasAbilityActive("Made of Water"),
                ))
        );
    }
    private moveAction(route: IWeightedRoute): GameAction {
        return {
            type: "move_unit",
            unitId: this.unit.getId(),
            path: route.route.map((c) => ({ x: c.x, y: c.y })),
            targetCells: this.footprintForCell(route.cell),
            hasLavaCell: route.hasLavaCell,
            hasWaterCell: route.hasWaterCell,
        };
    }
    /** Every reachable destination (or nearest-to-enemy top-K when capped). */
    private addMoves(): void {
        const movePath = this.movePath();
        if (!movePath) {
            return;
        }
        const base = this.unit.getBaseCell();
        const routes: IWeightedRoute[] = [];
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            if (route.cell.x === base.x && route.cell.y === base.y) {
                continue;
            }
            if (!this.footprintOk(route.cell)) {
                continue;
            }
            routes.push(route);
        }
        const cap = this.options.maxMoveDestinations ?? 0;
        let kept = routes;
        if (cap > 0 && routes.length > cap) {
            // Principled top-K: nearest-to-an-enemy destinations first (v0.1 fallbackTurn's advance metric);
            // stable sort keeps enumeration order on ties -> deterministic.
            const dist = (cell: XY): number =>
                this.enemies.length
                    ? Math.min(
                          ...this.enemies.map((e) => {
                              const ec = e.getBaseCell();
                              return Math.abs(cell.x - ec.x) + Math.abs(cell.y - ec.y);
                          }),
                      )
                    : 0;
            kept = [...routes].sort((a, b) => dist(a.cell) - dist(b.cell)).slice(0, cap);
            this.truncated.push("move");
        }
        const candidateOf = (route: IWeightedRoute): IEnumeratedCandidate => ({
            kind: "move",
            actions: [this.moveAction(route)],
            targetCell: { x: route.cell.x, y: route.cell.y },
            features: this.features(),
        });
        if (this.options.enrichIncumbentMetadata) {
            for (const route of routes) this.enrichIncumbentCandidate(candidateOf(route));
        }
        for (const route of kept) {
            this.push(candidateOf(route));
        }
    }
    // ---- melee -------------------------------------------------------------------------------------
    private canMelee(): boolean {
        if (this.unit.hasAbilityActive("No Melee")) {
            return false;
        }
        const sel = this.unit.getAttackTypeSelection();
        if (sel === MELEE || sel === MELEE_MAGIC) {
            return true;
        }
        const possible = this.unit.getPossibleAttackTypes();
        return possible.includes(MELEE) || possible.includes(MELEE_MAGIC);
    }
    private meleeTargets(): Unit[] {
        // Mirrors AttackHandler.handleMeleeAttack's guards: never a Hidden target, never a Cowardice-blocked
        // one, and when the unit carries a FORCED target (aggro), only that enemy is accepted.
        const forced = this.unit.getTarget();
        return this.enemies.filter((e) => {
            if (isHidden(e)) {
                return false;
            }
            if (this.unit.hasDebuffActive("Cowardice") && this.unit.getCumulativeHp() < e.getCumulativeHp()) {
                return false;
            }
            if (forced && forced !== e.getId()) {
                return false;
            }
            return true;
        });
    }
    private meleeDamage(target: Unit): { effective: number; kill: 0 | 1 } {
        const atkMul = this.unit.hasAbilityActive("Double Punch") ? 2 : 1;
        const min = atkMul * this.unit.calculateAttackDamageMin(this.unit.getAttack(), target, false, 0, 1);
        const max = atkMul * this.unit.calculateAttackDamageMax(this.unit.getAttack(), target, false, 0, 1);
        const hp = target.getCumulativeHp();
        const effective = Math.min((min + max) / 2, hp);
        return { effective, kill: effective >= hp ? 1 : 0 };
    }
    /** Every legal (target x stand-cell) pair: in-place strikes + move-and-strike over reachable cells. */
    private addMelee(): void {
        if (!this.canMelee()) {
            return;
        }
        const targets = this.meleeTargets();
        if (!targets.length) {
            return;
        }
        const base = this.unit.getBaseCell();
        const myCells = this.unit.getCells();
        const prefix = meleeAttackTypeSelectionPrefix(this.unit);

        interface IMeleePair {
            target: Unit;
            cell: XY;
            route?: IWeightedRoute;
            effective: number;
            kill: 0 | 1;
        }
        const pairs: IMeleePair[] = [];
        // In-place strikes: enemies already adjacent to the current footprint.
        for (const e of targets) {
            if (e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(mc, ec)))) {
                pairs.push({ target: e, cell: base, ...this.meleeDamage(e) });
            }
        }
        // Move-and-strike: every reachable stand cell whose footprint is adjacent to a target.
        const movePath = this.movePath();
        if (movePath) {
            for (const routeList of movePath.knownPaths.values()) {
                const route = routeList[0];
                if (!route?.route.length || !this.footprintOk(route.cell)) {
                    continue;
                }
                const fpCells = this.footprintForCell(route.cell);
                for (const e of targets) {
                    if (fpCells.some((mc) => e.getCells().some((ec) => isAdjacentCell(mc, ec)))) {
                        pairs.push({ target: e, cell: route.cell, route, ...this.meleeDamage(e) });
                    }
                }
            }
        }
        const cap = this.options.maxMeleePairs ?? 0;
        let kept = pairs;
        if (cap > 0 && pairs.length > cap) {
            kept = [...pairs].sort((a, b) => b.effective - a.effective).slice(0, cap);
            this.truncated.push("melee");
        }
        const candidateOf = (p: IMeleePair): IEnumeratedCandidate => {
            const actions: GameAction[] = [...prefix];
            // Move-and-strike is emitted as a SEPARATE move_unit + stationary melee_attack — the pattern
            // v0.5 measured ~+2.5pp over folding the path into the melee_attack (the standalone move runs
            // the full move handler). The ranked client folds the pair back for transport.
            if (p.route && (p.cell.x !== base.x || p.cell.y !== base.y)) {
                actions.push(this.moveAction(p.route));
            }
            actions.push({
                type: "melee_attack",
                attackerId: this.unit.getId(),
                targetId: p.target.getId(),
                attackFrom: { x: p.cell.x, y: p.cell.y },
            });
            return {
                kind: "melee",
                actions,
                targetId: p.target.getId(),
                standCell: { x: p.cell.x, y: p.cell.y },
                features: this.features({ expectedDamage: p.effective, expectedKill: p.kill }),
            };
        };
        if (this.options.enrichIncumbentMetadata) {
            for (const pair of pairs) this.enrichIncumbentCandidate(candidateOf(pair));
        }
        for (const p of kept) {
            this.push(candidateOf(p));
        }
    }
    // ---- ranged shots --------------------------------------------------------------------------------
    private canShoot(attackHandler: AttackHandler): boolean {
        if (
            !attackHandler.canLandRangeAttack(
                this.unit,
                this.context.grid.getEnemyAggrMatrixByUnitId(this.unit.getId()),
            )
        ) {
            return false;
        }
        return this.unit.getAttackTypeSelection() === RANGE || this.unit.getPossibleAttackTypes().includes(RANGE);
    }
    private rangePrefix(): GameAction[] {
        return this.unit.getAttackTypeSelection() !== RANGE
            ? [{ type: "select_attack_type", unitId: this.unit.getId(), attackType: RANGE }]
            : [];
    }
    /** n-choose-k for the one/two-shot expected-damage calculation. */
    private combinations(n: number, k: number): number {
        if (k < 0 || k > n) {
            return 0;
        }
        const smaller = Math.min(k, n - k);
        let result = 1;
        for (let i = 1; i <= smaller; i += 1) {
            result = (result * (n - smaller + i)) / i;
        }
        return result;
    }
    /**
     * Expected effective damage of a hit set (enemies add, splash friendly fire subtracts).
     *
     * The engine owns all target-specific combat semantics used here: calculateMissChance covers Dodge,
     * Small Specie, Boar Saliva and the Broken Aegis self-cost; getPhysicalAoeDamageMultiplier covers status
     * resistance and Mechanism vulnerability. Keeping those terms in the score prevents a high-raw-damage but
     * low-hit-probability cluster from incorrectly beating a reliable incumbent shot.
     */
    private shotDamage(
        evaluation: { affectedUnits: Array<Unit[]>; rangeAttackDivisors: number[] },
        primaryTargetId: string | undefined,
        shots: number,
        isAOE: boolean,
    ): {
        value: number;
        kill: 0 | 1;
        enemyDamage: number;
        friendlyFireDamage: number;
        primaryTargetDamage: number;
    } {
        let value = 0;
        let kill: 0 | 1 = 0;
        let enemyDamage = 0;
        let friendlyFireDamage = 0;
        let primaryTargetDamage = 0;
        const counted = new Set<string>();
        const fightProperties = this.context.fightProperties;
        const attackerAbilityPower = fightProperties?.getAdditionalAbilityPowerPerTeam(this.unit.getTeam()) ?? 0;
        const aoeAbility = isAOE
            ? (this.unit.getAbility("Area Throw") ?? this.unit.getAbility("Large Caliber"))
            : undefined;
        let sharedAoeMultiplier = aoeAbility
            ? this.unit.calculateAbilityMultiplier(aoeAbility, attackerAbilityPower)
            : 1;
        const paralysis = this.unit.getEffect("Paralysis");
        if (paralysis) {
            sharedAoeMultiplier *= (100 - paralysis.getPower()) / 100;
        }
        for (let i = 0; i < evaluation.affectedUnits.length; i += 1) {
            const divisor = evaluation.rangeAttackDivisors[i] ?? 1;
            for (const target of evaluation.affectedUnits[i]) {
                if (counted.has(target.getId())) {
                    continue;
                }
                counted.add(target.getId());
                const minRaw = this.unit.calculateAttackDamageMin(
                    this.unit.getAttack(),
                    target,
                    true,
                    attackerAbilityPower,
                    divisor,
                );
                const maxRaw = this.unit.calculateAttackDamageMax(
                    this.unit.getAttack(),
                    target,
                    true,
                    attackerAbilityPower,
                    divisor,
                );
                const applyEngineAoeModifiers = (rawDamage: number): number => {
                    if (!isAOE) {
                        return rawDamage;
                    }
                    let adjusted = Math.floor(rawDamage * sharedAoeMultiplier);
                    const brokenAegis = target.getBuff("Broken Aegis");
                    if (brokenAegis) {
                        adjusted = Math.floor(adjusted * (1 - brokenAegis.getPower() / 100));
                    }
                    return Math.floor(adjusted * target.getPhysicalAoeDamageMultiplier());
                };
                const min = applyEngineAoeModifiers(minRaw);
                const max = applyEngineAoeModifiers(maxRaw);
                const hp = target.getCumulativeHp();
                const conditionalDamage = (min + max) / 2;
                const defenderAbilityPower = fightProperties?.getAdditionalAbilityPowerPerTeam(target.getTeam()) ?? 0;
                const hitChance =
                    1 - Math.min(100, Math.max(0, this.unit.calculateMissChance(target, defenderAbilityPower))) / 100;
                let effective = 0;
                for (let hits = 1; hits <= shots; hits += 1) {
                    const probability =
                        this.combinations(shots, hits) * hitChance ** hits * (1 - hitChance) ** (shots - hits);
                    effective += probability * Math.min(hits * conditionalDamage, hp);
                }
                if (target.getTeam() === this.enemyTeam) {
                    value += effective;
                    enemyDamage += effective;
                    if (primaryTargetId && target.getId() === primaryTargetId && effective >= hp) {
                        kill = 1;
                    }
                    if (primaryTargetId && target.getId() === primaryTargetId) {
                        primaryTargetDamage = effective;
                    }
                } else {
                    value -= effective;
                    friendlyFireDamage += effective;
                }
            }
        }
        return { value, kill, enemyDamage, friendlyFireDamage, primaryTargetDamage };
    }
    /** Target-local signals already used by v0.5's shot scorer, exposed without changing that scorer. */
    private shotFeatures(
        target: Unit,
        damage: Pick<IShotCandidateFeatures, "enemyDamage" | "friendlyFireDamage" | "primaryTargetDamage">,
    ): IShotCandidateFeatures {
        const died = target.getAmountDied();
        const alive = target.getAmountAlive();
        const focus =
            this.allies.filter((ally) =>
                ally.getCells().some((ac) => target.getCells().some((tc) => isAdjacentCell(ac, tc))),
            ).length / 2;
        return {
            ...damage,
            targetFirepower: (Math.max(1, target.getRangeShots()) * Math.max(1, target.getAttackDamageMax())) / 1_000,
            targetLevel: target.getLevel(),
            targetIsRanged: target.getAttackType() === RANGE ? 1 : 0,
            targetCanCastSpells: target.getCanCastSpells() ? 1 : 0,
            targetNotYetActed:
                this.context.fightProperties && !this.context.fightProperties.hasAlreadyMadeTurn(target.getId())
                    ? 1
                    : 0,
            targetWoundedFraction: died + alive > 0 ? died / (died + alive) : 0,
            targetFocusFire: focus,
        };
    }
    /** Every enemy x visible edge; aims with identical hit sets (units + divisors) are deduped. */
    private addShots(): void {
        const attackHandler = this.context.attackHandler;
        if (!attackHandler || !this.canShoot(attackHandler)) {
            return;
        }
        const { grid, unitsHolder } = this.context;
        const matrix = grid.getMatrix();
        const gs = grid.getSettings();
        const allUnits = unitsHolder.getAllUnits();
        const fromTeam = this.unit.getTeam();
        const from = this.unit.getPosition();
        const isAOE = this.unit.hasAbilityActive("Large Caliber") || this.unit.hasAbilityActive("Area Throw");
        const isThroughShot = this.unit.hasAbilityActive("Through Shot");
        const shots = this.unit.hasAbilityActive("Double Shot") ? 2 : 1;
        const prefix = this.rangePrefix();

        interface IShot {
            targetId: string;
            aimCell: XY;
            aimSide: RangeAttackCellSide;
            value: number;
            kill: 0 | 1;
            shotFeatures: IShotCandidateFeatures;
        }
        const found: IShot[] = [];
        const hitSetSeen = new Set<string>();
        for (const enemy of this.enemies) {
            if (isHidden(enemy)) {
                continue; // the engine's melee/hidden guard; a Hidden unit cannot be targeted
            }
            for (const cell of enemy.getCells()) {
                for (const side of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(matrix, cell, side, fromTeam, isThroughShot)) {
                        continue;
                    }
                    const to = getRangeAttackSideCenter(gs, cell, side, from);
                    const evaluation = attackHandler.evaluateRangeAttack(
                        allUnits,
                        this.unit,
                        from,
                        to,
                        isThroughShot,
                        false,
                        isAOE,
                    );
                    // The engine declines a shot whose SOLE affected group leads with a Hidden unit (an AOE
                    // splash can put a Hidden neighbour first) — not a legal candidate.
                    const primaryHit = evaluation.affectedUnits[0]?.[0];
                    if (evaluation.affectedUnits.length === 1 && primaryHit && isHidden(primaryHit)) {
                        continue;
                    }
                    if (!evaluation.affectedUnits.length) {
                        continue;
                    }
                    // Alternative aims are only interesting when they change WHAT the shot hits: dedupe
                    // aims resolving to the identical (unit set, divisors) outcome per target.
                    const hitSig =
                        enemy.getId() +
                        "#" +
                        evaluation.affectedUnits
                            .map(
                                (g, i) =>
                                    `${evaluation.rangeAttackDivisors[i] ?? 1}:${g.map((u) => u.getId()).join(",")}`,
                            )
                            .join(";");
                    if (hitSetSeen.has(hitSig)) {
                        continue;
                    }
                    hitSetSeen.add(hitSig);
                    const damage = this.shotDamage(evaluation, enemy.getId(), shots, isAOE);
                    found.push({
                        targetId: enemy.getId(),
                        aimCell: { x: cell.x, y: cell.y },
                        aimSide: side,
                        value: damage.value,
                        kill: damage.kill,
                        shotFeatures: this.shotFeatures(enemy, damage),
                    });
                }
            }
        }
        const cap = this.options.maxShotAims ?? 0;
        let kept = found;
        if (cap > 0 && found.length > cap) {
            kept = [...found].sort((a, b) => b.value - a.value).slice(0, cap);
            this.truncated.push("shot");
        }
        const candidateOf = (s: IShot): IEnumeratedCandidate => ({
            kind: "shot",
            actions: [
                ...prefix,
                {
                    type: "range_attack",
                    attackerId: this.unit.getId(),
                    targetId: s.targetId,
                    aimCell: s.aimCell,
                    aimSide: s.aimSide,
                },
            ],
            targetId: s.targetId,
            shotFeatures: s.shotFeatures,
            features: this.features({ spendsRangeShot: 1, expectedDamage: s.value, expectedKill: s.kill }),
        });
        // Enrichment is independent of the challenger cap: even a capped-out duplicate is still the truthful
        // observation of candidate 0's exact shot.
        for (const s of found) {
            const candidate = candidateOf(s);
            this.enrichIncumbentCandidate(candidate);
        }
        for (const s of kept) {
            this.push(candidateOf(s));
        }
    }
    // ---- area throw (Gargantuan) ------------------------------------------------------------------
    /**
     * area_throw_attack — engine legality (GameActionEngine.areaThrowAttack): Area Throw ability active,
     * RANGE selected (or selectable), shots > 0, target cell inside the grid and not occupied by a unit
     * (lava "L" / water "W" markers are fine). NOTE the engine does NOT re-check melee pinning for this
     * action, but RANGE selectability already encodes it via refreshPossibleAttackTypes. Relevance filter:
     * only cells whose 3x3 splash (cells around the aim + interception projection) reaches >=1 living
     * enemy — aiming at bare ground is legal but strictly dominated, and including ~200 empty cells would
     * drown every consumer.
     */
    private addAreaThrows(): void {
        if (
            !this.unit.hasAbilityActive("Area Throw") ||
            this.unit.getRangeShots() <= 0 ||
            !(this.unit.getAttackTypeSelection() === RANGE || this.unit.getPossibleAttackTypes().includes(RANGE))
        ) {
            return;
        }
        const attackHandler = this.context.attackHandler;
        if (!attackHandler) {
            return;
        }
        const { grid, unitsHolder } = this.context;
        const gs = grid.getSettings();
        const allUnits = unitsHolder.getAllUnits();
        const prefix = this.rangePrefix();
        const shots = this.unit.hasAbilityActive("Double Shot") ? 2 : 1;
        const forcedTarget = allUnits.get(this.unit.getTarget());
        const forcedTargetId = forcedTarget && !forcedTarget.isDead() ? forcedTarget.getId() : undefined;

        // Aim-cell pool: empty cells adjacent to a living enemy's footprint (the only aims whose splash
        // can reach an enemy), deduped, in deterministic enemy/cell order.
        const poolSeen = new Set<number>();
        const pool: XY[] = [];
        for (const enemy of this.enemies) {
            for (const ec of enemy.getCells()) {
                for (const c of [...getCellsAroundCell(gs, ec)]) {
                    const key = (c.x << 4) | c.y;
                    if (poolSeen.has(key)) {
                        continue;
                    }
                    poolSeen.add(key);
                    if (!isCellWithinGrid(gs, c)) {
                        continue;
                    }
                    const occupantId = grid.getOccupantUnitId(c);
                    if (occupantId && occupantId !== "L" && occupantId !== "W") {
                        continue; // engine rejects unit-occupied aim cells
                    }
                    pool.push(c);
                }
            }
        }

        interface IThrow {
            aim: XY;
            primaryTargetId: string;
            value: number;
            kill: 0 | 1;
        }
        const found: IThrow[] = [];
        for (const aim of pool) {
            // Mirror the engine: a unit on the trajectory intercepts the throw — evaluate the splash at
            // the PROJECTED cell, not the aimed one, so the feature reflects what would actually happen.
            const projected = attackHandler.projectAreaThrowTargetCell(allUnits, this.unit, aim);
            const targetPosition = getPositionForCell(projected, gs.getMinX(), gs.getStep(), gs.getHalfStep());
            const affectedCells = [...getCellsAroundCell(gs, projected), projected];
            const affectedUnits = evaluateAffectedUnits(affectedCells, unitsHolder, grid) ?? [];
            const primaryTargetId = affectedUnits[0]?.[0]?.getId();
            if (!primaryTargetId || (forcedTargetId && forcedTargetId !== primaryTargetId)) {
                continue; // AttackHandler enforces the same first-affected-unit forced-target check.
            }
            const divisor = attackHandler.getRangeAttackDivisor(this.unit, targetPosition);
            const { value, kill } = this.shotDamage(
                { affectedUnits, rangeAttackDivisors: affectedUnits.map(() => divisor) },
                primaryTargetId,
                shots,
                true,
            );
            found.push({ aim, primaryTargetId, value, kill });
        }
        const cap = this.options.maxAreaThrowCells ?? 0;
        let kept = found;
        if (cap > 0 && found.length > cap) {
            kept = [...found].sort((a, b) => b.value - a.value).slice(0, cap);
            this.truncated.push("area_throw");
        }
        const candidateOf = (t: IThrow): IEnumeratedCandidate => ({
            kind: "area_throw",
            actions: [
                ...prefix,
                {
                    type: "area_throw_attack",
                    attackerId: this.unit.getId(),
                    targetCell: { x: t.aim.x, y: t.aim.y },
                },
            ],
            targetId: t.primaryTargetId,
            targetCell: { x: t.aim.x, y: t.aim.y },
            features: this.features({ spendsRangeShot: 1, expectedDamage: t.value, expectedKill: t.kill }),
        });
        if (this.options.enrichIncumbentMetadata) {
            for (const candidate of found) this.enrichIncumbentCandidate(candidateOf(candidate));
        }
        for (const t of kept) {
            this.push(candidateOf(t));
        }
    }
    // ---- spells ----------------------------------------------------------------------------------
    /** Mirrors GameActionEngine.canUseSpell. */
    private canUseSpell(spell: Spell): boolean {
        return (
            spell.getLapsTotal() > 0 &&
            spell.isRemaining() &&
            spell.getMinimalCasterStackPower() <= this.unit.getStackPower()
        );
    }
    private castAction(spell: Spell, targetId?: string, targetCell?: XY): GameAction {
        return { type: "cast_spell", casterId: this.unit.getId(), spellName: spell.getName(), targetId, targetCell };
    }
    private pushSpell(
        spell: Spell,
        targetId?: string,
        targetCell?: XY,
        overrides: Partial<ICandidateFeatures> = {},
    ): void {
        this.push({
            kind: "spell",
            actions: [this.castAction(spell, targetId, targetCell)],
            spellName: spell.getName(),
            targetId,
            targetCell,
            features: this.features({
                spendsSpellCharge: 1,
                burnsResurrectionCharge: spell.getName() === "Resurrection" && this.ownsResurrectionCharge() ? 1 : 0,
                ...overrides,
            }),
        });
    }
    /**
     * ALL castable spells x targets — including the MELEE_MAGIC-granted ones no AI version has ever
     * emitted (Angel Resurrection, Valkyrie Wind Flow, Harpy Castling) and offensive debuffs (v0.2+ only
     * ever casts beneficial spells). Target-type coverage:
     *   ANY_ALLY (Heal/buffs/Resurrection)         -> per-ally canCastSpell
     *   ANY_ENEMY (debuffs)                        -> per-enemy canCastSpell
     *   ENEMY_WITHIN_MOVEMENT_RANGE (Castling)     -> small enemies on getEnemiesCellsWithinMovementRange
     *   ALL_ALLIES / ALL_ENEMIES / ALL_FLYING      -> single mass candidate via canMassCastSpell
     *   RANDOM_CLOSE_TO_CASTER summons             -> deterministic first empty adjacent cell
     * AUTO-targeted entries (system effects like Morale) are not player-castable and are skipped.
     */
    private addSpells(): void {
        const spells = this.unit.getSpells();
        if (!spells.length) {
            return;
        }
        const { grid, unitsHolder } = this.context;
        const matrix = grid.getMatrix();
        const gs = grid.getSettings();
        const team = this.unit.getTeam();
        const livingAllies = [this.unit, ...this.allies];
        let castlingCells: XY[] | undefined;

        for (const spell of spells) {
            if (!this.canUseSpell(spell)) {
                continue;
            }
            const targetType = spell.getSpellTargetType();

            if (spell.isSummon() && targetType === SpellTargetType.RANDOM_CLOSE_TO_CASTER) {
                const amount = Math.floor(this.unit.getAmountAlive() * spell.getPower());
                if (amount <= 0) {
                    continue;
                }
                // Deterministic (RNG-free) summon cell: the first empty cell around the caster in
                // getCellsAroundCell order. The engine only validates emptiness (canCastSummon).
                const cell = getCellsAroundCell(gs, this.unit.getBaseCell()).find((c) =>
                    canCastSummon(spell, matrix, c),
                );
                if (cell) {
                    this.pushSpell(spell, undefined, { x: cell.x, y: cell.y });
                }
                continue;
            }

            if (
                targetType === SpellTargetType.ALL_ALLIES ||
                targetType === SpellTargetType.ALL_ENEMIES ||
                targetType === SpellTargetType.ALL_FLYING
            ) {
                // Mass cast (e.g. Valkyrie's Wind Flow = ALL_FLYING) — exact engine gate.
                if (
                    canMassCastSpell(
                        spell,
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
                    this.pushSpell(spell);
                }
                continue;
            }

            if (targetType === SpellTargetType.ANY_ALLY) {
                for (const ally of livingAllies) {
                    if (
                        canCastSpell(
                            false,
                            gs,
                            matrix,
                            this.unit,
                            ally,
                            spell,
                            ally.getBaseCell(),
                            ally.getMagicResist(),
                            ally.hasMindAttackResistance(),
                            ally.canBeHealed(),
                            undefined,
                        )
                    ) {
                        this.pushSpell(spell, ally.getId());
                    }
                }
                continue;
            }

            if (targetType === SpellTargetType.ANY_ENEMY) {
                for (const enemy of this.enemies) {
                    // handleMagicAttack rejects Hidden enemy targets before canCastSpell runs.
                    if (isHidden(enemy)) {
                        continue;
                    }
                    if (
                        canCastSpell(
                            false,
                            gs,
                            matrix,
                            this.unit,
                            enemy,
                            spell,
                            enemy.getBaseCell(),
                            enemy.getMagicResist(),
                            enemy.hasMindAttackResistance(),
                            enemy.canBeHealed(),
                            undefined,
                        )
                    ) {
                        this.pushSpell(spell, enemy.getId());
                    }
                }
                continue;
            }

            if (targetType === SpellTargetType.ENEMY_WITHIN_MOVEMENT_RANGE) {
                // Castling (Harpy): swap with a SMALL enemy within movement range. The legality list is
                // computed once per decision; the engine must see the same list through its own context
                // callback (see getEnemiesCellsWithinMovementRange docs).
                castlingCells ??= getEnemiesCellsWithinMovementRange(this.unit, this.context);
                if (!castlingCells.length) {
                    continue;
                }
                for (const enemy of this.enemies) {
                    if (isHidden(enemy) || !enemy.isSmallSize()) {
                        continue;
                    }
                    const bc = enemy.getBaseCell();
                    if (!castlingCells.some((c) => c.x === bc.x && c.y === bc.y)) {
                        continue;
                    }
                    if (
                        canCastSpell(
                            false,
                            gs,
                            matrix,
                            this.unit,
                            enemy,
                            spell,
                            bc,
                            enemy.getMagicResist(),
                            enemy.hasMindAttackResistance(),
                            enemy.canBeHealed(),
                            castlingCells,
                        )
                    ) {
                        this.pushSpell(spell, enemy.getId(), { x: bc.x, y: bc.y });
                    }
                }
                continue;
            }
            // AUTO / other target types: not directly castable through the cast_spell action — skip.
        }
    }
}
