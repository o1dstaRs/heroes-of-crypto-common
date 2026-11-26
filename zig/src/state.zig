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
/// No unit (uids are 0..MAX_UIDS-1).
pub const NO_UID: u8 = 0xff;
pub const GRID = 16;
/// Buffs a unit can carry in scope: Morale, Luck Blessing, Sylvan Focus, Arcane Ward, Warding Mane, Sharpened Weapons
/// (melee or magic units) or Rallying Volley (shooters), Ember Covenant, four aura rows (Disguise among them), the five
/// augments, a cast Blessing, Battle Roar and the Hidden marker (19), with one to spare. A push past a capacity sets
/// State.overflow (the checks report it).
pub const MAX_SPELLS = 20;
/// Debuffs: Dismorale, Dulling Defense, Miner, the Web Aura and Range Null Field Aura rows, the Vine Throw snare, the
/// Visible marker and Spit Ball's seven, which a Magic Reflection mirror can duplicate on the shooter (19 in scope; 9 seen
/// on one unit). Effects: Stun, Break, Poison, Aggr, Shatter Armor, Pegasus Light, Deep Wounds, Boar Saliva, Terrifying
/// Gaze, one to spare.
pub const MAX_DEBUFFS = 20;
pub const MAX_EFFECTS = 10;

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
    /// Read by spell damage (getMagicDamageBonusPercentage).
    empower_augment,
    // spells (wave 1)
    /// The Healer's cast buff: every damage roll of its holder is the maximum (adjustBaseStats).
    blessing,
    /// The Vine Throw snare (a debuff: -power steps at every refresh), from the cast or an arrival on an enemy vine.
    vine_throw,
    /// The Satyr's stack blessing: a magic-damage bonus percentage on every ally.
    sylvan_focus_blessing,
    // batch 4
    /// The stacking Deep Wounds effect (Wolf, Tiger, Griffin, Manticore, Behemoth): a holder's strikes deal power% more.
    deep_wounds,
    /// Frenzied Boar's effect on its victim: the first term of the victim's own miss chance.
    boar_saliva,
    /// Manticore's effect: the frightened unit may not attack or answer its gazer (Unit.forbidden).
    terrifying_gaze,
    /// The Griffin's debuff aura row on enemy shooters: no ranged attack while it stands.
    range_null_field_aura,
    /// The White Tiger's own buff aura row (it lands only on Disguise holders).
    disguise_aura,
    /// The Disguise markers (System spells, 1 lap): Hidden (a buff: untargetable) or Visible (a debuff).
    hidden,
    visible,
    /// Manticore's census blessing: a magic-resist term on every ally.
    warding_mane_blessing,
    /// Behemoth's mass cast: +power steps_mod and maximum damage rolls.
    battle_roar,
    // batch 5: Spit Ball's debuffs (spells.json Death and Order configs, recorded in `init.spellConfigs`)
    /// Every damage roll of its holder is the minimum (unless Blessing or Battle Roar).
    curse,
    /// MIND: morale -20 and no morale change.
    sadness,
    /// steps and steps_mod x (100 - power) / 100.
    quagmire,
    /// The base-armor multiplier x (100 - power) / 100, before Heavy Armor.
    weakening_beam,
    /// attack_mod -= power% of the running base attack.
    weakness,
    /// MIND: no ranged attack or counter-shot (only an attack_type RANGE target receives it).
    rangebane,
    /// MIND: no strike, response or switch onto an enemy with more cumulative hp.
    cowardice,

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
            .blessing => "Blessing",
            .vine_throw => "Vine Throw",
            .sylvan_focus_blessing => "Sylvan Focus Blessing",
            .deep_wounds => "Deep Wounds",
            .boar_saliva => "Boar Saliva",
            .terrifying_gaze => "Terrifying Gaze",
            .range_null_field_aura => "Range Null Field Aura",
            .disguise_aura => "Disguise Aura",
            .hidden => "Hidden",
            .visible => "Visible",
            .warding_mane_blessing => "Warding Mane Blessing",
            .battle_roar => "Battle Roar",
            .curse => "Curse",
            .sadness => "Sadness",
            .quagmire => "Quagmire",
            .weakening_beam => "Weakening Beam",
            .weakness => "Weakness",
            .rangebane => "Rangebane",
            .cowardice => "Cowardice",
        };
    }

    /// Spit Ball's candidates (POSSIBLE_DEBUFFS_TO_FACTIONS, spit_ball_ability.ts), in roll order.
    pub const SPIT_BALL = [_]SpellId{ .curse, .sadness, .quagmire, .weakening_beam, .weakness, .rangebane, .cowardice };

    /// One of Spit Ball's seven debuffs.
    pub inline fn isSpitBall(self: SpellId) bool {
        return @intFromEnum(self) >= @intFromEnum(SpellId.curse) and @intFromEnum(self) <= @intFromEnum(SpellId.cowardice);
    }

    /// An augment buff (UnitsHolder.applyAugments).
    pub inline fn isAugment(self: SpellId) bool {
        return @intFromEnum(self) >= @intFromEnum(SpellId.armor_augment) and @intFromEnum(self) <= @intFromEnum(SpellId.empower_augment);
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
/// `applied_*` display arrays. They agree while a name sits once in a list; only a Magic Reflection mirror of a Spit
/// Ball debuff appends a second debuff row of a name (applyDebuff never checks), and then every live object row of the
/// name ticks every display entry of it in Unit.minusLap, so a row's display laps (`laps - lag`) fall faster than its
/// object laps (`laps`, which govern expiry).
pub const AppliedSpell = struct {
    id: SpellId,
    /// firstSpellProperty / secondSpellProperty: an aura row's source cell (the emitter's base cell, buff or debuff
    /// rows), the Sniper Augment's base-attack and shot-distance percentages (27 and 70 at level 3), else -1
    /// (undefined). Rows that store their power there (the census blessings, Miner) keep it as the row's power.
    src_x: i8 = -1,
    src_y: i8 = -1,
    laps: f64,
    power: f64 = 0,
    /// Object laps minus display laps (applied_*_laps): 0 except on duplicate debuff rows (see above).
    lag: i16 = 0,

    /// The display laps (the digest's `*_laps` columns).
    pub inline fn shownLaps(self: AppliedSpell) f64 {
        return if (self.lag == 0) self.laps else self.laps - @as(f64, @floatFromInt(self.lag));
    }
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
pub const AbilityMask = u128;

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
    // spells (wave 1): the casters' spellbook cards (INFO, power type SPELLBOOK: read only by Predatory Assimilation,
    // which moves the card's remaining charges), the Magic Dragon's rebound and the Satyr's stack blessing
    book_of_healing,
    basic_tome_of_battle_magic,
    forest_spellbook,
    tome_of_elements,
    magic_reflection,
    sylvan_focus_blessing,
    // batch 4
    /// The mindless pin: the unit plays v0.1 whatever its seat (no engine reader).
    ai_driven,
    deep_wounds_level_0,
    deep_wounds_level_1,
    deep_wounds_level_2,
    deep_wounds_level_3,
    boar_saliva,
    range_null_field_aura,
    sky_runner,
    disguise_aura,
    warding_mane_blessing,
    terrifying_gaze,
    unyielding_power,
    /// Castable: one ":Battle Roar" charge, a mass cast on every ally.
    battle_roar,
    /// Castable and giftable: the regeneration at activation, and the ":Wild Regeneration" charge that gives it away.
    wild_regeneration,
    // batch 5: the shooters and throwers
    /// Arbalester: no distance bands (divisor 1); setPosition rewrites shot_distance from the position it leaves.
    sniper,
    /// Arbalester: range_shots capped at floor(maxRangeShots * stack power / 5) + the Rallying Volley arrows.
    limited_supply,
    /// Elf: a second single-target shot after the counter-shot and the switch.
    double_shot,
    /// Medusa: range_shots_mod 99 and shots that cost nothing; a melee thief shoots from 6.5.
    endless_quiver,
    /// Medusa (MIND): a share of the hit's damage in whole creatures, and a petrify roll.
    petrifying_gaze,
    /// Beholder: up to seven random debuffs per landed shot.
    spit_ball,
    /// Cyclops: a stack-powered splash on the 3x3 around the cell the ray entered; rays pass stones.
    large_caliber,
    /// Tsar Cannon: Madness's morale lock, MIND, poison and heal immunity, x1.5 from physical AOE and STATUS cards.
    mechanism,
    /// Tsar Cannon: no MELEE attack type, no melee strike or response.
    no_melee,
    /// Tsar Cannon: every enemy on the line to the field edge, no counter-shot either way.
    through_shot,
    /// Gargantuan: a second splash (Area Throw's multiplier) after the counter-shot and the switch.
    double_throw,
    /// Gargantuan: the flat splash, and the cell-aimed area_throw_attack.
    area_throw,
    /// Centaur: the target's armor x (1 - multiplier) in every damage band the holder rolls.
    piercing_spear,
    /// Centaur: max hp x (1 + multiplier) at every refresh.
    boost_health,

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
            .book_of_healing => "Book of Healing",
            .basic_tome_of_battle_magic => "Basic Tome of Battle Magic",
            .forest_spellbook => "Forest Spellbook",
            .tome_of_elements => "Tome of Elements",
            .magic_reflection => "Magic Reflection",
            .sylvan_focus_blessing => "Sylvan Focus Blessing",
            .ai_driven => "AI Driven",
            .deep_wounds_level_0 => "Deep Wounds Level 0",
            .deep_wounds_level_1 => "Deep Wounds Level 1",
            .deep_wounds_level_2 => "Deep Wounds Level 2",
            .deep_wounds_level_3 => "Deep Wounds Level 3",
            .boar_saliva => "Boar Saliva",
            .range_null_field_aura => "Range Null Field Aura",
            .sky_runner => "Sky Runner",
            .disguise_aura => "Disguise Aura",
            .warding_mane_blessing => "Warding Mane Blessing",
            .terrifying_gaze => "Terrifying Gaze",
            .unyielding_power => "Unyielding Power",
            .battle_roar => "Battle Roar",
            .wild_regeneration => "Wild Regeneration",
            .sniper => "Sniper",
            .limited_supply => "Limited Supply",
            .double_shot => "Double Shot",
            .endless_quiver => "Endless Quiver",
            .petrifying_gaze => "Petrifying Gaze",
            .spit_ball => "Spit Ball",
            .large_caliber => "Large Caliber",
            .mechanism => "Mechanism",
            .no_melee => "No Melee",
            .through_shot => "Through Shot",
            .double_throw => "Double Throw",
            .area_throw => "Area Throw",
            .piercing_spear => "Piercing Spear",
            .boost_health => "Boost Health",
        };
    }

    /// A SPELLBOOK card (unit.ts SPELLBOOK_SPELL_NAMES): whether it owns the charges of `spell`.
    pub fn ownsSpell(self: AbilityId, spell: CastSpell) bool {
        return switch (self) {
            .book_of_healing => spell == .heal or spell == .blessing,
            .forest_spellbook => spell == .summon_wolves,
            .basic_tome_of_battle_magic => spell == .fire_strike or spell == .meteorite,
            .tome_of_elements => spell == .lightning_strike or spell == .ring_of_fire or spell == .meteor_shower,
            else => false,
        };
    }

    pub inline fn isSpellbook(self: AbilityId) bool {
        return switch (self) {
            .book_of_healing, .basic_tome_of_battle_magic, .forest_spellbook, .tome_of_elements => true,
            else => false,
        };
    }

    /// The spell a castable ability carries (`can_be_cast`, makeAbility's System spell): Vine Throw, Battle Roar and
    /// Wild Regeneration in scope.
    pub inline fn castable(self: AbilityId) ?CastSpell {
        return switch (self) {
            .vine_throw => .vine_throw,
            .battle_roar => .battle_roar,
            .wild_regeneration => .wild_regeneration,
            else => null,
        };
    }

    /// DEEP_WOUNDS_ABILITY_NAMES (deep_wounds_ability.ts), the order processDeepWoundsAbility sums the cards in.
    pub const DEEP_WOUNDS = [_]AbilityId{ .deep_wounds_level_0, .deep_wounds_level_1, .deep_wounds_level_2, .deep_wounds_level_3 };
    pub const DEEP_WOUNDS_MASK: AbilityMask = blk: {
        var m: AbilityMask = 0;
        for (DEEP_WOUNDS) |id| m |= id.bit();
        break :blk m;
    };

    pub fn fromName(n: []const u8) ?AbilityId {
        inline for (std.meta.fields(AbilityId)) |f| {
            const id: AbilityId = @enumFromInt(f.value);
            if (std.mem.eql(u8, n, id.name())) return id;
        }
        return null;
    }

    pub inline fn bit(self: AbilityId) AbilityMask {
        return @as(AbilityMask, 1) << @as(u7, @intCast(@intFromEnum(self)));
    }

    /// The batch-5 cards (the shooters' and throwers').
    pub const BATCH5_MASK: AbilityMask = blk: {
        var m: AbilityMask = 0;
        for ([_]AbilityId{ .sniper, .limited_supply, .double_shot, .endless_quiver, .petrifying_gaze, .spit_ball, .large_caliber, .mechanism, .no_melee, .through_shot, .double_throw, .area_throw, .piercing_spear, .boost_health }) |id| m |= id.bit();
        break :blk m;
    };
};

