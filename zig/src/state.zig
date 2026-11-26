//! Battle state as plain fixed-size data: copying a `State` is the whole snapshot/restore, so a rollout
//! costs one memcpy instead of the TypeScript engine's object-graph snapshot.
//!
//! Numbers the TypeScript engine keeps as JS numbers are f64 here, so every rounding step matches.

const std = @import("std");
const Rng = @import("rng.zig").Rng;

/// Unit slots: the units in the holder plus the removed ones the turn sets still name this lap. A summon takes a free
/// slot (`engine.allocSlot`), so a battle can create more units than this over its course.
pub const MAX_UNITS = 32;
/// Distinct unit ids one battle can name (start units and summons): `Unit.uid` and recorded unit indices are u8.
pub const MAX_UIDS = 255;
pub const GRID = 16;
/// Buffs a unit can carry in scope: Morale, Luck Blessing, Arcane Ward, Sharpened Weapons (melee or magic units) or
/// Rallying Volley (shooters), Ember Covenant, three aura rows and the five augments (13), with one to spare. A push
/// past a capacity sets State.overflow (the checks report it).
pub const MAX_SPELLS = 14;
/// Debuffs (Dismorale, Dulling Defense, Miner, the Web Aura row) and effects (Stun, Break, Poison, Aggr, Shatter
/// Armor, Pegasus Light), one to spare each.
pub const MAX_DEBUFFS = 5;
pub const MAX_EFFECTS = 7;

pub const Team = struct {
    pub const NO_TEAM: u8 = 0;
    pub const RIGHT: u8 = 1;
    pub const LEFT: u8 = 2;
};

pub const AttackType = struct {
    pub const NO_ATTACK: u8 = 0;
    pub const MELEE: u8 = 1;
    pub const RANGE: u8 = 2;
    pub const MAGIC: u8 = 3;
    pub const MELEE_MAGIC: u8 = 4;
};

pub const Movement = struct {
    pub const WALK: u8 = 1;
    pub const FLY: u8 = 2;
};

pub const Cell = @import("recording.zig").Cell;

/// Buffs, debuffs and effects the scoped battles can carry, by their TypeScript names (the string table is for
/// loading the start state and for digests). Buffs: Morale, the team blessings, Ember Covenant, the aura rows
/// ("<effect> Aura") and the augments ("<kind> Augment", System spells of NUMBER_OF_LAPS_TOTAL laps); debuffs:
/// Dismorale and Dulling Defense; effects: Shatter Armor, Poison, Aggr, Pegasus Light and Break.
pub const SpellId = enum(u8) {
    morale,
    dismorale,
    luck_blessing,
    sharpened_weapons_blessing,
    dulling_defense,
    shatter_armor,
    ember_covenant_blessing,
    venom_cloud_aura,
    pegasus_might_aura,
    absorb_penalties_aura,
    poison,
    aggr,
    pegasus_light,
    /// The Chaos break-on-attack effect (effects.json "Break"): every ability is off while it lasts.
    break_,
    // batch 3
    /// Squire's Stun effect: the unit skips its next activation and cannot respond.
    stun,
    arcane_ward_blessing,
    rallying_volley_blessing,
    /// Troglodyte's display debuff on a mined unit (laps 15, power = the armor taken from it).
    miner,
    /// The Arachna Queen's aura row on enemy flyers (a debuff, MAX_SAFE_INTEGER laps).
    web_aura,
    armor_augment,
    might_augment,
    sniper_augment,
    movement_augment,
    /// Read only by magic-damage abilities (none in scope): carried and digested, never read.
    empower_augment,

    pub fn name(self: SpellId) []const u8 {
        return switch (self) {
            .morale => "Morale",
            .dismorale => "Dismorale",
            .luck_blessing => "Luck Blessing",
            .sharpened_weapons_blessing => "Sharpened Weapons Blessing",
            .dulling_defense => "Dulling Defense",
            .shatter_armor => "Shatter Armor",
            .ember_covenant_blessing => "Ember Covenant Blessing",
            .venom_cloud_aura => "Venom Cloud Aura",
            .pegasus_might_aura => "Pegasus Might Aura",
            .absorb_penalties_aura => "Absorb Penalties Aura",
            .poison => "Poison",
            .aggr => "Aggr",
            .pegasus_light => "Pegasus Light",
            .break_ => "Break",
            .stun => "Stun",
            .arcane_ward_blessing => "Arcane Ward Blessing",
            .rallying_volley_blessing => "Rallying Volley Blessing",
            .miner => "Miner",
            .web_aura => "Web Aura",
            .armor_augment => "Armor Augment",
            .might_augment => "Might Augment",
            .sniper_augment => "Sniper Augment",
            .movement_augment => "Movement Augment",
            .empower_augment => "Empower Augment",
        };
    }

    /// An augment buff (UnitsHolder.applyAugments).
    pub inline fn isAugment(self: SpellId) bool {
        return @intFromEnum(self) >= @intFromEnum(SpellId.armor_augment);
    }

    pub fn fromName(n: []const u8) ?SpellId {
        inline for (std.meta.fields(SpellId)) |f| {
            const id: SpellId = @enumFromInt(f.value);
            if (std.mem.eql(u8, n, id.name())) return id;
        }
        return null;
    }
};

