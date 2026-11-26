/*
 * The native engine's scope as a pre-check on live TypeScript objects (zig/BRIDGE.md "Scope manifest"): given a
 * battle's unitsHolder, grid and fightProperties, answers "would the library load this root and accept a request for
 * policy P" by name lookups, in microseconds, without exporting it. It is compiled from the library's own manifest
 * (`engine.scopeManifest(policy)`, generated from the tables snapshot.zig and rollout.v08Scope refuse by), so the two
 * cannot drift. A root it passes and the library still refuses is a pre-check miss (the export and load cost was
 * wasted, the decision is unaffected); a root it refuses runs in TypeScript.
 *
 *   const precheck = compileHocPrecheck(engine.scopeManifest("v0.8"));
 *   const why = precheck.refusal({ unitsHolder, grid, fightProperties });   // null: the library takes this root
 *
 * What it reads, besides the manifest's names and capacities: the raw unit fields the export captures (the Ability
 * objects, the applied lists, the spellbook entries and Spell objects, Effect stacks, the stored properties of aura,
 * augment and artifact rows, the artifact-granted cards), the summon templates a board can raise (Infest, a summon
 * spell, a summoned Wolf), the grid type, stones and Barrel Barricade's barrels, the fight's lap, the teams'
 * artifacts, smoke clouds, fire walls and vines. The consistency checks of the loader (applied lists
 * against their objects, registrations against the board, alreadyMadeTurnByTeam against alreadyMadeTurn, terrain
 * cells) hold on every state the TypeScript engine produces and are not repeated here.
 */

import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../../src/utils/lib";
import type { IHocScopeManifest } from "./bridge";

export interface IHocPrecheckContext {
    unitsHolder: any;
    grid: any;
    fightProperties: any;
}

/**
 * The ranked client's authoritative stats on UnitProperties (src/units/unit_properties.ts, every `*_authoritative`
 * field except spell_entries_authoritative). The loader refuses any such key by suffix (manifest
 * `refuse.unitPropSuffix`); reading the props' keys on every root would cost more than the rest of the pre-check, so
 * the known fields are listed here and `strict` mode (tests) enumerates the keys instead.
 */
export const AUTHORITATIVE_PROPS = [
    "luck_authoritative",
    "armor_mod_authoritative",
    "attack_mod_authoritative",
    "steps_authoritative",
    "max_hp_authoritative",
    "morale_authoritative",
    "base_armor_authoritative",
    "base_attack_authoritative",
    "range_shots_authoritative",
] as const;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** snapshot.requireEmpty on the value's export form (toPlain): undefined, null, false, +0, "", [] and {} are empty. */
export function exportsEmpty(v: unknown): boolean {
    if (v === undefined || v === null) return true;
    switch (typeof v) {
        case "boolean":
            return !v;
        case "number":
            return v === 0 && !Object.is(v, -0); // -0, NaN and the infinities export as tagged objects
        case "string":
            return v.length === 0;
        case "function":
            return true; // dropped by the export
        case "object": {
            if (Array.isArray(v)) return v.length === 0;
            if (v instanceof Map || v instanceof Set) return v.size === 0;
            const proto = Object.getPrototypeOf(v);
            if (typeof (v as any).toArray === "function" && typeof (v as any).length === "number") {
                return (v as any).length === 0; // Denque
            }
            if (proto && proto !== Object.prototype) return false; // a class instance carries $class
            for (const x of Object.values(v as object)) if (typeof x !== "function") return false;
            return true;
        }
        default:
            return false;
    }
}

/** The creatures each summon source raises (state_export.ts engineConfigs). */
const INFEST_SUMMONS = ["Arachna Spider", "Arachna Queen"];
const SPELL_SUMMONS = ["Wolf"];