// =====================================================================================================================
// Spells (src/spells: spells.json via getSpellConfig, Spell, the unit's spellbook)
// =====================================================================================================================

/// The spells the port casts (wave 1). A book entry of any other spell is refused at load, so a cast naming another
/// spell is necessarily `spell_not_found` (NO_SPELL in an action).
pub const CastSpell = enum(u8) {
    heal,
    blessing,
    lightning_strike,
    fire_strike,
    meteor_shower,
    meteorite,
    summon_wolves,
    vine_throw,
    ring_of_fire,
    // batch 4: castable abilities
    battle_roar,
    wild_regeneration,

    pub fn name(self: CastSpell) []const u8 {
        return switch (self) {
            .heal => "Heal",
            .blessing => "Blessing",
            .lightning_strike => "Lightning Strike",
            .fire_strike => "Fire Strike",
            .meteor_shower => "Meteor Shower",
            .meteorite => "Meteorite",
            .summon_wolves => "Summon Wolves",
            .vine_throw => "Vine Throw",
            .ring_of_fire => "Ring of Fire",
            .battle_roar => "Battle Roar",
            .wild_regeneration => "Wild Regeneration",
        };
    }

    pub fn fromName(n: []const u8) ?CastSpell {
        inline for (std.meta.fields(CastSpell)) |f| {
            const id: CastSpell = @enumFromInt(f.value);
            if (std.mem.eql(u8, n, id.name())) return id;
        }
        return null;
    }

    /// The buff or debuff of the same name a target can carry (canCastSpell's notAlreadyApplied), if any in scope.
    pub fn applied(self: CastSpell) ?SpellId {
        return switch (self) {
            .blessing => .blessing,
            .vine_throw => .vine_throw,
            .battle_roar => .battle_roar,
            else => null,
        };
    }

    /// The ability a giftable spell hands over (handleMagicAttack's giftable HEAL branch: the spell's own name).
    pub fn gifted(self: CastSpell) ?AbilityId {
        return if (self == .wild_regeneration) .wild_regeneration else null;
    }
};