/// Lap counts that `minusLap` never decrements: aura buffs (Number.MAX_SAFE_INTEGER) and whole-fight ones
/// (NUMBER_OF_LAPS_TOTAL = 12 + 4 - 1, src/constants.ts).
pub const LAPS_AURA: f64 = 9007199254740991;
pub const NUMBER_OF_LAPS_TOTAL: f64 = 15;

/// One applied buff/debuff/effect. TypeScript keeps the object (AppliedSpell / Effect) and the parallel
/// `applied_*` display arrays; in scope a name is never applied twice to one list (every apply deletes the name
/// first), so both always agree and one record holds them.
pub const AppliedSpell = struct {
    id: SpellId,
    /// firstSpellProperty / secondSpellProperty: an aura row's source cell (the emitter's base cell, buff or debuff
    /// rows), the Sniper Augment's base-attack and shot-distance percentages (27 and 70 at level 3), else -1
    /// (undefined). Rows that store their power there (the census blessings, Miner) keep it as the row's power.
    src_x: i8 = -1,
    src_y: i8 = -1,
    laps: f64,
    power: f64 = 0,
};

/// A unit's buff list (the widest of the three).
pub const SpellList = SpellListN(MAX_SPELLS);

/// An ordered list of applied buffs, debuffs or effects with room for `cap` entries. A push past the capacity is
/// dropped (it would show as a digest mismatch, never as a write past the list).
pub fn SpellListN(comptime cap: u8) type {
    return struct {
        items: [cap]AppliedSpell = undefined,
        len: u8 = 0,

        pub const capacity = cap;
        const Self = @This();

        pub fn find(self: *const Self, id: SpellId) ?usize {
            for (self.items[0..self.len], 0..) |s, i| if (s.id == id) return i;
            return null;
        }
        /// The first entry's power (`getBuff(name)?.getPower()`, `getEffect(name)?.getPower()`).
        pub fn power(self: *const Self, id: SpellId) ?f64 {
            for (self.items[0..self.len]) |s| if (s.id == id) return s.power;
            return null;
        }
        /// The first entry of that name (`getBuff(name)`, `getEffect(name)`).
        pub fn get(self: *const Self, id: SpellId) ?*const AppliedSpell {
            for (self.items[0..self.len]) |*s| if (s.id == id) return s;
            return null;
        }
        pub fn removeAt(self: *Self, i: usize) void {
            var j = i;
            while (j + 1 < self.len) : (j += 1) self.items[j] = self.items[j + 1];
            self.len -= 1;
        }
        pub fn push(self: *Self, s: AppliedSpell) void {
            if (self.len >= cap) return;
            self.items[self.len] = s;
            self.len += 1;
        }
        /// Unit.applyEffect / applyAuraEffect: a re-application deletes the old entry and appends at the end.
        pub fn replace(self: *Self, s: AppliedSpell) void {
            self.delete(s.id);
            self.push(s);
        }
        /// deleteBuff / deleteDebuff / deleteEffect: every entry of that name, keeping the order of the rest.
        pub fn delete(self: *Self, id: SpellId) void {
            var i: usize = self.len;
            while (i > 0) {
                i -= 1;
                if (self.items[i].id == id) self.removeAt(i);
            }
        }
    };
}

