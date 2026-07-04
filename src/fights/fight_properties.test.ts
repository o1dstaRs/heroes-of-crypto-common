import { describe, expect, it } from "bun:test";

import { FightProperties } from "./fight_properties";

// restoreAlreadyHourglass is how the ranked client keeps "who has used their one hourglass this lap" in sync
// with the server (the ranked client follows snapshots instead of running the turn engine, so it never calls
// flipLap()/enqueueHourglass()). Without a correct set, the AI's canHourglass is perpetually true and it
// re-requests a hourglass on a unit's re-up, which the server rejects (hourglass_not_available) → wasted skip.
describe("FightProperties.restoreAlreadyHourglass", () => {
    it("rebuilds the already-hourglassed set from an authoritative list", () => {
        const fp = new FightProperties();
        expect(fp.hasAlreadyHourglass("a")).toBe(false);

        fp.restoreAlreadyHourglass(["a", "b"]);

        expect(fp.hasAlreadyHourglass("a")).toBe(true);
        expect(fp.hasAlreadyHourglass("b")).toBe(true);
        expect(fp.hasAlreadyHourglass("c")).toBe(false);
    });

    it("REPLACES (not merges) prior entries so the set clears at lap change", () => {
        const fp = new FightProperties();
        fp.restoreAlreadyHourglass(["a", "b"]);

        // Next lap: the server resets the flags in flipLap(), so the snapshot carries an empty set.
        fp.restoreAlreadyHourglass([]);

        expect(fp.hasAlreadyHourglass("a")).toBe(false);
        expect(fp.hasAlreadyHourglass("b")).toBe(false);
    });

    it("lets the authoritative snapshot override a locally-enqueued (optimistic) hourglass", () => {
        const fp = new FightProperties();
        fp.enqueueHourglass("a");
        expect(fp.hasAlreadyHourglass("a")).toBe(true);

        // Authoritative truth says nobody has hourglassed — the client must defer to it.
        fp.restoreAlreadyHourglass([]);

        expect(fp.hasAlreadyHourglass("a")).toBe(false);
    });
});