pub const N_CAST_SPELLS = @typeInfo(CastSpell).@"enum".fields.len;
/// A cast or book entry naming a spell outside CastSpell.
pub const NO_SPELL: u8 = 0xff;

/// SpellTargetType, SpellPowerType, SpellMultiplierType and SpellElement (src/spells/spell_properties.ts).
pub const SpellTarget = struct {
    pub const FREE_CELL: u8 = 1;
    pub const ANY_ALLY: u8 = 2;
    pub const RANDOM_CLOSE_TO_CASTER: u8 = 3;
    pub const ALL_ALLIES: u8 = 4;
    pub const ALL_ENEMIES: u8 = 5;
    pub const ANY_ENEMY: u8 = 6;
    pub const ALL_FLYING: u8 = 8;
    pub const ENEMY_WITHIN_MOVEMENT_RANGE: u8 = 9;
    pub const ALLIES_AREA: u8 = 11;
};
pub const SpellPower = struct {
    pub const COMMON: u8 = 1;
    pub const MIND: u8 = 2;
    pub const HEAL: u8 = 3;
    pub const POSITION_CHANGE: u8 = 4;
    pub const RESURRECT: u8 = 5;
};
pub const SpellMultiplier = struct {
    pub const NO_MULTIPLIER: u8 = 1;
    /// The mass buff's power is the caster's creatures alive (Battle Roar).
    pub const UNIT_AMOUNT: u8 = 2;
    pub const UNIT_AMOUNT_POWER: u8 = 3;
    pub const UNIT_AMOUNT_DAMAGE: u8 = 6;
};
pub const Element = struct {
    pub const NONE: u8 = 0;
    pub const FIRE: u8 = 1;
    pub const WATER: u8 = 2;
    pub const AIR: u8 = 3;
    pub const EARTH: u8 = 4;
    /// No element argument at all (a creature's hit): Unit.applyDamage's `damageElement` undefined.
    pub const UNSET: u8 = 0xff;
};