// =====================================================================================================================
// Abilities (src/abilities/ability_properties.ts, the creature configs in src/configuration)
// =====================================================================================================================

/// Active abilities per unit: three native ones plus what Predatory Assimilation steals (8 seen on one Queen).
pub const MAX_ABILITIES = 10;
/// Abilities a unit can lose to Predatory Assimilation (props.stolen_abilities).
pub const MAX_STOLEN = 6;
pub const AbilityMask = u64;

/// The abilities the port implements. A recorded unit carrying any other ability is refused at load.
pub const AbilityId = enum(u8) {
    luck_blessing,
    lucky_strike,
    shatter_armor,
    rapid_charge,
    double_punch,
    sharpened_weapons_blessing,
    shadow_touch,
    small_specie,
    heavy_armor,
    dulling_defense,
    penetrating_bite,
    backstab,
    dodge,
    // batch 2
    venom_cloud_aura,
    wardguard,
    aggr,
    skewer_strike,
    bitter_experience,
    absorb_penalties_aura,
    pegasus_might_aura,
    pegasus_light,
    lightning_spin,
    devour_essence,
    ember_covenant_blessing,
    earth_element,
    vine_throw,
    in_its_own_world,
    // batch 3
    handyman,
    chakram,
    rallying_volley_blessing,
    web_aura,
    infest,
    predatory_assimilation,
    stun,
    arcane_ward_blessing,
    madness,
    blind_fury,
    miner,
    magic_shield,
    borrowed_grace,
    absolving_arrow,

    pub fn name(self: AbilityId) []const u8 {
        return switch (self) {
            .luck_blessing => "Luck Blessing",
            .lucky_strike => "Lucky Strike",
            .shatter_armor => "Shatter Armor",
            .rapid_charge => "Rapid Charge",
            .double_punch => "Double Punch",
            .sharpened_weapons_blessing => "Sharpened Weapons Blessing",
            .shadow_touch => "Shadow Touch",
            .small_specie => "Small Specie",
            .heavy_armor => "Heavy Armor",
            .dulling_defense => "Dulling Defense",
            .penetrating_bite => "Penetrating Bite",
            .backstab => "Backstab",
            .dodge => "Dodge",
            .venom_cloud_aura => "Venom Cloud Aura",
            .wardguard => "Wardguard",
            .aggr => "Aggr",
            .skewer_strike => "Skewer Strike",
            .bitter_experience => "Bitter Experience",
            .absorb_penalties_aura => "Absorb Penalties Aura",
            .pegasus_might_aura => "Pegasus Might Aura",
            .pegasus_light => "Pegasus Light",
            .lightning_spin => "Lightning Spin",
            .devour_essence => "Devour Essence",
            .ember_covenant_blessing => "Ember Covenant Blessing",
            .earth_element => "Earth Element",
            .vine_throw => "Vine Throw",
            .in_its_own_world => "In Its Own World",
            .handyman => "Handyman",
            .chakram => "Chakram",
            .rallying_volley_blessing => "Rallying Volley Blessing",
            .web_aura => "Web Aura",
            .infest => "Infest",
            .predatory_assimilation => "Predatory Assimilation",
            .stun => "Stun",
            .arcane_ward_blessing => "Arcane Ward Blessing",
            .madness => "Madness",
            .blind_fury => "Blind Fury",
            .miner => "Miner",
            .magic_shield => "Magic Shield",
            .borrowed_grace => "Borrowed Grace",
            .absolving_arrow => "Absolving Arrow",
        };
    }

    pub fn fromName(n: []const u8) ?AbilityId {
        inline for (std.meta.fields(AbilityId)) |f| {
            const id: AbilityId = @enumFromInt(f.value);
            if (std.mem.eql(u8, n, id.name())) return id;
        }
        return null;
    }

    pub inline fn bit(self: AbilityId) AbilityMask {
        return @as(AbilityMask, 1) << @as(u6, @intCast(@intFromEnum(self)));
    }
};

pub const MAX_AURA_DEFS = 6;
/// Aura effects one unit emits: its own, plus the ones it stole (a Queen: Web and two stolen ones seen).
pub const MAX_UNIT_AURAS = 4;

