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

import { Grid } from "../grid/grid";
import * as HoCConstants from "../constants";
import * as HoCMath from "../utils/math";
import * as HoCLib from "../utils/lib";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import type { ISceneLog } from "../scene/scene_log_interface";
import { UnitsHolder } from "../units/units_holder";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";

import { processLuckyStrikeAbility } from "./lucky_strike_ability";
import { processFleshShieldAura } from "./flesh_shield_aura_ability";
import { processPetrifyingGazeAbility } from "./petrifying_gaze_ability";
import { processRimeCharmAbility } from "./rime_charm_ability";
import { processSpitBallAbility } from "./spit_ball_ability";
import { processStunAbility } from "./stun_ability";
import { processFreezeAbility } from "./freeze_ability";
import { PBTypes } from "../generated/protobuf/v1/types";
import { processPoisonAuraAbility } from "./poison_aura_ability";

export interface IAOERangeAttackResult {
    landed: boolean;
    maxDamage: number;
    unitIdsDied: string[];
    // Per-affected-unit damage so the client can draw a floating number on every splashed unit at its
    // own position (not just the primary target). Position is captured at impact time.
    // `missed` marks a unit the volley rolled a MISS against (Dodge / Small Specie / Boar Saliva). It gets
    // an entry with no damage rather than no entry at all: the engine's own log line about the miss never
    // reaches ranked, which rebuilds its scene log from events, and the client needs something to pop the
    // MISS over. Every other entry is a unit that was actually hit.
    perUnitDamage: { unitId: string; position: HoCMath.XY; amount: number; unitsDied: number; missed?: boolean }[];
}

