import { afterEach, describe, expect, test } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { getAIStrategy } from "../../src/ai";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { reserveGravechainShortlistCandidate } from "../../src/ai/gravechain_shortlist";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { GameActionEngine } from "../../src/engine/action_engine";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

afterEach(() => setDeterministicRandomSource(undefined));

function fixture(
    options: {
        team?: typeof LEFT;
        attacker?: TestUnitOptions;
        root?: TestUnitOptions;
        cluster?: TestUnitOptions;
        actorCell?: XY;
    } = {},
) {
    const combat = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const team = options.team ?? LEFT;
    const enemyTeam = team === LEFT ? RIGHT : LEFT;
    const actor = createTestUnit({
        name: "Gravechain archer",
        team,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 20,
        damageMin: 10,
        damageMax: 10,
        maxHp: 10000,
        ...options.attacker,
    });
    placeUnit(combat.grid, combat.unitsHolder, actor, options.actorCell ?? { x: 3, y: 7 });
    const add = (name: string, cell: XY, properties: TestUnitOptions = {}) => {
        const unit = createTestUnit({ name, team: enemyTeam, maxHp: 10000, ...properties });
        placeUnit(combat.grid, combat.unitsHolder, unit, cell);
        return unit;
    };
    const isolated = add("Isolated easy damage", { x: 8, y: 3 }, { armor: 0 });
    const root = add("Cluster root", { x: 8, y: 8 }, { ...options.cluster, ...options.root });
    const bridge = add("Diagonal bridge", { x: 9, y: 9 }, options.cluster);
    const end = add("Second link", { x: 10, y: 10 }, options.cluster);
    const third = add("Third link", { x: 11, y: 11 }, options.cluster);
    const outside = add("Beyond three links", { x: 12, y: 12 }, options.cluster);
    fightProperties.setArtifactPerTeam(team, 2, Tier2Artifact.GRAVECHAIN);
    combat.unitsHolder.applyArtifacts(fightProperties);
    combat.unitsHolder.refreshStackPowerForAllUnits();
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(team, 1);
    fightProperties.setTeamUnitsAlive(enemyTeam, 6);
    fightProperties.startTurn(team, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    let activeUnitId = actor.getId();
    const engineContext = {
        ...combat,
        fightProperties,
        moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => activeUnitId || undefined,
        canLandRangeAttack: (unit: Unit) =>
            combat.attackHandler.canLandRangeAttack(unit, combat.grid.getEnemyAggrMatrixByUnitId(unit.getId())),
    };
    const engine = new GameActionEngine(engineContext);
    const catalog = () => {
        const all = enumerateCandidates(actor, context, [{ type: "defend_turn", unitId: actor.getId() }], {
            enrichIncumbentMetadata: true,
        }).candidates;
        const shot = (target: Unit) => {
            const candidate = all.find(
                (candidate) => candidate.kind === "shot" && candidate.targetId === target.getId(),
            );
            expect(candidate).toBeDefined();
            return candidate!;
        };
        const easy = shot(isolated);
        const chain = shot(root);
        // Mirror the pre-pass that retains immediate damage while discarding the lower-damage chain.
        const candidates = [{ ...easy, kind: "incumbent" as const }, easy, chain];
        return { candidates, easy, chain };
    };
    const reserve = (candidates: readonly IEnumeratedCandidate[], retained: readonly IEnumeratedCandidate[]) =>
        reserveGravechainShortlistCandidate(actor, context, candidates, retained);
    const fire = (candidate: IEnumeratedCandidate) => {
        setDeterministicRandomSource(() => 0);
        for (const action of candidate.actions) expect(engine.apply(action).completed).toBe(true);
    };
    const deps: ILookaheadDeps = {
        ...context,
        fightProperties,
        engine,
        turnEngine: new TurnEngine(engineContext),
        strategyForTeam: () => getAIStrategy("v0.8"),
        getActiveUnitId: () => activeUnitId,
        setActiveUnitId: (id) => {
            activeUnitId = id;
        },
        damageDealtThisLap: () => combat.damageStatisticHolder.has(fightProperties.getCurrentLap()),
        captureDamageStats: () => [...combat.damageStatisticHolder.get()],
        restoreDamageStats: (saved) => {
            combat.damageStatisticHolder.clear();
            for (const item of saved) combat.damageStatisticHolder.add(item);
        },
    };
    return {
        ...combat,
        context,
        fightProperties,
        actor,
        root,
        isolated,
        bridge,
        end,
        third,
        outside,
        add,
        catalog,
        reserve,
        fire,
        deps,
    };
}

describe("Gravechain horizon coverage", () => {
    test("keeps lower-damage connected control and executes the real three-link diagonal chain", () => {
        const h = fixture();
        const { candidates, easy, chain } = h.catalog();
        expect(easy.features.expectedDamage).toBeGreaterThan(chain.features.expectedDamage);
        expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
        h.fire(chain);
        for (const unit of [h.root, h.bridge, h.end, h.third]) expect(unit.hasDebuffActive("Gravebound")).toBe(true);
        expect(h.outside.hasDebuffActive("Gravebound")).toBe(false);
        expect(h.isolated.hasDebuffActive("Gravebound")).toBe(false);
    });

    test("the retained chain denies a real enemy move-and-strike that the damage-only shot allows", () => {
        const canStrikeAlly = (useChain: boolean) => {
            const h = fixture();
            const ally = h.add("Exposed ally", { x: 4, y: 9 }, { team: h.actor.getTeam(), maxHp: 1000 });
            h.fightProperties.setTeamUnitsAlive(h.actor.getTeam(), 2);
            const { easy, chain } = h.catalog();
            h.fire(useChain ? chain : easy);
            h.fightProperties.startTurn(h.root.getTeam(), 2000);
            const replies = enumerateCandidates(h.root, h.context, [
                { type: "defend_turn", unitId: h.root.getId() },
            ]).candidates;
            return replies.some((candidate) =>
                candidate.actions.some((action) => action.type === "melee_attack" && action.targetId === ally.getId()),
            );
        };
        expect(canStrikeAlly(false)).toBe(true);
        expect(canStrikeAlly(true)).toBe(false);
    });

    test("real rollout search selects the retained chain when its slow prevents the opponent's damaging reply", () => {
        const environment = {
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_SHORTLIST: "2",
            SEARCH_A19_GRAVECHAIN_COVERAGE: "1",
            SEARCH_ROLLOUTS: "16",
            SEARCH_HORIZON: "1",
            SEARCH_GATE: "0",
            V07_VALUE_WEIGHTS: "material",
            V07_VALUE_WEIGHTS_V2: undefined,
        };
        withSearchEnvironment(environment, () => {
            const h = fixture({ root: { damageMin: 100, damageMax: 100 } });
            h.add("Exposed ally", { x: 4, y: 9 }, { team: h.actor.getTeam(), maxHp: 1000 });
            const alternate = h.add("Isolated alternate shot", { x: 8, y: 5 }, { armor: 1 });
            h.fightProperties.setTeamUnitsAlive(h.actor.getTeam(), 2);
            h.fightProperties.setTeamUnitsAlive(h.root.getTeam(), 7);
            h.fightProperties.enqueueUpNext(h.root.getId());
            const { easy } = h.catalog();
            const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties));
            const driver = new SearchDriver(h.deps);
            // Keep the private rollout bank independent of the fixture's UUIDs.
            (driver as unknown as { simSeed: () => number }).simSeed = () => 4433;
            const chosen = driver.chooseDecision(h.actor, "v0.8", easy.actions);
            const strike = chosen.find((action) => action.type === "range_attack");
            expect(strike?.type).toBe("range_attack");
            expect([h.root, h.bridge, h.end, h.third].map((unit) => unit.getId())).toContain(strike && strike.targetId);
            expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties))).toBe(before);
            expect(h.deps.getActiveUnitId()).toBe(h.actor.getId());
            expect(h.damageStatisticHolder.get()).toHaveLength(0);
            withSearchEnvironment({ ...environment, SEARCH_A19_GRAVECHAIN_COVERAGE: "0" }, () => {
                const baseline = new SearchDriver(h.deps);
                (baseline as unknown as { simSeed: () => number }).simSeed = () => 4433;
                const oldStrike = baseline
                    .chooseDecision(h.actor, "v0.8", easy.actions)
                    .find((action) => action.type === "range_attack");
                expect(oldStrike?.type).toBe("range_attack");
                expect([h.isolated.getId(), alternate.getId()]).toContain(oldStrike && oldStrike.targetId);
            });
            expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties))).toBe(before);
        });
    });

    test.each(["Through Shot", "Large Caliber", "Area Throw"])(
        "real %s search retains lower damage when Gravechain prevents an enemy strike",
        (ability) => {
            const environment = {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.8",
                SEARCH_SHORTLIST: "2",
                SEARCH_A19_GRAVECHAIN_COVERAGE: "1",
                SEARCH_ROLLOUTS: "16",
                SEARCH_HORIZON: "1",
                SEARCH_GATE: "0",
                V07_VALUE_WEIGHTS: "material",
                V07_VALUE_WEIGHTS_V2: undefined,
            };
            withSearchEnvironment(environment, () => {
                const h = fixture({
                    attacker: { abilities: [ability] },
                    cluster: { armor: 100 },
                    root: { damageMin: 100, damageMax: 100 },
                });
                h.add("Exposed ally", { x: 4, y: 9 }, { team: h.actor.getTeam(), maxHp: 1000 });
                const alternate = h.add("Isolated alternate shot", { x: 8, y: 5 }, { armor: 1 });
                h.fightProperties.setTeamUnitsAlive(h.actor.getTeam(), 2);
                h.fightProperties.setTeamUnitsAlive(h.root.getTeam(), 7);
                h.fightProperties.enqueueUpNext(h.root.getId());
                const { easy, chain } = h.catalog();
                expect(easy.features.expectedDamage).toBeGreaterThan(chain.features.expectedDamage);
                const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties));
                const choose = () => {
                    const driver = new SearchDriver(h.deps);
                    (driver as unknown as { simSeed: () => number }).simSeed = () => 4433;
                    return driver.chooseDecision(h.actor, "v0.8", easy.actions);
                };
                const chosen = choose();
                expect(chosen).not.toEqual(easy.actions);
                withSearchEnvironment({ SEARCH_A19_GRAVECHAIN_COVERAGE: "0" }, () => {
                    const oldStrike = choose().find((action) => action.type === "range_attack");
                    expect(oldStrike?.type).toBe("range_attack");
                    expect([h.isolated.getId(), alternate.getId()]).toContain(oldStrike && oldStrike.targetId);
                });
                expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties))).toBe(before);
                h.fire({ ...chain, actions: chosen });
                expect(h.root.hasDebuffActive("Gravebound")).toBe(true);
                h.fightProperties.startTurn(h.root.getTeam(), 2000);
                const replies = enumerateCandidates(h.root, h.context, [
                    { type: "defend_turn", unitId: h.root.getId() },
                ]).candidates;
                expect(replies.some((candidate) => candidate.kind === "melee")).toBe(false);
            });
        },
    );

    test.each([PBTypes.AttackVals.MELEE, PBTypes.AttackVals.MELEE_MAGIC])(
        "also retains and executes legal physical melee chains (type %i)",
        (attackType) => {
            const h = fixture({ actorCell: { x: 7, y: 7 }, attacker: { attackType, rangeShots: 0 } });
            const candidates = enumerateCandidates(h.actor, h.context, [
                { type: "defend_turn", unitId: h.actor.getId() },
            ]).candidates;
            const retained: IEnumeratedCandidate[] = [];
            const reserved = h.reserve(candidates, retained);
            expect(reserved).toHaveLength(1);
            expect(reserved[0]?.actions.some((action) => action.type === "melee_attack")).toBe(true);
            h.fire(reserved[0]!);
            expect(h.root.hasDebuffActive("Gravebound")).toBe(true);
            expect(h.bridge.hasDebuffActive("Gravebound")).toBe(true);
            expect(h.end.hasDebuffActive("Gravebound")).toBe(true);
        },
    );

    test("native repeated shots preserve the same connected control opportunity", () => {
        const h = fixture({ attacker: { abilities: ["Double Shot"] } });
        const { candidates, easy, chain } = h.catalog();
        expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
        h.fire(chain);
        expect(h.third.hasDebuffActive("Gravebound")).toBe(true);
    });

    test.each(["Through Shot", "Large Caliber", "Area Throw"])(
        "%s retains the union of chains from every impact, including beyond the primary's reach",
        (ability) => {
            const h = fixture({ actorCell: { x: 3, y: 3 }, attacker: { abilities: [ability] } });
            const { candidates, easy, chain } = h.catalog();
            const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties));
            setDeterministicRandomSource(() => {
                throw new Error("coverage must not roll combat RNG");
            });
            expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
            expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties))).toBe(before);
            const all = enumerateCandidates(h.actor, h.context, easy.actions).candidates;
            const retained = [chain];
            expect(h.reserve(all, retained)).toBe(retained);
            h.fire(chain);
            expect(h.outside.hasDebuffActive("Gravebound")).toBe(true);
            expect(h.isolated.hasDebuffActive("Gravebound")).toBe(false);
        },
    );

    test("a shielded piercing primary still allows chains from later impacts", () => {
        const h = fixture({
            actorCell: { x: 3, y: 3 },
            attacker: { abilities: ["Through Shot"] },
            root: { abilities: ["Water Shield"] },
        });
        h.root.trySeedWaterShield();
        const { candidates, easy, chain } = h.catalog();
        expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
        h.fire(chain);
        expect(h.outside.hasDebuffActive("Gravebound")).toBe(true);
    });

    test("an empty-cell Area Throw retains control from the actual splash", () => {
        const h = fixture({ attacker: { abilities: ["Area Throw"] } });
        const { easy } = h.catalog();
        const candidates = enumerateCandidates(h.actor, h.context, easy.actions).candidates.filter(
            (candidate) => candidate.kind === "incumbent" || candidate.kind === "area_throw",
        );
        const reserved = h.reserve(candidates, [easy]);
        expect(reserved).toHaveLength(2);
        expect(reserved[1]!.kind).toBe("area_throw");
        h.fire(reserved[1]!);
        expect(h.outside.hasDebuffActive("Gravebound")).toBe(true);
    });

    test("an intercepted throw cannot advertise a distant cluster beyond its actual splash", () => {
        const h = fixture({ actorCell: { x: 3, y: 3 }, attacker: { abilities: ["Area Throw"] } });
        const distant = h.add("Distant cluster", { x: 14, y: 14 });
        const farNeighbor = h.add("Distant neighbor", { x: 15, y: 15 });
        for (const unit of [h.root, h.bridge, h.end, h.third, h.outside]) {
            unit.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", 1), amount: 1 }));
        }
        const { candidates, easy, chain } = h.catalog();
        const intercepted: IEnumeratedCandidate = {
            ...chain,
            kind: "area_throw",
            actions: [{ type: "area_throw_attack", attackerId: h.actor.getId(), targetCell: { x: 13, y: 13 } }],
        };
        const retained = [easy];
        expect(h.reserve([candidates[0]!, easy, intercepted], retained)).toBe(retained);
        h.fire(intercepted);
        expect(distant.hasDebuffActive("Gravebound")).toBe(false);
        expect(farNeighbor.hasDebuffActive("Gravebound")).toBe(false);
    });

    test.each(["Through Shot", "Large Caliber", "Area Throw"])(
        "%s respects Wingshield interception instead of inventing downstream roots",
        (ability) => {
            const h = fixture({
                actorCell: { x: 3, y: 3 },
                attacker: { abilities: [ability] },
                root: { abilities: ["Arrows Wingshield Blessing"] },
            });
            for (const unit of [h.root, h.bridge, h.end]) {
                unit.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", 1), amount: 1 }));
            }
            const { candidates, easy, chain } = h.catalog();
            const retained = [easy];
            // Only the third link is new; the fifth stack would require another impact beyond the Angel.
            expect(h.reserve(candidates, retained)).toBe(retained);
            h.fire(chain);
            expect(h.third.hasDebuffActive("Gravebound")).toBe(true);
            expect(h.outside.hasDebuffActive("Gravebound")).toBe(false);
        },
    );

    test("a free-aim piercing line is reconstructed from its endpoint", () => {
        const h = fixture({ actorCell: { x: 3, y: 3 }, attacker: { abilities: ["Through Shot"] } });
        const { candidates, easy, chain } = h.catalog();
        const free = {
            ...chain,
            actions: chain.actions.map((action) =>
                action.type === "range_attack"
                    ? {
                          type: "range_attack" as const,
                          attackerId: h.actor.getId(),
                          targetId: "",
                          targetPosition: h.root.getPosition(),
                      }
                    : action,
            ),
        };
        expect(h.reserve([candidates[0]!, free], [easy])).toEqual([easy, free]);
        h.fire(free);
        expect(h.outside.hasDebuffActive("Gravebound")).toBe(true);
    });

    test.each(["Through Shot", "Large Caliber", "Area Throw", "Chakram"])(
        "%s does not hide ordinary melee Gravechain opportunities",
        (ability) => {
            const h = fixture({ actorCell: { x: 7, y: 7 }, attacker: { abilities: [ability] } });
            h.actor.refreshPossibleAttackTypes(false);
            const candidates = enumerateCandidates(h.actor, h.context, [
                { type: "defend_turn", unitId: h.actor.getId() },
            ]).candidates;
            const reserved = h.reserve(candidates, []);
            expect(reserved).toHaveLength(1);
            expect(reserved[0]!.actions.some((action) => action.type === "melee_attack")).toBe(true);
            h.fire(reserved[0]!);
            expect(h.bridge.hasDebuffActive("Gravebound")).toBe(true);
        },
    );

    test.each([LEFT, RIGHT])(
        "uses either team's public board without consuming RNG or changing state (seat %i)",
        (team) => {
            const h = fixture({ team });
            const { candidates, easy, chain } = h.catalog();
            const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties));
            setDeterministicRandomSource(() => {
                throw new Error("coverage must be RNG-free");
            });
            expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
            expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties))).toBe(before);
        },
    );

    test.each([
        [1, 2],
        [2, 1],
        [2, 2],
    ])("uses the full %ix%i footprint ring", (width, height) => {
        const h = fixture({ root: { footprintWidth: width, footprintHeight: height } });
        // Only this rectangle's far corner touches the new stack; its anchor is two cells away.
        const corner = h.add("Far footprint corner", { x: 8 - width, y: 8 - height });
        const { candidates, easy, chain } = h.catalog();
        expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
        h.fire(chain);
        expect(corner.hasDebuffActive("Gravebound")).toBe(true);
    });

    test("immune and already slowed stacks relay but are not counted as new beneficiaries", () => {
        const h = fixture({ root: { magicResist: 100 } });
        h.bridge.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", 1), amount: 1 }));
        const { candidates, easy, chain } = h.catalog();
        expect(h.reserve(candidates, [easy])).toEqual([easy, chain]);
        h.end.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", 1), amount: 1 }));
        const retained = [easy];
        expect(h.reserve(candidates, retained)).toBe(retained);
        h.fire(chain);
        expect(h.root.hasDebuffActive("Gravebound")).toBe(false);
        expect(h.bridge.getDebuff("Gravebound")?.getLaps()).toBe(1);
        expect(h.third.hasDebuffActive("Gravebound")).toBe(true);
    });

    test("does not add a duplicate, a single slow, or another equally broad attack", () => {
        const h = fixture();
        const { candidates, easy, chain } = h.catalog();
        const retained = [chain];
        expect(h.reserve(candidates, retained)).toBe(retained);
        const sameRoot = {
            ...chain,
            features: { ...chain.features, expectedDamage: chain.features.expectedDamage + 1 },
        };
        expect(h.reserve([...candidates, sameRoot], retained)).toBe(retained);
        const isolatedOnly = [candidates[0], easy];
        const easyRetained = [easy];
        expect(h.reserve(isolatedOnly, easyRetained)).toBe(easyRetained);
    });

    test("a shielded primary gives no chain reservation; Fire Element can bypass it", () => {
        const h = fixture({ root: { abilities: ["Water Shield"] } });
        h.root.trySeedWaterShield();
        const { candidates, easy } = h.catalog();
        const retained = [easy];
        expect(h.reserve(candidates, retained)).toBe(retained);
        const fire = fixture({ root: { abilities: ["Water Shield"] }, attacker: { abilities: ["Fire Element"] } });
        fire.root.trySeedWaterShield();
        const c = fire.catalog();
        expect(fire.reserve(c.candidates, [c.easy])).toEqual([c.easy, c.chain]);
        fire.fire(c.chain);
        expect(fire.end.hasDebuffActive("Gravebound")).toBe(true);
    });

    test("a fatal root relays to its neighbors but is never counted as slowed", () => {
        const h = fixture({ root: { maxHp: 1 } });
        const { candidates, easy, chain } = h.catalog();
        expect(chain.features.expectedKill).toBe(1);
        for (const unit of [h.end, h.third])
            unit.applyDebuff(new Spell({ spellProperties: getSpellConfig("Death", "Gravebound", 1), amount: 1 }));
        const retained = [easy];
        expect(h.reserve(candidates, retained)).toBe(retained);
        h.end.deleteDebuff("Gravebound");
        expect(h.reserve(candidates, retained)).toEqual([easy, chain]);
        h.fire(chain);
        expect(h.root.isDead()).toBe(true);
        expect(h.bridge.hasDebuffActive("Gravebound")).toBe(true);
        expect(h.end.hasDebuffActive("Gravebound")).toBe(true);
    });

    test("no artifact, nonphysical actions and unsupported impact sets keep the shortlist", () => {
        const h = fixture();
        const { candidates, easy, chain } = h.catalog();
        const retained = [easy];
        const spell: IEnumeratedCandidate = {
            ...chain,
            kind: "spell",
            actions: [
                { type: "cast_spell", casterId: h.actor.getId(), spellName: "Quagmire", targetId: h.root.getId() },
            ],
        };
        expect(h.reserve([candidates[0], easy, spell], retained)).toBe(retained);
        h.fightProperties.setArtifactPerTeam(h.actor.getTeam(), 2, 0);
        h.unitsHolder.applyArtifacts(h.fightProperties);
        expect(h.reserve(candidates, retained)).toBe(retained);
        const splash = fixture({ attacker: { abilities: ["Chakram"] } });
        const s = splash.catalog();
        const sr = [s.easy];
        expect(splash.reserve(s.candidates, sr)).toBe(sr);
    });

    test.each(["v0.8", "v0.8s", "v0.7"])("production shortlist wiring is scoped to %s", (version) => {
        const saved = { ...process.env };
        try {
            for (const key of Object.keys(process.env))
                if (/^(SEARCH_|Q2_|V07_|V08_)/.test(key)) delete process.env[key];
            Object.assign(process.env, {
                V07_SEARCH: "1",
                SEARCH_VERSIONS: version,
                SEARCH_SHORTLIST: "2",
                SEARCH_ROLLOUTS: "1",
                SEARCH_A19_GRAVECHAIN_COVERAGE: "1",
            });
            const h = fixture();
            const { candidates, easy, chain } = h.catalog();
            const driver = new SearchDriver(h.deps) as unknown as {
                scoreCandidates: () => number[];
                shortlistCandidates: (
                    unit: Unit,
                    candidates: readonly IEnumeratedCandidate[],
                    seed: number,
                    deadline: null,
                    version: string,
                ) => readonly IEnumeratedCandidate[];
            };
            driver.scoreCandidates = () => [100, 90, 1];
            const result = driver.shortlistCandidates(h.actor, candidates, 1, null, version);
            expect(result).toEqual(version === "v0.7" ? [candidates[0], easy] : [candidates[0], easy, chain]);
        } finally {
            for (const key of Object.keys(process.env))
                if (/^(SEARCH_|Q2_|V07_|V08_)/.test(key)) delete process.env[key];
            for (const [key, value] of Object.entries(saved))
                if (/^(SEARCH_|Q2_|V07_|V08_)/.test(key) && value !== undefined) process.env[key] = value;
        }
    });

    test("the explicit rollback and absent switch preserve the old shortlist", () => {
        const h = fixture();
        const { candidates, easy } = h.catalog();
        for (const setting of [undefined, "0"]) {
            withSearchEnvironment(
                { V07_SEARCH: "1", SEARCH_SHORTLIST: "2", SEARCH_A19_GRAVECHAIN_COVERAGE: setting },
                () => {
                    const driver = new SearchDriver(h.deps) as unknown as {
                        scoreCandidates: () => number[];
                        shortlistCandidates: (
                            unit: Unit,
                            candidates: readonly IEnumeratedCandidate[],
                            seed: number,
                            deadline: null,
                            version: string,
                        ) => readonly IEnumeratedCandidate[];
                    };
                    driver.scoreCandidates = () => [100, 90, 1];
                    expect(driver.shortlistCandidates(h.actor, candidates, 1, null, "v0.8")).toEqual([
                        candidates[0],
                        easy,
                    ]);
                },
            );
        }
        withSearchEnvironment({ SEARCH_A19_GRAVECHAIN_COVERAGE: "yes" }, () => {
            expect(() => new SearchDriver(h.deps)).toThrow("SEARCH_A19_GRAVECHAIN_COVERAGE must be 0 or 1");
        });
    });
});
