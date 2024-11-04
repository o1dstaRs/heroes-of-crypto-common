import protobuf from "protobufjs";

const protoFile = `
syntax = "proto3";

package battlefield;

enum Race {
  CHAOS = 0;
  MIGHT = 1;
  NATURE = 2;
  LIFE = 3;
}

enum Team {
  NO_TEAM = 0;
  UPPER = 1;
  LOWER = 2;
}

enum AttackType {
  MELEE = 0;
  RANGE = 1;
  MAGIC = 2;
}

enum UnitSize {
  SMALL = 0;
  LARGE = 1;
}

enum UnitLevel {
  FIRST = 0;
  SECOND = 1;
  THIRD = 2;
  FOURTH = 3;
}

message Unit {
  bytes id = 1;
  Race race = 2;
  string name = 3;
  Team team = 4;
  uint32 max_hp = 5;
  uint32 hp = 6;
  float steps = 7;
  float steps_mod = 8;
  int32 morale = 9;
  int32 luck = 10;
  uint32 speed = 11;
  float armor_mod = 12;
  float base_armor = 13;
  AttackType attack_type = 14;
  AttackType attack_type_selected = 15;
  uint32 attack = 16;
  uint32 attack_damage_min = 17;
  uint32 attack_damage_max = 18;
  uint32 attack_range = 19;
  uint32 range_shots = 20;
  uint32 range_shots_mod = 21;
  float shot_distance = 22;
  uint32 magic_resist = 23;
  uint32 magic_resist_mod = 24;
  bool can_cast_spells = 25;
  bool can_fly = 26;
  float exp = 27;
  UnitSize size = 28;
  UnitLevel level = 29;
  repeated string spells = 30;
  repeated string abilities = 31;
  repeated string effects = 32;
  uint32 amount_alive = 33;
  uint32 amount_died = 34;
  int32 luck_mod = 35;
  float attack_multiplier = 36;
}
`;

const root = protobuf.parse(protoFile).root;

// Get the Unit message type
const Unit = root.lookupType("battlefield.Unit");

// Extract fields and their types
const fields = Unit.fields;
const result = {};
Object.keys(fields).forEach((key) => {
    result[key] = fields[key].type;
});

// eslint-disable-next-line no-undef
console.log(result);
