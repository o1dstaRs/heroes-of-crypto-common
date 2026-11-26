/*
 * The state digest zig/parity/record.ts writes after every recorded step (and the bridge smoke test compares against
 * the Zig state): every unit still in the holder, in insertion order, and the fight's turn state. The Zig side reads
 * it in zig/src/compare.zig (`compare.state`), by column position; `digestFields` names the columns.
 *
 * `setup` adds the setup columns (shot distance, initial base armor and steps), `terrain` the terrain block of the
 * fight digest (written on any board that is not the classic NORMAL one), `spells` the spellbook columns (after the
 * batch-3 columns, which it turns on) and the fight digest's vines, `batch4` the forbidden target (Terrifying Gaze's
 * lock) as the last column (it turns the batch-3 columns on too).
 */

export interface IDigestOptions {
    setup: boolean;
    terrain: boolean;
    /** The batch-3 columns (active and stolen abilities, the Web lock, debuff stored properties, Rallying Volley). */
    batch3?: boolean;
    /** The spellbook columns (the raw entries and the parsed book) and the fight's vines; implies `batch3`. */
    spells?: boolean;
    /** The forbidden target column (the gazer's id or ""), after every other column; implies `batch3`. */
    batch4?: boolean;
}

export function unitDigest(u: any, setup: boolean, batch3 = false, spells = false, batch4 = false): unknown[] {
    const p = u.getUnitProperties();
    const c = u.getBaseCell();
    return [
        u.getId(),
        p.amount_alive,
        p.amount_died,
        p.hp,
        p.max_hp,
        c.x,
        c.y,
        u.isDead() ? 1 : 0,
        u.getResponded() ? 1 : 0,
        u.isOnHourglass() ? 1 : 0,
        u.hasMovedThisTurn() ? 1 : 0,
        p.stack_power,
        p.morale,
        p.luck,
        p.luck_mod,
        p.attack_mod,
        p.armor_mod,
        p.base_armor,
        p.base_attack,
        p.steps,
        p.steps_mod,
        p.initiative,
        p.range_shots,
        p.range_shots_mod,
        p.range_armor,
        p.attack_multiplier,
        p.attack_damage_min,
        p.attack_damage_max,
        p.attack_type_selected,
        p.applied_buffs.join(","),
        p.applied_buffs_laps.join(","),
        p.applied_debuffs.join(","),
        p.applied_debuffs_laps.join(","),
        p.applied_effects.join(","),
        p.applied_effects_laps.join(","),
        u.getPosition().x,
        u.getPosition().y,
        u.initialUnitProperties.morale,
        u.luckPerTurn,
        p.applied_buffs_powers.join(","),
        p.applied_debuffs_powers.join(","),
        p.applied_effects_powers.join(","),
        u.initialUnitProperties.base_attack,
        u.getMovedRouteCellsThisTurn(),
        u.getTarget() ?? "",
        p.magic_resist,
        u
            .getBuffs()
            .map((b: any) => `${b.getFirstSpellProperty() ?? ""};${b.getSecondSpellProperty() ?? ""}`)
            .join(","),
        // Setup columns: Sniper moves shot_distance on every refresh; Bitter Experience moves the two bases.
        ...(setup ? [p.shot_distance, u.initialUnitProperties.base_armor, u.initialUnitProperties.steps] : []),
        // Batch-3 columns: the active ability list (stolen ones included, Break ignored), the names the unit lost to
        // Predatory Assimilation, the Web movement lock, each debuff's stored properties (the Web row's source cell)
        // and the once-only Rallying Volley arrows.
        ...(batch3 || spells || batch4
            ? [
                  u.abilities.map((a: any) => a.getName()).join(","),
                  (p.stolen_abilities ?? []).join(","),
                  p.web_movement_locked ? 1 : 0,
                  u
                      .getDebuffs()
                      .map((b: any) => `${b.getFirstSpellProperty() ?? ""};${b.getSecondSpellProperty() ?? ""}`)
                      .join(","),
                  p.rallying_volley_granted ?? 0,
              ]
            : []),
        // Spellbook columns: the raw entries (one per remaining charge; useSpell removes the LAST of a name) and the
        // parsed book with each spell's remaining charges (a spent spell stays at 0 until the book is re-parsed).
        ...(spells
            ? [
                  (p.spells ?? []).join(","),
                  u
                      .getSpells()
                      .map((s: any) => `${s.getName()}:${s.getAmount()}`)
                      .join(","),
              ]
            : []),
        // Batch-4 column: Terrifying Gaze's lock (the gazer's id; TypeScript keeps it after the gazer dies).
        ...(batch4 ? [p.forbidden_target ?? ""] : []),
    ];
}

