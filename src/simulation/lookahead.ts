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

import type { IAIStrategy } from "../ai";
import type { GameAction } from "../engine/actions";
import type { GameActionEngine } from "../engine/action_engine";
import type { GameEvent } from "../engine/events";
import type { TurnEngine } from "../engine/turn_engine";
import type { FightProperties } from "../fights/fight_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Grid } from "../grid/grid";
import type { PathHelper } from "../grid/path_helper";
import type { AttackHandler } from "../handlers/attack_handler";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../utils/lib";
import type { XY } from "../utils/math";
import { makeRng } from "./army";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import { extractValueFeatures, VALUE_FEATURE_NAMES } from "./value_features";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

/** How many turns to advance/play (worst case) while eliciting the opponent's immediate reply. */
const REPLY_CAP = 6;
/** Hard cap on candidate decisions scored per acting-unit turn (keeps the per-turn cost bounded). */
const MAX_CANDIDATES = 5;
/**
 * RE-RANK gate (mode="rerank"): only override the policy's own decision when the best candidate's leaf value
 * beats the policy's (base) candidate by at least this margin. The strong v0.5 policy is trusted by default;
 * the learned value only intervenes on a clear improvement. 0 = always take argmax (pure greedy).
 */
const RERANK_GATE = Number(process.env.V05_RERANK_GATE ?? 0.05);
/** Value-function positional term: HP-equivalent worth of a surviving stack advantage. 0 = pure material. */
const POSITIONAL_WEIGHT = Number(process.env.V05_LOOKAHEAD_POSW ?? 0);

/**
 * LEARNED leaf value function (opt-in). When V05_VALUE_WEIGHTS is a valid `{b, w:[...]}` (logistic-regression
 * coefficients from fit_value.mjs, w aligned to value_features.ts VALUE_FEATURE_NAMES), the leaf eval returns
 * the model logit b + w·features INSTEAD of pure material. Absent/malformed => null => material eval unchanged
 * (so V05_LOOKAHEAD's baseline is byte-identical to today). Ranking-only, so the raw logit needs no sigmoid.
 */
const LEARNED_VALUE: { b: number; w: number[] } | null = (() => {
    const raw = process.env.V05_VALUE_WEIGHTS;
    if (!raw) {
        return null;
    }
    try {
        const m = JSON.parse(raw);
        if (
            m &&
            typeof m.b === "number" &&
            Number.isFinite(m.b) &&
            Array.isArray(m.w) &&
            m.w.length === VALUE_FEATURE_NAMES.length &&
            m.w.every((x: unknown) => typeof x === "number" && Number.isFinite(x))
        ) {
            return { b: m.b, w: m.w as number[] };
        }
    } catch {
        /* malformed -> fall through to material eval */
    }
    return null;
})();

const otherTeam = (team: TeamType): TeamType => (team === LOWER ? UPPER : LOWER);
const isHidden = (u: Unit): boolean => u.hasBuffActive("Hidden") || u.hasAbilityActive("Hidden");

const footprintForBase = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ x: base.x, y: base.y }]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

/** Everything the driver needs from the (closure-heavy) battle_engine loop it plugs into. */
export interface ILookaheadDeps {
    engine: GameActionEngine;
    turnEngine: TurnEngine;
    grid: Grid;
    unitsHolder: UnitsHolder;
    fightProperties: FightProperties;
    pathHelper: PathHelper;
    attackHandler: AttackHandler;
    /** The strategy that drives a given team (so the simulated opponent replies with its OWN policy). */
    strategyForTeam: (team: TeamType) => IAIStrategy;
    /** Read/write the engine's notion of the active unit (battle_engine's `currentActiveUnitId`). */
    getActiveUnitId: () => string;
    setActiveUnitId: (id: string) => void;
    /** True iff damage was already dealt this lap (mirrors the real loop's advance() argument). */
    damageDealtThisLap: () => boolean;
    /** Snapshot/rollback the per-lap damage stat log — it is NOT part of the battle snapshot but a
     *  simulated attack appends to it, which would perturb the real narrowing decision if left. */
    captureDamageStats: () => IDamageStatistic[];
    restoreDamageStats: (saved: IDamageStatistic[]) => void;
}