/// One aura effect (aura_effects.json, recorded in `init.auraEffectConfigs`): the buff row it grants on its
/// recipients ("<effect> Aura") and its configured range, default power, recipient side and power type.
pub const AuraDef = struct {
    buff: SpellId,
    range: f64,
    power: f64,
    is_buff: bool,
    power_type: u8,
};

/// AbilityPowerType values the ported formulas branch on (src/abilities/ability_properties.ts).
pub const PowerType = struct {
    pub const TOTAL_DAMAGE_PERCENTAGE: u8 = 1;
    pub const ADDITIONAL_DAMAGE_PERCENTAGE: u8 = 2;
    pub const MAGIC_RESIST_100: u8 = 6;
    pub const APPLY_EFFECT: u8 = 7;
    pub const IGNORE_ARMOR: u8 = 8;
    pub const BOOST_HEALTH: u8 = 13;
    pub const ADDITIONAL_MELEE_DAMAGE_PERCENTAGE: u8 = 16;
    pub const ADDITIONAL_RANGE_ARMOR_PERCENTAGE: u8 = 19;
    pub const MAGIC_RESIST_50: u8 = 21;
    pub const ABSORB_DEBUFF: u8 = 25;
    pub const KILL_RANDOM_AMOUNT: u8 = 27;
    pub const MAGIC_RESIST_25: u8 = 28;
    pub const ADDITIONAL_STEPS: u8 = 29;
    pub const STEAL_ARMOR_ON_HIT: u8 = 35;
    pub const MAGIC_DAMAGE: u8 = 41;
    pub const ADDITIONAL_BASE_ATTACK_AND_ARMOR: u8 = 32;
    pub const POISON_ON_HIT: u8 = 56;
    /// The Web aura (Arachna Queen): it lands only on flyers and carries no power.
    pub const DISABLE_FLY_MOVEMENT: u8 = 51;
    pub const GAIN_ATTACK_AND_ARMOR_EACH_STEP: u8 = 44;
    pub const REDUCE_BASE_ATTACK_UPON_MELEE_ATTACK: u8 = 47;
};

/// One configured ability (getAbilityConfig(name)), plus the default of the effect it applies, if any (effects.json
/// laps and powers are small integers, so f32 holds them exactly).
pub const Ability = struct {
    power: f64,
    effect_laps: f32 = 0,
    effect_power: f32 = 0,
    id: AbilityId,
    power_type: u8,
    ty: u8,
    stack_powered: bool,
    skip_response: bool,
    /// The aura effect it emits (an index into State.aura_defs), or NO_AURA.
    aura: u8 = NO_AURA,
};

pub const NO_AURA: u8 = 0xff;

/// `initialUnitProperties`: the base values every stat refresh recomputes from (recorded `initialProps`; older
/// recordings, made without setup, take them from `props`). In scope `morale` changes (morale moves), `base_attack`
/// (Dulling Defense), `base_armor` and `steps` (Bitter Experience), and `amount_alive` (the Life supply synergy).
pub const BaseStats = struct {
    max_hp: f64,
    luck: f64,
    morale: f64,
    base_armor: f64,
    armor_mod: f64,
    base_attack: f64,
    attack_mod: f64,
    attack_damage_min: f64,
    attack_damage_max: f64,
    steps: f64,
    initiative: f64,
    magic_resist: f64,
    shot_distance: f64,
    amount_alive: f64,
};

/// One team's synergy values (FightProperties.getAdditional*PerTeam and getBreakChancePerTeam): fixed for the whole
/// battle once runMatch's setup block has run (recorded as `init.setup.perTeam`; all 0 without setup).
pub const TeamSetup = struct {
    /// getAdditionalAbilityPowerPerTeam (Might, PLUS_STACK_ABILITIES_POWER): every ability formula of the team.
    ability_power: f64 = 0,
    /// getAdditionalMovementStepsPerTeam (Chaos, MOVEMENT): added to steps_mod.
    movement_steps: f64 = 0,
    /// getAdditionalFlyArmorPerTeam (Nature, PLUS_FLY_ARMOR): % of base armor as armor_mod for flyers.
    fly_armor: f64 = 0,
    /// getAdditionalMoralePerTeam / getAdditionalLuckPerTeam (Life, PLUS_MORALE_AND_LUCK).
    morale: f64 = 0,
    luck: f64 = 0,
    /// getAdditionalSupplyPerTeam (Life, PLUS_SUPPLY_PERCENTAGE): % more creatures at start_fight.
    supply: f64 = 0,
    /// getAdditionalAuraRangePerTeam (Might, PLUS_AURAS_RANGE): added to every aura the team emits.
    aura_range: f64 = 0,
    /// getBreakChancePerTeam (Chaos, BREAK_ON_ATTACK): the striker's chance to Break the unit it hits.
    break_chance: f64 = 0,
};

