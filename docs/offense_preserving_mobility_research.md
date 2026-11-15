# Offense-preserving mobility research

The November 15 continuation tests a distinct spending hypothesis after the closed
[Chaos rush study](chaos_rush_research.md). That earlier experiment changed both army selection and
spending, often replacing Sniper with Might. Earlier contact did not establish a stronger policy.

The new candidate keeps the adopted locked-V3/contextual draft, artifacts, offensive augments,
Placement allowance, authoritative native placement/support splits, and A19 combat. It buys Movement
only with existing Armor. For example, Armor 3 / Sniper 3 becomes Armor 2 / Sniper 3 / Movement 1 or
Armor 1 / Sniper 3 / Movement 2. Five-point armies can lose their final Armor points; this real cost is
included, rather than granted free movement. The native formation algorithm can respond to movement;
there is no added forward-deployment override.

Status: **completed without a finalist; no default change**. All 1,684 distinct battles / 4,320 logical
rows finished, and independent input, score and bootstrap reconstruction passed. No qualification or
confirmation bank opened. These fixed candidates are closed; a favorable map or doctrine slice does
not authorize a revised rule on the same data.

## Complete results

The current adopted reference scored 61.419753% on the primary 162-family population: 394 wins,
eight draws and 246 losses across 648 permutations. All four candidate point estimates were lower.

| Fixed candidate              | Score      | Change vs current | Simultaneous 95% interval | 5-point change | 6-point change | 7-point change |
| ---------------------------- | ---------- | ----------------- | ------------------------- | -------------- | -------------- | -------------- |
| Movement 1, preserve offense | 56.867284% | −4.552469 pp      | −8.581220 to −0.523719 pp | −4.861111 pp   | −3.703704 pp   | −5.092593 pp   |
| Movement 2, preserve offense | 59.722222% | −1.697531 pp      | −5.324074 to +1.929012 pp | +1.620370 pp   | −1.620370 pp   | −5.092593 pp   |
| Chaos only, Movement 1       | 59.953704% | −1.466049 pp      | −3.554899 to +0.622801 pp | −1.388889 pp   | −1.388889 pp   | −1.620370 pp   |
| Chaos only, Movement 2       | 60.648148% | −0.771605 pp      | −2.649257 to +1.106047 pp | −0.231481 pp   | −0.925926 pp   | −1.157407 pp   |

The broad Movement 1 rule has a supported negative difference after the four-comparison correction.
The other intervals cross zero; they do not establish either a gain or a general proof that movement
is harmful. None reaches the fixed +1 pp development threshold. The broad Movement 2 rule's positive
five-point slice does not rescue its negative overall, six-point and seven-point means.

Against current, shooter-biased and caster-biased opponents respectively, Movement 2 changed score by
−4.861111, −0.694444 and +0.462963 pp. Chaos-only Movement 2 changed these by −2.314815, 0 and 0 pp.
The pressure population changed by exactly zero because no candidate activated there; this is a
dispatch coverage result, not evidence that rushing beats fast melee.

The spending change did improve the contact mechanism. With broad Movement 2, the proportion reaching
melee contact with a native shooter or damage caster increased from 74.69% to 79.63%; conditional contact
lap decreased from 2.8223 to 2.2791, and enemy backline actions before contact or fight end decreased
from 8.1512 to 6.3966. Final score nevertheless fell. Conditional contact statistics and action counts
depend on survival and fight duration, so they cannot identify Armor loss or changed native geometry
as the sole cause. Preserving Sniper alone was insufficient to make this fixed spending trade a win.

The complete source, raw inputs, independent verifiers and standalone HTML report are retained in the
ignored capsule. All 5,155 frozen files and transported raw-file hashes matched; all games had zero
rejected actions or neural errors. A separate direct-sampling implementation reproduced the registered
bootstrap intervals. The report passed 96 filter combinations. Repository validation passed 13,979
tests plus lint and type checks. Research evidence is not inserted into Premium or deployed as a default.

## Frozen candidate and comparison

