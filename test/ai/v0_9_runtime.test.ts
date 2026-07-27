import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
    AI_VERSIONS,
    DEFAULT_AI_VERSION,
    LATEST_AI_VERSION,
    V09_FEATURE_SCHEMA,
    V09_FEATURE_SCHEMA_SHA256,
    V09_INPUT_FEATURE_NAMES,
    V09_EMPTY_FAILURES_SHA256,
    V09_MODEL_ARTIFACT,
    V09_MODEL_PROMOTED,
    V09_QUALIFICATION_RECEIPT_SCHEMA,
    enumerateCandidates,
    scoreV09FixedPoint,
    serializeV09QualificationReceiptPayload,
    validateV09ModelArtifact,
    v09CandidateFeatureVector,
    v09RangeObservation,
    type IAIPolicyEvent,
    type IDecisionContext,
    type IEnumeratedCandidate,
    type IV09ModelArtifact,
    type IV09QualificationReceipt,
} from "../../src/ai";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import {
    StrategyV0_9,
    buildV09HardGuardSummary,
    commitV09TargetMemoryOverride,
    createV09OfflineResearchStrategy,
    selectV09RankedCandidate,
    v09CandidatePassesHardGuards,
} from "../../src/ai/versions/v0_9";
import { captureAITargetMemory, recordAITargetMemory } from "../../src/ai/ai";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

const features = {
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 0,
    hourglassSpent: 0 as const,
    spendsRangeShot: 0 as const,
    spendsSpellCharge: 0 as const,
    burnsResurrectionCharge: 0 as const,
    expectedDamage: 0,
    expectedKill: 0 as const,
};

const trainedArtifact = (weights: readonly number[], scaleShift = 8): IV09ModelArtifact => ({
    ...V09_MODEL_ARTIFACT,
    status: "trained",
    promoted: false,
    modelId: "v0.9-test-model",
    modelSha256: "a".repeat(64),
    source: {
        commonCommit: "abcdef1",
        rulesSha256: "b".repeat(64),
        rosterSha256: "c".repeat(64),
        trainingRunId: "test-run",
    },
    layers: [
        {
            inputSize: V09_INPUT_FEATURE_NAMES.length,
            outputSize: 1,
            activation: "linear",
            scaleShift,
            weights,
            biases: [0],
        },
    ],
    notes: "Synthetic unit-test artifact; never exported or promoted.",
});

