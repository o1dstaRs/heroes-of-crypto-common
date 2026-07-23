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

import type { XY } from "../utils/math";

export interface IMovePath {
    cells: XY[];
    hashes: Set<number>;
    knownPaths: Map<number, IWeightedRoute[]>;
}

export interface IWeightedRoute {
    cell: XY;
    route: XY[];
    weight: number;
    firstAggrMet: boolean;
    hasLavaCell: boolean;
    hasWaterCell: boolean;
}

/** Deep-readonly view used when a path result is shared inside one synchronous decision. */
export interface IReadonlyWeightedRoute extends Readonly<Omit<IWeightedRoute, "cell" | "route">> {
    readonly cell: Readonly<XY>;
    readonly route: readonly Readonly<XY>[];
}

export type IReadonlyKnownPaths = ReadonlyMap<number, readonly IReadonlyWeightedRoute[]>;

export interface IReadonlyMovePath {
    readonly cells: readonly Readonly<XY>[];
    readonly hashes: ReadonlySet<number>;
    readonly knownPaths: IReadonlyKnownPaths;
}
