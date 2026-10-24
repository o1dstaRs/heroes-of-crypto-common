# Mage Fireball priority — 2026-10-24

Neither runtime passed the registered strength gate. Keep the proposed lethal-spell exception to the
Mage's Smoke priority disabled. Correctness examples do not establish a win-rate improvement.

## Completed strength screens

Each runtime used 630 independent pairs of armies, played twice with identical armies and combat seed
while the candidate changed physical sides. Wins score 1, draws 0.5 and losses 0. The intervals resample
whole paired scenarios within the nine registered composition/map cells. The two runtime hypotheses
use the tightened 97.5% intervals and exact sign-flip p <= 0.025 gate.

| Search settings | Fights | Wins / losses / draws | Candidate score | Clustered 97.5% interval | Sign-flip p | Rejected actions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Current ranked server | 1,260 | 626 / 615 / 19 | 50.44% | 48.89–51.98% | 0.5653 | 2 |
| Native sandbox | 1,260 | 618 / 624 / 18 | 49.76% | 48.21–51.31% | 0.7734 | 0 |

Both intervals include parity. These results do not establish either an improvement or a regression.
Neither screen qualifies for its fresh 6,300-fight confirmation stage; no confirmation games were run.
No favorable map or composition subgroup rescues a failed overall screen.

The population forces a Wandering Mage into each six-stack army and varies the remaining slots using
the canonical roster generator. Stack amounts use the live 1,000-experience budget. Native placements,
funded setup, synergies and current live artifact pools are shared by the two arms. Melee-focused,
mixed and shooter-heavy armies cross Normal, Lava and Block maps in equal numbers. There were 1,254
distinct ordered armies in the ranked screen and 1,255 in the sandbox screen. These are controlled Mage
combat populations, not estimates of ranked draft strength or win rate against human players.

## What was reproduced

Wandering Mage already has a working Fireball candidate and damage-spell policy. Fireball requires
stack power 3. Tests cover the full native book, cluster targeting, actual damage and charge consumption,
friendly fire, depleted charges and the engine's rejection below the power requirement.

The Smoke router's existing kill exception recognizes weapon attacks. The proposed exception also
recognizes an immediately lethal damage spell, including fire magic bypassing Water Shield. A real
AIController/search/engine test reproduces native sandbox choosing Smoke on a board where Fireball kills
the shooter, and the experimental rule choosing Fireball instead. Both branches remain covered.

Sandbox and ranked do not currently use identical search settings: the server adds material tie
arbitration. They were therefore measured separately. In the complete sandbox screen, the control's
Mages cast Fireball 1,002 times and the candidate's cast it 997 times. Casting capability is present;
changing this particular priority did not demonstrate greater strength.

## Validation and limitations

- Both runtime A/A checks completed 72 fights with exactly 50% score, identical paired action streams
  and zero rejections.
- All 18 portability fights matched between the two Linux hosts. All 18 sandbox pilot fights matched
  between macOS and Linux. The sandbox's exact offline selection-bound optimizations also matched
  the unoptimized sandbox pilot on all 18 fights.
- The sandbox strength screen combined two complete, disjoint 315-pair shards. Source, runner,
  protocol and effective profile hashes matched. Their union contains every pair ID 0–629 exactly
  once. No partial or selected shard results were used for inference.
- The canonical `pairedAuditEvidence` independently reproduced each screen's mean and exact p-value.
- Ranked pair 95 produced one rejected Magic Dragon `obstacle_attack` in each physical assignment
  (`attack_not_available`). The two accepted trajectories were identical. A replay with full rejection
  details reproduced both original outcomes and action streams. The pair stays in the analysis and
  also fails the registered zero-rejection health gate; this is separate from Mage spell selection.
- The ranked screen's first logger omitted named spell telemetry. Empty spell-count objects are missing
  data, not zero casts. A corrected 18-fight replay preserved every original action field and outcome;
  named cast counts are reported only for the fully instrumented sandbox screen. The primary ranked
  outcomes and rejection counts were recorded throughout.
- Initial logging/setup attempts and the incomplete, unsharded sandbox launch were retained as
  excluded runs. The complete registered sample was rerun in its fixed balanced shards. No strength
  outcomes were used to choose the partition, change a rule, change seeds or extend a sample.

## Reproducibility and disposition

Frozen common source: `ab162d2768ee73ee3b7829e3e4a4592104d71073`, with the research-only physical-team
toggle around the damage-spell kill predicate. Engine and spell rules are identical between arms.
Frozen source SHA-256:
`c38bebf008f69e86f9e4901ecb5a1aa3c606279c0e60e2933725775902943e40`.
All runs used Bun 1.4.4. The 9800X3D used eight workers; macOS used twelve. Puffalo supplied the
independent portability and rejection replays. Deterministic H64/R4 search prevents host timing from
changing the comparison.

Protocols: [ranked](PROTOCOL.md), [sandbox](SANDBOX_PROTOCOL.md). Frozen sources, runner versions,
manifests, per-pair records, strict analyses, canonical statistical audits, telemetry checks and excluded
attempts remain outside Git in the client workspace's `game/core/tmp/mage-fireball-study-20261024` and
`game/core/tmp/mage-fireball-sandbox-study-20261024`, with corresponding research-host copies.

The shipped profile explicitly keeps `V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT` and
`V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT` at `0`. The candidate is available only for explicit research.
No production deployment or activation is part of this study.
