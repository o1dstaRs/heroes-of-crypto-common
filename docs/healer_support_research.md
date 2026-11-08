# Healer support research

`healer-real-effects-research-v1` is an isolated research policy in
`src/simulation/healer_support_policy.ts`. No production strategy imports it.
Do not activate it from a favorable example or a partial bank.

The separate shared correctness change makes Heal and Mass Heal estimates match
the engine's Holy Cross bonus, spell-specific morale, and integer rounding.
Healing restores the wounded front creature; it does not resurrect dead bodies.
The regression tests compare estimates with actual engine casts on both teams.

## Fixed hypothesis

The candidate reranks only an incumbent Healer Heal, Mass Heal, Spiritual Armor,
or Blessing. It preserves attacks, movement, waits, and other spells. Spell
previews run the real engine and restore battle state, object references,
statistics, auxiliary state, active unit, and random state.

Recovery uses the existing durable-anchor taxonomy. Blessing is valued by the
increase in the best currently available physical attack per ally; armor by the
decrease in the equivalent enemy opportunities, allowing retargeting. The
candidate requires a gain above `max(5, 10% of incumbent value)`.

This is a one-activation estimate. It does not predict chosen enemy behavior,
later movement, initiative, secondary area damage, buff duration value, or the
future value of finite charges. Armor and Blessing last three laps; their full
value may therefore differ substantially from this estimate.

## Registered local pilot

The November 8 pilot reserves 144 new independent Healer-containing prescribed
army boards, balanced across three maps and three own doctrines. Each board uses
two physical seats, one matched future, and four arms: 1,152 fights total.

- Stock A19 with the shared healing-estimate correction.
- The unchanged `satyr-contact-support-20261108` research checkpoint on A19.
- The same Satyr baseline plus this Healer reranker.
- The immutable accepted `a19-full-policy-5036-20261108` model pair.

The primary contrast is the Healer addition versus Satyr alone. The shared
recovery-estimate correction is present in every arm; its strength effect is not
isolated. The prescribed-army test does not exercise ranked drafting or establish
current authoritative serving parity.

The pilot gate requires a complete bank, at least one percentage point of paired
gain, a positive whole-board 95% lower bound, nonnegative means against both
other references, nonnegative primary means for every own doctrine, and exact
execution with zero rejects. Intervals use 20,000 whole-board resamples stratified
by map and own doctrine. There is no automatic confirmation or promotion.

Thirty separate smoke fights include six observation-only full-fight A/A
controls. They are not strength evidence. Every changed-result primary context
is reserved for exact replay in both arms, including all gains and losses. These
replays add no independent games. Committed health ledgers separate sourced and
unknown damage, healing, resurrection, regeneration, and other HP changes.

The frozen source, registration, complete raw journals, statistics and replay
receipts belong under the client research output directory
`game/core/tmp/healer-support-pilot-20261108/`. Preserve the fixed hypotheses,
completed cases, and consumed seeds; do not refill or tune from partial outcomes.
