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

import { EffectHelper, type IPlacement, Spell } from "..";
import { getArmorPower, getMightPower, getMovementPower, getSniperPower } from "../augments/augment_properties";
import {
    ARTIFACT_POWER as AP,
    BROKEN_AEGIS_BREAK_CHANCE,
    BROKEN_AEGIS_MISS_CHANCE,
    TIER1_ARTIFACT_LIST,
    TIER2_ARTIFACT_LIST,
    Tier1Artifact,
    Tier2Artifact,
} from "../artifacts/artifact_properties";
import { getSpellConfig } from "../configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../constants";
import { AppliedAuraEffectProperties } from "../effects/effect_properties";
import type { FightProperties } from "../fights/fight_properties";
import { FightStateManager } from "../fights/fight_state_manager";
import { Grid } from "../grid/grid";
import { getCellsAroundCell, getPositionForCell, isCellWithinGrid, isPositionWithinGrid } from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { AppliedSpell } from "../spells/applied_spell";
import { getDistance, type XY } from "../utils/math";
import { type IUnitAIRepr, Unit } from "./unit";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { UnitProperties } from "./unit_properties";

export class UnitsHolder {
    private readonly grid: Grid;
    private readonly allUnits: Map<string, Unit> = new Map();
    private readonly gridSettings: GridSettings;
    private teamsAuraEffects: Map<TeamType, Map<number, AppliedAuraEffectProperties[]>>;
    private distancesToClosestEnemies: Map<string, number> = new Map();
    public constructor(grid: Grid) {
        this.grid = grid;
        this.gridSettings = grid.getSettings();
        this.teamsAuraEffects = new Map();
        this.distancesToClosestEnemies = new Map();
    }
    public getAllUnitsIterator(): IterableIterator<Unit> {
        return this.allUnits.values();
    }
    public getAllUnits(): ReadonlyMap<string, Unit> {
        return this.allUnits;
    }
    public getAllEnemyUnits(myTeamType: TeamType): Unit[] {
        const enemyUnits: Unit[] = [];
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() !== myTeamType) {
                enemyUnits.push(unit);
            }
        }

        return enemyUnits;
    }
    public getAllAllies(teamType: TeamType): Unit[] {
        const allies: Unit[] = [];
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                allies.push(unit);
            }
        }

        return allies;
    }
    public getAllAlliesPlaced(
        teamType: TeamType,
        lowerLeftPlacement: IPlacement,
        upperRightPlacement: IPlacement,
        lowerRightPlacement?: IPlacement,
        upperLeftPlacement?: IPlacement,
    ): Unit[] {
        const allies: Unit[] = [];

        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                const unitCells = unit.getCells();
                let allCellsAllowed = true;

                for (const c of unitCells) {
                    const cellPosition = getPositionForCell(
                        c,
                        this.gridSettings.getMinX(),
                        this.gridSettings.getStep(),
                        this.gridSettings.getHalfStep(),
                    );

                    if (!(
                        (teamType === PBTypes.TeamVals.LOWER &&
                            (lowerLeftPlacement.isAllowed(cellPosition) ||
                                (lowerRightPlacement && lowerRightPlacement.isAllowed(cellPosition)))) ||
                        (teamType === PBTypes.TeamVals.UPPER &&
                            (upperRightPlacement.isAllowed(cellPosition) ||
                                (upperLeftPlacement && upperLeftPlacement.isAllowed(cellPosition))) &&
                            isPositionWithinGrid(this.gridSettings, cellPosition))
                    )) {
                        allCellsAllowed = false;
                        break;
                    }
                }

                if (allCellsAllowed) {
                    allies.push(unit);
                }
            }
        }

        return allies;
    }
    public toCleanupRandomUnitsTillTeamSize(
        targetTeamSize: number,
        teamType: TeamType,
        lowerLeftPlacement: IPlacement,
        upperRightPlacement: IPlacement,
        lowerRightPlacement?: IPlacement,
        upperLeftPlacement?: IPlacement,
    ): Unit[] {
        const ret: Unit[] = [];
        let targetSize = targetTeamSize;
        if (targetTeamSize < 0) {
            targetSize = 0;
        }

        const units = this.getAllAlliesPlaced(
            teamType,
            lowerLeftPlacement,
            upperRightPlacement,
            lowerRightPlacement,
            upperLeftPlacement,
        );

        if (units.length <= targetSize) {
            return ret;
        }

        units.sort((a, b) => a.getStackPower() - b.getStackPower());

        for (let i = 0; i < units.length - targetSize; i++) {
            ret.push(units[i]);
        }

        return ret;
    }
    public getAllTeamUnitsBuffs(teamType: TeamType): Map<string, AppliedSpell[]> {
        const teamUnitBuffs: Map<string, AppliedSpell[]> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                teamUnitBuffs.set(unit.getId(), unit.getBuffs());
            }
        }

        return teamUnitBuffs;
    }
    public haveDistancesToClosestEnemiesDecreased(): boolean {
        let distanceDecreased = false;

        for (const unit of this.allUnits.values()) {
            if (unit.isDead()) {
                continue;
            }

            const unitId = unit.getId();

            if (!isPositionWithinGrid(this.gridSettings, unit.getPosition())) {
                continue;
            }

            let currentDistance = 0;
            if (this.distancesToClosestEnemies.has(unitId)) {
                currentDistance = Number(
                    this.getDistanceToClosestEnemy(unit.getOppositeTeam(), unit.getPosition()).toFixed(2),
                );
                const knownDistance = this.distancesToClosestEnemies.get(unitId) ?? 0;
                if (!knownDistance || knownDistance > currentDistance) {
                    distanceDecreased = true;
                }
            } else {
                distanceDecreased = true;
                currentDistance = Number(
                    this.getDistanceToClosestEnemy(unit.getOppositeTeam(), unit.getPosition()).toFixed(2),
                );
            }
            this.distancesToClosestEnemies.set(unitId, currentDistance);
        }

        return distanceDecreased;
    }
    public getAllEnemyUnitsBuffs(myTeamType: TeamType): Map<string, AppliedSpell[]> {
        const enemyTeamUnitBuffs: Map<string, AppliedSpell[]> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() !== myTeamType) {
                enemyTeamUnitBuffs.set(unit.getId(), unit.getBuffs());
            }
        }

        return enemyTeamUnitBuffs;
    }
    public getAllEnemyUnitsDebuffs(myTeamType: TeamType): Map<string, AppliedSpell[]> {
        const teamUnitBuffs: Map<string, AppliedSpell[]> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() !== myTeamType) {
                teamUnitBuffs.set(unit.getId(), unit.getDebuffs());
            }
        }

        return teamUnitBuffs;
    }
    public getAllTeamUnitsCanFly(teamType: TeamType): Map<string, boolean> {
        const teamUnitCanFly: Map<string, boolean> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                teamUnitCanFly.set(unit.getId(), unit.canFly());
            }
        }

        return teamUnitCanFly;
    }
    public getAllEnemyUnitsCanFly(teamType: TeamType): Map<string, boolean> {
        const enemyTeamUnitCanFly: Map<string, boolean> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() !== teamType) {
                enemyTeamUnitCanFly.set(unit.getId(), unit.canFly());
            }
        }

        return enemyTeamUnitCanFly;
    }
    public getAllTeamUnitsMagicResist(teamType: TeamType): Map<string, number> {
        const teamUnitMagicResist: Map<string, number> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                teamUnitMagicResist.set(unit.getId(), unit.getMagicResist());
            }
        }

        return teamUnitMagicResist;
    }
    public getAllTeamUnitsHp(teamType: TeamType): Map<string, number> {
        const teamUnitHp: Map<string, number> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                teamUnitHp.set(unit.getId(), unit.getHp());
            }
        }

        return teamUnitHp;
    }
    // fightProperties defaults to the global singleton (client/sandbox), but server play sessions run many
    // concurrent fights off their own per-session FightProperties, so they pass it explicitly (mirrors
    // applyArtifacts). Applies the team's chosen army augments (armor / might / sniper / movement) as
    // per-unit "System" buffs; placement augments are read separately when sizing the placement grid.
    public applyAugments(
        fightProperties: FightProperties = FightStateManager.getInstance().getFightProperties(),
    ): void {
        for (const unit of this.getAllUnitsIterator()) {
            const augmentArmor = fightProperties.getAugmentArmor(unit.getTeam());
            const augmentArmorPower = getArmorPower(augmentArmor);
            unit.deleteBuff("Armor Augment");
            if (augmentArmor && isPositionWithinGrid(this.gridSettings, unit.getPosition())) {
                const augmentArmorBuff = new Spell({
                    spellProperties: getSpellConfig("System", "Armor Augment", NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                const infoArr: string[] = [];
                for (const descStr of augmentArmorBuff.getDesc()) {
                    infoArr.push(
                        descStr
                            .replace(/\{\}/g, augmentArmorPower.toString())
                            .replace(/\[\]/g, augmentArmor.toString()),
                    );
                }
                augmentArmorBuff.setDesc(infoArr);
                augmentArmorBuff.setPower(augmentArmorPower);
                unit.applyBuff(augmentArmorBuff);
            }

            const augmentMight = fightProperties.getAugmentMight(unit.getTeam());
            const augmentMightPower = getMightPower(augmentMight);
            unit.deleteBuff("Might Augment");
            if (augmentMight && isPositionWithinGrid(this.gridSettings, unit.getPosition())) {
                const augmentMightBuff = new Spell({
                    spellProperties: getSpellConfig("System", "Might Augment", NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                const infoArr: string[] = [];
                for (const descStr of augmentMightBuff.getDesc()) {
                    infoArr.push(
                        descStr
                            .replace(/\{\}/g, augmentMightPower.toString())
                            .replace(/\[\]/g, augmentMight.toString()),
                    );
                }
                augmentMightBuff.setDesc(infoArr);
                augmentMightBuff.setPower(augmentMightPower);
                unit.applyBuff(augmentMightBuff);
            }

            const augmentSniper = fightProperties.getAugmentSniper(unit.getTeam());
            const augmentSniperPower = getSniperPower(augmentSniper);
            unit.deleteBuff("Sniper Augment");
            if (
                augmentSniper &&
                unit.getAttackType() === PBTypes.AttackVals.RANGE &&
                isPositionWithinGrid(this.gridSettings, unit.getPosition())
            ) {
                const augmentSniperBuff = new Spell({
                    spellProperties: getSpellConfig("System", "Sniper Augment", NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                const infoArr: string[] = [];
                for (const descStr of augmentSniperBuff.getDesc()) {
                    infoArr.push(
                        descStr
                            .replace(/\{\}/, augmentSniperPower[0].toString())
                            .replace(/\{\}/, augmentSniperPower[1].toString())
                            .replace(/\[\]/g, augmentSniper.toString()),
                    );
                }
                augmentSniperBuff.setDesc(infoArr);
                augmentSniperBuff.setPower(augmentSniperPower[0]);
                unit.applyBuff(augmentSniperBuff, augmentSniperPower[0], augmentSniperPower[1]);
            }

            const augmentMovement = fightProperties.getAugmentMovement(unit.getTeam());
            const augmentMovementPower = getMovementPower(augmentMovement);
            unit.deleteBuff("Movement Augment");
            if (augmentMovement && isPositionWithinGrid(this.gridSettings, unit.getPosition())) {
                const augmentMovementBuff = new Spell({
                    spellProperties: getSpellConfig("System", "Movement Augment", NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                const infoArr: string[] = [];
                for (const descStr of augmentMovementBuff.getDesc()) {
                    infoArr.push(
                        descStr
                            .replace(/\{\}/g, augmentMovementPower.toString())
                            .replace(/\[\]/g, augmentMovement.toString()),
                    );
                }
                augmentMovementBuff.setDesc(infoArr);
                augmentMovementBuff.setPower(augmentMovementPower);
                unit.applyBuff(augmentMovementBuff);
            }
        }
    }
    // fightProperties defaults to the global singleton (client/sandbox), but server play sessions run many
    // concurrent fights off their own per-session FightProperties, so they pass it explicitly.
    public applyArtifacts(
        fightProperties: FightProperties = FightStateManager.getInstance().getFightProperties(),
    ): void {
        // Pre-compute archer counts per team (Hunter's Longbow's bonus depends on having 3+ archers).
        const archersPerTeam: Map<TeamType, number> = new Map();
        for (const unit of this.getAllUnitsIterator()) {
            if (unit.getAttackType() === PBTypes.AttackVals.RANGE) {
                archersPerTeam.set(unit.getTeam(), (archersPerTeam.get(unit.getTeam()) ?? 0) + 1);
            }
        }

        // All stat-artifact buff names, for cleanup on every recompute (deselect / re-pick must be clean).
        const artifactBuffNames = [...TIER1_ARTIFACT_LIST, ...TIER2_ARTIFACT_LIST]
            .map((props) => props.buffName)
            .filter((name) => name.length > 0);

        for (const unit of this.getAllUnitsIterator()) {
            for (const buffName of artifactBuffNames) {
                unit.deleteBuff(buffName);
                // Dual/cursed artifacts also apply a display-only marker DEBUFF under the same name
                // (see applyDualArtifact); clear it too so nothing accumulates across recompute.
                unit.deleteDebuff(buffName);
            }

            if (!isPositionWithinGrid(this.gridSettings, unit.getPosition())) {
                continue;
            }

            const team = unit.getTeam();
            const tier1 = fightProperties.getArtifactTier1(team);
            const tier2 = fightProperties.getArtifactTier2(team);
            const isRange = unit.getAttackType() === PBTypes.AttackVals.RANGE;
            const isFlyer = unit.canFly();
            const isMelee = unit.getAttackType() === PBTypes.AttackVals.MELEE && !isFlyer;

            const applyArtifactBuff = (buffName: string, primary: number, secondary?: number): void => {
                const buff = new Spell({
                    spellProperties: getSpellConfig("System", buffName, NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                const infoArr: string[] = [];
                for (const descStr of buff.getDesc()) {
                    infoArr.push(
                        descStr
                            .replace(/\{\}/g, primary.toString())
                            .replace(/\[\]/g, (secondary ?? primary).toString()),
                    );
                }
                buff.setDesc(infoArr);
                buff.setPower(primary);
                unit.applyBuff(buff, primary, secondary);
            };

            // Cursed / dual artifacts have an upside AND a downside. Apply the functional buff (positive half)
            // exactly like a normal artifact — the stat hooks read the `;primary;secondary` suffix that
            // applyBuff appends, so the visible text can be positive-only — then ALSO apply a power-0 marker
            // DEBUFF carrying the negative half. Power 0 means it never affects stats or trips a real debuff
            // check; it exists purely so the sidebar shows the downside on the Debuffs side (same name/icon as
            // the buff). The cleanup loop above deletes both by name each recompute, so nothing accumulates.
            const applyDualArtifact = (
                buffName: string,
                buffDesc: string,
                debuffDesc: string,
                primary: number,
                secondary?: number,
            ): void => {
                const buff = new Spell({
                    spellProperties: getSpellConfig("System", buffName, NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                buff.setDesc([buffDesc.replace(/\{\}/g, primary.toString()), "Lasts till the end of the fight."]);
                buff.setPower(primary);
                unit.applyBuff(buff, primary, secondary);

                const debuff = new Spell({
                    spellProperties: getSpellConfig("System", buffName, NUMBER_OF_LAPS_TOTAL),
                    amount: 1,
                });
                debuff.setDesc([
                    debuffDesc.replace(/\{\}/g, (secondary ?? primary).toString()),
                    "Lasts till the end of the fight.",
                ]);
                debuff.setPower(0);
                unit.applyDebuff(debuff, secondary);
            };

            // ---- Tier 1 stat artifacts ----
            switch (tier1) {
                case Tier1Artifact.VETERAN_HELM:
                    applyArtifactBuff("Veteran Helm", AP.VETERAN_HELM_PERCENT);
                    break;
                case Tier1Artifact.KEEN_BLADE:
                    applyArtifactBuff("Keen Blade", AP.KEEN_BLADE_FLAT);
                    break;
                case Tier1Artifact.IRON_PLATE:
                    applyArtifactBuff("Iron Plate", AP.IRON_PLATE_FLAT);
                    break;
                case Tier1Artifact.SWIFT_BOOTS:
                    if (isMelee) {
                        applyArtifactBuff("Swift Boots", AP.SWIFT_BOOTS_STEPS);
                    }
                    break;
                case Tier1Artifact.WINGED_BOOTS:
                    if (isFlyer) {
                        applyArtifactBuff("Winged Boots", AP.WINGED_BOOTS_STEPS);
                    }
                    break;
                case Tier1Artifact.CURSED_WARD:
                    applyDualArtifact(
                        "Cursed Ward",
                        "Blessed: +{} luck for the whole army.",
                        "Cursed: -{} morale for the whole army.",
                        AP.CURSED_WARD_LUCK,
                        AP.CURSED_WARD_MORALE_PENALTY,
                    );
                    break;
                case Tier1Artifact.HUNTERS_LONGBOW:
                    if (isRange) {
                        if ((archersPerTeam.get(team) ?? 0) >= AP.LONGBOW_ARCHER_THRESHOLD) {
                            applyDualArtifact(
                                "Hunters Longbow",
                                "Ranged units gain +{} attack.",
                                "Ranged units suffer -{}% defense.",
                                AP.LONGBOW_ATTACK_FLAT_MANY_ARCHERS,
                                AP.LONGBOW_DEFENSE_PENALTY_PERCENT_MANY_ARCHERS,
                            );
                        } else {
                            applyDualArtifact(
                                "Hunters Longbow",
                                "Ranged units gain +{} attack.",
                                "Ranged units suffer -{}% defense.",
                                AP.LONGBOW_ATTACK_FLAT,
                                AP.LONGBOW_DEFENSE_PENALTY_PERCENT,
                            );
                        }
                    }
                    break;
                case Tier1Artifact.HELM_OF_FOCUS:
                    applyArtifactBuff("Helm of Focus", AP.HELM_OF_FOCUS_RESIST_PERCENT);
                    break;
                case Tier1Artifact.AMULET_OF_RESOLVE:
                    applyArtifactBuff("Amulet of Resolve", AP.AMULET_OF_RESOLVE_RESIST_PERCENT);
                    break;
                // Combat-time markers (checked by the relevant hook via unit.getBuff).
                case Tier1Artifact.DUAL_STRIKE_CHARM:
                    // Only meaningful on units that actually get a second attack in the fight, so restrict the
                    // marker buff to units with Double Punch (melee) or Double Shot (ranged).
                    if (unit.hasAbilityActive("Double Punch") || unit.hasAbilityActive("Double Shot")) {
                        applyArtifactBuff("Dual Strike Charm", AP.DUAL_STRIKE_SECOND_ATTACK_PERCENT);
                    }
                    break;
                case Tier1Artifact.WOUNDING_CHARM:
                    // Grant Level-1 Deep Wounds to the whole army (like the Wolf) so EVERY unit inflicts Deep
                    // Wounds on attack — plus the marker buff still adds +1 stack on top for units that had it.
                    applyArtifactBuff("Wounding Charm", AP.WOUNDING_CHARM_DEEP_WOUNDS_PERCENT);
                    unit.grantAbility("Deep Wounds Level 1");
                    break;
                case Tier1Artifact.BROKEN_AEGIS:
                    // Upside (offensive break, resolved in getBreakChancePerTeam) vs downside (self-miss).
                    // Functional buff power stays AEGIS_AREA_REDUCTION_PERCENT (0) so the legacy area-damage
                    // hook is a no-op; the displayed numbers come from the break/miss constants.
                    applyDualArtifact(
                        "Broken Aegis",
                        `The army's attacks have a ${BROKEN_AEGIS_BREAK_CHANCE}% chance to Break the enemy hit (muting its abilities).`,
                        `Cursed: ${BROKEN_AEGIS_MISS_CHANCE}% chance to miss on attack.`,
                        AP.AEGIS_AREA_REDUCTION_PERCENT,
                        BROKEN_AEGIS_MISS_CHANCE,
                    );
                    break;
                default:
                    break;
            }

            // ---- Tier 2 stat artifacts ----
            switch (tier2) {
                case Tier2Artifact.WARLORDS_EDGE:
                    applyArtifactBuff("Warlords Edge", AP.WARLORDS_EDGE_PERCENT);
                    break;
                case Tier2Artifact.TITAN_PLATE:
                    applyArtifactBuff("Titan Plate", AP.TITAN_PLATE_PERCENT);
                    break;
                case Tier2Artifact.CLOVER_OF_FORTUNE:
                    applyArtifactBuff("Clover of Fortune", AP.CLOVER_LUCK);
                    break;
                case Tier2Artifact.CROWN_OF_COMMAND:
                    applyArtifactBuff("Crown of Command", AP.CROWN_STEPS, AP.CROWN_MORALE);
                    break;
                case Tier2Artifact.PENDANT_OF_VITALITY:
                    applyDualArtifact(
                        "Pendant of Vitality",
                        "+{}% maximum HP for the whole army.",
                        "-{}% attack for the whole army.",
                        AP.PENDANT_HP_PERCENT,
                        AP.PENDANT_ATTACK_PENALTY_PERCENT,
                    );
                    break;
                case Tier2Artifact.BERSERKERS_BOND:
                    applyDualArtifact(
                        "Berserkers Bond",
                        "+{} attack for the whole army.",
                        "-{} defense for the whole army.",
                        AP.BERSERKERS_BOND_ATTACK,
                        AP.BERSERKERS_BOND_DEFENSE_PENALTY,
                    );
                    break;
                // Combat-time / terrain markers (checked by the relevant hook via unit.getBuff).
                case Tier2Artifact.HOLY_CROSS:
                    applyArtifactBuff("Holy Cross", AP.HOLY_CROSS_HEAL_RES_PERCENT);
                    break;
                case Tier2Artifact.GIANTS_MAUL:
                    applyArtifactBuff("Giants Maul", AP.GIANTS_MAUL_AOE_PERCENT);
                    break;
                case Tier2Artifact.FARSIGHT_QUIVER:
                    applyArtifactBuff("Farsight Quiver", AP.FARSIGHT_QUIVER_RANGE_PERCENT);
                    break;
                case Tier2Artifact.TOME_OF_AMPLIFICATION:
                    applyArtifactBuff("Tome of Amplification", AP.TOME_BUFF_POWER_PERCENT);
                    break;
                case Tier2Artifact.RIME_CHARM:
                    applyArtifactBuff("Rime Charm", AP.RIME_PROC_PERCENT, AP.RIME_SLOW_LAPS);
                    break;
                case Tier2Artifact.LAVA_STRIDERS:
                    // Grant the Made of Fire ability to the WHOLE army (like an innate Fire creature, e.g. the
                    // Wounding Charm -> Deep Wounds pattern). This makes EVERY hasAbilityActive("Made of Fire")
                    // checkpoint treat them uniformly — lava pathing, AI occupy-cell checks, combat/move handlers,
                    // the central-lava +10% boost (applyLavaWaterModifier), AND the ability icon drawn in the UI.
                    // The marker buff stays for legacy isMadeOfFire callers.
                    applyArtifactBuff("Lava Striders", 0);
                    unit.grantAbility("Made of Fire");
                    break;
                default:
                    break;
            }
        }
    }
    public getAllTeamUnitsMaxHp(teamType: TeamType): Map<string, number> {
        const teamUnitMaxHp: Map<string, number> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() === teamType) {
                teamUnitMaxHp.set(unit.getId(), unit.getMaxHp());
            }
        }

        return teamUnitMaxHp;
    }
    public getAllEnemyUnitsMagicResist(myTeamType: TeamType): Map<string, number> {
        const enemyUnitMagicResist: Map<string, number> = new Map();
        for (const unit of this.allUnits.values()) {
            if (unit.getTeam() !== myTeamType) {
                enemyUnitMagicResist.set(unit.getId(), unit.getMagicResist());
            }
        }

        return enemyUnitMagicResist;
    }
    public getUnitByStats(unitProperties: UnitProperties): Unit | undefined {
        if (!unitProperties) {
            return undefined;
        }

        const unitId = unitProperties.id;
        if (!unitId) {
            return undefined;
        }

        return this.allUnits.get(unitId);
    }
    public refreshUnitsForAllTeams(): Unit[][] {
        const unitForAllTeams: Unit[][] = new Array((Object.keys(PBTypes.TeamVals).length - 2) >> 1);
        for (const unit of this.allUnits.values()) {
            const teamId = unit.getTeam() - 1;
            if (!(teamId in unitForAllTeams)) {
                unitForAllTeams[teamId] = [];
            }
            unitForAllTeams[teamId].push(unit);
        }
        return unitForAllTeams;
    }
    public deleteUnitById(unitId: string, checkForResurrection = false): boolean {
        if (!unitId) {
            return false;
        }

        const unitToDelete = this.allUnits.get(unitId);
        let considerResurrection =
            checkForResurrection &&
            unitToDelete?.hasAbilityActive("Resurrection") &&
            unitToDelete?.hasSpellRemaining("Resurrection");

        if (considerResurrection) {
            if (unitToDelete) {
                const newAmountAlive = Math.floor((unitToDelete.getAmountDied() ?? 0) / 2);
                if (newAmountAlive > 0) {
                    unitToDelete.increaseAmountAlive(newAmountAlive);
                    unitToDelete.decreaseAmountDied(newAmountAlive);
                    unitToDelete.handleResurrectionAnimation();
                    unitToDelete.deleteAllEffects();
                    unitToDelete.deleteAllBuffs();
                    unitToDelete.deleteAllDebuffs();
                    unitToDelete.resetTarget();
                    unitToDelete.deleteAbility("Resurrection");
                    unitToDelete.useSpell("Resurrection");
                } else {
                    considerResurrection = false;
                }
            } else {
                considerResurrection = false;
            }
        }

        if (!considerResurrection) {
            if (unitToDelete) {
                this.allUnits.delete(unitId);
                this.grid.cleanupAll(unitId, unitToDelete.getAttackRange(), unitToDelete.isSmallSize());
            }

            FightStateManager.getInstance().getFightProperties().removeFromHourglassQueue(unitId);
            FightStateManager.getInstance().getFightProperties().removeFromMoraleMinusQueue(unitId);
            FightStateManager.getInstance().getFightProperties().removeFromMoralePlusQueue(unitId);
            FightStateManager.getInstance().getFightProperties().removeFromUpNext(unitId);

            return true;
        }

        return false;
    }
    public getSummonedUnitByName(teamType: TeamType, unitName: string): Unit | undefined {
        if (!unitName) {
            return undefined;
        }

        for (const u of this.getAllUnitsIterator()) {
            if (u.isSummoned() && u.getName() === unitName && u.getTeam() === teamType) {
                return u;
            }
        }

        return undefined;
    }
    public getDistanceToClosestEnemy(enemyTeam: TeamType, position: XY): number {
        let closestDistance = Number.MAX_SAFE_INTEGER;
        for (const u of this.getAllUnitsIterator()) {
            if (u.getTeam() === enemyTeam) {
                closestDistance = Math.min(closestDistance, getDistance(position, u.getPosition()));
            }
        }

        return closestDistance;
    }
    /**
     * Distance from `position` to the CENTROID (average position) of all living enemy units.
     * Used by the move-distance morale modifier so it reflects whether a unit advanced toward (or
     * retreated from) the enemy army as a whole rather than a single closest enemy — a lone flanker
     * behind the unit can no longer flip "charging into the enemy line" into a morale penalty.
     * Returns Number.MAX_SAFE_INTEGER when there are no enemies (so the caller sees no change).
     */
    public getDistanceToEnemyCentroid(enemyTeam: TeamType, position: XY): number {
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (const u of this.getAllUnitsIterator()) {
            if (u.getTeam() === enemyTeam) {
                const enemyPosition = u.getPosition();
                sumX += enemyPosition.x;
                sumY += enemyPosition.y;
                count += 1;
            }
        }

        if (count === 0) {
            return Number.MAX_SAFE_INTEGER;
        }

        return getDistance(position, { x: sumX / count, y: sumY / count });
    }
    public allEnemiesAroundUnit(attacker: IUnitAIRepr, isAttack: boolean, attackFromCell?: XY): Unit[] {
        const enemyList: Unit[] = [];
        const firstCheckCell = isAttack ? attackFromCell : attacker.getBaseCell();

        if (!firstCheckCell) {
            return enemyList;
        }

        let checkCells: XY[];

        if (attacker.isSmallSize()) {
            // use either target move position on current
            // depending on the action type (attack vs response)
            checkCells = getCellsAroundCell(this.gridSettings, firstCheckCell);
        } else {
            checkCells = [];
            for (let i = -2; i <= 1; i++) {
                for (let j = -2; j <= 1; j++) {
                    checkCells.push({ x: firstCheckCell.x + i, y: firstCheckCell.y + j });
                }
            }
        }

        for (const c of checkCells) {
            const checkUnitId = this.grid.getOccupantUnitId(c);
            if (checkUnitId) {
                const addUnit = this.getAllUnits().get(checkUnitId);
                if (
                    addUnit &&
                    checkUnitId !== attacker.getId() &&
                    !enemyList.includes(addUnit) &&
                    !(attacker.getTeam() === addUnit.getTeam())
                ) {
                    enemyList.push(addUnit);
                }
            }
        }

        return enemyList;
    }
    public refreshStackPowerForAllUnits(): void {
        FightStateManager.getInstance()
            .getFightProperties()
            .setUnitsCalculatedStacksPower(this.gridSettings, this.allUnits);
        // Refresh position-dependent auras (e.g. Leprechaun's Luck Aura, Disguise/War Anger) before
        // recomputing per-unit stats so adjustBaseStats below sees the current aura buffs. The engine
        // (used authoritatively by the ranked server) only ever called the stack-power refresh, so
        // buff-style auras were silently inactive in ranked; pairing them here matches the sandbox,
        // whose refreshUnits() has always run both. cleanAuraEffects() makes this idempotent.
        this.refreshAuraEffectsForAllUnits();
        for (const u of this.getAllUnitsIterator()) {
            if (!isCellWithinGrid(this.gridSettings, u.getBaseCell())) {
                continue;
            }
            u.adjustBaseStats(
                FightStateManager.getInstance().getFightProperties().hasFightStarted(),
                FightStateManager.getInstance().getFightProperties().getCurrentLap(),
                FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(u.getTeam()),
                FightStateManager.getInstance().getFightProperties().getAdditionalMovementStepsPerTeam(u.getTeam()),
                FightStateManager.getInstance().getFightProperties().getAdditionalFlyArmorPerTeam(u.getTeam()),
                FightStateManager.getInstance().getFightProperties().getAdditionalMoralePerTeam(u.getTeam()),
                FightStateManager.getInstance().getFightProperties().getAdditionalLuckPerTeam(u.getTeam()),
                FightStateManager.getInstance().getFightProperties().getStepsMoraleMultiplier(),
            );
            u.increaseAttackMod(this.getUnitAuraAttackMod(u));
            u.setSynergies(FightStateManager.getInstance().getFightProperties().getSynergiesPerTeam(u.getTeam()));

            const disguiseAura = u.getAppliedAuraEffect("Disguise Aura");
            if (disguiseAura) {
                if (
                    this.getNumberOfEnemiesWithinRange(
                        u,
                        disguiseAura.getRange() +
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalAuraRangePerTeam(u.getTeam()),
                    )
                ) {
                    u.deleteBuff("Hidden");
                    if (!u.hasDebuffActive("Visible")) {
                        u.applyDebuff(
                            new Spell({
                                spellProperties: getSpellConfig("System", "Visible"),
                                amount: 1,
                            }),
                        );
                    }
                } else {
                    u.deleteDebuff("Visible");
                    if (!u.hasBuffActive("Hidden")) {
                        u.applyBuff(
                            new Spell({
                                spellProperties: getSpellConfig("System", "Hidden"),
                                amount: 1,
                            }),
                        );
                    }
                }
            }
        }
    }
    public getNumberOfEnemiesWithinRange(unit: Unit, range: number): number {
        const enemyIdsSpotted: string[] = [];
        const enemyIds: string[] = [];
        for (const e of this.getAllEnemyUnits(unit.getTeam())) {
            enemyIds.push(e.getId());
        }

        for (const c of unit.getCells()) {
            const auraCells = EffectHelper.getAuraCells(this.gridSettings, c, range);
            for (const ac of auraCells) {
                const occupantId = this.grid.getOccupantUnitId(ac);
                if (!occupantId) {
                    continue;
                }

                if (enemyIds.includes(occupantId) && !enemyIdsSpotted.includes(occupantId)) {
                    enemyIdsSpotted.push(occupantId);
                }
            }
        }

        return enemyIdsSpotted.length;
    }
    public getUnitAuraAttackMod(unit: Unit, cells?: XY[]): number {
        let auraAttackMod = 0;
        const warAngerAuraEffect = unit.getAuraEffect("War Anger");
        if (warAngerAuraEffect) {
            const enemyIdsSpotted: string[] = [];
            const enemyIds: string[] = [];
            for (const e of this.getAllEnemyUnits(unit.getTeam())) {
                enemyIds.push(e.getId());
            }

            const unitCells = cells?.length ? cells : unit.getCells();

            for (const c of unitCells) {
                const auraCells = EffectHelper.getAuraCells(
                    this.gridSettings,
                    c,
                    warAngerAuraEffect.getRange() +
                        FightStateManager.getInstance()
                            .getFightProperties()
                            .getAdditionalAuraRangePerTeam(unit.getTeam()),
                );
                for (const ac of auraCells) {
                    const occupantId = this.grid.getOccupantUnitId(ac);
                    if (!occupantId) {
                        continue;
                    }

                    if (enemyIds.includes(occupantId) && !enemyIdsSpotted.includes(occupantId)) {
                        enemyIdsSpotted.push(occupantId);
                    }
                }
            }

            return unit.getBaseAttack() * ((warAngerAuraEffect.getPower() * enemyIdsSpotted.length) / 100);
        }

        return auraAttackMod;
    }
    public refreshAuraEffectsForAllUnits(): void {
        // setup the initial empty maps
        this.teamsAuraEffects = new Map();
        for (let i = 0; i < (Object.keys(PBTypes.TeamVals).length - 2) >> 1; i++) {
            this.teamsAuraEffects.set((i + 1) as TeamType, new Map());
        }

        // fill the maps with the aura effects, duplicate auras allowed
        for (const u of this.getAllUnitsIterator()) {
            if (!isCellWithinGrid(this.gridSettings, u.getBaseCell())) {
                continue;
            }

            u.cleanAuraEffects();

            const unitAuraEffects = u.getAuraEffects();
            for (const uae of unitAuraEffects) {
                for (const c of u.getCells()) {
                    uae.toDefault();
                    const unitAuraEffectProperties = uae.getProperties();
                    if (unitAuraEffectProperties.power) {
                        unitAuraEffectProperties.power = u.calculateAuraPower(
                            uae,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalAbilityPowerPerTeam(u.getTeam()),
                        );
                    }

                    const auraRange =
                        unitAuraEffectProperties.range +
                        FightStateManager.getInstance().getFightProperties().getAdditionalAuraRangePerTeam(u.getTeam());

                    if (auraRange < 0) {
                        continue;
                    }

                    const teamAuraEffects = this.teamsAuraEffects.get(
                        unitAuraEffectProperties.is_buff ? u.getTeam() : u.getOppositeTeam(),
                    );

                    if (!teamAuraEffects) {
                        continue;
                    }

                    const affectedCellKeys = EffectHelper.getAuraCellKeys(this.gridSettings, c, auraRange);
                    for (const ack of affectedCellKeys) {
                        if (!teamAuraEffects.has(ack)) {
                            teamAuraEffects.set(ack, []);
                        }

                        const teamAuraEffectsPerCell = teamAuraEffects.get(ack);
                        if (!teamAuraEffectsPerCell) {
                            continue;
                        }

                        const baseCell = u.getBaseCell();
                        if (!baseCell) {
                            continue;
                        }

                        teamAuraEffectsPerCell.push(
                            new AppliedAuraEffectProperties(unitAuraEffectProperties, baseCell),
                        );
                    }
                }
            }
        }

        // within the same team, squash aura effects where for the same auras, the one with bigger power will be applied
        for (const [team, cells] of this.teamsAuraEffects) {
            const newValue = new Map<number, AppliedAuraEffectProperties[]>();
            for (const [cellKey, appliedAuraEffects] of cells) {
                const auraEffectsMap = new Map<string, AppliedAuraEffectProperties>();
                for (const aae of appliedAuraEffects) {
                    const auraEffectProperties = aae.getAuraEffectProperties();
                    if (!auraEffectsMap.has(auraEffectProperties.name)) {
                        auraEffectsMap.set(auraEffectProperties.name, aae);
                    } else {
                        const existingAppliedAuraEffect = auraEffectsMap.get(auraEffectProperties.name);
                        if (!existingAppliedAuraEffect) {
                            continue;
                        }
                        const existingAuraEffectProperties = existingAppliedAuraEffect.getAuraEffectProperties();

                        if (auraEffectProperties.power > existingAuraEffectProperties.power) {
                            auraEffectsMap.set(auraEffectProperties.name, aae);
                        }
                    }
                }
                newValue.set(cellKey, Array.from(auraEffectsMap.values()));
            }
            this.teamsAuraEffects.set(team, newValue);
        }

        // apply aura effects to the units
        for (const u of this.getAllUnitsIterator()) {
            const teamAuraEffects = this.teamsAuraEffects.get(u.getTeam());
            if (!teamAuraEffects) {
                continue;
            }

            let unitAuraNamesToApply: string[] = [];
            let unitAppliedAuraEffectProperties: AppliedAuraEffectProperties[] = [];
            for (const c of u.getCells()) {
                const cellKey = (c.x << 4) | c.y;
                const appliedAuraEffects = teamAuraEffects.get(cellKey);
                if (!appliedAuraEffects || !appliedAuraEffects.length) {
                    continue;
                }

                for (const aae of appliedAuraEffects) {
                    const auraEffectProperties = aae.getAuraEffectProperties();
                    if (!unitAuraNamesToApply.includes(auraEffectProperties.name)) {
                        unitAuraNamesToApply.push(`${auraEffectProperties.name} Aura`);
                        unitAppliedAuraEffectProperties.push(aae);
                    }
                }
            }

            for (let i = 0; i < unitAppliedAuraEffectProperties.length; i++) {
                const appliedAuraEffectProperties = unitAppliedAuraEffectProperties[i];
                const auraEffectProperties = appliedAuraEffectProperties.getAuraEffectProperties();
                if (EffectHelper.canApplyAuraEffect(u, auraEffectProperties)) {
                    u.applyAuraEffect(
                        `${auraEffectProperties.name} Aura`,
                        auraEffectProperties.desc.replace(/\{\}/g, auraEffectProperties.power.toString()),
                        auraEffectProperties.is_buff,
                        Number(auraEffectProperties.power.toFixed(1)),
                        appliedAuraEffectProperties.getSourceCellAsString(),
                    );
                }
            }
        }
    }
    public addUnit(unit: Unit): void {
        this.allUnits.set(unit.getId(), unit);
    }
    public decreaseMoraleForTheSameUnitsOfTheTeam(moraleDecreaseForTheUnitTeam: Record<string, number>): void {
        for (const unitNameKey of Object.keys(moraleDecreaseForTheUnitTeam)) {
            const moraleDecrease = moraleDecreaseForTheUnitTeam[unitNameKey];
            const unitNameKeySplit = unitNameKey.split(":");
            if (unitNameKeySplit.length === 2) {
                const unitName = unitNameKeySplit[0];
                const unitTeam = parseInt(unitNameKeySplit[1]);
                if (unitTeam !== PBTypes.TeamVals.LOWER && unitTeam !== PBTypes.TeamVals.UPPER) {
                    continue;
                }
                for (const u of this.getAllUnitsIterator()) {
                    if (u.getTeam() === unitTeam && u.getName() === unitName) {
                        u.decreaseMorale(
                            moraleDecrease,
                            FightStateManager.getInstance()
                                .getFightProperties()
                                .getAdditionalMoralePerTeam(u.getTeam()),
                        );
                    }
                }
            }
        }
    }
    public increaseUnitsSupplyIfNeededPerTeam(team: TeamType): void {
        if (
            FightStateManager.getInstance().getFightProperties().hasFightStarted() ||
            FightStateManager.getInstance().getFightProperties().hasFightFinished()
        ) {
            return;
        }

        for (const u of this.getAllUnitsIterator()) {
            if (u.getTeam() === team) {
                u.increaseSupply(FightStateManager.getInstance().getFightProperties().getAdditionalSupplyPerTeam(team));
            }
        }
    }
    public deleteUnitIfNotAllowed(
        unitId: string,
        lowerLeftPlacement?: IPlacement,
        upperRightPlacement?: IPlacement,
        lowerRightPlacement?: IPlacement,
        upperLeftPlacement?: IPlacement,
        verifyWithinGridPosition = true,
    ): boolean {
        const unit = this.allUnits.get(unitId);
        if (!unit) {
            return this.deleteUnitById(unitId);
        }

        const unitCells = unit.getCells();
        const teamType = unit.getTeam();
        const enemyTeamType = unit.getOppositeTeam();

        for (const c of unitCells) {
            const cellPosition = getPositionForCell(
                c,
                this.gridSettings.getMinX(),
                this.gridSettings.getStep(),
                this.gridSettings.getHalfStep(),
            );

            const isWithinGrid = isPositionWithinGrid(this.gridSettings, cellPosition);
            if (
                (enemyTeamType === PBTypes.TeamVals.LOWER &&
                    ((lowerLeftPlacement && lowerLeftPlacement.isAllowed(cellPosition)) ||
                        (lowerRightPlacement && lowerRightPlacement.isAllowed(cellPosition)))) ||
                (enemyTeamType === PBTypes.TeamVals.UPPER &&
                    ((upperRightPlacement && upperRightPlacement.isAllowed(cellPosition)) ||
                        (upperLeftPlacement && upperLeftPlacement.isAllowed(cellPosition)))) ||
                (isWithinGrid &&
                    teamType === PBTypes.TeamVals.LOWER &&
                    !lowerLeftPlacement?.isAllowed(cellPosition) &&
                    !lowerRightPlacement?.isAllowed(cellPosition)) ||
                (isWithinGrid &&
                    teamType === PBTypes.TeamVals.UPPER &&
                    !upperRightPlacement?.isAllowed(cellPosition) &&
                    !upperLeftPlacement?.isAllowed(cellPosition)) ||
                (verifyWithinGridPosition && !isWithinGrid)
            ) {
                return this.deleteUnitById(unitId);
            }
        }

        return false;
    }
}