The offline helper is `src/simulation/offense_preserving_mobility_research.ts`. Its four fixed recipes
target Movement 1 or 2, either whenever eligible or only with an active public Chaos Movement synergy.
All require complete public Setup, at least two distinct own pure-melee types, at least two distinct
enemy native shooter types, and more shooter types than direct-damage caster types. A duplicate stack
does not supply another type. Private Setup, insufficient Armor, incomplete spending, or an already
purchased movement level retains the incumbent. Enemy positions, augments, split sizes and hidden draft
information are not inputs. Physical engagement stops ordinary shooting; it does not silence damage spells.

Each candidate independently rebuilds its native opening. Offensive points, Placement, unit totals,
split bodies, enemy deployment and fixed map terrain match the paired incumbent. Native own deployment
and artifact barrels can change with the purchased movement; barrel cells are audited separately from
fixed map obstacles. Exact-input deduplication is permitted only within the same family/permutation.

Registration `eca22a6fca45e15ff764fb58fc9ccdbb7bfe80b6d5d1fc2c477e6ddaa7ac8078` freezes common
`024cc59c7cb133856b2f594d8c211b2e69ac6cef`, server `4ee0e4ae31788e6e3e206fdd134897ea3b2712f2`, the new
helper overlay, seeded copied server identities and 5,155 source/dependency/harness files. Runtime package
identity checks cover the RNG and FightStateManager. Bun is 1.4.4; both seats use unchanged deterministic
A19 H64/R2/K6 work. The ignored capsule is `game/core/tmp/offense-preserving-mobility-20261115` in the client.

The full unscored census has 216 fresh offer families, 54 each against current, shooter-biased,
damage-caster-biased and fast-pressure drafts. Each style balances three maps and nine doctrine pairs;
each family includes both draft orders and physical seats. It admits 4,320 logical rows / 1,684 distinct
battle inputs. All four recipes pass the prospective coverage requirement in each 5/6/7-point doctrine.
Initial native-plan adaptation incorrectly assumed zero-valued entries were present; that unscored
census and source remain preserved, and the sparse-plan fix preceded registration and any combat.
Three changed cases, one per budget, passed exact cold-process and Mac/Puffalo trace comparison: 24
actual correctness battles in total. These repeats are not extra independent families.

## Fixed decisions and seed reservation

The primary population is the first 162 families (current, shooter, caster, equally weighted). Pressure
is a separate 54-family safety check. Draws score one half. Average all four permutations within each
independent family. Report 20,000 stratified whole-family bootstrap resamples with simultaneous 95%
max-standardized-deviation intervals across all four candidate contrasts, NumPy seed 151126.

At most one unchanged recipe advances from development: at least +1 percentage point against current,
nonnegative means in every own doctrine and against the current opponent, and pressure mean at least
−2 points. Choose highest primary score, then lower Movement, then lexical ID. This is a development
screen, not qualification. No new Placement spending or formation rule exists, so the incumbent also
serves as the matched free control. If every candidate fails, close the study without selecting a
favorable doctrine or weakening the gate. A finalist needs separately registered fresh qualification,
independent confirmation and serving/timing verification within the existing 10% compute constraint.

No qualification or confirmation channels are allocated. The local `reserved-channels.json` reserves
3,456 raw/permuted channels after excluding 11,101,049 prior or reserved channels. Future allocations
must also exclude this study. To reconstruct a conservative reservation without the local capsule,
hash UTF-8 `offense-preserving-mobility-20261115-fresh-development-v1:<counter>` with SHA-256 for counters
1 through 219 inclusive, interpret the first four bytes as an unsigned little-endian preimage, and
reserve each preimage plus offsets 0 through 7 and each corresponding `permuteRankedDraftSeed` value.
This includes the three rejected overlapping preimages as well as all 216 accepted families. Do not
reuse any of these channels for independent evidence.

The separate peer campaign `ranked-geometry-confirm-20261115` is running its own fresh confirmation of
formation and stack allocation. Its 12,312 channels and this study's 3,456 channels are disjoint. It is
not a completed strength result or a replacement baseline. Concurrent published server changes through
`28f71c4b1c6559e456f66bc0f7708aa12cadb7b2` concern authentication tests/dependencies; the authoritative
game, simulation and Premium source is unchanged from this study's server freeze. Preserve each
experiment's identity and let the peer complete its registered comparison.
