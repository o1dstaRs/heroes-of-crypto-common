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

import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../artifacts/artifact_properties";

/**
 * One buff/debuff/effect application (or a resisted debuff) observed while an action was applied.
 * Captured at the Unit.applyBuff/applyDebuff/applyEffect funnels so EVERY source — targeted casts,
 * mass casts, on-hit ability riders (Stun, Break, Poison, …) — is seen without threading a recorder
 * through each of them. The action engine drains the capture into an `effects_applied` game event,
 * which is what lets the ranked scene log (rebuilt from events, never from engine text) finally show
 * buffs and debuffs with every affected target.
 */
export interface IEffectApplicationRecord {
    unitId: string;
    name: string;
    kind: "buff" | "debuff" | "effect";
    laps?: number;
    /** A debuff that ROLLED but was resisted — recorded so the log can say the target shrugged it off. */
    resisted?: boolean;
}

// System/marker state the seeding and refresh machinery re-applies over and over — never player-visible
// "something landed on you" news. Mirrors ability_helper's ENGINE_MARKER_SPELL_NAMES (kept local: this
// module must stay a leaf importable from unit.ts, and ability_helper imports Unit).
const MARKER_SPELL_NAMES: ReadonlySet<string> = new Set([
    "Morale",
    "Dismorale",
    "Hidden",
    "Visible",
    "Angelic Host",
    "Water Shield",
]);

const ARTIFACT_BUFF_NAMES: ReadonlySet<string> = new Set(
    [...TIER1_ARTIFACT_LIST, ...TIER2_ARTIFACT_LIST].map((artifact) => artifact.buffName).filter((name) => !!name),
);

/**
 * Applications that are bookkeeping noise rather than news: engine markers, artifact carry-buffs and
 * augments (re-applied on every stack-power refresh), and aura carrier entries (re-stamped every aura
 * refresh while a unit stands inside).
 */
export const isEffectApplicationNoise = (name: string): boolean =>
    MARKER_SPELL_NAMES.has(name) ||
    ARTIFACT_BUFF_NAMES.has(name) ||
    name.endsWith(" Aura") ||
    name.endsWith(" Augment");

let captureActive = false;
let records: IEffectApplicationRecord[] = [];

/** Start capturing applications. Callers MUST pair with endEffectApplicationCapture. */
export const beginEffectApplicationCapture = (): void => {
    captureActive = true;
    records = [];
};

/** Stop capturing and return everything recorded since begin (empty array when nothing landed). */
export const endEffectApplicationCapture = (): IEffectApplicationRecord[] => {
    captureActive = false;
    const out = records;
    records = [];
    return out;
};

/** Record one application; a no-op outside a capture window or for noise names. */
export const recordEffectApplication = (record: IEffectApplicationRecord): void => {
    if (!captureActive || isEffectApplicationNoise(record.name)) {
        return;
    }
    records.push(record);
};
