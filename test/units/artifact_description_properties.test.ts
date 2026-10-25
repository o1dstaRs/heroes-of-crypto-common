import { expect, test } from "bun:test";

import { ARTIFACT_POWER } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { Spell } from "../../src/spells/spell";
import { createTestUnit } from "../helpers/combat";

interface IDescriptionRefresh {
    refreshLastFuseDescription(): void;
    refreshQuiverOfEchoesDescription(): void;
    refreshRimeCharmDescription(): void;
    refreshGravechainDescription(): void;
}

const artifacts = [
    ["Last Fuse", "refreshLastFuseDescription"],
    ["Quiver of Echoes", "refreshQuiverOfEchoesDescription"],
    ["Rime Charm", "refreshRimeCharmDescription"],
    ["Gravechain", "refreshGravechainDescription"],
] as const;

for (const [artifact, method] of artifacts) {
    test(`${artifact} keeps every positional-property byte while refreshing its card`, () => {
        const unit = createTestUnit();
        unit.applyBuff(new Spell({ spellProperties: getSpellConfig("System", artifact), amount: 1 }));
        const properties = unit.getUnitProperties();
        const index = properties.applied_buffs.indexOf(artifact);
        const refresh = unit as unknown as IDescriptionRefresh;
        const descriptions = [
            "",
            "opaque prose without properties",
            "prose;",
            "prose;;",
            "prose;25;3",
            "prose;0;0",
            "prose;-4; 2 ",
            "prose;12;Infinity",
            "prose;12;NaN;extra;;",
            "unicode 🙂;1;4;opaque\ntrailing data;",
        ];
        let state = 0xbaff_2026;
        for (let i = 0; i < 128; i += 1) {
            const chars: string[] = [];
            for (let j = 0; j < i; j += 1) {
                state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
                chars.push(";0123456789 xyz\n🙂"[state % 18]!);
            }
            descriptions.push(chars.join(""));
        }

        for (const original of descriptions) {
            properties.applied_buffs_descriptions[index] = original;
            const legacyFields = original.split(";").slice(1);
            refresh[method]();
            const rendered = properties.applied_buffs_descriptions[index]!;
            expect(rendered.split(";").slice(1).join(";")).toBe(legacyFields.join(";"));
            if (artifact === "Rime Charm" || artifact === "Gravechain") {
                const fallback =
                    artifact === "Rime Charm" ? ARTIFACT_POWER.RIME_SLOW_LAPS : ARTIFACT_POWER.GRAVECHAIN_SLOW_LAPS;
                expect(rendered).toContain(`for ${Number(legacyFields[1]) || fallback} laps`);
            }
            refresh[method]();
            expect(properties.applied_buffs_descriptions[index]).toBe(rendered);
        }
    });
}
