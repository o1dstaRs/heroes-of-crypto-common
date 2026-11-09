import { afterEach, expect, test } from "bun:test";
import type { IDecisionContext } from "../../src/ai";
import { battleMageTargetsEnabled, V08_BATTLE_MAGE_TARGETS_ENV } from "../../src/ai/battle_mage_targets";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { withBattleMageLegacyRollouts } from "../../src/simulation/battle_mage_target_research";
import type { Unit } from "../../src/units/unit";

const native = StrategyV0_8.prototype.decideTurn;
const saved = process.env[V08_BATTLE_MAGE_TARGETS_ENV];
afterEach(() => {
    StrategyV0_8.prototype.decideTurn = native;
    if (saved === undefined) delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
    else process.env[V08_BATTLE_MAGE_TARGETS_ENV] = saved;
});
const actor = (team: TeamType, name = "Battle Mage") => ({ getName: () => name, getTeam: () => team }) as Unit;
const context = (decisionOrigin: "root" | "rollout") => ({ decisionOrigin }) as IDecisionContext;

test("only the specified team's simulated Battle Mage changes; root coverage and default import stay intact", () => {
    delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
    const observed: (string | undefined)[] = [];
    const stub: typeof native = () => {
        observed.push(process.env[V08_BATTLE_MAGE_TARGETS_ENV]);
        return [];
    };
    StrategyV0_8.prototype.decideTurn = stub;
    const ai = new StrategyV0_8();
    let overrides = 0;
    expect(StrategyV0_8.prototype.decideTurn).toBe(stub);
    withBattleMageLegacyRollouts(
        PBTypes.TeamVals.LEFT,
        () => {
            ai.decideTurn(actor(PBTypes.TeamVals.LEFT), context("root"));
            ai.decideTurn(actor(PBTypes.TeamVals.LEFT), context("rollout"));
            ai.decideTurn(actor(PBTypes.TeamVals.RIGHT), context("rollout"));
            ai.decideTurn(actor(PBTypes.TeamVals.LEFT, "Satyr"), context("rollout"));
            // Search enumeration takes place after the native callback has restored the flag.
            expect(battleMageTargetsEnabled(actor(PBTypes.TeamVals.LEFT))).toBe(true);
        },
        () => {
            overrides += 1;
        },
    );
    expect(observed).toEqual([undefined, "off", undefined, undefined]);
    expect(overrides).toBe(1);
    expect(StrategyV0_8.prototype.decideTurn).toBe(stub);
});

test("restores an existing seat gate and prototype when the native callback throws", () => {
    process.env[V08_BATTLE_MAGE_TARGETS_ENV] = "red";
    const fail = () => {
        throw new Error("probe failure");
    };
    StrategyV0_8.prototype.decideTurn = fail;
    expect(() =>
        withBattleMageLegacyRollouts(PBTypes.TeamVals.RIGHT, () =>
            new StrategyV0_8().decideTurn(actor(PBTypes.TeamVals.RIGHT), context("rollout")),
        ),
    ).toThrow("probe failure");
    expect(process.env[V08_BATTLE_MAGE_TARGETS_ENV]).toBe("red");
    expect(StrategyV0_8.prototype.decideTurn).toBe(fail);
    expect(withBattleMageLegacyRollouts(PBTypes.TeamVals.RIGHT, () => 7)).toBe(7);
});

test("rejects async, nested and invalid-team scopes without leaving a prototype patch", () => {
    expect(() => withBattleMageLegacyRollouts(PBTypes.TeamVals.LEFT, () => Promise.resolve(1))).toThrow("synchronous");
    expect(StrategyV0_8.prototype.decideTurn).toBe(native);
    expect(() =>
        withBattleMageLegacyRollouts(PBTypes.TeamVals.LEFT, () =>
            withBattleMageLegacyRollouts(PBTypes.TeamVals.RIGHT, () => 1),
        ),
    ).toThrow("nested");
    expect(() => withBattleMageLegacyRollouts(0 as TeamType, () => 1)).toThrow("physical team");
    expect(StrategyV0_8.prototype.decideTurn).toBe(native);
});

test("preserves other strategy versions even when they inherit the native method", () => {
    delete process.env[V08_BATTLE_MAGE_TARGETS_ENV];
    const seen: (string | undefined)[] = [];
    StrategyV0_8.prototype.decideTurn = () => {
        seen.push(process.env[V08_BATTLE_MAGE_TARGETS_ENV]);
        return [];
    };
    withBattleMageLegacyRollouts(PBTypes.TeamVals.LEFT, () =>
        StrategyV0_8.prototype.decideTurn.call(new StrategyV0_8S(), actor(PBTypes.TeamVals.LEFT), context("rollout")),
    );
    expect(seen).toEqual([undefined]);
});