interface ICandidate {
    actions: GameAction[];
    kind: string;
}

/**
 * STAGE 2 — a 2-ply lookahead driver for the SIM.
 *
 * For the active unit it builds a small, diverse CANDIDATE SET (the strategy's own decision, a strategic
 * hourglass, and a few alternative melee targets/stand-cells), then SCORES each by SIMULATION: it clones
 * the live fight (battle_snapshot), applies the candidate through the REAL engine, lets the opponent make
 * its immediate reply (advance one turn and run the opponent strategy's decideTurn), evaluates the
 * resulting material, and rolls back. The best-scoring candidate is returned to be applied for real.
 *
 * DETERMINISM: the tournament installs a seeded global RNG stream. Simulated engine applies would draw
 * from (and advance) that same stream, desyncing the paired A/B comparison and replay. So while it
 * simulates, the driver SWAPS the global source to a PRIVATE per-decision stream (seeded from the lap +
 * unit id, identical for every candidate → a fair paired comparison) and restores the tournament's exact
 * source reference afterward. Combined with battle_snapshot's rollback and the damage-stat rollback, the
 * real stream is never advanced by search, so V05_LOOKAHEAD=off and =on stay individually reproducible.
 */
export class LookaheadDriver {
    public readonly enabled: boolean;
    /** "off" = no search; "on" = 2-ply (our move + opponent reply); "rerank" = 1-ply value-max, gated to the policy. */
    private readonly mode: "off" | "on" | "rerank";
    private readonly deps: ILookaheadDeps;
    private finishedSim = false;
    public constructor(deps: ILookaheadDeps) {
        this.deps = deps;
        const raw = process.env.V05_LOOKAHEAD ?? "off";
        this.mode = raw === "on" || raw === "rerank" ? raw : "off";
        this.enabled = this.mode !== "off";
    }
    /** Replace the strategy's single decision with the best-by-simulation candidate for `unit`. */
    public chooseDecision(unit: Unit, baseDecision: GameAction[]): GameAction[] {
        const actingTeam = unit.getTeam();
        const seed = this.simSeed(unit);
        const savedSource = getDeterministicRandomSource();
        const savedActive = this.deps.getActiveUnitId();

        // Swap the tournament's seeded RNG to a PRIVATE stream around the WHOLE search (candidate building
        // included) so NOTHING here — path enumeration, snapshotting, simulated applies — draws from (and
        // thereby advances) the real stream. The exact source reference is restored in `finally`, so the
        // tournament's stream is byte-identical to a V05_LOOKAHEAD=off run and replay-determinism holds.
        setDeterministicRandomSource(makeRng(seed));
        try {
            const candidates = this.buildCandidates(unit, baseDecision);
            if (candidates.length <= 1) {
                return baseDecision;
            }
            const snapshot = snapshotBattle(this.deps.unitsHolder, this.deps.grid, this.deps.fightProperties);
            const savedStats = this.deps.captureDamageStats();

            let best = baseDecision;
            let bestScore = -Infinity;
            let bestIsBase = true;
            let baseScore = -Infinity;
            for (const cand of candidates) {
                const score = this.scoreCandidate(unit, cand, actingTeam, seed);
                // Restore to the frozen pre-decision state before the next candidate.
                restoreBattle(snapshot, this.deps.unitsHolder, this.deps.grid, this.deps.fightProperties);
                this.deps.restoreDamageStats(savedStats);
                if (cand.kind === "base") {
                    baseScore = score;
                }
                if (score > bestScore) {
                    bestScore = score;
                    best = cand.actions;
                    bestIsBase = cand.kind === "base";
                }
            }
            // RE-RANK gate: trust the policy's own move unless a challenger clearly beats it on leaf value. This
            // is what separates "rerank" from the 2-ply search that overrode good policy moves too eagerly.
            if (this.mode === "rerank" && !bestIsBase && bestScore - baseScore < RERANK_GATE) {
                return baseDecision;
            }
            return best;
        } finally {
            // Restore the tournament's exact RNG source + the engine's active-unit pointer.
            setDeterministicRandomSource(savedSource);
            this.deps.setActiveUnitId(savedActive);
            this.finishedSim = false;
        }
    }
    // ---- candidate generation --------------------------------------------------
    private buildCandidates(unit: Unit, baseDecision: GameAction[]): ICandidate[] {
        const cands: ICandidate[] = [{ actions: baseDecision, kind: "base" }];
        const id = unit.getId();
        const baseIsWait = baseDecision.length === 1 && baseDecision[0].type === "wait_turn";

        // (b) strategic hourglass — only when the engine would actually accept a wait.
        if (!baseIsWait && this.canHourglass(unit)) {
            cands.push({ actions: [{ type: "wait_turn", unitId: id }], kind: "wait" });
        }

        // (c) alternative melee targets / stand cells (melee units only, keeps it cheap & relevant).
        if (unit.getAttackType() === MELEE) {
            for (const m of this.meleeAlternatives(unit, baseDecision)) {
                cands.push(m);
                if (cands.length >= MAX_CANDIDATES) {
                    break;
                }
            }
        }
        return cands.slice(0, MAX_CANDIDATES);
    }
    private canHourglass(unit: Unit): boolean {
        const fp = this.deps.fightProperties;
        const team = unit.getTeam();
        if (team !== LOWER && team !== UPPER) {
            return false;
        }
        return (
            fp.getTeamUnitsAlive(team) > 1 &&
            !fp.hourglassIncludes(unit.getId()) &&
            !fp.hasAlreadyMadeTurn(unit.getId()) &&
            !fp.hasAlreadyHourglass(unit.getId())
        );
    }
    /** Up to a few distinct melee (target, stand-cell) strikes not identical to the base pick. */
    private meleeAlternatives(unit: Unit, baseDecision: GameAction[]): ICandidate[] {
        const { grid, unitsHolder, pathHelper } = this.deps;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead() && !isHidden(e));
        if (!enemies.length) {
            return [];
        }
        const base = unit.getBaseCell();
        const myCells = unit.getCells();
        const baseStrike = baseDecision.find((a) => a.type === "melee_attack");
        const baseTarget = baseStrike?.type === "melee_attack" ? baseStrike.targetId : undefined;