describe("v0.9 fixed-point runtime", () => {
    test("registers the inert candidate without changing the latest or default v0.8", () => {
        expect(AI_VERSIONS).toContain("v0.9");
        expect(LATEST_AI_VERSION).toBe("v0.8");
        expect(DEFAULT_AI_VERSION).toBe("v0.8");
        expect(V09_MODEL_PROMOTED).toBe(false);
        expect(V09_MODEL_ARTIFACT.status).toBe("anchor_only");
        expect(V09_MODEL_ARTIFACT.modelSha256).toBeNull();
        expect(V09_MODEL_ARTIFACT.notes).toContain("UNTRAINED ANCHOR ONLY");
        expect(validateV09ModelArtifact(V09_MODEL_ARTIFACT)).toEqual([]);
    });

    test("freezes the exact 166-value IL-v4 feature contract and its schema hash", () => {
        expect(V09_INPUT_FEATURE_NAMES).toHaveLength(166);
        expect(new Set(V09_INPUT_FEATURE_NAMES).size).toBe(166);
        const hash = createHash("sha256")
            .update(JSON.stringify({ schema: V09_FEATURE_SCHEMA, inputFeatureNames: V09_INPUT_FEATURE_NAMES }))
            .digest("hex");
        expect(hash).toBe(V09_FEATURE_SCHEMA_SHA256);
    });

    test("extracts a finite 166-value vector for every candidate in a live decision", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LOWER, name: "Feature Actor", attackType: MELEE });
        const ally = createTestUnit({ team: LOWER, name: "Feature Screen", attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, name: "Feature Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 3, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 8 });
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties: FightStateManager.getInstance().getFightProperties(),
        };
        const anchor = new StrategyV0_8().decideTurn(actor, context);
        const candidates = enumerateCandidates(actor, context, anchor, {
            maxMoveDestinations: 8,
            maxMeleePairs: 16,
            maxShotAims: 16,
            maxAreaThrowCells: 8,
            enrichIncumbentMetadata: true,
        }).candidates;

        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) {
            const vector = v09CandidateFeatureVector(candidate, actor, context, candidates);
            expect(vector).toHaveLength(166);
            expect(vector.every(Number.isFinite)).toBe(true);
        }
    });

    test("executes signed int8/int32 dense math with deterministic half-away rounding", () => {
        const weights = Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(0);
        weights[0] = 2;
        const artifact = trainedArtifact(weights);
        expect(validateV09ModelArtifact(artifact)).toEqual([]);
        const positive = Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(0);
        positive[0] = 1.5;
        const negative = Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(0);
        negative[0] = -1.5;
        expect(scoreV09FixedPoint(artifact, positive)).toBe(3);
        expect(scoreV09FixedPoint(artifact, negative)).toBe(-3);
    });

    test("accepts the exact signed-int32 accumulator boundary and rejects one unit beyond it", () => {
        const weights = Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(127);
        const artifact = trainedArtifact(weights);
        const productBound = V09_INPUT_FEATURE_NAMES.length * 32767 * 127;
        const boundaryBias = 0x7fffffff - productBound;
        const boundary: IV09ModelArtifact = {
            ...artifact,
            layers: [{ ...artifact.layers[0], biases: [boundaryBias] }],
        };
        const overflow: IV09ModelArtifact = {
            ...artifact,
            layers: [{ ...artifact.layers[0], biases: [boundaryBias + 1] }],
        };
        expect(validateV09ModelArtifact(boundary)).toEqual([]);
        expect(validateV09ModelArtifact(overflow)).toContain("layers[0].row[0] can exceed signed int32 accumulation");
    });

    test("requires a source- and model-bound 48k+48k qualification receipt for promotion", () => {
        const research = trainedArtifact(Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(0));
        expect(validateV09ModelArtifact({ ...research, promoted: true })).toContain(
            "promotion and qualification receipt must transition together",
        );
        const promoted: IV09ModelArtifact = {
            ...research,
            promoted: true,
            qualification: {
                schema: V09_QUALIFICATION_RECEIPT_SCHEMA,
                qualificationSummarySchema: "hoc.ai.v0_9_qualification.v2",
                armageddonMetric: "reached_armageddon_lap",
                summarySha256: "d".repeat(64),
                journalSha256: "e".repeat(64),
                manifestSha256: "f".repeat(64),
                seedLedgerSha256: "1".repeat(64),
                researchArtifactSha256: "2".repeat(64),
                modelSha256: research.modelSha256!,
                modelId: research.modelId,
                trainingRunId: research.source.trainingRunId!,
                commonCommit: research.source.commonCommit!,
                rulesSha256: research.source.rulesSha256!,
                rosterSha256: research.source.rosterSha256!,
                runFingerprint: "3".repeat(64),
                combinedGames: 96_000,
                confirmationGames: 48_000,
                qualificationGames: 48_000,
                failuresSha256: V09_EMPTY_FAILURES_SHA256,
                qualifiedAt: "2026-07-27T00:00:00.000Z",
                receiptSha256: "4".repeat(64),
            },
        };
        expect(validateV09ModelArtifact(promoted)).toEqual([]);
        expect(JSON.parse(serializeV09QualificationReceiptPayload(promoted.qualification!))).toMatchObject({
            schema: "hoc.ai.v0_9_qualification_receipt.v2",
            qualificationSummarySchema: "hoc.ai.v0_9_qualification.v2",
            armageddonMetric: "reached_armageddon_lap",
        });
        expect(
            validateV09ModelArtifact({
                ...promoted,
                qualification: { ...promoted.qualification!, qualificationGames: 47_999 as 48_000 },
            }),
        ).toContain("qualification must bind the exact 48k+48k promotion sample");
        expect(
            validateV09ModelArtifact({
                ...promoted,
                qualification: {
                    ...promoted.qualification!,
                    schema: "hoc.ai.v0_9_qualification_receipt.v1" as typeof V09_QUALIFICATION_RECEIPT_SCHEMA,
                },
            }),
        ).toContain(`qualification.schema must be ${V09_QUALIFICATION_RECEIPT_SCHEMA}`);
        expect(
            validateV09ModelArtifact({
                ...promoted,
                qualification: {
                    ...promoted.qualification!,
                    qualificationSummarySchema: undefined,
                } as unknown as IV09QualificationReceipt,
            }),
        ).toContain("qualification must bind the v2 qualification summary");
        expect(
            validateV09ModelArtifact({
                ...promoted,
                qualification: {
                    ...promoted.qualification!,
                    armageddonMetric: "decided_by_armageddon_damage",
                } as unknown as IV09QualificationReceipt,
            }),
        ).toContain("qualification must bind reached-Armageddon-lap semantics");
    });

    test("keeps candidate zero on ties, sub-margin gains and guarded high scores", () => {
        expect(selectV09RankedCandidate([0, 5, 5], [true, true, true], 5)).toEqual({
            index: 1,
            fallbackReason: null,
        });
        expect(selectV09RankedCandidate([0, 4], [true, true], 5)).toEqual({
            index: 0,
            fallbackReason: "below_margin",
        });
        expect(selectV09RankedCandidate([0, 9], [true, false], 5)).toEqual({
            index: 0,
            fallbackReason: "hard_guard",
        });
        expect(selectV09RankedCandidate([10, 0], [false, true], 5)).toEqual({
            index: 1,
            fallbackReason: null,
        });
        expect(selectV09RankedCandidate([10, 0], [false, false], 5)).toEqual({
            index: 0,
            fallbackReason: "no_safe_candidate",
        });
    });

    test("a learned override discards anchor focus memory and records only its executed target", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LOWER, name: "Memory Actor", attackType: MELEE });
        const previous = createTestUnit({ team: UPPER, name: "Previous", attackType: MELEE });
        const abandoned = createTestUnit({ team: UPPER, name: "Abandoned", attackType: MELEE });
        const selected = createTestUnit({ team: UPPER, name: "Selected", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, previous, { x: 8, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, abandoned, { x: 9, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, selected, { x: 8, y: 9 });
        recordAITargetMemory(combat.unitsHolder, actor.getId(), previous.getId());
        const beforeAnchor = captureAITargetMemory(combat.unitsHolder);
        recordAITargetMemory(combat.unitsHolder, actor.getId(), abandoned.getId());

        commitV09TargetMemoryOverride(combat.unitsHolder, actor.getId(), beforeAnchor, [
            {
                type: "melee_attack",
                attackerId: actor.getId(),
                targetId: selected.getId(),
                attackFrom: actor.getBaseCell(),
            },
        ]);

        expect(captureAITargetMemory(combat.unitsHolder).get(actor.getId())).toBe(selected.getId());
    });

    test("blocks luck shield and mountain challengers while a productive move exists", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LOWER, name: "Actor", attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 9, y: 9 });
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
        };
        const anchor: IEnumeratedCandidate = {
            kind: "incumbent",
            actions: [{ type: "move_unit", unitId: actor.getId(), path: [{ x: 3, y: 3 }] }],
            features,
        };
        const move: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: actor.getId(), path: [{ x: 3, y: 2 }] }],
            targetCell: { x: 3, y: 2 },
            features,
        };
        const shield: IEnumeratedCandidate = {
            kind: "defend",
            actions: [{ type: "defend_turn", unitId: actor.getId() }],
            features: { ...features, moraleDelta: -2, luckDelta: 3 },
        };
        const mountain: IEnumeratedCandidate = {
            kind: "mine",
            actions: [
                {
                    type: "obstacle_attack",
                    attackerId: actor.getId(),
                    targetPosition: { x: 4, y: 4 },
                    attackFrom: { x: 3, y: 3 },
                },
            ],
            features,
        };
        const candidates = [anchor, move, shield, mountain];
        expect(v09CandidatePassesHardGuards(0, anchor, candidates, actor, context)).toBe(true);
        expect(v09CandidatePassesHardGuards(1, move, candidates, actor, context)).toBe(true);
        expect(v09CandidatePassesHardGuards(2, shield, candidates, actor, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(3, mountain, candidates, actor, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(0, shield, [shield, move], actor, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(0, mountain, [mountain, move], actor, context)).toBe(false);
    });

    test("preserves the v0.8 Abomination screen for both protector and ranged ward candidates", () => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({
            team: LOWER,
            name: "Abomination",
            attackType: MELEE,
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const ward = createTestUnit({
            team: LOWER,
            name: "Protected Archer",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 8,
            damageMax: 20,
            amountAlive: 5,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, protector, { x: 5, y: 4 });
        placeUnit(combat.grid, combat.unitsHolder, ward, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 12, y: 12 });
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
        };
        const protectorCharge: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: protector.getId(), path: [{ x: 7, y: 3 }] }],
            targetCell: { x: 7, y: 3 },
            features,
        };
        const wardCharge: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: ward.getId(), path: [{ x: 7, y: 7 }] }],
            targetCell: { x: 7, y: 7 },
            features,
        };

        expect(v09CandidatePassesHardGuards(0, protectorCharge, [protectorCharge], protector, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(0, wardCharge, [wardCharge], ward, context)).toBe(false);
    });

    test("keeps a forced-displacement Abomination hold safe when no catch-up route exists", () => {
        const combat = createCombatTestContext();
        const protector = createTestUnit({
            team: LOWER,
            name: "Abomination",
            attackType: MELEE,
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        const ward = createTestUnit({
            team: LOWER,
            name: "Protected Healer",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 8,
            damageMax: 20,
            amountAlive: 5,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, protector, { x: 1, y: 1 });
        placeUnit(combat.grid, combat.unitsHolder, ward, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 12, y: 12 });
        protector.setWebMovementLocked(true);
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties: FightStateManager.getInstance().getFightProperties(),
        };
        const wait: IEnumeratedCandidate = {
            kind: "incumbent",
            actions: [{ type: "wait_turn", unitId: protector.getId() }],
            features: { ...features, moraleDelta: -3, hourglassSpent: 1 },
        };
        const defend: IEnumeratedCandidate = {
            kind: "defend",
            actions: [{ type: "defend_turn", unitId: protector.getId() }],
            features: { ...features, moraleDelta: -2, luckDelta: 3 },
        };
        const rush: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: protector.getId(), path: [{ x: 0, y: 0 }] }],
            targetCell: { x: 0, y: 0 },
            features,
        };
        const candidates = [wait, defend, rush];
        const summary = buildV09HardGuardSummary(candidates, protector, context);
        const eligible = candidates.map((candidate, index) =>
            v09CandidatePassesHardGuards(index, candidate, candidates, protector, context, summary),
        );

        expect(summary.backlineProtectorIntent?.ward).toBe(ward);
        expect(summary.backlineProtectorHasCatchUpRoute).toBe(false);
        expect(summary.productiveExists).toBe(false);
        expect(eligible).toEqual([true, true, false]);
        expect(selectV09RankedCandidate([10, 5, 20], eligible, 1).fallbackReason).toBe("hard_guard");
    });

    test("rejects a visible declared shot when authoritative trajectory evaluation hits no unit", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            team: LOWER,
            name: "Shooter",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 8,
        });
        const declaredTarget = createTestUnit({ team: UPPER, name: "Declared", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, declaredTarget, { x: 8, y: 2 });
        const noHitAttackHandler = Object.create(combat.attackHandler) as typeof combat.attackHandler;
        noHitAttackHandler.evaluateRangeAttack = () => ({
            affectedUnits: [],
            affectedCells: [],
            rangeAttackDivisors: [],
        });
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: noHitAttackHandler,
        };
        const shot: IEnumeratedCandidate = {
            kind: "shot",
            targetId: declaredTarget.getId(),
            actions: [
                {
                    type: "range_attack",
                    attackerId: shooter.getId(),
                    targetId: declaredTarget.getId(),
                    aimCell: declaredTarget.getBaseCell(),
                    aimSide: 0,
                },
            ],
            features: { ...features, expectedDamage: 1, spendsRangeShot: 1 },
        };

        expect(v09RangeObservation(shooter, context, shot).firstHitTargetId).toBeUndefined();
        expect(v09CandidatePassesHardGuards(0, shot, [shot], shooter, context)).toBe(false);
    });

    test("forces immediate damage over retreat, support, or mere closing in the urgent finish window", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LOWER, name: "Finisher", attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, name: "Last Enemy", attackType: MELEE });
        const forbiddenEnemy = createTestUnit({ team: UPPER, name: "Forbidden Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, forbiddenEnemy, { x: 5, y: 3 });
        actor.setForbiddenTarget(forbiddenEnemy.getId());
        const fightProperties = new FightProperties();
        while (fightProperties.getCurrentLap() < V08_URGENT_FINISH_START_LAP) {
            fightProperties.flipLap();
        }
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };
        const retreat: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: actor.getId(), path: [{ x: 1, y: 2 }] }],
            targetCell: { x: 1, y: 2 },
            features,
        };
        const closer: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: actor.getId(), path: [{ x: 3, y: 2 }] }],
            targetCell: { x: 3, y: 2 },
            features,
        };
        const support: IEnumeratedCandidate = {
            kind: "spell",
            actions: [{ type: "cast_spell", casterId: actor.getId(), spellName: "support" }],
            features,
        };
        const attack: IEnumeratedCandidate = {
            kind: "melee",
            actions: [
                {
                    type: "melee_attack",
                    attackerId: actor.getId(),
                    targetId: enemy.getId(),
                    attackFrom: actor.getBaseCell(),
                },
            ],
            features: { ...features, expectedDamage: 1 },
        };
        const unsafeFakeKill: IEnumeratedCandidate = {
            kind: "melee",
            actions: [
                {
                    type: "melee_attack",
                    attackerId: actor.getId(),
                    targetId: forbiddenEnemy.getId(),
                    attackFrom: actor.getBaseCell(),
                },
            ],
            features: { ...features, expectedDamage: 10, expectedKill: 1 },
        };
        const candidates = [retreat, closer, support, attack, unsafeFakeKill];

        expect(v09CandidatePassesHardGuards(0, retreat, candidates, actor, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(1, closer, candidates, actor, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(2, support, candidates, actor, context)).toBe(false);
        expect(v09CandidatePassesHardGuards(3, attack, candidates, actor, context)).toBe(true);
        expect(v09CandidatePassesHardGuards(4, unsafeFakeKill, candidates, actor, context)).toBe(false);
    });

    test("evaluates research weights offline without forging the promoted runtime state", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LOWER, name: "Research Actor", attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, name: "Research Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 8 });
        const events: IAIPolicyEvent[] = [];
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties: FightStateManager.getInstance().getFightProperties(),
            policyEventObserver: (event) => events.push(event),
        };
        const research = trainedArtifact(Array<number>(V09_INPUT_FEATURE_NAMES.length).fill(0));
        const actions = createV09OfflineResearchStrategy(research).decideTurn(actor, context);
        const decision = events.find((event) => event.kind === "v0.9_decision");

        expect(actions.length).toBeGreaterThan(0);
        expect(research.promoted).toBe(false);
        expect(research.qualification).toBeNull();
        if (decision?.kind === "v0.9_decision") {
            expect(decision.details.candidateCount).toBeGreaterThan(1);
            expect(decision.details.fallbackReason).not.toBe("invalid_artifact");
            expect(decision.details.fallbackReason).not.toBe("unpromoted_model");
        }
        expect(decision).toMatchObject({
            kind: "v0.9_decision",
            details: {
                artifactStatus: "trained",
                modelId: research.modelId,
                modelSha256: research.modelSha256,
                candidateCount: expect.any(Number),
            },
        });
    });

    test("the embedded v0.9 emits one attribution event and returns exact v0.8 actions", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({ team: LOWER, name: "Anchor Actor", attackType: MELEE });
        const enemy = createTestUnit({ team: UPPER, name: "Anchor Enemy", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 8, y: 8 });
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
        };
        const expected = new StrategyV0_8().decideTurn(actor, context);
        const events: IAIPolicyEvent[] = [];
        context.policyEventObserver = (event) => events.push(event);
        const actual = new StrategyV0_9().decideTurn(actor, context);

        expect(actual).toEqual(expected);
        const v09Events = events.filter((event) => event.kind === "v0.9_decision");
        expect(v09Events).toHaveLength(1);
        expect(v09Events[0]).toMatchObject({
            kind: "v0.9_decision",
            details: {
                artifactStatus: "anchor_only",
                selectedCandidateIndex: 0,
                candidateCount: 1,
                fallbackReason: "untrained_anchor",
                circuitBreakerRecommended: false,
            },
        });
    });
});
