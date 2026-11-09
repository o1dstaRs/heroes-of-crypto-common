# Saved Wandering Mage candidates

The user asked to save the promising strategies for reuse after the completed November 8 campaign.
Two named candidates are retained in `src/simulation/wandering_mage_checkpoint.ts`. They are
executable research options, not enabled in the live default. None passed its original progression
gate; saving them does not rewrite that decision. Future changes require a new ID and evidence.

| Strategy ID                                | Exact behavior                                                                                                                           | Paired gain over stock A19 | Ordinary whole-board 95% interval |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: | --------------------------------: |
| `wandering-mage-one-buff-search8-20261108` | Prioritize at least one one-body Mage child in existing funded slots; keep the main stack; rear placement; own Mage root shortlist 6 → 8 |                +7.17593 pp |          +0.23148 to +14.12037 pp |
| `wandering-mage-rear-lateral-20261108`     | Native splits; rear placement preserving each Mage's original flank before separation/center tie breaks; unchanged combat search         |                +5.55556 pp |          −4.62963 to +15.74074 pp |

The first estimate used 108 independent boards and 216 outcomes per arm. Its adjusted interval was
−1.15741 to +15.50926 pp, and its incremental gain over the same protected split setup was only
+0.92593 pp [−2.08333, +3.93519]. The second used 54 different boards and 108 outcomes per arm;
its adjusted interval was −6.94444 to +18.05556 pp. Both failed their three-control gates, including
the accepted A19 full-policy checkpoint. There is no fresh confirmation or qualified runtime budget.
These are prescribed Mage-containing mixed armies against matched opponents, not ranked drafting
or direct candidate-versus-stock tournaments. Do not pool the studies or select winning subgroups.

## Reuse in research

```ts
import { createLockedWanderingMageResearchStrategy } from "./wandering_mage_checkpoint";

const candidate = createLockedWanderingMageResearchStrategy("wandering-mage-one-buff-search8-20261108");
// During native setup: candidate.planSplits(legalOwnUnits, alreadyFundedMaximumStacks).
// After the server's final formation: candidate.place(formation, ownUnits, legalPlacementContext).
// Apply the positions through the native server and generate its barrels afterwards.
// In an isolated synchronous worker: candidate.withSearch(ownTeam, () => runTheMatch()).
```

Use the original full A19 H64/R2 environment and native setup order recorded in the archive.
`withSearch` only widens the chosen team's Mage root search, before neural correction. It restores
the original method and shortlist even on failure, rejects nested scopes and asynchronous callbacks,
and refuses a different base shortlist or another shortlist override. It does not train a model or
force a spell. Importing the module has no activation effect; it is intentionally excluded from
the public game API and default battle-engine import graph. The other saved candidate retains
ordinary search and only changes placement. Preserve the exact helper source SHA in the checkpoint.

The one-child plan is a minimum, not a limit: an incumbent plan already containing two Mage children
is preserved. A competing utility split can lose a funded slot. Never silently combine the two
saved policies into a new untested rule or infer enemy hidden information to choose between them.

## Retained evidence and lessons

`docs/evidence/wandering_mage_20261108.json` preserves all four studies, all arm scores and paired
contrasts, every board's arm scores, source/registration hashes, and all 804 reserved setup/combat
channels including the unopened confirmation. Exclude these channels from future independent work.
The inventory is 270 strength boards, 2,916 logical outcomes, 2,700 newly simulated fights and
216 exact equivalent-case reuses. Correctness fights are separate. No GPU, fit or optimizer step.

The expanded-spell study gained −1.85185 pp [−11.57407, +7.87037]; forced one-body support gained
0 pp [−5.55556, +4.62963]. Their full results remain as counterevidence, not reusable winners.
The support test increased Sword casts from 13 to 87, but 37 of 64 forced choices targeted the
one-body caster itself. Buff-target valuation and actual enemy reach remain open research questions.

One-body children retain independent full-strength Sword charges. Keep enough main-stack power
for Smoke (4) and Fireball (3); casualties and army scale affect eligibility. Rear depth alone does
not measure safety: recentering a protected corner exposed some Mages to flyers and shooters.
Fireball uses the actual intercepted impact cell and can hurt allies. Smoke can obstruct allied
shots too. These mechanics and observed failures do not establish a winning dispatch rule.

The immutable full archive is in the client repository's ignored `game/core/tmp/` as
`wandering-mage-pilot-20261108-verified.tar.gz`, SHA256
`dc9c9eaf59a9159a8ac23656e74297b5ec93625da095ca8f2254a32b25e140b5`.
It includes frozen sources, original runners, all losses, native receipts, complete traces,
registrations, independent statistics and the interactive HTML. Generated bulk output is not tracked.
