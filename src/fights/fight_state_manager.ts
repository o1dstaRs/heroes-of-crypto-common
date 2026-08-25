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
    /**
     * Process-wide board-orientation default, applied to every FightProperties this manager creates
     * (constructor AND reset). The CLIENT sets this true once at boot — every fight it hosts
     * (sandbox, vs-AI, previews) plays the side-oriented board (owner call 2026-08-25: everything
     * fights left-to-right now). The server and the sim never touch it: they stamp orientation
     * explicitly per fight, and a fresh default FightProperties stays classic for tests.
     */
    private static defaultSideOrientedPlacement = false;
    public static setDefaultSideOrientedPlacement(sideOriented: boolean): void {
        FightStateManager.defaultSideOrientedPlacement = sideOriented;
    }
    private static applyDefaults(fightProperties: FightProperties): FightProperties {
        if (FightStateManager.defaultSideOrientedPlacement) {
            fightProperties.setSideOrientedPlacement(true);
        }
        return fightProperties;
    }
    private constructor() {
        this.fightProperties = FightStateManager.applyDefaults(new FightProperties());
    }
    public reset(): void {
        this.fightProperties = FightStateManager.applyDefaults(new FightProperties());
    }
    // Point the process-global FightProperties at a specific instance. The server runs MANY concurrent
    // PlaySessions, each with its OWN FightProperties — but the combat/ability handlers read synergy data
    // (e.g. getBreakChancePerTeam) from this singleton. Without this, that data is never populated on the
    // server, so break-on-attack (and other singleton-read synergy effects) silently do nothing in
    // server play. The server calls this at the start of each synchronous action/tick to bind the
    // singleton to the session it's currently processing (safe: Bun is single-threaded and action
    // handling never awaits mid-combat, so no cross-session interleaving occurs). Client/local sandbox
    // (a single game) is unaffected — the singleton already is that game's FightProperties.
    public setFightProperties(fightProperties: FightProperties): void {
        this.fightProperties = fightProperties;
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
