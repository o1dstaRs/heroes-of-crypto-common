/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import { creatureInfo, creatureIdForName } from "../ai/setup/creature_score";
import { createV08A19RoleStrategy } from "../ai/versions/v0_8_a19_role_strategy";
import { roleSearchPlan, v08A19RoleSearchOverrides } from "../ai/versions/v0_8_a19_role_plan";
import { PBTypes } from "../generated/protobuf/v1/types";
import { materializeReplayAbSplits } from "./ranked_replay_tactics_ab_core";
import type { IArmyUnitSpec } from "./army";
import type { IMatchConfig, ISetupAugment, Side } from "./battle_engine";
import { withScopedAIEnvironment } from "./v0_8_a13_search";

export const V08_A19_ROLE_CANDIDATE_ID = "a19-own-role-training-v1" as const;
const mergedRoster = (roster: readonly IArmyUnitSpec[]): IArmyUnitSpec[] => {
    const grouped = new Map<string, IArmyUnitSpec>();
    for (const spec of roster) {
        const key = JSON.stringify([spec.faction, spec.creatureName, spec.level]);
        const old = grouped.get(key);
        if (old) old.amount += spec.amount;
        else grouped.set(key, { ...spec });
    }
    return [...grouped.values()];
};
function applyInitialRoleSetup(config: IMatchConfig, side: Side): void {
    const augmentKey = side === "green" ? "greenAugments" : "redAugments",
        rosterKey = side === "green" ? "roster" : "redRoster",
        synergyKey = side === "green" ? "greenSynergies" : "redSynergies",
        splitKey = side === "green" ? "greenTacticalSplitStacks" : "redTacticalSplitStacks";
    const augments = config[augmentKey];
    if (!augments?.some((a) => a.kind === "Might" && a.value === 1)) return;
    const own = config[rosterKey];
    if (!own) throw new Error("A19 role candidate requires an explicit completed own roster");
    const identities = [...new Set(own.map((spec) => spec.creatureName))],
        infos = identities.map((name) => creatureInfo(creatureIdForName(name)!)).filter((info) => info !== undefined);
    const ranged = infos.filter((info) => info.ranged).length,
        angel = identities.includes("Angel"),
        blockSupport = config.gridType === PBTypes.GridVals.BLOCK_CENTER && angel && ranged >= 4;
    const merged = mergedRoster(own),
        placementAugments: ISetupAugment[] = augments
            .filter((a) => a.kind !== "Might")
            .concat({ kind: "Placement", value: 1 });
    const trial = materializeReplayAbSplits(
        merged,
        merged.map((spec) => creatureIdForName(spec.creatureName)!),
        placementAugments,
        config[synergyKey] ?? [],
    );
    const currentSplits = (config[splitKey] ?? []).length,
        addsAura = trial.splitRoles.length > currentSplits && trial.splitRoles[currentSplits].role === "aura";
    const directCarry = infos.some((info) => info.level === 4 && !info.ranged && info.rangedSpellDamage),
        addedAura = addsAura ? trial.roster[trial.splitRoles[currentSplits].rosterIndex]?.creatureName : undefined;
    const usefulAura = addsAura && addedAura !== "Peasant" && (addedAura !== "Zena" || ranged >= 4);
    const kind: ISetupAugment["kind"] =
        blockSupport || directCarry ? "Might" : angel && ranged <= 3 ? "Empower" : usefulAura ? "Placement" : "Might";
    const next = augments.filter((a) => a.kind !== "Might").concat({ kind, value: 1 });
    if (kind === "Placement") {
        const split = materializeReplayAbSplits(
            merged,
            merged.map((spec) => creatureIdForName(spec.creatureName)!),
            next,
            config[synergyKey] ?? [],
        );
        if (split.splitRoles.length > currentSplits && split.splitRoles[currentSplits].role !== "bait") {
            config[augmentKey] = next;
            config[rosterKey] = split.roster;
            config[splitKey] = split.splitRoles;
        }
    } else config[augmentKey] = next;
}

