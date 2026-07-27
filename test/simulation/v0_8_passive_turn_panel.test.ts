import { describe, expect, test } from "bun:test";

import type { IEnumeratedCandidate } from "../../src/ai/candidates";
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
    runV08PassiveTurnPanelGame,
    summarizeV08PassiveTurnPanel,
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
    sourceCommit: "test-source",
};

const PRODUCTION_REGRESSION_OPTIONS: IV08PassiveTurnPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 4_096,
    baseSeed: 2_607_270_813,
    minCreatureAppearances: 250,
    sourceCommit: "ea4b2591bd95056990839226bbb7ba930839d9ab",
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
const end = (unitId: string): GameAction => ({ type: "end_turn", unitId });

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
    return {
        schema: V08_PASSIVE_TURN_PANEL_SCHEMA,
        game,
        pair: plan.pair,
        seed: plan.seed,
        mapType: plan.mapType,
        candidateVersion: OPTIONS.candidateVersion,
        opponentVersion: OPTIONS.opponentVersion,
        candidateSide: plan.candidateSide,
        candidateRoster: candidateRoster.map(({ creatureName }) => creatureName),
        opponentRoster: opponentRoster.map(({ creatureName }) => creatureName),
        winner: "candidate",
        laps: 5,
        endReason: "elimination",
        candidateEngineRejections: 0,
        metrics,
        byCreature,
    };
};

describe("v0.8 random-roster passive-turn panel", () => {
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
        rejectedMirror.observeProductiveProbe({
            unitId: "invalid",
            hasEngineValidProductiveAlternative: false,
        });
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
        acceptedMirror.observeProductiveProbe({
            unitId: "valid",
            hasEngineValidProductiveAlternative: true,
        });
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
        expect(passing.gates.pass).toBe(true);
        expect(passing.gates.failed).toEqual([]);
        expect(passing.planSha256).toBe(fingerprintV08PassiveTurnPanelPlan(OPTIONS));

        const failing = records.map((record) => ({
            ...record,
            metrics: { ...record.metrics },
            byCreature: Object.fromEntries(
                Object.entries(record.byCreature).map(([name, metrics]) => [name, { ...metrics }]),
            ),
        }));
        failing[0].metrics.rawEndTurnTurns = 1;
        failing[0].metrics.avoidableDefendTurns = 1;
        failing[0].metrics.missedSameLapWaitReactivations = 1;
        failing[0].metrics.strategyRejectedActions = 1;
        failing[0].byCreature.Abomination = emptyV08PassiveTurnMetrics();
        failing[0].byCreature.Abomination.rawEndTurnTurns = 1;
        failing[1].byCreature["Arachna Queen"] = emptyV08PassiveTurnMetrics();
        failing[1].byCreature["Arachna Queen"].recoveryAttempts = 1;
        const summary = summarizeV08PassiveTurnPanel(OPTIONS, failing);
        expect(summary.gates.pass).toBe(false);
        expect(summary.gates.failed).toContain("raw_end_turn_zero");
        expect(summary.gates.failed).toContain("strategy_rejections_zero");
        expect(summary.gates.failed).toContain("avoidable_defends_zero");
        expect(summary.gates.failed).toContain("missed_wait_reactivations_zero");
        expect(summary.gates.failed).toContain("abomination_faults_zero");
        expect(summary.gates.failed).toContain("arachna_queen_faults_zero");

        const appearanceGate = summarizeV08PassiveTurnPanel({ ...OPTIONS, minCreatureAppearances: 1 }, records);
        expect(appearanceGate.gates.checks.enabled_creature_appearances.pass).toBe(false);
        expect(appearanceGate.underrepresentedCreatures.length).toBeGreaterThan(0);
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
        expect(record.metrics.appearances).toBe(6);
        expect(record.metrics.turns).toBeGreaterThan(0);
        expect(record.metrics.observerPairingFaults).toBe(0);
    });

    test("classifies the known protector screen holds without manufacturing movement work", () => {
        // Block-center game 3443 has no attacks, casts, catch-up, local threat, or newly covered ward available
        // to Harpy/Abomination on its post-hourglass holds. Alternatives either leave the screen or move
        // laterally inside the same state, so those final shields are protected rather than avoidable.
        const record = runV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 3_443);
        expect(record.endReason).toBe("elimination");
        expect(record.metrics.rawAvoidableDefendTurns).toBe(0);
        expect(record.metrics.repairedRawAvoidableDefendTurns).toBe(0);
        expect(record.metrics.avoidableDefendTurns).toBe(0);
        expect(record.metrics.finalDefendTurns).toBe(record.metrics.protectedDefendTurns);
        expect(record.metrics.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.metrics.strategyRejectedActions).toBe(0);
        expect(record.metrics.recoveryAttempts).toBe(0);
        expect(record.byCreature.Harpy.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.byCreature.Abomination.protectedDefendTurns).toBeGreaterThan(0);
        expect(record.byCreature.Harpy.finalDefendTurns).toBe(record.byCreature.Harpy.protectedDefendTurns);
        expect(record.byCreature.Abomination.finalDefendTurns).toBe(record.byCreature.Abomination.protectedDefendTurns);
    });

    test("censors a waited unit skipped by a live effect instead of reporting a missed reactivation", () => {
        // Lava game 2 waits Mermaid twice after the damage-spell policy lets Battle Mage preserve the back line:
        // one wait reactivates normally and the other is consumed by a live effect before Strategy/SearchDriver
        // is called. The battle-event hook is the only observer of the effect-consumed turn.
        const record = runV08PassiveTurnPanelGame(PRODUCTION_REGRESSION_OPTIONS, 2);
        expect(record.endReason).toBe("elimination");
        expect(record.byCreature.Mermaid.waitTurns).toBe(2);
        expect(record.byCreature.Mermaid.sameLapWaitReactivations).toBe(1);
        expect(record.byCreature.Mermaid.waitsSkippedByEffectBeforeReactivation).toBe(1);
        expect(record.byCreature.Mermaid.missedSameLapWaitReactivations).toBe(0);
        expect(record.metrics.missedSameLapWaitReactivations).toBe(0);
    });
});
