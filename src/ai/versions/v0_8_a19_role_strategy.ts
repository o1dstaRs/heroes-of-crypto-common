/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import type { IAIStrategy, IPlacementContext, IDecisionContext } from "../ai_strategy";
import { creatureInfo, creatureIdForName } from "../setup/creature_score";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { GridType } from "../../generated/protobuf/v1/types_gen";
import type { Unit } from "../../units/unit";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import { StrategyV0_7 } from "./v0_7";
import { layoutRevealPlacement, SPLASH_AOE_ABILITIES } from "./v0_7_placement_reveal";
import { withAreaThrow } from "./area_throw_router";
import { V08A19ChakramDispersionStrategy } from "./v0_8_a19_chakram_dispersion";
import { V08A19CompactPlacementStrategy } from "./v0_8_a19_compact_placement";
import { V08A19BoarBattleMageFlankPlacementStrategy } from "./v0_8_a19_boar_battle_mage_flank_placement";
import { V08A19F184LowerHumanPlacementStrategy } from "./v0_8_a19_f184_lower_human_placement";
import { createV08A19RankedPlacementStrategy } from "./v0_8_a19_profile";
import { roleSearchPlan } from "./v0_8_a19_role_plan";
import {
    supportAgainstPublicFastFlyer,
    casterSupportPlacement,
    V08A19PublicSplashDispersionStrategy,
    screenPublicThroughShotArmy,
    disperseRevealedSplashArmy,
    reflectIncumbentPlacement,
} from "./v0_8_a19_public_placement";

/** Preserves the native A19 initialization and combat policy for the research placement composition. */
function createRoleBaseStrategy(): IAIStrategy {
    const ranked = createV08A19RankedPlacementStrategy(),
        compact = new V08A19CompactPlacementStrategy(ranked);
    const ordinaryCompact = compact.placeArmy.bind(compact);
    compact.placeArmy = (units, context) =>
        context.publicOpponentCreatureIds?.some((id) => {
            const i = creatureInfo(id);
            return i && SPLASH_AOE_ABILITIES.some((a) => i.abilities.includes(a));
        })
            ? ranked.placeArmy(units, context)
            : ordinaryCompact(units, context);
    const strategy = withAreaThrow(
        new V08A19F184LowerHumanPlacementStrategy(new V08A19BoarBattleMageFlankPlacementStrategy(compact)),
    );
    const initialize = strategy.placeArmy.bind(strategy),
        legacy = new StrategyV0_7();
    strategy.placeArmy = (units, context) => {
        const incumbent = initialize(units, context);
        const supportEligible =
            units.some((u) => u.getName() === "Angel") &&
            new Set(units.filter((u) => u.getAttackType() === PBTypes.AttackVals.RANGE).map((u) => u.getName())).size >=
                4;
        const selected =
            context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER && supportEligible
                ? legacy.placeArmy(units, { ...context, setupPlacementPolicy: "legitimate-reveal" })
                : incumbent;
        const ranged = new Set(
            units.filter((u) => u.getAttackType() === PBTypes.AttackVals.RANGE).map((u) => u.getName()),
        ).size;
        const nativeCaster = units.some((u) => creatureInfo(creatureIdForName(u.getName())!)?.nativeSpellbook);
        const enemySplash = context.publicOpponentCreatureIds?.some((id) => {
            const i = creatureInfo(id);
            return i && SPLASH_AOE_ABILITIES.some((a) => i.abilities.includes(a));
        });
        if (
            context.team !== PBTypes.TeamVals.RIGHT ||
            context.grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER ||
            ranged > 2 ||
            !nativeCaster ||
            !enemySplash ||
            !units.some((u) => u.getName() === "Frenzied Boar")
        )
            return selected;
        return reflectIncumbentPlacement(units, context, selected);
    };
    return strategy;
}

