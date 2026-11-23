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

import { Tier2Artifact } from "../../artifacts/artifact_properties";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { tier2ArtifactHasBeneficiary } from "./artifact_fit";
import type { ITier2ArtifactDecisionContext } from "./setup_strategy";

/**
 * a19-lava-map-artifact-v1 (owner, 2026-11-22: "AI suggests lava striders on open map lol"). Lava Striders lets an army
 * move over and stand in lava, and a unit that crosses lava with it gains Made of Fire's boost; only the lava-centre map
 * has lava. The Tier-2 tables are averages over every map, so the policy took Lava Striders as often on a map without
 * lava, where it does nothing, as on the lava map.
 *
 * With the map known at the pick (it is public at the Tier-2 pick for every doctrine), on a map without lava Lava
 * Striders leaves the offer while an artifact this army can use is on it. The lava map and an unknown map leave the
 * choice unchanged: the registered rule for the lava map (a striker army takes Lava Striders) failed its strength gate
 * and is not part of this policy. See docs/lava_map_artifact_adoption.md.
 */
export const A19_LAVA_MAP_ARTIFACT_POLICY = "a19-lava-map-artifact-v1" as const;

/** Whether the map has lava; undefined while the map is unknown. */
export function a19MapHasLava(gridType: number | undefined): boolean | undefined {
    return gridType === undefined ? undefined : gridType === PBTypes.GridVals.LAVA_CENTER;
}

/**
 * The offer without Lava Striders on a known map without lava, unless no other offered artifact has a beneficiary in
 * the army (the beneficiary rule of artifact-fit-v8).
 */
export function a19LavaMapOffer(
    offered: readonly number[],
    ownIds: readonly number[],
    context: Readonly<Pick<ITier2ArtifactDecisionContext, "gridType" | "ownProspectiveCreatureIds">> | undefined,
): readonly number[] {
    if (a19MapHasLava(context?.gridType) !== false || !offered.includes(Tier2Artifact.LAVA_STRIDERS)) return offered;
    const rest = offered.filter((id) => id !== Tier2Artifact.LAVA_STRIDERS);
    return rest.some((id) => tier2ArtifactHasBeneficiary(id, ownIds, context?.ownProspectiveCreatureIds))
        ? rest
        : offered;
}

/** The Tier-2 pick: `pick` is the seat's own policy (the striker rule over artifact-fit-v8), asked on that offer. */
export function a19LavaMapTier2Artifact(
    offered: readonly number[],
    ownIds: readonly number[],
    context: Readonly<ITier2ArtifactDecisionContext> | undefined,
    pick: (offer: readonly number[]) => number,
): number {
    return pick(a19LavaMapOffer(offered, ownIds, context));
}
