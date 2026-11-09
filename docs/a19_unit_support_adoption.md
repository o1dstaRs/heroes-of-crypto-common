# User-adopted unit support, 2026-11-09

The user explicitly requested routing the saved Wandering Mage, Satyr and Healer strategies into the actual AI. `a19-unit-support-v1` is that product adoption. It runs with the locked v0.9 draft and compatible v0.8/A19 combat, identified by server revision `a19-neural-r2-placement-v2-unit-support-v1`. It does not activate native v0.9 combat or the separate full-policy research models.

This combined policy has not passed a fresh strength confirmation. Adoption does not rewrite any original failed research gate or turn the component gains into an additive win-rate claim. The historical research helpers, manifests, evidence and reserved channels remain immutable and separate from these production modules.

## Routed behavior

- **Satyr:** after ordinary A19 search and neural correction, summon Wolves before the main level-1 line makes contact; prefer a positive-value Helping Hand on an engaged recipient after accounting for donor cost and caster exposure. Preserve real attacks. Avoid unsafe advance and keep behind the surviving main line when a safer legal action is available. The layer checks actual legal attacks and resolved incoming shots, including barrel interception. It skips AI Driven actors, hidden enemy targets and rollout decisions. Each probe restores the board, RNG, statistics and auxiliary state. Live work shares the existing 1,000 ms decision deadline; exhausted or failed probes retain the completed A19 action.
- **Healer:** consider halves when two useful own recipients exist and each half retains estimated power three against the largest own experience stack; otherwise consider two single-body buff children when capacity and recipients permit, or one single-body child. The dispatcher uses only the own roster; it cannot guarantee power against a larger hidden enemy stack. This dispatcher is a new heuristic over the saved alternatives, not a fitted model. Position Healers in separated legal rear cells. The losing Healer combat reranker is not enabled.
- **Wandering Mage:** retain or reserve a one-body buff child using already funded stack capacity. Protect the rear while retaining the original flank where possible. Widen only default, nondegraded A19 Mage roots from six to eight search candidates; retain explicit research shortlist overrides and degraded limits. Ordinary spell search still selects Fireforged Sword, Mass Fireball and Smoke according to the position; no unconditional spell preference was added.

The shared setup planner reserves capacity for both Healer and Mage when two slots exist. It never buys Placement, exceeds the existing stack ceiling or splits the same identity again on a retry. These splits belong to bot setup. Premium formation uses the same final support positioning but preserves the human's chosen stack counts and supports Undo. Both native server formations and legal artifact barrels are applied through the existing authoritative action path, with complete rollback on rejection.

The combat factory is shared by authoritative bots, Premium fight decisions, browser sandbox search and default A19 headless combat. Setup and final placement are attached to the authoritative server path. A headless runner that constructs its own opening must explicitly use this setup/final-placement adapter before claiming to measure the full serving policy; merely changing its combat driver is insufficient.

## Original evidence, kept separate

| Component                                      | Fixed study                      | Paired result                                                                   | Qualification                                |
| ---------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| Satyr contact/support                          | 72 boards, 432 fights            | +4.5139 pp over stock A19, whole-board 95% −2.0833 to +11.4583                  | Failed original gate; no fresh confirmation  |
| Healer protected single / halves / two singles | 36 boards, 288 fights            | +9.72 / +10.42 / +11.81 pp; every adjusted interval crossed zero                | Failed original gates; no fresh confirmation |
| Mage one-buff/backline/search8                 | 108 boards, 216 outcomes per arm | +7.17593 pp; ordinary 95% +0.23148 to +14.12037, adjusted −1.15741 to +15.50926 | Failed multiplicity-adjusted gate            |
| Mage flank-preserving rear                     | 54 boards, 108 outcomes per arm  | +5.55556 pp, whole-board 95% −4.62963 to +15.74074                              | Inconclusive                                 |

The Mage production combination uses the one-buff/search8 component and flank-preserving placement together; neither individual study qualifies that combination. See [Satyr evidence](satyr_contact_research.md), [Healer evidence](healer_split_research.md) and [Mage evidence](wandering_mage_research.md) for all alternatives, losses, immutable hashes and excluded seed channels.

Runtime regression checks cover legal split application and conserved army totals, shared slot budgets, both physical seats, exact frozen-rule parity, protected placement and barrel non-overlap, repeated preparation, Premium human-stack preservation and Undo, Satyr state restoration and deadline fallback, and scoped Mage shortlist selection. These are correctness checks, not new independent strength games.

Rollback retains the preceding published common/server/client pins. Combat research may independently disable `SEARCH_A19_SATYR_CONTACT_SUPPORT` or `SEARCH_A19_WANDERING_MAGE_SUPPORT` through the explicit A19 environment override; these switches do not change the new setup adapter. Historical Premium snapshots remain evidence of their recorded source and are not relabeled or regenerated by this adoption.
