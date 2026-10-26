/** Shared research observation: one board encoding, with candidate-relative action/target inputs. */
import type { IDecisionContext } from "../../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../../ai/candidates";
import {
    V09_INPUT_FEATURE_NAMES,
    v09CandidateFeatureVector,
    v09RangeObservation,
} from "../../ai/versions/v0_9_features";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import { ObstacleType } from "../../obstacles/obstacle_type";
import type { Unit } from "../../units/unit";
import { hashSimulationParts } from "../army";
import { v09CandidateSignature } from "../../ai/versions/v0_9";
import { VALUE_FEATURE_NAMES_V2, extractValueFeaturesV2 } from "../value_features";
import { fingerprintV09 } from "./protocol";
import spellsJson from "../../configuration/spells.json";
import { ilCandidateActionMetadata } from "../il_action_features";
import type { XY } from "../../utils/math";

const ABILITY_BUCKETS = 64;
const STATUS_BUCKETS = 32;
export const V09_A19_ENTITY_FEATURES = [
    "own",
    "actor",
    "forward",
    "lateral",
    "forwardExtent",
    "lateralExtent",
    "level",
    "logAlive",
    "logDead",
    "logHp",
    "hpFraction",
    "attack",
    "armor",
    "rangeArmor",
    "damageMin",
    "damageMax",
    "steps",
    "initiative",
    "morale",
    "luck",
    "ranged",
    "flyer",
    "caster",
    "shots",
    "rangeDistance",
    "notActed",
    "hourglassSpent",
    "retaliationSpent",
    "spellCharges",
    ...Array.from({ length: ABILITY_BUCKETS }, (_, index) => `abilityBucket${index}`),
    ...Array.from({ length: STATUS_BUCKETS }, (_, index) => `buffBucket${index}`),
    ...Array.from({ length: STATUS_BUCKETS }, (_, index) => `debuffBucket${index}`),
    ...Array.from({ length: STATUS_BUCKETS }, (_, index) => `effectBucket${index}`),
] as const;
export const V09_A19_SPELL_NAMES = Object.freeze(
    [
        ...new Set(
            Object.values(spellsJson).flatMap((section) =>
                typeof section === "object" && section !== null
                    ? Object.values(section).map((spell) => (spell as { name: string }).name)
                    : [],
            ),
        ),
    ].sort(),
);
const GEOMETRY_FEATURES = [
    "moveForward",
    "moveLateral",
    "targetCellForward",
    "targetCellLateral",
    "standForward",
    "standLateral",
    "aimForward",
    "aimLateral",
];
export const V09_A19_CANDIDATE_FEATURES = [
    ...V09_INPUT_FEATURE_NAMES.slice(VALUE_FEATURE_NAMES_V2.length),
    ...GEOMETRY_FEATURES,
    ...V09_A19_SPELL_NAMES.map((name) => `spell_${name}`),
];
export const V09_A19_OBSERVATION_SCHEMA = "hoc.ai.v0_9_a19_observation.v2" as const;
export const V09_A19_OBSERVATION_CONTRACT = {
    schema: V09_A19_OBSERVATION_SCHEMA,
    entities: V09_A19_ENTITY_FEATURES,
    candidates: V09_A19_CANDIDATE_FEATURES,
    globals: VALUE_FEATURE_NAMES_V2,
    terrain: [0, ObstacleType.BLOCK, ObstacleType.HOLE, ObstacleType.LAVA, ObstacleType.WATER],
    gridSize: GRID_SIZE,
    abilityBuckets: ABILITY_BUCKETS,
    statusBuckets: STATUS_BUCKETS,
    maximumEntities: 64,
    maximumCandidates: 256,
    spellVocabulary: V09_A19_SPELL_NAMES,
    geometry: "occupied-cell centroid; actor-forward and lateral; canonical candidate cells",
    terrainUnderUnits: "restore source-bound built-in terrain beneath occupants",
};
export const V09_A19_OBSERVATION_SHA256 = fingerprintV09(V09_A19_OBSERVATION_CONTRACT);