pub const Unit = struct {
    in_holder: bool,
    /// The unit's per-battle identity (never reused): start units take their start-state index, each summon the next
    /// one (State.next_uid). Recordings and handles name units by uid; slots (indices into State.units) are reused.
    uid: u8 = 0,
    /// The unit id as 16 bytes when it is a canonical lowercase UUID (`uuid_ok`): summon ids hash their summoner's id,
    /// and Chakram breaks bearing ties by id order.
    uuid: [16]u8 = .{0} ** 16,
    uuid_ok: bool = false,
    /// PBTypes.CreatureVals of the unit's creature (recorded `creatureId`; 0 in recordings that predate it).
    creature_id: u16,
    team: u8,
    faction: u8,
    level: u8,
    size: u8,
    fw: u8,
    fh: u8,
    attack_type: u8,
    attack_type_selected: u8,
    movement_type: u8,

    base: Cell,
    pos_x: f64,
    pos_y: f64,
    cells: [4]Cell,
    n_cells: u8,

    max_hp: f64,
    hp: f64,
    steps: f64,
    steps_mod: f64,
    morale: f64,
    luck: f64,
    initiative: f64,
    armor_mod: f64,
    base_armor: f64,
    range_armor: f64,
    base_attack: f64,
    attack_mod: f64,
    attack_damage_min: f64,
    attack_damage_max: f64,
    attack_range: f64,
    range_shots: f64,
    range_shots_mod: f64,
    shot_distance: f64,
    magic_resist: f64,
    magic_resist_mod: f64,
    exp: f64,
    amount_alive: f64,
    amount_died: f64,
    luck_mod: f64,
    attack_multiplier: f64,
    stack_power: f64,

    responded: bool,
    on_hourglass: bool,
    moved_this_turn: bool,

    buffs: SpellList,
    debuffs: SpellListN(MAX_DEBUFFS),
    effects: SpellListN(MAX_EFFECTS),

    init: BaseStats,
    luck_per_turn: f64,
    /// Bit L set = lap L already re-rolled luck (`adjustedBaseStatsLaps`).
    adjusted_laps: u128,
    /// UnitsHolder.distancesToClosestEnemies entry for this unit.
    dist_known: bool,
    dist_closest_enemy: f64,
    name_id: u16,
    /// possibleAttackTypes, in order.
    possible: [4]u8,
    n_possible: u8,
    /// Grid registration (`cellsByUnitId`), in the order the caller supplied it.
    reg: [4]Cell,
    n_reg: u8,

    /// `abilities`, in the order of the unit's configuration, and a bit per AbilityId for quick probes.
    abilities: [MAX_ABILITIES]Ability,
    n_abilities: u8,
    ability_mask: AbilityMask,
    /// The unit's ability names include a LUCK_DEPENDENT_BLESSINGS name (UnitsHolder's early luck pass).
    luck_dependent: bool,
    /// movedRouteCellsThisTurn: the last move's route length, read by Rapid Charge; 0 when not moved.
    moved_route_cells: f64,
    /// unitProperties.target: the unit an Aggr forces this one to attack (-1 = none, the initial "").
    target: i8,
    /// `auraEffects`, in `aura_effects` order: indices into State.aura_defs.
    auras: [MAX_UNIT_AURAS]u8,
    n_auras: u8,
    /// getAdditionalAbilityPowerPerTeam(team): the synergy power every ability formula of this unit adds (the
    /// owner's team at every call site in scope; State.setup[team].ability_power).
    syn_power: f64,
    /// props.rallying_volley_granted: the Rallying Volley arrows already added to range_shots (0 or 2, once per unit).
    rallying_volley_granted: f64 = 0,
    /// props.web_movement_locked: refreshPreTurnState's snapshot at activation (a flyer under a Web Aura row).
    web_locked: bool = false,
    /// props.stolen_abilities: the abilities Predatory Assimilation took from this unit, in order.
    stolen: [MAX_STOLEN]AbilityId = undefined,
    n_stolen: u8 = 0,

    pub fn isDead(self: *const Unit) bool {
        return self.amount_alive <= 0;
    }

    /// hasEffectActive("Break")
    pub inline fn isBroken(self: *const Unit) bool {
        return self.effects.len != 0 and self.effects.find(.break_) != null;
    }

    /// hasAbilityActive: the unit has the ability and is not Broken (absence is settled before Break is read, as in
    /// TypeScript, so a unit without the ability never scans its effects).
    pub inline fn has(self: *const Unit, id: AbilityId) bool {
        return self.ability_mask & id.bit() != 0 and !self.isBroken();
    }

    /// getAbility: null when the unit lacks it or is Broken.
    pub fn ability(self: *const Unit, id: AbilityId) ?*const Ability {
        if (!self.has(id)) return null;
        for (self.abilities[0..self.n_abilities]) |*a| if (a.id == id) return a;
        return null;
    }

    /// getAuraEffects().length: no auras while Broken.
    pub inline fn auraCount(self: *const Unit) u8 {
        if (self.n_auras == 0 or self.isBroken()) return 0;
        return self.n_auras;
    }

    /// hasEffectActive("Stun"): isSkippingThisTurn (no Blindness, Freeze or Whirlpool in scope), and canRespond's veto.
    pub inline fn isStunned(self: *const Unit) bool {
        return self.effects.len != 0 and self.effects.find(.stun) != null;
    }

    /// canMove(): no Paralysis or Whirlpool in scope, so only the Web lock taken at activation.
    pub inline fn canMove(self: *const Unit) bool {
        return !self.web_locked;
    }

    /// The active ability of that id, Break ignored (the `abilities` array as TypeScript holds it).
    pub fn activeAbility(self: *const Unit, id: AbilityId) ?*const Ability {
        if (self.ability_mask & id.bit() == 0) return null;
        for (self.abilities[0..self.n_abilities]) |*a| if (a.id == id) return a;
        return null;
    }
};

