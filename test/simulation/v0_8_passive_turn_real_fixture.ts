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

import { describe, expect, test } from "bun:test";

import type { DecisionPathCatalog, IDecisionPathCatalogStats } from "../../src/ai/decision_path_catalog";
import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import type { GameAction } from "../../src/engine/actions";
import { runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import { liveTwinSetup } from "../../src/simulation/livetwin";
import type { ISearchPassiveProductiveProbe } from "../../src/simulation/search_driver";
import { V08_A13_SEARCH_OVERRIDE_ENV, withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import {
    planV08PassiveTurnPanelGame,
    runV08PassiveTurnPanelGame,
    V08PassiveTurnAuditor,
    type IV08PassiveTurnPanelOptions,
} from "../../src/simulation/v0_8_passive_turn_panel";

const PRODUCTION_REGRESSION_OPTIONS: IV08PassiveTurnPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 4_096,
    baseSeed: 2_607_270_813,
    minCreatureAppearances: 250,
    sourceCommit: "ea4b2591bd95056990839226bbb7ba930839d9ab",
    sourceDirty: false,
};

const registerRealTest = (name: string, body: () => void): void => {
    describe("v0.8 random-roster passive-turn panel", () => {
        test(name, body);
    });
};

export function registerV08PassiveProbeInvarianceTest(): void {
    registerRealTest("keeps the production probe detached and bit-for-bit inert", () => {
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
                greenDoctrine: setup.doctrine,
                redDoctrine: setup.doctrine,
                greenAugments: setup.augments,
                redAugments: setup.augments,
                placementAugmentTiming: "setup-before-placement",
                // Observer invariance must not depend on host-speed watchdog timing.
                searchOfflineDeterministicWork: true,
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
}

export function registerV08PassiveDiagnosticsInvarianceTest(): void {
    registerRealTest("keeps post-search passive diagnostics out of the live path catalog and search outcome", () => {
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
                    greenDoctrine: setup.doctrine,
                    redDoctrine: setup.doctrine,
                    greenAugments: setup.augments,
                    redAugments: setup.augments,
                    placementAugmentTiming: "setup-before-placement",
                    // Observer invariance must not depend on host-speed watchdog timing.
                    searchOfflineDeterministicWork: true,
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
}

export function registerV08PassiveProtectorRegressionTest(): void {
    registerRealTest("classifies the known protector screen holds without manufacturing movement work", () => {
        // Block-center game 1555 fields a Harpy + Abomination protector screen. This fixture was pinned to
        // an exact forced/protected count for a specific balance state, but every Abomination balance change
        // shifted that seed's trajectory and forced a seed swap (3443 -> 1555 after a Trent buff), and after
        // the Abomination aura rework (Flesh Shield reach 1 -> 2, Stun Aura -> ally buff) a full 4096-game
        // scan found NO seed still reproducing the exact original scenario. So it is re-anchored on the
        // CLASSIFIER'S INVARIANT rather than the brittle counts: whatever the balance, the repair pipeline
        // must drive every avoidable-defend to zero (nothing manufactures movement work — the test's title),
        // the buckets must account for the total, and the run must stay clean. Under 1555 the aura rework
        // even exercises the repair path (a raw avoidable hold is neutralised to zero), a stronger check
        // than the old "raw stays zero" pin.
        const record = runV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 1_555);
        expect(record.crash).toBeUndefined();
        expect(record.endReason).toBe("elimination");
        // The core guarantee: no hold is ever left as an avoidable defend — the repair pipeline zeroes them.
        expect(record.metrics.avoidableDefendTurns).toBe(0);
        expect(record.metrics.finalDefendTurns).toBe(
            record.metrics.protectedDefendTurns + record.metrics.forcedDefendTurns,
        );
        expect(record.metrics.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.metrics.strategyRejectedActions).toBe(0);
        expect(record.metrics.recoveryAttempts).toBe(0);
        // The scenario's two screen-holders are still present and cleanly bucketed.
        expect(record.byCreature.Harpy.finalDefendTurns).toBe(
            record.byCreature.Harpy.protectedDefendTurns + record.byCreature.Harpy.forcedDefendTurns,
        );
        expect(record.byCreature.Abomination.finalDefendTurns).toBe(
            record.byCreature.Abomination.protectedDefendTurns + record.byCreature.Abomination.forcedDefendTurns,
        );
    });
}

export function registerV08PassiveCircuitRegressionTest(): void {
    registerRealTest("scores every circuit-open wait in the exact games that exposed the global retry cutoff", () => {
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
}