        const prefix: GameAction[] =
            unit.getAttackTypeSelection() !== MELEE
                ? [{ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE }]
                : [];
        const out: ICandidate[] = [];
        const usedTargets = new Set<string>(baseTarget ? [baseTarget] : []);

        // In-place strikes: enemies already adjacent to the current footprint (no move needed).
        for (const e of enemies) {
            if (usedTargets.has(e.getId())) {
                continue;
            }
            if (grid.areCellsAdjacent(myCells, e.getCells())) {
                usedTargets.add(e.getId());
                out.push({
                    actions: [
                        ...prefix,
                        {
                            type: "melee_attack",
                            attackerId: unit.getId(),
                            targetId: e.getId(),
                            attackFrom: { x: base.x, y: base.y },
                        },
                    ],
                    kind: "melee-inplace",
                });
            }
        }

        // Move-and-strike: a reachable stand cell adjacent to an as-yet-unused enemy.
        if (unit.canMove() && out.length < MAX_CANDIDATES) {
            const movePath = pathHelper.getMovePath(
                base,
                grid.getMatrix(),
                unit.getSteps(),
                grid.getAggrMatrixByTeam(enemyTeam),
                unit.canFly(),
                unit.isSmallSize(),
                unit.hasAbilityActive("Made of Fire"),
            );
            for (const e of enemies) {
                if (usedTargets.has(e.getId())) {
                    continue;
                }
                for (const routes of movePath.knownPaths.values()) {
                    const route = routes[0];
                    if (!route?.route.length) {
                        continue;
                    }
                    const fp = footprintForBase(unit, route.cell);
                    if (!grid.areCellsAdjacent(fp, e.getCells())) {
                        continue;
                    }
                    usedTargets.add(e.getId());
                    out.push({
                        actions: [
                            ...prefix,
                            {
                                type: "melee_attack",
                                attackerId: unit.getId(),
                                targetId: e.getId(),
                                attackFrom: { x: route.cell.x, y: route.cell.y },
                                path: route.route.map((c) => ({ x: c.x, y: c.y })),
                                hasLavaCell: route.hasLavaCell,
                                hasWaterCell: route.hasWaterCell,
                            },
                        ],
                        kind: "melee-move",
                    });
                    break;
                }
                if (out.length >= MAX_CANDIDATES) {
                    break;
                }
            }
        }
        return out;
    }
    // ---- scoring ---------------------------------------------------------------
    /**
     * Simulate a candidate: apply it, elicit the opponent's immediate reply, return the material value.
     * The caller rolls back the battle snapshot + damage stats afterward; this method installs (and, on
     * every exit, restores) a private RNG stream so it never advances the tournament's real stream.
     */
    private scoreCandidate(unit: Unit, cand: ICandidate, actingTeam: TeamType, seed: number): number {
        // Private per-decision stream: makeRng(seed) is reseeded fresh for EVERY candidate, so the RNG
        // draws are identical across candidates (a fair paired comparison) and the tournament's real
        // source (restored by chooseDecision's finally) is never advanced by this search.
        setDeterministicRandomSource(makeRng(seed));
        this.finishedSim = false;
        this.deps.setActiveUnitId(unit.getId());

        // ply 1 — our move.
        let didSomething = false;
        for (const a of cand.actions) {
            if (this.finishedSim) {
                break;
            }
            const r = this.deps.engine.apply(a);
            if (!r.completed && a.type !== "select_attack_type") {
                return -Infinity; // an illegal candidate (e.g. an unavailable wait) is never chosen
            }
            if (r.completed && a.type !== "select_attack_type") {
                didSomething = true;
            }
            this.processEvents(r.events);
        }
        // A pure move leaves the unit active — close the turn so the opponent gets to reply.
        if (!this.finishedSim && this.deps.getActiveUnitId() === unit.getId()) {
            if (!didSomething) {
                this.processEvents(this.deps.engine.apply({ type: "defend_turn", unitId: unit.getId() }).events);
            }
            if (this.deps.getActiveUnitId() === unit.getId()) {
                const end = this.deps.engine.apply({ type: "end_turn", unitId: unit.getId(), reason: "manual" });
                this.processEvents(end.events);
                if (!end.completed) {
                    this.deps.setActiveUnitId("");
                }
            }
        }

        // RE-RANK mode is 1-ply: evaluate the position right after OUR move, with no simulated opponent reply.
        // The opponent-reply sim is exactly what made 2-ply override the strong policy too eagerly, so we skip
        // it and trust the learned leaf value to judge the post-move position.
        if (this.mode === "rerank") {
            return this.value(actingTeam);
        }

        // ply 2 — advance and play until the opponent has replied once (or the fight ends).
        const enemyTeam = otherTeam(actingTeam);
        let enemyReplied = false;
        for (let i = 0; i < REPLY_CAP && !this.finishedSim && !enemyReplied; i += 1) {
            if (!this.deps.getActiveUnitId()) {
                this.simAdvance();
                if (this.finishedSim || !this.deps.getActiveUnitId()) {
                    break;
                }
            }
            const activeId = this.deps.getActiveUnitId();
            const au = this.deps.unitsHolder.getAllUnits().get(activeId);
            if (!au || au.isDead()) {
                this.deps.setActiveUnitId("");
                continue;
            }
            this.simPlayTurn(au);
            if (au.getTeam() === enemyTeam) {
                enemyReplied = true;
            }
        }

        return this.value(actingTeam);
    }
    /** Material differential (higher = better for the acting team), plus an optional positional term. */
    private value(actingTeam: TeamType): number {
        // LEARNED leaf eval (opt-in): return the value model's logit for the acting team. Same board state the
        // material path reads, but the model can weigh tempo/positional features material can't. Ranking-only.
        if (LEARNED_VALUE) {
            const f = extractValueFeatures(this.deps.unitsHolder, this.deps.fightProperties, actingTeam);
            let z = LEARNED_VALUE.b;
            for (let i = 0; i < f.length; i += 1) {
                z += LEARNED_VALUE.w[i] * f[i];
            }
            return z;
        }
        let ours = 0;
        let enemy = 0;
        let oursAlive = 0;
        let enemyAlive = 0;
        for (const u of this.deps.unitsHolder.getAllUnits().values()) {
            if (u.isDead()) {
                continue;
            }
            const hp = u.getCumulativeHp();
            if (u.getTeam() === actingTeam) {
                ours += hp;
                oursAlive += 1;
            } else {
                enemy += hp;
                enemyAlive += 1;
            }
        }
        return ours - enemy + POSITIONAL_WEIGHT * (oursAlive - enemyAlive);
    }
    // ---- simulated turn plumbing (mirrors battle_engine's loop, minus recording) --------------
    private simPlayTurn(unit: Unit): void {
        const strat = this.deps.strategyForTeam(unit.getTeam());
        const id = unit.getId();
        let decided: GameAction[];
        try {
            decided = strat.decideTurn(unit, {
                grid: this.deps.grid,
                matrix: this.deps.grid.getMatrix(),
                unitsHolder: this.deps.unitsHolder,
                pathHelper: this.deps.pathHelper,
                attackHandler: this.deps.attackHandler,
                fightProperties: this.deps.fightProperties,
                decisionOrigin: "rollout",
            });
        } catch {
            decided = [];
        }
        let didSomething = false;
        for (const a of decided) {
            if (this.finishedSim) {
                break;
            }
            const r = this.deps.engine.apply(a);
            if (r.completed && a.type !== "select_attack_type") {
                didSomething = true;
            }
            this.processEvents(r.events);
        }
        if (!this.finishedSim && this.deps.getActiveUnitId() === id && !didSomething) {
            this.processEvents(this.deps.engine.apply({ type: "defend_turn", unitId: id }).events);
        }
        if (!this.finishedSim && this.deps.getActiveUnitId() === id) {
            const end = this.deps.engine.apply({ type: "end_turn", unitId: id, reason: "manual" });
            this.processEvents(end.events);
            if (!end.completed) {
                this.deps.setActiveUnitId("");
            }
        }
    }
    private simAdvance(): void {
        const holder = this.deps.unitsHolder;
        const maxAttempts = holder.getAllUnits().size + 2;
        for (let i = 0; i < maxAttempts && !this.finishedSim && !this.deps.getActiveUnitId(); i += 1) {
            const result = this.deps.turnEngine.advanceAfterNoActiveUnit({
                damageDealtThisLap: this.deps.damageDealtThisLap(),
            });
            this.processEvents(result.events);
            if (result.fightFinished) {
                this.finishedSim = true;
                return;
            }
            if (this.deps.getActiveUnitId()) {
                return;
            }
            if (!result.events.length && this.deps.fightProperties.getUpNextQueueSize() === 0) {
                break;
            }
        }
    }
    private processEvents(events: GameEvent[]): void {
        for (const event of events) {
            if (event.type === "turn_completed") {
                if (this.deps.getActiveUnitId() === event.unitId) {
                    this.deps.setActiveUnitId("");
                }
            } else if (event.type === "next_unit_selected") {
                this.deps.setActiveUnitId(event.unitId);
            } else if (event.type === "fight_finished") {
                this.deps.setActiveUnitId("");
                this.finishedSim = true;
            } else if (event.type === "unit_destroyed") {
                if (this.deps.getActiveUnitId() === event.unitId) {
                    this.deps.setActiveUnitId("");
                }
            }
        }
    }
    /** Deterministic per-decision seed for the private sim RNG (same across candidates → paired A/B). */
    private simSeed(unit: Unit): number {
        let h = (this.deps.fightProperties.getCurrentLap() * 0x9e3779b1) >>> 0;
        const id = unit.getId();
        for (let i = 0; i < id.length; i += 1) {
            h = (Math.imul(h ^ id.charCodeAt(i), 0x85ebca77) + 1) >>> 0;
        }
        return (h ^ 0x6d2b79f5) >>> 0;
    }
}
