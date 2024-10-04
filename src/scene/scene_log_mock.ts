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

import { SceneLog } from "./scene_log";

export class SceneLogMock extends SceneLog {
    public getLog(): string {
        return "";
    }

    public updateLog(_newLog?: string): void {}

    public hasBeenUpdated(): boolean {
        return false;
    }
}