/// One spell's configuration (getSpellConfig(faction, name): recorded in `init.spellConfigs`, or the export's Spell
/// objects' spellProperties). Every number the cast reads comes from here.
pub const SpellConfig = struct {
    power: f64 = 0,
    laps: f64 = 0,
    min_stack_power: f64 = 0,
    target: u8 = 0,
    power_type: u8 = 0,
    multiplier: u8 = 0,
    element: u8 = 0,
    is_buff: bool = false,
    self_cast: bool = false,
    /// conflicts_with names in scope (a SpellId a target can carry); names outside the port can never be carried.
    conflict: ?SpellId = null,
    /// is_giftable / maximum_gift_level: a HEAL spell that hands its ability to an ally of at most that level.
    is_giftable: bool = false,
    max_gift_level: f64 = 0,
    loaded: bool = false,
};

/// One Spit Ball debuff's config: laps, power and whether its power type is MIND.
pub const SpitConfig = struct {
    laps: f64 = 0,
    power: f64 = 0,
    mind: bool = false,
    loaded: bool = false,
};

/// One raw spell entry (unitProperties.spells "<Faction>:<Name>"): the spell and its faction prefix.
pub const BookEntry = struct {
    spell: u8,
    prefix: u8,

    /// The prefix codes: an empty faction (":Vine Throw", a castable ability), "System:", then the factions.
    pub const NO_FACTION: u8 = 0;
    pub const SYSTEM: u8 = 1;
    pub const PREFIXES = [_][]const u8{ "", "System", "Life", "Nature", "Chaos", "Might" };

    /// normalizeSpellEntry: "System:X" is ":X" (parseSpellData keys and the castable-entry checks).
    pub inline fn normalized(self: BookEntry) u8 {
        return if (self.prefix == SYSTEM) NO_FACTION else self.prefix;
    }
};

