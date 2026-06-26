# Luck

Luck is a stack's combat fortune. Unlike morale (which grants extra/skipped turns), luck is mostly a **damage-variance and ability stat**:

1. **Damage taken** — lucky stacks take *less* damage; unlucky stacks take *more*.
2. **Ability power & chance** — a unit's own luck boosts the strength and trigger chance of its abilities.

Luck is an integer in the range **[−10, +10]** (`LUCK_MAX_VALUE_TOTAL = 10`). 0 is neutral.

> Constants live in `src/constants.ts`. Behaviour is in the shared engine (`src/`), identical on client and authoritative server. Unlike morale, the per-turn luck roll is **non-deterministic** (see §6).

---

## 1. The per-turn luck spread

Each lap (once the fight has started), every unit re-rolls a small random luck swing (`unit.ts` `randomizeLuckPerTurn`):

```
luck_mod = random integer in [-3, +3]     (LUCK_MAX_CHANGE_FOR_TURN = 3)
```

clamped so that `base_luck + luck_mod` never leaves [−10, +10].

- **Before the fight starts** (placement / drafting), the spread is forced to 0 — units show only their base luck.
- The roll is re-applied at the start of each lap inside `adjustBaseStats()` (gated on `hasFightStarted` and once-per-lap).

So a unit with base luck 2 will, in-fight, fluctuate roughly between −1 and +5 each lap.

---

## 2. Effective luck

```
effective_luck = base_luck + luck_mod          (clamped to [-10, +10])
```

read everywhere via `getLuck()` (`unit.ts`). `base_luck` is `unitProperties.luck`; `luck_mod` holds the per-turn spread plus luck synergy (see §4).

---

## 3. How luck changes damage

When attacker **A** hits defender **D**, the damage is scaled by **the defender's** luck (`unit.ts` `calculateAttackDamageMin` / `calculateAttackDamageMax`):

```
damage = base_damage
       * attackRate * amount_alive
       / defender_armor
       * (1 - D.getLuck() / 100)      ← luck term
       / divisor
       * attacker.attack_multiplier   ← morale buff/debuff lands here
       * abilityMultiplier
```

So luck is a **defensive** stat:

| Defender luck | Damage taken |
| --- | --- |
| **+10** | ×0.90 — 10% **less** |
| 0 | ×1.00 |
| **−10** | ×1.10 — 10% **more** |

A "lucky" stack shrugs off blows; an "unlucky" one gets hit harder. (Note: the attacker's *own* luck does not add to this attack's damage directly — attacker luck shows up in abilities, §5.)

---

## 4. Luck synergy

The **Life** faction synergy `PLUS_MORALE_AND_LUCK` grants a team-wide flat luck bonus scaling with synergy level (1–3). It is folded into `luck_mod` inside `adjustBaseStats()` via `fight_properties.getAdditionalLuckPerTeam()`, then clamped to ±10 (exact per-level values are in `synergies/synergy_properties.ts` → `SynergyKeysToPower`). The same synergy also grants morale (see `MORALE.md`).

---

## 5. Luck in abilities

A unit's **own** effective luck is added into many ability calculations (`unit.ts`), e.g.:

- **ability apply chance** (`calculateAbilityApplyChance`) — luck is added to the percentage chance an ability triggers;
- **ability power / multipliers** (damage-type abilities, Deep Wounds, aura coefficients) — luck is added to the computed power.

In short: high luck makes *your* abilities both stronger and more likely to fire, on top of making *you* harder to damage.

> Not to be confused with the **"Lucky Strike"** ability, which is a separate ability and does not read the luck stat directly.

---

## 6. Special cases & notes

- **Luck Aura** (buff): forces luck to the **maximum (+10)** for its duration — `adjustBaseStats` detects the sentinel and sets `luck = 10`, `luck_mod = 0` (`spells/spell_helper.ts`, `unit.ts`).
- **Madness / Mechanism**: these abilities only affect **morale** (forced to 0). They do **not** change luck.
- **Defend / Luck Shield**: defending costs **−2 morale** and runs `cleanupLuckPerTurn()`, which clears this turn's random luck spread (`luck_mod = 0`, `luckPerTurn = 0`). Effective luck falls back to **base luck** (plus any team luck synergy, which the next stat refresh re-applies); the random ±3 swing is gone for the rest of the lap. (`engine/action_engine.ts` `defendTurn` → `unit.ts` `cleanupLuckPerTurn`.)
- **Determinism**: the per-turn spread uses a cryptographically-random integer (`utils/lib.ts` `getRandomInt`, not a seeded RNG). Luck rolls therefore cannot be reproduced from a replay unless the rolled values are recorded. (Morale's roll uses the runtime RNG and is comparatively reproducible.)

---

## 7. Developer reference (file : line)

| Mechanic | Location |
| --- | --- |
| Constants (`LUCK_MAX_VALUE_TOTAL=10`, `LUCK_MAX_CHANGE_FOR_TURN=3`) | `src/constants.ts:40-41` |
| Per-turn spread | `src/units/unit.ts` `randomizeLuckPerTurn` |
| Effective luck + clamp | `src/units/unit.ts` `getLuck` |
| Luck applied in `adjustBaseStats` (spread + synergy + Luck Aura) | `src/units/unit.ts` `adjustBaseStats` (LUCK block) |
| Damage luck term | `src/units/unit.ts` `calculateAttackDamageMin` / `calculateAttackDamageMax` |
| Luck in abilities | `src/units/unit.ts` (ability power / `calculateAbilityApplyChance`) |
| Synergy bonus | `src/fights/fight_properties.ts` `getAdditionalLuckPerTeam` |
| Luck Aura | `src/spells/spell_helper.ts` |
| RNG | `src/utils/lib.ts` `getRandomInt` |

**Tests:** `test/units/unit.test.ts` (`describe("luck")`): pre-fight spread cleared, synergy bonus, ±10 clamping, in-fight bound across many rolls.
