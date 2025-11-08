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

import { FightProperties } from "./fight_properties";

export class FightStateManager {
    private static instance: FightStateManager;
    private fightProperties: FightProperties;
    private constructor() {
        this.fightProperties = new FightProperties();
    }
    public reset(): void {
        this.fightProperties = new FightProperties();
    }
    public static getInstance(): FightStateManager {
        if (!FightStateManager.instance) {
            FightStateManager.instance = new FightStateManager();
        }

        return FightStateManager.instance;
    }
    public getFightProperties(): FightProperties {
        return this.fightProperties;
    }
}
