import { describe, expect, test } from "bun:test";

import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import type { DecisionPathCatalog, IDecisionPathCatalogStats } from "../../src/ai/decision_path_catalog";
import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import type { GameAction } from "../../src/engine/actions";
import type { GameEvent } from "../../src/engine/events";
import {
    GREEN_TEAM,
    runMatch,
    type IMatchConfig,
    type ITurnExecutionObservation,
    type ITurnRecoveryObservation,
} from "../../src/simulation/battle_engine";
import { liveTwinSetup } from "../../src/simulation/livetwin";
import type { ISearchPassiveProductiveProbe } from "../../src/simulation/search_driver";
import { V08_A13_SEARCH_OVERRIDE_ENV, withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import {
    classifyV08PassiveDefendOpportunity,
    emptyV08PassiveTurnMetrics,
    fingerprintV08PassiveTurnPanelPlan,
    isV08PassiveForceTierProductiveCandidate,
    planV08PassiveTurnPanelGame,
    requiresV08PassiveProductiveProbe,
    runV08PassiveTurnPanelGame,
    summarizeV08PassiveTurnPanel,
    withV08PassiveCandidateEnvironment,
    V08PassiveTurnAuditor,
    V08_PASSIVE_TURN_PANEL_MAPS,
    V08_PASSIVE_TURN_PANEL_SCHEMA,
    type IV08PassiveTurnPanelOptions,
    type IV08PassiveTurnPanelRecord,
} from "../../src/simulation/v0_8_passive_turn_panel";

const OPTIONS: IV08PassiveTurnPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 6,
    baseSeed: 0x1234_5678,
    minCreatureAppearances: 0,
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
};

const PRODUCTION_REGRESSION_OPTIONS: IV08PassiveTurnPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 4_096,
    baseSeed: 2_607_270_813,
    minCreatureAppearances: 250,
    sourceCommit: "ea4b2591bd95056990839226bbb7ba930839d9ab",
    sourceDirty: false,
};

const features = (expectedDamage = 0): IEnumeratedCandidate["features"] => ({
    moraleDelta: 0,
    luckDelta: 0,
    enemiesNotYetActedFrac: 0,
    alliesNotYetActedFrac: 0,
    lap: 1,
    hourglassSpent: 0,
    spendsRangeShot: 0,
    spendsSpellCharge: 0,
    burnsResurrectionCharge: 0,
    expectedDamage,
    expectedKill: 0,
});

const candidate = (
    kind: IEnumeratedCandidate["kind"],
    actions: GameAction[],
    expectedDamage = 0,
): IEnumeratedCandidate => ({
    kind,
    actions,
    features: features(expectedDamage),
});

const noRecovery: ITurnRecoveryObservation = {
    source: "none",
    completed: false,
    events: [],
};

const execution = ({
    unitId = "unit",
    creatureName = "Peasant",
    side = "green",
    strategyVersion = "v0.8",
    raw = [],
    chosen = [],
    completed = chosen,
    rejected = [],
    recoveryAttempts = [],
    events = [],
}: {
    unitId?: string;
    creatureName?: string;
    side?: "green" | "red";
    strategyVersion?: string;
    raw?: GameAction[];
    chosen?: GameAction[];
    completed?: GameAction[];
    rejected?: GameAction[];
    recoveryAttempts?: ITurnRecoveryObservation[];
    events?: GameEvent[];
}): ITurnExecutionObservation => ({
    unitId,
    creatureName,
    side,
    strategyVersion,
    rawIncumbent: raw,
    chosenDecision: chosen,
    strategyActions: [
        ...completed.map((action) => ({ action, completed: true, events: [] })),
        ...rejected.map((action) => ({
            action,
            completed: false,
            rejectionReason: "test rejection",
            events: [],
        })),
    ],
    recoveryAttempts,
    recovery: recoveryAttempts.at(-1) ?? noRecovery,
    events,
});

const move = (unitId: string): GameAction => ({
    type: "move_unit",
    unitId,
    path: [{ x: 1, y: 1 }],
});
const defend = (unitId: string): GameAction => ({ type: "defend_turn", unitId });
const wait = (unitId: string): GameAction => ({ type: "wait_turn", unitId });
const mountain = (unitId: string): GameAction => ({
    type: "obstacle_attack",
    attackerId: unitId,
    targetPosition: { x: 7, y: 7 },
});
const end = (unitId: string): GameAction => ({ type: "end_turn", unitId });

const productiveProbe = (
    unitId: string,
    overrides: Partial<ISearchPassiveProductiveProbe> = {},
): ISearchPassiveProductiveProbe => ({
    unitId,
    lap: 1,
    incumbentKind: "luck_shield",
    selectedKind: "defend",
    retainedPassive: true,
    hasEngineValidProductiveAlternative: false,
    engineValidShortlistedProductiveAlternatives: 0,
    productiveComparisonScope: "search_shortlist",
    bestShortlistedProductiveKind: null,
    incumbentScore: 0.5,
    bestShortlistedProductiveScore: null,
    shortlistedProductiveScoreDelta: null,
    betterShortlistedProductiveAlternative: false,
    scoreComparisonComplete: true,
    evidenceComplete: true,
    productiveTierRequired: true,
    productiveOverrideGate: 0.03,
    strongerRangedPostureWait: false,
    backlineProtectorIntent: false,
    backlineWardIntent: false,
    circuitOpenAtDecision: false,
    circuitWaitArbitration: false,
    decisionMs: 1,
    resolution: "scored",
    ...overrides,
});

const fixtureRecord = (game: number): IV08PassiveTurnPanelRecord => {
    const plan = planV08PassiveTurnPanelGame(OPTIONS, game);
    const candidateRoster = plan.candidateSide === "green" ? plan.greenRoster : plan.redRoster;
    const opponentRoster = plan.candidateSide === "green" ? plan.redRoster : plan.greenRoster;
    const metrics = emptyV08PassiveTurnMetrics();
    metrics.appearances = candidateRoster.length;
    const byCreature: IV08PassiveTurnPanelRecord["byCreature"] = {};
    for (const { creatureName } of candidateRoster) {
        const creatureMetrics = (byCreature[creatureName] ??= emptyV08PassiveTurnMetrics());
        creatureMetrics.appearances += 1;
    }
    const observedCreature = candidateRoster[0]!.creatureName;
    metrics.turns = 1;
    metrics.passiveEvidenceTurns = 1;
    byCreature[observedCreature]!.turns = 1;
    byCreature[observedCreature]!.passiveEvidenceTurns = 1;
    return {
        schema: V08_PASSIVE_TURN_PANEL_SCHEMA,
        sourceCommit: OPTIONS.sourceCommit ?? null,
        sourceDirty: false,
        game,
        pair: plan.pair,
        seed: plan.seed,
        mapType: plan.mapType,
        candidateVersion: OPTIONS.candidateVersion,
        opponentVersion: OPTIONS.opponentVersion,
        inheritCandidateEnvironment: false,
        candidateSide: plan.candidateSide,
        candidateRoster: candidateRoster.map(({ creatureName }) => creatureName),
        opponentRoster: opponentRoster.map(({ creatureName }) => creatureName),
        winner: "candidate",
        laps: 5,
        endReason: "elimination",
        candidateEngineRejections: 0,
        metrics,
        byCreature,
        passiveFailureSamples: [],
        passiveDecisionTimings: [],
    };
};