/** Research-only setup and match-local strategy. Uses only the chosen seat's completed setup and the public map. */
export function prepareV08A19RoleCandidate(config: IMatchConfig, side: Side): Readonly<Record<string, string>> {
    const ownRosterKey = side === "green" ? "roster" : "redRoster",
        augmentKey = side === "green" ? "greenAugments" : "redAugments",
        splitKey = side === "green" ? "greenTacticalSplitStacks" : "redTacticalSplitStacks";
    if (!config[ownRosterKey]) throw new Error("A19 role candidate requires an explicit completed own roster");

    const inputRoster = structuredClone(config[ownRosterKey]);
    const inputSplits = structuredClone(config[splitKey]);
    const plan = roleSearchPlan(
        inputRoster.map((u) => u.creatureName),
        config.gridType,
    );
    applyInitialRoleSetup(config, side);
    const ownNames = [...new Set(inputRoster.map((unit) => unit.creatureName))] as string[];
    const spellCarry = ownNames.some((name) => {
        const info = creatureInfo(creatureIdForName(name)!)!;
        return info.level === 4 && info.rangedSpellDamage;
    });
    if (
        plan.magic === 1 &&
        plan.ranged <= 2 &&
        spellCarry &&
        !ownNames.some((name) => {
            const info = creatureInfo(creatureIdForName(name)!)!;
            return info.level >= 3 && info.ranged;
        })
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 1 },
            { kind: "Armor", value: 3 },
            { kind: "Empower", value: 3 },
        ];
    }

    if (
        (config.gridType === PBTypes.GridVals.LAVA_CENTER &&
            plan.healer &&
            plan.magic === 0 &&
            plan.ranged === 3 &&
            !plan.artillery) ||
        (plan.magic === 0 && plan.ranged === 3 && !plan.artillery && !plan.areaCarry && !plan.healer) ||
        (config.gridType === PBTypes.GridVals.BLOCK_CENTER &&
            plan.artillery &&
            plan.ranged === 3 &&
            plan.magic >= 1 &&
            ownNames.some((name) =>
                creatureInfo(creatureIdForName(name)!)?.abilities.includes("Rallying Volley Aura"),
            ) &&
            ownNames.some((name) => creatureInfo(creatureIdForName(name)!)?.castsAmplifiableBuff))
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 1 },
            { kind: "Might", value: 3 },
        ];
    }

    const fleshCarry = ownNames.some((name) => {
        const i = creatureInfo(creatureIdForName(name)!)!;
        return i.level === 4 && i.abilities.includes("Dense Flesh");
    });
    if (
        config.gridType === PBTypes.GridVals.BLOCK_CENTER &&
        plan.magic === 1 &&
        plan.ranged === 3 &&
        !plan.artillery &&
        !plan.areaCarry &&
        !plan.healer &&
        !spellCarry &&
        fleshCarry
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 1 },
            { kind: "Might", value: 3 },
        ];
    }
    const drivenCarry = ownNames.some((name) => {
        const i = creatureInfo(creatureIdForName(name)!)!;
        return i.level === 4 && i.abilities.includes("AI Driven");
    });
    const graceSupport = ownNames.some((name) => {
        const i = creatureInfo(creatureIdForName(name)!)!;
        return i.level === 3 && i.abilities.includes("Borrowed Grace");
    });
    if (
        config.gridType === PBTypes.GridVals.BLOCK_CENTER &&
        plan.magic === 0 &&
        plan.ranged === 3 &&
        !plan.artillery &&
        !plan.areaCarry &&
        !plan.healer &&
        drivenCarry &&
        graceSupport
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 1 },
        ];
    }
    if (
        config.gridType === PBTypes.GridVals.LAVA_CENTER &&
        plan.artillery &&
        plan.magic === 0 &&
        plan.ranged >= 4 &&
        ownNames.some((name) => creatureInfo(creatureIdForName(name)!)?.abilities.includes("Enchants"))
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Placement", value: 2 },
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 2 },
        ];
    }
    if (config.gridType === PBTypes.GridVals.BLOCK_CENTER && spellCarry && plan.magic >= 3 && plan.ranged === 1) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 2 },
            { kind: "Armor", value: 2 },
            { kind: "Empower", value: 3 },
        ];
    }
    if (
        config.gridType === PBTypes.GridVals.NORMAL &&
        plan.artillery &&
        plan.magic === 1 &&
        plan.ranged === 3 &&
        ownNames.some((name) => {
            const info = creatureInfo(creatureIdForName(name)!)!;
            return info.level === 3 && info.melee && info.abilities.includes("Heavy Armor");
        })
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 1 },
            { kind: "Might", value: 3 },
        ];
    }
    if (
        config.gridType === PBTypes.GridVals.NORMAL &&
        plan.healer &&
        plan.magic === 0 &&
        plan.ranged === 3 &&
        ownNames.some((name) => {
            const i = creatureInfo(creatureIdForName(name)!)!;
            return i.level === 3 && i.ranged && i.abilities.includes("Large Caliber");
        })
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 1 },
        ];
    }
    if (
        config.gridType === PBTypes.GridVals.BLOCK_CENTER &&
        plan.magic === 1 &&
        plan.ranged <= 2 &&
        ownNames.some((name) => {
            const i = creatureInfo(creatureIdForName(name)!)!;
            return i.level === 4 && i.abilities.includes("AI Driven");
        })
    ) {
        config[ownRosterKey] = inputRoster;
        config[splitKey] = inputSplits;
        config[augmentKey] = [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: 1 },
            { kind: "Might", value: 3 },
        ];
    }

    config.searchEnvOverrideTeams = [side === "green" ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT];
    const strategy = createV08A19RoleStrategy(ownNames, config.gridType ?? PBTypes.GridVals.NORMAL);
    if (side === "green") config.greenStrategyOverride = strategy;
    else config.redStrategyOverride = strategy;
    return v08A19RoleSearchOverrides(plan);
}

/** Scope research settings to this synchronous simulation; the caller's ambient profile is restored on exit. */
export function withV08A19RoleCandidate<T>(config: IMatchConfig, side: Side, run: () => T): T {
    const overrides = prepareV08A19RoleCandidate(config, side);
    return withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: JSON.stringify(overrides) }, run);
}
