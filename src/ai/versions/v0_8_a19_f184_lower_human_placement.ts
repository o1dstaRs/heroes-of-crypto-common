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

import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { creatureIdForName } from "../setup/creature_score";
import { footprintCenterForAnchor } from "./v0_1";
import {
    V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_HUMAN_PLACEMENT_POLICY,
    V08A19F184HumanPlacementStrategy,
    type V08A19F184HumanOpeningId,
    type V08A19F184HumanPlacementFallbackReason,
} from "./v0_8_a19_f184_human_placement";

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256 = V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256;

export const V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY = Object.freeze({
    schema: "hoc.v0_8_a19_f184_human_placement.v11.lower-only-v1" as const,
    policyId: "a19-prod-f184-opening-lower-only-v1" as const,
    researchOnly: true as const,
    baseStrategy: "v0.8+a19-h18" as const,
    maps: V08_A19_F184_HUMAN_PLACEMENT_POLICY.maps,
    information: "own-army+map+legal-cells+public-opponent-identities" as const,
    treatment: "exact-public-matchup-production-opening-lower-only-v1" as const,
    supportedTeam: PBTypes.TeamVals.LOWER,
    productionFixtureSha256: V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256,
    upstreamPolicy: Object.freeze({
        schema: V08_A19_F184_HUMAN_PLACEMENT_POLICY.schema,
        policyId: V08_A19_F184_HUMAN_PLACEMENT_POLICY.policyId,
    }),
});

export type V08A19F184LowerHumanPlacementFallbackReason = V08A19F184HumanPlacementFallbackReason;
export type V08A19F184LowerHumanOpeningId = V08A19F184HumanOpeningId;

export interface IV08A19F184LowerHumanPlacementAudit {
    readonly treatmentApplied: boolean;
    readonly placementChanged: boolean;
    readonly horizontalDisplacement: number;
    readonly openingId: V08A19F184LowerHumanOpeningId | null;
    readonly templateUnitsMoved: number;
    readonly fallbackReason: V08A19F184LowerHumanPlacementFallbackReason | null;
    readonly incumbentFingerprint: string;
    readonly selectedFingerprint: string;
}

// Formations are compared by where the BODIES sit, so the anchor is pulled back half a cell per extra column
// and row: unchanged for a 1x1 and a 2x2, and a rectangle now leans only along its long side.
const centerFor = footprintCenterForAnchor;

const normalizedPlacementFingerprint = (
    units: readonly Unit[],
    team: IPlacementContext["team"],
    placement: ReadonlyMap<string, XY>,
): string => {
    const rows = units.map((unit) => {
        const base = placement.get(unit.getId());
        const center = base ? centerFor(unit, base) : undefined;
        return [
            creatureIdForName(unit.getName()) ?? null,
            unit.getLevel(),
            unit.getAmountAlive(),
            unit.getSize(),
            center?.x ?? null,
            center === undefined ? null : team === PBTypes.TeamVals.LOWER ? center.y : GRID_SIZE - 1 - center.y,
        ];
    });
    rows.sort((left, right) => JSON.stringify(left.slice(0, 4)).localeCompare(JSON.stringify(right.slice(0, 4))));
    return JSON.stringify(rows);
};

/**
 * Apply the exact f184 opening only to LOWER. The wrapped v10 policy remains the single implementation of
 * the roster, metadata, placement-geometry, public-information, overlap, and legality gates.
 */
export class V08A19F184LowerHumanPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    private readonly lowerPolicy: V08A19F184HumanPlacementStrategy;
    private lastPlacementAudit?: IV08A19F184LowerHumanPlacementAudit;
    public constructor(private readonly base: IAIStrategy) {
        this.version = base.version;
        this.lowerPolicy = new V08A19F184HumanPlacementStrategy(base);
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        if (context.team === PBTypes.TeamVals.LOWER) {
            const selected = this.lowerPolicy.placeArmy(units, context);
            const audit = this.lowerPolicy.getLastPlacementAudit();
            if (!audit) throw new Error("Lower-only f184 placement delegate did not produce an audit");
            this.lastPlacementAudit = Object.freeze({ ...audit });
            return selected;
        }
        const incumbent = this.base.placeArmy(units, context);
        const incumbentFingerprint = normalizedPlacementFingerprint(units, context.team, incumbent);
        this.lastPlacementAudit = Object.freeze({
            treatmentApplied: false,
            placementChanged: false,
            horizontalDisplacement: 0,
            openingId: null,
            templateUnitsMoved: 0,
            fallbackReason: "unsupported-team",
            incumbentFingerprint,
            selectedFingerprint: incumbentFingerprint,
        });
        return incumbent;
    }
    public getLastPlacementAudit(): IV08A19F184LowerHumanPlacementAudit | undefined {
        return this.lastPlacementAudit;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export function applyV08A19F184LowerHumanPlacement(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
): Map<string, XY> {
    return new V08A19F184LowerHumanPlacementStrategy({
        version: "v0.8",
        placeArmy: () => incumbent,
        decideTurn: () => [],
    }).placeArmy(units, context);
}

export const withV08A19F184LowerHumanPlacement = (base: IAIStrategy): IAIStrategy =>
    new V08A19F184LowerHumanPlacementStrategy(base);
