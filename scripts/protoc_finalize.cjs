/* eslint-disable no-console */
/**
 * scripts/gen_from_protoset.js
 *
 * Generates:
 *  - src/generated/protobuf/v1/creature_gen.ts
 *  - src/generated/protobuf/v1/types_gen.ts           (TeamType, FactionType, …) — type aliases to PBTypes.*
 *  - src/generated/protobuf/v1/enums_reexports.ts     (TeamVals, CreatureVals, …) — re-export ORIGINAL PBTypes enums
 *  - src/generated/protobuf/v1/messages_reexports.ts  (ConfirmCode, NewPlayer, ...) — flatten PBTypes.<Msg> to top-level
 *      also exports FooObject = ReturnType<InstanceType<typeof Foo>["toObject"]>
 *  - src/generated/protobuf/v1/index.ts               (barrel)
 *
 * Expects:
 *  - src/generated/protobuf/v1/types.protoset
 *  - src/generated/protobuf/v1/*_pb.js    (CJS google-protobuf stubs with PBTypes for your app protos)
 *  - src/generated/protobuf/v1/types.ts   (exports PBTypes { ...enums... })
 */

const fs = require("node:fs");
const path = require("node:path");
const { FileDescriptorSet } = require("google-protobuf/google/protobuf/descriptor_pb.js");

// Need extensions for Creature maps
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
const messagesReexportsOutTs = path.join(GEN_DIR, "messages_reexports.ts");
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
   Collect enums & messages
--------------------------- */
const enumNames = new Set();
const files = []; // [{ protoName, baseName, messages: [msgName, ...] }]

for (const file of fds.getFileList()) {
    const protoName = file.getName(); // e.g. "confirm_code.proto" or "google/protobuf/descriptor.proto"
    const baseName = protoName.replace(/\.proto$/, ""); // e.g. "confirm_code" or "google/protobuf/descriptor"

    const messages = file.getMessageTypeList().map((m) => m.getName());

    // top-level enums
    for (const ed of file.getEnumTypeList()) enumNames.add(ed.getName());
    // nested enums (inside messages)
    for (const md of file.getMessageTypeList()) {
        for (const ed of md.getEnumTypeList()) enumNames.add(ed.getName());
    }

    files.push({ protoName, baseName, messages });
}

const sortedEnumNames = Array.from(enumNames).sort();
const valsEnumNames = sortedEnumNames.filter((n) => n.endsWith("Vals"));

/* --------------------------
   types_gen.ts  (TeamType, FactionType, ...)
--------------------------- */
const typesHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Type aliases for numeric proto enums (*Vals) using PBTypes.*.\n` +
    `// Safe: no runtime imports, purely types.\n` +
    `import { PBTypes } from "./types";\n\n`;

const typeAliasLines = valsEnumNames.map((name) => {
    const typeName = name.replace(/Vals$/, "Type");
    return `export type ${typeName} = PBTypes.${name};`;
});

fs.writeFileSync(valsTypesOutTs, typesHeader + typeAliasLines.join("\n") + "\n");
console.log("✓ Wrote", path.relative(process.cwd(), valsTypesOutTs));

/* --------------------------
   enums_reexports.ts  (re-export ORIGINAL runtime enums)
--------------------------- */
const enumsHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Re-exports ORIGINAL runtime enums from PBTypes (no regeneration).\n` +
    `import { PBTypes } from "./types";\n\n` +
    `// Usage: import { TeamVals, CreatureVals } from "@heroesofcrypto/common";\n`;

const reexportLines = [
    `export const {`,
    valsEnumNames.map((n, i) => `  ${n}${i < valsEnumNames.length - 1 ? "," : ""}`).join("\n"),
    `} = PBTypes;\n`,
];

fs.writeFileSync(enumsReexportsOutTs, enumsHeader + reexportLines.join("\n"));
console.log("✓ Wrote", path.relative(process.cwd(), enumsReexportsOutTs));

/* --------------------------
   messages_reexports.ts  (flatten PBTypes.<Message> => top-level exports)
   Skip any google/protobuf/* protos (their TS entry paths differ and you don't need them here).
--------------------------- */
let msgHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Re-exports message classes from PBTypes.* as top-level named exports.\n\n`;

let msgBody = ``;

const publicProtoFiles = files.filter((f) => !f.baseName.startsWith("google/protobuf/"));

for (const f of publicProtoFiles) {
    const modAlias = `m_${f.baseName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    // Your app runtime JS stubs are "*_pb"
    msgBody += `import * as ${modAlias} from "./${f.baseName}";\n`;
    for (const m of f.messages) {
        // value export: the constructor (class)
        msgBody += `export const ${m} = ${modAlias}.PBTypes.${m};\n`;
        // type export: instance type of that constructor
        msgBody += `export type ${m} = InstanceType<typeof ${modAlias}.PBTypes.${m}>;\n`;
        // object-shape type: what .toObject() returns
        msgBody += `export type ${m}Object = ReturnType<InstanceType<typeof ${modAlias}.PBTypes.${m}>["toObject"]>;\n`;
    }
    msgBody += `\n`;
}

fs.writeFileSync(messagesReexportsOutTs, msgHeader + msgBody);
console.log("✓ Wrote", path.relative(process.cwd(), messagesReexportsOutTs));

/* --------------------------
   generated/protobuf/v1/index.ts  (barrel)
--------------------------- */
const genIndexHeader = `// AUTO-GENERATED. DO NOT EDIT.\n` + `// Public barrel for generated v1 API.\n`;

const genIndexBody =
    [
        `export * from "./enums_reexports";`,
        `export * from "./types_gen";`,
        `export * from "./creature_gen";`,
        `export * from "./messages_reexports";`,
    ].join("\n") + "\n";

fs.writeFileSync(genIndexOutTs, genIndexHeader + genIndexBody);
console.log("✓ Wrote", path.relative(process.cwd(), genIndexOutTs));
