import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { friendlyShotBlockingBarrels } from "../../src/ai/artifact_barrel_tactics";
import { getSpellConfig } from "../../src/configuration/config_provider";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { selectBarrelForecastUsefulClear } from "../../src/simulation/barrel_forecast_useful_clear_research";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const teams = [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT] as const;
function fixture(map: GridType = 1, team: TeamType = teams[0], owner: TeamType = team) {
    const h = createCombatTestContext(map);
    const actor = createTestUnit({ team });
    const shooter = createTestUnit({ team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 4 });
    const enemy = createTestUnit({ team: team === teams[0] ? teams[1] : teams[0] });
    placeUnit(h.grid, h.unitsHolder, shooter, { x: 4, y: 11 });
    placeUnit(h.grid, h.unitsHolder, actor, { x: 5, y: 10 });
    placeUnit(h.grid, h.unitsHolder, enemy, { x: 7, y: 11 });
    const barrel = { x: 5, y: 11 };
    expect(h.grid.placeArtifactBarrel(owner, 0, barrel)).toBe(true);
    const fp = FightStateManager.getInstance().getFightProperties();
    const context = {
        ...h,
        fightProperties: fp,
        matrix: h.grid.getMatrix(),
        pathHelper: new PathHelper(h.grid.getSettings()),
        decisionOrigin: "rollout" as const,
    };
    const before: GameAction[] = [{ type: "wait_turn", unitId: actor.getId() }];
    const cleanup: GameAction[] = [
        {
            type: "obstacle_attack",
            attackerId: actor.getId(),
            targetPosition: getPositionForCell(
                barrel,
                h.grid.getSettings().getMinX(),
                h.grid.getSettings().getStep(),
                h.grid.getSettings().getHalfStep(),
            ),
        },
    ];
    return { ...h, actor, shooter, enemy, fp, context, before, cleanup };
}

for (const map of [1, 2, 3, 4] as const)
    for (const team of teams)
        for (const owner of teams)
            test(`retains a shot-opening native clear on map ${map}, actor ${team}, barrel ${owner}`, () => {
                const h = fixture(map, team, owner);
                expect(selectBarrelForecastUsefulClear(h.actor, h.context, h.before, h.cleanup)).toBe(h.cleanup);
            });

test("empty ammunition, a pinned shooter and hidden targets do not manufacture a useful clear", () => {
    const empty = fixture();
    empty.shooter.getUnitProperties().range_shots = 0;
    expect(empty.shooter.getRangeShots()).toBe(0);
    expect(selectBarrelForecastUsefulClear(empty.actor, empty.context, empty.before, empty.cleanup)).toBe(empty.before);
    const pinned = fixture();
    placeUnit(pinned.grid, pinned.unitsHolder, createTestUnit({ team: teams[1] }), { x: 3, y: 11 });
    expect(selectBarrelForecastUsefulClear(pinned.actor, pinned.context, pinned.before, pinned.cleanup)).toBe(
        pinned.before,
    );
    const hidden = fixture();
    hidden.enemy.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Hidden"), amount: 1 }));
    expect(selectBarrelForecastUsefulClear(hidden.actor, hidden.context, hidden.before, hidden.cleanup)).toBe(
        hidden.before,
    );
});

test("keeps ranged actors, live roots, explicit combat and unclassifiable forecasts native", () => {
    const h = fixture();
    expect(selectBarrelForecastUsefulClear(h.shooter, h.context, h.before, h.cleanup)).toBe(h.cleanup);
    expect(
        selectBarrelForecastUsefulClear(h.actor, { ...h.context, decisionOrigin: "root" }, h.before, h.cleanup),
    ).toBe(h.cleanup);
    expect(selectBarrelForecastUsefulClear(h.actor, h.context, [{ type: "cast_spell" } as GameAction], h.cleanup)).toBe(
        h.cleanup,
    );
    expect(
        selectBarrelForecastUsefulClear(h.actor, { ...h.context, attackHandler: undefined }, h.before, h.cleanup),
    ).toBe(h.cleanup);
});

test("shot classification preserves authoritative state, cached matrix, decisions and RNG", () => {
    const h = fixture();
    const state = snapshotBattle(h.unitsHolder, h.grid, h.fp),
        matrix = h.grid.getMatrix();
    const actions = structuredClone({ before: h.before, cleanup: h.cleanup });
    let draws = 0;
    setDeterministicRandomSource(() => {
        draws++;
        return 0.5;
    });
    try {
        expect(selectBarrelForecastUsefulClear(h.actor, h.context, h.before, h.cleanup)).toBe(h.cleanup);
        expect(draws).toBe(0);
    } finally {
        setDeterministicRandomSource(undefined);
    }
    expect(snapshotBattle(h.unitsHolder, h.grid, h.fp)).toEqual(state);
    expect(h.grid.getMatrix()).toEqual(matrix);
    expect({ before: h.before, cleanup: h.cleanup }).toEqual(actions);
});

test("the follow-up remains absent from serving source and original frozen intent helper", () => {
    for (const path of [
        "../../src/ai/versions/v0_8.ts",
        "../../src/simulation/search_driver.ts",
        "../../src/ai/versions/v0_8_a19_profile.ts",
        "../../src/simulation/barrel_forecast_intent_research.ts",
    ])
        expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain(
            "barrel_forecast_useful_clear_research",
        );
});

test("a screen blocking only an enemy shot retains legal native movement or hold", () => {
    const h = fixture();
    h.shooter.getUnitProperties().range_shots = 0;
    h.enemy.getUnitProperties().attack_type = PBTypes.AttackVals.RANGE;
    h.enemy.getUnitProperties().attack_type_selected = PBTypes.AttackVals.RANGE;
    h.enemy.getUnitProperties().range_shots = 4;
    expect(friendlyShotBlockingBarrels(h.enemy.getTeam(), h.grid, h.unitsHolder, h.attackHandler).has("5,11")).toBe(
        true,
    );
    const alternatives: GameAction[][] = [
        h.before,
        [{ type: "defend_turn", unitId: h.actor.getId() }],
        [
            {
                type: "move_unit",
                unitId: h.actor.getId(),
                path: [
                    { x: 5, y: 10 },
                    { x: 6, y: 10 },
                ],
                targetCells: [{ x: 6, y: 10 }],
                hasLavaCell: false,
                hasWaterCell: false,
            },
        ],
    ];
    for (const before of alternatives)
        expect(selectBarrelForecastUsefulClear(h.actor, h.context, before, h.cleanup)).toBe(before);
});
