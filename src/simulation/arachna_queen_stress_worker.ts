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

import { parentPort, workerData } from "node:worker_threads";

import { enumerateCandidates } from "../ai";
import type { GameEvent } from "../engine/events";
import { FightStateManager } from "../fights/fight_state_manager";
import type { Unit } from "../units/unit";
import {
    arachnaQueenExpectedSide,
    arachnaQueenStressScenarioForGame,
    buildArachnaQueenStressConfig,
    createArachnaQueenStressTally,
    type IArachnaQueenStressFailure,
    type IArachnaQueenStressOptions,
    type IArachnaQueenStressTally,
} from "./arachna_queen_stress";
import {
    runMatch,
    type IDecisionObservation,
    type ITurnExecutionObservation,
    type IMatchResult,
} from "./battle_engine";

if (!parentPort) throw new Error("arachna_queen_stress_worker must run in a worker thread");

const workerOptions = (workerData as { options?: IArachnaQueenStressOptions } | undefined)?.options;
if (!workerOptions) throw new Error("arachna_queen_stress_worker is missing options");
const options: IArachnaQueenStressOptions = workerOptions;

process.env.SIM_NO_ACTIONS = "1";
FightStateManager.getInstance();

const SPELLBOOK_SPELLS: Readonly<Record<string, ReadonlySet<string>>> = {
    "Book of Healing": new Set(["Heal", "Spiritual Armor", "Blessing", "Mass Heal"]),
    "Forest Spellbook": new Set(["Courage", "Helping Hand", "Summon Wolves"]),
    "Tome of Might": new Set(["Riot", "Magic Mirror", "Mass Riot", "Mass Magic Mirror"]),
};

const SPELLBOOK_INITIAL_CHARGES: Readonly<Record<string, number>> = {
    "Book of Healing": 11,
    "Forest Spellbook": 6,
    "Tome of Might": 6,
};

type SpellOrigin = "direct" | "spellbook";

interface IUnitSnapshot {
    unit: Unit;
    id: string;
    name: string;
    activeAbilities: string[];
    cardAbilities: string[];
    stolenAbilities: string[];
    spells: string[];
    directSpellByAbility: Record<string, string>;
}

interface ITurnSnapshot {
    units: Map<string, IUnitSnapshot>;
}

const increment = (record: Record<string, number>, key: string, amount = 1): void => {
    record[key] = (record[key] ?? 0) + amount;
};

const entrySpellName = (entry: string): string => {
    const separator = entry.indexOf(":");
    return separator >= 0 ? entry.slice(separator + 1) : entry;
};

const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));

const sameMultiset = (left: readonly string[], right: readonly string[]): boolean => {
    const a = sorted(left);
    const b = sorted(right);
    return a.length === b.length && a.every((value, index) => value === b[index]);
};

const snapshotUnit = (unit: Unit): IUnitSnapshot => {
    const properties = unit.getAllProperties();
    const abilities = unit.getAbilities();
    return {
        unit,
        id: unit.getId(),
        name: unit.getName(),
        activeAbilities: abilities.map((ability) => ability.getName()),
        cardAbilities: [...properties.abilities],
        stolenAbilities: [...(properties.stolen_abilities ?? [])],
        spells: [...properties.spells],
        directSpellByAbility: Object.fromEntries(
            abilities
                .map((ability) => [ability.getName(), ability.getSpell()?.getName()] as const)
                .filter((entry): entry is readonly [string, string] => !!entry[1]),
        ),
    };
};

const snapshotTurn = (observation: IDecisionObservation): ITurnSnapshot => ({
    units: new Map(
        [...observation.context.unitsHolder.getAllUnits().values()].map((unit) => [unit.getId(), snapshotUnit(unit)]),
    ),
});

const ownedSpellEntries = (snapshot: IUnitSnapshot, abilityName: string): string[] => {
    const spellbookNames = SPELLBOOK_SPELLS[abilityName];
    if (spellbookNames) {
        return snapshot.spells.filter((entry) => !entry.startsWith(":") && spellbookNames.has(entrySpellName(entry)));
    }
    const directSpell = snapshot.directSpellByAbility[abilityName];
    return directSpell ? snapshot.spells.filter((entry) => entry === `:${directSpell}`) : [];
};

