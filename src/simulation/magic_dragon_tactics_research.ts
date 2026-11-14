/** Synchronous, explicitly scoped research. Importing this module never activates a default policy. */
import type { IEnumeratedCandidate, IEnumerateOptions } from "../ai/candidates";
import { planA19SupportSplits } from "../ai/support_setup";
import type { A19SupportSplitPlan } from "../ai/healer_support_setup";
import type { ITacticalSplitUnit, ITacticalSplitPlacementUnit } from "../ai/tactical_split_placement";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { GameAction } from "../engine/actions";
import { getFootprintCellsForAnchor } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { SearchDriver } from "./search_driver";

export const MAGIC_DRAGON_RESEARCH_ID = "magic-dragon-tactics-v1";
export const DRAGON_SPELLS = ["Whirlpool", "Lightning Strike", "Ring of Fire", "Meteor Shower"] as const;
export type DragonSpell = (typeof DRAGON_SPELLS)[number];
export type DragonSplit = "none" | "half" | "single" | "control-pair";
export interface DragonTactic {
    id: string;
    meteorCoverage: boolean;
    spellDiversity: boolean;
    rear: boolean;
    split: DragonSplit;
    forceFirstSpell?: DragonSpell;
}
const tactic = (id: string, extra: Partial<DragonTactic> = {}): Readonly<DragonTactic> =>
    Object.freeze({ id, meteorCoverage: false, spellDiversity: false, rear: false, split: "none", ...extra });
export const MAGIC_DRAGON_TACTICS: readonly Readonly<DragonTactic>[] = Object.freeze([
    tactic("current-a19"),
    tactic("meteor-coverage", { meteorCoverage: true }),
    tactic("spell-diversity", { meteorCoverage: true, spellDiversity: true }),
    ...DRAGON_SPELLS.map((spell, i) =>
        tactic(["whirlpool-first", "lightning-first", "ring-first", "meteor-first"][i], {
            meteorCoverage: true,
            spellDiversity: true,
            forceFirstSpell: spell,
        }),
    ),
    tactic("rear-diversity", { meteorCoverage: true, spellDiversity: true, rear: true }),
    ...(["half", "single", "control-pair"] as const).map((split) =>
        tactic(`${split}-rear`, {
            meteorCoverage: true,
            spellDiversity: true,
            rear: true,
            split,
        }),
    ),
]);

/** Own roster only. Preserve the adopted Healer and Wandering Mage plans; displace at most one generic utility. */
export function planMagicDragonResearchSplits(
    units: readonly ITacticalSplitUnit[],
    maximumStacks: number,
    mode: DragonSplit,
): A19SupportSplitPlan[] {
    const incumbent = planA19SupportSplits(units, maximumStacks);
    if (mode === "none" || !Number.isSafeInteger(maximumStacks)) return incumbent;
    const living = units.filter((u) => u.amount > 0);
    const dragons = living.filter((u) => u.identity === "Magic Dragon:4");
    const dragon = dragons[0];
    if (dragons.length !== 1 || dragon.summoned || !Number.isSafeInteger(dragon.amount) || dragon.amount < 2)
        return incumbent;
    const slots = Math.max(0, Math.min(maximumStacks - living.length, maximumStacks - 6));
    if (!slots) return incumbent;
    const xp = (u: ITacticalSplitUnit) => {
        const id = creatureIdForName(u.identity.split(":")[0]);
        return id === undefined ? 0 : (creatureInfo(id)?.exp ?? 0);
    };
    let amount = mode === "single" ? 1 : Math.floor(dragon.amount / 2);
    if (mode === "control-pair") {
        const reference = Math.max(...living.map((u) => u.amount * xp(u)));
        const dragonXp = xp(dragon);
        if (!(reference > 0 && dragonXp > 0)) return incumbent;
        amount = Math.floor((0.4 * reference) / dragonXp) + 1;
        if (dragon.amount - amount < amount) return incumbent;
    }
    const plans = incumbent.slice();
    if (plans.length >= slots) {
        const protectedIds = new Set(
            living.filter((u) => u.identity === "Healer:2" || u.identity === "Wandering Mage:1").map((u) => u.id),
        );
        let replace = plans.length - 1;
        while (replace >= 0 && protectedIds.has(plans[replace].sourceUnitId)) replace--;
        if (replace < 0) return incumbent;
        plans.splice(replace, 1);
    }
    return [...plans, { sourceUnitId: dragon.id, amount, role: "support" }];
}