export class HocPrecheck {
    private readonly abilities: Set<string>;
    private readonly auras: Set<string>;
    private readonly applied: Set<string>;
    private readonly spells: Set<string>;
    private readonly prefixes: Set<string>;
    private readonly factions: Set<number>;
    private readonly summons: Set<string>;
    private readonly unitTypes: Set<number>;
    private readonly teams: Set<number>;
    private readonly gridTypes: Set<number>;
    private readonly castable: Set<string> | null;
    private readonly refusedAbilities: Set<string>;
    private readonly refusedDebuffs: Set<string>;
    private readonly refusedEffects: Set<string>;
    private readonly refusedBuffs: Set<string>;
    private readonly refusedRevived: boolean;
    private readonly refusedArtifactRows: boolean;
    private readonly refusedSmoke: boolean;
    private readonly refusedFireWalls: boolean;
    private readonly artifactRowBuffs: Set<string>;
    private readonly artifactRowDebuffs: Set<string>;
    private readonly storedBuffs: Set<string>;
    private readonly artifactTiers: [Set<number>, Set<number>];
    private readonly limitedProps: Array<[string, Set<string>]>;
    private readonly fieldParts: Array<[string, string]>;
    private readonly cap: IHocScopeManifest["scope"]["loader"]["capacities"];
    private readonly footprint: [number, number];
    private readonly stacking: string;
    private readonly refuse: IHocScopeManifest["scope"]["loader"]["refuse"];
    private readonly fightRefused: Array<[string, string | undefined]>;
    private readonly templateVerdicts = new Map<string, string | null>();
    private readonly templateAuras = new Map<string, string[]>();

    /** `policy`: the policy every request on this root names (its extra scope applies); null = the loader alone. */
    public constructor(
        public readonly manifest: IHocScopeManifest,
        public readonly policy: string | null,
        private readonly strict = false,
    ) {
        const l = manifest.scope.loader;
        this.abilities = new Set(l.abilities);
        this.auras = new Set(l.auraEffects);
        this.applied = new Set(l.applied);
        this.spells = new Set(l.spells);
        this.prefixes = new Set(l.spellEntryPrefixes);
        this.factions = new Set(l.spellFactions);
        this.summons = new Set(l.summons);
        this.unitTypes = new Set(l.unitTypes);
        this.teams = new Set(l.teams);
        this.gridTypes = new Set(l.gridTypes);
        this.cap = l.capacities;
        this.footprint = l.footprint;
        this.stacking = l.stackingEffect;
        this.refuse = l.refuse;
        this.storedBuffs = new Set(l.storedPropertyBuffs);
        this.artifactTiers = [new Set(l.artifacts.tier1), new Set(l.artifacts.tier2)];
        this.artifactRowBuffs = new Set(l.artifactRows.buffs);
        this.artifactRowDebuffs = new Set(l.artifactRows.debuffs);
        this.limitedProps = Object.entries(l.refuse.unitPropsLimited).map(([key, names]) => [key, new Set(names)]);
        this.fieldParts = l.refuse.unitFieldParts.map((path) => {
            const dot = path.indexOf(".");
            return [path.slice(0, dot), path.slice(dot + 1)];
        });
        this.fightRefused = l.refuse.fight.map((path) => {
            const dot = path.indexOf(".");
            return dot < 0 ? [path, undefined] : [path.slice(0, dot), path.slice(dot + 1)];
        });
        const p = policy === null ? undefined : manifest.scope.policies[policy];
        if (policy !== null && !p) throw new Error(`scope manifest has no policy ${policy}`);
        this.castable = p?.castable ? new Set(p.castable) : null;
        this.refusedAbilities = new Set(p?.refusedAbilities ?? []);
        this.refusedDebuffs = new Set(p?.refusedDebuffs ?? []);
        this.refusedEffects = new Set(p?.refusedEffects ?? []);
        this.refusedBuffs = new Set(p?.refusedBuffs ?? []);
        this.refusedRevived = p?.refusedRevived ?? false;
        this.refusedArtifactRows = p?.refusedArtifactRows ?? false;
        this.refusedSmoke = p?.refusedSmoke ?? false;
        this.refusedFireWalls = p?.refusedFireWalls ?? false;
    }

