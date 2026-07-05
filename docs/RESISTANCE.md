# Resistances

Heroes of Crypto has **three separate resistance mechanics**. They are commonly confused, but they are
distinct stats that protect against *different* things:

1. **Magic resistance** — reduces magic **damage** and the chance that a **spell debuff** lands.
2. **Status resistance** — reduces the chance that a **status ability** (Stun, Paralysis) lands.
3. **Mind resistance** — a **binary immunity** to **MIND**-type effects.

> All behaviour is in the shared engine (`src/`), so it is identical on the client and the authoritative
> server. Percentages below are read as whole numbers (e.g. `25` = 25%).

---

## 1. Magic resistance

`magic_resist` — a percentage stat, read via `Unit.getMagicResist()` (`units/unit.ts`). It does **two**
different things, and it does **not** protect against status abilities or MIND effects.

### 1a. Magic damage reduction

Magic damage is multiplied by `(1 − magic_resist / 100)`; a unit at **100** takes **no** magic damage.

| Source of magic damage | Formula | Where |
| --- | --- | --- |
| **Fire Breath** | `dmg × (1 − mr/100)`, `mr ≥ 100` → immune | `abilities/fire_breath_ability.ts` |
| **Chain Lightning** | `dmg × (1 − mr/100)`, `mr = 100` **or** `Wind Element` → immune | `abilities/chain_lightning_ability.ts` |
| **Fire Shield** (reflected) | `dmg × (1 − mr/100)` | `abilities/fire_shield_ability.ts` |

### 1b. Spell-debuff application roll

When an attack applies a **spell** debuff, the debuff is resisted if `randomInt(0,100) < floor(magic_resist)`.
So `magic_resist` is the **percent chance to shrug off** that debuff.

| Debuff source | Where |
| --- | --- |
| Any **cast-on-hit** debuff spell | `handlers/attack_handler.ts` (`rand < magic_resist`) |
| **Spit Ball** (Sadness / Quagmire / Weakening Beam / Weakness / Rangebane / Cowardice) | `abilities/spit_ball_ability.ts` |

### Sources of magic resistance

| Source | Effect | Where |
| --- | --- | --- |
| Base creature stat | innate `magic_resist` | creature config |
| **Helm of Focus** (Tier-1 artifact) | `+%` additive, capped at 100 | `units/unit.ts` (`adjustBaseStats`) |
| **Made of Fire** ability | scales `magic_resist` up | `units/unit.ts` |
| **Enchanted Skin** ability | sets `magic_resist_mod` | `units/unit.ts` |

> **Note:** the **Amulet of Resolve** artifact is *not* magic resistance — it grants **status resistance**
> (§2), even though it historically fed `magic_resist`.

---

## 2. Status resistance

`getStatusResist()` (`units/unit.ts`) — a percentage that lowers the chance a **`STATUS`-type ability**
lands. The apply chance is multiplied by `(1 − status_resist / 100)`.

| STATUS ability | Gated by status resistance? | Where |
| --- | --- | --- |
| **Stun** | ✅ apply chance `× (1 − sr/100)` | `abilities/stun_ability.ts` |
| **Paralysis** | ✅ apply chance `× (1 − sr/100)` | `abilities/paralysis_ability.ts` |
| **Shatter Armor** | ❌ — it has **no** apply roll (it always lands; only its *power* scales), so status resistance does not reduce it | `abilities/shatter_armor_ability.ts` |

### Sources of status resistance

| Source | Effect | Where |
| --- | --- | --- |
| **Amulet of Resolve** (Tier-1 artifact) | `+%` status resistance | applied as a `"System"` buff (`units_holder.ts` `applyArtifacts`), read by `getStatusResist()` |

Status resistance does **not** reduce magic damage, spell debuffs, or MIND effects.

---

## 3. Mind resistance

Mind resistance is **binary immunity** — a unit either fully resists **MIND**-type effects or it does not.
It is **not** a percentage and is **not** granted by any artifact.

`Unit.hasMindAttackResistance()` (`units/unit.ts`) returns `true` only when the unit has the **`Madness`**
or **`Mechanism`** ability. A MIND effect on such a unit is fully blocked (no roll).

| MIND ability (fully blocked) | Where |
| --- | --- |
| **Blindness** | `abilities/blindness_ability.ts` |
| **Aggravating** (Aggr) | `abilities/aggr_ability.ts` |
| **Boar Saliva** | `abilities/boar_saliva_ability.ts` |
| **Petrifying Gaze** | `abilities/petrifying_gaze_ability.ts` |

| MIND spell (fully blocked) | Applied via |
| --- | --- |
| **Sadness**, **Cowardice**, **Rangebane**, **Courage** | `handlers/attack_handler.ts` / `abilities/spit_ball_ability.ts` (MIND branch) |

> A MIND *debuff spell* applied on-hit (e.g. Sadness via Spit Ball) is checked against **both** magic
> resistance (the `magic_resist` roll) **and** mind immunity — either one can block it.

---

## 4. The `Mechanism` duality (important nuance)

`Mechanism` grants **mind immunity** (§3) — but it also makes the unit **more vulnerable to STATUS
abilities**. When the attacker's Stun / Paralysis / Shatter Armor is `STATUS`-typed and the target has
`Mechanism`, an amplifier of **1.5×** is applied to the ability's apply chance / effect power
(`stun_ability.ts`, `paralysis_ability.ts`, `shatter_armor_ability.ts`).

So a `Mechanism` unit is **immune to MIND effects** yet **1.5× easier to Stun / Paralyse**. `Madness`
grants the MIND immunity **without** this STATUS vulnerability.

---

## 5. Quick reference — which resist stops what

| Effect | Magic resist | Status resist | Mind resist |
| --- | --- | --- | --- |
| Fire Breath / Chain Lightning / Fire Shield damage | ✅ reduces (100 = immune) | — | — |
| Cast-on-hit debuff spell (non-MIND) | ✅ chance to resist | — | — |
| Spit Ball debuffs | ✅ chance to resist | — | ✅ if the debuff is MIND-typed |
| **Stun**, **Paralysis** | — | ✅ lowers chance | — |
| **Shatter Armor** | — | ❌ (always lands) | — |
| Blindness / Aggravating / Boar Saliva / Petrifying Gaze | — | — | ✅ full immunity |
| MIND spells (Sadness / Cowardice / Rangebane / Courage) | ✅ if applied on-hit (roll) | — | ✅ full immunity |

**Takeaways**
- **Amulet of Resolve** (status resist) helps vs Stun / Paralysis — **not** vs magic damage, spell
  debuffs, or the MIND abilities.
- **Helm of Focus** (magic resist) helps vs magic damage + spell debuffs — **not** vs Stun / Paralysis.
- **MIND immunity** comes only from the `Madness` / `Mechanism` abilities, never from an artifact.
