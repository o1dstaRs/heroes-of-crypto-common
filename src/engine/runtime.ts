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

import { v4 as uuidv4 } from "uuid";

import { getRandomInt, getTimeMillis } from "../utils/lib";

export interface IGameRandom {
    int(min: number, max: number): number;
}

export interface IGameClock {
    nowMillis(): number;
}

export interface IGameIdFactory {
    nextId(): string;
}

export interface IGameRuntime {
    rng: IGameRandom;
    clock: IGameClock;
    ids: IGameIdFactory;
}

export const createDefaultGameRuntime = (): IGameRuntime => ({
    rng: {
        int: (min, max) => getRandomInt(min, max),
    },
    clock: {
        nowMillis: () => getTimeMillis(),
    },
    ids: {
        nextId: () => uuidv4(),
    },
});

export const createSequenceGameRuntime = (opts: {
    ints?: number[];
    nowMillis?: number[];
    ids?: string[];
    defaultNowMillis?: number;
}): IGameRuntime => {
    let intIndex = 0;
    let nowIndex = 0;
    let idIndex = 0;

    return {
        rng: {
            int: (min, max) => {
                if (intIndex >= (opts.ints?.length ?? 0)) {
                    throw new Error(`No deterministic random integer queued for [${min}, ${max})`);
                }
                const value = opts.ints![intIndex++];
                if (!Number.isInteger(value) || value < min || value >= max) {
                    throw new Error(`Queued random integer ${value} is outside [${min}, ${max})`);
                }
                return value;
            },
        },
        clock: {
            nowMillis: () => {
                if (nowIndex < (opts.nowMillis?.length ?? 0)) {
                    return opts.nowMillis![nowIndex++];
                }
                return opts.defaultNowMillis ?? 0;
            },
        },
        ids: {
            nextId: () => {
                if (idIndex >= (opts.ids?.length ?? 0)) {
                    throw new Error("No deterministic id queued");
                }
                return opts.ids![idIndex++];
            },
        },
    };
};

export const shuffleWithRng = <T>(items: T[], rng: IGameRandom): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
        const j = rng.int(0, i + 1);
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
};