function blockedGroundHealerFormation(names: readonly string[], gridType: GridType): boolean {
    const role = roleSearchPlan(names, gridType);
    if (gridType !== PBTypes.GridVals.BLOCK_CENTER || !role.healer || role.magic !== 0) return false;
    return !names.some((name) => {
        const i = creatureInfo(creatureIdForName(name)!)!;
        return i.level < 4 && i.canFly && i.melee;
    });
}

/** Composes the incumbent placement while preserving native initialization and combat decisions. */
function createIncumbentRoleStrategy(names: readonly string[], gridType: GridType, base: IAIStrategy): IAIStrategy {
    if (base.version !== "v0.8") throw new Error("A19 role placement requires a native v0.8 base");
    const ownNames = [...new Set(names)],
        plan = roleSearchPlan(ownNames, gridType);
    const spellCarry = ownNames.some((name) => {
        const info = creatureInfo(creatureIdForName(name)!)!;
        return info.level === 4 && info.rangedSpellDamage;
    });
    const selectedPlan = plan;
    const layer = {
        version: base.version,
        placeArmy: (units: Unit[], context: IPlacementContext) => {
            let selected = base.placeArmy(units, context);
            if (selectedPlan.airSupport) selected = supportAgainstPublicFastFlyer(units, context, selected);
            if (selectedPlan.casterSupport) selected = casterSupportPlacement(units, context, selected, "gap2");
            return selected;
        },
        decideTurn: (unit: Unit, context: IDecisionContext) => base.decideTurn(unit, context),
    };
    const strategy = plan.chakram
        ? plan.magic > 1 || (plan.areaCarry && plan.ranged <= 2) || blockedGroundHealerFormation(ownNames, gridType)
            ? new V08A19ChakramDispersionStrategy(layer, true)
            : new V08A19PublicSplashDispersionStrategy(layer, true)
        : layer;
    const screened = {
        version: strategy.version,
        placeArmy: (units: Unit[], context: IPlacementContext) =>
            screenPublicThroughShotArmy(units, context, strategy.placeArmy(units, context)),
        decideTurn: (unit: Unit, context: IDecisionContext) => strategy.decideTurn(unit, context),
    };
    const splash = {
        version: screened.version,
        placeArmy: (units: Unit[], context: IPlacementContext) => {
            const incumbent = screened.placeArmy(units, context);
            const revealed = [...new Set(context.publicOpponentCreatureIds ?? [])]
                .map((id) => creatureInfo(id))
                .filter((info) => info !== undefined);
            const rapidChargeThroughShot =
                context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                selectedPlan.magic >= 2 &&
                selectedPlan.ranged <= 2 &&
                ownNames.some((name) => creatureInfo(creatureIdForName(name)!)?.abilities.includes("Rapid Charge")) &&
                revealed.some((info) => info.abilities.includes("Through Shot"));
            if (
                context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                selectedPlan.areaCarry &&
                selectedPlan.magic === 1 &&
                selectedPlan.ranged === 3 &&
                revealed.some((info) => info.abilities.includes("Through Shot"))
            )
                return layoutRevealPlacement(units, context, {
                    gap: 1,
                    screenShooters: true,
                    cornerShift: false,
                    physicalMeleeMagicRoles: true,
                    screenBacklineProtectors: true,
                });
            if (
                spellCarry &&
                selectedPlan.magic === 1 &&
                ((selectedPlan.ranged <= 2 && revealed.some((info) => info.abilities.includes("Area Throw"))) ||
                    (context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                        selectedPlan.ranged >= 3 &&
                        !ownNames.some((name) =>
                            creatureInfo(creatureIdForName(name)!)?.abilities.includes("Rapid Charge"),
                        ) &&
                        revealed.some(
                            (info) => info.abilities.includes("Area Throw") || info.abilities.includes("Large Caliber"),
                        )))
            )
                return incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.LAVA_CENTER &&
                spellCarry &&
                selectedPlan.magic >= 2 &&
                selectedPlan.ranged >= 3
            )
                return incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                selectedPlan.healer &&
                selectedPlan.magic === 0 &&
                selectedPlan.ranged <= 2 &&
                revealed.filter((info) => info.ranged).length >= 3
            )
                return incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                selectedPlan.healer &&
                selectedPlan.magic >= 2 &&
                selectedPlan.ranged <= 2 &&
                revealed.filter((info) => info.ranged).length >= 3
            )
                return revealed.some(
                    (info) => info.abilities.includes("Area Throw") || info.abilities.includes("Large Caliber"),
                )
                    ? disperseRevealedSplashArmy(units, context, incumbent)
                    : incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                selectedPlan.healer &&
                selectedPlan.magic >= 1 &&
                selectedPlan.ranged <= 2 &&
                revealed.filter((info) => info.ranged).length >= 3 &&
                revealed.some((info) => info.abilities.includes("Through Shot"))
            )
                return incumbent;
            if (
                context.team === PBTypes.TeamVals.RIGHT &&
                context.grid.getGridType() === PBTypes.GridVals.NORMAL &&
                selectedPlan.artillery &&
                selectedPlan.magic === 0 &&
                selectedPlan.ranged >= 4 &&
                revealed.some((info) => info.level === 4 && info.canFly && info.melee)
            )
                return reflectIncumbentPlacement(units, context, incumbent);
            const groundedMeleeCarry = ownNames.some((name) => {
                const info = creatureInfo(creatureIdForName(name)!)!;
                return info.level === 4 && !info.canFly && info.melee;
            });
            const lowerFlyer = ownNames.some((name) => {
                const info = creatureInfo(creatureIdForName(name)!)!;
                return info.level < 4 && info.canFly && info.melee;
            });
            const lowerLargeCaliber = ownNames.some((name) => {
                const info = creatureInfo(creatureIdForName(name)!)!;
                return info.level === 3 && info.abilities.includes("Large Caliber");
            });
            const preserveNativeRole =
                (context.grid.getGridType() === PBTypes.GridVals.NORMAL &&
                    spellCarry &&
                    selectedPlan.magic === 1 &&
                    selectedPlan.ranged === 4 &&
                    !lowerLargeCaliber) ||
                (context.grid.getGridType() === PBTypes.GridVals.LAVA_CENTER &&
                    groundedMeleeCarry &&
                    !selectedPlan.artillery &&
                    !selectedPlan.areaCarry &&
                    !selectedPlan.healer &&
                    !spellCarry &&
                    selectedPlan.magic === 0 &&
                    selectedPlan.ranged === 2 &&
                    !lowerFlyer) ||
                (context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                    selectedPlan.healer &&
                    selectedPlan.magic === 1 &&
                    selectedPlan.ranged <= 3) ||
                (context.grid.getGridType() === PBTypes.GridVals.NORMAL &&
                    selectedPlan.areaCarry &&
                    selectedPlan.magic === 0 &&
                    selectedPlan.ranged >= 4);
            if (preserveNativeRole && revealed.filter((info) => info.ranged).length >= 3) return incumbent;
            const wideGroundScreen = ownNames.some((name) => {
                const i = creatureInfo(creatureIdForName(name)!)!;
                return i.level < 4 && i.melee && !i.canFly && i.footprintWidth === 2 && i.footprintHeight === 1;
            });
            if (
                context.grid.getGridType() === PBTypes.GridVals.LAVA_CENTER &&
                selectedPlan.artillery &&
                selectedPlan.magic === 0 &&
                selectedPlan.ranged >= 4 &&
                wideGroundScreen &&
                !lowerFlyer &&
                revealed.filter((info) => info.ranged).length >= 3
            )
                return incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.LAVA_CENTER &&
                selectedPlan.areaCarry &&
                selectedPlan.magic === 0 &&
                selectedPlan.ranged >= 3 &&
                wideGroundScreen &&
                !lowerFlyer &&
                revealed.filter((info) => info.ranged).length >= 3
            )
                return incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.NORMAL &&
                spellCarry &&
                selectedPlan.magic === 1 &&
                selectedPlan.ranged === 3 &&
                ownNames.some((name) => {
                    const i = creatureInfo(creatureIdForName(name)!)!;
                    return i.level === 3 && i.abilities.includes("Borrowed Grace");
                }) &&
                revealed.filter((info) => info.ranged).length >= 3 &&
                lowerFlyer
            )
                return incumbent;
            if (
                context.grid.getGridType() === PBTypes.GridVals.NORMAL &&
                spellCarry &&
                selectedPlan.magic === 1 &&
                selectedPlan.ranged === 3 &&
                ownNames.some((name) => {
                    const i = creatureInfo(creatureIdForName(name)!)!;
                    return i.level === 3 && i.ranged && i.abilities.includes("Large Caliber");
                }) &&
                revealed.filter((info) => info.ranged).length >= 3
            )
                return incumbent;
            if (
                !rapidChargeThroughShot &&
                !(
                    selectedPlan.artillery &&
                    ((context.grid.getGridType() === PBTypes.GridVals.NORMAL &&
                        (selectedPlan.ranged >= 4 || (selectedPlan.ranged === 2 && selectedPlan.magic === 0))) ||
                        (context.grid.getGridType() === PBTypes.GridVals.BLOCK_CENTER &&
                            selectedPlan.ranged >= 4 &&
                            selectedPlan.magic === 0 &&
                            ownNames.some((name) =>
                                creatureInfo(creatureIdForName(name)!)?.abilities.includes("Book of Healing"),
                            )))
                ) &&
                selectedPlan.ranged >= 2 &&
                revealed.filter((info) => info.ranged).length >= 3
            )
                return layoutRevealPlacement(units, context, {
                    gap: 2,
                    screenShooters: true,
                    cornerShift: false,
                    physicalMeleeMagicRoles: true,
                    screenBacklineProtectors: true,
                });
            const areaPressure = context.publicOpponentCreatureIds?.some((id) =>
                ["Large Caliber", "Area Throw"].some((a) => creatureInfo(id)?.abilities.includes(a)),
            );
            return selectedPlan.magic >= 2 && selectedPlan.ranged <= 2 && areaPressure
                ? disperseRevealedSplashArmy(units, context, incumbent)
                : incumbent;
        },
        decideTurn: (unit: Unit, context: IDecisionContext) => screened.decideTurn(unit, context),
    };
    const reflectionOwn = ownNames.map((name) => creatureInfo(creatureIdForName(name)!)!);
    const reflectionWide = reflectionOwn.some(
        (i) => i.level < 4 && i.melee && !i.canFly && i.footprintWidth === 2 && i.footprintHeight === 1,
    );
    const reflectionFlyer = reflectionOwn.some((i) => i.level < 4 && i.melee && i.canFly);
    const reflectionEligible =
        gridType === PBTypes.GridVals.LAVA_CENTER &&
        plan.artillery &&
        plan.magic === 0 &&
        plan.ranged >= 4 &&
        !reflectionWide &&
        !reflectionFlyer &&
        reflectionOwn.some((i) => i.abilities.includes("Luck Aura"));
    const finalStrategy = reflectionEligible
        ? {
              version: splash.version,
              placeArmy: (units: Unit[], context: IPlacementContext) => {
                  const incumbent = splash.placeArmy(units, context);
                  const publicFlyer = (context.publicOpponentCreatureIds ?? []).some((id) => {
                      const i = creatureInfo(id);
                      return i?.level === 4 && i.canFly && i.melee;
                  });
                  return context.team === PBTypes.TeamVals.RIGHT && publicFlyer
                      ? reflectIncumbentPlacement(units, context, incumbent)
                      : incumbent;
              },
              decideTurn: (unit: Unit, context: IDecisionContext) => splash.decideTurn(unit, context),
          }
        : splash;
    const blockedCasterBattery = plan.magic >= 3 && plan.ranged === 1;
    const blockedSpellBattery = plan.magic === 1 && plan.ranged >= 4 && spellCarry;
    const blockedAreaBattery = plan.areaCarry && plan.magic === 1 && plan.ranged >= 4;
    const blockedPhysicalBattery =
        plan.magic === 0 &&
        plan.ranged === 3 &&
        !plan.artillery &&
        !plan.areaCarry &&
        !plan.healer &&
        !plan.screenPhysical;
    const blockedGroundPhysicalHealer = plan.healer && plan.magic === 0 && plan.ranged === 3 && !reflectionFlyer;
    const lavaSparseAreaBattery =
        gridType === PBTypes.GridVals.LAVA_CENTER && plan.areaCarry && plan.magic >= 2 && plan.ranged <= 2;
    const lavaUnbuffedAreaBattery =
        gridType === PBTypes.GridVals.LAVA_CENTER &&
        plan.areaCarry &&
        plan.magic === 1 &&
        plan.ranged >= 4 &&
        !reflectionOwn.some((info) => info.castsAmplifiableBuff);
    const lavaNarrowSpellWithFlyingProtector =
        gridType === PBTypes.GridVals.LAVA_CENTER &&
        plan.magic === 1 &&
        plan.ranged === 2 &&
        spellCarry &&
        reflectionFlyer;
    const lavaRangedArtillery =
        gridType === PBTypes.GridVals.LAVA_CENTER && plan.artillery && plan.magic === 0 && plan.ranged >= 4;
    const lavaHybridArtillery =
        gridType === PBTypes.GridVals.LAVA_CENTER && plan.artillery && plan.magic === 1 && plan.ranged >= 4;
    const volleySupport = reflectionOwn.some((info) => info.abilities.includes("Rallying Volley Aura"));
    const meleeFlyer = reflectionOwn.some((info) => info.melee && info.canFly);
    const blockedFlyingVolley = plan.artillery && plan.magic === 1 && plan.ranged === 3 && volleySupport && meleeFlyer;
    const blockedSplashBattery =
        plan.magic === 1 &&
        plan.ranged <= 3 &&
        ((plan.artillery && !volleySupport && !meleeFlyer) ||
            (plan.ranged <= 2 &&
                reflectionOwn.some((info) => info.level === 4 && info.abilities.includes("AI Driven"))));
    if (
        !lavaSparseAreaBattery &&
        !lavaUnbuffedAreaBattery &&
        !lavaNarrowSpellWithFlyingProtector &&
        !lavaRangedArtillery &&
        !lavaHybridArtillery &&
        (gridType !== PBTypes.GridVals.BLOCK_CENTER ||
            !(
                blockedCasterBattery ||
                blockedSpellBattery ||
                blockedFlyingVolley ||
                blockedSplashBattery ||
                blockedAreaBattery ||
                blockedPhysicalBattery ||
                blockedGroundPhysicalHealer
            ))
    )
        return finalStrategy;
    return {
        version: finalStrategy.version,
        placeArmy: (units: Unit[], context: IPlacementContext) => {
            const incumbent = finalStrategy.placeArmy(units, context);
            if (context.grid.getGridType() !== gridType) return incumbent;
            const spreadBattery = () =>
                layoutRevealPlacement(units, context, {
                    gap: 3,
                    screenShooters: true,
                    cornerShift: false,
                    physicalMeleeMagicRoles: true,
                    screenBacklineProtectors: true,
                });
            const batteryFormation =
                lavaUnbuffedAreaBattery || (blockedPhysicalBattery && context.team === PBTypes.TeamVals.RIGHT)
                    ? reflectIncumbentPlacement(units, context, incumbent)
                    : lavaSparseAreaBattery ||
                        lavaNarrowSpellWithFlyingProtector ||
                        (blockedCasterBattery && context.team === PBTypes.TeamVals.LEFT)
                      ? spreadBattery()
                      : blockedSpellBattery
                        ? context.team === PBTypes.TeamVals.RIGHT
                            ? spreadBattery()
                            : reflectIncumbentPlacement(units, context, incumbent)
                        : blockedFlyingVolley
                          ? spreadBattery()
                          : blockedSplashBattery || blockedGroundPhysicalHealer
                            ? disperseRevealedSplashArmy(units, context, incumbent)
                            : incumbent;
            const selected =
                !lavaUnbuffedAreaBattery &&
                (blockedAreaBattery ||
                    lavaHybridArtillery ||
                    (lavaRangedArtillery && context.team === PBTypes.TeamVals.LEFT))
                    ? disperseRevealedSplashArmy(units, context, batteryFormation)
                    : batteryFormation;
            if (selected.size !== units.length) return incumbent;
            const legal = context.placement.possibleCellHashes(),
                occupied = new Set<number>();
            for (const unit of units) {
                const anchor = selected.get(unit.getId());
                if (!anchor) return incumbent;
                for (const cell of footprintCellsForAnchor(unit, anchor)) {
                    const hash = (cell.x << 4) | cell.y;
                    if (!legal.has(hash) || occupied.has(hash)) return incumbent;
                    occupied.add(hash);
                }
            }
            return selected;
        },
        decideTurn: (unit: Unit, context: IDecisionContext) => finalStrategy.decideTurn(unit, context),
    };
}