describe("v0.8 random-roster passive-turn panel", () => {
    test("inherits a campaign environment only when requested and otherwise seals dynamic strategy gates", () => {
        const capKey = "SEARCH_MAX_MOVE_SHOTS";
        const dynamicKey = "V08_RANGED_POSITION_MODE";
        const versionsKey = "V08_RANGED_POSITION_VERSIONS";
        const inheritedWaitKey = "V07_WAIT_WEIGHTS_V3";
        const previous = new Map(
            [capKey, dynamicKey, versionsKey, inheritedWaitKey].map((key) => [key, process.env[key]] as const),
        );
        process.env[capKey] = "campaign-sentinel";
        process.env[dynamicKey] = "hostile-mode";
        process.env[versionsKey] = "hostile";
        process.env[inheritedWaitKey] = "hostile-wait-vector";
        try {
            const inherited = withV08PassiveCandidateEnvironment(
                { candidateVersion: "v0.8", inheritCandidateEnvironment: true },
                () => ({
                    cap: process.env[capKey],
                    dynamic: process.env[dynamicKey],
                    inheritedWait: process.env[inheritedWaitKey],
                    versions: process.env[versionsKey],
                }),
            );
            expect(inherited).toEqual({
                cap: "campaign-sentinel",
                dynamic: "hostile-mode",
                inheritedWait: "hostile-wait-vector",
                versions: "hostile",
            });

            for (const candidateVersion of ["v0.8", "v0.8s"] as const) {
                const sealed = withV08PassiveCandidateEnvironment(
                    { candidateVersion, inheritCandidateEnvironment: false },
                    () => ({
                        cap: process.env[capKey],
                        dynamic: process.env[dynamicKey],
                        inheritedWait: process.env[inheritedWaitKey],
                        versions: process.env[versionsKey],
                    }),
                );
                expect(sealed).toEqual({
                    cap: "0",
                    dynamic: undefined,
                    inheritedWait: undefined,
                    versions: undefined,
                });
                expect(process.env[capKey]).toBe("campaign-sentinel");
                expect(process.env[dynamicKey]).toBe("hostile-mode");
                expect(process.env[inheritedWaitKey]).toBe("hostile-wait-vector");
                expect(process.env[versionsKey]).toBe("hostile");
            }
        } finally {
            for (const [key, value] of previous) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test("uses deterministic random physical rosters, adjacent seat swaps, and all live maps", () => {
        const firstFingerprint = fingerprintV08PassiveTurnPanelPlan(OPTIONS);
        const previousForced = process.env.FORCE_CREATURES;
        process.env.FORCE_CREATURES = "4:Abomination";
        try {
            expect(fingerprintV08PassiveTurnPanelPlan(OPTIONS)).toBe(firstFingerprint);
        } finally {
            if (previousForced === undefined) delete process.env.FORCE_CREATURES;
            else process.env.FORCE_CREATURES = previousForced;
        }
        expect(firstFingerprint).not.toBe(
            fingerprintV08PassiveTurnPanelPlan({ ...OPTIONS, inheritCandidateEnvironment: true }),
        );
        expect(firstFingerprint).not.toBe(
            fingerprintV08PassiveTurnPanelPlan({ ...OPTIONS, sourceCommit: "b".repeat(40) }),
        );
        expect(firstFingerprint).not.toBe(fingerprintV08PassiveTurnPanelPlan({ ...OPTIONS, sourceDirty: true }));

        for (let pair = 0; pair < OPTIONS.games / 2; pair += 1) {
            const even = planV08PassiveTurnPanelGame(OPTIONS, pair * 2);
            const odd = planV08PassiveTurnPanelGame(OPTIONS, pair * 2 + 1);
            expect(odd.seed).toBe(even.seed);
            expect(odd.mapType).toBe(even.mapType);
            expect(odd.greenRoster).toEqual(even.greenRoster);
            expect(odd.redRoster).toEqual(even.redRoster);
            expect(even.candidateSide).toBe("green");
            expect(odd.candidateSide).toBe("red");
        }
        expect(
            Array.from({ length: OPTIONS.games }, (_, game) => planV08PassiveTurnPanelGame(OPTIONS, game).mapType),
        ).toEqual(V08_PASSIVE_TURN_PANEL_MAPS.flatMap((mapType) => [mapType, mapType]));
    });

    test("matches SearchDriver's force-tier semantics and separates forced, protected, and avoidable shields", () => {
        const unitId = "actor";
        const harmfulAttack = candidate(
            "melee",
            [
                {
                    type: "melee_attack",
                    attackerId: unitId,
                    targetId: "enemy",
                    attackFrom: { x: 1, y: 1 },
                },
            ],
            -10,
        );
        const positiveAttack = candidate("melee", harmfulAttack.actions, 10);
        const productiveMove = candidate("move", [move(unitId)]);
        const supportSpell = candidate("spell", [
            { type: "cast_spell", casterId: unitId, spellName: "Spiritual Armor", targetId: unitId },
        ]);
        const passiveDefend = candidate("defend", [defend(unitId)]);

        expect(isV08PassiveForceTierProductiveCandidate(harmfulAttack)).toBe(false);
        expect(isV08PassiveForceTierProductiveCandidate(positiveAttack)).toBe(true);
        expect(isV08PassiveForceTierProductiveCandidate(productiveMove)).toBe(true);
        expect(isV08PassiveForceTierProductiveCandidate(supportSpell)).toBe(true);
        expect(isV08PassiveForceTierProductiveCandidate(passiveDefend)).toBe(false);
        expect(classifyV08PassiveDefendOpportunity([harmfulAttack, passiveDefend])).toBe("forced");
        expect(classifyV08PassiveDefendOpportunity([productiveMove, passiveDefend], () => false)).toBe("protected");
        expect(
            classifyV08PassiveDefendOpportunity(
                [positiveAttack, productiveMove, passiveDefend],
                (alternative) => alternative === productiveMove,
            ),
        ).toBe("avoidable");
    });

    test("requires SearchDriver's real-engine probe before calling an enumerated shield alternative avoidable", () => {
        const rejectedMirror = new V08PassiveTurnAuditor("green");
        rejectedMirror.observePreparedDecision({
            unitId: "invalid",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("invalid")],
            defendClass: "avoidable",
            requiresProductiveProbe: true,
        });
        rejectedMirror.observeProductiveProbe(productiveProbe("invalid"));
        rejectedMirror.observeExecution(
            execution({
                unitId: "invalid",
                raw: [defend("invalid")],
                chosen: [defend("invalid")],
            }),
        );
        rejectedMirror.finish();
        expect(rejectedMirror.metrics.rawAvoidableDefendTurns).toBe(0);
        expect(rejectedMirror.metrics.avoidableDefendTurns).toBe(0);
        expect(rejectedMirror.metrics.forcedDefendTurns).toBe(1);
        expect(rejectedMirror.metrics.observerPairingFaults).toBe(0);

        const acceptedMirror = new V08PassiveTurnAuditor("green");
        acceptedMirror.observePreparedDecision({
            unitId: "valid",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("valid")],
            defendClass: "avoidable",
            requiresProductiveProbe: true,
        });
        acceptedMirror.observeProductiveProbe(
            productiveProbe("valid", {
                selectedKind: "move",
                retainedPassive: false,
                hasEngineValidProductiveAlternative: true,
                engineValidShortlistedProductiveAlternatives: 1,
                bestShortlistedProductiveKind: "move",
                bestShortlistedProductiveScore: 0.6,
                shortlistedProductiveScoreDelta: 0.1,
                betterShortlistedProductiveAlternative: true,
            }),
        );
        acceptedMirror.observeExecution(
            execution({
                unitId: "valid",
                raw: [defend("valid")],
                chosen: [move("valid")],
            }),
        );
        acceptedMirror.finish();
        expect(acceptedMirror.metrics.rawAvoidableDefendTurns).toBe(1);
        expect(acceptedMirror.metrics.repairedRawAvoidableDefendTurns).toBe(1);
        expect(acceptedMirror.metrics.observerPairingFaults).toBe(0);

        const missingProbe = new V08PassiveTurnAuditor("green");
        missingProbe.observePreparedDecision({
            unitId: "missing",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("missing")],
            defendClass: "avoidable",
            requiresProductiveProbe: true,
        });
        missingProbe.observeExecution(
            execution({
                unitId: "missing",
                raw: [defend("missing")],
                chosen: [defend("missing")],
            }),
        );
        missingProbe.finish();
        expect(missingProbe.metrics.rawAvoidableDefendTurns).toBe(0);
        expect(missingProbe.metrics.forcedDefendTurns).toBe(1);
        expect(missingProbe.metrics.observerPairingFaults).toBe(1);

        expect(requiresV08PassiveProductiveProbe("v0.8s", [defend("alias-missing")])).toBe(true);
        expect(requiresV08PassiveProductiveProbe("v0.1", [defend("mindless")])).toBe(false);
        const missingAliasProbe = new V08PassiveTurnAuditor("green");
        missingAliasProbe.observePreparedDecision({
            unitId: "alias-missing",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("alias-missing")],
            defendClass: "avoidable",
            requiresProductiveProbe: requiresV08PassiveProductiveProbe("v0.8s", [defend("alias-missing")]),
        });
        missingAliasProbe.observeExecution(
            execution({
                unitId: "alias-missing",
                strategyVersion: "v0.8s",
                raw: [defend("alias-missing")],
                chosen: [defend("alias-missing")],
            }),
        );
        missingAliasProbe.finish();
        expect(missingAliasProbe.metrics.forcedDefendTurns).toBe(1);
        expect(missingAliasProbe.metrics.observerPairingFaults).toBe(1);
    });

    test("pairs post-search productive probes that arrive before decisions and counts duplicates or orphans", () => {
        const early = new V08PassiveTurnAuditor("green");
        early.observeProductiveProbe(productiveProbe("early"));
        early.observePreparedDecision({
            unitId: "early",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("early")],
            defendClass: "forced",
            requiresProductiveProbe: true,
        });
        early.observeExecution(
            execution({
                unitId: "early",
                raw: [defend("early")],
                chosen: [defend("early")],
            }),
        );
        early.finish();
        expect(early.metrics.observerPairingFaults).toBe(0);
        expect(early.metrics.passiveEvidenceTurns).toBe(1);

        const duplicate = new V08PassiveTurnAuditor("green");
        duplicate.observeProductiveProbe(productiveProbe("duplicate"));
        duplicate.observeProductiveProbe(productiveProbe("duplicate"));
        duplicate.observePreparedDecision({
            unitId: "duplicate",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("duplicate")],
            defendClass: "forced",
            requiresProductiveProbe: true,
        });
        duplicate.observeExecution(
            execution({
                unitId: "duplicate",
                raw: [defend("duplicate")],
                chosen: [defend("duplicate")],
            }),
        );
        duplicate.finish();
        expect(duplicate.metrics.observerPairingFaults).toBe(1);

        const orphan = new V08PassiveTurnAuditor("green");
        orphan.observeProductiveProbe(productiveProbe("orphan"));
        orphan.finish();
        expect(orphan.metrics.observerPairingFaults).toBe(1);
    });

    test("keeps the production probe detached and bit-for-bit inert", () => {
        const plan = planV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 73);
        const setup = liveTwinSetup();
        const run = (
            searchPassiveProductiveProbeObserver?: (probe: ISearchPassiveProductiveProbe) => void,
        ): ReturnType<typeof runMatch> => {
            const config: IMatchConfig = {
                greenVersion:
                    plan.candidateSide === "green"
                        ? PRODUCTION_REGRESSION_OPTIONS.candidateVersion
                        : PRODUCTION_REGRESSION_OPTIONS.opponentVersion,
                redVersion:
                    plan.candidateSide === "green"
                        ? PRODUCTION_REGRESSION_OPTIONS.opponentVersion
                        : PRODUCTION_REGRESSION_OPTIONS.candidateVersion,
                roster: plan.greenRoster,
                redRoster: plan.redRoster,
                seed: plan.seed,
                gridType: plan.mapType,
                greenPerk: setup.perk,
                redPerk: setup.perk,
                greenAugments: setup.augments,
                redAugments: setup.augments,
                placementAugmentTiming: "setup-before-placement",
                searchPassiveProductiveProbeObserver,
            };
            return withScopedAIEnvironment({ [V08_A13_SEARCH_OVERRIDE_ENV]: "1" }, () => runMatch(config));
        };
        const control = run();
        const probes: ISearchPassiveProductiveProbe[] = [];
        const observed = run((probe) => {
            probes.push({ ...probe });
            // The observer receives a detached scalar record. Even hostile mutation cannot touch the fallback
            // candidate, battle snapshot, or the driver's already-computed boolean.
            (probe as { unitId: string }).unitId = "mutated";
            (probe as { hasEngineValidProductiveAlternative: boolean }).hasEngineValidProductiveAlternative =
                !probe.hasEngineValidProductiveAlternative;
        });

        expect(probes.length).toBeGreaterThan(0);
        expect(observed).toEqual(control);
    });

    test("keeps post-search passive diagnostics out of the live path catalog and search outcome", () => {
        const plan = planV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 73);
        const setup = liveTwinSetup();
        const run = (diagnostics: boolean) => {
            const auditor = diagnostics ? new V08PassiveTurnAuditor(plan.candidateSide) : undefined;
            const catalogs: DecisionPathCatalog[] = [];
            const callbackStats: Array<{
                before: IDecisionPathCatalogStats;
                after: IDecisionPathCatalogStats;
            }> = [];
            const choices: GameAction[][] = [];
            const passiveOutcomes: Array<Omit<ISearchPassiveProductiveProbe, "decisionMs">> = [];
            const result = withScopedAIEnvironment({ [V08_A13_SEARCH_OVERRIDE_ENV]: "1" }, () =>
                runMatch({
                    greenVersion:
                        plan.candidateSide === "green"
                            ? PRODUCTION_REGRESSION_OPTIONS.candidateVersion
                            : PRODUCTION_REGRESSION_OPTIONS.opponentVersion,
                    redVersion:
                        plan.candidateSide === "green"
                            ? PRODUCTION_REGRESSION_OPTIONS.opponentVersion
                            : PRODUCTION_REGRESSION_OPTIONS.candidateVersion,
                    roster: plan.greenRoster,
                    redRoster: plan.redRoster,
                    seed: plan.seed,
                    gridType: plan.mapType,
                    greenPerk: setup.perk,
                    redPerk: setup.perk,
                    greenAugments: setup.augments,
                    redAugments: setup.augments,
                    placementAugmentTiming: "setup-before-placement",
                    decisionObserver: (observation) => {
                        const catalog = observation.context.decisionPathCatalog;
                        if (!catalog) {
                            auditor?.observeDecision(observation);
                            return;
                        }
                        const before = catalog.getStats();
                        auditor?.observeDecision(observation);
                        const after = catalog.getStats();
                        catalogs.push(catalog);
                        callbackStats.push({ before, after });
                    },
                    searchPassiveProductiveProbeObserver: (probe) => {
                        const outcome = { ...probe };
                        delete (outcome as Partial<ISearchPassiveProductiveProbe>).decisionMs;
                        passiveOutcomes.push(outcome);
                        auditor?.observeProductiveProbe(probe);
                    },
                    turnExecutionObserver: (observation) => {
                        choices.push(structuredClone([...observation.chosenDecision]));
                        auditor?.observeExecution(observation);
                    },
                    turnActivationObserver: (events) => auditor?.observeEvents(events),
                }),
            );
            auditor?.finish();
            return {
                result,
                choices,
                passiveOutcomes,
                callbackStats,
                finalCatalogStats: catalogs.map((catalog) => catalog.getStats()),
            };
        };

        // Both arms install the callback so BattleEngine creates the same stats-enabled catalog. The only
        // difference is whether the qualification auditor performs its pre-search enumeration.
        const control = run(false);
        const observed = run(true);

        expect(observed.callbackStats.length).toBeGreaterThan(0);
        expect(
            observed.callbackStats.every(({ before, after }) => JSON.stringify(before) === JSON.stringify(after)),
        ).toBe(true);
        expect(observed.result).toEqual(control.result);
        expect(observed.choices).toEqual(control.choices);
        expect(observed.passiveOutcomes.length).toBeGreaterThan(0);
        expect(observed.passiveOutcomes).toEqual(control.passiveOutcomes);
        expect(observed.finalCatalogStats).toEqual(control.finalCatalogStats);
    });

    test("records scored avoidable passives, explicit exemptions, and a terminal avoidable streak", () => {
        const auditor = new V08PassiveTurnAuditor("green");
        const retain = (
            unitId: string,
            lap: number,
            action: GameAction,
            probeOverrides: Partial<ISearchPassiveProductiveProbe>,
            defendClass: "forced" | "protected" | "avoidable" = "avoidable",
        ): void => {
            auditor.observePreparedDecision({
                unitId,
                creatureName: "Peasant",
                lap,
                rawIncumbent: [action],
                defendClass,
                requiresProductiveProbe: true,
            });
            auditor.observeProductiveProbe(
                productiveProbe(unitId, {
                    lap,
                    selectedKind:
                        action.type === "wait_turn" ? "wait" : action.type === "defend_turn" ? "defend" : "mine",
                    retainedPassive: true,
                    ...probeOverrides,
                }),
            );
            auditor.observeExecution(execution({ unitId, raw: [action], chosen: [action] }));
        };

        for (const lap of [1, 2]) {
            retain("mountain", lap, mountain("mountain"), {
                incumbentKind: "mountain",
                hasEngineValidProductiveAlternative: true,
                engineValidShortlistedProductiveAlternatives: 1,
                bestShortlistedProductiveKind: "move",
                incumbentScore: 0.4,
                bestShortlistedProductiveScore: 0.5,
                shortlistedProductiveScoreDelta: 0.1,
                betterShortlistedProductiveAlternative: true,
                productiveTierRequired: true,
            });
        }
        retain("initiative", 1, wait("initiative"), {
            incumbentKind: "wait",
            hasEngineValidProductiveAlternative: true,
            engineValidShortlistedProductiveAlternatives: 1,
            bestShortlistedProductiveKind: "shot",
            incumbentScore: 0.5,
            bestShortlistedProductiveScore: 0.52,
            shortlistedProductiveScoreDelta: 0.02,
            betterShortlistedProductiveAlternative: false,
            productiveTierRequired: false,
            strongerRangedPostureWait: true,
        });
        retain("deadline-initiative", 1, wait("deadline-initiative"), {
            incumbentKind: "wait",
            hasEngineValidProductiveAlternative: true,
            engineValidShortlistedProductiveAlternatives: 1,
            bestShortlistedProductiveKind: "shot",
            incumbentScore: 0.5,
            bestShortlistedProductiveScore: 0.6,
            shortlistedProductiveScoreDelta: 0.1,
            betterShortlistedProductiveAlternative: true,
            productiveTierRequired: false,
            strongerRangedPostureWait: true,
            resolution: "deadline_fallback",
        });
        retain(
            "protector",
            1,
            defend("protector"),
            {
                backlineProtectorIntent: true,
            },
            "protected",
        );
        retain("forced", 1, mountain("forced"), {
            incumbentKind: "mountain",
        });
        auditor.finish();

        expect(auditor.metrics.passiveEvidenceTurns).toBe(6);
        expect(auditor.metrics.retainedPassiveWithBetterShortlistedProductiveActionTurns).toBe(3);
        expect(auditor.metrics.exemptRetainedPassiveWithBetterShortlistedProductiveActionTurns).toBe(0);
        expect(auditor.metrics.avoidableRetainedPassiveTurns).toBe(3);
        expect(auditor.metrics.avoidableMountainTurns).toBe(2);
        expect(auditor.metrics.avoidableWaitTurns).toBe(1);
        expect(auditor.metrics.strongerRangedWaitExemptions).toBe(1);
        expect(auditor.metrics.protectedRetainedPassiveTurns).toBe(1);
        expect(auditor.metrics.protectorIntentPassiveExemptions).toBe(1);
        expect(auditor.metrics.forcedRetainedPassiveTurns).toBe(1);
        expect(auditor.metrics.terminalPassiveStreaks).toBe(1);
        expect(auditor.metrics.terminalAvoidablePassiveStreaks).toBe(1);
        expect(auditor.metrics.terminalAvoidablePassiveStreakTurns).toBe(2);
        expect(auditor.metrics.observerPairingFaults).toBe(0);
        expect(auditor.failureSamples).toHaveLength(3);
        expect(auditor.failureSamples[0]).toMatchObject({
            issue: "avoidable_retained_mountain",
            unitId: "mountain",
            creatureName: "Peasant",
            lap: 1,
            incumbentKind: "mountain",
            retainedKind: "mountain",
            selectedKind: "mine",
            bestShortlistedProductiveKind: "move",
            incumbentScore: 0.4,
            bestShortlistedProductiveScore: 0.5,
            shortlistedProductiveScoreDelta: 0.1,
            resolution: "scored",
        });
    });

    test("counts the candidate physical side even when a Berserker/Boar turn is pinned to v0.1", () => {
        const auditor = new V08PassiveTurnAuditor("green");
        auditor.observePreparedDecision({
            unitId: "berserker",
            creatureName: "Berserker",
            lap: 2,
            rawIncumbent: [move("berserker")],
            defendClass: "avoidable",
        });
        auditor.observeExecution(
            execution({
                unitId: "berserker",
                creatureName: "Berserker",
                strategyVersion: "v0.1",
                chosen: [move("berserker")],
            }),
        );
        auditor.finish();
        expect(auditor.metrics.turns).toBe(1);
        expect(auditor.byCreature.Berserker.turns).toBe(1);
        expect(auditor.metrics.observerPairingFaults).toBe(0);
    });

    test("keeps terminal wait and mountain streaks visible for candidate units pinned to v0.1", () => {
        const auditor = new V08PassiveTurnAuditor("green");
        const retainPinnedPassive = (unitId: string, creatureName: string, lap: number, action: GameAction): void => {
            auditor.observePreparedDecision({
                unitId,
                creatureName,
                lap,
                rawIncumbent: [action],
                defendClass: "avoidable",
            });
            auditor.observeExecution(
                execution({
                    unitId,
                    creatureName,
                    strategyVersion: "v0.1",
                    raw: [action],
                    chosen: [action],
                }),
            );
        };

        retainPinnedPassive("berserker", "Berserker", 1, wait("berserker"));
        retainPinnedPassive("berserker", "Berserker", 2, wait("berserker"));
        retainPinnedPassive("boar", "Boar", 1, mountain("boar"));
        retainPinnedPassive("boar", "Boar", 2, mountain("boar"));
        auditor.finish();

        expect(auditor.metrics.passiveEvidenceTurns).toBe(0);
        expect(auditor.metrics.terminalPassiveStreaks).toBe(2);
        expect(auditor.metrics.terminalPassiveStreakTurns).toBe(4);
        expect(auditor.metrics.terminalAvoidablePassiveStreaks).toBe(0);
        expect(auditor.byCreature.Berserker.terminalPassiveStreakTurns).toBe(2);
        expect(auditor.byCreature.Boar.terminalPassiveStreakTurns).toBe(2);
        expect(auditor.metrics.observerPairingFaults).toBe(0);
    });

    test("audits end-turn, rejection, recovery, incomplete, introduced shield, and repaired raw shield gates", () => {
        const auditor = new V08PassiveTurnAuditor("green");

        auditor.observePreparedDecision({
            unitId: "repaired",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [defend("repaired")],
            defendClass: "avoidable",
        });
        auditor.observeExecution(
            execution({
                unitId: "repaired",
                raw: [defend("repaired")],
                chosen: [move("repaired")],
            }),
        );

        auditor.observePreparedDecision({
            unitId: "introduced",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [move("introduced")],
            defendClass: "avoidable",
        });
        auditor.observeExecution(
            execution({
                unitId: "introduced",
                raw: [move("introduced")],
                chosen: [defend("introduced")],
            }),
        );

        const rejectedMove = move("broken");
        const recovery: ITurnRecoveryObservation = {
            source: "defend",
            completed: true,
            action: defend("broken"),
            events: [],
        };
        auditor.observePreparedDecision({
            unitId: "broken",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [end("broken")],
            defendClass: "forced",
        });
        auditor.observeExecution(
            execution({
                unitId: "broken",
                raw: [end("broken")],
                chosen: [end("broken"), rejectedMove],
                completed: [end("broken")],
                rejected: [rejectedMove],
                recoveryAttempts: [recovery],
            }),
        );
        auditor.finish();

        expect(auditor.metrics.rawAvoidableDefendTurns).toBe(1);
        expect(auditor.metrics.repairedRawAvoidableDefendTurns).toBe(1);
        expect(auditor.metrics.introducedDefendTurns).toBe(2);
        expect(auditor.metrics.avoidableDefendTurns).toBe(1);
        expect(auditor.metrics.forcedDefendTurns).toBe(1);
        expect(auditor.metrics.rawEndTurnTurns).toBe(1);
        expect(auditor.metrics.chosenEndTurnTurns).toBe(1);
        expect(auditor.metrics.strategyRejectedActions).toBe(1);
        expect(auditor.metrics.recoveryTurns).toBe(1);
        expect(auditor.metrics.recoveryAttempts).toBe(1);
        expect(auditor.metrics.incompleteTurns).toBe(0);
    });

    test("distinguishes same-lap wait reactivation, repeat, live miss, death, and match-end censoring", () => {
        const auditor = new V08PassiveTurnAuditor("green");
        const park = (unitId: string, lap: number): void => {
            auditor.observePreparedDecision({
                unitId,
                creatureName: "Peasant",
                lap,
                rawIncumbent: [wait(unitId)],
                defendClass: "forced",
            });
            auditor.observeExecution(execution({ unitId, raw: [wait(unitId)], chosen: [wait(unitId)] }));
        };

        park("reactivated", 1);
        auditor.observePreparedDecision({
            unitId: "reactivated",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [move("reactivated")],
            defendClass: "avoidable",
        });
        auditor.observeExecution(execution({ unitId: "reactivated", chosen: [move("reactivated")] }));

        park("repeated", 1);
        auditor.observePreparedDecision({
            unitId: "repeated",
            creatureName: "Peasant",
            lap: 1,
            rawIncumbent: [wait("repeated")],
            defendClass: "forced",
        });
        auditor.observeExecution(execution({ unitId: "repeated", chosen: [wait("repeated")] }));

        park("missed", 1);
        auditor.observePreparedDecision({
            unitId: "lap-two-actor",
            creatureName: "Peasant",
            lap: 2,
            rawIncumbent: [move("lap-two-actor")],
            defendClass: "avoidable",
        });
        auditor.observeExecution(execution({ unitId: "lap-two-actor", chosen: [move("lap-two-actor")] }));

        park("killed", 2);
        auditor.observeExecution(
            execution({
                unitId: "enemy",
                creatureName: "Pikeman",
                side: "red",
                events: [{ type: "unit_destroyed", unitId: "killed", reason: "dead_cleanup" }],
            }),
        );

        park("effect", 2);
        auditor.observeEvents([{ type: "unit_skipped", unitId: "effect", team: GREEN_TEAM, reason: "effect" }]);

        park("censored", 2);
        auditor.finish();

        expect(auditor.metrics.waitTurns).toBe(7);
        expect(auditor.metrics.sameLapWaitReactivations).toBe(2);
        expect(auditor.metrics.repeatedSameLapWaits).toBe(1);
        expect(auditor.metrics.missedSameLapWaitReactivations).toBe(2);
        expect(auditor.metrics.waitsSkippedByEffectBeforeReactivation).toBe(1);
        expect(auditor.metrics.waitsKilledBeforeReactivation).toBe(1);
        expect(auditor.metrics.waitsCensoredByMatchEnd).toBe(1);
    });

    test("exposes every hard gate, including enabled-creature and Abomination/Queen fault gates", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => fixtureRecord(game));
        const passing = summarizeV08PassiveTurnPanel(OPTIONS, records);
        expect(summarizeV08PassiveTurnPanel(OPTIONS, [...records].reverse())).toEqual(passing);
        expect(passing.gates.pass).toBe(true);
        expect(passing.gates.failed).toEqual([]);
        expect(passing.planSha256).toBe(fingerprintV08PassiveTurnPanelPlan(OPTIONS));
        expect(passing.options.inheritCandidateEnvironment).toBe(false);
        expect(passing.sourceCommit).toBe(OPTIONS.sourceCommit);
        expect(passing.sourceDirty).toBe(false);
        expect(passing.recordsWithoutObservedTurns).toBe(0);
        expect(passing.recordTurnTotalMismatches).toBe(0);
        expect(passing.byCreatureTurns).toBe(OPTIONS.games);

        const dirtyOptions = { ...OPTIONS, sourceDirty: true };
        const dirty = summarizeV08PassiveTurnPanel(
            dirtyOptions,
            records.map((record) => ({ ...record, sourceDirty: true })),
        );
        expect(dirty.gates.failed).toEqual(["source_commit_bound"]);
        expect(dirty.sourceDirty).toBe(true);

        const failing = records.map((record) => ({
            ...record,
            metrics: { ...record.metrics },
            byCreature: Object.fromEntries(
                Object.entries(record.byCreature).map(([name, metrics]) => [name, { ...metrics }]),
            ),
        }));
        failing[0].metrics.rawEndTurnTurns = 1;
        failing[0].metrics.avoidableDefendTurns = 1;
        failing[0].metrics.retainedPassiveWithBetterShortlistedProductiveActionTurns = 1;
        failing[0].metrics.avoidableRetainedPassiveTurns = 1;
        failing[0].metrics.avoidableWaitTurns = 1;
        failing[0].metrics.avoidableLuckShieldTurns = 1;
        failing[0].metrics.avoidableMountainTurns = 1;
        failing[0].metrics.deadlineWaitResolutions = 1;
        failing[0].metrics.deadlineWaitRetentions = 1;
        failing[0].metrics.retainedPassiveEvidenceIncompleteTurns = 1;
        failing[0].metrics.terminalAvoidablePassiveStreaks = 1;
        failing[0].metrics.missedSameLapWaitReactivations = 1;
        failing[0].metrics.strategyRejectedActions = 1;
        failing[0].passiveFailureSamples = [
            {
                issue: "avoidable_retained_wait",
                unitId: "sample-unit",
                creatureName: "Peasant",
                lap: 4,
                incumbentKind: "wait",
                retainedKind: "wait",
                selectedKind: "wait",
                bestShortlistedProductiveKind: "move",
                incumbentScore: 0.4,
                bestShortlistedProductiveScore: 0.5,
                shortlistedProductiveScoreDelta: 0.1,
                resolution: "circuit_fallback",
                strongerRangedPostureWait: false,
                backlineProtectorIntent: false,
                backlineWardIntent: false,
                circuitOpenAtDecision: true,
                circuitWaitArbitration: false,
                decisionMs: 12.5,
            },
        ];
        failing[0].passiveDecisionTimings = [
            { decisionMs: 2, circuitOpenWait: false, circuitWaitArbitration: false },
            { decisionMs: 12.5, circuitOpenWait: true, circuitWaitArbitration: false },
        ];
        failing[0].byCreature.Abomination = emptyV08PassiveTurnMetrics();
        failing[0].byCreature.Abomination.rawEndTurnTurns = 1;
        failing[1].byCreature["Arachna Queen"] = emptyV08PassiveTurnMetrics();
        failing[1].byCreature["Arachna Queen"].recoveryAttempts = 1;
        const summary = summarizeV08PassiveTurnPanel(OPTIONS, failing);
        expect(summary.gates.pass).toBe(false);
        expect(summary.gates.failed).toContain("raw_end_turn_zero");
        expect(summary.gates.failed).toContain("strategy_rejections_zero");
        expect(summary.gates.failed).toContain("avoidable_defends_zero");
        expect(summary.gates.failed).toContain("retained_passive_with_better_shortlisted_productive_action_zero");
        expect(summary.gates.failed).toContain("avoidable_waits_zero");
        expect(summary.gates.failed).toContain("avoidable_luck_shields_zero");
        expect(summary.gates.failed).toContain("avoidable_mountain_turns_zero");
        expect(summary.gates.failed).toContain("wait_deadline_fallbacks_zero");
        expect(summary.gates.failed).toContain("retained_passive_evidence_complete");
        expect(summary.gates.failed).toContain("terminal_avoidable_passive_streaks_zero");
        expect(summary.failureSamples[0]).toMatchObject({
            game: 0,
            issue: "avoidable_retained_wait",
            unitId: "sample-unit",
            creatureName: "Peasant",
            lap: 4,
            incumbentKind: "wait",
            bestShortlistedProductiveKind: "move",
            incumbentScore: 0.4,
            bestShortlistedProductiveScore: 0.5,
            shortlistedProductiveScoreDelta: 0.1,
            resolution: "circuit_fallback",
            circuitOpenAtDecision: true,
            decisionMs: 12.5,
        });
        expect(summary.passiveDecisionTiming).toEqual({ count: 2, meanMs: 7.25, p95Ms: 12.5, maxMs: 12.5 });
        expect(summary.circuitOpenWaitTiming).toEqual({
            count: 1,
            meanMs: 12.5,
            p95Ms: 12.5,
            maxMs: 12.5,
        });
        expect(summary.circuitOpenWaitArbitrationTiming).toEqual({
            count: 0,
            meanMs: 0,
            p95Ms: 0,
            maxMs: 0,
        });
        expect(summary.circuitOpenWaitDeferredTiming).toEqual({
            count: 1,
            meanMs: 12.5,
            p95Ms: 12.5,
            maxMs: 12.5,
        });
        expect(summary.gates.failed).toContain("missed_wait_reactivations_zero");
        expect(summary.gates.failed).toContain("abomination_faults_zero");
        expect(summary.gates.failed).toContain("arachna_queen_faults_zero");

        const appearanceGate = summarizeV08PassiveTurnPanel({ ...OPTIONS, minCreatureAppearances: 1 }, records);
        expect(appearanceGate.gates.checks.enabled_creature_appearances.pass).toBe(false);
        expect(appearanceGate.underrepresentedCreatures.length).toBeGreaterThan(0);
    });

    test("keeps forced and protected Luck Shields inside the absolute 1.01% budget", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => fixtureRecord(game));
        const turnCounts = [1_665, 1_667, 1_667, 1_667, 1_667, 1_667];
        records.forEach((record, index) => {
            record.metrics.turns = turnCounts[index]!;
            const observed = Object.values(record.byCreature).find((metrics) => metrics.turns === 1)!;
            observed.turns = turnCounts[index]!;
        });
        const defendedCreature = Object.values(records[0]!.byCreature).find(
            (metrics) => metrics.turns === turnCounts[0],
        )!;
        Object.assign(records[0]!.metrics, {
            rawDefendTurns: 101,
            chosenDefendTurns: 101,
            finalDefendTurns: 101,
            forcedDefendTurns: 1,
            protectedDefendTurns: 100,
        });
        Object.assign(defendedCreature, {
            rawDefendTurns: 101,
            chosenDefendTurns: 101,
            finalDefendTurns: 101,
            forcedDefendTurns: 1,
            protectedDefendTurns: 100,
        });

        const atBoundary = summarizeV08PassiveTurnPanel(OPTIONS, records);
        expect(atBoundary.defendShare).toBe(0.0101);
        expect(atBoundary.defendClassMismatches).toBe(0);
        expect(atBoundary.gates.checks.defend_classes_consistent.pass).toBe(true);
        expect(atBoundary.gates.checks.final_defend_share.pass).toBe(true);
        expect(atBoundary.gates.pass).toBe(true);

        const overBudget = records.map((record) => ({
            ...record,
            metrics: { ...record.metrics },
            byCreature: Object.fromEntries(
                Object.entries(record.byCreature).map(([name, metrics]) => [name, { ...metrics }]),
            ),
        }));
        const overBudgetCreature = Object.values(overBudget[0]!.byCreature).find(
            (metrics) => metrics.turns === turnCounts[0],
        )!;
        overBudget[0]!.metrics.rawDefendTurns += 1;
        overBudget[0]!.metrics.chosenDefendTurns += 1;
        overBudget[0]!.metrics.finalDefendTurns += 1;
        overBudget[0]!.metrics.forcedDefendTurns += 1;
        overBudgetCreature.rawDefendTurns += 1;
        overBudgetCreature.chosenDefendTurns += 1;
        overBudgetCreature.finalDefendTurns += 1;
        overBudgetCreature.forcedDefendTurns += 1;
        const overBudgetSummary = summarizeV08PassiveTurnPanel(OPTIONS, overBudget);
        expect(overBudgetSummary.defendShare).toBe(0.0102);
        expect(overBudgetSummary.gates.checks.defend_classes_consistent.pass).toBe(true);
        expect(overBudgetSummary.gates.failed).toContain("final_defend_share");

        const malformed = records.map((record) => ({
            ...record,
            metrics: { ...record.metrics },
            byCreature: Object.fromEntries(
                Object.entries(record.byCreature).map(([name, metrics]) => [name, { ...metrics }]),
            ),
        }));
        const malformedCreature = Object.values(malformed[0]!.byCreature).find(
            (metrics) => metrics.turns === turnCounts[0],
        )!;
        malformedCreature.protectedDefendTurns = 99;
        malformedCreature.forcedDefendTurns = 2;
        const malformedSummary = summarizeV08PassiveTurnPanel(OPTIONS, malformed);
        expect(malformedSummary.defendClassMismatches).toBeGreaterThan(0);
        expect(malformedSummary.gates.failed).toContain("defend_classes_consistent");

        malformed[0]!.metrics.protectedDefendTurns = -1;
        malformed[0]!.metrics.forcedDefendTurns = 102;
        const invalidDomainSummary = summarizeV08PassiveTurnPanel(OPTIONS, malformed);
        expect(invalidDomainSummary.defendClassMismatches).toBeGreaterThan(0);
        expect(invalidDomainSummary.gates.failed).toContain("defend_classes_consistent");
    });

    test("fails closed when records contain no observations or disagree with their by-creature turn totals", () => {
        const records = Array.from({ length: OPTIONS.games }, (_, game) => fixtureRecord(game));
        const silent = records.map((record) => ({
            ...record,
            metrics: {
                ...record.metrics,
                turns: 0,
                passiveEvidenceTurns: 0,
            },
            byCreature: Object.fromEntries(
                Object.entries(record.byCreature).map(([creatureName, metrics]) => [
                    creatureName,
                    {
                        ...metrics,
                        turns: 0,
                        passiveEvidenceTurns: 0,
                    },
                ]),
            ),
        }));
        const silentSummary = summarizeV08PassiveTurnPanel(OPTIONS, silent);
        expect(silentSummary.gates.pass).toBe(false);
        expect(silentSummary.gates.failed).toContain("observed_turns_positive");
        expect(silentSummary.gates.failed).toContain("passive_evidence_turns_positive");
        expect(silentSummary.gates.failed).toContain("every_game_observed_turns");
        expect(silentSummary.gates.checks.turn_totals_consistent.pass).toBe(true);
        expect(silentSummary.recordsWithoutObservedTurns).toBe(OPTIONS.games);

        const inconsistent = records.map((record) => ({
            ...record,
            metrics: { ...record.metrics },
            byCreature: Object.fromEntries(
                Object.entries(record.byCreature).map(([creatureName, metrics]) => [creatureName, { ...metrics }]),
            ),
        }));
        inconsistent[0]!.metrics.turns += 1;
        const inconsistentSummary = summarizeV08PassiveTurnPanel(OPTIONS, inconsistent);
        expect(inconsistentSummary.gates.failed).toContain("turn_totals_consistent");
        expect(inconsistentSummary.recordTurnTotalMismatches).toBe(1);
        expect(inconsistentSummary.byCreatureTurns).toBe(OPTIONS.games);
        expect(inconsistentSummary.metrics.turns).toBe(OPTIONS.games + 1);
    });

    test("smokes the real production v0.8+a13 dual-hook path", () => {
        const previousSearch = process.env.V07_SEARCH;
        const previousOverride = process.env.V08_A13_SEARCH;
        process.env.V07_SEARCH = "1";
        process.env.V08_A13_SEARCH = "0";
        let record: IV08PassiveTurnPanelRecord;
        try {
            record = runV08PassiveTurnPanelGame(
                {
                    ...OPTIONS,
                    games: 2,
                    maxLaps: 1,
                },
                0,
            );
            expect(process.env.V07_SEARCH).toBe("1");
            expect(process.env.V08_A13_SEARCH).toBe("0");
        } finally {
            if (previousSearch === undefined) delete process.env.V07_SEARCH;
            else process.env.V07_SEARCH = previousSearch;
            if (previousOverride === undefined) delete process.env.V08_A13_SEARCH;
            else process.env.V08_A13_SEARCH = previousOverride;
        }
        expect(record.endReason).toBe("turn_cap");
        expect(record.crash).toBeUndefined();
        expect(record.candidateSide).toBe("green");
        expect(record.inheritCandidateEnvironment).toBe(false);
        expect(record.metrics.appearances).toBe(6);
        expect(record.metrics.turns).toBeGreaterThan(0);
        expect(record.metrics.observerPairingFaults).toBe(0);
    });

    test("classifies the known protector screen holds without manufacturing movement work", () => {
        // Block-center game 3443 has no attacks, casts, catch-up, local threat, or newly covered ward available
        // to Harpy/Abomination on its post-hourglass holds. The shared Flesh-Shield retaliation-risk predicate
        // now rejects the tempting raw Abomination hit before passive arbitration, so no avoidable shield needs
        // repair. Screen holds remain protected; after S3 restores the campaign shortlist, one genuinely forced
        // Abomination shield remains after the role releases, with no productive candidate left.
        const record = runV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 3_443);
        expect(record.endReason).toBe("elimination");
        expect(record.metrics.rawAvoidableDefendTurns).toBe(0);
        expect(record.metrics.repairedRawAvoidableDefendTurns).toBe(0);
        expect(record.metrics.avoidableDefendTurns).toBe(0);
        // The S3 shortlist admits the productive branch that removes the other historical forced hold. The
        // guarded classification is untouched — every avoidable-defend counter above stays zero.
        expect(record.metrics.forcedDefendTurns).toBe(1);
        expect(record.metrics.finalDefendTurns).toBe(
            record.metrics.protectedDefendTurns + record.metrics.forcedDefendTurns,
        );
        expect(record.metrics.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.metrics.strategyRejectedActions).toBe(0);
        expect(record.metrics.recoveryAttempts).toBe(0);
        expect(record.byCreature.Harpy.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.byCreature.Abomination.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.byCreature.Harpy.finalDefendTurns).toBe(record.byCreature.Harpy.protectedDefendTurns);
        expect(record.byCreature.Abomination.finalDefendTurns).toBe(
            record.byCreature.Abomination.protectedDefendTurns + record.byCreature.Abomination.forcedDefendTurns,
        );
    });

    test("scores every circuit-open wait in the exact games that exposed the global retry cutoff", () => {
        const forcedCircuitEnvironment = {
            ...buildV08A13SearchEnvironment("v0.8"),
            // Keep the same production search shape while deterministically opening its timing circuit before
            // these lap-two waits. The deadline remains strictly below the circuit breaker as required.
            SEARCH_CIRCUIT_BREAKER_MS: "0.0001",
            SEARCH_DECISION_DEADLINE_MS: "0.00001",
        };
        const options: IV08PassiveTurnPanelOptions = {
            ...PRODUCTION_REGRESSION_OPTIONS,
            inheritCandidateEnvironment: true,
            searchOfflineDeterministicWork: false,
        };
        const records = withScopedAIEnvironment(forcedCircuitEnvironment, () =>
            [756, 758].map((game) => runV08PassiveTurnPanelGame(options, game)),
        );

        expect(records.map(({ seed }) => seed)).toEqual([961_641_207, 3_616_076_968]);
        expect(records.map(({ candidateRoster }) => candidateRoster)).toEqual([
            ["Peasant", "Peasant", "Manticore", "Pikeman", "Monk", "Hydra"],
            ["Dryad", "Squire", "Medusa", "Manticore", "Pegasus", "Angel"],
        ]);
        for (const record of records) {
            expect(record.crash).toBeUndefined();
            expect(record.metrics.circuitOpenWaitArbitrations).toBeGreaterThan(1);
            expect(record.metrics.circuitOpenWaitDeferred).toBe(0);
            expect(record.metrics.avoidableWaitTurns).toBe(0);
            expect(record.metrics.avoidableRetainedPassiveTurns).toBe(0);
            expect(record.passiveFailureSamples).toEqual([]);
            expect(
                record.passiveDecisionTimings
                    .filter(({ circuitOpenWait }) => circuitOpenWait)
                    .every(({ circuitWaitArbitration }) => circuitWaitArbitration),
            ).toBe(true);
        }
    });

    // RE-PIN NEEDED (fight lane): the Griffin nerf (armor 24 -> 23, owner-requested 2026-08-01) reshapes
    // seeded game 471, whose censored unit IS the Griffin — its wait pattern moved (waitTurns 1 -> 3 with
    // a same-lap pair), so this seed no longer isolates the pure effect-consumed wait the test exists to
    // hold. Needs a fresh seed (any creature) that hits exactly one effect-consumed wait and no same-lap
    // reactivation; the censoring LOGIC is unchanged.
    test.skip("censors strict-rollout effect-consumed waits without reporting a missed reactivation", () => {
        // A wait consumed by a live effect before the unit can reactivate is a CENSORED lifecycle outcome,
        // not a missed opportunity or an avoidable policy wait -- that distinction is what this test exists
        // to hold, and the counts below only matter as evidence the path was actually walked.
        //
        // Frenzied Boar's 240/42 -> 220/40 durability change moved the old game off this lifecycle, and
        // Battle Mage's 21 -> 19 hp moved it again (game 464's Troglodyte lost the effect-consumed wait).
        // Beholder's 15 -> 16 attack moved it a third time (game 446's Crusader picked up a second,
        // normal wait, losing the pure shape). Game 471's Griffin walks the same censored path: a single
        // wait consumed by a live effect before reactivation, found by the usual panel scan.
        const record = runV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 471);
        expect(record.endReason).toBe("elimination");
        const censored = record.byCreature.Griffin;
        expect(censored.waitsSkippedByEffectBeforeReactivation).toBeGreaterThan(0);
        expect(censored.waitsSkippedByEffectBeforeReactivation).toBe(1);
        // Exactly the effect-consumed wait, no normal same-lap pair — which is the censoring under test.
        expect(censored.waitTurns).toBe(1);
        expect(censored.sameLapWaitReactivations).toBe(0);
        // The censoring must not be reported as a miss, here or in the run-wide metric.
        expect(censored.missedSameLapWaitReactivations).toBe(0);
        expect(censored.avoidableWaitTurns).toBe(0);
        expect(record.metrics.missedSameLapWaitReactivations).toBe(0);
    });
});
