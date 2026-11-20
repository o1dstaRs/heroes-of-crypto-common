/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { isA19DeliveryMelee } from "./a19_revealed_ranged_draft";
import { PBTypes } from "../../generated/protobuf/v1/types";

/**
 * Striker matchup draft: which striker to take depends on who it will face.
 *
 * A striker army plays one of two games. Against an army that is not itself melee it rushes (see
 * a19_striker_rush.ts), and speed decides. Against another striker army nobody rushes, and the units that carry
 * a brawl are different ones. Every striker therefore has two measured values, and the draft weighs them by the
 * probability that the opponent ends with a melee army, judged from the opposing creatures the seat may legally
 * see at that pick. Nothing hidden is read.
 *
 * The numbers are fitted, not designed: read docs/striker_matchup_adoption.md before changing one.
 */
export { A19_STRIKER_MATCHUP_POLICY } from "./a19_striker_matchup_identity";

const C = PBTypes.CreatureVals;

/** Prior probability that an opponent whose picks are still unseen is drafting a melee army. */
export const A19_STRIKER_MATCHUP_MELEE_PRIOR = 0.5;
/** Share of strikers among the picks of a melee drafter and of any other drafter. */
export const A19_STRIKER_MATCHUP_MELEE_STRIKER_RATE = 0.9;
export const A19_STRIKER_MATCHUP_OTHER_STRIKER_RATE = 0.25;
/**
 * The draft's boundary between the two games. Since profile v18 a four-striker army with two shooters is rushed
 * as well; moving this boundary to five with it was tried on development tasks and was not better, so it stays
 * at four.
 */
const MELEE_ARMY_STRIKERS = 4;
const ARMY_SIZE = 6;

/**
 * Match-score points a striker is worth, [in a rush against a non-melee army, against a melee army], relative to
 * the average striker of its level. Keyed by creature id.
 */
export const A19_STRIKER_MATCHUP_VALUES: Readonly<Record<number, readonly [rush: number, melee: number]>> =
    Object.freeze({
        // Level 1
        [C.BERSERKER]: [-0.4, -2.1],
        [C.FAIRY]: [6.8, 4.2],
        [C.LEPRECHAUN]: [0.9, 5.4],
        [C.MERMAID]: [-2.4, -5.4],
        [C.PEASANT]: [3.1, 1.6],
        [C.SCAVENGER]: [1.0, 3.9],
        [C.SQUIRE]: [-1.4, 1.9],
        [C.TROGLODYTE]: [-4.4, 4.2],
        [C.WOLF]: [-4.7, -0.8],
        [C.WOLF_RIDER]: [2.7, -4.9],
        // Level 2
        [C.HARPY]: [4.3, -3.6],
        [C.HYENA]: [-1.4, 0.5],
        [C.MANTICORE]: [1.2, -6.9],
        [C.NOMAD]: [1.9, 2.3],
        [C.PIKEMAN]: [0.5, 5.7],
        [C.TRENT]: [-2.9, 2.9],
        [C.TROLL]: [0.5, -3.5],
        [C.WHITE_TIGER]: [-2.6, -0.2],
        [C.WYVERN]: [7.5, 0.5],
        // Level 3
        [C.CRUSADER]: [0.5, 12.9],
        [C.EFREET]: [-0.8, -6.3],
        [C.GOBLIN_KNIGHT]: [-2.4, 3.3],
        [C.GRIFFIN]: [6.8, -11.1],
        [C.MANTIS]: [2.1, -3.8],
        [C.PEGASUS]: [0.6, 4.2],
        [C.UNICORN]: [-6.8, 0.9],
        // Level 4
        [C.ABOMINATION]: [-11.5, -6.9],
        [C.ANGEL]: [9.3, -8.1],
        [C.ARACHNA_QUEEN]: [-2.5, 12.9],
        [C.BLACK_DRAGON]: [-6.4, -4.0],
        [C.CHAMPION]: [7.0, -1.4],
        [C.FRENZIED_BOAR]: [-3.4, -0.7],
        [C.HYDRA]: [3.0, 14.2],
        [C.THUNDERBIRD]: [4.5, -6.1],
    });

