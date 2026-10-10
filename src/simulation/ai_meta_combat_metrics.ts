import type { IAiMetaFightEvidence } from "./ai_meta_evidence";
import { summarizePremiumParticipation, type IPremiumCombatParticipation } from "./ai_meta_participation";
import type { ISecondaryDamage, IVisibleDamage } from "../scene/animations";

export const PREMIUM_COMBAT_METRICS_SCHEMA = "premium-combat-metrics-v1";
export const PREMIUM_COMBAT_UNIT_METRICS_V1 = {
    stacks: "Drafted stacks including split children; summons excluded",
    activations: "Committed next-unit selections",
    completedTurns: "Committed turn completions, including hourglass completions",
    waits: "Wait events",
    effectSkips: "Turns skipped with the effect reason",
    explicitMoves: "Explicit move events; excludes implicit melee approach",
    reportedDamageReceivedHp: "HP in detailed attack, spell, secondary and environmental payloads; incomplete ledger",
    attributedDamageDealtHp:
        "Reported HP with an explicit actor; excludes ambiguous secondary and legacy splash ownership",
    spellHealingGivenHp: "Actual healing in spell payloads",
    spellResurrectionGivenHp: "HP restored by resurrection spell payloads",
    devourHealingHp: "HP restored by reported Devour Essence triggers",
    waterShieldAbsorbedHp: "Reported Water Shield absorption, separate from damage",
    fleshShieldRedirectedHp: "HP taken by the Flesh Shield absorber, not counterfactual prevented damage",
    poisonHp: "Reported poison damage received; poison source is not attributed",
    fireWallHp: "Reported fire-wall damage received; wall ownership is not attributed",
    deathsBeforeFirstAction: "Stacks with a death notification before their first recorded action",
} as const;
/** Indexed derivation version; committed raw stack summaries remain compatible with v1. */
export const PREMIUM_COMBAT_UNIT_METRICS_SCHEMA = "premium-combat-unit-metrics-v2";
export const PREMIUM_COMBAT_UNIT_METRICS = {
    ...PREMIUM_COMBAT_UNIT_METRICS_V1,
    hourglassCompletions: "Hourglass turn completions; a subset of completedTurns, not extra turns",
    defends: "Committed defend events",
    timeoutSkips: "Turn skips explicitly attributed to timeout",
    manualSkips: "Turn skips explicitly attributed to manual input",
    otherSkips: "Turn skips with the generic skip reason",
    positiveMorale: "Positive morale events, not guaranteed extra actions",
    negativeMorale: "Negative morale events, not additional effect-skip events",
    reportedRouteCells: "Reported path-array entries for explicit moves, not movement cost or distance",
    systemMoves: "System relocation events, including narrowing",
    offensiveStacks: "Stacks with a recorded unit/area attack or non-reflected damaging spell",
    stacksWithoutRecordedOffense: "Stacks without a recorded offensive action; support actions are not offense",
    firstOffenseLapTotal: "Sum of first offensive lap numbers; divide by offensiveStacks for timing, not stacks",
    activationsThroughFirstOffense:
        "Sum of activations through each stack's first offense, including the current activation; denominator offensiveStacks",
    primaryEnemyTargetIncidences:
        "Sum of per-stack distinct primary enemy targets; the same target can count for multiple split children",
    openingMeasuredStacks: "Stacks with measured first-decision footprint geometry",
    openingEnemyDistanceMeasuredStacks:
        "Opening stacks with at least one enemy footprint; denominator for distance totals",
    openingNearestEnemyCellTotal:
        "Sum of minimum footprint Chebyshev enemy distances; divide by openingEnemyDistanceMeasuredStacks, not path cost",
    openingAdjacentAlliedStackTotal:
        "Sum of adjacent allied stack counts at first decision; symmetric neighbors count twice, not aura beneficiaries",
    reportedCreatureLosses:
        "Reported creatures lost across damage payloads; resurrection can restore them, not permanent kills",
    reportedMissesReceived: "Detailed missed attack entries targeting this stack, not all attack attempts",
    spellHealingReceivedHp: "Actual healing received in spell payloads, overlapping health-ledger healing",
    spellResurrectionReceivedHp: "Resurrection HP received in spell payloads, overlapping health-ledger resurrection",
    waterShieldTriggers: "Reported Water Shield trigger entries",
    spellTargetOutcomes: "Spell target-outcome entries, not spell casts or guaranteed successful effects",
    abilityTransfersGiven: "Recorded ability transfer entries originating from this stack",
    abilityTransfersReceived: "Recorded ability transfer entries received by this stack",
    armageddonHp: "Reported environmental Armageddon damage received; no player ownership inferred",
    recordedActions: "Recorded attack, move, spell, wait, defend and skip events; not all are productive actions",
    spellCasts: "Committed spell-cast events, including support spells; separate from per-target outcomes",
    effectsAppliedReceived: "Reported non-resisted effect applications received; not duration, uptime or source credit",
    effectsResistedReceived: "Reported resisted effect applications received; not all resistance checks",
    summonedCreatures: "Creature amounts in summon events credited to this caster, including merged reinforcement",
} as const;
type Moment = { lap: number; eventIndex: number };
type Input = Pick<
    IAiMetaFightEvidence,
    "aIsGreen" | "formations" | "firstDecisionState" | "terminalState" | "committedEventBatches"
