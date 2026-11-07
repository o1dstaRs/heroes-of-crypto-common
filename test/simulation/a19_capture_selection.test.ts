import { describe, expect, test } from "bun:test";
import { A19StrictRootCollector, a19CapturePhase } from "../../src/simulation/v0_9/a19_capture_selection";

const request = { focal: "Black Dragon", team: 1, phase: 2 as const };
const root = (lap: number, ordinal = 0) => ({ actor: "Black Dragon", team: 1, lap, ordinal });

describe("strict research root collection", () => {
    test("rejects phase fallback and keeps later matching roots", () => {
        const collect = new A19StrictRootCollector(request);
        collect.noteDecision("Black Dragon", 1, 1, true);
        collect.offer(root(1), 0);
        expect(collect.selected()).toBeNull();
        collect.noteDecision("Black Dragon", 1, 6, true);
        collect.offer(root(6, 2), 10);
        expect(collect.selected()?.lap).toBe(6);
        expect(collect.finish(["Black Dragon"]).selectedPhase).toBe(2);
    });

    test("does not label another unit or the opposing army", () => {
        const collect = new A19StrictRootCollector(request);
        collect.noteDecision("Magic Dragon", 1, 6, true);
        collect.noteDecision("Black Dragon", 2, 6, true);
        collect.offer({ ...root(6), actor: "Magic Dragon" }, 0);
        collect.offer({ ...root(6), team: 2 }, 0);
        expect(collect.selected()).toBeNull();
        expect(collect.finish(["Black Dragon"]).missingRootReason).toBe("no_focal_turn");
    });

    test("selects independently of visitation order and breaks rank ties by ordinal", () => {
        for (const order of [
            [3, 1, 2],
            [2, 1, 3],
        ]) {
            const collect = new A19StrictRootCollector(request);
            for (const ordinal of order) {
                collect.noteDecision("Black Dragon", 1, 6, true);
                collect.offer(root(6, ordinal), ordinal === 3 ? 100 : 9);
            }
            expect(collect.selected()?.ordinal).toBe(1);
        }
    });

    test("retains separate missing reasons and actual phase counts", () => {
        const absent = new A19StrictRootCollector(request);
        expect(absent.finish(["Zena"]).missingRootReason).toBe("focal_absent_from_draft");
        const noTurn = new A19StrictRootCollector(request);
        expect(noTurn.finish(["Black Dragon"]).missingRootReason).toBe("no_focal_turn");
        const noTie = new A19StrictRootCollector(request);
        noTie.noteDecision("Black Dragon", 1, 6, false);
        expect(noTie.finish(["Black Dragon"]).missingRootReason).toBe("no_eligible_primary_tie");
        const wrongPhase = new A19StrictRootCollector(request);
        wrongPhase.noteDecision("Black Dragon", 1, 3, true);
        wrongPhase.offer(root(3), 1);
        expect(wrongPhase.finish(["Black Dragon"])).toMatchObject({
            selectedPhase: null,
            missingRootReason: "no_eligible_root_in_requested_phase",
            eligibleFocalDecisionsByPhase: [0, 1, 0],
        });
    });

    test("natural background still obeys the requested phase", () => {
        const collect = new A19StrictRootCollector({ team: 1, phase: 1 });
        collect.noteDecision("Zena", 1, 1, true);
        collect.offer({ ...root(1), actor: "Zena" }, 0);
        collect.noteDecision("Magic Dragon", 1, 4, true);
        collect.offer({ ...root(4), actor: "Magic Dragon" }, 9);
        expect(collect.selected()?.actor).toBe("Magic Dragon");
    });

    test("does not admit a root that contradicts the actual roster", () => {
        const collect = new A19StrictRootCollector(request);
        collect.noteDecision("Black Dragon", 1, 6, true);
        collect.offer(root(6), 1);
        expect(() => collect.finish(["Zena"])).toThrow("contradicts draft roster");
    });

    test("request is isolated from later caller mutations", () => {
        const mutable = { focal: "Black Dragon", team: 1, phase: 2 as const };
        const collect = new A19StrictRootCollector(mutable);
        mutable.focal = "Zena";
        collect.noteDecision("Black Dragon", 1, 6, true);
        collect.offer(root(6), 1);
        expect(collect.selected()?.actor).toBe("Black Dragon");
    });

    test("validates phases and ranks", () => {
        expect([1, 2, 3, 5, 6, 20].map(a19CapturePhase)).toEqual([0, 0, 1, 1, 2, 2]);
        for (const invalid of [0, -1, 1.5, Number.NaN]) expect(() => a19CapturePhase(invalid)).toThrow();
        const collect = new A19StrictRootCollector(request);
        for (const rank of [-1, 0x100000000, Number.NaN]) expect(() => collect.offer(root(6), rank)).toThrow();
    });
});
