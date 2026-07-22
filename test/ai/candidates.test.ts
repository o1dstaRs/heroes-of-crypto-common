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

import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import {
    enumerateCandidates,
    getEnemiesCellsWithinMovementRange,
    type IEnumeratedCandidate,
} from "../../src/ai/candidates";
import { selectV08STargetPressureCandidate } from "../../src/ai/versions/v0_8s_finish";
import { getCreatureConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { ilCandidateActionEncoding } from "../../src/simulation/il_action_features";
import {
    IL_CANDIDATE_FEATURE_NAMES,
    ilActionSignature,
    ilCandidateFeatureVector,
} from "../../src/simulation/il_dataset";
import { Spell } from "../../src/spells/spell";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const FLY = PBTypes.MovementVals.FLY;

function ctxFor(c: CombatTestContext, withFight = false): IDecisionContext {
    return {
        grid: c.grid,
        matrix: c.grid.getMatrix(),
        unitsHolder: c.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: c.attackHandler,
        fightProperties: withFight ? FightStateManager.getInstance().getFightProperties() : undefined,
    };
}

function makeReal(team: number, faction: string, name: string): Unit {
    const ef = new EffectFactory();
    const af = new AbilityFactory(ef);
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        af,
        ef,
        false,
    );
}

/** Place a LARGE (2x2) unit with its 4-cell footprint properly occupied (placeUnit only does 1 cell). */
function placeLarge(c: CombatTestContext, unit: Unit, base: XY): void {
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) {
        throw new Error("bad large placement");
    }
    unit.setPosition(position.x, position.y);
    c.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    c.unitsHolder.addUnit(unit);
}

const endTurn = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
const ofKind = (cands: IEnumeratedCandidate[], kind: string): IEnumeratedCandidate[] =>
    cands.filter((cand) => cand.kind === kind);