>;

export interface IPremiumStackCombatMetrics {
    unitId: string;
    army: "a" | "b" | null;
    origin: "drafted" | "summoned" | "unknown";
    draftedCreatureIds: number[];
    activations: number;
    completedTurns: number;
    hourglassCompletions: number;
    waits: number;
    defends: number;
    skips: Record<string, number>;
    morale: Record<string, number>;
    explicitMoves: number;
    reportedRouteCells: number;
    systemMoves: number;
    firstOffensiveAction: Moment | null;
    activationsBeforeFirstOffense: number | null;
    diedBeforeFirstAction: boolean | null;
    distinctPrimaryEnemyTargets: string[];
    opening: { nearestEnemyCells: number | null; adjacentAlliedStacks: number } | null;
    /** Reported HP only, not a complete HP ledger or causal contribution. */
    damageReceivedHp: Record<string, number>;
    attributedDamageDealtHp: Record<string, number>;
    reportedCreatureLosses: Record<string, number>;
    reportedMissesReceived: number;
    spellHealingGivenHp: number;
    spellHealingReceivedHp: number;
    spellResurrectionGivenHp: number;
    spellResurrectionReceivedHp: number;
    devourHealingHp: number;
    waterShieldAbsorbedHp: number;
    waterShieldTriggers: number;
    fleshShieldRedirectedHp: number;
    spellOutcomes: Record<string, number>;
    abilityTransfersGiven: Record<string, number>;
    abilityTransfersReceived: Record<string, number>;
}

export interface IPremiumCombatMetrics {
    schema: typeof PREMIUM_COMBAT_METRICS_SCHEMA;
    eventCoverage: "committed-batches" | "unavailable";
    stacks: IPremiumStackCombatMetrics[];
    damageWithoutSourceHp: Record<string, number>;
    coverage: {
        attackEvents: number;
        attacksWithoutDetailedHp: number;
        attacksWithUnassignedHp: number;
        unknownStackIds: string[];
    };
    limitations: readonly string[];
}

const add = (counts: Record<string, number>, key: string, amount = 1) => {
    counts[key] = (counts[key] ?? 0) + amount;
};
const total = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);

