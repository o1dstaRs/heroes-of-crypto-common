/* eslint-disable */
const fs = require("node:fs");
const path = require("node:path");

// descriptor_pb.js is CommonJS
const { FileDescriptorSet } = require("google-protobuf/google/protobuf/descriptor_pb.js");

// Generated stubs (CommonJS via package.json type=commonjs in gen folder)
const gen = require("../src/generated/protobuf/v1/types_pb.js");
const { creatureLevel, creatureFaction, UnitLevelVals, FactionVals } = gen;

const ROOT = __dirname;
const GEN_DIR = path.resolve(ROOT, "../src/generated/protobuf/v1");
const PROTOSET = path.join(GEN_DIR, "types.protoset");
const creatureOutTs = path.join(GEN_DIR, "creature_gen.ts");
const valsTypesOutTs = path.join(GEN_DIR, "types_gen.ts");

// Read & parse the descriptor set
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
            const num = v.getNumber(); // numeric Creature value
            const opts = v.getOptions();
            const lvl = (opts && opts.getExtension(creatureLevel)) ?? UnitLevelVals.NO_LEVEL;
            const fac = (opts && opts.getExtension(creatureFaction)) ?? FactionVals.NO_FACTION;

            levels[num] = lvl;
            factions[num] = fac;
            if (byLevel[lvl]) byLevel[lvl].push(num);
        }
    }
}

// Emit numeric shape to avoid google-protobuf enum typing quirks
const creatureHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Derived from types.protoset enum value options.\n` +
    `// NOTE: Values are numeric. Compare against UnitLevelVals.FIRST / FactionVals.LIFE, etc.\n`;

const creatureBody =
    `export const CreatureLevels: Record<number, number> = ${JSON.stringify(levels, null, 2)};\n` +
    `export const CreatureFactions: Record<number, number> = ${JSON.stringify(factions, null, 2)};\n` +
    `export const CreatureByLevel: number[][] = ${JSON.stringify(byLevel, null, 2)};\n`;

fs.writeFileSync(creatureOutTs, creatureHeader + creatureBody);
console.log("✓ Wrote", path.relative(process.cwd(), creatureOutTs));

/* --------------------------
   Emit *Type aliases for each *Vals enum
   TeamVals -> TeamType, UnitVals -> UnitType, etc.
   Types use the "...Map" interfaces exported by google-protobuf d.ts:
   e.g. export interface TeamValsMap { NO_TEAM: 0; UPPER: 1; LOWER: 2; }
   Then: type TeamType = TeamValsMap[keyof TeamValsMap];
--------------------------- */
const valsEnumNames = new Set();

/** Walk file and (optionally) nested enums if you add them later */
for (const file of fds.getFileList()) {
    for (const ed of file.getEnumTypeList()) {
        const name = ed.getName();
        if (name.endsWith("Vals")) valsEnumNames.add(name);
    }
    // If you ever nest enums inside messages, you can also iterate:
    // for (const md of file.getMessageTypeList()) {
    //   for (const ed of md.getEnumTypeList()) { ... }
    // }
}

const sortedNames = Array.from(valsEnumNames).sort(); // deterministic output
// const importTypeEntries = sortedNames.map((n) => `${n}Map`);
// const typeAliasLines = sortedNames.map((n) => {
//     const base = n.replace(/Vals$/, ""); // TeamVals -> Team
//     const typeName = `${base}Type`; // TeamType
//     const mapName = `${n}Map`; // TeamValsMap
//     return `export type ${typeName} = ${mapName}[keyof ${mapName}];`;
// });

const valsHeader =
    `// AUTO-GENERATED. DO NOT EDIT.\n` +
    `// Type aliases for numeric proto enums (*Vals) using their "...Map" interfaces.\n` +
    `// Safe: no runtime imports, purely types.\n` +
    `import { PBTypes } from "./types";\n\n`;

const typeAliasLines = sortedNames.map((name) => {
    const typeName = name.replace(/Vals$/, "Type");
    return `export type ${typeName} = PBTypes.${name};`;
});

const valsBody = typeAliasLines.join("\n") + "\n";

fs.writeFileSync(valsTypesOutTs, valsHeader + valsBody);
console.log("✓ Wrote", path.relative(process.cwd(), valsTypesOutTs));
