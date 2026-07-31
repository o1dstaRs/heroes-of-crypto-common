import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { V07_NONFIGHT_SETUP_ARTIFACT, type INonFightCandidatePolicy } from "../../src/ai/setup/setup_ship";
import { evaluateSetupPair } from "../../src/simulation/optimizer/v0_7_setup_overnight";

const REPLAY_SEEDS = [2147598935, 2147640168, 2147790257, 2147831490] as const;
// Re-pinned after 4a68de8 fixed full-unit HP-cap refreshes and 9845c43 adjusted three creature stats.
// Clean-source isolation showed 4a68de8 alone changed only both traces for seed 2147598935 (whose roster
// contains Behemoth/Unyielding Power), while 9845c43 independently changed roster/combat traces. Two
// exact-9845c43 runs produced this byte-identical digest; this fixture is intentionally balance sensitive.
// Re-pinned again after the lap-start morale-roll fix: applyMoraleRolls now reads each unit's true
// accumulated morale instead of the stale ±20 that a Morale/Dismorale buff locks live morale to. That
// shifts which units proc Morale/Dismorale each lap, so the seeded combat traces legitimately change.
// Re-pinned again after Behemoth's armor -2 (30 -> 28): seed 2147598935's roster fields Behemoth, so its
// combat trace legitimately changes. Two runs on the fixed engine produced this byte-identical digest.
// Re-pinned again after enabling Abomination (catalog id 41): the larger L4 pool shifts every seeded
// roster draw, so all traces legitimately change. Two runs produced this byte-identical digest.
// Re-pinned again after enabling Champion (42) and Frenzied Boar (43) grew the L4 pool to 11 —
// same legitimate roster-draw shift. Two runs produced this byte-identical digest.
// Re-pinned again after enabling Arachna Queen (44) grew the L4 pool to 12 and shifted the same seeded
// roster draws. Two runs produced this byte-identical digest.
// Re-pinned again after raising L4 auto-bans 3 -> 5 (LIVE_AUTO_BANS_BY_LEVEL): banning more of the L4 pool
// shifts the same seeded roster draws. Two runs produced this byte-identical digest.
// Re-pinned after hardening v0.1 melee target legality and preferring enemies that already replied this lap;
// the affected seeded combat actions legitimately change. Two runs produced this byte-identical digest.
// Re-pinned after enabling Dryad expanded the Nature L1 catalog and shifted the deterministic roster draws.
// The full and focused suites independently produced this byte-identical digest.
// Re-pinned after Blacksmith expanded the Life L1 catalog and the hasUnactedTeammate wait gate changed
// eligible seeded combat waits. Two isolated runs produced this digest with zero rejected actions.
// Re-pinned after four stacked changes that each legitimately move the seeded combat traces. Per-commit
// isolation separated them, starting from 905bbcf (the last commit reproducing 8585a28):
//   2e88592  Wounding Charm grants a full-strength Deep Wounds card   8585a28 -> ea81764
//   c642eab  Break lasts two laps                                     ea81764 -> 9f83bc2
//   208ee33  mindless "AI Driven" units pinned to v0.1                9f83bc2 -> caf1913
//   v0.1 mindless units fall through OBSTACLE_ATTACK                  caf1913 -> the value below
// Isolation also confirmed two commits in that range leave this fixture byte-identical: 4efb68b (a13
// shortlist 3 -> 2, a v0.8 search control this v0.7 fixture does not exercise) and 1e2314e (Deep Wounds
// luck counted once). Two isolated runs produced the digest below.
// Re-pinned again after enabling Ash Moth (Chaos L1) grew the L1 draft catalog 15 -> 16. Like every
// previous catalog change, the larger pool shifts the deterministic roster draws, so all seeded traces
// legitimately change. Two isolated runs produced this byte-identical digest.
// Re-pinned again after enabling Zena (Might L2) grew the L2 draft catalog 12 -> 13. Same legitimate
// roster-draw shift as every previous catalog change. Two isolated runs produced this digest.
// Re-pinned again after Zena's kit started actually FIRING in seeded fights: her Chakram now ricochets on
// responses as well as on the initiating shot, and the Rallying Volley aura now reaches ranged allies (its
// power type was missing from the effect_helper whitelist, so it had been inert). Both change combat
// outcomes wherever she is drafted, so every seeded trace legitimately moves. Two isolated runs produced
// this byte-identical digest.
// Re-pinned again after enabling Wyvern (Might L2) and Trent (Nature L2) grew the L2 draft catalog
// 13 -> 15. Same legitimate roster-draw shift as every previous catalog change. The two creatures landed
// in the same working tree, so this is one re-pin covering both. Two isolated runs produced this digest.
// Re-pinned again after enabling Manticore (Chaos L2) grew the L2 draft catalog 15 -> 16. Same legitimate
// roster-draw shift as every previous catalog change. Two isolated runs produced this byte-identical digest.
// Re-pinned again after enabling Monk (Life L3) grew the L3 draft catalog 8 -> 9. Same legitimate
// roster-draw shift as every previous catalog change. Two isolated runs produced this digest.
// Re-pinned again after Battle Mage (55) / Nightmare (56) grew the draft catalogs AND the Venom Cloud Aura's
// poison started stacking (+35% of each further poison), which moves both the roster draws and the combat
// traces. Stacked causes in one shared working tree, so per-change isolation was not possible here.
// Re-pinned again after poison started riding RESPONSES too (both the melee and the counter-shot paths),
// so an aura'd unit now poisons what it strikes back at. That legitimately changes the seeded combat
// traces wherever a poison aura is drafted. Two isolated runs produced this byte-identical digest.
// Re-pinned once more when the creature wave merged with those Zena fixes: both sides had moved this
// fixture independently, so neither branch's value survives the merge. Two isolated runs on the merged
// tree produced this byte-identical digest.
// Re-pinned again after the Armor augment started hardening MAGIC armor by the same percentage it adds
// to physical armor. Every seeded fight where a side buys that augment now resolves magic damage
// differently, so the traces legitimately move. Two isolated runs produced this byte-identical digest.
// Re-pinned after v0.1 stopped emitting the one melee target forbidden by Terrifying Gaze. Clean-source
// isolation changed only seed 2147640168's green candidate (one rejected action became zero); the other
// seven mirrored traces stayed byte-identical before the Armor change above. Two runs on the combined
// latest-main engine produced this byte-identical digest.
// Re-pinned after a dying stack of ONE that still holds its Resurrection charge started raising itself
// instead of being deleted (the raise was floor(died / 2), which is 0 for a single). Any seeded fight where
// a lone holder falls now continues with it alive, so the traces legitimately move. Two isolated runs
// produced this byte-identical digest.
// Re-pinned after Abomination's rebalance from 550 HP / 45 armor to 500 HP / 44 armor. Only seed
// 2147640168 fields Abomination and changes; the other three pair records remain byte-identical. Two
// isolated runs produced this digest.
// Re-pinned on the combined balance tree after Battle Mage's 50-body pricing, Ash Moth's armor nudge, and
// Ring of Fire's target-sparing size-aware footprint landed together. The final union preserves main's
// Mermaid/Wyvern tuning instead of rolling those stats backward. Two shared-tree runs produced this exact
// byte-identical digest.
// Re-pinned after Winged Boots started granting flyers +1 armour alongside their +1 movement: every seeded
// fight with a flyer under the boots takes damage differently, so the traces legitimately move. Two isolated
// runs produced this byte-identical digest.
// Re-pinned after L1/L2 auto-bans went 5 -> 6 (LIVE_AUTO_BANS_BY_LEVEL), the two 16-creature pools. This is
// the mirror image of every catalog growth above — one fewer creature drafted from each pool shifts the same
// deterministic roster draws. Two isolated runs produced this byte-identical digest.
// Re-pinned after the Battle Mage traded armour for health (14/11 -> 26/10). It survives exchanges it used
// to lose, so every seeded trace containing one diverges from that point on — the digest moving is the
// change landing, not a regression. Two isolated runs produced this byte-identical digest.
// Re-pinned after a team's two starting bundles stopped being able to offer the SAME Tier-1 artifact.
// Drawing the pair distinctly consumes the same two RNG values per team but maps the second one through a
// pool of 11 instead of 12, so every seeded draft downstream of it shifts. Two isolated runs produced this
// byte-identical digest.
// Re-pinned after v0.1 primary move-and-strike began executing an explicit move before its stationary melee.
// This resolves Fire Wall, Vine, smoke, moved-state and movement events instead of bypassing that lifecycle;
// two isolated full-trace evaluations reproduced the hash below.
// Re-pinned after the arcane rings joined the draft pool: each Tier-1 artifact is now drawn from 13
// instead of 12 and each Tier-2 offer from a 13-artifact bag, so every seeded draft consumes the shared
// RNG differently. Note this digest matches NEITHER the value main carried nor the one this branch was
// pinned to in isolation -- the ring count and the distinct-Tier-1-pair fix each move the draft on their
// own, so only the combination produces the trace below. Two isolated runs produced this byte-identical
// digest.
// Re-pinned after the Battle Mage's health came down 26 -> 21. It dies to exchanges it used to survive,
// so every seeded trace containing one diverges from that point on. Two isolated runs produced this
// byte-identical digest.
// Re-pinned after the Battle Mage's melee dropped to 2-5 (was 3-6). It trades blows differently, so every
// seeded trace containing one diverges from that point on. Two isolated runs produced this byte-identical
// digest.
// Re-pinned after Crown of Command changed from +1 movement/+5 morale to +1 movement/+8 morale/+1 armor.
// The stronger army-wide artifact legitimately changes seeded setup valuation and downstream combat traces;
// the focused local run and clean Linux CI independently produced this byte-identical digest.
// Re-pinned after the Sniper augment's attack component rose to 8/17/27 (parity with Might):
// augment EV feeds seeded setup valuation, so every trace re-values from the first augment pick.
// Two isolated runs produced this byte-identical digest. (Re-pinned for Battle Mage hp 21 -> 19:
// creature stats feed seeded setup valuation, so every trace re-values from the first roster read.)
// Re-pinned after Arachna Queen hp rose 180 -> 190: the added survivability changes seeded setup
// valuation and downstream combat traces. Re-pinned again after Battle Mage hp fell 19 -> 17, which
// changes the same seeded valuation and exchanges. Two isolated runs produced this byte-identical digest.
// Re-pinned for the Abomination buff (hp 500 -> 550, armor 44 -> 46): the tank's added durability
// re-values seeded setups and every downstream exchange it appears in.
const EXPECTED_REPLAY_SHA256 = "0cb01557c8216f933601e5772ad60ee4b87bd33e3b881779f60ef3c086ca261c";

test("the shared production resolver preserves the terminal setup guard's full-trace replay digest", () => {
    const previousGate = process.env.V07_PLACEMENT_REVEAL;
    process.env.V07_PLACEMENT_REVEAL = "on";
    try {
        const policy: INonFightCandidatePolicy = {
            id: "c77bae00-909a-4095-bb12-27dbe9b796bb/pass-11/synergy/situational",
            ...structuredClone(V07_NONFIGHT_SETUP_ARTIFACT.policy),
        };
        const pairs = REPLAY_SEEDS.map((seed) => evaluateSetupPair(policy, seed)).sort(
            (left, right) => left.seed - right.seed,
        );
        expect(createHash("sha256").update(JSON.stringify(pairs)).digest("hex")).toBe(EXPECTED_REPLAY_SHA256);
    } finally {
        if (previousGate === undefined) delete process.env.V07_PLACEMENT_REVEAL;
        else process.env.V07_PLACEMENT_REVEAL = previousGate;
    }
}, 30_000);