/** Explicit opt-in. Uses the own completed roster, public map and revealed opponent identities. */
export function createV08A19RoleStrategy(
    names: readonly string[],
    gridType: GridType,
    base: IAIStrategy = createRoleBaseStrategy(),
): IAIStrategy {
    const strategy = createIncumbentRoleStrategy(names, gridType, base);
    if (gridType !== PBTypes.GridVals.BLOCK_CENTER) return strategy;
    const plan = roleSearchPlan(names, gridType),
        own = [...new Set(names)].map((name) => creatureInfo(creatureIdForName(name)!)!);
    const compactMagicBattery = plan.magic >= 3 && plan.ranged === 1;
    const reflectHybridHealer = plan.healer && plan.magic === 1 && plan.ranged === 3;
    const disperseSpellBattery =
        plan.magic === 1 && plan.ranged >= 4 && own.some((info) => info.level === 4 && info.rangedSpellDamage);
    const reflectPhysicalBattery =
        plan.magic === 1 &&
        plan.ranged === 3 &&
        ((plan.artillery &&
            own.some((info) => info.castsAmplifiableBuff) &&
            own.some((info) => info.abilities.includes("Rallying Volley Aura"))) ||
            (!plan.artillery &&
                !plan.healer &&
                !plan.areaCarry &&
                own.some((info) => info.level === 4 && info.abilities.includes("Dense Flesh"))));
    if (!compactMagicBattery && !reflectPhysicalBattery && !disperseSpellBattery && !reflectHybridHealer)
        return strategy;
    return {
        version: strategy.version,
        placeArmy: (units: Unit[], context: IPlacementContext) => {
            const incumbent = strategy.placeArmy(units, context);
            if (context.grid.getGridType() !== gridType) return incumbent;
            if (reflectPhysicalBattery && context.team !== PBTypes.TeamVals.LEFT) return incumbent;
            const selected =
                reflectPhysicalBattery || reflectHybridHealer
                    ? reflectIncumbentPlacement(units, context, incumbent)
                    : disperseSpellBattery
                      ? disperseRevealedSplashArmy(units, context, incumbent)
                      : layoutRevealPlacement(units, context, {
                            gap: 2,
                            screenShooters: true,
                            cornerShift: false,
                            physicalMeleeMagicRoles: true,
                            screenBacklineProtectors: true,
                        });
            if (selected.size !== units.length) return incumbent;
            const legal = context.placement.possibleCellHashes(),
                occupied = new Set<number>();
            for (const unit of units) {
                const anchor = selected.get(unit.getId());
                if (!anchor) return incumbent;
                for (const cell of footprintCellsForAnchor(unit, anchor)) {
                    const hash = (cell.x << 4) | cell.y;
                    if (!legal.has(hash) || occupied.has(hash)) return incumbent;
                    occupied.add(hash);
                }
            }
            return selected;
        },
        decideTurn: (unit: Unit, context: IDecisionContext) => strategy.decideTurn(unit, context),
    };
}