const withoutEntries = (source: readonly string[], removed: readonly string[]): string[] => {
    const remainingToRemove = new Map<string, number>();
    for (const entry of removed) remainingToRemove.set(entry, (remainingToRemove.get(entry) ?? 0) + 1);
    return source.filter((entry) => {
        const remaining = remainingToRemove.get(entry) ?? 0;
        if (remaining <= 0) return true;
        remainingToRemove.set(entry, remaining - 1);
        return false;
    });
};

const countSpellEntries = (entries: readonly string[], spellName: string): number =>
    entries.filter((entry) => entrySpellName(entry) === spellName).length;

function playStressGame(game: number): IArachnaQueenStressTally {
    const tally = createArachnaQueenStressTally();
    const scenario = arachnaQueenStressScenarioForGame(game);
    tally.games = 1;
    increment(tally.scenarioGames, scenario.id);
    let beforeTurn: ITurnSnapshot | undefined;
    const spellOriginsByQueen = new Map<string, Map<string, SpellOrigin>>();

    const failure = (value: Omit<IArachnaQueenStressFailure, "game" | "scenario">): void => {
        tally.invariantFailures += 1;
        if (tally.failures.length < 12) tally.failures.push({ game, scenario: scenario.id, ...value });
    };

    const queenOrigins = (unitId: string): Map<string, SpellOrigin> => {
        let origins = spellOriginsByQueen.get(unitId);
        if (!origins) {
            origins = new Map();
            spellOriginsByQueen.set(unitId, origins);
        }
        return origins;
    };

    const observeDecision = (observation: IDecisionObservation): void => {
        beforeTurn = snapshotTurn(observation);
        if (observation.unit.getName() !== "Arachna Queen") return;
        tally.queenTurns += 1;

        const candidates = enumerateCandidates(observation.unit, observation.context, [...observation.incumbent]);
        const legalSpells = new Set<string>();
        let hasShot = false;
        // Candidate enumeration deduplicates a selected incumbent into kind="incumbent", so preserve its
        // concrete spell/shot capability before inspecting the remaining alternatives.
        for (const action of observation.incumbent) {
            if (action.type === "cast_spell") legalSpells.add(action.spellName);
            if (action.type === "range_attack") hasShot = true;
        }
        for (const candidate of candidates.candidates) {
            if (candidate.kind === "spell" && candidate.spellName) legalSpells.add(candidate.spellName);
            if (candidate.kind === "shot") hasShot = true;
        }
        if (legalSpells.size) tally.queenSpellLegalTurns += 1;
        for (const spellName of legalSpells) increment(tally.legalSpellTurnsBySpell, spellName);
        if (hasShot) tally.queenRangeLegalTurns += 1;
    };

    const postSnapshot = (id: string): IUnitSnapshot | undefined => {
        const prior = beforeTurn?.units.get(id);
        return prior ? snapshotUnit(prior.unit) : undefined;
    };

    const observeTheft = (
        event: Extract<GameEvent, { type: "ability_stolen" }>,
        turnEvents: readonly GameEvent[],
    ): void => {
        tally.steals += 1;
        tally.theftInvariantChecks += 1;
        tally.spellEntryConservationChecks += 1;
        increment(tally.stealsByAbility, event.abilityName);

        const beforeThief = beforeTurn?.units.get(event.thiefId);
        const beforeTarget = beforeTurn?.units.get(event.targetId);
        const afterThief = postSnapshot(event.thiefId);
        const afterTarget = postSnapshot(event.targetId);
        if (!beforeThief || !beforeTarget || !afterThief || !afterTarget) {
            failure({
                kind: "theft_snapshot_missing",
                detail: "pre/post unit snapshot missing for ability_stolen",
                abilityName: event.abilityName,
                thiefId: event.thiefId,
                targetId: event.targetId,
            });
            return;
        }

        const transferred = ownedSpellEntries(beforeTarget, event.abilityName);
        tally.spellEntriesTransferred += transferred.length;
        increment(tally.transfersByAbility, event.abilityName, transferred.length);
        if (new Set(transferred).size < transferred.length) {
            tally.duplicateRemainingEntryTransfers += 1;
        }
        const spellbookInitial = SPELLBOOK_INITIAL_CHARGES[event.abilityName];
        if (spellbookInitial && transferred.length > 0 && transferred.length < spellbookInitial) {
            tally.partialSpellbookTransfers += 1;
            increment(tally.partialTransfersByAbility, event.abilityName);
        }
        const directSpell = beforeTarget.directSpellByAbility[event.abilityName];
        if (directSpell && transferred.length === 0) {
            tally.spentDirectCardThefts += 1;
            increment(tally.spentDirectTheftsByAbility, event.abilityName);
        }

        let expectedTargetSpells = withoutEntries(beforeTarget.spells, transferred);
        // The post snapshot is after the complete turn. An Angel may spend its retained Resurrection
        // charge while dying later in the same attack, independently of the ability that was stolen.
        if (
            turnEvents.some((turnEvent) => turnEvent.type === "unit_resurrected" && turnEvent.unitId === event.targetId)
        ) {
            expectedTargetSpells = withoutEntries(expectedTargetSpells, [":Resurrection"]);
        }
        let expectedThiefSpells = [...beforeThief.spells, ...transferred];
        // A defending Queen can steal Resurrection during its response to the killing blow, then consume
        // that newly received charge immediately when the same attack resolves. The event stream records
        // both facts in order; account for the legitimate one-charge spend instead of reporting charge loss.
        const thiefResurrectedThisTurn = turnEvents.some(
            (turnEvent) => turnEvent.type === "unit_resurrected" && turnEvent.unitId === event.thiefId,
        );
        if (thiefResurrectedThisTurn) {
            expectedThiefSpells = withoutEntries(expectedThiefSpells, [":Resurrection"]);
        }
        if (!sameMultiset(afterTarget.spells, expectedTargetSpells)) {
            failure({
                kind: "victim_spell_entries",
                detail: `expected ${JSON.stringify(sorted(expectedTargetSpells))}, got ${JSON.stringify(sorted(afterTarget.spells))}`,
                abilityName: event.abilityName,
                thiefId: event.thiefId,
                targetId: event.targetId,
            });
        }
        if (!sameMultiset(afterThief.spells, expectedThiefSpells)) {
            failure({
                kind: "thief_spell_entries",
                detail: `expected ${JSON.stringify(sorted(expectedThiefSpells))}, got ${JSON.stringify(sorted(afterThief.spells))}`,
                abilityName: event.abilityName,
                thiefId: event.thiefId,
                targetId: event.targetId,
            });
        }
        if (!afterTarget.cardAbilities.includes(event.abilityName)) {
            failure({
                kind: "victim_card_removed",
                detail: "stolen card must remain visible on the victim",
                abilityName: event.abilityName,
                thiefId: event.thiefId,
                targetId: event.targetId,
            });
        }
        if (
            afterTarget.activeAbilities.includes(event.abilityName) ||
            !afterTarget.stolenAbilities.includes(event.abilityName)
        ) {
            failure({
                kind: "victim_not_disabled",
                detail: "victim still has active mechanics or lacks the stolen marker",
                abilityName: event.abilityName,
                thiefId: event.thiefId,
                targetId: event.targetId,
            });
        }
        const stolenResurrectionConsumed = event.abilityName === "Resurrection" && thiefResurrectedThisTurn;
        if (stolenResurrectionConsumed) {
            if (
                afterThief.activeAbilities.includes("Resurrection") ||
                ownedSpellEntries(afterThief, "Resurrection").length > 0
            ) {
                failure({
                    kind: "thief_resurrection_not_consumed",
                    detail: "same-turn stolen Resurrection remained active after resurrecting the thief",
                    abilityName: event.abilityName,
                    thiefId: event.thiefId,
                    targetId: event.targetId,
                });
            }
        } else if (!afterThief.activeAbilities.includes(event.abilityName)) {
            failure({
                kind: "thief_not_active",
                detail: "thief did not receive active stolen mechanics",
                abilityName: event.abilityName,
                thiefId: event.thiefId,
                targetId: event.targetId,
            });
        }

        if (afterThief.name === "Arachna Queen") {
            const origin: SpellOrigin | undefined = spellbookInitial ? "spellbook" : directSpell ? "direct" : undefined;
            if (origin) {
                const origins = queenOrigins(event.thiefId);
                for (const entry of transferred) origins.set(entrySpellName(entry), origin);
            }
        }
    };

    const observeQueenAction = (observation: ITurnExecutionObservation): void => {
        if (observation.creatureName !== "Arachna Queen") return;
        const beforeQueen = beforeTurn?.units.get(observation.unitId);
        const afterQueen = postSnapshot(observation.unitId);
        for (const execution of observation.strategyActions) {
            const action = execution.action;
            if (action.type === "cast_spell") {
                tally.queenSpellChosen += 1;
                increment(tally.chosenSpellCastsBySpell, action.spellName);
                const beforeCharges = beforeQueen ? countSpellEntries(beforeQueen.spells, action.spellName) : 0;
                if (beforeCharges <= 0) {
                    tally.queenCastsAtZero += 1;
                    failure({
                        kind: "queen_cast_at_zero",
                        detail: "Queen proposed a spell after its final raw spell entry was consumed",
                        spellName: action.spellName,
                        thiefId: observation.unitId,
                    });
                }
                if (!execution.completed) {
                    tally.queenSpellRejected += 1;
                    continue;
                }
                tally.queenSpellCompleted += 1;
                tally.queenSpellChargeChecks += 1;
                increment(tally.completedSpellCastsBySpell, action.spellName);
                const origin = spellOriginsByQueen.get(observation.unitId)?.get(action.spellName) ?? "unknown";
                increment(tally.completedSpellCastsByOrigin, origin);
                const afterCharges = afterQueen ? countSpellEntries(afterQueen.spells, action.spellName) : -1;
                if (afterCharges !== beforeCharges - 1) {
                    failure({
                        kind: "queen_cast_charge_delta",
                        detail: `spell charge count changed ${beforeCharges} -> ${afterCharges}, expected -1`,
                        spellName: action.spellName,
                        thiefId: observation.unitId,
                    });
                }
                if (
                    !execution.events.some(
                        (event) => event.type === "spell_cast" && event.casterId === observation.unitId,
                    )
                ) {
                    failure({
                        kind: "queen_cast_event_missing",
                        detail: "completed cast lacks spell_cast event",
                        spellName: action.spellName,
                        thiefId: observation.unitId,
                    });
                }
            } else if (action.type === "range_attack") {
                tally.queenRangeChosen += 1;
                if (!execution.completed) {
                    tally.queenRangeRejected += 1;
                    continue;
                }
                tally.queenRangeCompleted += 1;
                if (
                    !execution.events.some(
                        (event) =>
                            event.type === "unit_attacked" &&
                            event.attackType === "range" &&
                            event.attackerId === observation.unitId,
                    )
                ) {
                    failure({
                        kind: "queen_range_event_missing",
                        detail: "completed Queen range attack lacks a ranged unit_attacked event",
                        thiefId: observation.unitId,
                    });
                }
            }
        }
    };

    const observeExecution = (observation: ITurnExecutionObservation): void => {
        for (const event of observation.events) {
            if (event.type === "ability_stolen") observeTheft(event, observation.events);
        }
        observeQueenAction(observation);
    };

    const recordResult = (result: IMatchResult): void => {
        increment(tally.endReasons, result.endReason);
        if (result.endReason === "stuck") tally.stuck += 1;
        if (result.endReason === "turn_cap") tally.turnCaps += 1;
        const rejected = (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0);
        tally.strategyRejections += rejected;
        for (const detail of result.rejectedDetails ?? []) {
            increment(tally.rejectionReasons, `${detail.type}:${detail.reason ?? "unknown"}`);
        }

        const expectedSide = arachnaQueenExpectedSide(game);
        const expectedPlacements = expectedSide === "green" ? result.placements.green : result.placements.red;
        const oppositePlacements = expectedSide === "green" ? result.placements.red : result.placements.green;
        const expectedCount = expectedPlacements.filter((entry) => entry.creatureName === "Arachna Queen").length;
        const oppositeCount = oppositePlacements.filter((entry) => entry.creatureName === "Arachna Queen").length;
        if (expectedCount === 1 && oppositeCount === 0) {
            tally.queenPlacementGames += 1;
        } else {
            failure({
                kind: "queen_placement",
                detail: `expected one Queen on ${expectedSide}; observed ${expectedCount} expected-side and ${oppositeCount} opposite-side`,
            });
        }
    };

    try {
        const result = runMatch({
            ...buildArachnaQueenStressConfig(options, game),
            decisionObserver: observeDecision,
            turnExecutionObserver: observeExecution,
        });
        recordResult(result);
    } catch (error) {
        tally.crashes += 1;
        tally.failures.push({
            game,
            scenario: scenario.id,
            kind: "crash",
            detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
    return tally;
}

parentPort.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({ type: "result", tally: playStressGame(message.game) });
    } catch (error) {
        parentPort!.postMessage({
            type: "fatal",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
