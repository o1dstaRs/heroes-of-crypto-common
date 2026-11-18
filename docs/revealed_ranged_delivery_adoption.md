# Adopted revealed-ranged draft and setup policies

The user explicitly requested “adopt the ones that gave gains please. For sure being draft and setup
aware is the path forward. We will improve from here” on November 18, 2026 UTC. The authoritative
default is now profile v12, `revealed-ranged-exclusive-delivery-v1`, with the wire version still v0.8,
locked V3/contextual drafting and unchanged A19 combat weights/search.

This adopts the two positive component candidates under their original uncertainty. It does not
promote the losing combined arm, reopen confirmation, rewrite failed gates or add the two estimates.
The [original screen](revealed_ranged_delivery_research.md) remains immutable historical evidence.
`lockedRevealedRangedDeliveryCheckpoints()` verifies both evidence files and their frozen sources.

| Original arm | Score difference versus v11 native | Adjusted 95% interval |
| --- | ---: | ---: |
| Draft only | +7.407407 pp | −9.259259 to +24.074074 pp |
| Setup only | +9.259259 pp | −5.555556 to +25.925926 pp |
| Both together | −1.851852 pp | −16.666667 to +12.962963 pp |

These are 27 opportunity-enriched families, 54 seats per arm, not a general win-rate estimate.

## Default dispatch

After the existing V3 and contextual choices, `a19_revealed_ranged_draft.ts` admits the saved mobile
alternatives only against publicly revealed shooter/damage-caster threats. It retains the saved
quality/coherence margins, protection-role exclusions and actual Chaos Movement threshold check.
A known No Fly enemy blocks flight-only alternatives. No concealed enemy identities enter the policy.

The delivery head has its own per-seat, one-use persisted budget. Accepted choices and hidden-pick
collisions consume it atomically. Collision retries, the draft-to-play bridge and session restart
preserve it independently of the V3/contextual budgets. Premium uses the same default decider without
mutating the pick; accepting its delivery suggestion through the normal live pick endpoint or model
match endpoint records the same budget.

**If that seat used the delivery draft override, keep its native setup.** Otherwise public Setup may
use `a19_revealed_ranged_setup.ts`. This mutually exclusive routing is a new explicit operational
choice, not an independently qualified combined gain. Ranked Setup already exposes the full roster;
the early doctrine/collision information matters during drafting.

Eligible setup compares native, free forward placement and funded P0/M1, P0/M2, P1/M0, P1/M1. It
preserves Armor, Might, relevant Empower and at least Sniper 1 for armies with shooters. A paid plan
must improve the fixed hypothetical contact score by at least 0.25 over the best cheaper plan. It
projects actual own fight-start steps through the engine, including synergy, artifact and footprint
rules. Reaching a mage does not disable its damage spells; the proxy is reach, not survival.

The serving preview creates a separate session using own amounts/artifacts/doctrine and the public
roster, with neutral opponent artifacts/doctrine and standard assumed opposing stack amounts. It
uses a stable public game/team seed and restores the live RNG, UUID counter and fight singleton in
`finally`. It executes no battle or persistence callback. The own-only holder prevents opponent
upgrades, deployment and auras from leaking into the projected stats. A failed preview retains native
setup. The chosen fully funded plan and public-input signature survive restart; only a still-matching
plan can apply forward geometry, after the normal/terrain placement layers and before own barrels.

Premium applies the same funded plan; formation preserves the human's existing stacks and supports
undo. Automatic partial human spending, private setup, native v0.9 and explicit rollback/custom
policies retain their existing behavior. `HOC_A19_CONTEXT_POLICY=off` disables these overlays along
with the existing contextual heads. Combat weights and search environment are unchanged.

## Port audit and limits

The adoption evidence fixture records a separate implementation audit on all 54 saved seats:

- All 27 saved draft proposals reproduce the same admissible pool; used budgets and empty public
  reveals disable the override.
- All 54 native openings and 54 draft-only openings match the frozen screen in spending, stack
  counts/splits, spellbooks, positions and own barrels. The guarded dispatcher selects the draft-only
  arm on every one of these deliberately draft-opportunity-enriched cases.
- Setup-only matches 53 of 54 complete saved openings. The serving preview's isolated public seed
  changes `fresh-s12-f003-s1` from P0/M1 to P0/M2. Its other funding and geometry rules are unchanged.
  This difference is retained in the evidence rather than presenting the old setup score as a fresh
  measurement of the port.
- Local preview timings on that audit had a 16.6 ms median and 91.4 ms maximum. These are descriptive
  workstation measurements, not a production latency qualification.
- Focused tests cover Premium ranking/privacy, no live RNG/board mutation, private/partial setup,
  funded formation, restart and undo. Database integration cases cover both physical seats' accepted
  and collided delivery budgets and stale reuse.

There are **no fresh strength outcomes** in this adoption audit. The existing draft-only result is
retained, not counted again as new evidence. The new dispatcher and the setup port still need a
fresh independent outcome comparison against the adopted default before claiming a further gain.

Future research uses v12 as its default comparator and preserves all historical seed exclusions.
Already frozen v11 work retains its original comparator. Authoritative server-based collection uses
the new dispatcher when it carries the persisted draft flag. The existing `premium-ranked-v4` meta
cohort oracle intentionally explores alternative setup choices and is not an exact serving-policy
replay; its existing SQLite evidence is not relabelled or regenerated by this adoption. Client and
server common pins/lockfile must move together. Publication of these commits is separate from deployment.
