import { creaturesByLevel } from "./src/simulation/army";
for (const lvl of [1, 2, 3, 4]) {
    const e = creaturesByLevel(lvl)
        .filter((c) => c.size === 2)
        .map((c) => `${c.faction}/${c.creatureName}/${c.attackType}/${c.movementType}`);
    console.log(lvl, e.join(", "));
}
for (const lvl of [1, 2]) {
    const e = creaturesByLevel(lvl)
        .filter((c) => c.size === 1 && c.attackType === "MELEE" && c.movementType !== "FLY")
        .map((c) => `${c.faction}/${c.creatureName}`);
    console.log("small", lvl, e.slice(0, 8).join(", "));
}
