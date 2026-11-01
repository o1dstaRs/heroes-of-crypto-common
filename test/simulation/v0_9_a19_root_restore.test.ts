import { expect, test } from "bun:test";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GameAction } from "../../src/engine/actions";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withV09RootRestoreAudit } from "../../src/simulation/v0_9/a19_root_restore";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

function exercise(mutate: (fixture: ReturnType<typeof fixture>) => void, failOutsideDecision = false) {
    const f = fixture();
    const prototype = SearchDriver.prototype;
    const original = prototype.chooseDecision;
    const chosen: GameAction[] = [];
    const replacement: typeof original = () => {
        mutate(f);
        return chosen;
    };
    prototype.chooseDecision = replacement;
    const driver = Object.assign(Object.create(prototype), {
        deps: { unitsHolder: f.unitsHolder, grid: f.grid, fightProperties: f.fight, captureDamageStats: () => ({}) },
    }) as SearchDriver;
    try {
        if (failOutsideDecision) {
            expect(() =>
                withV09RootRestoreAudit(() => {
                    throw new Error("test interruption");
                }),
            ).toThrow("test interruption");
        } else {
            const audited = withV09RootRestoreAudit(() => driver.chooseDecision(f.left, "v0.8", chosen));
            expect(audited.value).toBe(chosen);
            expect(audited.checks).toBe(1);
        }
    } finally {
        expect(prototype.chooseDecision).toBe(replacement);
        prototype.chooseDecision = original;
    }
}

function fixture() {
    const context = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const left = createTestUnit({ team: PBTypes.TeamVals.LEFT });
    const peer = createTestUnit({ team: PBTypes.TeamVals.LEFT });
    const right = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
    for (const [i, unit] of [left, peer, right].entries())
        placeUnit(context.grid, context.unitsHolder, unit, { x: i + 2, y: 3 });
    fight.setSynergiesPerTeam(left.getTeam(), ["Life:1:1"]);
    const shared = fight.getSynergiesPerTeam(left.getTeam());
    left.setSynergies(shared);
    peer.setSynergies(shared);
    return { ...context, fight, left, peer };
}

test("producer root audit preserves an unchanged decision and its original action reference", () => exercise(() => {}));

test("producer root audit rejects equal-valued detached synergy owners", () => {
    expect(() => exercise((f) => f.left.setSynergies([...f.left.getUnitProperties().synergies]))).toThrow(
        "root restoration failed",
    );
});

test("producer root audit rejects replacement live unit instances", () => {
    expect(() =>
        exercise((f) => {
            const replacement = Object.assign(Object.create(Object.getPrototypeOf(f.left)), f.left);
            f.unitsHolder.getAllUnits().set(f.left.getId(), replacement);
        }),
    ).toThrow("root restoration failed");
});

test("producer root audit restores its hook after an interrupted job", () => exercise(() => {}, true));