export interface IV09A19Observation {
    schema: typeof V09_A19_OBSERVATION_SCHEMA;
    contractSha256: string;
    globals: number[];
    entities: number[][];
    /** Metadata only. Neither UUIDs nor creature names are neural input. */
    entityIds: string[];
    actorIndex: number;
    terrain: number[];
    candidates: {
        signature: string;
        features: number[];
        targetIndex: number;
    }[];
}

const bounded = (values: number[]): number[] =>
    values.map((value) => {
        if (!Number.isFinite(value)) throw new Error("Non-finite neural observation");
        return Math.max(-8, Math.min(8, value));
    });

function buckets(
    entries: readonly { getName(): string; getPower(): number }[],
    width: number,
    namespace: string,
): number[] {
    const result = Array<number>(width).fill(0);
    for (const entry of entries) {
        const index = hashSimulationParts(namespace, entry.getName()) % width;
        result[index] += 1 + Math.min(2, Math.abs(entry.getPower()) / 100);
    }
    return result;
}

export function encodeV09A19Observation(
    actor: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IV09A19Observation {
    const fight = context.fightProperties;
    if (!fight) throw new Error("A19 observation needs the live fight context");
    const side = fight.isSideOrientedPlacement();
    const invert = actor.getTeam() !== PBTypes.TeamVals.LEFT;
    const cellCoordinates = (cell: XY) => {
        const rawForward = side ? cell.x : cell.y;
        return [invert ? GRID_SIZE - 1 - rawForward : rawForward, side ? cell.y : cell.x];
    };
    const coordinates = (unit: Unit) => {
        const cells = unit.getCells().map(cellCoordinates);
        return [0, 1].map((axis) => cells.reduce((sum, cell) => sum + cell[axis], 0) / cells.length);
    };
    const units = [...context.unitsHolder.getAllUnits().values()].filter((unit) => !unit.isDead());
    if (units.length > 64 || candidates.length > 256)
        throw new Error("Neural observation exceeds its declared capacity; no truncation allowed");
    units.sort((a, b) => {
        const left = coordinates(a),
            right = coordinates(b);
        return (
            Number(b.getTeam() === actor.getTeam()) - Number(a.getTeam() === actor.getTeam()) ||
            left[0] - right[0] ||
            left[1] - right[1]
        );
    });
    const entityIds = units.map((unit) => unit.getId());
    const indexOf = new Map(entityIds.map((id, index) => [id, index]));
    const entities = units.map((unit) => {
        const [forward, lateral] = coordinates(unit);
        const original = unit.getAmountAlive() + unit.getAmountDied();
        const abilities = unit.getAbilities().filter((ability) => unit.hasAbilityActive(ability.getName()));
        const vector = bounded([
            Number(unit.getTeam() === actor.getTeam()),
            Number(unit.getId() === actor.getId()),
            forward / 15,
            lateral / 15,
            (side ? unit.getFootprintWidth() : unit.getFootprintHeight()) / 4,
            (side ? unit.getFootprintHeight() : unit.getFootprintWidth()) / 4,
            unit.getLevel() / 4,
            Math.log1p(unit.getAmountAlive()) / 8,
            Math.log1p(unit.getAmountDied()) / 8,
            Math.log1p(Math.max(0, unit.getCumulativeHp())) / 12,
            unit.getCumulativeHp() / Math.max(1, original * unit.getMaxHp()),
            unit.getAttack() / 100,
            unit.getArmor() / 100,
            unit.getRangeArmor() / 100,
            unit.getAttackDamageMin() / 100,
            unit.getAttackDamageMax() / 100,
            unit.getSteps() / 16,
            unit.getInitiative() / 100,
            unit.getMorale() / 10,
            unit.getLuck() / 10,
            Number(unit.isRangeCapable()),
            Number(unit.canFly()),
            Number(unit.getCanCastSpells()),
            unit.getRangeShots() / 32,
            unit.getRangeShotDistance() / 16,
            Number(!fight.hasAlreadyMadeTurn(unit.getId())),
            Number(fight.hasAlreadyHourglass(unit.getId())),
            Number(fight.hasAlreadyRepliedAttack(unit.getId())),
            Math.log1p(unit.getSpells().reduce((sum, spell) => sum + Math.max(0, spell.getAmount()), 0)) / 8,
            ...buckets(abilities, ABILITY_BUCKETS, "v09-ability-v1"),
            ...buckets(unit.getBuffs(), STATUS_BUCKETS, "v09-buff-v1"),
            ...buckets(unit.getDebuffs(), STATUS_BUCKETS, "v09-debuff-v1"),
            ...buckets(unit.getEffects(), STATUS_BUCKETS, "v09-effect-v1"),
        ]);
        if (vector.length !== V09_A19_ENTITY_FEATURES.length) throw new Error("Entity observation width drift");
        return vector;
    });
    const matrix = context.grid.getMatrixNoUnits();
    // getMatrixNoUnits returns zero before checking built-in terrain at occupied cells. Restore it
    // without changing engine occupancy. These read-only private seams are bound by the source hash.
    const surface = context.grid as unknown as {
        cleanedUpCenter: boolean;
        isCenterObstacleCell(x: number, y: number): boolean;
        getObstacleTypePerGrid(): number | undefined;
    };
    const builtIn = surface.cleanedUpCenter ? undefined : surface.getObstacleTypePerGrid();
    const terrain: number[] = [];
    for (let forward = 0; forward < GRID_SIZE; forward++) {
        for (let lateral = 0; lateral < GRID_SIZE; lateral++) {
            const rawForward = invert ? GRID_SIZE - 1 - forward : forward;
            const x = side ? rawForward : lateral,
                y = side ? lateral : rawForward;
            const ground =
                matrix[y][x] === 0 && builtIn !== undefined && surface.isCenterObstacleCell(x, y)
                    ? builtIn
                    : matrix[y][x];
            const index = V09_A19_OBSERVATION_CONTRACT.terrain.indexOf(ground);
            if (index < 0) throw new Error("Unrepresented terrain in neural observation");
            terrain.push(index);
        }
    }
    const actorIndex = indexOf.get(actor.getId());
    if (actorIndex === undefined) throw new Error("Living actor omitted from neural observation");
    return {
        schema: V09_A19_OBSERVATION_SCHEMA,
        contractSha256: V09_A19_OBSERVATION_SHA256,
        globals: bounded(extractValueFeaturesV2(context.unitsHolder, fight, actor.getTeam())),
        entities,
        entityIds,
        actorIndex,
        terrain,
        candidates: candidates.map((candidate) => {
            const metadata = ilCandidateActionMetadata(candidate);
            if (metadata.spell && !V09_A19_SPELL_NAMES.includes(metadata.spell.name))
                throw new Error(`Unrepresented spell in neural observation: ${metadata.spell.name}`);
            const geometry = [
                metadata.move?.destination,
                metadata.targetCell,
                metadata.standCell,
                metadata.aimCell,
            ].flatMap((cell) => (cell ? cellCoordinates(cell).map((value) => value / 15) : [0, 0]));
            const target = candidate.actions.find(
                (action) =>
                    action.type === "melee_attack" || action.type === "range_attack" || action.type === "cast_spell",
            );
            const range = v09RangeObservation(actor, context, candidate);
            const targetId = range.hasAim
                ? range.firstHitTargetId
                : target && "targetId" in target
                  ? target.targetId
                  : candidate.targetId;
            return {
                signature: v09CandidateSignature(candidate.actions),
                features: bounded([
                    ...v09CandidateFeatureVector(candidate, actor, context, candidates).slice(
                        VALUE_FEATURE_NAMES_V2.length,
                    ),
                    ...geometry,
                    ...V09_A19_SPELL_NAMES.map((name) => Number(metadata.spell?.name === name)),
                ]),
                targetIndex: indexOf.get(targetId ?? "") ?? -1,
            };
        }),
    };
}
