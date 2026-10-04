/*
 * This file is part of the common code of the Heroes of Crypto.
 * Licensed under the MIT license in the source tree's LICENSE file.
 */
import { creatureInfo, creatureIdForName } from "../setup/creature_score";
import { PBTypes } from "../../generated/protobuf/v1/types";

/** Opt-in research budget based only on this seat's completed roster and the public map. */
export function roleSearchPlan(names: readonly string[], gridType: number = PBTypes.GridVals.NORMAL) {
    const infos = [...new Set(names)]
        .map((n) => creatureIdForName(n))
        .map((id) => (id === undefined ? undefined : creatureInfo(id)))
        .filter((info) => info !== undefined);
    const ranged = infos.filter((i) => i.ranged).length;
    const magic = infos.filter((i) => i.rangedSpellDamage).length;
    const artillery = infos.some((i) => i.level === 4 && i.abilities.includes("No Melee"));
    const healer = infos.some((i) => i.level === 4 && i.caster && i.abilities.includes("Resurrection"));
    const areaCarry = infos.some((i) => i.level === 4 && !i.canFly && i.ranged && i.abilities.includes("Area Throw"));
    const spellCarry = infos.some((i) => i.level === 4 && i.rangedSpellDamage);
    const expandedGroundHybrid =
        gridType === PBTypes.GridVals.BLOCK_CENTER &&
        magic === 1 &&
        ranged === 3 &&
        !artillery &&
        !areaCarry &&
        !healer &&
        !spellCarry &&
        !infos.some((i) => i.level === 4 && i.abilities.includes("Dense Flesh"));
    const lowPhysicalMagic = magic >= 2 && ranged <= 2;
    const hybridBattery = magic >= 2 && ranged >= 3;
    const preserveSparseArtillery = artillery && ranged === 3 && gridType !== PBTypes.GridVals.NORMAL;
    const densePhysicalArea = areaCarry && magic <= 1;
    const mixedBattery = magic >= 1 && ranged >= 3;
    const lavaMixedArtillery = preserveSparseArtillery && magic === 1 && gridType === PBTypes.GridVals.LAVA_CENTER;
    const narrowCaster = (healer && magic === 1 && ranged <= 2) || (spellCarry && magic === 1 && ranged === 2);
    const screenPhysical =
        magic === 0 && ranged >= 3 && infos.some((i) => i.level === 4 && !i.canFly && i.melee && i.auraCount > 0);
    const deepSparseAnchor =
        magic === 1 &&
        ranged <= 2 &&
        ((healer && gridType === PBTypes.GridVals.LAVA_CENTER) ||
            artillery ||
            infos.some((info) => info.level === 4 && info.abilities.includes("AI Driven")));
    const deepBlockedArea = areaCarry && magic === 1 && ranged >= 4 && gridType === PBTypes.GridVals.BLOCK_CENTER;
    const deepNormalArtillery = artillery && magic === 1 && ranged >= 4 && gridType === PBTypes.GridVals.NORMAL;
    const deepBlockedSpell = spellCarry && magic === 1 && ranged >= 3 && gridType === PBTypes.GridVals.BLOCK_CENTER;
    const deepBufferedArtillery =
        gridType === PBTypes.GridVals.BLOCK_CENTER &&
        artillery &&
        magic === 1 &&
        ranged === 3 &&
        infos.some((i) => i.abilities.includes("Rallying Volley Aura")) &&
        infos.some((i) => i.castsAmplifiableBuff);
    const relative =
        lavaMixedArtillery ||
        narrowCaster ||
        screenPhysical ||
        densePhysicalArea ||
        (!preserveSparseArtillery && artillery && ranged >= 3) ||
        healer ||
        (areaCarry && ranged <= 2) ||
        (spellCarry && magic === 1 && ranged >= 3) ||
        lowPhysicalMagic;
    return {
        ranged,
        magic,
        artillery,
        healer,
        areaCarry,
        hybridBattery,
        screenPhysical,
        narrowCaster,
        lavaMixedArtillery,
        rollouts:
            deepSparseAnchor || deepBlockedArea || deepBlockedSpell || deepBufferedArtillery
                ? 128
                : deepNormalArtillery
                  ? 96
                  : (artillery && ranged >= 4) || lavaMixedArtillery
                    ? 64
                    : 32,
        horizon:
            deepSparseAnchor || deepBlockedArea || deepNormalArtillery || deepBlockedSpell || deepBufferedArtillery
                ? 128
                : (artillery && ranged >= 4) || lavaMixedArtillery
                  ? 128
                  : 64,
        moves: expandedGroundHybrid
            ? 8
            : artillery && ranged >= 4
              ? 8
              : (!preserveSparseArtillery && artillery && ranged === 3) ||
                  lowPhysicalMagic ||
                  densePhysicalArea ||
                  mixedBattery ||
                  screenPhysical ||
                  narrowCaster
                ? 4
                : 1,
        shortlist:
            (artillery && ranged >= 4) || densePhysicalArea || mixedBattery || screenPhysical || narrowCaster ? 24 : 12,
        throws: densePhysicalArea ? 16 : 4,
        moveShots: ranged >= 3 ? 2 : 0,
        material: relative ? "sample-relative" : "sample-ties",
        chakram: screenPhysical || (relative && !hybridBattery) || (areaCarry && magic === 0),
        airSupport:
            spellCarry ||
            (areaCarry && ranged <= 2) ||
            (!preserveSparseArtillery && artillery && ranged === 3) ||
            (artillery && ranged >= 4 && gridType === PBTypes.GridVals.LAVA_CENTER),
        casterSupport: healer && magic >= 2,
    };
}
export type V08A19RoleSearchPlan = ReturnType<typeof roleSearchPlan>;

/** A detached override object; callers scope it to one search driver without changing ambient process state. */
export function v08A19RoleSearchOverrides(plan: V08A19RoleSearchPlan): Readonly<Record<string, string>> {
    return Object.freeze({
        SEARCH_MAX_MOVES: String(plan.moves),
        SEARCH_SHORTLIST: String(plan.shortlist),
        SEARCH_MAX_THROWS: String(plan.throws),
        SEARCH_MAX_MOVE_SHOTS: String(plan.moveShots),
        SEARCH_ROLLOUTS: String(plan.rollouts),
        SEARCH_HORIZON: String(plan.horizon),
        SEARCH_MAX_MELEE: "16",
        SEARCH_MAX_SHOTS: "24",
        SEARCH_A19_MATERIAL_ARBITRATION: plan.material,
        SEARCH_A19_HEALER_OPENING_COHESION: "1",
        SEARCH_A19_MATERIAL_LOW_EVIDENCE_WINS: plan.areaCarry && plan.magic === 1 && plan.ranged >= 3 ? "3" : "1",
    });
}