const choose = (n: number, k: number): number => {
    let result = 1;
    for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
    return result;
};

/**
 * Probability that the opponent's finished army has four or more strikers, given the opposing creatures this
 * seat can see. Two kinds of drafter are assumed, one taking strikers nine times in ten and one a quarter of the
 * time; what has been seen updates which kind this is, and the unseen picks follow that kind.
 */
export function a19OpponentMeleeProbability(knownOpponentIds: readonly number[]): number {
    const known = [...new Set(knownOpponentIds)].slice(0, ARMY_SIZE);
    const strikers = known.filter((id) => isA19DeliveryMelee(id)).length;
    const unseen = ARMY_SIZE - known.length;
    const likelihood = (rate: number): number => rate ** strikers * (1 - rate) ** (known.length - strikers);
    const melee = likelihood(A19_STRIKER_MATCHUP_MELEE_STRIKER_RATE) * A19_STRIKER_MATCHUP_MELEE_PRIOR;
    const other = likelihood(A19_STRIKER_MATCHUP_OTHER_STRIKER_RATE) * (1 - A19_STRIKER_MATCHUP_MELEE_PRIOR);
    const posterior = melee + other > 0 ? melee / (melee + other) : A19_STRIKER_MATCHUP_MELEE_PRIOR;
    const reaches = (rate: number): number => {
        let probability = 0;
        for (let more = 0; more <= unseen; more++)
            if (strikers + more >= MELEE_ARMY_STRIKERS)
                probability += choose(unseen, more) * rate ** more * (1 - rate) ** (unseen - more);
        return probability;
    };
    return (
        posterior * reaches(A19_STRIKER_MATCHUP_MELEE_STRIKER_RATE) +
        (1 - posterior) * reaches(A19_STRIKER_MATCHUP_OTHER_STRIKER_RATE)
    );
}

/** A striker's value for this matchup. Creatures without a measured value count as the average striker. */
export function a19StrikerMatchupValue(creatureId: number, meleeProbability: number): number {
    const [rush, melee] = A19_STRIKER_MATCHUP_VALUES[creatureId] ?? [0, 0];
    return meleeProbability * melee + (1 - meleeProbability) * rush;
}

const BETTER = 1e-9;

/**
 * The striker on offer with the highest matchup value. `head` is what the striker rush head settled on and is
 * kept unless another striker is strictly better; with no striker on offer the head's choice stands.
 */
export function a19StrikerMatchupCreature(
    head: number,
    available: readonly number[],
    knownOpponentIds: readonly number[],
): number {
    const strikers = available.filter((id) => isA19DeliveryMelee(id)).sort((a, b) => a - b);
    if (!strikers.length) return head;
    const melee = a19OpponentMeleeProbability(knownOpponentIds);
    let best = strikers.includes(head) ? head : strikers[0];
    for (const id of strikers)
        if (a19StrikerMatchupValue(id, melee) > a19StrikerMatchupValue(best, melee) + BETTER) best = id;
    return best;
}

/**
 * Opening bundle: most strikers first, exactly as the striker rush head counts them, then the matchup value of
 * the pair. `head` is kept on a tie.
 */
export function a19StrikerMatchupBundle(
    bundles: readonly (readonly [number, number, number])[],
    head: number,
    knownOpponentIds: readonly number[],
): number {
    if (!bundles.length) return head;
    const melee = a19OpponentMeleeProbability(knownOpponentIds);
    const strikers = (index: number): number[] => bundles[index].slice(0, 2).filter((id) => isA19DeliveryMelee(id));
    const worth = (index: number): number =>
        strikers(index).reduce((sum, id) => sum + a19StrikerMatchupValue(id, melee), 0);
    let best = head;
    for (let index = 0; index < bundles.length; index++) {
        const more = strikers(index).length - strikers(best).length;
        if (more > 0 || (more === 0 && worth(index) > worth(best) + BETTER)) best = index;
    }
    return best;
}