/// A small FIFO of unit indices with Denque's order (front = next out).
pub const Queue = struct {
    items: [MAX_UNITS]u8 = undefined,
    len: u8 = 0,

    pub fn push(self: *Queue, u: u8) void {
        self.items[self.len] = u;
        self.len += 1;
    }
    pub fn shift(self: *Queue) ?u8 {
        if (self.len == 0) return null;
        const u = self.items[0];
        var i: usize = 1;
        while (i < self.len) : (i += 1) self.items[i - 1] = self.items[i];
        self.len -= 1;
        return u;
    }
    pub fn includes(self: *const Queue, u: u8) bool {
        for (self.items[0..self.len]) |x| if (x == u) return true;
        return false;
    }
    pub fn removeOnce(self: *Queue, u: u8) bool {
        for (self.items[0..self.len], 0..) |x, i| {
            if (x == u) {
                var j = i;
                while (j + 1 < self.len) : (j += 1) self.items[j] = self.items[j + 1];
                self.len -= 1;
                return true;
            }
        }
        return false;
    }
    pub fn slice(self: *const Queue) []const u8 {
        return self.items[0..self.len];
    }
};

pub const UnitSet = u32;

/// A set of uids (0..255): the removed units a lap's turn set still names. TypeScript keeps a removed unit's id in
/// alreadyMadeTurn / alreadyHourglass / alreadyRepliedAttack until the lap flips; nothing but the digest and the set
/// sizes reads them, so a removed unit's slot can go to a summon once its memberships move here.
pub const UidSet = struct {
    words: [4]u64 = .{ 0, 0, 0, 0 },

    pub inline fn add(self: *UidSet, uid: u8) void {
        self.words[uid >> 6] |= @as(u64, 1) << @intCast(uid & 63);
    }
    pub inline fn has(self: *const UidSet, uid: u8) bool {
        return self.words[uid >> 6] & (@as(u64, 1) << @intCast(uid & 63)) != 0;
    }
    pub fn count(self: *const UidSet) u32 {
        var n: u32 = 0;
        for (self.words) |w| n += @popCount(w);
        return n;
    }
    pub inline fn isEmpty(self: *const UidSet) bool {
        return (self.words[0] | self.words[1] | self.words[2] | self.words[3]) == 0;
    }
};