const emptyStack = (id: string): IPremiumStackCombatMetrics => ({
    unitId: id,
    army: null,
    origin: "unknown",
    draftedCreatureIds: [],
    activations: 0,
    completedTurns: 0,
    hourglassCompletions: 0,
    waits: 0,
    defends: 0,
    skips: {},
    morale: {},
    explicitMoves: 0,
    reportedRouteCells: 0,
    systemMoves: 0,
    firstOffensiveAction: null,
    activationsBeforeFirstOffense: null,
    diedBeforeFirstAction: null,
    distinctPrimaryEnemyTargets: [],
    opening: null,
    damageReceivedHp: {},
    attributedDamageDealtHp: {},
    reportedCreatureLosses: {},
    reportedMissesReceived: 0,
    spellHealingGivenHp: 0,
    spellHealingReceivedHp: 0,
    spellResurrectionGivenHp: 0,
    spellResurrectionReceivedHp: 0,
    devourHealingHp: 0,
    waterShieldAbsorbedHp: 0,
    waterShieldTriggers: 0,
    fleshShieldRedirectedHp: 0,
    spellOutcomes: {},
    abilityTransfersGiven: {},
    abilityTransfersReceived: {},
});

/** Read only committed payloads. Never infer HP from the legacy visible-damage headline. */
export function summarizePremiumCombatMetrics(fight: Input): IPremiumCombatMetrics {
    const participation = summarizePremiumParticipation(fight);
    const rows = new Map<string, IPremiumStackCombatMetrics>();
    for (const base of participation.stacks) {
        const row = emptyStack(base.unitId);
        Object.assign(row, {
            army: base.army,
            origin: base.origin,
            draftedCreatureIds: [...base.draftedCreatureIds],
            diedBeforeFirstAction:
                participation.eventCoverage === "unavailable" || !base.firstDeath
                    ? null
                    : !base.firstAction || base.firstDeath.eventIndex < base.firstAction.eventIndex,
            spellHealingGivenHp: base.spellHealingGiven,
            spellHealingReceivedHp: base.spellHealingReceived,
            spellResurrectionGivenHp: base.spellResurrectionHpGiven,
            spellResurrectionReceivedHp: base.spellResurrectionHpReceived,
        });
        rows.set(base.unitId, row);
    }
    // Some secondary/environment recipients never appear in primary action fields.
    const stack = (id: string) => {
        let row = rows.get(id);
        if (!row) {
            // Deliberately not a drafted unit: unknown identity must remain visible to the audit.
            row = emptyStack(id);
            rows.set(id, row);
        }
        return row;
    };
    const opening = fight.firstDecisionState?.units ?? [];
    for (const own of opening) {
        const distances = opening
            .filter((other) => other.properties.id !== own.properties.id)
            .map((other) => ({
                team: other.properties.team,
                distance: Math.min(
                    ...own.cells.flatMap((a) =>
                        other.cells.map((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))),
                    ),
                ),
            }));
        if (!own.cells.length) continue;
        const enemies = distances.filter(
            (other) => other.team !== own.properties.team && Number.isFinite(other.distance),
        );
        stack(own.properties.id).opening = {
            nearestEnemyCells: enemies.length ? Math.min(...enemies.map((other) => other.distance)) : null,
            adjacentAlliedStacks: distances.filter(
                (other) => other.team === own.properties.team && other.distance === 1,
            ).length,
        };
    }
    const damageWithoutSourceHp: Record<string, number> = {};
    const coverage = {
        attackEvents: 0,
        attacksWithoutDetailedHp: 0,
        attacksWithUnassignedHp: 0,
        unknownStackIds: [] as string[],
    };
    const hit = (id: string, hp: number, losses: number, channel: string, actor?: string) => {
        if (!id) return;
        add(stack(id).damageReceivedHp, channel, hp);
        add(stack(id).reportedCreatureLosses, channel, losses);
        if (actor) add(stack(actor).attributedDamageDealtHp, channel, hp);
        else add(damageWithoutSourceHp, channel, hp);
    };
    const secondary = (entries: readonly ISecondaryDamage[]) => {
        for (const entry of entries) {
            const recipient = stack(entry.unitId);
            if (entry.source === "devour_essence") recipient.devourHealingHp += entry.amount;
            else if (entry.source === "water_shield") {
                recipient.waterShieldAbsorbedHp += entry.amount;
                recipient.waterShieldTriggers++;
            } else {
                hit(entry.unitId, entry.amount, entry.unitsDied, `secondary:${entry.source}`);
                if (entry.source === "flesh_shield") recipient.fleshShieldRedirectedHp += entry.amount;
            }
        }
    };
    const attack = (damage: IVisibleDamage | undefined, actor: string, fallbackTarget?: string) => {
        coverage.attackEvents++;
        if (!damage) {
            coverage.attacksWithoutDetailedHp++;
            return;
        }
        secondary(damage.secondary ?? []);
        // Flight splash duplicates the flat splash field; flat splash can duplicate the primary hits.
        if (damage.chakramFlights?.length) {
            if (damage.chakramFlights.some((flight) => !flight.splash.length && !flight.missed))
                coverage.attacksWithoutDetailedHp++;
            for (const flight of damage.chakramFlights) {
                if (!flight.splash.length) {
                    if (flight.missed && flight.primaryTargetId) stack(flight.primaryTargetId).reportedMissesReceived++;
                }
                for (const entry of flight.splash) {
                    if (entry.missed) stack(entry.unitId).reportedMissesReceived++;
                    else hit(entry.unitId, entry.amount, entry.unitsDied, "attack_splash", flight.attackerId);
                }
            }
        } else if (damage.splash?.length) {
            // Older combined splash can contain the response as well: there is no reliable single owner.
            for (const entry of damage.splash) {
                if (entry.missed) stack(entry.unitId).reportedMissesReceived++;
                else hit(entry.unitId, entry.amount, entry.unitsDied, "attack_splash");
            }
        } else if (damage.hits?.length) {
            const target = damage.unitId || fallbackTarget;
            if (target)
                for (const entry of damage.hits) hit(target, entry.amount, entry.unitsDied, "attack_primary", actor);
            else coverage.attacksWithUnassignedHp++;
        } else if (!damage.missed) coverage.attacksWithoutDetailedHp++;
        if (damage.missed && !damage.splash?.length && !damage.chakramFlights?.length) {
            const target = damage.unitId || fallbackTarget;
            if (target) stack(target).reportedMissesReceived++;
        }
    };
    let index = 0;
    for (const batch of fight.committedEventBatches ?? [])
        for (const event of batch.events) {
            const moment = { lap: batch.lap, eventIndex: index++ };
            const offensive = (id: string) => {
                const row = stack(id);
                if (!row.firstOffensiveAction) {
                    row.firstOffensiveAction = moment;
                    // Activations already observed before this action, including its current activation.
                    row.activationsBeforeFirstOffense = row.activations;
                }
            };
            switch (event.type) {
                case "next_unit_selected":
                    stack(event.unitId).activations++;
                    break;
                case "turn_completed":
                    stack(event.unitId).completedTurns++;
                    stack(event.unitId).hourglassCompletions += Number(event.hourglass);
                    break;
                case "unit_waited":
                    stack(event.unitId).waits++;
                    break;
                case "unit_defended":
                    stack(event.unitId).defends++;
                    break;
                case "unit_skipped":
                    add(stack(event.unitId).skips, event.reason);
                    break;
                case "morale_applied":
                    add(stack(event.unitId).morale, event.kind);
                    break;
                case "unit_moved":
                    stack(event.unitId).explicitMoves++;
                    stack(event.unitId).reportedRouteCells += event.path.length;
                    break;
                case "unit_moved_by_system":
                    stack(event.unitId).systemMoves++;
                    break;
                case "unit_attacked": {
                    offensive(event.attackerId);
                    const source = stack(event.attackerId),
                        target = event.targetId ? stack(event.targetId) : null;
                    if (
                        target?.army &&
                        source.army &&
                        target.army !== source.army &&
                        !source.distinctPrimaryEnemyTargets.includes(target.unitId)
                    )
                        source.distinctPrimaryEnemyTargets.push(target.unitId);
                    attack(event.damage, event.attackerId, event.targetId);
                    break;
                }
                case "area_attacked":
                    offensive(event.attackerId);
                    attack(event.damage, event.attackerId);
                    break;
                case "obstacle_attacked":
                    if (event.damage) attack(event.damage, event.attackerId);
                    break;
                case "spell_cast":
                    if (event.damaged?.some((entry) => !entry.rebounded)) offensive(event.casterId);
                    for (const entry of event.damaged ?? [])
                        hit(
                            entry.unitId,
                            entry.amount,
                            entry.unitsDied,
                            entry.rebounded ? "spell_rebound" : "spell",
                            entry.rebounded ? entry.reboundedFromUnitId : event.casterId,
                        );
                    secondary(event.secondary ?? []);
                    for (const outcome of event.outcomes ?? [])
                        add(stack(event.casterId).spellOutcomes, `${event.spellName}:${outcome.outcome}`);
                    for (const transfer of event.abilityTransfers ?? []) {
                        const key = `${transfer.mode}:${transfer.abilityName}`;
                        add(stack(transfer.fromUnitId).abilityTransfersGiven, key);
                        add(stack(transfer.toUnitId).abilityTransfersReceived, key);
                    }
                    break;
                case "poison_ticked":
                    hit(event.unitId, event.damage, event.unitsDied, "environment:poison");
                    break;
                case "armageddon_applied":
                    hit(event.unitId, event.damage, event.unitsDied, "environment:armageddon");
                    break;
                case "fire_wall_burned":
                    hit(event.unitId, event.amount, event.unitsDied, "environment:fire_wall");
                    break;
            }
        }
    const stacks = [...rows.values()].sort((a, b) => a.unitId.localeCompare(b.unitId));
    for (const row of stacks) row.distinctPrimaryEnemyTargets.sort();
    coverage.unknownStackIds = stacks.filter((row) => !row.draftedCreatureIds.length).map((row) => row.unitId);
    return {
        schema: PREMIUM_COMBAT_METRICS_SCHEMA,
        eventCoverage: participation.eventCoverage,
        stacks,
        damageWithoutSourceHp,
        coverage,
        limitations: [
            "Reported HP is partial: primary attack responses, passive regeneration and many prevention effects lack complete payloads. No legacy headline damage is counted.",
            "Detailed flight splash supersedes flat splash, which supersedes primary hits; the duplicate representations are never added together.",
            "Secondary damage and legacy splash retain unknown source attribution; reflected spell HP is never credited to the original caster.",
            "Water Shield is absorption, Devour Essence is healing, and Flesh Shield is redirected HP taken, not equivalent prevented damage.",
            "Movement counts explicit move events and their reported route cells; implicit melee approach, path cost and aura uptime are not measured.",
            "Opening distance is minimum footprint Chebyshev distance, not a pathfinding or attack-range guarantee. Spell outcomes count target outcomes, not casts.",
            "Creature losses are reported counts, not permanent kills; resurrection can restore them. Missing events are unavailable, not evidence of zero contribution.",
        ],
    };
}