/// One parsed Spell (Unit.getSpells(), parseSpells): one per distinct normalized entry in first-occurrence order, with
/// its remaining charges. A spent Spell stays (amount 0) until the next re-parse.
pub const BookSpell = struct {
    spell: u8,
    prefix: u8,
    amount: u8,
};

/// Raw entries a unit can hold (Healer's Heal x4 + Blessing x2 is the largest wave-1 book; a Queen may steal two).
pub const MAX_BOOK = 16;
pub const MAX_BOOK_SPELLS = 6;

/// One vined cell (src/spells/vines.ts Vine): laps remaining and the thrower's team.
pub const Vine = struct {
    x: u8,
    y: u8,
    laps: i16,
    team: u8,
};

/// FightProperties.vines: one entry per cell in Map insertion order (a re-throw replaces the entry in place).
pub const MAX_VINES = 96;

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
    /// Endless Quiver: projectShotCost reads it (a holder's volleys cost no arrow).
    pub const UNLIMITED_SUPPLIES: u8 = 4;
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
    /// The Range Null Field aura (Griffin): it lands only on RANGE creatures and carries no power.
    pub const DISABLE_RANGE_ATTACK: u8 = 17;
    /// The Disguise aura (White Tiger): it lands only on its holders and carries no power.
    pub const UNTARGETABLE: u8 = 46;
};

