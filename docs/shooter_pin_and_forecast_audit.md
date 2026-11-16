# Shooter pin delivery and forecast audit — November 16, 2026

Status: **completed; no serving change and no fresh strength bank opened**. The user asked to continue
improving the adopted V3/contextual-draft plus A19 AI after the closed backliner preservation study.
This continuation tests a distinct attack-position mechanism and audits the source of earlier forecasts.
It does not activate, retune, or replace any closed approach, searched-reply, or geometry policy.

## Same-hit shooter pin prototype

`src/simulation/shooter_pin_delivery_research.ts`, ID `shooter-pin-delivery-v1`, proposes one missing
legal move-and-strike endpoint. It must retain the target, native expected-damage/kill metadata, and
moving/stationary class of an ordinary retained melee alternative, while putting more currently
shootable, not-yet-acted enemies into melee contact. The coarse quantity-times-damage-band weight orders
proposals; it is not a prediction of prevented damage. Contact does not generally suppress spellcasting,
and an enemy can potentially escape before firing.

Only current public combat information is used. The native shooting check handles existing pins,
ammunition, Rangebane, and range-null effects. Hidden enemies are excluded. The helper consumes no RNG,
mutates no battle state, adds no path search, and has no unit-name, doctrine, map, or prior-outcome filter.
The experimental copied caller preserves every ordinary shortlist alternative and special reservation,
then appends at most one extra H64/R2 comparison. All existing role/finish guards remain in force.
The production import graph cannot reach this helper.

Five focused tests verify actual engine acceptance and additional shooting suppression for 1×1, 2×1,
1×2, and 2×2 actors; unchanged state/RNG; no spell-only suppression credit; spent-turn/ammo/hidden/rollout
exclusions; attack-class conservation; and serving isolation. They pass with 1,741 assertions. A later
test-only type correction uses `Object.assign` for fixture steps instead of assigning a readonly view;
the frozen experiment's helper and runtime bytes are unchanged.

Fixed helper SHA-256:
`3da3457fa52a1f989660d5c35733d984a0bf0ce7773140a54e203aa9738a2d48`.
Final test SHA-256:
`7698a049a7a473fa0527b0804574674a33812357de7719416faa08a2e9eb7b40`.

### Completed functional admission

The ignored client capsule is `game/core/tmp/shooter-pin-delivery-20261116`. Registration SHA-256:
`9ba378bc695636ecb6c3392e791d4893e4715a5cf08b46f0eef37c6b1a50931d`.
It freezes common `cb5ee84ab919875777edd66edbdeebfbc6887369`, server
`d90e6bd5aa339be1ad73d1545076bba262f00ba0`, dependencies, native setup and explicit research overlays.
Server/common module identity is asserted. Every arm independently reconstructs its funded native
draft/setup/splits/spellbook/formation/barrels. No shared dependency symlink points at another capsule.

The 54 reused cases were selected mechanically from the completed preservation bank: board index
divisible by four, game index `floor(board / 4) % 4`. Outcomes did not select the cases. All four opponent
styles, three maps, doctrines, and physical seats remain represented. Off, compute-and-discard observer,
and active prototype give **162 full executions**, followed by **nine cold-process replays**.

All 108 off/observer inputs and complete action/event traces reproduce the earlier controls. Cold
inputs, semantic observations and traces are exact. There are zero rejected actions or model/helper
errors. However, only **three** proposals occur, one per map; **zero** enter the full shortlist and
**zero** change a trajectory. The fixed admission required five expanded shortlists and one selected
proposal, so it fails. No development seed was allocated and the proposed 1,728-game bank never opened.
Do not increase this sample, weaken the gate, or turn this into a shooter-only default.

A separate read-only guard audit repeats all three affected cases, nine executions total, preserving
every parent trace and semantic observation. All three proposals belong to Angel and fail the native
**protector-intent** guard. The prospect of pinning an enemy does not by itself establish that abandoning
the friendly screen is worthwhile. That guard remains unchanged. Guard-audit capsule:
`game/core/tmp/shooter-pin-guard-audit-20261116`.

Admission receipt SHA-256:
`b8c4748418f091467d371395bf2033319691457648d82dbffa3575f6125d3ab1`.
Independent guard-audit receipt:
`e6ba1f8d7d8bb3e23129bdab2eeab7bdeb3638a9a58cfc4c9dadcb0e3c91d8a9`.