describe("candidates — the F4 enumerated candidate generator", () => {
    it("candidate 0 is ALWAYS the incumbent decision (anchor pattern), verbatim", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "U", attackType: MELEE, speed: 2 });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 4, y: 5 });
        const incumbent = endTurn(unit);
        const { candidates } = enumerateCandidates(unit, ctxFor(c), incumbent);
        expect(candidates.length).toBeGreaterThan(1);
        expect(candidates[0].kind).toBe("incumbent");
        expect(candidates[0].actions).toBe(incumbent); // the exact array, not a copy
    });

    it("melee: emits in-place strikes on EVERY adjacent enemy", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "Brawler", attackType: MELEE, speed: 3, amountAlive: 5 });
        const adj1 = createTestUnit({ team: UPPER, name: "Adj1", attackType: MELEE, amountAlive: 3 });
        const adj2 = createTestUnit({ team: UPPER, name: "Adj2", attackType: MELEE, amountAlive: 3 });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, adj1, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, adj2, { x: 6, y: 5 });
        const { candidates } = enumerateCandidates(unit, ctxFor(c), endTurn(unit));

        const melee = ofKind(candidates, "melee");
        const targets = new Set(melee.map((m) => m.targetId));
        expect(targets.has(adj1.getId())).toBe(true);
        expect(targets.has(adj2.getId())).toBe(true);

        // In-place strike: single melee_attack from the current cell, no move.
        const inPlace = melee.find((m) => m.targetId === adj1.getId() && m.standCell?.x === 5 && m.standCell?.y === 5);
        expect(inPlace).toBeDefined();
        expect(inPlace!.actions.some((a) => a.type === "move_unit")).toBe(false);
        // Every melee candidate carries a damage feature.
        for (const m of melee) {
            expect(m.features.expectedDamage).toBeGreaterThan(0);
        }
    });

    it("opt-in attack caps retain the best delivery to every distinct target", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "Scheduler", attackType: MELEE, amountAlive: 5 });
        const first = createTestUnit({ team: UPPER, name: "First blocker", attackType: MELEE, amountAlive: 3 });
        const second = createTestUnit({ team: UPPER, name: "Second blocker", attackType: MELEE, amountAlive: 3 });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, first, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, second, { x: 6, y: 5 });

        const defaultCapped = enumerateCandidates(unit, ctxFor(c), endTurn(unit), { maxMeleePairs: 1 });
        const covered = enumerateCandidates(unit, ctxFor(c), endTurn(unit), {
            maxMeleePairs: 1,
            preserveAttackTargetCoverage: true,
        });

        expect(new Set(ofKind(defaultCapped.candidates, "melee").map(({ targetId }) => targetId)).size).toBe(1);
        expect(new Set(ofKind(covered.candidates, "melee").map(({ targetId }) => targetId))).toEqual(
            new Set([first.getId(), second.getId()]),
        );
    });

    it("melee: emits move-and-strike (move_unit + stationary melee_attack) pairs across stand cells", () => {
        const c = createCombatTestContext();
        // Unengaged unit (aggro pathing constrains movement once adjacent to an enemy — that legality
        // is intentional and mirrors v0.5's enumeration).
        const unit = createTestUnit({ team: LOWER, name: "Brawler", attackType: MELEE, speed: 4, amountAlive: 5 });
        const far = createTestUnit({ team: UPPER, name: "Far", attackType: MELEE, amountAlive: 3 });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, far, { x: 5, y: 8 }); // stand cells (4..6,7) reachable within 3 steps
        const { candidates } = enumerateCandidates(unit, ctxFor(c), endTurn(unit));
        const melee = ofKind(candidates, "melee").filter((m) => m.targetId === far.getId());
        expect(melee.length).toBeGreaterThan(1); // several distinct stand cells around the target

        const moveStrike = melee[0];
        const types = moveStrike.actions.map((a) => a.type);
        expect(types).toContain("move_unit");
        expect(types[types.length - 1]).toBe("melee_attack");
        const strike = moveStrike.actions[moveStrike.actions.length - 1];
        if (strike.type === "melee_attack") {
            expect(strike.attackFrom).toEqual(moveStrike.standCell!);
            expect(strike.path).toBeUndefined(); // stationary strike after the standalone move
        }
        // Distinct stand cells enumerated (target x stand-cell pairs, not just one per target).
        const stands = new Set(melee.map((m) => `${m.standCell!.x},${m.standCell!.y}`));
        expect(stands.size).toBe(melee.length);

        const anchor = enumerateCandidates(unit, ctxFor(c), moveStrike.actions, {
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(anchor.actions).toBe(moveStrike.actions);
        expect(ilCandidateFeatureVector(anchor.features)).toEqual(ilCandidateFeatureVector(moveStrike.features));
        expect(ilCandidateActionEncoding(anchor, LOWER)).toEqual(ilCandidateActionEncoding(moveStrike, LOWER));
    });

    it("moves: every reachable destination; capped enumeration reports truncation", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "Runner", attackType: MELEE, speed: 4 });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 14 });

        const full = enumerateCandidates(unit, ctxFor(c), endTurn(unit));
        const fullMoves = ofKind(full.candidates, "move");
        expect(fullMoves.length).toBeGreaterThan(10); // speed 4 in open field
        expect(full.truncated).toEqual([]);

        const capped = enumerateCandidates(unit, ctxFor(c), endTurn(unit), { maxMoveDestinations: 3 });
        const cappedMoves = ofKind(capped.candidates, "move");
        expect(cappedMoves.length).toBe(3);
        expect(capped.truncated).toContain("move");
        // Principled top-K: kept destinations are the nearest-to-enemy ones (advance).
        for (const m of cappedMoves) {
            expect(m.targetCell!.y).toBeGreaterThan(8);
        }
    });

    it("opt-in capped moves retain one closing and one non-closing posture without changing the default", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "Screen", attackType: MELEE, speed: 4 });
        const enemy = createTestUnit({ team: UPPER, name: "Approaching enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 14 });
        const distance = (cell: XY): number =>
            Math.abs(cell.x - enemy.getBaseCell().x) + Math.abs(cell.y - enemy.getBaseCell().y);
        const currentDistance = distance(unit.getBaseCell());

        const historical = enumerateCandidates(unit, ctxFor(c), endTurn(unit), { maxMoveDestinations: 1 });
        const historicalMoves = ofKind(historical.candidates, "move");
        expect(historicalMoves).toHaveLength(1);
        expect(distance(historicalMoves[0].targetCell!)).toBeLessThan(currentDistance);

        const diversified = enumerateCandidates(unit, ctxFor(c), endTurn(unit), {
            maxMoveDestinations: 1,
            preserveMovePostureDiversity: true,
        });
        const diversifiedMoves = ofKind(diversified.candidates, "move");
        expect(diversifiedMoves).toHaveLength(2);
        expect(diversifiedMoves.some(({ targetCell }) => distance(targetCell!) < currentDistance)).toBe(true);
        expect(diversifiedMoves.some(({ targetCell }) => distance(targetCell!) >= currentDistance)).toBe(true);
        expect(diversified.truncated).toContain("move");

        const full = ofKind(enumerateCandidates(unit, ctxFor(c), endTurn(unit)).candidates, "move");
        const optInUncapped = ofKind(
            enumerateCandidates(unit, ctxFor(c), endTurn(unit), { preserveMovePostureDiversity: true }).candidates,
            "move",
        );
        expect(optInUncapped.map(({ targetCell }) => targetCell)).toEqual(full.map(({ targetCell }) => targetCell));
    });

    it("does not expand an opt-in move cap when every reachable destination is closing", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "Corner runner", attackType: MELEE, speed: 2 });
        const enemy = createTestUnit({ team: UPPER, name: "Far enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 0, y: 0 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 14, y: 14 });

        const diversified = enumerateCandidates(unit, ctxFor(c), endTurn(unit), {
            maxMoveDestinations: 1,
            preserveMovePostureDiversity: true,
        });
        expect(ofKind(diversified.candidates, "move")).toHaveLength(1);
        expect(diversified.truncated).toContain("move");
    });

    it("defend is always offered; wait (hourglass) only when the engine would accept it", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "U", attackType: MELEE, speed: 1 });
        const ally = createTestUnit({ team: LOWER, name: "A", attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 5, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 3, y: 12 });
        const fp = FightStateManager.getInstance().getFightProperties();
        fp.setTeamUnitsAlive(LOWER, 2);

        const withWait = enumerateCandidates(unit, ctxFor(c, true), endTurn(unit));
        expect(ofKind(withWait.candidates, "defend").length).toBe(1);
        const wait = ofKind(withWait.candidates, "wait");
        expect(wait.length).toBe(1);
        expect(wait[0].features.hourglassSpent).toBe(1);
        expect(wait[0].features.moraleDelta).toBeLessThan(0);

        // Already hourglassed this lap -> the engine would reject wait -> no wait candidate.
        fp.enqueueHourglass(unit.getId());
        const noWait = enumerateCandidates(unit, ctxFor(c, true), endTurn(unit));
        expect(ofKind(noWait.candidates, "wait").length).toBe(0);
        // No fightProperties in context -> wait legality unknowable -> not offered.
        const noFp = enumerateCandidates(unit, ctxFor(c), endTurn(unit));
        expect(ofKind(noFp.candidates, "wait").length).toBe(0);
    });

    it("shots: aim alternatives per enemy, deduped by identical hit set; lone enemy -> exactly one shot", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LOWER,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            speed: 2,
            amountAlive: 5,
        });
        const lone = createTestUnit({ team: UPPER, name: "Lone", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, lone, { x: 10, y: 10 });
        const { candidates } = enumerateCandidates(shooter, ctxFor(c), endTurn(shooter));
        const shots = ofKind(candidates, "shot");
        // Every observable edge of a lone small enemy hits the identical {enemy} set at the same
        // divisor -> alternative aims collapse to ONE candidate.
        expect(shots.length).toBe(1);
        expect(shots[0].targetId).toBe(lone.getId());
        expect(shots[0].features.spendsRangeShot).toBe(1);
        expect(shots[0].features.expectedDamage).toBeGreaterThan(0);
        const shot = shots[0].actions[shots[0].actions.length - 1];
        expect(shot.type).toBe("range_attack");
        if (shot.type === "range_attack") {
            expect(shot.aimCell).toBeDefined();
            expect(shot.aimSide).toBeDefined();
        }
    });

    it("opt-in shot caps expand to cover every primary target", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LOWER,
            name: "Coverage archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
        });
        const first = createTestUnit({ team: UPPER, name: "First shot target", attackType: MELEE });
        const second = createTestUnit({ team: UPPER, name: "Second shot target", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, first, { x: 10, y: 10 });
        placeUnit(c.grid, c.unitsHolder, second, { x: 12, y: 10 });

        const defaultCapped = enumerateCandidates(shooter, ctxFor(c), endTurn(shooter), { maxShotAims: 1 });
        const covered = enumerateCandidates(shooter, ctxFor(c), endTurn(shooter), {
            maxShotAims: 1,
            preserveAttackTargetCoverage: true,
        });

        expect(new Set(ofKind(defaultCapped.candidates, "shot").map(({ targetId }) => targetId)).size).toBe(1);
        expect(new Set(ofKind(covered.candidates, "shot").map(({ targetId }) => targetId))).toEqual(
            new Set([first.getId(), second.getId()]),
        );
    });

    it("shots: an exact incumbent duplicate is enriched in place and omitted from challengers", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LOWER,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
        });
        const ally = createTestUnit({ team: LOWER, name: "Focus", attackType: MELEE });
        const target = createTestUnit({
            team: UPPER,
            name: "Target",
            attackType: RANGE,
            rangeShots: 3,
            damageMax: 4,
            amountAlive: 5,
        });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 10 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 11, y: 10 });

        const generated = ofKind(enumerateCandidates(shooter, ctxFor(c, true), endTurn(shooter)).candidates, "shot")[0];
        expect(generated).toBeDefined();
        expect(generated.shotFeatures).toMatchObject({
            friendlyFireDamage: 0,
            targetIsRanged: 1,
            targetCanCastSpells: 0,
            targetNotYetActed: 1,
            targetWoundedFraction: 0,
            targetFocusFire: 0.5,
        });
        expect(generated.shotFeatures!.primaryTargetDamage).toBeGreaterThan(0);

        const incumbent = generated.actions;
        const { candidates } = enumerateCandidates(shooter, ctxFor(c, true), incumbent);
        const anchor = candidates[0];
        expect(anchor.kind).toBe("incumbent");
        expect(anchor.actions).toBe(incumbent);
        expect(anchor.targetId).toBe(target.getId());
        expect(anchor.shotFeatures).toEqual(generated.shotFeatures);
        expect(anchor.features.expectedDamage).toBe(generated.features.expectedDamage);
        expect(anchor.features.expectedKill).toBe(generated.features.expectedKill);
        expect(ilCandidateFeatureVector(anchor.features)).toEqual(ilCandidateFeatureVector(generated.features));
        expect(ilCandidateFeatureVector(anchor.features)).toHaveLength(IL_CANDIDATE_FEATURE_NAMES.length);
        expect(Object.keys(anchor).sort()).toEqual(["actions", "features", "kind", "shotFeatures", "targetId"]);
        const explicitOff = enumerateCandidates(shooter, ctxFor(c, true), incumbent, {
            enrichIncumbentMetadata: false,
        }).candidates[0];
        expect(explicitOff).toEqual(anchor);
        expect(ilCandidateActionEncoding(anchor, LOWER)).toEqual(ilCandidateActionEncoding(generated, LOWER));

        // Candidate 0 keeps the exact action identity and the generator does not emit it again as a challenger.
        const signatures = candidates.map((candidate) => ilActionSignature(candidate.actions));
        expect(new Set(signatures).size).toBe(signatures.length);
        expect(ofKind(candidates, "shot").some((candidate) => candidate.targetId === target.getId())).toBe(false);
    });

    it("shots: exposes friendly-fire damage separately without changing net expected damage", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LOWER, "Nature", "Gargantuan");
        const ally = createTestUnit({ team: LOWER, name: "Ally", attackType: MELEE, amountAlive: 20 });
        const target = createTestUnit({ team: UPPER, name: "Target", attackType: MELEE, amountAlive: 20 });
        placeLarge(c, garg, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 10 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 10, y: 9 });

        const shots = ofKind(enumerateCandidates(garg, ctxFor(c), endTurn(garg)).candidates, "shot");
        const splash = shots.find((candidate) => (candidate.shotFeatures?.friendlyFireDamage ?? 0) > 0);
        expect(splash).toBeDefined();
        expect(splash!.shotFeatures!.enemyDamage).toBeGreaterThan(0);
        expect(splash!.features.expectedDamage).toBe(
            splash!.shotFeatures!.enemyDamage - splash!.shotFeatures!.friendlyFireDamage,
        );

        const incumbent = splash!.actions;
        const anchor = enumerateCandidates(garg, ctxFor(c), incumbent).candidates[0];
        expect(anchor.actions).toBe(incumbent);
        expect(anchor.shotFeatures).toEqual(splash!.shotFeatures);
        expect(anchor.features.expectedDamage).toBe(splash!.features.expectedDamage);
    });

    it("v0.8s target pressure rejects a net-negative splash even when it kills the primary target", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LOWER, "Nature", "Gargantuan");
        const ally = createTestUnit({
            team: LOWER,
            name: "Large ally",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 100,
        });
        const target = createTestUnit({
            team: UPPER,
            name: "Tiny target",
            attackType: MELEE,
            amountAlive: 1,
            maxHp: 1,
        });
        placeLarge(c, garg, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 10 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 10, y: 9 });

        const shots = ofKind(
            enumerateCandidates(garg, ctxFor(c), endTurn(garg), { preserveAttackTargetCoverage: true }).candidates,
            "shot",
        );
        const harmful = shots.find(
            (candidate) =>
                candidate.targetId === target.getId() &&
                candidate.features.expectedDamage < 0 &&
                (candidate.shotFeatures?.primaryTargetDamage ?? 0) > 0,
        );
        expect(harmful).toBeDefined();
        expect(harmful!.features.expectedKill).toBe(1);
        expect(selectV08STargetPressureCandidate(garg, c.unitsHolder, [harmful!])).toBeUndefined();
    });

    it("shots: a pinned shooter (adjacent enemy) gets NO shot candidates (engine would reject)", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({ team: LOWER, name: "Pinned", attackType: RANGE, rangeShots: 5 });
        const pinner = createTestUnit({ team: UPPER, name: "Pinner", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, pinner, { x: 3, y: 4 });
        const { candidates } = enumerateCandidates(shooter, ctxFor(c), endTurn(shooter));
        expect(ofKind(candidates, "shot").length).toBe(0);
        expect(ofKind(candidates, "area_throw").length).toBe(0);
    });

    it("area_throw (Gargantuan): aim cells whose splash reaches enemies, incl. a two-enemy cluster aim", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LOWER, "Nature", "Gargantuan"); // RANGE, size 2, Area Throw + Double Shot
        const e1 = createTestUnit({ team: UPPER, name: "E1", attackType: MELEE, amountAlive: 5, maxHp: 50 });
        const e2 = createTestUnit({ team: UPPER, name: "E2", attackType: MELEE, amountAlive: 5, maxHp: 50 });
        placeLarge(c, garg, { x: 3, y: 3 });
        // Clustered enemies with the empty cell (10,10) adjacent to BOTH.
        placeUnit(c.grid, c.unitsHolder, e1, { x: 10, y: 11 });
        placeUnit(c.grid, c.unitsHolder, e2, { x: 11, y: 10 });
        const { candidates } = enumerateCandidates(garg, ctxFor(c), endTurn(garg));
        const throws = ofKind(candidates, "area_throw");
        expect(throws.length).toBeGreaterThan(0);
        expect(throws.every((candidate) => !("pressureTargetId" in candidate))).toBe(true);
        expect(throws.every((candidate) => !("pressureExpectedKill" in candidate))).toBe(true);
        for (const t of throws) {
            // Engine legality: in-grid and not unit-occupied.
            const occupant = c.grid.getOccupantUnitId(t.targetCell!);
            expect(!occupant || occupant === "L" || occupant === "W").toBe(true);
            expect(t.features.spendsRangeShot).toBe(1);
            expect(t.pressureTargetId).toBeUndefined();
        }
        // The cluster cell must be among the aims, and its splash (both enemies) out-damages
        // any single-enemy splash.
        const cluster = throws.find((t) => t.targetCell!.x === 10 && t.targetCell!.y === 10);
        expect(cluster).toBeDefined();
        const maxDamage = Math.max(...throws.map((t) => t.features.expectedDamage));
        expect(cluster!.features.expectedDamage).toBe(maxDamage);
        const anchor = enumerateCandidates(garg, ctxFor(c), cluster!.actions, {
            enrichIncumbentMetadata: true,
            maxAreaThrowCells: 1,
        }).candidates[0];
        expect(anchor.actions).toBe(cluster!.actions);
        expect(ilCandidateFeatureVector(anchor.features)).toEqual(ilCandidateFeatureVector(cluster!.features));
        expect(ilCandidateActionEncoding(anchor, LOWER)).toEqual(ilCandidateActionEncoding(cluster!, LOWER));
        // Gargantuan also gets plain ranged shots (it is a shooter).
        expect(ofKind(candidates, "shot").length).toBeGreaterThan(0);
    });

    it("area_throw: only emits aims whose engine primary hit satisfies a forced target", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LOWER, "Nature", "Gargantuan");
        const forced = createTestUnit({ team: UPPER, name: "Forced", attackType: MELEE, amountAlive: 20 });
        const clusterA = createTestUnit({ team: UPPER, name: "Cluster A", attackType: MELEE, amountAlive: 20 });
        const clusterB = createTestUnit({ team: UPPER, name: "Cluster B", attackType: MELEE, amountAlive: 20 });
        placeLarge(c, garg, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, forced, { x: 14, y: 3 });
        placeUnit(c.grid, c.unitsHolder, clusterA, { x: 10, y: 9 });
        placeUnit(c.grid, c.unitsHolder, clusterB, { x: 10, y: 11 });
        garg.setTarget(forced.getId());

        const throws = ofKind(enumerateCandidates(garg, ctxFor(c), endTurn(garg)).candidates, "area_throw");
        expect(throws.length).toBeGreaterThan(0);
        expect(throws.every((candidate) => candidate.targetId === forced.getId())).toBe(true);
    });

    it("v0.8s target pressure schedules a positive Area Throw whose engine-primary hit is allied", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LOWER, "Nature", "Gargantuan");
        const enemyA = createTestUnit({
            team: UPPER,
            name: "Enemy A",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1,
        });
        const enemyB = createTestUnit({
            team: UPPER,
            name: "Enemy B",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1,
        });
        const ally = createTestUnit({ team: LOWER, name: "Interceptor", attackType: MELEE, amountAlive: 1, maxHp: 1 });
        placeLarge(c, garg, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(c.grid, c.unitsHolder, enemyB, { x: 10, y: 11 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 8, y: 8 });

        const throws = ofKind(
            enumerateCandidates(garg, ctxFor(c), endTurn(garg), { preserveAttackTargetCoverage: true }).candidates,
            "area_throw",
        );
        const friendlyPrimary = throws.find(
            (candidate) => candidate.targetId === ally.getId() && candidate.features.expectedDamage > 0,
        );
        expect(friendlyPrimary).toBeDefined();
        expect([enemyA.getId(), enemyB.getId()]).toContain(friendlyPrimary!.pressureTargetId!);
        expect(friendlyPrimary!.features.expectedKill).toBe(0);
        expect(friendlyPrimary!.pressureExpectedKill).toBe(1);
        expect(selectV08STargetPressureCandidate(garg, c.unitsHolder, [friendlyPrimary!])).toBe(friendlyPrimary);
    });

    it("area_throw: hit probability prevents a Dodge/Small Specie cluster from outranking a clean shot", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LOWER, "Nature", "Gargantuan");
        const evasive = {
            team: UPPER,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1_000,
            stackPower: 5,
            abilities: ["Dodge", "Small Specie"],
        };
        const clusterA = createTestUnit({ ...evasive, name: "Cluster A" });
        const clusterB = createTestUnit({ ...evasive, name: "Cluster B" });
        const reliable = createTestUnit({
            team: UPPER,
            name: "Reliable",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1_000,
        });
        placeLarge(c, garg, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, clusterA, { x: 10, y: 9 });
        placeUnit(c.grid, c.unitsHolder, clusterB, { x: 10, y: 11 });
        placeUnit(c.grid, c.unitsHolder, reliable, { x: 8, y: 3 });

        const candidates = enumerateCandidates(garg, ctxFor(c), endTurn(garg)).candidates;
        const cluster = ofKind(candidates, "area_throw").find(
            (candidate) => candidate.targetCell?.x === 10 && candidate.targetCell.y === 10,
        );
        const cleanShot = ofKind(candidates, "shot").find((candidate) => candidate.targetId === reliable.getId());
        expect(cluster).toBeDefined();
        expect(cleanShot).toBeDefined();
        expect(cluster!.features.expectedDamage).toBeLessThan(cleanShot!.features.expectedDamage);
    });

    it("AOE damage estimates use the engine's miss, artifact, and physical-resistance modifiers", () => {
        const score = (mutate?: (attacker: Unit, target: Unit) => void): number => {
            const c = createCombatTestContext();
            const garg = makeReal(LOWER, "Nature", "Gargantuan");
            const target = createTestUnit({
                team: UPPER,
                name: "Target",
                attackType: MELEE,
                amountAlive: 100,
                maxHp: 1_000,
            });
            placeLarge(c, garg, { x: 3, y: 3 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 10 });
            mutate?.(garg, target);
            const shot = ofKind(enumerateCandidates(garg, ctxFor(c), endTurn(garg)).candidates, "shot").find(
                (candidate) => candidate.targetId === target.getId(),
            );
            expect(shot).toBeDefined();
            return shot!.features.expectedDamage;
        };
        const giveBuff = (unit: Unit, name: "Amulet of Resolve" | "Broken Aegis", power: number): void => {
            const buff = new Spell({
                spellProperties: getSpellConfig("System", name, NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            });
            buff.setPower(power);
            unit.applyBuff(buff);
        };

        const baseline = score();
        const boarSaliva = score((attacker) => attacker.applyEffect(new EffectFactory().makeEffect("Boar Saliva")));
        const brokenAegisMiss = score((attacker) => giveBuff(attacker, "Broken Aegis", 20));
        const brokenAegisReduction = score((_attacker, target) => giveBuff(target, "Broken Aegis", 20));
        const statusResistance = score((_attacker, target) => giveBuff(target, "Amulet of Resolve", 25));
        const mechanismVulnerability = score((_attacker, target) => target.grantAbility("Mechanism"));

        expect(boarSaliva).toBeLessThan(baseline);
        expect(brokenAegisMiss).toBeLessThan(baseline);
        expect(brokenAegisReduction).toBeLessThan(baseline);
        expect(statusResistance).toBeLessThan(baseline);
        expect(mechanismVulnerability).toBeGreaterThan(baseline);
    });

    it("Angel: Resurrection candidates target living allies with dead bodies and price the passive charge", () => {
        const c = createCombatTestContext();
        const angel = makeReal(LOWER, "Life", "Angel"); // MELEE_MAGIC, ability-granted Resurrection
        angel.setStackPower(5); // spell requires caster stack power >= 3
        const hurt = createTestUnit({ team: LOWER, name: "Hurt", attackType: MELEE, amountAlive: 5, maxHp: 10 });
        const fresh = createTestUnit({ team: LOWER, name: "Fresh", attackType: MELEE, amountAlive: 5, maxHp: 10 });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE });
        placeLarge(c, angel, { x: 4, y: 4 });
        placeUnit(c.grid, c.unitsHolder, hurt, { x: 8, y: 4 });
        placeUnit(c.grid, c.unitsHolder, fresh, { x: 9, y: 4 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 12 });
        hurt.applyDamage(25, 0, new SceneLogMock()); // kills 2 of the 10-hp stack -> amountDied > 0
        expect(hurt.getAmountDied()).toBeGreaterThan(0);

        const { candidates } = enumerateCandidates(angel, ctxFor(c), endTurn(angel));
        const res = ofKind(candidates, "spell").filter((s) => s.spellName === "Resurrection");
        expect(res.length).toBe(1); // only the ally with dead bodies is a legal target
        expect(res[0].targetId).toBe(hurt.getId());
        // Opportunity cost: the cast burns the Angel's own on-death auto-res charge.
        expect(res[0].features.burnsResurrectionCharge).toBe(1);
        expect(res[0].features.spendsSpellCharge).toBe(1);
        const anchor = enumerateCandidates(angel, ctxFor(c), res[0].actions, {
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(anchor.actions).toBe(res[0].actions);
        expect(ilCandidateFeatureVector(anchor.features)).toEqual(ilCandidateFeatureVector(res[0].features));
        expect(ilCandidateActionEncoding(anchor, LOWER)).toEqual(ilCandidateActionEncoding(res[0], LOWER));
        // And the MELEE_MAGIC Angel still gets melee/move candidates alongside the cast.
        expect(ofKind(candidates, "move").length).toBeGreaterThan(0);

        // Break suppresses hasAbilityActive(), but the cast remains engine-legal and still burns the stored
        // passive. The opportunity-cost feature must therefore remain set while Angel is Broken.
        angel.applyEffect(new EffectFactory().makeEffect("Break"));
        expect(angel.hasAbilityActive("Resurrection")).toBe(false);
        const brokenRes = ofKind(enumerateCandidates(angel, ctxFor(c), endTurn(angel)).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Resurrection",
        );
        expect(brokenRes).toHaveLength(1);
        expect(brokenRes[0].features.burnsResurrectionCharge).toBe(1);
    });

    it("Valkyrie: Wind Flow (ALL_FLYING mass) is emitted when a flyer is on the board", () => {
        const c = createCombatTestContext();
        const valk = makeReal(LOWER, "Life", "Valkyrie");
        valk.setStackPower(5); // Wind Flow requires stack power 5
        const flyer = createTestUnit({ team: UPPER, name: "Flyer", attackType: MELEE, movementType: FLY });
        placeUnit(c.grid, c.unitsHolder, valk, { x: 4, y: 4 });
        placeUnit(c.grid, c.unitsHolder, flyer, { x: 4, y: 12 });
        const { candidates } = enumerateCandidates(valk, ctxFor(c), endTurn(valk));
        const wind = ofKind(candidates, "spell").filter((s) => s.spellName === "Wind Flow");
        expect(wind.length).toBe(1);
        expect(wind[0].targetId).toBeUndefined(); // mass cast carries no target
        const cast = wind[0].actions[0];
        expect(cast.type).toBe("cast_spell");
    });

    it("Harpy: Castling targets exactly the SMALL enemies within movement range", () => {
        const c = createCombatTestContext();
        const harpy = makeReal(LOWER, "Might", "Harpy"); // speed 7.6 flyer with Castling
        harpy.setStackPower(5); // Castling requires stack power 4
        const near = createTestUnit({ team: UPPER, name: "Near", attackType: MELEE, amountAlive: 3 });
        const farAway = createTestUnit({ team: UPPER, name: "FarAway", attackType: MELEE, amountAlive: 3 });
        placeUnit(c.grid, c.unitsHolder, harpy, { x: 2, y: 2 });
        placeUnit(c.grid, c.unitsHolder, near, { x: 5, y: 5 }); // within ~7 steps
        placeUnit(c.grid, c.unitsHolder, farAway, { x: 15, y: 15 }); // out of reach
        const ctx = ctxFor(c);

        const cells = getEnemiesCellsWithinMovementRange(harpy, ctx);
        expect(cells).toContainEqual({ x: 5, y: 5 });
        expect(cells).not.toContainEqual({ x: 15, y: 15 });

        const { candidates } = enumerateCandidates(harpy, ctx, endTurn(harpy));
        const castling = ofKind(candidates, "spell").filter((s) => s.spellName === "Castling");
        expect(castling.length).toBe(1);
        expect(castling[0].targetId).toBe(near.getId());
    });

    it("Harpy: a LARGE enemy within range is NOT a Castling target", () => {
        const c = createCombatTestContext();
        const harpy = makeReal(LOWER, "Might", "Harpy");
        harpy.setStackPower(5);
        const big = makeReal(UPPER, "Nature", "Gargantuan"); // size 2
        placeUnit(c.grid, c.unitsHolder, harpy, { x: 2, y: 2 });
        placeLarge(c, big, { x: 6, y: 6 });
        const { candidates } = enumerateCandidates(harpy, ctxFor(c), endTurn(harpy));
        expect(ofKind(candidates, "spell").filter((s) => s.spellName === "Castling").length).toBe(0);
    });

    it("Arachna Queen: inherited Castling is not enumerated for a LARGE caster", () => {
        const c = createCombatTestContext();
        const queen = makeReal(LOWER, "Nature", "Arachna Queen");
        queen.grantStolenAbility("Castling", [":Castling"]);
        queen.setStackPower(5);
        const enemy = createTestUnit({ team: UPPER, name: "Near", attackType: MELEE, amountAlive: 3 });
        placeLarge(c, queen, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 6, y: 6 });

        expect(queen.hasSpellRemaining("Castling")).toBe(true);
        const { candidates } = enumerateCandidates(queen, ctxFor(c), endTurn(queen));
        expect(ofKind(candidates, "spell").filter((candidate) => candidate.spellName === "Castling")).toHaveLength(0);
    });

    it("dedupes candidates identical to the incumbent (no double-scored actions)", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "U", attackType: MELEE, speed: 2, amountAlive: 3 });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE, amountAlive: 3 });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 5, y: 6 });
        // Incumbent IS the in-place strike -> the melee enumeration must not repeat it.
        const incumbent: GameAction[] = [
            { type: "melee_attack", attackerId: unit.getId(), targetId: enemy.getId(), attackFrom: { x: 5, y: 5 } },
        ];
        const { candidates } = enumerateCandidates(unit, ctxFor(c), incumbent);
        const dupes = candidates.filter(
            (cand) =>
                cand.kind === "melee" &&
                cand.targetId === enemy.getId() &&
                cand.standCell?.x === 5 &&
                cand.standCell?.y === 5,
        );
        expect(dupes.length).toBe(0);
        expect(candidates[0].actions).toBe(incumbent);
    });

    it("is deterministic: two runs on the same board produce identical candidate sets", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "U", attackType: MELEE, speed: 3, amountAlive: 4 });
        const e1 = createTestUnit({ team: UPPER, name: "E1", attackType: MELEE, amountAlive: 4 });
        const e2 = createTestUnit({ team: UPPER, name: "E2", attackType: MELEE, amountAlive: 4 });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, e1, { x: 6, y: 7 });
        placeUnit(c.grid, c.unitsHolder, e2, { x: 9, y: 6 });
        const a = enumerateCandidates(unit, ctxFor(c), endTurn(unit));
        const b = enumerateCandidates(unit, ctxFor(c), endTurn(unit));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it("bench: enumeration cost per turn on a populated board (logged)", () => {
        const c = createCombatTestContext();
        const movers: Unit[] = [];
        // 2x6 mid-game-ish board: melee wall + shooters + the Gargantuan (widest enumeration).
        const garg = makeReal(LOWER, "Nature", "Gargantuan");
        placeLarge(c, garg, { x: 3, y: 3 });
        movers.push(garg);
        for (let i = 0; i < 4; i += 1) {
            const m = createTestUnit({ team: LOWER, name: `M${i}`, attackType: MELEE, speed: 4, amountAlive: 5 });
            placeUnit(c.grid, c.unitsHolder, m, { x: 5 + i * 2, y: 4 });
            movers.push(m);
        }
        const shooter = createTestUnit({ team: LOWER, name: "S", attackType: RANGE, rangeShots: 8, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 13, y: 3 });
        movers.push(shooter);
        for (let i = 0; i < 6; i += 1) {
            const e = createTestUnit({ team: UPPER, name: `E${i}`, attackType: MELEE, speed: 4, amountAlive: 5 });
            placeUnit(c.grid, c.unitsHolder, e, { x: 3 + i * 2, y: 9 });
        }
        const ctx = ctxFor(c);
        // Warm-up + timed runs across all our units.
        for (const u of movers) {
            enumerateCandidates(u, ctx, endTurn(u));
        }
        const iterations = 20;
        const start = performance.now();
        let total = 0;
        for (let i = 0; i < iterations; i += 1) {
            for (const u of movers) {
                total += enumerateCandidates(u, ctx, endTurn(u)).candidates.length;
            }
        }
        const elapsed = performance.now() - start;
        const perTurnMs = elapsed / (iterations * movers.length);

        console.log(
            `[candidates bench] ${movers.length} units x ${iterations} iters: ` +
                `${perTurnMs.toFixed(2)} ms/turn avg, ${(total / (iterations * movers.length)).toFixed(1)} candidates/turn avg`,
        );
        // Generous CI bound — locally this is ~1-6 ms/turn; the point is catching accidental O(n^3) blowups.
        expect(perTurnMs).toBeLessThan(150);
    });
});
