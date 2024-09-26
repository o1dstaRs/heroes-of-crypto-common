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

import { NUMBER_OF_LAPS_TOTAL } from "../constants";

export class AppliedSpell {
    private readonly name: string;

    private readonly power: number;

    private lapsRemaining: number;

    private readonly firstSpellProperty?: number = undefined;

    private readonly secondSpellProperty?: number = undefined;

    public constructor(
        name: string,
        power: number,
        lapsRemaining: number,
        firstSpellProperty?: number,
        secondSpellProperty?: number,
    ) {
        this.name = name;
        this.power = power;
        this.lapsRemaining = lapsRemaining;
        this.firstSpellProperty = firstSpellProperty;
        this.secondSpellProperty = secondSpellProperty;
    }
    public getFirstSpellProperty(): number | undefined {
        return this.firstSpellProperty;
    }

    public getSecondSpellProperty(): number | undefined {
        return this.secondSpellProperty;
    }

    public getName(): string {
        return this.name;
    }

    public getPower(): number {
        return this.power;
    }

    public minusLap(): void {
        if (this.lapsRemaining === Number.MAX_SAFE_INTEGER || this.lapsRemaining === NUMBER_OF_LAPS_TOTAL) {
            return;
        }

        if (this.lapsRemaining > 0) {
            this.lapsRemaining -= 1;
        }
        if (this.lapsRemaining < 0) {
            this.lapsRemaining = 0;
        }
    }

    public getLaps(): number {
        return this.lapsRemaining;
    }
}
