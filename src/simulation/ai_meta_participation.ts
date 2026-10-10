import type { IAiMetaFightEvidence } from "./ai_meta_evidence";
import { PBTypes } from "../generated/protobuf/v1/types";

export const PREMIUM_PARTICIPATION_SCHEMA = "premium-combat-participation-v1";
type Moment = { lap: number; eventIndex: number };

export interface IPremiumStackParticipation {
    unitId: string;
    name: string | null;
    team: number | null;
    army: "a" | "b" | null;
    draftedCreatureIds: number[];
    summonerIds: string[];
    origin: "drafted" | "summoned" | "unknown";
    splitRole: string | null;
    openingAmount: number | null;
    terminal: { alive: boolean; amount: number; hp: number } | null;
    firstActivation: Moment | null;
    firstAction: Moment | null;
    firstTargeted: Moment | null;
    firstDeath: Moment | null;
    actions: Record<string, number>;
    spells: Record<string, number>;
    receivedEffects: Record<string, number>;
    resistedEffects: Record<string, number>;
    spellHealingGiven: number;
    spellHealingReceived: number;
    spellResurrectionHpGiven: number;
    spellResurrectionHpReceived: number;
    summonedAmount: number;
}

export interface IPremiumCombatParticipation {
    schema: typeof PREMIUM_PARTICIPATION_SCHEMA;
    eventCoverage: "committed-batches" | "unavailable";
    eventCount: number;
    unknownStackIds: string[];
    stacks: IPremiumStackParticipation[];
    limitations: readonly string[];
}

type Input = Pick<
    IAiMetaFightEvidence,
    "aIsGreen" | "formations" | "firstDecisionState" | "terminalState" | "committedEventBatches"
>;
const add = (counts: Record<string, number>, key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
};