    /** null when the library would load the root and accept a request for the policy; else the first reason found. */
    public refusal(ctx: IHocPrecheckContext): string | null {
        const fp = ctx.fightProperties;
        const grid = ctx.grid;
        // ---- grid and fight ----
        const gridType = grid.gridType ?? grid.getGridType?.();
        if (!this.gridTypes.has(gridType)) return `grid type ${gridType}`;
        for (const key of this.refuse.grid) if (!exportsEmpty(grid[key])) return key;
        if ((grid.scatteredMountainLayout?.length ?? 0) > this.cap.stones) return "stones";
        if ((grid.artifactBarrels?.size ?? 0) > this.cap.barrels) return "barrels";
        const lap = fp.currentLap ?? fp.getCurrentLap?.();
        if (!(lap >= 0 && lap <= this.cap.lap)) return `lap ${lap}`;
        for (const [key, inner] of this.fightRefused) {
            const v = fp[key];
            if (!exportsEmpty(inner === undefined ? v : v?.[inner])) return inner ? `${key}.${inner}` : key;
        }
        for (let tier = 0; tier < this.refuse.artifactsPerTeam.length; tier++) {
            const m = fp[this.refuse.artifactsPerTeam[tier]];
            if (m instanceof Map) {
                const ids = this.artifactTiers[tier];
                for (const v of m.values()) if (!ids?.has(v)) return `Tier-${tier + 1} artifact ${v}`;
            } else if (!exportsEmpty(m) && !(m && typeof m === "object")) return "artifacts";
        }
        if ((fp.vines?.vines?.size ?? 0) > this.cap.vines) return "vines";
        const smoked: number = fp.smokeClouds?.clouds?.size ?? 0;
        if (smoked > this.cap.smoke) return "smoke";
        if (this.refusedSmoke && smoked > 0) return `${this.policy}: smoke clouds`;
        const burning: number = fp.fireWalls?.walls?.size ?? 0;
        if (burning > this.cap.fireWalls) return "fire walls";
        if (this.refusedFireWalls && burning > 0) return `${this.policy}: fire walls`;

        // ---- units ----
        const units: Map<string, any> = ctx.unitsHolder.getAllUnits();
        if (units.size > this.cap.units) return `${units.size} units`;
        let ids = units.size;
        for (const key of ["alreadyMadeTurn", "alreadyHourglass", "alreadyRepliedAttack"]) ids += fp[key]?.size ?? 0;
        for (const key of ["upNextQueue", "hourglassQueue", "moralePlusQueue", "moraleMinusQueue"])
            ids += fp[key]?.length ?? 0;
        ids += 2 * units.size; // the AI target memory and the forbidden targets name at most these
        if (ids > this.cap.ids) return "unit ids";
        let infest = false;
        let spellSummons = false;
        let auraNames: string[] | undefined;
        for (const u of units.values()) {
            const props = u.unitProperties;
            const name: string = props.name;
            if (!this.unitTypes.has(u.unitType)) return `${name}: unit type ${u.unitType}`;
            if (!this.teams.has(u.teamType)) return `${name}: team ${u.teamType}`;
            if (u.summoned && !this.summons.has(name)) return `summoned ${name}`;
            const fw = props.footprint_width;
            const fh = props.footprint_height;
            if (!(
                fw >= this.footprint[0] &&
                fw <= this.footprint[1] &&
                fh >= this.footprint[0] &&
                fh <= this.footprint[1]
            ))
                return `${name}: footprint ${fw}x${fh}`;
            // the ACTIVE abilities (raw field: getAbilities() hides a Broken unit's)
            const active: any[] = u.abilities;
            if (active.length > this.cap.abilities) return `${name}: ${active.length} abilities`;
            for (const a of active) {
                const ap = a.abilityProperties;
                const n: string = ap.name;
                if (!this.abilities.has(n)) return `ability ${n}`;
                if (this.refusedAbilities.has(n)) return `${this.policy}: ability ${n}`;
                const aura = ap.aura_effect;
                if (aura) {
                    if (!this.auras.has(aura)) return `aura ${aura}`;
                    if (!(auraNames ??= []).includes(aura)) auraNames.push(aura);
                }
                if (n === "Infest") infest = true;
            }
            const stolen: string[] | undefined = props.stolen_abilities;
            if (stolen && stolen.length) {
                if (stolen.length > this.cap.stolen) return `${name}: ${stolen.length} stolen abilities`;
                for (const n of stolen) if (!this.abilities.has(n)) return `stolen ${n}`;
            }
            const cards: string[] = props.abilities;
            if (!infest && cards.length) for (const n of cards) if (n === "Infest") infest = true;
            const emitted: string[] | undefined = props.aura_effects;
            if (emitted && emitted.length) {
                if (emitted.length > this.cap.unitAuras) return `${name}: ${emitted.length} auras`;
                for (const n of emitted) {
                    if (!this.auras.has(n)) return `aura ${n}`;
                    if (!(auraNames ??= []).includes(n)) auraNames.push(n);
                }
            }
            // applied rows
            const buffs: string[] = props.applied_buffs;
            if (buffs.length > this.cap.buffs) return `${name}: ${buffs.length} buffs`;
            if (this.refusedRevived && buffs.length > (u.buffs?.length ?? 0))
                return `${this.policy}: ${name} was revived`;
            for (const n of buffs) {
                if (!this.applied.has(n)) return `buff ${n}`;
                if (this.refusedBuffs.has(n)) return `${this.policy}: buff ${n}`;
                if (this.refusedArtifactRows && this.artifactRowBuffs.has(n))
                    return `${this.policy}: artifact row ${n}`;
            }
            const debuffs: string[] = props.applied_debuffs;
            if (debuffs.length > this.cap.debuffs) return `${name}: ${debuffs.length} debuffs`;
            for (const n of debuffs) {
                if (!this.applied.has(n)) return `debuff ${n}`;
                if (this.refusedDebuffs.has(n)) return `${this.policy}: debuff ${n}`;
                if (this.refusedArtifactRows && this.artifactRowDebuffs.has(n))
                    return `${this.policy}: artifact row ${n}`;
            }
            const effects: string[] = props.applied_effects;
            if (effects.length > this.cap.effects) return `${name}: ${effects.length} effects`;
            if (effects.length) {
                for (const n of effects) {
                    if (!this.applied.has(n)) return `effect ${n}`;
                    if (this.refusedEffects.has(n)) return `${this.policy}: effect ${n}`;
                }
                const stacks: unknown = props.applied_effects_stacks;
                if (Array.isArray(stacks)) {
                    for (let i = 0; i < stacks.length; i++) {
                        if (stacks[i] !== 1 && effects[i] !== this.stacking) return `${name}: effect stacks`;
                    }
                }
                for (const e of u.effects as any[]) {
                    const ep = e.effectProperties;
                    if (ep.name !== this.stacking && ep.stacks !== undefined && ep.stacks !== 1)
                        return `${name}: ${ep.name} stacks`;
                }
            }
            // the stored properties of aura, augment and artifact rows (an integer 0..127 or undefined)
            if (buffs.length) {
                for (const b of u.buffs as any[]) {
                    if (b.lapsRemaining !== MAX_SAFE && !this.storedBuffs.has(b.name)) continue;
                    if (!this.storedOk(b.firstSpellProperty) || !this.storedOk(b.secondSpellProperty))
                        return `${name}: ${b.name} stored property`;
                }
            }
            if (debuffs.length) {
                for (const b of u.debuffs as any[]) {
                    if (b.lapsRemaining !== MAX_SAFE) continue;
                    if (!this.storedOk(b.firstSpellProperty) || !this.storedOk(b.secondSpellProperty))
                        return `${name}: ${b.name} stored property`;
                }
            }
            // the spellbook: raw entries and parsed Spell objects
            const entries: string[] | undefined = props.spells;
            if (entries && entries.length) {
                if (entries.length > this.cap.spellEntries) return `${name}: ${entries.length} spell entries`;
                for (const entry of entries) {
                    const colon = entry.indexOf(":");
                    const spell = colon < 0 ? entry : entry.slice(colon + 1);
                    if (colon < 0 || !this.prefixes.has(entry.slice(0, colon)) || !this.spells.has(spell))
                        return `spell ${entry}`;
                    if (this.castable && !this.castable.has(spell)) return `${this.policy}: spell ${spell}`;
                    if (spell.startsWith("Summon ")) spellSummons = true;
                }
            }
            const book: any[] = u.spells;
            if (book.length) {
                if (book.length > this.cap.spells) return `${name}: ${book.length} spells`;
                for (const s of book) {
                    const sp = s.spellProperties;
                    if (!this.spells.has(sp.name)) return `spell ${sp.name}`;
                    if (this.castable && !this.castable.has(sp.name)) return `${this.policy}: spell ${sp.name}`;
                    if (Number.isInteger(sp.faction) && !this.factions.has(sp.faction))
                        return `spell ${sp.name} of faction ${sp.faction}`;
                }
            }
            if (u.summoned && SPELL_SUMMONS.includes(name)) spellSummons = true;
            // unported state
            for (const [key, accepted] of this.limitedProps) {
                const list: unknown = props[key];
                if (Array.isArray(list)) {
                    for (const n of list) if (!accepted.has(n)) return `${name}: ${key} ${n}`;
                } else if (list !== undefined && list !== null) return `${name}: ${key}`;
            }
            for (const key of this.refuse.unitProps) if (!exportsEmpty(props[key])) return `${name}: ${key}`;
            for (const key of this.refuse.unitFields) if (!exportsEmpty(u[key])) return `${name}: ${key}`;
            for (const [key, part] of this.fieldParts) {
                const v = u[key];
                if (v !== undefined && v !== null && v[part] !== undefined && v[part] !== null)
                    return `${name}: ${key}.${part}`;
            }
            if (this.strict) {
                for (const key of Object.keys(props)) {
                    if (
                        key.endsWith(this.refuse.unitPropSuffix) &&
                        !this.refuse.unitPropSuffixKept.includes(key) &&
                        !exportsEmpty(props[key])
                    )
                        return `${name}: ${key}`;
                }
            } else {
                for (const key of AUTHORITATIVE_PROPS) if (props[key]) return `${name}: ${key}`;
            }
            const target: string | undefined = props.target;
            if (target && !units.has(target)) return `${name}: target left the battle`;
            if ((u.possibleAttackTypes?.length ?? 0) > this.cap.possibleAttackTypes) return `${name}: attack types`;
        }
        // ---- the summon templates the export carries (createUnitFromSpec's fresh units) ----
        if (infest || spellSummons) {
            for (const creature of [...(infest ? INFEST_SUMMONS : []), ...(spellSummons ? SPELL_SUMMONS : [])]) {
                const why = this.templateRefusal(creature, ctx.grid);
                if (why) return why;
                for (const n of this.templateAuras.get(creature) ?? [])
                    if (!(auraNames ??= []).includes(n)) auraNames.push(n);
            }
        }
        if (auraNames && auraNames.length > this.cap.auraDefs) return `${auraNames.length} aura effects`;
        return null;
    }

