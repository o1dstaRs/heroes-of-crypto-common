/*
 * -----------------------------------------------------------------------------
 * Cursed Ward's morale penalty must be applied exactly once.
 *
 * Ranked hands the client the server's FINAL morale and the client seeds a unit
 * with it, then runs the same refreshUnits() -> applyArtifacts() +
 * refreshStackPowerForAllUnits() cycle the sandbox does. Before
 * morale_authoritative, adjustBaseStats rebuilt morale from that already-adjusted
 * base and subtracted the artifact delta a second time, so a single Cursed Ward
 * read as -12 (and, stacked on in-fight morale losses, as -18).
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { ARTIFACT_POWER, Tier1Artifact } from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const PENALTY = ARTIFACT_POWER.CURSED_WARD_MORALE_PENALTY;

/** One locally-simulated (sandbox-style) team carrying Cursed Ward. */
const simulateLocally = (morale: number) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LOWER, 1, Tier1Artifact.CURSED_WARD);
    const unit = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.LOWER, morale });
    placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
    return { unitsHolder, fightProperties, unit };
};

describe("Cursed Ward morale penalty", () => {
    it("applies once locally and stays put across repeated recomputes", () => {
        const { unitsHolder, fightProperties, unit } = simulateLocally(0);

        const seen: number[] = [];
        for (let i = 0; i < 4; i += 1) {
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
            seen.push(unit.getMorale());
        }

        expect(seen).toEqual([-PENALTY, -PENALTY, -PENALTY, -PENALTY]);
        expect(unit.getUnitProperties().applied_buffs.filter((n) => n === "Cursed Ward")).toHaveLength(1);
        expect(unit.getUnitProperties().applied_debuffs.filter((n) => n === "Cursed Ward")).toHaveLength(1);
    });

    it("is NOT re-applied on top of an authoritative (ranked) morale", () => {
        // What the server computes and ships.
        const server = simulateLocally(0);
        server.unitsHolder.applyArtifacts(server.fightProperties);
        server.unitsHolder.refreshStackPowerForAllUnits();
        const authoritativeMorale = server.unit.getMorale();
        expect(authoritativeMorale).toBe(-PENALTY);

        // What the ranked client does with it: seed the snapshot's morale, flag it authoritative, then run
        // the normal refresh cycle repeatedly. The value must survive untouched.
        const client = simulateLocally(authoritativeMorale);
        client.unit.getUnitProperties().morale_authoritative = true;
        for (let i = 0; i < 4; i += 1) {
            client.unitsHolder.applyArtifacts(client.fightProperties);
            client.unitsHolder.refreshStackPowerForAllUnits();
            expect(client.unit.getMorale()).toBe(authoritativeMorale);
        }
    });

    it("does not double-count a server morale that already includes in-fight losses", () => {
        // The -18 report: artifact (-6) plus -6 of in-fight morale loss = -12 on the server; the client
        // used to subtract another 6 on top.
        const authoritativeMorale = -PENALTY - 6;
        const client = simulateLocally(authoritativeMorale);
        client.unit.getUnitProperties().morale_authoritative = true;
        client.unitsHolder.applyArtifacts(client.fightProperties);
        client.unitsHolder.refreshStackPowerForAllUnits();
        expect(client.unit.getMorale()).toBe(authoritativeMorale);
    });
});