/// AbilityType values the ported processors branch on.
pub const AbilityKind = struct {
    /// A STATUS card (Stun, Shatter Armor): x1.5 on a Mechanism target.
    pub const STATUS: u8 = 7;
    /// A MIND ability (Aggr, Boar Saliva, Terrifying Gaze, Petrifying Gaze): Madness and Mechanism resist its effect.
    pub const MIND: u8 = 13;
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
    /// unitProperties.spells: one raw entry per remaining charge, in order (useSpell removes the LAST of a name).
    book: [MAX_BOOK]BookEntry = undefined,
    n_book: u8 = 0,
    /// Unit.getSpells(): the parsed book (parseSpells), spent spells included until the next re-parse.
    spells: [MAX_BOOK_SPELLS]BookSpell = undefined,
    n_spells: u8 = 0,
    /// Unit.summoned: created by a summon (Infest, Summon Wolves); the merge target of a Summon Wolves cast.
    summoned: bool = false,
    /// unitProperties.forbidden_target (Terrifying Gaze): the uid of the gazer this unit may not attack or answer
    /// (NO_UID = ""). An id, not a slot: TypeScript keeps it after the gazer dies, until the effect is gone.
    forbidden: u8 = NO_UID,
    /// Unit.maxRangeShots: the constructor's range_shots (the creature config), hidden; Limited Supply's cap reads it.
    max_range_shots: f64 = 0,

    pub fn isDead(self: *const Unit) bool {
        return self.amount_alive <= 0;
    }

    /// unitProperties.can_cast_spells (every mutator keeps it at spells.length > 0).
    pub inline fn canCastSpells(self: *const Unit) bool {
        return self.n_book > 0;
    }

    /// getSpellsCount(): no spells while Broken.
    pub inline fn spellsCount(self: *const Unit) u8 {
        if (self.n_book == 0 or self.isBroken()) return 0;
        return self.n_book;
    }

    /// The first parsed Spell of that spell (getSpells().find(name)).
    pub fn bookSpell(self: *const Unit, spell: u8) ?*const BookSpell {
        for (self.spells[0..self.n_spells]) |*b| if (b.spell == spell) return b;
        return null;
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

    /// cannotAttackUnitId(id): the raw forbidden id (no liveness check, not Break-aware).
    pub inline fn cannotAttack(self: *const Unit, target_uid: u8) bool {
        return self.forbidden != NO_UID and self.forbidden == target_uid;
    }

    /// hasBuffActive("Hidden")
    pub inline fn isHidden(self: *const Unit) bool {
        return self.buffs.len != 0 and self.buffs.find(.hidden) != null;
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

    /// FightProperties.vines (Vine Throw): the vined cells in Map order, and a bit per cell (bit y of vine_cells[x]).
    vines: [MAX_VINES]Vine = undefined,
    n_vines: u8 = 0,
    vine_cells: [GRID]u16 = .{0} ** GRID,

    /// getAlreadyMadeTurnSize: the units in `made` plus the removed ones it still names.
    pub fn madeCount(self: *const Fight) u32 {
        return @as(u32, @popCount(self.made)) + self.removed_made.count();
    }

    /// Vines.has(cell)
    pub inline fn hasVine(self: *const Fight, x: i32, y: i32) bool {
        if (self.n_vines == 0 or x < 0 or y < 0 or x >= GRID or y >= GRID) return false;
        return self.vine_cells[@intCast(x)] & (@as(u16, 1) << @intCast(y)) != 0;
    }

    /// Vines.teamAt(cell)
    pub fn vineTeam(self: *const Fight, x: i32, y: i32) ?u8 {
        if (!self.hasVine(x, y)) return null;
        for (self.vines[0..self.n_vines]) |v| {
            if (v.x == x and v.y == y) return v.team;
        }
        return null;
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

/// The creatures summons raise, as createUnitFromSpec builds them (recorded `init.summonTemplates`, or the export's
/// `configs.summonTemplates`): the props and base stats of a fresh stack of one, its abilities and auras. Shared and
/// immutable (engine.internSummons), so a State only points at it.
pub const Summons = struct {
    /// Index SPIDER: "Arachna Spider" (a level 1-3 corpse), QUEEN: "Arachna Queen" (a level-4 corpse), WOLF: "Wolf"
    /// (Summon Wolves).
    units: [N_SUMMONS]Unit,
    present: [N_SUMMONS]bool = .{false} ** N_SUMMONS,

    pub const SPIDER = 0;
    pub const QUEEN = 1;
    pub const WOLF = 2;
};

pub const N_SUMMONS = 3;
pub const SUMMON_NAMES = [N_SUMMONS][]const u8{ "Arachna Spider", "Arachna Queen", "Wolf" };

/// The id a summon gets: runMatch's deterministicSimulationId("summon", seed, ..., summon_seq) (`match`), or the
/// server's createSecureUuid() under a seeded source, the "sim" UUID of deterministicUuidSequence (`uuid_sequence`).
pub const IdScheme = enum(u8) { match, uuid_sequence };

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
    /// lib.ts deterministicUuidSequence: every unit a summon constructs takes one value (UnitProperties' id), and
    /// under `IdScheme.uuid_sequence` its id is createSecureUuid's "sim" UUID of that value.
    uuid_seq: u64 = 0,
    /// How a summon is named (runMatch's createSummonedUnit, or the server's, which keeps createSecureUuid's id).
    id_scheme: IdScheme = .match,
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
    /// Some unit holds a spell entry (or a cast row: Blessing, the Vine Throw snare), so adjustBaseStats reads them.
    spell_hooks: bool = false,
    /// The "Break" effect's configured laps and power (effects.json, recorded in `init.effectConfigs.Break`).
    break_laps: f64,
    break_power: f64,
    /// The name ids of "Arachna Spider", "Arachna Queen" and "Wolf" (Unit.name_id of a summon).
    summon_name_id: [N_SUMMONS]u16 = .{0xffff} ** N_SUMMONS,
    /// The configs of the spells the battle can cast (by CastSpell), and whether any unit holds a spell entry.
    spell_cfg: [N_CAST_SPELLS]SpellConfig = .{SpellConfig{}} ** N_CAST_SPELLS,
    /// Batch-4 gates (loadScopeFlags): some unit can hold the Range Null Field aura (or carries its row), and some unit
    /// can hold Disguise (or carries a Hidden / Visible marker). They keep the ability-free path free of the scans.
    null_field: bool = false,
    disguise: bool = false,
    /// Some unit can hold Unyielding Power or Sky Runner: adjustBaseStats runs their hooks.
    unit_hooks: bool = false,
    /// Some unit can hold Terrifying Gaze (or is frightened at load): the forbidden-target gates and reset run.
    gaze: bool = false,
    /// The Disguise aura's configured range (the swap reads AuraEffect.getRange() of the config) and the System
    /// "Hidden" / "Visible" markers' laps and powers (recorded `spellConfigs`).
    disguise_range: f64 = 0,
    hidden_laps: f64 = 1,
    hidden_power: f64 = 0,
    visible_laps: f64 = 1,
    visible_power: f64 = 0,
    /// Batch-5 gates (loadScopeFlags): some unit can hold Spit Ball or carries one of its debuffs (the debuff stat hooks,
    /// the Sadness morale lock, the Rangebane and Cowardice gates), and some unit can hold Limited Supply, Endless
    /// Quiver or Boost Health (their refresh hooks).
    spit: bool = false,
    shot_hooks: bool = false,
    /// Spit Ball's debuff configs (getSpellConfig of Death / Order, recorded `spellConfigs`), by SpellId.SPIT_BALL index.
    spit_cfg: [7]SpitConfig = .{SpitConfig{}} ** 7,

    /// cannotAttackUnitId on battles where a gaze can land (Unit.forbidden is never set otherwise).
    pub inline fn forbids(self: *const State, u: *const Unit, target_uid: u8) bool {
        return self.gaze and u.cannotAttack(target_uid);
    }

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