## Where the earlier forecasts came from

The separate read-only capsule `game/core/tmp/backline-forecast-audit-20261116` uses registration
`1310deaff52955e78e2b87d3e074db79fd3b73d79147efbe64870a3957ba4697`.
It replays **all 18 regressions and all 17 improvements** from the original approach study, both arms:
70 full executions plus six cold replays. These are deliberately outcome-selected historical cases,
not 76 new independent matches or a population calibration sample.

The observer wraps existing rollouts and simulated turns only. It records whether each returned value
came from an exact simulated terminal result or the nonterminal learned leaf, together with the existing
scalar, end state, and simulated turn count. It performs **zero additional rollouts or decisions**.
Every original input, full trace, root, score sequence, candidate order and paired repetition matches.
Independent Python and TypeScript reconstruction agree; all six cold replays match too.

| Existing evaluations at the 35 roots       | Exact terminal | Learned leaf | Total |
| ------------------------------------------ | -------------: | -----------: | ----: |
| Full H64 continuations, both arms          |            678 |           33 |   711 |
| Immediate leaf screening                   |              0 |          519 |   519 |
| Chosen treatment action in 18 regressions  |             33 |            3 |    36 |
| Chosen treatment action in 17 improvements |             34 |            0 |    34 |

In **10 of the 18 regression cases**, both forecasts for the chosen action reach an exact simulated win.
The same is true for 11 of 17 improvements. This argues against treating every bad forecast as a
miscalibrated learned leaf, or treating terminal optimism as a useful standalone rejection rule.
The seven missing full comparisons in regressions, versus two in improvements, remain the earlier
shortlist-competition finding; they are not new strength evidence.

Among the five losses that survived both preservation repairs:

| Actor / historical case | Chosen action's two forecasts   | Original action in the same search |
| ----------------------- | ------------------------------- | ---------------------------------- |
| Harpy, 7/1              | learned 0.999625; terminal win  | learned 0.609147; terminal win     |
| Griffin, 102/3          | terminal loss; learned 0.999137 | terminal loss; learned 0.004295    |
| Peasant, 107/0          | terminal draw; terminal loss    | two terminal losses                |
| Hyena, 130/1            | two terminal wins               | terminal win; terminal loss        |
| Peasant, 176/0          | two terminal wins               | terminal loss; terminal win        |

Real future turns use searched A19, while ordinary simulated future turns use the native policy with
`decisionOrigin: "rollout"`; search is intentionally nonrecursive. Forecasts also use hypothetical chance
streams rather than the actual combat future. The audit distinguishes terminal versus leaf origin. It
does **not** establish which of controller mismatch, chance sampling, subsequent policy interventions,
or another interaction caused each full-game loss. A first changed action is not automatically a bad
action on independent continuations.

Analysis SHA-256:
`2fdf7942230086dbe90af55abf48fa934dfca2ea9e3d8534643ee4d4907a26f4`.
Independent verification SHA-256:
`933c463d8fae03763e4f1af6b32ba2b5c0651027978da90a751fec02d9c60135`.

## Consequences

The complete continuation contains 256 historical full-game executions: 171 prototype admission/cold,
nine guard diagnostics, and 76 forecast audit/cold. It allocates no new random channels, fits no model,
and changes no default, Premium route, deployment, upgrade budget or image. Source and generated
evidence stay in their separate immutable capsules.

A more useful future combat experiment would measure disagreement between native and real-controller
continuations on outcome-independently sampled roots, with matched chance streams, complete candidate
coverage, and restored-state checks. Those diagnostics may support a cheap continuation model or better
action ranking; neither is trained or qualified here. The previously failed two-searched-reply policy
remains closed and must not simply be restarted. Read `a19_searched_reply_research.md` and
`a19_actual_continuation_research.md` first. Representative full-game comparison and fresh independent
confirmation, including the serving compute bound, are still required for any new policy.

The independently confirmed geometry/split planner remains a separate research checkpoint with its
own +2.083333-point result and unresolved serving cost. Its preparation for a faster selector is not a
trained model and is not incorporated into these combat comparisons. Concurrent peer edits to ranged
aiming also postdate this freeze; these diagnostics do not qualify a combination with those edits.
