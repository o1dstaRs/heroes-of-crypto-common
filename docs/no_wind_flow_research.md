# Never casting Wind Flow — failed confirmation T

Studied on 2026-11-23 after the owner's remark: "Valkyrie is also strong to stop flyers sometimes, very situational tho
cause it gives armor". Registered confirmation T failed its strength gate. **Not adopted; the default stays profile
v28.**

## The candidate

Wind Flow is the Valkyrie's spell. Every flyer on the board, own and enemy, gets −4 movement and +4 armor for 3 laps.
The native decision never casts it, but the A19 search generates it as a challenger and sometimes plays it. The
candidate `a19-no-wind-flow-v1` dropped every Wind Flow challenger from the A19 candidate list. Candidate 0, the native
decision, stays.

## Development

In 20 development games with a Valkyrie, the AI cast Wind Flow in 6 and won 1 of those. It won 11 of the 14 games
without a cast, a comparison confounded by game state.

The screen used 914 profile v27 drafts with a forced Valkyrie, against an owner-shaped rush (389) and native shooter
armies (525), in the v27 formation. Never casting gained +2.19 points per task (95% +0.65 to +3.78). Against shooter
armies the gain was +3.71 (+1.90 to +5.81). Against the owner-shaped rush it was +0.13 (−2.31 to +2.57).

## Registered confirmation T

Registration `docs/evidence/no_wind_flow_registration_20261123.json` (sha256
`a51858e6f3c7b5a4d356e4f6d044754f876870b768676be26af308df7d3a5e04`) was written before any confirmation fight. The
formatter may rewrite that file. The registered bytes are `json.dumps(json.load(file), indent=1)` in Python, with no
final newline, and their sha256 is the one above.

**Bank.** Namespace `wind-flow-20261123-v1` with 3,046 fresh families. Each family has one draft root, with maps 1, 3
and 4 and three fights each. Doctrines cycle by family. The entrant drafts as the v28 default (counter draft and
Tier-2 rules included). Both arms use the v28 Valkyrie formation and the decoy rule. The forced populations add a
Valkyrie to the entrant's draft. Only tasks whose entrant fields a Valkyrie can change; the others replay identically.
Those can-change tasks were played, plus 30 parity tasks per population.

**Execution.** Fight tree prod21c14 on the Mac, the x3d host and basenode, with an identical manifest on all three.
Rows were moved between hosts twice for capacity, as logistics only. No bank, arm, setting, tree or analysis changed;
the deviation note is in the capsule. Results are in `docs/evidence/no_wind_flow_confirmation_20261123.json`.

| Population                                   | Tasks | Replayed differently | Won / lost | Difference | 95% interval       |
| -------------------------------------------- | ----: | -------------------: | ---------: | ---------: | ------------------ |
| Forced Valkyrie vs owner-shaped rush (ownF)  |  2229 |                  458 |  +69 / −50 |      +0.81 | −0.11 to +1.79     |
| Forced Valkyrie vs native shooters (nativeF) |  2556 |                  136 |    +4 / −9 |      −0.18 | −0.49 to +0.10     |
| **Primary: ownF + nativeF pooled**           |  4785 |                  594 |  +73 / −59 |  **+0.28** | **−0.19 to +0.77** |
| Natural drafts vs owner-shaped rush (own)    |   639 |                  174 |  +32 / −14 |      +2.82 | +0.72 to +5.10     |
| Natural drafts vs native shooters (native)   |   357 |                   39 |    +3 / −3 |       0.00 | −1.68 to +1.41     |
| Guard: own + native pooled                   |   996 |                  213 |  +35 / −17 |      +1.81 | +0.35 to +3.42     |

The unit is the paired score difference per can-change task, in points. The 95% intervals come from a bootstrap over
draft-root families (20,000 resamples).

Gates:

- **T1 strength failed.** The lower bound of the primary interval must be above 0.
- T2 natural guard passed: at least −8 points.
- T3 quality passed: no quality error in either arm.
- T4 parity passed: 120 of 120 parity tasks replay to the control digest.
- T5 second host passed: 30 of 30 candidate fights on basenode reproduce the main digests. The analysis script's gate
  label says x3d, but basenode is the host the registration names, and the one that played them.

## What it shows

- The development gain against shooter armies did not replicate. It was +3.71 in development and −0.18 on 2,556
  fresh forced tasks. The development screen used the v27 formation, with Valkyrie at the back; T used v28's, with
  Valkyrie among the strikers. Whether the formation explains the difference was not tested.
- Against the owner-shaped rush, dropping Wind Flow gained: +0.81 on forced drafts, and +2.82 (+0.72 to +5.10) on
  natural drafts across 73 families. These are not the primary population. They do not pass T1 and cannot be relabeled
  as the primary result.
- Post-hoc breakdowns of the primary, for description only:
    - By map: map 1 +0.28, map 3 +0.13, map 4 +0.44.
    - By the entrant's doctrine: Scout +0.57, Spymaster −0.15, Battle Trance +0.35.
- Situational follow-up (development only, not registered). The rule kept Wind Flow challengers only while the enemy's
  affected flyers carry more pressure than the caster's own. Pressure is amount × maximum damage × steps, which is
  the legacy v0.6/v0.7 caster router's test. On 677 development tasks with an enemy flyer, compared with never
  casting, it scored +0.30 (95% −0.74 to +1.29), with 41 tasks replayed differently. It plays like never casting and
  is not pursued.

## Rules for this result

- T stays recorded as failed. Do not waive, re-run or relabel T1. Do not adopt the rule on the strength of the
  owner-shaped populations. The bank namespace `wind-flow-20261123-v1` is consumed.
- A new Wind Flow candidate needs a new hypothesis, development on other data, and a fresh bank.
- Not claimed: a win rate against people. The owner's situational use is not modelled: enemy flyers about to dive
  while the caster's own flyers are idle.

The production port was prepared and never applied. It consists of `src/ai/no_wind_flow.ts` and a `candidates.ts` hook
behind `A19_NO_WIND_FLOW_<seat>`. It is kept with the inputs, fight rows and analysis in the ignored client capsule
`game/core/tmp/barrel-strike-necessity-20261119/rush`. The results archive is
`archive/confirmation-T-20261123.tar.gz`, sha256 `701f6bd7a5194507d1c74776fed5333b27fe9b1bbb347eda4f62f20b9e0b326a`.
The x3d and basenode copies of the rows are under `barrel-strike-necessity-20261119/rush10` in each host's research
directory.
