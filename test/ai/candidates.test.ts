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
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    getCellsAroundCell,
    getPositionForCells,
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    type RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { ilCandidateActionEncoding } from "../../src/simulation/il_action_features";
import {
    IL_CANDIDATE_FEATURE_NAMES,
    ilActionSignature,
    ilCandidateFeatureVector,
} from "../../src/simulation/il_dataset";
import { fireWallCells, normalizeFireWallOrientation } from "../../src/spells/fire_walls";
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

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
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

function startActionEngine(c: CombatTestContext, unit: Unit, context: IDecisionContext): GameActionEngine {
    const fightProperties = context.fightProperties!;
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LEFT, c.unitsHolder.getAllAllies(LEFT).length);
    fightProperties.setTeamUnitsAlive(RIGHT, c.unitsHolder.getAllAllies(RIGHT).length);
    fightProperties.startTurn(unit.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: c.grid,
        unitsHolder: c.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, c.grid, c.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: c.attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
        getCurrentEnemiesCellsWithinMovementRange: () => getEnemiesCellsWithinMovementRange(unit, context),
    });
}

const endTurn = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
const ofKind = (cands: IEnumeratedCandidate[], kind: string): IEnumeratedCandidate[] =>
    cands.filter((cand) => cand.kind === kind);

describe("candidates — the F4 enumerated candidate generator", () => {
    it("candidate 0 is ALWAYS the incumbent decision (anchor pattern), verbatim", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "U", attackType: MELEE, initiative: 2 });
        const enemy = createTestUnit({ team: RIGHT, name: "E", attackType: MELEE });
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
        const unit = createTestUnit({ team: LEFT, name: "Brawler", attackType: MELEE, initiative: 3, amountAlive: 5 });
        const adj1 = createTestUnit({ team: RIGHT, name: "Adj1", attackType: MELEE, amountAlive: 3 });
        const adj2 = createTestUnit({ team: RIGHT, name: "Adj2", attackType: MELEE, amountAlive: 3 });
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

    it("melee: only a live forced target constrains candidates; missing and dead targets release them", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "Aggr-constrained brawler", attackType: MELEE });
        const forced = createTestUnit({ team: RIGHT, name: "Live forced target", attackType: MELEE });
        const other = createTestUnit({ team: RIGHT, name: "Other adjacent target", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, forced, { x: 5, y: 6 });
        placeUnit(c.grid, c.unitsHolder, other, { x: 6, y: 5 });
        const meleeTargetIds = (): Set<string | undefined> =>
            new Set(
                ofKind(enumerateCandidates(unit, ctxFor(c), endTurn(unit)).candidates, "melee").map(
                    ({ targetId }) => targetId,
                ),
            );

        unit.setTarget(forced.getId());
        expect(meleeTargetIds()).toEqual(new Set([forced.getId()]));

        unit.setTarget("missing-forced-target");
        expect(meleeTargetIds()).toEqual(new Set([forced.getId(), other.getId()]));

        unit.setTarget(forced.getId());
        forced.applyDamage(forced.getCumulativeHp(), 0, new SceneLogMock());
        expect(meleeTargetIds()).toEqual(new Set([other.getId()]));
    });

    it("melee metadata applies a native shooter's penalty while Handyman retains full damage", () => {
        const meleeMetadata = (abilities: string[] = []): IEnumeratedCandidate => {
            const c = createCombatTestContext();
            const shooter = createTestUnit({
                team: LEFT,
                name: abilities.length ? "Handyman shooter" : "Penalized shooter",
                attackType: RANGE,
                attack: 10,
                damageMin: 4,
                damageMax: 4,
                rangeShots: 5,
                abilities,
            });
            const target = createTestUnit({
                team: RIGHT,
                name: "Four HP target",
                attackType: MELEE,
                armor: 10,
                maxHp: 4,
            });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 5, y: 5 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 5, y: 6 });
            shooter.refreshPossibleAttackTypes(false);

            const candidate = ofKind(
                enumerateCandidates(shooter, ctxFor(c), endTurn(shooter)).candidates,
                "melee",
            ).find(({ targetId, standCell }) => targetId === target.getId() && standCell?.x === 5 && standCell.y === 5);
            if (!candidate) throw new Error("expected an in-place ranged-unit melee candidate");
            return candidate;
        };

        const penalized = meleeMetadata();
        expect(penalized.features.expectedDamage).toBe(2);
        expect(penalized.features.expectedKill).toBe(0);

        const handyman = meleeMetadata(["Handyman"]);
        expect(handyman.features.expectedDamage).toBe(4);
        expect(handyman.features.expectedKill).toBe(1);
    });

    it("opt-in attack caps retain the best delivery to every distinct target", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "Scheduler", attackType: MELEE, amountAlive: 5 });
        const first = createTestUnit({ team: RIGHT, name: "First blocker", attackType: MELEE, amountAlive: 3 });
        const second = createTestUnit({ team: RIGHT, name: "Second blocker", attackType: MELEE, amountAlive: 3 });
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
        const unit = createTestUnit({ team: LEFT, name: "Brawler", attackType: MELEE, initiative: 4, amountAlive: 5 });
        const far = createTestUnit({ team: RIGHT, name: "Far", attackType: MELEE, amountAlive: 3 });
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
        expect(ilCandidateActionEncoding(anchor, LEFT)).toEqual(ilCandidateActionEncoding(moveStrike, LEFT));
    });

    it("moves: every reachable destination; capped enumeration reports truncation", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "Runner", attackType: MELEE, initiative: 4 });
        const enemy = createTestUnit({ team: RIGHT, name: "E", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 14 });

        const full = enumerateCandidates(unit, ctxFor(c), endTurn(unit));
        const fullMoves = ofKind(full.candidates, "move");
        expect(fullMoves.length).toBeGreaterThan(10); // initiative 4 in open field
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
        const unit = createTestUnit({ team: LEFT, name: "Screen", attackType: MELEE, initiative: 4 });
        const enemy = createTestUnit({ team: RIGHT, name: "Approaching enemy", attackType: MELEE });
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

    it("applies a hard move-role gate before selecting the nearest capped destination", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "Role holder", attackType: MELEE, initiative: 4 });
        const enemy = createTestUnit({ team: RIGHT, name: "Approaching enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 14 });
        const distance = (cell: XY): number =>
            Math.abs(cell.x - enemy.getBaseCell().x) + Math.abs(cell.y - enemy.getBaseCell().y);
        const fullEligible = ofKind(enumerateCandidates(unit, ctxFor(c), endTurn(unit)).candidates, "move").filter(
            ({ targetCell }) => targetCell !== undefined && targetCell.y <= unit.getBaseCell().y,
        );
        const nearestEligibleDistance = Math.min(...fullEligible.map(({ targetCell }) => distance(targetCell!)));

        const gated = enumerateCandidates(unit, ctxFor(c), endTurn(unit), {
            maxMoveDestinations: 1,
            retainMoveCandidateBeforeCap: ({ targetCell }) =>
                targetCell !== undefined && targetCell.y <= unit.getBaseCell().y,
        });
        const gatedMoves = ofKind(gated.candidates, "move");
        expect(gatedMoves).toHaveLength(1);
        expect(gatedMoves[0].targetCell!.y).toBeLessThanOrEqual(unit.getBaseCell().y);
        expect(distance(gatedMoves[0].targetCell!)).toBe(nearestEligibleDistance);
        expect(gated.truncated).toContain("move");
    });

    it("does not expand an opt-in move cap when every reachable destination is closing", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "Corner runner", attackType: MELEE, initiative: 2 });
        const enemy = createTestUnit({ team: RIGHT, name: "Far enemy", attackType: MELEE });
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
        const unit = createTestUnit({ team: LEFT, name: "U", attackType: MELEE, initiative: 1 });
        const ally = createTestUnit({ team: LEFT, name: "A", attackType: MELEE });
        const enemy = createTestUnit({ team: RIGHT, name: "E", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 5, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 3, y: 12 });
        const fp = FightStateManager.getInstance().getFightProperties();
        fp.setTeamUnitsAlive(LEFT, 2);

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

    it("Nightmare's Time Denial suppresses wait candidates board-wide", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "U", attackType: MELEE, initiative: 1 });
        const ally = createTestUnit({ team: LEFT, name: "A", attackType: MELEE });
        const nightmare = makeReal(RIGHT, "Chaos", "Nightmare");
        placeUnit(c.grid, c.unitsHolder, unit, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 5, y: 3 });
        placeUnit(c.grid, c.unitsHolder, nightmare, { x: 12, y: 12 });
        const fp = FightStateManager.getInstance().getFightProperties();
        fp.setTeamUnitsAlive(LEFT, 2);

        expect(nightmare.hasAbilityActive("Time Denial")).toBe(true);
        const candidates = enumerateCandidates(unit, ctxFor(c, true), endTurn(unit)).candidates;
        expect(ofKind(candidates, "defend")).toHaveLength(1);
        expect(ofKind(candidates, "wait")).toHaveLength(0);
    });

    it("shots: aim alternatives per enemy, deduped by identical hit set; lone enemy -> exactly one shot", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            initiative: 2,
            amountAlive: 5,
        });
        const lone = createTestUnit({ team: RIGHT, name: "Lone", attackType: MELEE, amountAlive: 5 });
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

    it("shots: canonicalizes a screened rear aim to the visible edge and identity of the actual first hit", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Screened-shot archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
        });
        // Insert the rear unit first so roster iteration would deterministically advertise it first without
        // first-hit canonicalization.
        const rear = createTestUnit({ team: RIGHT, name: "Screened rear", attackType: MELEE });
        const front = createTestUnit({ team: RIGHT, name: "Actual first hit", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, rear, { x: 10, y: 7 });
        placeUnit(c.grid, c.unitsHolder, front, { x: 6, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        const context = ctxFor(c, true);

        const enumerate = (): IEnumeratedCandidate[] =>
            ofKind(enumerateCandidates(shooter, context, endTurn(shooter)).candidates, "shot");
        const shots = enumerate();
        expect(shots).toHaveLength(1);
        expect(JSON.stringify(enumerate())).toBe(JSON.stringify(shots));

        const candidate = shots[0];
        const action = candidate.actions.find(
            (entry): entry is Extract<GameAction, { type: "range_attack" }> => entry.type === "range_attack",
        );
        expect(action).toBeDefined();
        expect(candidate.targetId).toBe(front.getId());
        expect(action!.targetId).toBe(front.getId());
        expect(front.getCells()).toContainEqual(action!.aimCell!);
        expect(rear.getCells()).not.toContainEqual(action!.aimCell!);
        expect(candidate.shotFeatures?.aimTargetDamage).toBe(candidate.shotFeatures?.primaryTargetDamage);
        expect(
            isRangeAttackSideObservable(
                c.grid.getMatrix(),
                action!.aimCell!,
                action!.aimSide as RangeAttackCellSide,
                shooter.getTeam(),
                false,
            ),
        ).toBe(true);

        const to = getRangeAttackSideCenter(
            testGridSettings,
            action!.aimCell!,
            action!.aimSide as RangeAttackCellSide,
            shooter.getPosition(),
        );
        const evaluation = c.attackHandler.evaluateRangeAttack(
            c.unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            to,
            false,
            false,
            false,
        );
        expect(evaluation.affectedUnits[0]?.[0]?.getId()).toBe(candidate.targetId);
        expect(candidate.shotFeatures?.primaryTargetDamage).toBeGreaterThan(0);

        const engine = startActionEngine(c, shooter, context);
        expect(candidate.actions.every((entry) => engine.apply(entry).completed)).toBe(true);
    });

    for (const special of [
        { ability: "Through Shot", through: true, aoe: false },
        { ability: "Large Caliber", through: false, aoe: true },
    ] as const) {
        it(`shots: ${special.ability} retains an intentional rear aim while scoring the actual primary`, () => {
            const c = createCombatTestContext();
            const shooter = createTestUnit({
                team: LEFT,
                name: `${special.ability} shooter`,
                attackType: RANGE,
                rangeShots: 5,
                shotDistance: 30,
                amountAlive: 5,
                abilities: [special.ability],
            });
            const rear = createTestUnit({ team: RIGHT, name: "Intentional rear aim", attackType: MELEE });
            const front = createTestUnit({ team: RIGHT, name: "Special first hit", attackType: MELEE });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
            placeUnit(c.grid, c.unitsHolder, rear, { x: 10, y: 7 });
            placeUnit(c.grid, c.unitsHolder, front, { x: 6, y: 7 });
            shooter.refreshPossibleAttackTypes(true);
            const context = ctxFor(c, true);

            const rearAim = ofKind(enumerateCandidates(shooter, context, endTurn(shooter)).candidates, "shot").find(
                (candidate) => {
                    const action = candidate.actions.find((entry) => entry.type === "range_attack");
                    return (
                        action?.type === "range_attack" &&
                        action.targetId === rear.getId() &&
                        action.aimCell?.x === rear.getBaseCell().x &&
                        action.aimCell.y === rear.getBaseCell().y
                    );
                },
            );
            expect(rearAim).toBeDefined();
            expect(rearAim!.targetId).toBe(front.getId());
            expect(rearAim!.shotFeatures?.primaryTargetDamage).toBeGreaterThan(0);
            if (special.through) {
                expect(rearAim!.shotFeatures?.aimTargetDamage).toBeGreaterThan(0);
            } else {
                // Large Caliber explodes at the first intercepted group. The rear stack owns the selected
                // edge, but it is outside the front stack's 3x3 splash and therefore takes no phantom damage.
                expect(rearAim!.shotFeatures?.aimTargetDamage).toBe(0);
            }

            const action = rearAim!.actions.find(
                (entry): entry is Extract<GameAction, { type: "range_attack" }> => entry.type === "range_attack",
            )!;
            expect(
                isRangeAttackSideObservable(
                    c.grid.getMatrix(),
                    action.aimCell!,
                    action.aimSide as RangeAttackCellSide,
                    shooter.getTeam(),
                    special.through,
                ),
            ).toBe(true);
            const to = getRangeAttackSideCenter(
                testGridSettings,
                action.aimCell!,
                action.aimSide as RangeAttackCellSide,
                shooter.getPosition(),
            );
            const evaluation = c.attackHandler.evaluateRangeAttack(
                c.unitsHolder.getAllUnits(),
                shooter,
                shooter.getPosition(),
                to,
                special.through,
                false,
                special.aoe,
            );
            expect(evaluation.affectedUnits[0]?.[0]?.getId()).toBe(rearAim!.targetId);
            expect(evaluation.affectedUnits.flat().some((unit) => unit.getId() === rear.getId())).toBe(true);

            const enrichedAnchor = enumerateCandidates(shooter, context, rearAim!.actions, {
                enrichIncumbentMetadata: true,
            }).candidates[0];
            const anchorAction = enrichedAnchor.actions.find(
                (entry): entry is Extract<GameAction, { type: "range_attack" }> => entry.type === "range_attack",
            );
            // The finish scheduler reads candidate.targetId and must see the actual primary. The exact special
            // geometry action nevertheless keeps its intentional rear aim anchor.
            expect(enrichedAnchor.kind).toBe("incumbent");
            expect(enrichedAnchor.targetId).toBe(front.getId());
            expect(enrichedAnchor.shotFeatures?.primaryTargetDamage).toBeGreaterThan(0);
            expect(anchorAction?.targetId).toBe(rear.getId());
            expect(anchorAction?.aimCell).toEqual(rear.getBaseCell());

            const covered = ofKind(
                enumerateCandidates(shooter, context, endTurn(shooter), {
                    maxShotAims: 1,
                    preserveAttackTargetCoverage: true,
                }).candidates,
                "shot",
            );
            expect(
                covered.some((candidate) =>
                    candidate.actions.some((entry) => entry.type === "range_attack" && entry.targetId === rear.getId()),
                ),
            ).toBe(true);

            const frontHpBefore = front.getCumulativeHp();
            const rearHpBefore = rear.getCumulativeHp();
            const engine = startActionEngine(c, shooter, context);
            expect(rearAim!.actions.every((entry) => engine.apply(entry).completed)).toBe(true);
            expect(front.getCumulativeHp()).toBeLessThan(frontHpBefore);
            if (special.through) {
                expect(rear.getCumulativeHp()).toBeLessThan(rearHpBefore);
            } else {
                expect(rear.getCumulativeHp()).toBe(rearHpBefore);
            }
        });
    }

    it("Through Shot metadata matches stack power, Giant's Maul, and physical resistance in the engine", () => {
        const run = (
            options: {
                giantsMaulPower?: number;
                secondShot?: "Double Shot" | "Crafted Double Shot";
                dualStrikeCharmPower?: number;
            } = {},
        ): { estimated: number; applied: number } => {
            const c = createCombatTestContext();
            const shooter = createTestUnit({
                team: LEFT,
                name: "Low-power Through Shot",
                attackType: RANGE,
                attack: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 5,
                shotDistance: 30,
                amountAlive: 5,
                stackPower: 1,
                abilities: ["Through Shot", ...(options.secondShot ? [options.secondShot] : [])],
            });
            const target = createTestUnit({
                team: RIGHT,
                name: "Status-resistant target",
                attackType: MELEE,
                armor: 10,
                amountAlive: 100,
                maxHp: 1_000,
            });
            const statusResistance = new Spell({
                spellProperties: getSpellConfig("System", "Amulet of Resolve", NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            });
            statusResistance.setPower(25);
            target.applyBuff(statusResistance);
            if (options.giantsMaulPower !== undefined) {
                const giantsMaul = new Spell({
                    spellProperties: getSpellConfig("System", "Giants Maul", NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                giantsMaul.setPower(options.giantsMaulPower);
                shooter.applyBuff(giantsMaul);
            }
            if (options.dualStrikeCharmPower !== undefined) {
                const dualStrikeCharm = new Spell({
                    spellProperties: getSpellConfig("System", "Dual Strike Charm", NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                dualStrikeCharm.setPower(options.dualStrikeCharmPower);
                shooter.applyBuff(dualStrikeCharm);
            }
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 7 });
            shooter.refreshPossibleAttackTypes(true);
            const context = ctxFor(c, true);
            const candidate = ofKind(enumerateCandidates(shooter, context, endTurn(shooter)).candidates, "shot").find(
                ({ targetId }) => targetId === target.getId(),
            );
            expect(candidate).toBeDefined();
            const estimated = candidate!.shotFeatures!.primaryTargetDamage;
            const hpBefore = target.getCumulativeHp();
            const engine = startActionEngine(c, shooter, context);
            expect(candidate!.actions.every((action) => engine.apply(action).completed)).toBe(true);
            return { estimated, applied: hpBefore - target.getCumulativeHp() };
        };

        // Base deterministic damage is 50. Through Shot is now stack-INDEPENDENT, so a stack-power-1 shooter
        // keeps the full 100% (previously diluted to 20%); the target's 25% physical-AOE resistance floors
        // 50 -> 37. Giant's Maul 50% applies before resistance: 50 -> 75 -> 56. In every case the AI's
        // estimate must equal the engine's applied damage.
        expect(run()).toEqual({ estimated: 37, applied: 37 });
        expect(run({ giantsMaulPower: 50 })).toEqual({ estimated: 56, applied: 56 });
        // Crafted Double Shot's SECOND line volley is still stack-scaled (20% of the first at stack 1), so it
        // adds 7 after resistance (37 -> 44). Dual Strike Charm raises that second impact, taking it to 48.
        expect(run({ secondShot: "Crafted Double Shot" })).toEqual({ estimated: 44, applied: 44 });
        expect(
            run({
                secondShot: "Crafted Double Shot",
                dualStrikeCharmPower: 50,
            }),
        ).toEqual({ estimated: 48, applied: 48 });
    });

    it("shots: Cowardice rejects the stronger resolved primary, leaves a legal lower-HP target, and does not enrich the invalid incumbent", () => {
        const c = createCombatTestContext();
        const beholder = createTestUnit({
            team: LEFT,
            name: "Beholder-like shooter",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
            maxHp: 10,
        });
        const stronger = createTestUnit({
            team: RIGHT,
            name: "Cowardice-blocked stack",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 10,
        });
        const weaker = createTestUnit({
            team: RIGHT,
            name: "Cowardice-legal stack",
            attackType: MELEE,
            amountAlive: 3,
            maxHp: 10,
        });
        placeUnit(c.grid, c.unitsHolder, beholder, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, stronger, { x: 10, y: 3 });
        placeUnit(c.grid, c.unitsHolder, weaker, { x: 10, y: 11 });
        beholder.refreshPossibleAttackTypes(true);
        const context = ctxFor(c, true);
        const unrestricted = ofKind(enumerateCandidates(beholder, context, endTurn(beholder)).candidates, "shot");
        const invalidIncumbent = unrestricted.find((candidate) => candidate.targetId === stronger.getId());
        expect(invalidIncumbent).toBeDefined();

        beholder.applyDebuff(new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }));
        const candidates = enumerateCandidates(beholder, context, invalidIncumbent!.actions).candidates;
        const anchor = candidates[0];
        const shots = ofKind(candidates, "shot");
        expect(anchor.actions).toBe(invalidIncumbent!.actions);
        expect(anchor.targetId).toBeUndefined();
        expect(anchor.shotFeatures).toBeUndefined();
        expect(anchor.features.expectedDamage).toBe(0);
        expect(shots.some((candidate) => candidate.targetId === stronger.getId())).toBe(false);
        const legal = shots.find((candidate) => candidate.targetId === weaker.getId());
        expect(legal).toBeDefined();

        const engine = startActionEngine(c, beholder, context);
        expect(legal!.actions.every((action) => engine.apply(action).completed)).toBe(true);
    });

    it("shots: Through Shot remains legal against a stronger primary while the attacker has Cowardice", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Cowardly line shooter",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
            maxHp: 10,
            abilities: ["Through Shot"],
        });
        const stronger = createTestUnit({
            team: RIGHT,
            name: "Stronger line target",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 10,
        });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, stronger, { x: 10, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        shooter.applyDebuff(new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }));
        expect(shooter.getCumulativeHp()).toBeLessThan(stronger.getCumulativeHp());

        const context = ctxFor(c, true);
        const shot = ofKind(enumerateCandidates(shooter, context, endTurn(shooter)).candidates, "shot").find(
            (candidate) => candidate.targetId === stronger.getId(),
        );
        expect(shot).toBeDefined();
        const engine = startActionEngine(c, shooter, context);
        expect(shot!.actions.every((action) => engine.apply(action).completed)).toBe(true);
    });

    it("shots: a live forced target excludes other resolved primaries, while a dead forced target releases them", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Aggr-constrained shooter",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
        });
        const forced = createTestUnit({ team: RIGHT, name: "Forced", attackType: MELEE });
        const other = createTestUnit({ team: RIGHT, name: "Other", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, forced, { x: 10, y: 3 });
        placeUnit(c.grid, c.unitsHolder, other, { x: 10, y: 11 });
        shooter.refreshPossibleAttackTypes(true);
        shooter.setTarget(forced.getId());
        const context = ctxFor(c);

        const constrained = ofKind(enumerateCandidates(shooter, context, endTurn(shooter)).candidates, "shot");
        expect(constrained.some((candidate) => candidate.targetId === forced.getId())).toBe(true);
        expect(constrained.some((candidate) => candidate.targetId === other.getId())).toBe(false);

        forced.applyDamage(forced.getCumulativeHp(), 0, new SceneLogMock());
        const released = ofKind(enumerateCandidates(shooter, context, endTurn(shooter)).candidates, "shot");
        expect(released.some((candidate) => candidate.targetId === other.getId())).toBe(true);
    });

    it("move-shots: default-off enumeration is unchanged; opt-in emits at most two exact legal composites", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Advancing archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 3,
            initiative: 3,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 5,
        });
        const target = createTestUnit({
            team: RIGHT,
            name: "Distant target",
            attackType: MELEE,
            initiative: 1,
            amountAlive: 20,
            maxHp: 20,
        });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        const context = ctxFor(c, true);
        const incumbent = endTurn(shooter);
        const baseline = enumerateCandidates(shooter, context, incumbent).candidates;
        const explicitOff = enumerateCandidates(shooter, context, incumbent, {
            maxMoveShotComposites: 0,
        }).candidates;
        const hasMoveAndShot = (candidate: IEnumeratedCandidate): boolean =>
            candidate.actions.some((action) => action.type === "move_unit") &&
            candidate.actions.some((action) => action.type === "range_attack");

        expect(explicitOff).toEqual(baseline);
        expect(baseline.some(hasMoveAndShot)).toBe(false);

        const discoveryWithOpenLine = enumerateCandidates(shooter, context, incumbent, {
            maxMoveShotComposites: 2,
            discoverMoveShotTargetsAfterMove: true,
        });
        expect(discoveryWithOpenLine.candidates).toEqual(baseline);
        expect(discoveryWithOpenLine.candidates.some(hasMoveAndShot)).toBe(false);

        const enabled = enumerateCandidates(shooter, context, incumbent, {
            maxMoveShotComposites: 99,
        });
        const composites = enabled.candidates.filter(hasMoveAndShot);
        expect(composites.length).toBeGreaterThan(0);
        expect(composites.length).toBeLessThanOrEqual(2);
        expect(enabled.truncated).toContain("shot");

        const stationary = ofKind(enabled.candidates, "shot").find(
            (candidate) =>
                candidate.targetId === target.getId() && !candidate.actions.some((a) => a.type === "move_unit"),
        );
        expect(stationary).toBeDefined();
        for (const candidate of composites) {
            expect(candidate.kind).toBe("shot");
            expect(candidate.targetId).toBe(target.getId());
            expect(candidate.features.spendsRangeShot).toBe(1);
            expect(candidate.features.expectedDamage).toBeGreaterThan(stationary!.features.expectedDamage);
            expect(candidate.shotFeatures?.enemyDamage).toBe(candidate.features.expectedDamage);
            expect(candidate.shotFeatures?.friendlyFireDamage).toBe(0);
            expect(candidate.shotFeatures?.primaryTargetDamage).toBe(candidate.features.expectedDamage);

            const move = candidate.actions.find((action) => action.type === "move_unit");
            const shot = candidate.actions.find((action) => action.type === "range_attack");
            if (move?.type !== "move_unit" || shot?.type !== "range_attack" || !move.targetCells) {
                throw new Error("expected a bounded move-then-range-shot candidate");
            }
            const origin = getPositionForCells(testGridSettings, move.targetCells);
            if (!origin || !shot.aimCell || shot.aimSide === undefined) throw new Error("missing exact shot intent");
            const to = getRangeAttackSideCenter(testGridSettings, shot.aimCell, shot.aimSide, origin);
            const evaluation = c.attackHandler.evaluateRangeAttack(
                c.unitsHolder.getAllUnits(),
                shooter,
                origin,
                to,
                false,
                false,
                false,
            );
            expect(evaluation.affectedUnits[0]?.[0]?.getId()).toBe(target.getId());
        }

        const engine = startActionEngine(c, shooter, context);
        expect(composites[0].actions.map((action) => engine.apply(action).completed)).toEqual([true, true]);
    });

    it("move-shots: terminal discovery escapes non-positive Large Caliber splash but keeps a positive stationary shot", () => {
        const fixture = (stationaryFriendlyFire: boolean) => {
            const c = createCombatTestContext();
            const shooter = createTestUnit({
                team: LEFT,
                name: "Large Caliber finisher",
                attackType: RANGE,
                attack: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 5,
                shotDistance: 30,
                amountAlive: 5,
                initiative: 3,
                stackPower: 100,
                abilities: ["Large Caliber"],
            });
            const target = createTestUnit({
                team: RIGHT,
                name: "Large Caliber target",
                attackType: MELEE,
                armor: 20,
                amountAlive: 100,
                maxHp: 1_000,
            });
            const ally = createTestUnit({
                team: LEFT,
                name: "Stationary splash ally",
                attackType: MELEE,
                armor: 10,
                amountAlive: 100,
                maxHp: 1_000,
            });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 7 });
            placeUnit(c.grid, c.unitsHolder, ally, { x: 2, y: 3 });
            shooter.refreshPossibleAttackTypes(true);
            const originalPosition = { ...shooter.getPosition() };

            // Keep real action-engine application and candidate damage calculation, while fixing the ray groups
            // so this regression is independent of raster tie-breaks: the stationary splash loses more allied
            // HP than it removes from the enemy, and every moved origin opens a clean positive ray.
            c.attackHandler.evaluateRangeAttack = (_allUnits, _fromUnit, fromPosition) => {
                const moved = fromPosition.x !== originalPosition.x || fromPosition.y !== originalPosition.y;
                const affected = stationaryFriendlyFire && !moved ? [target, ally] : [target];
                return {
                    rangeAttackDivisors: [1],
                    affectedUnits: [affected],
                    affectedCells: [affected.map((unit) => unit.getBaseCell())],
                };
            };
            return { c, shooter, target, ally, context: ctxFor(c, true) };
        };
        const hasMoveAndShot = (candidate: IEnumeratedCandidate): boolean =>
            candidate.actions.some((action) => action.type === "move_unit") &&
            candidate.actions.some((action) => action.type === "range_attack");
        const options = {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        } as const;

        const counterproductive = fixture(true);
        const counterproductiveSet = enumerateCandidates(
            counterproductive.shooter,
            counterproductive.context,
            endTurn(counterproductive.shooter),
            options,
        );
        const stationary = ofKind(counterproductiveSet.candidates, "shot").find(
            (candidate) => !candidate.actions.some((action) => action.type === "move_unit"),
        );
        const composite = counterproductiveSet.candidates.find(hasMoveAndShot);
        expect(stationary?.features.expectedDamage).toBeLessThan(0);
        expect(stationary?.shotFeatures?.friendlyFireDamage).toBeGreaterThan(
            stationary?.shotFeatures?.enemyDamage ?? 0,
        );
        expect(composite).toBeDefined();
        expect(composite?.features.expectedDamage).toBeGreaterThan(0);
        expect(composite?.shotFeatures?.friendlyFireDamage).toBe(0);
        const targetHpBefore = counterproductive.target.getCumulativeHp();
        const allyHpBefore = counterproductive.ally.getCumulativeHp();
        const counterproductiveEngine = startActionEngine(
            counterproductive.c,
            counterproductive.shooter,
            counterproductive.context,
        );
        expect(composite!.actions.map((action) => counterproductiveEngine.apply(action).completed)).toEqual([
            true,
            true,
        ]);
        expect(counterproductive.target.getCumulativeHp()).toBeLessThan(targetHpBefore);
        expect(counterproductive.ally.getCumulativeHp()).toBe(allyHpBefore);

        const productive = fixture(false);
        const productiveSet = enumerateCandidates(
            productive.shooter,
            productive.context,
            endTurn(productive.shooter),
            options,
        );
        const productiveStationary = ofKind(productiveSet.candidates, "shot").find(
            (candidate) => !candidate.actions.some((action) => action.type === "move_unit"),
        );
        expect(productiveStationary?.features.expectedDamage).toBeGreaterThan(0);
        expect(productiveSet.candidates.some(hasMoveAndShot)).toBe(false);
        const productiveTargetHpBefore = productive.target.getCumulativeHp();
        const productiveEngine = startActionEngine(productive.c, productive.shooter, productive.context);
        expect(productiveStationary!.actions.map((action) => productiveEngine.apply(action).completed)).toEqual([true]);
        expect(productive.target.getCumulativeHp()).toBeLessThan(productiveTargetHpBefore);
    });

    it("move-shots: terminal discovery opens a new BLOCK_CENTER line only when explicitly enabled", () => {
        const fixture = (abilities: string[] = [], initiative = 4) => {
            const c = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
            const shooter = createTestUnit({
                team: LEFT,
                name: "Blocked-line archer",
                attackType: RANGE,
                rangeShots: 8,
                shotDistance: 3,
                initiative,
                damageMin: 10,
                damageMax: 10,
                amountAlive: 5,
                maxHp: 10,
                abilities,
            });
            const target = createTestUnit({
                team: RIGHT,
                name: "Blocked-line target",
                attackType: MELEE,
                amountAlive: 10,
                maxHp: 10,
            });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 4, y: 7 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 9, y: 12 });
            shooter.refreshPossibleAttackTypes(true);
            return { c, shooter, target, context: ctxFor(c, true) };
        };
        const hasMoveAndShot = (candidate: IEnumeratedCandidate): boolean =>
            candidate.actions.some((action) => action.type === "move_unit") &&
            candidate.actions.some((action) => action.type === "range_attack");

        const live = fixture();
        const incumbent = endTurn(live.shooter);
        const baseline = enumerateCandidates(live.shooter, live.context, incumbent);
        const capOnly = enumerateCandidates(live.shooter, live.context, incumbent, {
            maxMoveShotComposites: 1,
        });
        expect(capOnly).toEqual(baseline);
        expect(capOnly.candidates.some(hasMoveAndShot)).toBe(false);
        const rollout = enumerateCandidates(live.shooter, { ...live.context, decisionOrigin: "rollout" }, incumbent, {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        });
        expect(rollout).toEqual(capOnly);

        const discovered = enumerateCandidates(live.shooter, live.context, incumbent, {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        });
        const composite = discovered.candidates.find(hasMoveAndShot);
        expect(composite).toBeDefined();
        expect(composite).toMatchObject({
            kind: "shot",
            targetId: live.target.getId(),
            features: { spendsRangeShot: 1, expectedDamage: 25 },
        });
        expect(composite!.actions).toEqual([
            expect.objectContaining({
                type: "move_unit",
                unitId: live.shooter.getId(),
                // Re-pinned when falloff bands became squares of whole cells: the wider band means one
                // diagonal step already buys the same 1/2 shot the old two-step walk to (4, 9) did, so
                // discovery settles on the cheaper move for the identical expectedDamage of 25.
                path: [
                    { x: 4, y: 7 },
                    { x: 3, y: 8 },
                ],
            }),
            expect.objectContaining({
                type: "range_attack",
                attackerId: live.shooter.getId(),
                targetId: live.target.getId(),
                aimCell: { x: 9, y: 12 },
                aimSide: 0,
            }),
        ]);
        const engine = startActionEngine(live.c, live.shooter, live.context);
        expect(composite!.actions.map((action) => engine.apply(action).completed)).toEqual([true, true]);

        for (const ability of ["Sniper", "Through Shot", "Large Caliber"]) {
            const special = fixture();
            const specialComposite = enumerateCandidates(special.shooter, special.context, endTurn(special.shooter), {
                maxMoveShotComposites: 1,
                discoverMoveShotTargetsAfterMove: true,
            }).candidates.find(hasMoveAndShot);
            expect(specialComposite).toBeDefined();
            special.shooter.grantStolenAbility(ability);
            const enrichedSpecial = enumerateCandidates(special.shooter, special.context, specialComposite!.actions, {
                maxMoveShotComposites: 0,
                enrichIncumbentMetadata: true,
            }).candidates[0];
            expect(enrichedSpecial).toMatchObject({
                kind: "incumbent",
                targetId: specialComposite!.targetId,
                features: {
                    spendsRangeShot: 1,
                },
            });
            expect(enrichedSpecial.features.expectedDamage).toBeGreaterThan(0);
            expect(enrichedSpecial.shotFeatures?.primaryTargetDamage).toBeGreaterThan(0);
            expect(selectV08STargetPressureCandidate(special.shooter, special.c.unitsHolder, [enrichedSpecial])).toBe(
                enrichedSpecial,
            );
            const specialEngine = startActionEngine(special.c, special.shooter, special.context);
            expect(specialComposite!.actions.map((action) => specialEngine.apply(action).completed)).toEqual([
                true,
                true,
            ]);
        }

        const splash = fixture();
        const splashComposite = enumerateCandidates(splash.shooter, splash.context, endTurn(splash.shooter), {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        }).candidates.find(hasMoveAndShot);
        expect(splashComposite).toBeDefined();
        splash.shooter.grantStolenAbility("Large Caliber");
        for (const [index, cell] of [
            { x: 9, y: 13 },
            { x: 10, y: 13 },
            { x: 10, y: 12 },
        ].entries()) {
            const ally = createTestUnit({
                team: LEFT,
                name: `Splash ally ${index}`,
                attackType: MELEE,
                amountAlive: 20,
                maxHp: 20,
            });
            placeUnit(splash.c.grid, splash.c.unitsHolder, ally, cell);
        }
        const splashContext = ctxFor(splash.c, true);
        const enrichedSplash = enumerateCandidates(splash.shooter, splashContext, splashComposite!.actions, {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(enrichedSplash.shotFeatures?.friendlyFireDamage).toBeGreaterThan(
            enrichedSplash.shotFeatures?.enemyDamage ?? 0,
        );
        expect(enrichedSplash.features.expectedDamage).toBeLessThan(0);
        expect(
            selectV08STargetPressureCandidate(splash.shooter, splash.c.unitsHolder, [enrichedSplash]),
        ).toBeUndefined();
        const splashEngine = startActionEngine(splash.c, splash.shooter, splashContext);
        expect(splashComposite!.actions.map((action) => splashEngine.apply(action).completed)).toEqual([true, true]);

        const constrained = fixture();
        const other = createTestUnit({
            team: RIGHT,
            name: "Unforced target",
            attackType: MELEE,
            amountAlive: 1,
            maxHp: 10,
        });
        placeUnit(constrained.c.grid, constrained.c.unitsHolder, other, { x: 9, y: 2 });
        constrained.shooter.setTarget(constrained.target.getId());
        const forced = enumerateCandidates(constrained.shooter, constrained.context, endTurn(constrained.shooter), {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        }).candidates.filter(hasMoveAndShot);
        expect(forced.length).toBeGreaterThan(0);
        expect(
            forced.every((candidate) =>
                candidate.actions.some(
                    (action) => action.type === "range_attack" && action.targetId === constrained.target.getId(),
                ),
            ),
        ).toBe(true);

        constrained.shooter.applyDebuff(
            new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }),
        );
        const cowardly = enumerateCandidates(constrained.shooter, constrained.context, endTurn(constrained.shooter), {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        }).candidates;
        expect(cowardly.some(hasMoveAndShot)).toBe(false);

        const sniper = fixture(["Sniper"]);
        const sniperCapOnly = enumerateCandidates(sniper.shooter, sniper.context, endTurn(sniper.shooter), {
            maxMoveShotComposites: 1,
        });
        expect(sniperCapOnly.candidates.some(hasMoveAndShot)).toBe(false);
        const sniperDiscovered = enumerateCandidates(sniper.shooter, sniper.context, endTurn(sniper.shooter), {
            maxMoveShotComposites: 1,
            discoverMoveShotTargetsAfterMove: true,
        }).candidates.find(hasMoveAndShot);
        expect(sniperDiscovered).toBeDefined();
        const sniperEngine = startActionEngine(sniper.c, sniper.shooter, sniper.context);
        expect(sniperDiscovered!.actions.map((action) => sniperEngine.apply(action).completed)).toEqual([true, true]);

        const withoutWall = fixture();
        withoutWall.target.setAmountAlive(4);
        withoutWall.shooter.applyDebuff(
            new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }),
        );
        const withoutWallComposites = enumerateCandidates(
            withoutWall.shooter,
            withoutWall.context,
            endTurn(withoutWall.shooter),
            {
                maxMoveShotComposites: 2,
                discoverMoveShotTargetsAfterMove: true,
            },
        ).candidates.filter(hasMoveAndShot);
        expect(
            withoutWallComposites.some((candidate) =>
                candidate.actions.some(
                    (action) => action.type === "move_unit" && action.path.some((cell) => cell.x === 4 && cell.y === 8),
                ),
            ),
        ).toBe(true);

        const throughWall = fixture();
        throughWall.target.setAmountAlive(4);
        throughWall.shooter.applyDebuff(
            new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }),
        );
        throughWall.context.fightProperties!.getFireWalls().add({ x: 4, y: 8 });
        const throughWallComposites = enumerateCandidates(
            throughWall.shooter,
            throughWall.context,
            endTurn(throughWall.shooter),
            {
                maxMoveShotComposites: 2,
                discoverMoveShotTargetsAfterMove: true,
            },
        ).candidates.filter(hasMoveAndShot);
        expect(
            throughWallComposites.some((candidate) =>
                candidate.actions.some(
                    (action) => action.type === "move_unit" && action.path.some((cell) => cell.x === 4 && cell.y === 8),
                ),
            ),
        ).toBe(false);
        expect(throughWallComposites.length).toBeGreaterThan(0);
        const fireWallEngine = startActionEngine(throughWall.c, throughWall.shooter, throughWall.context);
        expect(throughWallComposites[0].actions.map((action) => fireWallEngine.apply(action).completed)).toEqual([
            true,
            true,
        ]);

        const projectedDamage = fixture([], 1);
        projectedDamage.target.applyDamage(78, 0, new SceneLogMock());
        expect(projectedDamage.target.getCumulativeHp()).toBe(22);
        for (const cell of getCellsAroundCell(testGridSettings, projectedDamage.shooter.getBaseCell())) {
            projectedDamage.context.fightProperties!.getFireWalls().add(cell);
        }
        const projectedComposite = enumerateCandidates(
            projectedDamage.shooter,
            projectedDamage.context,
            endTurn(projectedDamage.shooter),
            {
                maxMoveShotComposites: 1,
                discoverMoveShotTargetsAfterMove: true,
            },
        ).candidates.find(hasMoveAndShot);
        expect(projectedComposite).toBeDefined();
        expect(projectedComposite).toMatchObject({
            features: { expectedDamage: 20, expectedKill: 0 },
        });
        const enrichedProjected = enumerateCandidates(
            projectedDamage.shooter,
            projectedDamage.context,
            projectedComposite!.actions,
            {
                maxMoveShotComposites: 0,
                enrichIncumbentMetadata: true,
            },
        ).candidates[0];
        expect(enrichedProjected).toMatchObject({
            kind: "incumbent",
            targetId: projectedDamage.target.getId(),
            features: { expectedDamage: 20, expectedKill: 0 },
        });
        const projectedMove = projectedComposite!.actions.find((action) => action.type === "move_unit");
        expect(
            projectedMove?.type === "move_unit" &&
                projectedMove.path.some((cell) => projectedDamage.context.fightProperties!.getFireWalls().has(cell)),
        ).toBe(true);
        const targetHpBefore = projectedDamage.target.getCumulativeHp();
        const projectedDamageEngine = startActionEngine(
            projectedDamage.c,
            projectedDamage.shooter,
            projectedDamage.context,
        );
        expect(projectedComposite!.actions.map((action) => projectedDamageEngine.apply(action).completed)).toEqual([
            true,
            true,
        ]);
        expect(targetHpBefore - projectedDamage.target.getCumulativeHp()).toBe(20);
        expect(projectedDamage.target.getCumulativeHp()).toBe(2);

        const rejectedSuffix = fixture([], 1);
        rejectedSuffix.target.setAmountAlive(4);
        const preWallComposite = enumerateCandidates(
            rejectedSuffix.shooter,
            rejectedSuffix.context,
            endTurn(rejectedSuffix.shooter),
            {
                maxMoveShotComposites: 1,
                discoverMoveShotTargetsAfterMove: true,
            },
        ).candidates.find(hasMoveAndShot);
        expect(preWallComposite).toBeDefined();
        const preWallMove = preWallComposite!.actions.find((action) => action.type === "move_unit");
        if (preWallMove?.type !== "move_unit") throw new Error("expected move-shot incumbent");
        const enteredCell = preWallMove.path.find((cell) => {
            const base = rejectedSuffix.shooter.getBaseCell();
            return cell.x !== base.x || cell.y !== base.y;
        });
        expect(enteredCell).toBeDefined();
        rejectedSuffix.context.fightProperties!.getFireWalls().add(enteredCell!);
        rejectedSuffix.shooter.applyDebuff(
            new Spell({ spellProperties: getSpellConfig("Order", "Cowardice"), amount: 1 }),
        );
        const rejectedAnchor = enumerateCandidates(
            rejectedSuffix.shooter,
            rejectedSuffix.context,
            preWallComposite!.actions,
            {
                maxMoveShotComposites: 0,
                enrichIncumbentMetadata: true,
            },
        ).candidates[0];
        expect(rejectedAnchor).toMatchObject({
            kind: "incumbent",
            features: { expectedDamage: 0, expectedKill: 0 },
        });
        expect(rejectedAnchor.targetId).toBeUndefined();
        expect(rejectedAnchor.shotFeatures).toBeUndefined();
        const rejectedEngine = startActionEngine(rejectedSuffix.c, rejectedSuffix.shooter, rejectedSuffix.context);
        expect(preWallComposite!.actions.map((action) => rejectedEngine.apply(action).completed)).toEqual([
            true,
            false,
        ]);
    });

    for (const special of [
        { ability: "Through Shot", aoe: false },
        { ability: "Large Caliber", aoe: true },
    ] as const) {
        it(`move-shots: ${special.ability} discovery preserves a rear aim through an intercepted primary`, () => {
            const c = createCombatTestContext();
            const shooter = createTestUnit({
                team: LEFT,
                name: `${special.ability} mover`,
                attackType: RANGE,
                attack: 10,
                damageMin: 10,
                damageMax: 10,
                rangeShots: 5,
                shotDistance: 30,
                amountAlive: 5,
                initiative: 3,
                stackPower: 5,
                abilities: [special.ability],
            });
            const ally = createTestUnit({
                team: LEFT,
                name: "Stationary-line blocker",
                attackType: MELEE,
                amountAlive: 100,
                maxHp: 1_000,
            });
            const front = createTestUnit({
                team: RIGHT,
                name: "Resolved front primary",
                attackType: MELEE,
                amountAlive: 100,
                maxHp: 1_000,
            });
            const rear = createTestUnit({
                team: RIGHT,
                name: "Rear aim anchor",
                attackType: MELEE,
                amountAlive: 100,
                maxHp: 1_000,
            });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
            placeUnit(c.grid, c.unitsHolder, ally, { x: 2, y: 3 });
            placeUnit(c.grid, c.unitsHolder, front, { x: 7, y: 7 });
            placeUnit(c.grid, c.unitsHolder, rear, { x: 10, y: 7 });
            shooter.refreshPossibleAttackTypes(true);
            const originalPosition = { ...shooter.getPosition() };
            const rearThreshold = (front.getPosition().x + rear.getPosition().x) / 2;

            // Force a closed stationary line and deterministic post-move interception. This isolates the
            // candidate/action identity contract from raster details: an action aimed at `rear` damages both
            // stacks, while clamping rear's aimCell to `front` (the old targetId bug) damages only front.
            c.attackHandler.evaluateRangeAttack = (_allUnits, _fromUnit, fromPosition, toPosition) => {
                const moved = fromPosition.x !== originalPosition.x || fromPosition.y !== originalPosition.y;
                if (!moved) {
                    return {
                        rangeAttackDivisors: [1],
                        affectedUnits: [[ally]],
                        affectedCells: [[ally.getBaseCell()]],
                    };
                }
                const aimsBehindFront = toPosition.x > rearThreshold;
                const affectedUnits = aimsBehindFront ? (special.aoe ? [[front, rear]] : [[front], [rear]]) : [[front]];
                return {
                    rangeAttackDivisors: affectedUnits.map(() => 1),
                    affectedUnits,
                    affectedCells: affectedUnits.map((group) => group.map((unit) => unit.getBaseCell())),
                };
            };
            const context = ctxFor(c, true);
            const candidates = enumerateCandidates(shooter, context, endTurn(shooter), {
                maxMoveShotComposites: 2,
                discoverMoveShotTargetsAfterMove: true,
            }).candidates;
            const composite = candidates.find((candidate) => {
                const move = candidate.actions.find((action) => action.type === "move_unit");
                const shot = candidate.actions.find((action) => action.type === "range_attack");
                return (
                    move?.type === "move_unit" &&
                    shot?.type === "range_attack" &&
                    candidate.targetId === front.getId() &&
                    shot.targetId === rear.getId() &&
                    shot.aimCell?.x === rear.getBaseCell().x &&
                    shot.aimCell.y === rear.getBaseCell().y
                );
            });
            expect(composite).toBeDefined();
            const frontHpBefore = front.getCumulativeHp();
            const rearHpBefore = rear.getCumulativeHp();
            const engine = startActionEngine(c, shooter, context);
            expect(composite!.actions.map((action) => engine.apply(action).completed)).toEqual([true, true]);
            expect(front.getCumulativeHp()).toBeLessThan(frontHpBefore);
            expect(rear.getCumulativeHp()).toBeLessThan(rearHpBefore);
        });
    }

    it("move-shots: enriches only an exact incumbent at cap zero without adding or reordering challengers", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "a13 advancing archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 3,
            initiative: 3,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 5,
        });
        const target = createTestUnit({
            team: RIGHT,
            name: "a13 pressure target",
            attackType: MELEE,
            initiative: 1,
            amountAlive: 20,
            maxHp: 20,
        });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        const context = ctxFor(c, true);
        const generated = enumerateCandidates(shooter, context, endTurn(shooter), {
            maxMoveShotComposites: 1,
        }).candidates.find(
            (candidate) =>
                candidate.actions.some((action) => action.type === "move_unit") &&
                candidate.actions.some((action) => action.type === "range_attack"),
        );
        expect(generated).toBeDefined();

        const defaultOff = enumerateCandidates(shooter, context, generated!.actions).candidates;
        const explicitOff = enumerateCandidates(shooter, context, generated!.actions, {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: false,
        }).candidates;
        const enriched = enumerateCandidates(shooter, context, generated!.actions, {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: true,
        }).candidates;
        const anchor = enriched[0];

        expect(explicitOff).toEqual(defaultOff);
        expect(anchor.kind).toBe("incumbent");
        expect(anchor.actions).toBe(generated!.actions);
        expect(anchor.targetId).toBe(target.getId());
        expect(anchor.targetCell).toEqual(generated!.targetCell);
        expect(anchor.shotFeatures).toEqual(generated!.shotFeatures);
        expect(anchor.features.expectedDamage).toBe(generated!.features.expectedDamage);
        expect(anchor.features.expectedKill).toBe(generated!.features.expectedKill);
        expect(selectV08STargetPressureCandidate(shooter, c.unitsHolder, [anchor])).toBe(anchor);

        // The opt-in changes metadata on candidate zero only. The cap-zero candidate identities, exact action
        // references, ordering, truncation behavior, and challenger catalog remain the default/off catalog.
        const identity = (candidate: IEnumeratedCandidate): [string, string] => [
            candidate.kind,
            ilActionSignature(candidate.actions),
        ];
        expect(enriched.map(identity)).toEqual(explicitOff.map(identity));
        expect(enriched.map((candidate) => candidate.actions)).toEqual(
            explicitOff.map((candidate) => candidate.actions),
        );
        expect(enriched.slice(1)).toEqual(explicitOff.slice(1));
        expect(
            enriched
                .slice(1)
                .some(
                    (candidate) =>
                        candidate.actions.some((action) => action.type === "move_unit") &&
                        candidate.actions.some((action) => action.type === "range_attack"),
                ),
        ).toBe(false);

        const passive = enumerateCandidates(shooter, context, endTurn(shooter), {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(passive).toEqual({
            kind: "incumbent",
            actions: endTurn(shooter),
            features: expect.objectContaining({ expectedDamage: 0, expectedKill: 0, spendsRangeShot: 0 }),
        });
        expect(passive.targetId).toBeUndefined();
        expect(passive.shotFeatures).toBeUndefined();
    });

    it("move-shots: does not enrich an incumbent whose legal move makes its shot melee-pinned", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Pinned after moving",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            initiative: 3,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 5,
        });
        const pinner = createTestUnit({ team: RIGHT, name: "Destination pinner", attackType: MELEE, initiative: 1 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, pinner, { x: 6, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        const context = ctxFor(c, true);
        const catalog = enumerateCandidates(shooter, context, endTurn(shooter)).candidates;
        const move = ofKind(catalog, "move").find(
            (candidate) => candidate.targetCell?.x === 5 && candidate.targetCell.y === 7,
        );
        const shot = ofKind(catalog, "shot").find((candidate) => candidate.targetId === pinner.getId());
        expect(move).toBeDefined();
        expect(shot).toBeDefined();
        const incumbent = [...move!.actions, ...shot!.actions];

        const anchor = enumerateCandidates(shooter, context, incumbent, {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(anchor.actions).toBe(incumbent);
        expect(anchor.targetId).toBeUndefined();
        expect(anchor.targetCell).toBeUndefined();
        expect(anchor.shotFeatures).toBeUndefined();
        expect(anchor.features).toMatchObject({ spendsRangeShot: 1, expectedDamage: 0, expectedKill: 0 });

        // This is the authoritative failure mode guarded above: movement itself succeeds, then the real attack
        // engine rejects range_attack because the actor now occupies the enemy's melee-aggression band.
        const engine = startActionEngine(c, shooter, context);
        expect(engine.apply(incumbent[0]).completed).toBe(true);
        expect(engine.apply(incumbent[1]).completed).toBe(false);
    });

    it("move-shots: a secondary RANGE selection completes after moving", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Dual-mode archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 3,
            initiative: 3,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 5,
        });
        const target = createTestUnit({
            team: RIGHT,
            name: "Target",
            attackType: MELEE,
            initiative: 1,
            amountAlive: 20,
            maxHp: 20,
        });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        expect(shooter.selectAttackType(MELEE)).toBe(true);
        const context = ctxFor(c, true);
        const composite = enumerateCandidates(shooter, context, endTurn(shooter), {
            maxMoveShotComposites: 1,
        }).candidates.find(
            (candidate) =>
                candidate.actions.some((action) => action.type === "move_unit") &&
                candidate.actions.some((action) => action.type === "range_attack"),
        );
        expect(composite).toBeDefined();
        expect(composite!.actions.map((action) => action.type)).toEqual([
            "move_unit",
            "select_attack_type",
            "range_attack",
        ]);

        const engine = startActionEngine(c, shooter, context);
        expect(composite!.actions.map((action) => engine.apply(action).completed)).toEqual([true, true, true]);
    });

    it("move-shots: a LARGE shooter evaluates and applies its exact legal 2x2 destination footprint", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Large cannon",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 3,
            initiative: 3,
            size: PBTypes.UnitSizeVals.LARGE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 5,
        });
        const target = createTestUnit({
            team: RIGHT,
            name: "Target",
            attackType: MELEE,
            initiative: 1,
            amountAlive: 20,
            maxHp: 20,
        });
        placeLarge(c, shooter, { x: 3, y: 8 });
        placeUnit(c.grid, c.unitsHolder, target, { x: 11, y: 7 });
        shooter.refreshPossibleAttackTypes(true);
        const context = ctxFor(c, true);
        const composite = enumerateCandidates(shooter, context, endTurn(shooter), {
            maxMoveShotComposites: 1,
        }).candidates.find(
            (candidate) =>
                candidate.actions.some((action) => action.type === "move_unit") &&
                candidate.actions.some((action) => action.type === "range_attack"),
        );
        expect(composite).toBeDefined();
        const move = composite!.actions.find((action) => action.type === "move_unit");
        const shot = composite!.actions.find((action) => action.type === "range_attack");
        if (move?.type !== "move_unit" || shot?.type !== "range_attack" || !move.targetCells) {
            throw new Error("expected a LARGE move-shot candidate");
        }
        expect(move.targetCells).toHaveLength(4);
        expect(new Set(move.targetCells.map((cell) => `${cell.x},${cell.y}`)).size).toBe(4);
        const origin = getPositionForCells(testGridSettings, move.targetCells);
        if (!origin || !shot.aimCell || shot.aimSide === undefined) throw new Error("missing LARGE shot origin");
        const to = getRangeAttackSideCenter(testGridSettings, shot.aimCell, shot.aimSide, origin);
        const evaluation = c.attackHandler.evaluateRangeAttack(
            c.unitsHolder.getAllUnits(),
            shooter,
            origin,
            to,
            false,
            false,
            false,
        );
        expect(evaluation.affectedUnits[0]?.[0]?.getId()).toBe(target.getId());

        const reordered = composite!.actions.map((action) =>
            action.type === "move_unit"
                ? { ...action, targetCells: [...(action.targetCells ?? [])].reverse() }
                : action,
        );
        const anchor = enumerateCandidates(shooter, context, reordered, {
            maxMoveShotComposites: 0,
            enrichIncumbentMetadata: true,
        }).candidates[0];
        expect(anchor.actions).toBe(reordered);
        expect(anchor.targetId).toBe(target.getId());
        expect(anchor.targetCell).toEqual(composite!.targetCell);
        expect(anchor.shotFeatures).toEqual(composite!.shotFeatures);
        expect(anchor.features.expectedDamage).toBe(composite!.features.expectedDamage);
        expect(anchor.features.expectedKill).toBe(composite!.features.expectedKill);

        const engine = startActionEngine(c, shooter, context);
        expect(reordered.map((action) => engine.apply(action).completed)).toEqual([true, true]);
        expect(shooter.getCells()).toEqual(expect.arrayContaining(move.targetCells));
    });

    it("move-shots: excludes pinned shooters and special range geometry", () => {
        const enumerateFor = (abilities: string[] = [], pinned = false): IEnumeratedCandidate[] => {
            const c = createCombatTestContext();
            const shooter = createTestUnit({
                team: LEFT,
                name: `Excluded ${abilities[0] ?? "pinned"}`,
                attackType: RANGE,
                rangeShots: 5,
                shotDistance: 3,
                initiative: 3,
                abilities,
            });
            const target = createTestUnit({ team: RIGHT, name: "Target", attackType: MELEE, initiative: 1 });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: 2, y: 7 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 7 });
            if (pinned) {
                const pinner = createTestUnit({ team: RIGHT, name: "Pinner", attackType: MELEE });
                placeUnit(c.grid, c.unitsHolder, pinner, { x: 3, y: 7 });
            }
            shooter.refreshPossibleAttackTypes(!pinned);
            return enumerateCandidates(shooter, ctxFor(c), endTurn(shooter), {
                maxMoveShotComposites: 2,
            }).candidates;
        };
        const composites = (candidates: IEnumeratedCandidate[]): IEnumeratedCandidate[] =>
            candidates.filter(
                (candidate) =>
                    candidate.actions.some((action) => action.type === "move_unit") &&
                    candidate.actions.some((action) => action.type === "range_attack"),
            );

        expect(composites(enumerateFor([], true))).toHaveLength(0);
        for (const ability of ["Sniper", "Through Shot", "Large Caliber", "Area Throw"]) {
            expect(composites(enumerateFor([ability]))).toHaveLength(0);
        }
    });

    it("opt-in shot caps expand to cover every primary target", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LEFT,
            name: "Coverage archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
        });
        const first = createTestUnit({ team: RIGHT, name: "First shot target", attackType: MELEE });
        const second = createTestUnit({ team: RIGHT, name: "Second shot target", attackType: MELEE });
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
            team: LEFT,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 5,
            shotDistance: 30,
            amountAlive: 5,
        });
        const ally = createTestUnit({ team: LEFT, name: "Focus", attackType: MELEE });
        const target = createTestUnit({
            team: RIGHT,
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
        expect(ilCandidateActionEncoding(anchor, LEFT)).toEqual(ilCandidateActionEncoding(generated, LEFT));

        // Candidate 0 keeps the exact action identity and the generator does not emit it again as a challenger.
        const signatures = candidates.map((candidate) => ilActionSignature(candidate.actions));
        expect(new Set(signatures).size).toBe(signatures.length);
        expect(ofKind(candidates, "shot").some((candidate) => candidate.targetId === target.getId())).toBe(false);
    });

    it("shots: exposes friendly-fire damage separately without changing net expected damage", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        const ally = createTestUnit({ team: LEFT, name: "Ally", attackType: MELEE, amountAlive: 20 });
        const target = createTestUnit({ team: RIGHT, name: "Target", attackType: MELEE, amountAlive: 20 });
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
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        const ally = createTestUnit({
            team: LEFT,
            name: "Large ally",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 100,
        });
        const target = createTestUnit({
            team: RIGHT,
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
        const shooter = createTestUnit({ team: LEFT, name: "Pinned", attackType: RANGE, rangeShots: 5 });
        const pinner = createTestUnit({ team: RIGHT, name: "Pinner", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, pinner, { x: 3, y: 4 });
        const { candidates } = enumerateCandidates(shooter, ctxFor(c), endTurn(shooter));
        expect(ofKind(candidates, "shot").length).toBe(0);
        expect(ofKind(candidates, "area_throw").length).toBe(0);
    });

    it("area_throw (Gargantuan): aim cells whose splash reaches enemies, incl. a two-enemy cluster aim", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LEFT, "Nature", "Gargantuan"); // RANGE, size 2, Area Throw + Double Shot
        const e1 = createTestUnit({ team: RIGHT, name: "E1", attackType: MELEE, amountAlive: 5, maxHp: 50 });
        const e2 = createTestUnit({ team: RIGHT, name: "E2", attackType: MELEE, amountAlive: 5, maxHp: 50 });
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
        expect(ilCandidateActionEncoding(anchor, LEFT)).toEqual(ilCandidateActionEncoding(cluster!, LEFT));
        // Gargantuan also gets plain ranged shots (it is a shooter).
        expect(ofKind(candidates, "shot").length).toBeGreaterThan(0);
    });

    it("area_throw: only emits aims whose engine primary hit satisfies a forced target", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        const forced = createTestUnit({ team: RIGHT, name: "Forced", attackType: MELEE, amountAlive: 20 });
        const clusterA = createTestUnit({ team: RIGHT, name: "Cluster A", attackType: MELEE, amountAlive: 20 });
        const clusterB = createTestUnit({ team: RIGHT, name: "Cluster B", attackType: MELEE, amountAlive: 20 });
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
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        const enemyA = createTestUnit({
            team: RIGHT,
            name: "Enemy A",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1,
        });
        const enemyB = createTestUnit({
            team: RIGHT,
            name: "Enemy B",
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1,
        });
        const ally = createTestUnit({ team: LEFT, name: "Interceptor", attackType: MELEE, amountAlive: 1, maxHp: 1 });
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
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        const evasive = {
            team: RIGHT,
            attackType: MELEE,
            amountAlive: 20,
            maxHp: 1_000,
            stackPower: 5,
            abilities: ["Dodge", "Small Specie"],
        };
        const clusterA = createTestUnit({ ...evasive, name: "Cluster A" });
        const clusterB = createTestUnit({ ...evasive, name: "Cluster B" });
        const reliable = createTestUnit({
            team: RIGHT,
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

    it("area_throw: Terrifying Gaze excludes a forbidden engine-primary even when another enemy is splashed", () => {
        const c = createCombatTestContext();
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        const enemyA = createTestUnit({ team: RIGHT, name: "Enemy A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: RIGHT, name: "Enemy B", attackType: MELEE, amountAlive: 20 });
        placeLarge(c, garg, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(c.grid, c.unitsHolder, enemyB, { x: 10, y: 11 });

        const before = ofKind(enumerateCandidates(garg, ctxFor(c), endTurn(garg)).candidates, "area_throw");
        const forbiddenPrimaryThrow = before.find(
            (candidate) => candidate.targetCell?.x === 10 && candidate.targetCell.y === 10,
        );
        expect(forbiddenPrimaryThrow).toBeDefined();
        expect([enemyA.getId(), enemyB.getId()]).toContain(forbiddenPrimaryThrow!.targetId!);
        const otherSplashVictim = forbiddenPrimaryThrow!.targetId === enemyA.getId() ? enemyB.getId() : enemyA.getId();
        expect(otherSplashVictim).not.toBe(forbiddenPrimaryThrow!.targetId);

        garg.setForbiddenTarget(forbiddenPrimaryThrow!.targetId!);
        const after = ofKind(enumerateCandidates(garg, ctxFor(c), endTurn(garg)).candidates, "area_throw");

        expect(after.some((candidate) => candidate.targetCell?.x === 10 && candidate.targetCell.y === 10)).toBe(false);
        expect(after.every((candidate) => candidate.targetId !== forbiddenPrimaryThrow!.targetId)).toBe(true);
    });

    it("AOE damage estimates use the engine's miss, artifact, and physical-resistance modifiers", () => {
        const score = (mutate?: (attacker: Unit, target: Unit) => void): number => {
            const c = createCombatTestContext();
            const garg = makeReal(LEFT, "Nature", "Gargantuan");
            const target = createTestUnit({
                team: RIGHT,
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
        const giveBuff = (
            unit: Unit,
            name: "Amulet of Resolve" | "Broken Aegis" | "Giants Maul",
            power: number,
        ): void => {
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
        const giantsMaul = score((attacker) => giveBuff(attacker, "Giants Maul", 50));

        expect(boarSaliva).toBeLessThan(baseline);
        expect(brokenAegisMiss).toBeLessThan(baseline);
        expect(brokenAegisReduction).toBeLessThan(baseline);
        expect(statusResistance).toBeLessThan(baseline);
        expect(mechanismVulnerability).toBeGreaterThan(baseline);
        expect(giantsMaul).toBeGreaterThan(baseline);
    });

    it("Angel: Resurrection candidates target living allies with dead bodies and price the passive charge", () => {
        const c = createCombatTestContext();
        const angel = makeReal(LEFT, "Life", "Angel"); // MELEE_MAGIC, ability-granted Resurrection
        angel.setStackPower(5); // spell requires caster stack power >= 3
        const hurt = createTestUnit({ team: LEFT, name: "Hurt", attackType: MELEE, amountAlive: 5, maxHp: 10 });
        const fresh = createTestUnit({ team: LEFT, name: "Fresh", attackType: MELEE, amountAlive: 5, maxHp: 10 });
        const enemy = createTestUnit({ team: RIGHT, name: "E", attackType: MELEE });
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
        expect(ilCandidateActionEncoding(anchor, LEFT)).toEqual(ilCandidateActionEncoding(res[0], LEFT));
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
        const valk = makeReal(LEFT, "Life", "Valkyrie");
        valk.setStackPower(5); // Wind Flow requires stack power 5
        const flyer = createTestUnit({ team: RIGHT, name: "Flyer", attackType: MELEE, movementType: FLY });
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
        const harpy = makeReal(LEFT, "Might", "Harpy"); // initiative 7.6 flyer with Castling
        harpy.setStackPower(5); // Castling requires stack power 4
        const near = createTestUnit({ team: RIGHT, name: "Near", attackType: MELEE, amountAlive: 3 });
        const farAway = createTestUnit({ team: RIGHT, name: "FarAway", attackType: MELEE, amountAlive: 3 });
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
        const harpy = makeReal(LEFT, "Might", "Harpy");
        harpy.setStackPower(5);
        const big = makeReal(RIGHT, "Nature", "Gargantuan"); // size 2
        placeUnit(c.grid, c.unitsHolder, harpy, { x: 2, y: 2 });
        placeLarge(c, big, { x: 6, y: 6 });
        const { candidates } = enumerateCandidates(harpy, ctxFor(c), endTurn(harpy));
        expect(ofKind(candidates, "spell").filter((s) => s.spellName === "Castling").length).toBe(0);
    });

    it("Arachna Queen: inherited Castling is not enumerated for a LARGE caster", () => {
        const c = createCombatTestContext();
        const queen = makeReal(LEFT, "Nature", "Arachna Queen");
        queen.grantStolenAbility("Castling", [":Castling"]);
        queen.setStackPower(5);
        const enemy = createTestUnit({ team: RIGHT, name: "Near", attackType: MELEE, amountAlive: 3 });
        placeLarge(c, queen, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 6, y: 6 });

        expect(queen.hasSpellRemaining("Castling")).toBe(true);
        const { candidates } = enumerateCandidates(queen, ctxFor(c), endTurn(queen));
        expect(ofKind(candidates, "spell").filter((candidate) => candidate.spellName === "Castling")).toHaveLength(0);
    });

    it("Battle Mage: Fire Strike respects thrown LOS and its clear candidate completes in the engine", () => {
        const c = createCombatTestContext();
        const mage = makeReal(LEFT, "Life", "Battle Mage");
        mage.setStackPower(5);
        const blocker = createTestUnit({ team: RIGHT, name: "Fireball blocker", attackType: MELEE });
        const blocked = createTestUnit({
            team: RIGHT,
            name: "Blocked target",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 100,
        });
        const clear = createTestUnit({
            team: RIGHT,
            name: "Clear target",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 100,
        });
        placeUnit(c.grid, c.unitsHolder, mage, { x: 2, y: 2 });
        placeUnit(c.grid, c.unitsHolder, blocker, { x: 5, y: 2 });
        placeUnit(c.grid, c.unitsHolder, blocked, { x: 8, y: 2 });
        placeUnit(c.grid, c.unitsHolder, clear, { x: 2, y: 8 });
        const context = ctxFor(c, true);

        const strikes = ofKind(enumerateCandidates(mage, context, endTurn(mage)).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Fire Strike",
        );
        // Not proposed at the unit BEHIND the screen: the engine would intercept the throw onto the screen, so
        // scoring it against the far target would mis-attribute the damage. The screen itself is still offered.
        expect(strikes.some((candidate) => candidate.targetId === blocked.getId())).toBe(false);
        expect(strikes.some((candidate) => candidate.targetId === blocker.getId())).toBe(true);
        const clearStrike = strikes.find((candidate) => candidate.targetId === clear.getId());
        expect(clearStrike).toBeDefined();
        expect(clearStrike!.features.expectedDamage).toBeGreaterThan(0);

        const hpBefore = clear.getCumulativeHp();
        const result = startActionEngine(c, mage, context).apply(clearStrike!.actions[0]);
        expect(result.completed).toBe(true);
        expect(hpBefore - clear.getCumulativeHp()).toBe(clearStrike!.features.expectedDamage);
    });

    it("Battle Mage: Meteorite finds a two-LARGE-unit cluster through their occupied footprint cells", () => {
        const c = createCombatTestContext();
        const mage = makeReal(LEFT, "Life", "Battle Mage");
        mage.setStackPower(5);
        const first = makeReal(RIGHT, "Chaos", "Hydra");
        const second = makeReal(RIGHT, "Chaos", "Black Dragon");
        placeUnit(c.grid, c.unitsHolder, mage, { x: 2, y: 2 });
        // The 2x2 at (8,8) catches (9,8) of the first footprint and (8,9) of the second, while neither
        // base cell lies inside it. Base-cell-only anchor generation misses this unique two-target block.
        placeLarge(c, first, { x: 10, y: 8 });
        placeLarge(c, second, { x: 8, y: 10 });
        const context = ctxFor(c, true);

        const meteorite = ofKind(enumerateCandidates(mage, context, endTurn(mage)).candidates, "spell").find(
            (candidate) => candidate.spellName === "Meteorite",
        );
        expect(meteorite?.targetCell).toEqual({ x: 8, y: 8 });
        expect(meteorite!.features.expectedDamage).toBeGreaterThan(0);

        const firstHpBefore = first.getCumulativeHp();
        const secondHpBefore = second.getCumulativeHp();
        const result = startActionEngine(c, mage, context).apply(meteorite!.actions[0]);
        expect(result.completed).toBe(true);
        expect(firstHpBefore - first.getCumulativeHp() + (secondHpBefore - second.getCumulativeHp())).toBe(
            meteorite!.features.expectedDamage,
        );
    });

    it("Battle Mage: Meteorite does not score an Earth Element target it cannot damage", () => {
        const c = createCombatTestContext();
        const mage = makeReal(LEFT, "Life", "Battle Mage");
        mage.setStackPower(5);
        const gargantuan = makeReal(RIGHT, "Nature", "Gargantuan");
        placeUnit(c.grid, c.unitsHolder, mage, { x: 2, y: 2 });
        placeLarge(c, gargantuan, { x: 8, y: 8 });

        const meteorites = ofKind(enumerateCandidates(mage, ctxFor(c, true), endTurn(mage)).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Meteorite",
        );

        expect(meteorites).toHaveLength(0);
    });

    it("Nightmare: Fire Wall emits an oriented FREE_CELL candidate accepted by the engine", () => {
        const c = createCombatTestContext();
        const nightmare = makeReal(LEFT, "Chaos", "Nightmare");
        nightmare.setStackPower(5);
        const enemy = createTestUnit({ team: RIGHT, name: "Approaching enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, nightmare, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 12, y: 12 });
        const context = ctxFor(c, true);

        const wall = ofKind(enumerateCandidates(nightmare, context, endTurn(nightmare)).candidates, "spell").find(
            (candidate) => candidate.spellName === "Fire Wall",
        );
        expect(wall?.targetCell).toBeDefined();
        const action = wall!.actions[0];
        expect(action.type).toBe("cast_spell");
        if (action.type !== "cast_spell") {
            throw new Error("expected Fire Wall cast");
        }
        expect(action.targetCell).toBeDefined();
        expect(action.targetOrientation).toBeDefined();
        expect(wall!.features.expectedDamage).toBe(0);
        const expectedCells = fireWallCells(action.targetCell!, normalizeFireWallOrientation(action.targetOrientation));

        const result = startActionEngine(c, nightmare, context).apply(action);
        expect(result.completed).toBe(true);
        expect(context.fightProperties!.getFireWalls().cells()).toEqual(expectedCells);
    });

    it("Nightmare: Fire Wall identity keeps a different rotation at the same anchor", () => {
        const c = createCombatTestContext();
        const nightmare = makeReal(LEFT, "Chaos", "Nightmare");
        nightmare.setStackPower(5);
        const enemy = createTestUnit({ team: RIGHT, name: "Approaching enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, nightmare, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 12, y: 12 });
        const context = ctxFor(c, true);

        const generated = ofKind(enumerateCandidates(nightmare, context, endTurn(nightmare)).candidates, "spell").find(
            (candidate) => candidate.spellName === "Fire Wall",
        );
        const generatedAction = generated?.actions[0];
        expect(generatedAction?.type).toBe("cast_spell");
        if (generatedAction?.type !== "cast_spell") {
            throw new Error("expected generated Fire Wall cast");
        }
        const alternateOrientation = normalizeFireWallOrientation(
            normalizeFireWallOrientation(generatedAction.targetOrientation) + 1,
        );
        const incumbent: GameAction[] = [{ ...generatedAction, targetOrientation: alternateOrientation }];

        const challengers = ofKind(enumerateCandidates(nightmare, context, incumbent).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Fire Wall",
        );
        expect(challengers).toHaveLength(1);
        expect(challengers[0].actions[0]).toEqual(generatedAction);
    });

    it("Nightmare: Fire Wall falls back to a shifted legal wall on a field-edge approach", () => {
        const c = createCombatTestContext();
        const nightmare = makeReal(LEFT, "Chaos", "Nightmare");
        nightmare.setStackPower(5);
        const enemy = createTestUnit({ team: RIGHT, name: "Edge approach", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, nightmare, { x: 0, y: 3 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 0, y: 0 });
        const context = ctxFor(c, true);

        const wall = ofKind(enumerateCandidates(nightmare, context, endTurn(nightmare)).candidates, "spell").find(
            (candidate) => candidate.spellName === "Fire Wall",
        );
        const action = wall?.actions[0];
        expect(action?.type).toBe("cast_spell");
        if (action?.type !== "cast_spell" || !action.targetCell) {
            throw new Error("expected edge fallback Fire Wall cast");
        }
        const expectedCells = fireWallCells(action.targetCell, normalizeFireWallOrientation(action.targetOrientation));
        expect(expectedCells.every((cell) => cell.x >= 0 && cell.y >= 0)).toBe(true);
        expect(wall!.features.expectedDamage).toBe(0);

        expect(startActionEngine(c, nightmare, context).apply(action).completed).toBe(true);
        expect(context.fightProperties!.getFireWalls().cells()).toEqual(expectedCells);
    });

    it("Magic Dragon: AI only proposes Ring of Fire with a ring victim, spares its aim, and respects thrown LOS", () => {
        const c = createCombatTestContext();
        const dragon = makeReal(LEFT, "Nature", "Magic Dragon");
        dragon.setStackPower(5);
        const blocker = createTestUnit({ team: LEFT, name: "Ring blocker", attackType: MELEE });
        const blocked = createTestUnit({
            team: RIGHT,
            name: "Blocked target",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 1_000,
        });
        const clear = createTestUnit({
            team: RIGHT,
            name: "Clear target",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 1_000,
        });
        // The engine allows an empty ring, but the AI deliberately omits that zero-value charge spend.
        // Park a second body beside the clear target — it burns friend or foe — so the ring has something
        // to hit and this still tests LINE OF SIGHT.
        const isolated = createTestUnit({
            team: RIGHT,
            name: "Isolated target",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 1_000,
        });
        const ringVictim = createTestUnit({
            team: RIGHT,
            name: "Ring victim",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 1_000,
        });
        const friendlyAim = createTestUnit({
            team: RIGHT,
            name: "Friendly-fire aim",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 1_000,
        });
        const friendlyRingVictim = createTestUnit({
            team: LEFT,
            name: "Friendly ring victim",
            attackType: MELEE,
            amountAlive: 10,
            maxHp: 1_000,
        });
        placeLarge(c, dragon, { x: 3, y: 3 });
        placeUnit(c.grid, c.unitsHolder, blocker, { x: 6, y: 3 });
        placeUnit(c.grid, c.unitsHolder, blocked, { x: 10, y: 3 });
        placeUnit(c.grid, c.unitsHolder, clear, { x: 3, y: 10 });
        placeUnit(c.grid, c.unitsHolder, isolated, { x: 12, y: 8 });
        placeUnit(c.grid, c.unitsHolder, ringVictim, { x: 4, y: 10 });
        placeUnit(c.grid, c.unitsHolder, friendlyAim, { x: 10, y: 10 });
        placeUnit(c.grid, c.unitsHolder, friendlyRingVictim, { x: 11, y: 10 });
        const context = ctxFor(c, true);

        const rings = ofKind(enumerateCandidates(dragon, context, endTurn(dragon)).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Ring of Fire",
        );
        expect(rings.some((candidate) => candidate.targetId === blocked.getId())).toBe(false);
        expect(rings.some((candidate) => candidate.targetId === isolated.getId())).toBe(false);
        const clearRing = rings.find((candidate) => candidate.targetId === clear.getId());
        expect(clearRing).toBeDefined();
        expect(clearRing!.features.expectedDamage).toBeGreaterThan(0);
        expect(
            rings.find((candidate) => candidate.targetId === friendlyAim.getId())!.features.expectedDamage,
        ).toBeLessThan(0);

        const aimedHpBefore = clear.getCumulativeHp();
        const victimHpBefore = ringVictim.getCumulativeHp();
        const result = startActionEngine(c, dragon, context).apply(clearRing!.actions[0]);
        expect(result.completed).toBe(true);
        expect(clear.getCumulativeHp()).toBe(aimedHpBefore);
        expect(victimHpBefore - ringVictim.getCumulativeHp()).toBe(clearRing!.features.expectedDamage);
    });

    it("Magic Dragon: called-down Lightning and Whirlpool remain legal through an occupied LOS", () => {
        for (const spellName of ["Lightning Strike", "Whirlpool"]) {
            const c = createCombatTestContext();
            const dragon = makeReal(LEFT, "Nature", "Magic Dragon");
            dragon.setStackPower(5);
            const blocker = createTestUnit({ team: LEFT, name: `${spellName} blocker`, attackType: MELEE });
            const target = createTestUnit({
                team: RIGHT,
                name: `${spellName} target`,
                attackType: MELEE,
                amountAlive: 10,
                maxHp: 1_000,
            });
            placeLarge(c, dragon, { x: 3, y: 3 });
            placeUnit(c.grid, c.unitsHolder, blocker, { x: 6, y: 3 });
            placeUnit(c.grid, c.unitsHolder, target, { x: 10, y: 3 });
            const context = ctxFor(c, true);

            const candidate = ofKind(enumerateCandidates(dragon, context, endTurn(dragon)).candidates, "spell").find(
                (entry) => entry.spellName === spellName && entry.targetId === target.getId(),
            );
            expect(candidate).toBeDefined();
            const spell = dragon.getSpells().find((entry) => entry.getName() === spellName);
            expect(spell).toBeDefined();
            const chargesBefore = spell!.getAmount();
            const hpBefore = target.getCumulativeHp();
            expect(startActionEngine(c, dragon, context).apply(candidate!.actions[0]).completed).toBe(true);
            expect(spell!.getAmount()).toBe(chargesBefore - 1);
            if (spellName === "Lightning Strike") {
                expect(target.getCumulativeHp()).toBeLessThan(hpBefore);
                expect(target.hasDebuffActive("Whirlpool")).toBe(false);
            } else {
                expect(target.getCumulativeHp()).toBe(hpBefore);
                expect(target.hasDebuffActive("Whirlpool")).toBe(true);
                expect(target.canMove()).toBe(false);
            }
        }
    });

    it("Magic Dragon: Meteor Shower finds a two-LARGE-unit cluster through their occupied footprint cells", () => {
        const c = createCombatTestContext();
        const dragon = makeReal(LEFT, "Nature", "Magic Dragon");
        dragon.setStackPower(5);
        // Meteor Shower is Earth magic, so neither target may be an Earth Element: the test needs HP loss to
        // prove that both non-base footprint cells were actually caught.
        const first = makeReal(RIGHT, "Chaos", "Black Dragon");
        const second = makeReal(RIGHT, "Chaos", "Hydra");
        placeLarge(c, dragon, { x: 3, y: 3 });
        // The 3x3 centered at (8,8) catches non-base footprint cells of both large targets. Its centre is
        // two cells away from either base on one axis, outside the old base-seeded offset set.
        placeLarge(c, first, { x: 10, y: 7 });
        placeLarge(c, second, { x: 7, y: 10 });
        const context = ctxFor(c, true);

        const shower = ofKind(enumerateCandidates(dragon, context, endTurn(dragon)).candidates, "spell").find(
            (candidate) => candidate.spellName === "Meteor Shower",
        );
        expect(shower?.targetCell).toEqual({ x: 8, y: 8 });
        expect(shower!.features.expectedDamage).toBeGreaterThan(0);

        const firstHpBefore = first.getCumulativeHp();
        const secondHpBefore = second.getCumulativeHp();
        const result = startActionEngine(c, dragon, context).apply(shower!.actions[0]);
        expect(result.completed).toBe(true);
        expect(first.getCumulativeHp()).toBeLessThan(firstHpBefore);
        expect(second.getCumulativeHp()).toBeLessThan(secondHpBefore);
    });

    it("Blacksmith: Craft enumerates useful in-grid 2x2 ally areas and the engine accepts one", () => {
        const c = createCombatTestContext();
        const blacksmith = makeReal(LEFT, "Life", "Blacksmith");
        blacksmith.setStackPower(5);
        const ally = createTestUnit({ team: LEFT, name: "Craft target", attackType: MELEE });
        const enemy = createTestUnit({ team: RIGHT, name: "Enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, blacksmith, { x: 4, y: 4 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 5, y: 4 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 12, y: 12 });
        const context = ctxFor(c, true);

        const craft = ofKind(enumerateCandidates(blacksmith, context, endTurn(blacksmith)).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Craft",
        );
        // Stable x/y scan keeps one representative for: Blacksmith only, both units, and ally only.
        expect(craft.map(({ targetCell }) => targetCell)).toEqual([
            { x: 3, y: 3 },
            { x: 4, y: 3 },
            { x: 5, y: 3 },
        ]);
        expect(craft.every((candidate) => candidate.targetCell !== undefined)).toBe(true);
        expect(
            craft.every(
                ({ targetCell }) =>
                    targetCell!.x >= 0 &&
                    targetCell!.x + 1 < testGridSettings.getGridSize() &&
                    targetCell!.y >= 0 &&
                    targetCell!.y + 1 < testGridSettings.getGridSize(),
            ),
        ).toBe(true);

        const coveringBoth = craft.find(({ targetCell }) => targetCell?.x === 4 && targetCell.y === 3);
        expect(coveringBoth).toBeDefined();
        const engine = startActionEngine(c, blacksmith, context);
        expect(coveringBoth!.actions.map((action) => engine.apply(action).completed)).toEqual([true]);
    });

    it("Trent: Vine Throw excludes blocked targets and emits an engine-accepted clear cast", () => {
        const c = createCombatTestContext();
        const trent = makeReal(LEFT, "Nature", "Trent");
        trent.setStackPower(5);
        // An ENEMY screen: friendly bodies are transparent to a throw, so a LEFT blocker would prove nothing.
        const blocker = createTestUnit({ team: RIGHT, name: "Blocker", attackType: MELEE });
        const blocked = createTestUnit({ team: RIGHT, name: "Blocked target", attackType: MELEE });
        const clear = createTestUnit({ team: RIGHT, name: "Clear target", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, trent, { x: 2, y: 2 });
        placeUnit(c.grid, c.unitsHolder, blocker, { x: 5, y: 2 });
        placeUnit(c.grid, c.unitsHolder, blocked, { x: 8, y: 2 });
        placeUnit(c.grid, c.unitsHolder, clear, { x: 2, y: 8 });
        const context = ctxFor(c, true);

        const vines = ofKind(enumerateCandidates(trent, context, endTurn(trent)).candidates, "spell").filter(
            (candidate) => candidate.spellName === "Vine Throw",
        );
        expect(vines.some((candidate) => candidate.targetId === blocked.getId())).toBe(false);
        const clearCast = vines.find((candidate) => candidate.targetId === clear.getId());
        expect(clearCast).toBeDefined();

        const engine = startActionEngine(c, trent, context);
        expect(clearCast!.actions.map((action) => engine.apply(action).completed)).toEqual([true]);
        expect(context.fightProperties!.getVines().size()).toBeGreaterThan(0);
    });

    // The friend/foe asymmetry is easy to get wrong in the gate and invisible in play until the AI starts
    // proposing throws the engine refuses (or refusing ones it would accept), so pin both spells at once.
    it("blocks a throw on a FRIENDLY body only for the spells the engine blocks", () => {
        const build = (casterFaction: string, casterName: string, spellName: string) => {
            const c = createCombatTestContext();
            const caster = makeReal(LEFT, casterFaction, casterName);
            caster.setStackPower(5);
            const friend = createTestUnit({ team: LEFT, name: "Friendly screen", attackType: MELEE });
            const behind = createTestUnit({ team: RIGHT, name: "Behind the screen", attackType: MELEE });
            placeUnit(c.grid, c.unitsHolder, caster, { x: 2, y: 2 });
            placeUnit(c.grid, c.unitsHolder, friend, { x: 5, y: 2 });
            placeUnit(c.grid, c.unitsHolder, behind, { x: 8, y: 2 });
            const proposed = ofKind(
                enumerateCandidates(caster, ctxFor(c, true), endTurn(caster)).candidates,
                "spell",
            ).filter((candidate) => candidate.spellName === spellName);
            return proposed.some((candidate) => candidate.targetId === behind.getId());
        };

        // Fire Strike arcs over its own troops, so the enemy behind them is still a live target...
        expect(build("Life", "Battle Mage", "Fire Strike")).toBe(true);
        // ...while a vine has to travel along the ground, and any body in the lane stops it.
        expect(build("Nature", "Trent", "Vine Throw")).toBe(false);
    });

    it("dedupes candidates identical to the incumbent (no double-scored actions)", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({ team: LEFT, name: "U", attackType: MELEE, initiative: 2, amountAlive: 3 });
        const enemy = createTestUnit({ team: RIGHT, name: "E", attackType: MELEE, amountAlive: 3 });
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
        const unit = createTestUnit({ team: LEFT, name: "U", attackType: MELEE, initiative: 3, amountAlive: 4 });
        const e1 = createTestUnit({ team: RIGHT, name: "E1", attackType: MELEE, amountAlive: 4 });
        const e2 = createTestUnit({ team: RIGHT, name: "E2", attackType: MELEE, amountAlive: 4 });
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
        const garg = makeReal(LEFT, "Nature", "Gargantuan");
        placeLarge(c, garg, { x: 3, y: 3 });
        movers.push(garg);
        for (let i = 0; i < 4; i += 1) {
            const m = createTestUnit({ team: LEFT, name: `M${i}`, attackType: MELEE, initiative: 4, amountAlive: 5 });
            placeUnit(c.grid, c.unitsHolder, m, { x: 5 + i * 2, y: 4 });
            movers.push(m);
        }
        const shooter = createTestUnit({ team: LEFT, name: "S", attackType: RANGE, rangeShots: 8, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 13, y: 3 });
        movers.push(shooter);
        for (let i = 0; i < 6; i += 1) {
            const e = createTestUnit({ team: RIGHT, name: `E${i}`, attackType: MELEE, initiative: 4, amountAlive: 5 });
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
