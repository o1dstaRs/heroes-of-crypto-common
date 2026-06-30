# Morale

Morale represents a stack's fighting spirit. It does three things:

1. **Bonus / penalty turns** — each lap, a unit may roll to act an *extra* time (high morale) or to be *skipped* (low morale).
2. **Movement range** — morale nudges how far a unit can move.
3. **Attack power** — when a unit is actually *on Morale* / *on Dismorale* for a lap, its attack is boosted / reduced.

Morale is always an integer in the range **[−20, +20]** (`MORALE_MAX_VALUE_TOTAL = 20`). 0 is neutral.

> All constants below live in `src/constants.ts`. All behaviour is implemented in the shared engine (`src/`) and is therefore identical on the client and the authoritative server.

---

## 1. How morale is earned and lost

Morale changes are applied to a unit's **base** morale and clamped to ±20. (See §4 for base-vs-effective.)

| Event | Change | Constant | Where |
| --- | --- | --- | --- |
| Move **toward** the enemy army | **+3** | `MORALE_CHANGE_FOR_DISTANCE` | `handlers/move_handler.ts` `applyDistanceMoraleModifier` |
| Move **away** from the enemy army | **−3** | `MORALE_CHANGE_FOR_DISTANCE` | same |
| Lateral move (distance unchanged) | 0 | — | same |
| **Kill** an enemy stack (attacker) | **+4** | `MORALE_CHANGE_FOR_KILL` | `handlers/attack_handler.ts`, kill-dealing abilities |
| An allied stack of the **same unit type** dies | **−4** each | `MORALE_CHANGE_FOR_KILL` | `units_holder.ts` `decreaseMoraleForTheSameUnitsOfTheTeam` |
| **Wait** (hourglass) | **−3** | `MORALE_CHANGE_FOR_CLOCK` | `engine/action_engine.ts` |
| **Defend** (Luck Shield, also sets this turn's luck to +3) | **−2** | `MORALE_CHANGE_FOR_SHIELD` | `engine/action_engine.ts` |
| **Skip** (Next with no action) / **forced skip** (timeout / effect) | **−1** | `MORALE_CHANGE_FOR_SKIP` | `engine/turn_engine.ts` `completeTurn` |

### The distance rule (in detail)

When a unit finishes a move, the engine compares its distance to the **centroid (average position) of all living enemy units** before vs. after the move:

- closer to the centroid → `TOWARD` → **+3**
- farther → `AWAY` → **−3**
- exactly equal → `SAME` → **0**

The centroid (`units_holder.ts` `getDistanceToEnemyCentroid`) is used instead of the single nearest enemy on purpose: with "nearest enemy" a lone flanker standing behind you could turn a charge *into* the enemy line into a morale *penalty*. The centroid measures movement relative to the army as a whole. With exactly one enemy, the centroid is that enemy, so the simple case is unchanged.

This applies to **all** unit sizes, including large (2×2) units that move via a footprint-only path.

### Kill morale (in detail)

When a stack is destroyed:

- the **killer** gains **+4** morale;
- every *living* allied stack **of the same unit type** as the dead stack loses **−4** (keyed by `"<unitName>:<teamId>"`). Multiple same-type deaths in one attack stack additively (two dead → −8).

### Forced skip vs. ending your turn

Only a **forced** skip costs morale (`skipReason` of `"timeout"` or `"effect"`). A normal player turn that ends after moving/attacking passes `skipReason: undefined` and costs **nothing**.

---

## 2. The morale roll (extra / skipped turns)

Once per lap, every unit with non-zero effective morale rolls (`engine/turn_engine.ts` `applyMoraleRolls`):

```
roll  = random integer in [0, 100]
proc  = roll < |morale|   AND NOT mind-attack-resistant
```

So the **chance to proc is `|morale|%`** (e.g. +15 morale → 15% chance; −8 → 8% chance).

- **Positive morale proc → "Morale"**: the unit gains the `Morale` buff for the lap and is enqueued to the **front** of the turn order (acts again / first). The `Morale` buff also gives **×1.25 attack** that lap.
- **Negative morale proc → "Dismorale"**: the unit gains the `Dismorale` debuff and is enqueued to the **back** of the turn order (acts last). The `Dismorale` debuff gives **×0.8 attack** that lap.

**Mind-attack resistance** (units with the **Madness** or **Mechanism** ability) never proc — they are immune to the morale roll entirely (`unit.hasMindAttackResistance()`).

Turn-order priority is held in two FIFO queues, `moralePlusQueue` (first) and `moraleMinusQueue` (last), serialized with the fight so it survives save/resume (`fights/fight_properties.ts`).

---

## 3. Morale and movement range

Effective morale shifts a unit's movement allowance:

```
steps_mod = STEPS_MORALE_MULTIPLIER * morale      (STEPS_MORALE_MULTIPLIER = 0.05)
final_steps = base_steps + steps_mod + (movement synergies/auras)
```

So **every 20 points of morale = 1 extra cell** of movement: +20 morale → +1 step, −20 → −1 step (`unit.ts` `adjustBaseStats` → `getSteps`).

---

## 4. Base vs. effective morale, and overrides

- **Base morale** (`initialUnitProperties.morale`) is what `increaseMorale` / `decreaseMorale` change, clamped to ±20.
- **Effective morale** (`unitProperties.morale`, read by everything via `getMorale()`) is recomputed by `adjustBaseStats()` and is what the roll, movement, and UI use. `adjustBaseStats()` runs on every stat refresh (`units_holder.refreshStackPowerForAllUnits()`), which the engine calls after each action — so a move's ±3 is reflected before the next morale roll.

`adjustBaseStats()` computes effective morale as `base + morale synergy`, then applies these **overrides** (highest-impact last):

| Condition | Effective morale | Attack multiplier |
| --- | --- | --- |
| Normal | base + synergy (clamped ±20) | ×1.0 |
| **Madness** or **Mechanism** ability | **0** | ×1.0 |
| **Courage** buff (no Sadness) | **+20** | ×1.0 |
| **Sadness** debuff (no Courage) | **−20** | ×1.0 |
| **Courage + Sadness** together | **0** | ×1.0 |
| **Morale** buff (this-lap proc) | **+20** | **×1.25** |
| **Dismorale** debuff (this-lap proc) | **−20** | **×0.8** |

`getMorale()` additionally returns **0** for Madness/Mechanism units regardless of stored value.

### Exemptions

`increaseMorale` / `decreaseMorale` are **no-ops** (base morale is not touched) while any of these is active: **Madness**, **Mechanism** (abilities); **Courage**, **Morale** (buffs); **Sadness**, **Dismorale** (debuffs). This keeps a locked unit's underlying base morale intact for when the lock ends.

### Team morale synergy

The **Life** faction synergy `PLUS_MORALE_AND_LUCK` grants a team-wide flat morale bonus that scales with synergy level (1–3). It is added to effective morale inside `adjustBaseStats()` via `fight_properties.getAdditionalMoralePerTeam()` (exact per-level values live in `synergies/synergy_properties.ts` → `SynergyKeysToPower`). The same synergy also grants luck (see `LUCK.md`).

> Implementation note: `increaseMorale`/`decreaseMorale` take a `synergyMoraleIncrease` argument but ignore it — synergy is applied centrally in `adjustBaseStats()` so it can't be double-counted or lost when the synergy value changes between calls.

---

## 5. Developer reference (file : line)

| Mechanic | Location |
| --- | --- |
| Constants | `src/constants.ts:35-42` |
| Distance morale (centroid) | `src/handlers/move_handler.ts` `applyDistanceMoraleModifier` |
| Enemy centroid | `src/units/units_holder.ts` `getDistanceToEnemyCentroid` |
| Footprint (large-unit) morale | `src/engine/action_engine.ts` (footprint-only move branch) |
| Kill morale (attacker + team) | `src/handlers/attack_handler.ts`; `src/units/units_holder.ts` `decreaseMoraleForTheSameUnitsOfTheTeam` |
| Wait / Defend / Skip morale | `src/engine/action_engine.ts`; `src/engine/turn_engine.ts` `completeTurn` |
| Morale roll | `src/engine/turn_engine.ts` `applyMoraleRolls` |
| Base change + clamp + exemptions | `src/units/unit.ts` `increaseMorale` / `decreaseMorale` |
| Effective morale + overrides | `src/units/unit.ts` `adjustBaseStats` (MORALE block) |
| `getMorale()` | `src/units/unit.ts` |
| Steps from morale | `src/units/unit.ts` `adjustBaseStats` (STEPS block) → `getSteps` |
| Turn-order queues | `src/fights/fight_properties.ts` (`moralePlusQueue` / `moraleMinusQueue`) |
| Synergy bonus | `src/fights/fight_properties.ts` `getAdditionalMoralePerTeam` |

**Tests:** `test/handlers/move_handler.test.ts` (distance/centroid/flanker/footprint/clamp/synergy), `test/units/units_holder.test.ts` (centroid metric), `test/units/unit.test.ts` (exemptions, Courage/Sadness locks, Morale/Dismorale multipliers, steps).
