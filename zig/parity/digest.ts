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
    /** Helping Hand's link column ("caster id;penalty id"), after the forbidden target (which it turns on); with `spells`. */
    helpingHand?: boolean;
    /** Batch 6b (with `spells` on; it turns the forbidden target and the link on): the spent Water Shield flag and
     * magic_resist_mod (Enchanted Skin) after the link, and the fight's lava cells. */
    batch6b?: boolean;
}

export function unitDigest(
    u: any,
    setup: boolean,
    batch3 = false,
    spells = false,
    batch4 = false,
    helpingHand = false,
    batch6b = false,
): unknown[] {
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
        ...(batch4 || helpingHand || batch6b ? [p.forbidden_target ?? ""] : []),
        // Helping Hand's link: the caster's and the penalty unit's ids.
        ...(helpingHand || batch6b ? [`${p.helping_hand_caster_id ?? ""};${p.helping_hand_penalty_id ?? ""}`] : []),
        // Batch-6b columns: Unit.waterShieldSpent (the seeding refresh reads it) and magic_resist_mod (Enchanted Skin's
        // 100, which getMagicResist answers with; the magic_resist column is then the unfolded base).
        ...(batch6b ? [u.waterShieldSpent ? 1 : 0, p.magic_resist_mod ?? 0] : []),
    ];
}

/** The column names of unitDigest, in order. */
export function digestFields(
    setup: boolean,
    batch3 = false,
    spells = false,
    batch4 = false,
    helpingHand = false,
    batch6b = false,
): string[] {
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
        ...(batch4 || helpingHand || batch6b ? ["forbidden_target"] : []),
        ...(helpingHand || batch6b ? ["helping_hand_link"] : []),
        ...(batch6b ? ["water_shield_spent", "magic_resist_mod"] : []),
    ];
}

/** The board's lava cells ("L" in boardCoord), x-major: a death on lava erases one, a unit leaving a centre cell restores
 * it, and a Made of Fire unit stands on them. */
export function lavaDigest(grid: any): number[][] {
    const out: number[][] = [];
    const board: string[][] = grid.boardCoord;
    for (let x = 0; x < board.length; x += 1) {
        for (let y = 0; y < board[x].length; y += 1) if (board[x][y] === "L") out.push([x, y]);
    }
    return out;
}

/** The vines store (FightProperties.vines) in Map order: [x, y, lapsRemaining, team]. */
export function vinesDigest(fp: any): number[][] {
    const store = fp.getVines?.();
    const map: Map<number, any> | undefined = store?.vines;
    if (!map) return [];
    return [...map.values()].map((v: any) => [v.cell.x, v.cell.y, v.getLapsRemaining(), v.team]);
}

/** The smoke store (FightProperties.smokeClouds) in Map order: [x, y, lapsRemaining]. */
export function smokeDigest(fp: any): number[][] {
    const store = fp.getSmokeClouds?.();
    const map: Map<number, any> | undefined = store?.clouds;
    if (!map) return [];
    return [...map.values()].map((c: any) => [c.cell.x, c.cell.y, c.getLapsRemaining()]);
}

/** The fire wall store (FightProperties.fireWalls) in Map order: [x, y, lapsRemaining, burnPercentage]. */
export function fireWallDigest(fp: any): number[][] {
    const store = fp.getFireWalls?.();
    if (!store) return [];
    return store.toJSON().map((c: any) => [c.x, c.y, c.l, c.p]);
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
        units.push(unitDigest(u, opts.setup, opts.batch3, opts.spells, opts.batch4, opts.helpingHand, opts.batch6b));
    }
    const emberTeams = [...(ctx.unitsHolder.emberCovenantTeams ?? [])].sort();
    const fight: Record<string, unknown> = { ...fightDigest(ctx.fightProperties), emberTeams };
    if (opts.terrain) fight.terrain = terrainDigest(ctx.grid, ctx.fightProperties);
    if (opts.spells) fight.vines = vinesDigest(ctx.fightProperties);
    if (opts.spells) fight.smoke = smokeDigest(ctx.fightProperties);
    if (opts.spells) fight.fireWalls = fireWallDigest(ctx.fightProperties);
    if (opts.batch6b) fight.lava = lavaDigest(ctx.grid);
    return { units, fight };
}