pub const Fight = struct {
    lap: i32 = 1,
    started: bool = false,
    finished: bool = false,
    first_turn_made: bool = false,
    previous_turn_team: u8 = 0,
    highest_initiative: f64 = 0,
    steps_morale_multiplier: f64 = 0,
    additional_narrowing_laps: i32 = 0,
    laps_till_narrowing: i32 = 3,
    grid_type: u8 = 1,
    /// sideOrientedPlacement: the side deployment zones and the x axis of advance (Backstab, the AI's
    /// isSideAxisPolicyTeam; no legacy-axis seats in scope).
    side_oriented: bool = false,
    /// obstacleHitsLeftLeft / obstacleHitsLeftRight: the classic BLOCK_CENTER mountains' hit points (3/3 on every
    /// BLOCK_CENTER board, scattered ones included, where they never move; 0/0 elsewhere).
    hits_left: i32 = 0,
    hits_right: i32 = 0,

    up_next: Queue = .{},
    hourglass_q: Queue = .{},
    morale_plus_q: Queue = .{},
    morale_minus_q: Queue = .{},

    made: UnitSet = 0,
    hourglass_set: UnitSet = 0,
    replied: UnitSet = 0,
    /// Bit L set = damage was dealt in lap L.
    damage_laps: u128 = 0,
    team_units_alive: [3]i32 = .{ 0, 0, 0 },
    /// The removed units the turn sets still name whose slots went to summons (by uid; see UidSet), cleared with the
    /// sets at the lap flip. `made` / `hourglass_set` / `replied` hold the units in slots.
    removed_made: UidSet = .{},
    removed_hourglass: UidSet = .{},
    removed_replied: UidSet = .{},

    /// getAlreadyMadeTurnSize: the units in `made` plus the removed ones it still names.
    pub fn madeCount(self: *const Fight) u32 {
        return @as(u32, @popCount(self.made)) + self.removed_made.count();
    }
};

pub const EMPTY: u8 = 0;
/// "H": a narrowing hole.
pub const HOLE: u8 = 0xff;
/// "B": a classic BLOCK_CENTER mountain cell or a standing scattered stone.
pub const BLOCK: u8 = 0xfe;
/// "L": the undried LAVA_CENTER square.
pub const LAVA: u8 = 0xfd;

/// Whether a board code names a unit (index + 1) rather than EMPTY, a hole or terrain.
pub inline fn isUnitCode(o: u8) bool {
    return o != EMPTY and o < LAVA;
}

/// GridVals (src/generated/protobuf/v1/types.ts). WATER_CENTER is never played.
pub const GridType = struct {
    pub const NORMAL: u8 = 1;
    pub const WATER_CENTER: u8 = 2;
    pub const LAVA_CENTER: u8 = 3;
    pub const BLOCK_CENTER: u8 = 4;
};

/// Up to 12 seeded stones (scatteredMountainCountForSeed is 9..12).
pub const MAX_STONES = 16;

/// The terrain fields of Grid (all private in TypeScript).
pub const Terrain = struct {
    /// scatteredMountainLayout, in roll order (getCenterCells and the AI's strike search read this order). Never
    /// shortened in scope, so hasScatteredMountains stays true all game once a layout is installed.
    layout: [MAX_STONES]Cell = undefined,
    n_layout: u8 = 0,
    /// scatteredMountainsStanding: bit i = layout[i] still stands.
    standing: u16 = 0,
    left_cleared: bool = false,
    right_cleared: bool = false,
    /// cleanedUpCenter: the lava has dried.
    cleaned_up_center: bool = false,
};

pub const Grid = struct {
    /// boardCoord[x][y]: EMPTY, HOLE, BLOCK, LAVA, or unit index + 1.
    board: [GRID][GRID]u8,
    /// boardAggrPerTeam[team][x][y], baseline 1, +1 per ring stamp of that team's units (terrain ignored).
    aggr: [3][GRID][GRID]i16,
    terrain: Terrain = .{},
};

