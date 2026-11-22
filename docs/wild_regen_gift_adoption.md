# Wild Regeneration gift — adopted as A19 profile v24

Adopted on November 22, 2026 by the owner's explicit decision. Policy id `a19-wild-regen-gift-v1`. Its registered owner
guard failed, and that failure stays recorded. Nothing was deployed by the adoption.

## The misplay

In test game 1a785955 the owner saw both AI Trolls give Wild Regeneration to Fairies, one of them a one-creature
split: "for some reason also troll gave his spell to fairy instead of grifiin for rejuvination". Wild Regeneration is a
one-way gift. Holy Cross lets the caster keep a copy. The holder's top creature is refilled to its max HP at the start
of its turn, and only allies of level 3 or lower may receive it. It is worth about one creature's max HP per turn:
Fairy 7, Harpy 20, Troll 40 (keeping it), Griffin 72. The production caster router does not route the spell. The casts
came from the A19 search's per-ally spell candidates, where rollout noise picks among many near-equal options, and from
the v0.4 native gift, which sorts by stack total HP.

## The rule

`src/ai/wild_regeneration_gift.ts`: the gift goes only to an ally that does not already regenerate and whose creatures
have more max HP than the caster's (any such ally while Holy Cross keeps the caster's card). The candidate generator
(`candidates.ts`) offers only those allies. The v0.4 native gift applies the same filter and prefers the most HP per
creature; for the v0.8 aliases only, so the frozen v0.4-v0.7 strategies keep their rule. Per-seat switch
`A19_WILD_REGEN_GIFT_<LEFT|RIGHT>`, on unless `0`.

## Evidence

Development: 838 paired tasks with an entrant Troll, +1.85 points (95% −0.23 to +3.92), gifts to weaker creatures 335 →
0. Registered confirmation W (`docs/evidence/wild_regen_gift_registration_20261122.json`, sha256 `15861f7f825265f6b376b134bc1ea71f7944d364ab7fc65a2e49bd116823f712`), before any
game of its bank was played: namespace `wild-regen-20261122-v1`, 2,628 fresh tasks audited against 927 ledgers, five
opponent populations drafted with the production recipe; the 1,077 tasks where the entrant fields a Troll were played.
Results: `docs/evidence/wild_regen_gift_confirmation_20261122.json`.

| Population | Tasks | Difference | 95% interval   |
| ---------- | ----: | ---------: | -------------- |
| **All**    |  1077 | **+0.05** | −1.97 to +2.09 |
| mirror  |   228 |      +1.97 | −3.00 to +6.98 |
| owner   |   235 |      −2.34 | −6.28 to +1.54 |
| mixB12  |   207 |      −4.11 | −9.00 to +0.73 |
| mixB34  |   203 |      +6.40 | +2.03 to +10.97 |
| native  |   204 |      −1.47 | −5.42 to +2.46 |

| Gate                                                           | Result     |
| -------------------------------------------------------------- | ---------- |
| W1 non-inferiority: lower bound at least −2 points             | passed     |
| W2 no entrant gift to a creature with no more HP than the caster | passed (526 → 0) |
| W3 owner guard: owner tasks at least −2 points                 | **failed** |
| W4 quality errors not above the control + 2                    | passed     |
| W5 30 candidate tasks reproduce on a second host               | passed     |

**W3 failed and stays recorded as failed.** Do not waive, re-run or relabel it. The owner then chose to adopt the fix as
a behaviour fix: "Sure please do". The standing instruction alone would not have adopted it.

## What the estimate is and is not

- No strength gain is claimed: +0.05 points on fresh tasks. The behaviour change is the reason for the adoption.
- The confirmation ran on the v22 base; with profile v23's deep fit the combination was not measured.
- Only games where the AI fields a Troll can change (about 9% of production drafts).