/** Derive bounded participation facts once from committed events, never from speculative search traces. */
export function summarizePremiumParticipation(fight: Input): IPremiumCombatParticipation {
    const stacks = new Map<string, IPremiumStackParticipation>();
    const stack = (id: string): IPremiumStackParticipation => {
        let row = stacks.get(id);
        if (!row) {
            row = {
                unitId: id,
                name: null,
                team: null,
                army: null,
                draftedCreatureIds: [],
                summonerIds: [],
                origin: "unknown",
                splitRole: null,
                openingAmount: null,
                terminal: null,
                firstActivation: null,
                firstAction: null,
                firstTargeted: null,
                firstDeath: null,
                actions: {},
                spells: {},
                receivedEffects: {},
                resistedEffects: {},
                spellHealingGiven: 0,
                spellHealingReceived: 0,
                spellResurrectionHpGiven: 0,
                spellResurrectionHpReceived: 0,
                summonedAmount: 0,
            };
            stacks.set(id, row);
        }
        return row;
    };
    for (const army of ["a", "b"] as const) {
        const formation = fight.formations[army];
        formation.unitIdsByStack.forEach((id, index) => {
            const row = stack(id);
            row.name = formation.expandedRoster[index].creatureName;
            row.army = army;
            row.team = (army === "a") === fight.aIsGreen ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
            row.origin = "drafted";
            row.draftedCreatureIds = [formation.draftedCreatureIdsByStack[index]];
            row.splitRole = formation.splitRoles.find((role) => role.rosterIndex === index)?.role ?? null;
        });
    }
    for (const { properties } of fight.firstDecisionState?.units ?? []) {
        const row = stack(properties.id);
        row.name = properties.name;
        row.team = properties.team;
        row.openingAmount = properties.amount_alive;
    }
    for (const { properties, alive, cumulativeHp } of fight.terminalState?.units ?? []) {
        const row = stack(properties.id);
        row.name = properties.name;
        row.team = properties.team;
        row.terminal = { alive, amount: properties.amount_alive, hp: cumulativeHp };
    }
    let eventIndex = 0;
    for (const batch of fight.committedEventBatches ?? []) {
        for (const event of batch.events) {
            const moment = { lap: batch.lap, eventIndex: eventIndex++ };
            const action = (id: string, kind: string) => {
                const row = stack(id);
                row.firstAction ??= moment;
                add(row.actions, kind);
                return row;
            };
            const target = (id: string) => {
                stack(id).firstTargeted ??= moment;
            };
            if (event.type === "next_unit_selected") stack(event.unitId).firstActivation ??= moment;
            if (
                ["unit_moved", "unit_waited", "unit_defended", "unit_skipped"].includes(event.type) &&
                "unitId" in event
            )
                action(event.unitId, event.type);
            if (
                event.type === "unit_attacked" ||
                event.type === "area_attacked" ||
                event.type === "obstacle_attacked"
            ) {
                action(event.attackerId, event.type === "unit_attacked" ? event.attackType : event.type);
                if (event.type === "unit_attacked") target(event.targetId);
                if (event.type === "area_attacked") event.affectedUnitIds.forEach(target);
            }
            if (event.type === "spell_cast") {
                const caster = action(event.casterId, "spell_cast");
                add(caster.spells, event.spellName);
                for (const healed of event.healed ?? []) {
                    caster.spellHealingGiven += healed.amount;
                    stack(healed.unitId).spellHealingReceived += healed.amount;
                }
                for (const raised of event.resurrected ?? []) {
                    caster.spellResurrectionHpGiven += raised.hp;
                    stack(raised.unitId).spellResurrectionHpReceived += raised.hp;
                }
                for (const damaged of event.damaged ?? []) target(damaged.unitId);
            }
            if (event.type === "unit_summoned") {
                const child = stack(event.unitId);
                const caster = stack(event.casterId);
                child.name = event.unitName;
                child.team = event.team;
                if (child.origin === "unknown") child.origin = "summoned";
                if (!child.summonerIds.includes(event.casterId)) child.summonerIds.push(event.casterId);
                caster.summonedAmount += event.amount;
            }
            if (event.type === "effects_applied") {
                for (const effect of event.applications) {
                    const row = stack(effect.unitId);
                    add(effect.resisted ? row.resistedEffects : row.receivedEffects, `${effect.kind}:${effect.name}`);
                }
            }
            if (event.type === "unit_destroyed") stack(event.unitId).firstDeath ??= moment;
            if ("unitIdsDied" in event) for (const id of event.unitIdsDied ?? []) stack(id).firstDeath ??= moment;
        }
    }
    // Merged summons can have multiple ancestors; preserve that ambiguity instead of crediting one caster.
    for (let pass = 0; pass < stacks.size; pass++) {
        let changed = false;
        for (const row of stacks.values()) {
            for (const parentId of row.summonerIds) {
                const parent = stack(parentId);
                if (row.army === null && parent.army !== null) row.army = parent.army;
                for (const id of parent.draftedCreatureIds)
                    if (!row.draftedCreatureIds.includes(id)) {
                        row.draftedCreatureIds.push(id);
                        changed = true;
                    }
            }
        }
        if (!changed) break;
    }
    const rows = [...stacks.values()].sort((a, b) => a.unitId.localeCompare(b.unitId));
    for (const row of rows) {
        row.draftedCreatureIds.sort((a, b) => a - b);
        row.summonerIds.sort();
    }
    return {
        schema: PREMIUM_PARTICIPATION_SCHEMA,
        eventCoverage: fight.committedEventBatches ? "committed-batches" : "unavailable",
        eventCount: eventIndex,
        unknownStackIds: rows.filter((row) => !row.draftedCreatureIds.length).map((row) => row.unitId),
        stacks: rows,
        limitations: [
            "Counts describe committed event payloads; attack counters exclude responses inside an exchange.",
            "Healing and resurrection totals cover spell payloads only; passive healing and prevented damage are excluded.",
            "First targeted includes primary attacks, area targets and spell damage; it is not a complete incoming-damage clock.",
            "A missing terminal stack has unknown terminal state; an earlier death does not exclude later resurrection.",
            "Merged summon ancestry is a set; its output cannot be assigned exclusively to one ancestor.",
        ],
    };
}
