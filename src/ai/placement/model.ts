import packed from "../models/a19/placement_v1.json";
import relations from "../models/a19/placement_v2.json";
import type { PlacementModel } from "./layout";
const EXPECTED_EXPORT = "3aa76b4c37ee49c99cab212a5a5f8f90020580f493300b61fb9e4af1bc554590";
const EXPECTED_RELATIONS_EXPORT = "4bb2199fb9af3212a17dfaef6d73de14fb174f1c4ff8699eda96c3a4a2a3554a";
let cached: PlacementModel | undefined;
let cachedRelations: PlacementModel | undefined;
function decodeModel(
    artifact: typeof packed,
    expectedExport: string,
    expectedId: string,
    shapes: readonly (readonly [number, number])[],
): PlacementModel {
    if (artifact.schema !== "hoc-placement-packed-float32-v1" || artifact.exportSha256 !== expectedExport)
        throw new Error("Placement model identity mismatch");
    const decode = (data: string, size: number): number[] => {
        const raw = atob(data);
        if (raw.length !== size * 4) throw new Error("Placement tensor size mismatch");
        const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const result = Array.from({ length: size }, (_, i) => view.getFloat32(i * 4, true));
        if (!result.every(Number.isFinite)) throw new Error("Nonfinite placement tensor");
        return result;
    };
    if (artifact.layers.length !== shapes.length) throw new Error("Placement layer count mismatch");
    const layers = artifact.layers.map((l, index) => {
        const [rows, columns] = shapes[index];
        if (l.shape.length !== 2 || l.shape[0] !== rows || l.shape[1] !== columns)
            throw new Error("Placement layer shape mismatch");
        const weights = decode(l.weight, rows * columns);
        return {
            weight: Array.from({ length: rows }, (_, row) => weights.slice(row * columns, (row + 1) * columns)),
            bias: decode(l.bias, rows),
        };
    });
    if (artifact.id !== expectedId || artifact.minimumGain !== 0.03)
        throw new Error("Placement selection policy mismatch");
    return { id: artifact.id, minimumGain: artifact.minimumGain, layers };
}
export function getPlacementModel(): PlacementModel {
    return (cached ??= decodeModel(packed, EXPECTED_EXPORT, "free-placement-fit-0", [
        [128, 1899],
        [64, 128],
        [1, 64],
    ]));
}
export function getPlacementRelationModel(): PlacementModel {
    if (
        relations.featureSchema !== "placement-role-relations-v2" ||
        relations.referenceExportSha256 !== EXPECTED_EXPORT
    )
        throw new Error("Placement reference policy mismatch");
    return (cachedRelations ??= decodeModel(relations, EXPECTED_RELATIONS_EXPORT, "relations-v2-absolute-256", [
        [256, 2138],
        [64, 256],
        [1, 64],
    ]));
}