    private storedOk(v: unknown): boolean {
        return (
            v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= this.cap.storedProperty)
        );
    }

    /** A summon template's abilities, auras and spells against the scope (once per creature and process). */
    private templateRefusal(creature: string, grid: any): string | null {
        const known = this.templateVerdicts.get(creature);
        if (known !== undefined) return known;
        let verdict: string | null = null;
        const auras: string[] = [];
        // The template is a throwaway unit, and building it takes a value of the deterministic UUID sequence: the search
        // goes on from this state, and the server names its summons from that sequence (unit ids seed the rollouts).
        const random = captureDeterministicRandomState();
        try {
            const { abilityFactory, effectFactory } = createCombatFactories();
            const unit: any = createUnitFromSpec(
                { faction: "Nature", creatureName: creature, level: 0, size: 0, amount: 1 },
                2,
                grid.getSettings(),
                abilityFactory,
                effectFactory,
                true,
                "00000000-0000-5000-8000-000000000000",
            );
            // engine.loadSummons: the template's card list is its active list; its aura links and auras are interned
            // into the battle. v08Scope reads only the holder, and a summon raises no card outside batches 1-4, so the
            // policy's extra refusals do not apply to a template.
            const props = unit.getUnitProperties();
            if (props.abilities.length > this.cap.abilities) verdict ??= `summon ${creature}: abilities`;
            for (const n of props.abilities as string[]) if (!this.abilities.has(n)) verdict ??= `summon ability ${n}`;
            for (const a of unit.abilities as any[]) {
                const aura = a.abilityProperties.aura_effect;
                if (aura) {
                    if (!this.auras.has(aura)) verdict ??= `summon aura ${aura}`;
                    auras.push(aura);
                }
            }
            for (const n of props.aura_effects ?? []) {
                if (!this.auras.has(n)) verdict ??= `summon aura ${n}`;
                auras.push(n);
            }
            if ((props.spells ?? []).length > this.cap.spellEntries) verdict ??= `summon ${creature}: spell entries`;
            for (const entry of props.spells ?? []) {
                const colon = entry.indexOf(":");
                if (colon < 0 || !this.prefixes.has(entry.slice(0, colon)) || !this.spells.has(entry.slice(colon + 1)))
                    verdict ??= `summon spell ${entry}`;
            }
        } catch (e) {
            verdict = `summon template ${creature}: ${(e as Error).message}`;
        } finally {
            restoreDeterministicRandomState(random);
        }
        this.templateVerdicts.set(creature, verdict);
        this.templateAuras.set(creature, auras);
        return verdict;
    }
}

/** The pre-check for `policy` ("v0.8", "v0.1"; null = the loader alone) from the library's manifest. */
export function compileHocPrecheck(
    manifest: IHocScopeManifest,
    policy: string | null = manifest.policy,
    strict = false,
): HocPrecheck {
    return new HocPrecheck(manifest, policy, strict);
}
