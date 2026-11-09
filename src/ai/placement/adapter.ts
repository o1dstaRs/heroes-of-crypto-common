import { creatureIdForName, creatureInfo } from "../setup/creature_score";
import { propose, encode, predict, chooseCandidate, valid, type PublicInput, type Point, type Body } from "./layout";
import { getPlacementModel, getPlacementRelationModel } from "./model";
import { relationFeatures } from "./relations";
import { protectA19WanderingMagePlacement } from "../wandering_mage_support";
import { protectA19HealerPlacement } from "../healer_support_setup";
export interface PlacementUnit {
    getId(): string;
    getName(): string;
    getAmountAlive(): number;
    getFootprintWidth(): number;
    getFootprintHeight(): number;
}
export interface PlacementEnvelope {
    team: number;
    gridType: number;
    sideOrientedPlacement: boolean;
    legalCellHashes: ReadonlySet<number>;
    publicOpponentCreatureIds: readonly number[];
    artifacts: readonly [number, number];
    doctrine: number;
    augments: readonly { kind: string; value: number }[];
}
export function buildPlacementInput(
    units: readonly PlacementUnit[],
    context: PlacementEnvelope,
): PublicInput | undefined {
    if (
        !context.sideOrientedPlacement ||
        ![1, 3, 4].includes(context.gridType) ||
        ![1, 2].includes(context.team) ||
        context.doctrine !== 3 ||
        units.length < 6 ||
        units.length > 12 ||
        context.artifacts.some((a) => !Number.isInteger(a) || a < 1 || a >= 64)
    )
        return undefined;
    const levels = new Map(context.augments.map((a) => [a.kind, a.value]));
    if (
        levels.size !== context.augments.length ||
        [...levels.values()].some((v) => !Number.isInteger(v) || v < 0 || v > 3) ||
        [...levels.keys()].some((k) => !["Placement", "Armor", "Might", "Sniper", "Movement", "Empower"].includes(k)) ||
        ["Placement", "Movement", "Empower"].some((k) => (levels.get(k) ?? 0) !== 0) ||
        levels.get("Armor") !== 3 ||
        !(
            (levels.get("Might") === 1 && levels.get("Sniper") === 3) ||
            (levels.get("Might") === 3 && levels.get("Sniper") === 1)
        )
    )
        return undefined;
    const enemyIds = [...new Set(context.publicOpponentCreatureIds)].sort((a, b) => a - b);
    if (enemyIds.length !== 6 || enemyIds.some((c) => !Number.isInteger(c) || c < 0 || c >= 128 || !creatureInfo(c)))
        return undefined;
    const bodies: Body[] = [];
    const totals = new Map<number, number>();
    for (const u of units) {
        const creature = creatureIdForName(u.getName());
        if (
            creature === undefined ||
            creature >= 128 ||
            !Number.isInteger(u.getAmountAlive()) ||
            u.getAmountAlive() < 1
        )
            return undefined;
        const i = creatureInfo(creature)!;
        totals.set(creature, (totals.get(creature) ?? 0) + u.getAmountAlive());
        bodies.push({
            id: u.getId(),
            creature,
            name: u.getName(),
            amount: u.getAmountAlive(),
            width: u.getFootprintWidth(),
            height: u.getFootprintHeight(),
            ranged: i.ranged,
            caster: i.caster,
            healer: u.getName() === "Healer",
            aura: i.auraCount > 0,
            fly: i.canFly,
            driven: i.abilities.includes("AI Driven"),
            hp: i.hp,
            damage: i.maxDamage,
            range: i.distance,
            steps: i.movementSteps ?? 0,
            initiative: i.initiative,
            level: i.level,
        });
    }
    if (
        totals.size !== 6 ||
        new Set(bodies.map((b) => b.id)).size !== bodies.length ||
        [...totals].some(([id, n]) => n !== Math.ceil(1000 / creatureInfo(id)!.exp))
    )
        return undefined;
    const rosterLevels = [...totals.keys()].map((id) => creatureInfo(id)!.level).sort((a, b) => a - b);
    if (rosterLevels.join(",") !== "1,1,2,2,3,4") return undefined;
    return {
        bodies,
        enemyIds,
        enemyKits: enemyIds.map((id) => creatureInfo(id)!.abilities),
        map: context.gridType,
        artifacts: [...context.artifacts],
        doctrine: context.doctrine,
        augments: context.augments.map((a) => ({ ...a })),
        left: context.team === 2,
        legal: [...context.legalCellHashes],
    };
}
export function finalizePlacement(
    units: readonly PlacementUnit[],
    context: PlacementEnvelope,
    incumbent: ReadonlyMap<string, Point>,
): Map<string, Point> {
    let retained = incumbent;
    const fallback = () => new Map([...retained].map(([id, p]) => [id, { ...p }]));
    try {
        const input = buildPlacementInput(units, context);
        if (!input || incumbent.size !== units.length) return fallback();
        const baseline = units.map((u) => incumbent.get(u.getId()));
        if (baseline.some((p) => p === undefined)) return fallback();
        const anchors = baseline as Point[];
        if (!valid(input, anchors)) return fallback();
        const model = getPlacementModel();
        const options = Array.from({ length: 8 }, (_, i) => propose(input, anchors, i));
        const scores = options.map((p) => predict(model, encode(input, p)));
        const reference = chooseCandidate(scores, model.minimumGain);
        retained = new Map(units.map((u, i) => [u.getId(), { ...options[reference][i] }]));
        const relationModel = getPlacementRelationModel();
        const relationScores = options.map((p) =>
            predict(relationModel, relationFeatures(input, p, options[reference])),
        );
        const selected = options[chooseCandidate(relationScores, relationModel.minimumGain, reference)];
        if (!valid(input, selected)) return fallback();
        return new Map(units.map((u, i) => [u.getId(), { ...selected[i] }]));
    } catch {
        return fallback();
    }
}

/** Apply user-adopted support protection after the unchanged learned formation, before barrels. */
export function finalizeA19Placement(
    units: readonly PlacementUnit[],
    context: PlacementEnvelope,
    incumbent: ReadonlyMap<string, Point>,
): Map<string, Point> {
    const learned = finalizePlacement(units, context, incumbent);
    if (
        units.length !== learned.size ||
        new Set(units.map((unit) => unit.getId())).size !== units.length ||
        !units.some((unit) => unit.getName() === "Wandering Mage" || unit.getName() === "Healer")
    )
        return learned;
    const supportUnits = units.map((unit) => ({
        id: unit.getId(),
        name: unit.getName(),
        amount: unit.getAmountAlive(),
        small: unit.getFootprintWidth() === 1 && unit.getFootprintHeight() === 1,
        footprintWidth: unit.getFootprintWidth(),
        footprintHeight: unit.getFootprintHeight(),
    }));
    return protectA19WanderingMagePlacement(
        protectA19HealerPlacement(learned, supportUnits, context),
        supportUnits,
        context,
    );
}
