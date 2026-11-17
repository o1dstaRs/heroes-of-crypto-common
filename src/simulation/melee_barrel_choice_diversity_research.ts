/** Offline research only; no serving profile imports this shortlist selector. */
export const MELEE_BARREL_CHOICE_DIVERSITY_RESEARCH_ID = "melee-barrel-choice-diversity-v1";

export interface IBarrelChoiceCandidate {
    readonly actions: readonly { readonly type: string; readonly spellName?: string }[];
    readonly features?: { readonly expectedDamage?: number };
}

export function reserveChoiceDiversity<T extends IBarrelChoiceCandidate>(
    candidates: readonly T[],
    retained: readonly T[],
    leaf: readonly number[],
): readonly T[] {
    if (candidates.length !== leaf.length || retained.length < 3) return retained;
    const pure = (candidate: T, type: string) => candidate.actions.length === 1 && candidate.actions[0].type === type;
    const score = (candidate: T) => leaf[candidates.indexOf(candidate)];
    const best = (type: string) =>
        candidates
            .slice(1)
            .filter((candidate) => pure(candidate, type) && Number.isFinite(score(candidate)))
            .sort((a, b) => score(b) - score(a) || candidates.indexOf(a) - candidates.indexOf(b))[0];
    let result = [...retained];
    for (const type of ["move_unit", "wait_turn"]) {
        if (result.some((candidate) => pure(candidate, type))) continue;
        const desired = best(type);
        if (!desired) continue;
        const spellKey = (candidate: T) => {
            if (!pure(candidate, "cast_spell") || (candidate.features?.expectedDamage ?? 0) > 0) return undefined;
            const name = candidate.actions[0].spellName;
            if (["Vine Throw", "Resurrection", "Resurrect"].includes(name as string)) return undefined;
            return name;
        };
        const counts = new Map<string, number>();
        for (const candidate of result.slice(1)) {
            const key = spellKey(candidate);
            if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let replace = -1;
        for (let index = 1; index < result.length; index += 1) {
            const key = spellKey(result[index]);
            if (!key || (counts.get(key) ?? 0) < 2 || !Number.isFinite(score(result[index]))) continue;
            if (replace < 0 || score(result[index]) <= score(result[replace])) replace = index;
        }
        if (replace >= 0) result[replace] = desired;
    }
    return result.every((candidate, index) => candidate === retained[index]) ? retained : result;
}