/** The column names of unitDigest, in order. */
export function digestFields(setup: boolean, batch3 = false, spells = false, batch4 = false): string[] {
    return [
        "id",
        "amount_alive",
        "amount_died",
        "hp",
        "max_hp",
        "x",
        "y",
        "dead",
        "responded",
        "hourglass",
        "moved",
        "stack_power",
        "morale",
        "luck",
        "luck_mod",
        "attack_mod",
        "armor_mod",
        "base_armor",
        "base_attack",
        "steps",
        "steps_mod",
        "initiative",
        "range_shots",
        "range_shots_mod",
        "range_armor",
        "attack_multiplier",
        "attack_damage_min",
        "attack_damage_max",
        "attack_type_selected",
        "buffs",
        "buffs_laps",
        "debuffs",
        "debuffs_laps",
        "effects",
        "effects_laps",
        "px",
        "py",
        "base_morale",
        "luck_per_turn",
        "buffs_powers",
        "debuffs_powers",
        "effects_powers",
        "base_attack_init",
        "moved_route_cells",
        "target",
        "magic_resist",
        "buffs_sources",
        ...(setup ? ["shot_distance", "base_armor_init", "steps_init"] : []),
        ...(batch3 || spells || batch4
            ? ["abilities", "stolen_abilities", "web_locked", "debuffs_sources", "rallying_volley_granted"]
            : []),
        ...(spells ? ["spell_entries", "spellbook"] : []),
        ...(batch4 ? ["forbidden_target"] : []),
    ];
}

/** The vines store (FightProperties.vines) in Map order: [x, y, lapsRemaining, team]. */
export function vinesDigest(fp: any): number[][] {
    const store = fp.getVines?.();
    const map: Map<number, any> | undefined = store?.vines;
    if (!map) return [];
    return [...map.values()].map((v: any) => [v.cell.x, v.cell.y, v.getLapsRemaining(), v.team]);
}

export function fightDigest(fp: any): Record<string, unknown> {
    const sorted = (s: Set<string>): string[] => [...s].sort();
    return {
        lap: fp.currentLap,
        started: fp.fightStarted ? 1 : 0,
        finished: fp.fightFinished ? 1 : 0,
        firstTurnMade: fp.firstTurnMade ? 1 : 0,
        previousTurnTeam: fp.previousTurnTeam,
        highestInitiative: fp.highestInitiativeThisTurn,
        stepsMoraleMultiplier: fp.stepsMoraleMultiplier,
        additionalNarrowingLaps: fp.additionalNarrowingLaps,
        upNext: fp.upNextQueue.toArray(),
        hourglassQ: fp.hourglassQueue.toArray(),
        moralePlusQ: fp.moralePlusQueue.toArray(),
        moraleMinusQ: fp.moraleMinusQueue.toArray(),
        made: sorted(fp.alreadyMadeTurn),
        hourglassSet: sorted(fp.alreadyHourglass),
        replied: sorted(fp.alreadyRepliedAttack),
        damageLaps: [...fp.damageDealFactPerLap.entries()]
            .filter(([, v]: [number, boolean]) => v)
            .map(([k]: [number, boolean]) => k)
            .sort((a: number, b: number) => a - b),
    };
}

/** Terrain state the engine changes during play: the classic hit counters and cleared sides, the dried lava centre,
 * and the standing scattered stones in layout order (Grid's fields are private). */
export function terrainDigest(grid: any, fp: any): Record<string, unknown> {
    return {
        hitsL: fp.getObstacleHitsLeftLeft(),
        hitsR: fp.getObstacleHitsLeftRight(),
        leftCleared: grid.leftMountainCleared ? 1 : 0,
        rightCleared: grid.rightMountainCleared ? 1 : 0,
        cleanedUpCenter: grid.cleanedUpCenter ? 1 : 0,
        standing: grid.getScatteredMountainsStanding().map((c: any) => [c.x, c.y]),
    };
}

export function battleDigest(
    ctx: { grid: any; fightProperties: any; unitsHolder: any },
    opts: IDigestOptions,
): { units: unknown[][]; fight: Record<string, unknown> } {
    const units: unknown[][] = [];
    for (const u of ctx.unitsHolder.getAllUnits().values()) {
        units.push(unitDigest(u, opts.setup, opts.batch3, opts.spells, opts.batch4));
    }
    const emberTeams = [...(ctx.unitsHolder.emberCovenantTeams ?? [])].sort();
    const fight: Record<string, unknown> = { ...fightDigest(ctx.fightProperties), emberTeams };
    if (opts.terrain) fight.terrain = terrainDigest(ctx.grid, ctx.fightProperties);
    if (opts.spells) fight.vines = vinesDigest(ctx.fightProperties);
    return { units, fight };
}