export interface DragonPlacementUnit extends ITacticalSplitPlacementUnit {
    readonly name: string;
    readonly amount: number;
}
/** Full legal footprints, own formation only. Failure keeps the complete original formation. */
export function protectMagicDragonResearchPlacement(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly DragonPlacementUnit[],
    context: {
        team: TeamType;
        sideOrientedPlacement: boolean;
        legalCellHashes: ReadonlySet<number>;
    },
): Map<string, XY> {
    const copy = () => new Map([...incumbent].map(([id, c]) => [id, { ...c }]));
    const result = copy(),
        dragons = units
            .filter((u) => u.name === "Magic Dragon" && incumbent.has(u.id))
            .sort((a, b) => b.amount - a.amount || units.indexOf(a) - units.indexOf(b));
    const ids = new Set(dragons.map((u) => u.id)),
        occupied = new Set<number>();
    const key = (c: XY) => (c.x << 4) | c.y;
    const footprint = (u: DragonPlacementUnit, c: XY) =>
        getFootprintCellsForAnchor(c, u.footprintWidth ?? (u.small ? 1 : 2), u.footprintHeight ?? (u.small ? 1 : 2));
    for (const u of units) {
        const c = incumbent.get(u.id);
        if (c && !ids.has(u.id)) for (const part of footprint(u, c)) occupied.add(key(part));
    }
    const depth = (c: XY) => {
        const v = context.sideOrientedPlacement ? c.x : c.y;
        return context.team === PBTypes.TeamVals.LEFT ? v : 15 - v;
    };
    const lateral = (c: XY) => (context.sideOrientedPlacement ? c.y : c.x);
    const placed: XY[] = [];
    for (const dragon of dragons) {
        const candidates = [...context.legalCellHashes]
            .map((h) => ({ x: h >> 4, y: h & 15 }))
            .filter((c) =>
                footprint(dragon, c).every(
                    (part) =>
                        part.x >= 0 &&
                        part.x < 16 &&
                        part.y >= 0 &&
                        part.y < 16 &&
                        context.legalCellHashes.has(key(part)) &&
                        !occupied.has(key(part)),
                ),
            );
        const separation = (c: XY) =>
            placed.length ? Math.min(...placed.map((o) => Math.max(Math.abs(c.x - o.x), Math.abs(c.y - o.y)))) : 0;
        const old = incumbent.get(dragon.id)!;
        candidates.sort(
            (a, b) =>
                depth(a) - depth(b) ||
                separation(b) - separation(a) ||
                Math.abs(lateral(a) - lateral(old)) - Math.abs(lateral(b) - lateral(old)) ||
                a.x - b.x ||
                a.y - b.y,
        );
        const c = candidates[0];
        if (!c) return copy();
        result.set(dragon.id, c);
        placed.push(c);
        for (const part of footprint(dragon, c)) occupied.add(key(part));
    }
    return result;
}

type ResearchDriver = {
    caps: IEnumerateOptions;
    deps: {
        unitsHolder: { getAllUnits(): Map<string, Unit> };
        fightProperties: { hasAlreadyMadeTurn(id: string): boolean };
    };
};
type Shortlist = (
    this: ResearchDriver,
    unit: Unit,
    candidates: readonly IEnumeratedCandidate[],
    seed: number,
    deadline: number | null,
    version: string,
    ...flags: boolean[]
) => readonly IEnumeratedCandidate[];
type Score = (
    this: ResearchDriver,
    unit: Unit,
    candidates: readonly IEnumeratedCandidate[],
    seed: number,
    mode: string,
    ...rest: unknown[]
) => number[];
export interface DragonSearchTrace {
    unitId: string;
    team: TeamType;
    tactic: string;
    candidates: { spell: string | null; targetId?: string; actions: GameAction[]; leafScore: number | null }[];
    originalShortlist: number[];
    selectedShortlist: number[];
    originalDecision: GameAction[];
    chosenDecision: GameAction[];
    forced: boolean;
}
let active = false;

