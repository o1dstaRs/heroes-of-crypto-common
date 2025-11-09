/* eslint-disable no-console */
/**
 * scripts/gen_from_protoset.js
 *
 * Generates:
 *  - src/generated/protobuf/v1/creature_gen.ts
 *  - src/generated/protobuf/v1/types_gen.ts        (TeamType, FactionType, …) — type aliases to PBTypes.*
 *  - src/generated/protobuf/v1/enums_reexports.ts  (TeamVals, CreatureVals, …) — re-export ORIGINAL PBTypes enums
 *  - src/generated/protobuf/v1/index.ts            (barrel)
 *
 * Expects:
 *  - src/generated/protobuf/v1/types.protoset
 *  - src/generated/protobuf/v1/types_pb.js         (CJS google-protobuf stubs with extensions)
 *  - src/generated/protobuf/v1/types.ts            (exports PBTypes { ...enums... })
 */

const fs = require("node:fs");
const path = require("node:path");

// descriptor_pb.js is CommonJS
const { FileDescriptorSet } = require("google-protobuf/google/protobuf/descriptor_pb.js");

// Generated stubs (CommonJS via package.json type=commonjs in gen folder)
const gen = require("../src/generated/protobuf/v1/types_pb.js");
const { creatureLevel, creatureFaction, UnitLevelVals, FactionVals } = gen;

/* --------------------------
   Paths
--------------------------- */
const ROOT = __dirname;
const PKG_SRC_DIR = path.resolve(ROOT, "../src");
const GEN_DIR = path.resolve(PKG_SRC_DIR, "generated/protobuf/v1");
const PROTOSET = path.join(GEN_DIR, "types.protoset");

const creatureOutTs = path.join(GEN_DIR, "creature_gen.ts");
const valsTypesOutTs = path.join(GEN_DIR, "types_gen.ts");
const enumsReexportsOutTs = path.join(GEN_DIR, "enums_reexports.ts");
const genIndexOutTs = path.join(GEN_DIR, "index.ts");

/* --------------------------
   Ensure dirs exist
--------------------------- */
fs.mkdirSync(GEN_DIR, { recursive: true });

/* --------------------------
   Read & parse the descriptor set
--------------------------- */
if (!fs.existsSync(PROTOSET)) {
    throw new Error(`Missing protoset at ${PROTOSET}. Run protoc to produce it first.`);
}
const bytes = fs.readFileSync(PROTOSET);
const fds = FileDescriptorSet.deserializeBinary(bytes);

/* --------------------------
   Build Creature maps
--------------------------- */
const levels = {};
const factions = {};
// adjust the array size if you add more levels later
const byLevel = [[], [], [], [], []]; // 0..4

for (const file of fds.getFileList()) {
    for (const ed of file.getEnumTypeList()) {
        if (ed.getName() !== "CreatureVals") continue;
        for (const v of ed.getValueList()) {
            const num = v.getNumber();
            const opts = v.getOptions();
            const lvl = (opts && opts.getExtension(creatureLevel)) ?? UnitLevelVals.NO_LEVEL;
            const fac = (opts && opts.getExtension(creatureFaction)) ?? FactionVals.NO_FACTION;

            levels[num] = lvl;
            factions[num] = fac;
            if (byLevel[lvl]) byLevel[lvl].push(num);
        }
    }
    // if CreatureVals ever becomes nested:
    for (const md of file.getMessageTypeList()) {
        for (const ed of md.getEnumTypeList()) {
            if (ed.getName() !== "CreatureVals") continue;
            for (const v of ed.getValueList()) {
                const num = v.getNumber();
                const opts = v.getOptions();
                const lvl = (opts && opts.getExtension(creatureLevel)) ?? UnitLevelVals.NO_LEVEL;
                const fac = (opts && opts.getExtension(creatureFaction)) ?? FactionVals.NO_FACTION;

                levels[num] = lvl;
                factions[num] = fac;
                if (byLevel[lvl]) byLevel[lvl].push(num);
            }
        }
    }
}

const creatureHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Derived from types.protoset enum value options.\n` +
    `// NOTE: Values are numeric. Compare against UnitLevelVals.* / FactionVals.*.\n`;

const creatureBody =
    `export const CreatureLevels: Record<number, number> = ${JSON.stringify(levels, null, 2)};\n` +
    `export const CreatureFactions: Record<number, number> = ${JSON.stringify(factions, null, 2)};\n` +
    `export const CreatureByLevel: number[][] = ${JSON.stringify(byLevel, null, 2)};\n`;

fs.writeFileSync(creatureOutTs, creatureHeader + creatureBody);
console.log("✓ Wrote", path.relative(process.cwd(), creatureOutTs));

/* --------------------------
   Collect enums (names only) so we can:
   - make type aliases (FooType) pointing to PBTypes.FooVals
   - re-export the ORIGINAL runtime enums by destructuring PBTypes
--------------------------- */
const enumNames = new Set();

for (const file of fds.getFileList()) {
    // top-level enums
    for (const ed of file.getEnumTypeList()) {
        enumNames.add(ed.getName());
    }
    // nested enums (inside messages)
    for (const md of file.getMessageTypeList()) {
        for (const ed of md.getEnumTypeList()) {
            enumNames.add(ed.getName());
        }
    }
}

const sortedEnumNames = Array.from(enumNames).sort();

/* --------------------------
   types_gen.ts  (TeamType, FactionType, ...)
   ONLY for *Vals enums (Type = PBTypes.FooVals)
--------------------------- */
const valsEnumNames = sortedEnumNames.filter((n) => n.endsWith("Vals"));

const typesHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Type aliases for numeric proto enums (*Vals) using PBTypes.*.\n` +
    `// Safe: no runtime imports, purely types.\n` +
    `import { PBTypes } from "./types";\n\n`;

const typeAliasLines = valsEnumNames.map((name) => {
    const typeName = name.replace(/Vals$/, "Type"); // TeamVals -> TeamType
    return `export type ${typeName} = PBTypes.${name};`;
});

fs.writeFileSync(valsTypesOutTs, typesHeader + typeAliasLines.join("\n") + "\n");
console.log("✓ Wrote", path.relative(process.cwd(), valsTypesOutTs));

/* --------------------------
   enums_reexports.ts  (re-export ORIGINAL runtime enums)
   We DO NOT regenerate enums; we re-export the ones on PBTypes.
--------------------------- */
const enumsHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Re-exports ORIGINAL runtime enums from PBTypes (no regeneration).\n` +
    `import { PBTypes } from "./types";\n\n` +
    `// Re-export as named constants so consumers can do:\n` +
    `//   import { TeamVals, CreatureVals } from "@heroesofcrypto/common";\n`;

const reexportNames = valsEnumNames; // limit to *Vals enums; add others if you also want them
const reexportLines = [
    `export const {`,
    reexportNames.map((n, i) => `  ${n}${i < reexportNames.length - 1 ? "," : ""}`).join("\n"),
    `} = PBTypes;\n`,
];

fs.writeFileSync(enumsReexportsOutTs, enumsHeader + reexportLines.join("\n"));
console.log("✓ Wrote", path.relative(process.cwd(), enumsReexportsOutTs));

/* --------------------------
   generated/protobuf/v1/index.ts  (barrel)
--------------------------- */
const genIndexHeader = `// AUTO-GENERATED. DO NOT EDIT.\n` + `// Public barrel for generated v1 API.\n`;

const genIndexBody =
    [
        `export * from "./enums_reexports";`, // ORIGINAL runtime enums (TeamVals, CreatureVals, …)
        `export * from "./types_gen";`, // type aliases (TeamType, CreatureType, …)
        `export * from "./creature_gen";`, // derived maps
    ].join("\n") + "\n";

fs.writeFileSync(genIndexOutTs, genIndexHeader + genIndexBody);
console.log("✓ Wrote", path.relative(process.cwd(), genIndexOutTs));
