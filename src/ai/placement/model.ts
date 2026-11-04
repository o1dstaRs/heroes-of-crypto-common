import packed from "../models/a19/placement_v1.json";
import type { PlacementModel } from "./layout";
const EXPECTED_EXPORT = "3aa76b4c37ee49c99cab212a5a5f8f90020580f493300b61fb9e4af1bc554590";
let cached: PlacementModel | undefined;
export function getPlacementModel(): PlacementModel {
    if (cached) return cached;
    if (packed.schema !== "hoc-placement-packed-float32-v1" || packed.exportSha256 !== EXPECTED_EXPORT)
        throw new Error("Placement model identity mismatch");
    const shapes = [
        [128, 1899],
        [64, 128],
        [1, 64],
    ];
    const decode = (data: string, size: number): number[] => {
        const raw = atob(data);
        if (raw.length !== size * 4) throw new Error("Placement tensor size mismatch");
        const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const result = Array.from({ length: size }, (_, i) => view.getFloat32(i * 4, true));
        if (!result.every(Number.isFinite)) throw new Error("Nonfinite placement tensor");
        return result;
    };
    if (packed.layers.length !== shapes.length) throw new Error("Placement layer count mismatch");
    const layers = packed.layers.map((l, index) => {
        const [rows, columns] = shapes[index];
        if (l.shape.length !== 2 || l.shape[0] !== rows || l.shape[1] !== columns)
            throw new Error("Placement layer shape mismatch");
        const weights = decode(l.weight, rows * columns);
        return {
            weight: Array.from({ length: rows }, (_, row) => weights.slice(row * columns, (row + 1) * columns)),
            bias: decode(l.bias, rows),
        };
    });
    if (packed.id !== "free-placement-fit-0" || packed.minimumGain !== 0.03)
        throw new Error("Placement selection policy mismatch");
    cached = { id: packed.id, minimumGain: packed.minimumGain, layers };
    return cached;
}