/** Offline worker scope only. All spell choices still receive the ordinary full R2/H64 comparison except the explicit first-cast diagnostic arms. */
export function withMagicDragonResearch<T>(
    team: TeamType | null,
    settings: Readonly<DragonTactic>,
    run: () => T,
    observe?: (t: DragonSearchTrace) => void,
): T {
    if (active) throw new Error("Magic Dragon research cannot be nested");
    if (team !== null && team !== PBTypes.TeamVals.LEFT && team !== PBTypes.TeamVals.RIGHT)
        throw new Error("Magic Dragon research requires a physical team");
    const prototype = SearchDriver.prototype as unknown as { shortlistCandidates: Shortlist; scoreCandidates: Score };
    const choose = SearchDriver.prototype.chooseDecision,
        shortlist = prototype.shortlistCandidates,
        score = prototype.scoreCandidates;
    const attempted = new Set<string>();
    let current: DragonSearchTrace | undefined;
    let currentCandidates: readonly IEnumeratedCandidate[] = [];
    let leafScores: number[] = [];
    const eligible = (unit: Unit, version: string) =>
        team !== null && unit.getTeam() === team && unit.getName() === "Magic Dragon" && version === "v0.8";
    const waterThreat = (driver: ResearchDriver, c: IEnumeratedCandidate) => {
        const target = c.targetId ? driver.deps.unitsHolder.getAllUnits().get(c.targetId) : undefined;
        if (
            !target ||
            target.isDead() ||
            target.isSkippingThisTurn() ||
            driver.deps.fightProperties.hasAlreadyMadeTurn(target.getId())
        )
            return -Infinity;
        return (
            target.getAmountAlive() * Math.max(0, target.getAttackDamageMax()) * (target.getRangeShots() > 0 ? 1.5 : 1)
        );
    };
    const bestSpell = (driver: ResearchDriver, name: DragonSpell) => {
        let best: IEnumeratedCandidate | undefined,
            bestValue = -Infinity;
        for (let i = 0; i < currentCandidates.length; i++) {
            const c = currentCandidates[i];
            if (c.spellName !== name || !Number.isFinite(leafScores[i])) continue;
            const value = name === "Whirlpool" ? waterThreat(driver, c) : leafScores[i];
            if (value > bestValue) {
                best = c;
                bestValue = value;
            }
        }
        return best;
    };
    active = true;
    prototype.scoreCandidates = function (unit, candidates, seed, mode, ...rest) {
        const result = score.call(this, unit, candidates, seed, mode, ...rest);
        if (current && mode === "leaf" && unit.getId() === current.unitId) {
            currentCandidates = candidates;
            leafScores = [...result];
        }
        return result;
    };
    prototype.shortlistCandidates = function (unit, candidates, seed, deadline, version, ...flags) {
        const original = shortlist.call(this, unit, candidates, seed, deadline, version, ...flags);
        if (!current || !eligible(unit, version)) return original;
        currentCandidates = candidates;
        // A small catalog may bypass the leaf pass; score it exactly as the ordinary leaf shortlist does.
        if (leafScores.length !== candidates.length && (settings.spellDiversity || settings.forceFirstSpell))
            leafScores = score.call(this, unit, candidates, seed, "leaf", 1, deadline);
        let result = original;
        if (settings.spellDiversity && original.length >= 2) {
            const required = DRAGON_SPELLS.map((name) => bestSpell(this, name)).filter(
                (c): c is IEnumeratedCandidate => !!c,
            );
            const protectedCandidates = new Set([candidates[0], ...required]);
            const selected = original.slice();
            for (const candidate of required) {
                if (selected.includes(candidate)) continue;
                let replace = selected.length - 1;
                while (replace > 0 && protectedCandidates.has(selected[replace])) replace--;
                if (replace > 0) selected[replace] = candidate;
            }
            result = selected;
        }
        current.candidates = candidates.map((c, i) => ({
            spell: c.spellName ?? null,
            targetId: c.targetId,
            actions: structuredClone(c.actions),
            leafScore: Number.isFinite(leafScores[i]) ? leafScores[i] : null,
        }));
        current.originalShortlist = original.map((c) => candidates.indexOf(c));
        current.selectedShortlist = result.map((c) => candidates.indexOf(c));
        return result;
    };
    SearchDriver.prototype.chooseDecision = function (unit, version, incumbent, context) {
        if (!eligible(unit, version)) return choose.call(this, unit, version, incumbent, context);
        const driver = this as unknown as ResearchDriver,
            oldCaps = driver.caps,
            previous = current;
        const trace: DragonSearchTrace = {
            unitId: unit.getId(),
            team: unit.getTeam(),
            tactic: settings.id,
            candidates: [],
            originalShortlist: [],
            selectedShortlist: [],
            originalDecision: [],
            chosenDecision: [],
            forced: false,
        };
        current = trace;
        currentCandidates = [];
        leafScores = [];
        driver.caps = { ...oldCaps, researchMagicDragonMeteorCoverage: settings.meteorCoverage };
        try {
            let result = choose.call(this, unit, version, incumbent, context);
            trace.originalDecision = structuredClone(result);
            if (settings.forceFirstSpell && !attempted.has(unit.getId())) {
                const proposal = bestSpell(driver, settings.forceFirstSpell);
                if (proposal) {
                    attempted.add(unit.getId());
                    result = proposal.actions;
                    trace.forced = true;
                }
            }
            trace.chosenDecision = structuredClone(result);
            observe?.(trace);
            return result;
        } finally {
            driver.caps = oldCaps;
            current = previous;
        }
    };
    try {
        const result = run();
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Magic Dragon research requires a synchronous callback");
        return result;
    } finally {
        SearchDriver.prototype.chooseDecision = choose;
        prototype.shortlistCandidates = shortlist;
        prototype.scoreCandidates = score;
        active = false;
    }
}