export function processRangeAOEAbility(
    attackerUnit: Unit,
    affectedUnits: Unit[],
    currentActiveUnit: Unit,
    rangeAttackDivisor: number,
    unitsHolder: UnitsHolder,
    grid: Grid,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    isAttack = true,
    secondaryDamage?: ISecondaryDamage[],
    // Per-victim scaling applied to the raw hit before artifacts/resistances — Zena's Chakram halves
    // the bounce onto a target two cells removed (see chakram_ability.damageFactorByUnitId).
    perUnitDamageFactors?: Record<string, number>,
    // Zena's Chakram rolls its dodges up front, in flight order, because a dodge ENDS the flight
    // (chakram_ability.resolveChakramFlightMisses). Those verdicts are reused here rather than rolled
    // again: a second roll could hand a hit to a victim the disc already stopped short of.
    preRolledMissByUnitId?: Readonly<Record<string, boolean>>,
): IAOERangeAttackResult {
    const unitIdsDied: string[] = [];
    const perUnitDamage: IAOERangeAttackResult["perUnitDamage"] = [];
    // The AOE abilities that route their splash through this tail. Being listed here is what earns an
    // ability the whole AOE package: ARTIFACT Giant's Maul's +% at impact, the victim's status resistance
    // hardening against physical AOE, Flesh Shield owners resolving first, and the per-unit damage
    // breakdown the client renders. Zena's Chakram bounces are AOE hits for exactly these reasons.
    let aoeAbility = attackerUnit.getAbility("Area Throw");
    if (!aoeAbility) {
        aoeAbility = attackerUnit.getAbility("Large Caliber");
    }
    if (!aoeAbility) {
        aoeAbility = attackerUnit.getAbility("Chakram");
    }

    let maxDamage = 0;
    if (aoeAbility) {
        const wasDead: Unit[] = [];
        let increaseMoraleTotal = 0;
        const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
        // ARTIFACT Giant's Maul: +% non-magical AOE damage to EVERY struck unit, applied at impact below
        // and then reduced by each victim's status resistance.
        const giantsMaulBuff = attackerUnit.getBuff("Giants Maul");
        // Range splash is one simultaneous impact. Resolve any Flesh Shield owners caught in the blast
        // before their protected allies so the owner's own hit reserves HP first; otherwise an allies-first
        // array could fill/kill the owner through absorption and make its direct AOE hit disappear entirely.
        const impactOrder = [
            ...affectedUnits.filter((unit) => unit.hasAbilityActive("Flesh Shield Aura")),
            ...affectedUnits.filter((unit) => !unit.hasAbilityActive("Flesh Shield Aura")),
        ];
        // Units whose sub-hit actually LANDED. A dodged sub-hit and a Water-Shield-absorbed sub-hit
        // both apply nothing, so the on-hit rider pass below (Stun/Freeze/Rime Charm/Spit Ball) only
        // runs for members of this set — mirroring the single-target rule in the attack handler.
        const landedHitUnitIds = new Set<string>();
        for (const unit of impactOrder) {
            if (unit.isDead()) {
                if (!unitIdsDied.includes(unit.getId())) {
                    unitIdsDied.push(unit.getId());
                }
                wasDead.push(unit);
                continue;
            }

            const isAttackMissed =
                preRolledMissByUnitId?.[unit.getId()] ??
                HoCLib.getRandomInt(0, 100) <
                    attackerUnit.calculateMissChance(
                        unit,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(unit.getTeam()),
                    );
            if (isAttackMissed) {
                sceneLog.updateLog(
                    `${attackerUnit.getName()} misses 🏹 ${isAttack ? "on" : "resp on"} ${unit.getName()}`,
                );
                // Report the dodge so it survives to the client: ranked builds its log from events, not from
                // the line above, and the renderer needs a position to pop MISS over.
                perUnitDamage.push({
                    unitId: unit.getId(),
                    position: { ...unit.getPosition() },
                    amount: 0,
                    unitsDied: 0,
                    missed: true,
                });
            } else {
                let abilityMultiplier = attackerUnit.calculateAbilityMultiplier(
                    aoeAbility,
                    FightStateManager.getInstance()
                        .getFightProperties()
                        .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                );

                const paralysisAttackerEffect = attackerUnit.getEffect("Paralysis");
                if (paralysisAttackerEffect) {
                    abilityMultiplier *= (100 - paralysisAttackerEffect.getPower()) / 100;
                }

                let damageFromAttack = processLuckyStrikeAbility(
                    attackerUnit,
                    attackerUnit.calculateAttackDamage(
                        unit,
                        PBTypes.AttackVals.RANGE,
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAbilityPowerPerTeam(attackerUnit.getTeam()),
                        rangeAttackDivisor,
                        abilityMultiplier,
                        false,
                    ),
                    sceneLog,
                );

                // Chakram: a bounce onto a target two cells removed lands at half strength (factor 0.5);
                // scaled before artifacts/resistances so those keep their usual relative effect.
                const perUnitFactor = perUnitDamageFactors?.[unit.getId()];
                if (perUnitFactor !== undefined && perUnitFactor !== 1) {
                    damageFromAttack = Math.floor(damageFromAttack * perUnitFactor);
                }

                // ARTIFACT Giant's Maul: +% non-magical AOE damage at impact (every struck unit), before the
                // status-resistance reduction below.
                if (giantsMaulBuff) {
                    damageFromAttack = Math.floor(damageFromAttack * (1 + giantsMaulBuff.getPower() / 100));
                }

                // ARTIFACT Broken Aegis: the victim takes reduced damage from area attacks.
                const aegisShieldBuff = unit.getBuff("Broken Aegis");
                if (aegisShieldBuff) {
                    damageFromAttack = Math.floor(damageFromAttack * (1 - aegisShieldBuff.getPower() / 100));
                }

                // Status resistance hardens the victim vs physical AOE (Mechanisms take extra).
                damageFromAttack = Math.floor(damageFromAttack * unit.getPhysicalAoeDamageMultiplier());

                // Petrifying Gaze is an on-hit effect on this unit, not part of the damage Flesh Shield can
                // redirect. Preserve the fully resolved impact damage before the aura splits the base hit.
                const petrifyingGazeDamage = damageFromAttack;

                const fleshShieldResult = processFleshShieldAura(
                    attackerUnit,
                    unit,
                    damageFromAttack,
                    true,
                    grid,
                    unitsHolder,
                    sceneLog,
                    damageStatisticHolder,
                    secondaryDamage,
                );
                damageFromAttack = fleshShieldResult.remainingDamage;
                increaseMoraleTotal += fleshShieldResult.increaseMorale;
                for (const unitId of fleshShieldResult.unitIdsDied) {
                    if (!unitIdsDied.includes(unitId)) {
                        unitIdsDied.push(unitId);
                    }
                }
                for (const [unitNameKey, moraleDecrease] of Object.entries(
                    fleshShieldResult.moraleDecreaseForTheUnitTeam,
                )) {
                    moraleDecreaseForTheUnitTeam[unitNameKey] =
                        (moraleDecreaseForTheUnitTeam[unitNameKey] ?? 0) + moraleDecrease;
                }

                // Snapshot position + stack BEFORE applying damage so the floating number lands where the
                // unit stood when hit (it may die and be removed before the visuals play).
                const unitPositionAtImpact = { ...unit.getPosition() };
                const amountAliveBeforeDamage = unit.getAmountAlive();
                const waterShieldAbsorbed = damageFromAttack > 0 && unit.willWaterShieldAbsorb(attackerUnit);
                if (!waterShieldAbsorbed) {
                    landedHitUnitIds.add(unit.getId());
                }
                const damageDealt = unit.applyDamage(
                    damageFromAttack,
                    FightStateManager.getInstance().getFightProperties().getBreakChancePerTeam(attackerUnit.getTeam()),
                    sceneLog,
                    false,
                    attackerUnit,
                );
                // Poison aura: an aura'd attacker poisons every unit its AOE hits, not just the primary.
                processPoisonAuraAbility(attackerUnit, unit, damageDealt, sceneLog);
                const unitsKilled = Math.max(0, amountAliveBeforeDamage - unit.getAmountAlive());
                perUnitDamage.push({
                    unitId: unit.getId(),
                    position: unitPositionAtImpact,
                    amount: damageDealt,
                    unitsDied: unitsKilled,
                });

                damageStatisticHolder.add({
                    unitName: attackerUnit.getName(),
                    damage: damageDealt,
                    team: attackerUnit.getTeam(),
                    lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                });
                if (!waterShieldAbsorbed) {
                    const pegasusLightEffect = unit.getEffect("Pegasus Light");
                    if (pegasusLightEffect) {
                        increaseMoraleTotal += pegasusLightEffect.getPower();
                    }
                }
                sceneLog.updateLog(
                    `${attackerUnit.getName()} ${isAttack ? "🏹" : "resp"} ${unit.getName()} (${damageFromAttack})` +
                        HoCLib.killTag(unitsKilled),
                );
                maxDamage = Math.max(maxDamage, damageFromAttack);

                if (!unit.isDead() && !waterShieldAbsorbed) {
                    processPetrifyingGazeAbility(
                        attackerUnit,
                        unit,
                        petrifyingGazeDamage,
                        sceneLog,
                        damageStatisticHolder,
                        secondaryDamage,
                        rangeAttackDivisor,
                    );
                }
            }
        }

        for (const unit of affectedUnits) {
            if (unit.isDead()) {
                if (!wasDead.includes(unit)) {
                    if (!unitIdsDied.includes(unit.getId())) {
                        sceneLog.updateLog(`${unit.getName()} died`);
                        unitIdsDied.push(unit.getId());
                        increaseMoraleTotal += HoCConstants.MORALE_CHANGE_FOR_KILL;
                        const unitNameKey = `${unit.getName()}:${unit.getTeam()}`;
                        moraleDecreaseForTheUnitTeam[unitNameKey] =
                            (moraleDecreaseForTheUnitTeam[unitNameKey] || 0) + HoCConstants.MORALE_CHANGE_FOR_KILL;
                    }
                    wasDead.push(unit);
                }
                continue;
            }
            if (!landedHitUnitIds.has(unit.getId())) {
                continue;
            }
            processStunAbility(attackerUnit, unit, attackerUnit, sceneLog);
            processFreezeAbility(attackerUnit, unit, attackerUnit, sceneLog);
            processRimeCharmAbility(attackerUnit, unit, sceneLog);
            processSpitBallAbility(attackerUnit, unit, currentActiveUnit, unitsHolder, grid, sceneLog);
        }
        attackerUnit.increaseMorale(
            increaseMoraleTotal,
            FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(attackerUnit.getTeam()),
        );
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam);
        // Spend this volley's arrows through the SHARED helper, so a splash shot honours the same rules a
        // single-target shot does. It previously decremented once flat, which silently exempted every
        // splash shooter (Gargantuan's Area Throw, Cyclops' Large Caliber) from Dense Flesh: a Double Shot
        // into an Abomination cost 2 arrows instead of 4.
        //
        // The surcharge is read from the PRIMARY target — affectedUnits[0], the first unit on the ray —
        // because Dense Flesh reads "ranged attacks AIMED AT this unit". A splashed bystander that happens
        // to have it does not make the shot more expensive.
        attackerUnit.spendShotsAgainst(affectedUnits[0]);

        return {
            landed: true,
            maxDamage,
            unitIdsDied,
            perUnitDamage,
        };
    }

    return {
        landed: false,
        maxDamage,
        unitIdsDied,
        perUnitDamage,
    };
}

