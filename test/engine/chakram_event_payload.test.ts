import { describe, expect, test } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import type { IVisibleDamage } from "../../src/scene/animations";

const cloneVisibleDamage = (damage: IVisibleDamage): IVisibleDamage =>
    (
        GameActionEngine.prototype as unknown as {
            cloneVisibleDamage: (damage: IVisibleDamage) => IVisibleDamage;
        }
    ).cloneVisibleDamage.call({}, damage);

describe("Chakram event snapshots", () => {
    test("later mutations cannot change a recorded volley's path or damage", () => {
        const arc = {
            targetUnitId: "bounce",
            cells: [
                { x: 4, y: 8 },
                { x: 5, y: 8 },
                { x: 6, y: 8 },
            ],
            hitUnitIds: ["bounce"],
            mountainCells: [{ x: 5, y: 9 }],
        };
        const hit = { unitId: "bounce", position: { x: 6, y: 8 }, amount: 17, unitsDied: 1 };
        const damage: IVisibleDamage = {
            amount: 0,
            render: false,
            unitPosition: { x: 4, y: 8 },
            unitIsSmall: false,
            chakramArcs: [arc],
            splash: [hit],
            chakramFlights: [
                {
                    attackerId: "zena",
                    primaryTargetId: "primary",
                    response: false,
                    hitIndex: 1,
                    missed: false,
                    arcs: [arc],
                    splash: [hit],
                },
            ],
        };
        const recorded = cloneVisibleDamage(damage);
        const expected = JSON.parse(JSON.stringify(recorded));

        arc.cells[0].x = 99;
        arc.hitUnitIds.push("later-victim");
        arc.mountainCells[0].y = 99;
        hit.position.x = 99;
        hit.amount = 99;
        damage.chakramFlights![0].primaryTargetId = "later-primary";
        damage.chakramFlights![0].arcs.push({ ...arc });
        damage.chakramFlights![0].splash.push({ ...hit });

        expect(JSON.parse(JSON.stringify(recorded))).toEqual(expected);
    });

    test("JSON events retain a missed throw even when it has no bounces", () => {
        const damage: IVisibleDamage = {
            amount: 0,
            render: false,
            unitPosition: { x: 6, y: 8 },
            unitIsSmall: false,
            chakramFlights: [
                {
                    attackerId: "counter-zena",
                    primaryTargetId: "rectangular-shooter",
                    response: true,
                    hitIndex: 0,
                    missed: true,
                    arcs: [],
                    splash: [
                        {
                            unitId: "rectangular-shooter",
                            position: { x: 6, y: 8 },
                            amount: 0,
                            unitsDied: 0,
                            missed: true,
                        },
                    ],
                },
            ],
        };

        const roundTrip = JSON.parse(JSON.stringify(cloneVisibleDamage(damage))) as IVisibleDamage;

        expect(roundTrip.chakramFlights).toEqual(damage.chakramFlights);
        expect(roundTrip.chakramFlights?.[0].arcs).toHaveLength(0);
        expect(roundTrip.chakramFlights?.[0].splash[0].missed).toBe(true);
    });
});
