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

/**
 * Per-unit AI pin for MINDLESS creatures. The AI version is otherwise chosen per TEAM (battle_engine's
 * green/redVersion, the client's DEFAULT_AI_VERSION), so every unit in an army thinks with the same brain.
 *
 * A creature carrying the "AI Driven" ability is never steered by its owner — the engine plays it whoever
 * owns the army — and that is exactly the set that should think mindlessly: Berserker and Frenzied Boar
 * today, plus anything given the ability later. Keying on the ABILITY rather than a name list means a new
 * mindless creature needs nothing here, and it holds in every mode — full AI rosters, player-vs-AI, and a
 * human army whose Berserker plays itself.
 *
 * This is a BALANCE + FLAVOUR lever. A berserk creature that kites, screens and finishes like the a13
 * composite reads wrong, and both carriers sit at the top of the measured tier list (Frenzied Boar 79.0%,
 * Berserker 60.0% against a level-balanced field over 30,006 v0.8+a13 fights). v0.1 is the original
 * baseline strategy: charge the nearest target, no search, no lookahead, no learned targeting.
 *
 * Resolve the version BEFORE the search/lookahead gates (both key off the acting strategy's version), so a
 * pinned unit loses the a13 search entirely rather than running an old policy inside it.
 *
 * `hasAbilityActive` is deliberate: a MUTED "AI Driven" (Broken by an enemy) hands the creature back to
 * its owner, and a unit its owner can steer should not be pinned to the mindless brain.
 */
export const MINDLESS_AI_ABILITY = "AI Driven";
export const MINDLESS_AI_VERSION = "v0.1";

/** Minimal shape so this stays free of unit/engine imports (and testable without building a Unit). */
export interface IAiOverrideUnit {
    hasAbilityActive(abilityName: string): boolean;
}

/** True when this unit plays itself and must do so predictably. */
export function isMindlessAiUnit(unit: IAiOverrideUnit): boolean {
    return unit.hasAbilityActive(MINDLESS_AI_ABILITY);
}

/**
 * The AI version that should decide THIS unit's turn: the mindless pin when it plays itself, else the
 * version the caller would have used anyway (its team's). Placement is unaffected — armies are placed as
 * a whole, so this applies to turn decisions only.
 */
export function aiVersionForUnit(unit: IAiOverrideUnit, teamVersion: string): string {
    return isMindlessAiUnit(unit) ? MINDLESS_AI_VERSION : teamVersion;
}
