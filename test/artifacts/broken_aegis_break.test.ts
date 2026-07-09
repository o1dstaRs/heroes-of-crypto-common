/*
 * -----------------------------------------------------------------------------
 * Broken Aegis break-on-attack: verifies the offensive break lands as a "Break"
 * effect on the struck unit (the effect a ranged/melee hit passes into
 * targetUnit.applyDamage), and that it does NOT re-apply / re-log when the unit
 * is already Broken (a Double Shot's two hits, or a hit + counter).
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { BROKEN_AEGIS_BREAK_CHANCE, BROKEN_AEGIS_MISS_CHANCE } from "../../src/artifacts/artifact_properties";
import { createTestUnit } from "../helpers/combat";
import type { ISceneLog } from "../../src/scene/scene_log_interface";

/** Recording log so we can count how many "got Break" lines were emitted. */
class RecordingSceneLog implements ISceneLog {
    public readonly lines: string[] = [];
    public getLog(): string {
        return this.lines.join("\n");
    }
    public updateLog(newLog?: string): void {
        if (newLog) {
            this.lines.push(newLog);
        }
    }
    public hasBeenUpdated(): boolean {
        return this.lines.length > 0;
    }
}

const makeTarget = (name: string) =>
    createTestUnit({
        name,
        team: PBTypes.TeamVals.UPPER,
        attackType: PBTypes.AttackVals.MELEE,
        maxHp: 1000,
        amountAlive: 1,
    });

describe("Broken Aegis break-on-attack", () => {
    it("tuned to 20% break / 4% self-miss (~48% overall win rate)", () => {
        expect(BROKEN_AEGIS_BREAK_CHANCE).toBe(20);
        expect(BROKEN_AEGIS_MISS_CHANCE).toBe(4);
    });

    it("applyDamage with a positive break chance lands a Break effect (recorded for the HUD)", () => {
        const target = makeTarget("Target");
        const log = new RecordingSceneLog();

        // chanceToBreak = 100 -> deterministic land (getRandomInt(0,100) < 100 always true).
        target.applyDamage(10, 100, log);

        expect(target.getEffects().map((e) => e.getName())).toContain("Break");
        // applied_effects is what the server serializes into the ranked HUD's `debuffs` and what the
        // sandbox reconcileEffectVisuals reads via getEffects() to pop the icon.
        expect(target.getAllProperties().applied_effects).toContain("Break");
        expect(log.lines.filter((l) => l.includes("got Break")).length).toBe(1);
    });

    it("does NOT re-apply or re-log Break when the unit is already Broken (no stacking)", () => {
        const target = makeTarget("Target");
        const log = new RecordingSceneLog();

        // Two hits that both roll a guaranteed break (e.g. a Double Shot's two shots).
        target.applyDamage(10, 100, log);
        target.applyDamage(10, 100, log);

        // Still exactly ONE Break effect and ONE "got Break" log line — the second hit is a no-op.
        expect(target.getEffects().filter((e) => e.getName() === "Break").length).toBe(1);
        expect(log.lines.filter((l) => l.includes("got Break")).length).toBe(1);
    });

    it("does NOT break when the chance is zero (no artifact / no synergy)", () => {
        const target = makeTarget("Target2");
        target.applyDamage(10, 0, new RecordingSceneLog());
        expect(target.getEffects().map((e) => e.getName())).not.toContain("Break");
    });
});