/// The creatures Infest raises, as createUnitFromSpec builds them (recorded `init.summonTemplates`, or the export's
/// `configs.summonTemplates`): the props and base stats of a fresh stack of one, its abilities and auras. Shared and
/// immutable (engine.internSummons), so a State only points at it.
pub const Summons = struct {
    /// Index SPIDER: "Arachna Spider" (a level 1-3 corpse), QUEEN: "Arachna Queen" (a level-4 corpse).
    units: [2]Unit,
    present: [2]bool = .{ false, false },

    pub const SPIDER = 0;
    pub const QUEEN = 1;
};

pub const State = struct {
    units: [MAX_UNITS]Unit,
    /// The slots in use: every slot below it holds a unit, in the holder or removed (`in_holder` false).
    n_units: u8,
    /// The UnitsHolder's insertion order: the slots of the units in the holder (dead ones not cleaned up included).
    holder: [MAX_UNITS]u8 = undefined,
    n_holder: u8 = 0,
    /// The uid the next summon takes.
    next_uid: u8 = 0,
    /// runMatch's createSummonedUnit counter (a part of every summon id) and the battle seed (another part; `has_seed`
    /// false prints it as "undefined").
    summon_seq: u32 = 0,
    seed: f64 = 0,
    has_seed: bool = false,
    /// The summon templates, when a unit can summon (null otherwise).
    summons: ?*const Summons = null,
    /// A capacity of the port was exceeded (unit slots, uids, ability or spell lists): the state no longer follows
    /// TypeScript, and the checks report it.
    overflow: bool = false,
    grid: Grid,
    fight: Fight,
    rng: Rng,
    /// The harness's currentActiveUnitId (-1 = none), fed by the step's events.
    active: i8,
    /// AI target memory (ai.ts previousTargetsByBattle): attacker -> remembered target, -1 = none.
    ai_prev_target: [MAX_UNITS]i8,
    /// Lap of the latest damage-statistic entry (a landed hit or response); feeds damageDealtThisLap.
    damage_lap: i32,
    /// Some unit carries a team-blessing ability, so the stat refresh runs the blessing census.
    blessings: bool,
    /// Some unit emits an aura (or carries an aura row at load), so the stat refresh runs the aura refresh.
    auras: bool,
    /// Some unit can be Aggr'd, buffed by an aura or carries Wardguard: adjustBaseStats runs those hooks.
    stat_hooks: bool,
    aura_defs: [MAX_AURA_DEFS]AuraDef,
    n_aura_defs: u8,
    /// UnitsHolder.emberCovenantSeeded and emberCovenantTeams (bit = team).
    ember_seeded: bool,
    ember_teams: u8,
    /// The System spell "Ember Covenant Blessing" (laps, power) and the "Poison" effect's laps.
    ember_laps: f64,
    ember_power: f64,
    poison_laps: f64,
    /// Per team (index Team.RIGHT / Team.LEFT): the synergy values runMatch's setup fixed for the battle.
    setup: [3]TeamSetup,
    /// Some unit carries an augment buff, so adjustBaseStats looks the augments up.
    augments: bool,
    /// The "Break" effect's configured laps and power (effects.json, recorded in `init.effectConfigs.Break`).
    break_laps: f64,
    break_power: f64,
    /// The name ids of "Arachna Spider" and "Arachna Queen" (Unit.name_id of a summon).
    summon_name_id: [2]u16 = .{ 0xffff, 0xffff },

    /// The holder's units in TypeScript's insertion order (`unitsHolder.getAllUnits()`): slot indices into `units`.
    /// Dead units stay until cleanupDeadUnits removes them. Without summons slots are never reused, so this is every
    /// slot with `in_holder` set, in slot order.
    pub inline fn holderOrder(self: *const State) []const u8 {
        return self.holder[0..self.n_holder];
    }

    /// The slot holding unit `uid` (in the holder, or removed but still in a slot), or null.
    pub fn slotOf(self: *const State, uid: u8) ?u8 {
        if (uid < self.n_units and self.units[uid].uid == uid) return uid; // the common case: no slot reused yet
        for (self.units[0..self.n_units], 0..) |*u, i| {
            if (u.uid == uid) return @intCast(i);
        }
        return null;
    }
};