/** Split children aggregate to their drafted creature; summoned output remains separate to avoid ambiguous credit. */
export function premiumDraftedCombatMetrics(
    metrics: IPremiumCombatMetrics,
    participation: IPremiumCombatParticipation,
) {
    if (metrics.eventCoverage !== "committed-batches" || participation.eventCoverage !== "committed-batches")
        throw new Error("Combat unit metrics require committed event coverage");
    const activity = new Map(participation.stacks.map((row) => [row.unitId, row]));
    const groups = new Map<string, { army: "a" | "b"; creatureId: number; values: Record<string, number> }>();
    for (const row of metrics.stacks) {
        if (row.origin !== "drafted" || !row.army || row.draftedCreatureIds.length !== 1) continue;
        const participant = activity.get(row.unitId);
        if (
            !participant ||
            participant.army !== row.army ||
            participant.origin !== row.origin ||
            participant.draftedCreatureIds.length !== 1 ||
            participant.draftedCreatureIds[0] !== row.draftedCreatureIds[0]
        )
            throw new Error("Combat unit metrics require matching participation ancestry");
        const creatureId = row.draftedCreatureIds[0],
            key = `${row.army}:${creatureId}`;
        const group = groups.get(key) ?? { army: row.army, creatureId, values: {} };
        groups.set(key, group);
        const values = {
            stacks: 1,
            activations: row.activations,
            completedTurns: row.completedTurns,
            waits: row.waits,
            effectSkips: row.skips.effect ?? 0,
            explicitMoves: row.explicitMoves,
            reportedDamageReceivedHp: total(row.damageReceivedHp),
            attributedDamageDealtHp: total(row.attributedDamageDealtHp),
            spellHealingGivenHp: row.spellHealingGivenHp,
            spellResurrectionGivenHp: row.spellResurrectionGivenHp,
            devourHealingHp: row.devourHealingHp,
            waterShieldAbsorbedHp: row.waterShieldAbsorbedHp,
            fleshShieldRedirectedHp: row.fleshShieldRedirectedHp,
            poisonHp: row.damageReceivedHp["environment:poison"] ?? 0,
            fireWallHp: row.damageReceivedHp["environment:fire_wall"] ?? 0,
            deathsBeforeFirstAction: Number(row.diedBeforeFirstAction === true),
            hourglassCompletions: row.hourglassCompletions,
            defends: row.defends,
            timeoutSkips: row.skips.timeout ?? 0,
            manualSkips: row.skips.manual ?? 0,
            otherSkips: row.skips.skip ?? 0,
            positiveMorale: row.morale.plus ?? 0,
            negativeMorale: row.morale.minus ?? 0,
            reportedRouteCells: row.reportedRouteCells,
            systemMoves: row.systemMoves,
            offensiveStacks: Number(row.firstOffensiveAction !== null),
            stacksWithoutRecordedOffense: Number(row.firstOffensiveAction === null),
            firstOffenseLapTotal: row.firstOffensiveAction?.lap ?? 0,
            activationsThroughFirstOffense: row.activationsBeforeFirstOffense ?? 0,
            primaryEnemyTargetIncidences: row.distinctPrimaryEnemyTargets.length,
            openingMeasuredStacks: Number(row.opening !== null),
            openingEnemyDistanceMeasuredStacks: Number(row.opening?.nearestEnemyCells != null),
            openingNearestEnemyCellTotal: row.opening?.nearestEnemyCells ?? 0,
            openingAdjacentAlliedStackTotal: row.opening?.adjacentAlliedStacks ?? 0,
            reportedCreatureLosses: total(row.reportedCreatureLosses),
            reportedMissesReceived: row.reportedMissesReceived,
            spellHealingReceivedHp: row.spellHealingReceivedHp,
            spellResurrectionReceivedHp: row.spellResurrectionReceivedHp,
            waterShieldTriggers: row.waterShieldTriggers,
            spellTargetOutcomes: total(row.spellOutcomes),
            abilityTransfersGiven: total(row.abilityTransfersGiven),
            abilityTransfersReceived: total(row.abilityTransfersReceived),
            armageddonHp: row.damageReceivedHp["environment:armageddon"] ?? 0,
            recordedActions: total(participant.actions),
            spellCasts: total(participant.spells),
            effectsAppliedReceived: total(participant.receivedEffects),
            effectsResistedReceived: total(participant.resistedEffects),
            summonedCreatures: participant.summonedAmount,
        };
        for (const [name, value] of Object.entries(values)) add(group.values, name, value);
    }
    return [...groups.values()];
}