export function evaluateAffectedUnits(
    affectedCells: HoCMath.XY[],
    unitsHolder: UnitsHolder,
    grid: Grid,
): Array<Unit[]> | undefined {
    const cellKeys: number[] = [];
    const unitIds: string[] = [];
    const affectedUnits: Unit[] = [];

    for (const c of affectedCells) {
        const cellKey = (c.x << 4) | c.y;
        if (cellKeys.includes(cellKey)) {
            continue;
        }

        const occupantId = grid.getOccupantUnitId(c);
        if (!occupantId) {
            continue;
        }

        if (unitIds.includes(occupantId)) {
            continue;
        }

        const occupantUnit = unitsHolder.getAllUnits().get(occupantId);
        if (!occupantUnit) {
            continue;
        }

        affectedUnits.push(occupantUnit);
        cellKeys.push(cellKey);
        unitIds.push(occupantId);
    }

    // ABILITY Arrows Wingshield Blessing (Angel): "the owner ... does not propagate AOE range damage".
    // A blast that catches the Angel stops at him — he soaks it and nobody around him is splashed.
    // Applied HERE rather than in processRangeAOEAbility because the client's hover preview calls this
    // same function to outline and price the victims, so what is highlighted is what actually gets hit.
    // Two Angels in one blast both soak it; neither passes it on.
    const shieldBearers = affectedUnits.filter((unit) => unit.hasAbilityActive("Arrows Wingshield Blessing"));
    if (shieldBearers.length) {
        return [shieldBearers, shieldBearers];
    }

    if (affectedUnits.length) {
        return [affectedUnits, affectedUnits];
    }

    return undefined;
}
