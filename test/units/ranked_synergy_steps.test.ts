/*
 * -----------------------------------------------------------------------------
 * Reproduce the ranked "Chaos MOVEMENT synergy doesn't extend my move" bug through the EXACT server path:
 * set the synergy on the shared FightStateManager, run UnitsHolder.refreshStackPowerForAllUnits() (what the
 * server now calls before every reachable-set computation), and assert getSteps() picks up the bonus.
 * Before the fix the server never ran this refresh at validation time, so getSteps stayed at BASE while the
 * client showed the boosted range → attack/move refused from a "legit" position.
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { ChaosSynergy } from "../../src/synergies/synergy_properties";
import { createCombatTestContext, createTestUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const RANGE = PBTypes.AttackVals.RANGE;
const CHAOS = PBTypes.FactionVals.CHAOS;

describe("ranked Chaos MOVEMENT synergy folds into getSteps via the server refresh", () => {
    it("refreshStackPowerForAllUnits applies the team's movement synergy to getSteps()", () => {
        const c = createCombatTestContext(); // resets FightStateManager singleton
        const fp = FightStateManager.getInstance().getFightProperties();

        // Place a mover on the board (refresh skips off-grid units).
        const mover = createTestUnit({ name: "Beholder", team: LOWER, attackType: RANGE, speed: 4, morale: 0 });
        c.grid.occupyCell({ x: 6, y: 1 }, mover.getId(), LOWER, 1, false, false);
        mover.setPosition(6, 1);
        c.unitsHolder.addUnit(mover);

        // Baseline: no synergy yet.
        c.unitsHolder.refreshStackPowerForAllUnits();
        const base = mover.getSteps();

        // Field the Chaos MOVEMENT synergy (needs >=2 Chaos units for level 1 — as setup computes it).
        fp.setSynergyUnitsPerFactions(LOWER, 0, 2, 0, 0);
        const applied = fp.updateSynergyPerTeam(LOWER, CHAOS, ChaosSynergy.MOVEMENT, 1);
        expect(applied).toBe(true);
        expect(fp.getAdditionalMovementStepsPerTeam(LOWER)).toBeGreaterThan(0);

        // The server now runs this refresh before every reachable-set check.
        c.unitsHolder.refreshStackPowerForAllUnits();
        expect(mover.getSteps()).toBe(base + fp.getAdditionalMovementStepsPerTeam(LOWER));
        expect(mover.getSteps()).toBeGreaterThan(base);
    });
});
