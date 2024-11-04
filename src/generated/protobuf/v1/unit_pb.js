// source: unit.proto
/**
 * @fileoverview
 * @enhanceable
 * @suppress {missingRequire} reports error on implicit type usages.
 * @suppress {messageConventions} JS Compiler reports an error if a variable or
 *     field starts with 'MSG_' and isn't a translatable message.
 * @public
 */
// GENERATED CODE -- DO NOT EDIT!
/* eslint-disable */
// @ts-nocheck

var jspb = require('google-protobuf');
var goog = jspb;
var global =
    (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof window !== 'undefined' && window) ||
    (typeof global !== 'undefined' && global) ||
    (typeof self !== 'undefined' && self) ||
    (function () { return this; }).call(null) ||
    Function('return this')();

var types_pb = require('./types_pb.js');
goog.object.extend(proto, types_pb);
goog.exportSymbol('proto.public.Unit', null, global);
/**
 * Generated by JsPbCodeGenerator.
 * @param {Array=} opt_data Optional initial data array, typically from a
 * server response, or constructed directly in Javascript. The array is used
 * in place and becomes part of the constructed object. It is not cloned.
 * If no data is provided, the constructed object will be empty, but still
 * valid.
 * @extends {jspb.Message}
 * @constructor
 */
proto.public.Unit = function(opt_data) {
  jspb.Message.initialize(this, opt_data, 0, -1, proto.public.Unit.repeatedFields_, null);
};
goog.inherits(proto.public.Unit, jspb.Message);
if (goog.DEBUG && !COMPILED) {
  /**
   * @public
   * @override
   */
  proto.public.Unit.displayName = 'proto.public.Unit';
}

/**
 * List of repeated fields within this message type.
 * @private {!Array<number>}
 * @const
 */
proto.public.Unit.repeatedFields_ = [30,31,32];



if (jspb.Message.GENERATE_TO_OBJECT) {
/**
 * Creates an object representation of this proto.
 * Field names that are reserved in JavaScript and will be renamed to pb_name.
 * Optional fields that are not set will be set to undefined.
 * To access a reserved field use, foo.pb_<name>, eg, foo.pb_default.
 * For the list of reserved names please see:
 *     net/proto2/compiler/js/internal/generator.cc#kKeyword.
 * @param {boolean=} opt_includeInstance Deprecated. whether to include the
 *     JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @return {!Object}
 */
proto.public.Unit.prototype.toObject = function(opt_includeInstance) {
  return proto.public.Unit.toObject(opt_includeInstance, this);
};


/**
 * Static version of the {@see toObject} method.
 * @param {boolean|undefined} includeInstance Deprecated. Whether to include
 *     the JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @param {!proto.public.Unit} msg The msg instance to transform.
 * @return {!Object}
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.public.Unit.toObject = function(includeInstance, msg) {
  var f, obj = {
    id: msg.getId_asB64(),
    race: jspb.Message.getFieldWithDefault(msg, 2, 0),
    name: jspb.Message.getFieldWithDefault(msg, 3, ""),
    team: jspb.Message.getFieldWithDefault(msg, 4, 0),
    maxHp: jspb.Message.getFieldWithDefault(msg, 5, 0),
    hp: jspb.Message.getFieldWithDefault(msg, 6, 0),
    steps: jspb.Message.getFloatingPointFieldWithDefault(msg, 7, 0.0),
    stepsMod: jspb.Message.getFloatingPointFieldWithDefault(msg, 8, 0.0),
    morale: jspb.Message.getFieldWithDefault(msg, 9, 0),
    luck: jspb.Message.getFieldWithDefault(msg, 10, 0),
    speed: jspb.Message.getFieldWithDefault(msg, 11, 0),
    armorMod: jspb.Message.getFloatingPointFieldWithDefault(msg, 12, 0.0),
    baseArmor: jspb.Message.getFloatingPointFieldWithDefault(msg, 13, 0.0),
    attackType: jspb.Message.getFieldWithDefault(msg, 14, 0),
    attackTypeSelected: jspb.Message.getFieldWithDefault(msg, 15, 0),
    attack: jspb.Message.getFieldWithDefault(msg, 16, 0),
    attackDamageMin: jspb.Message.getFieldWithDefault(msg, 17, 0),
    attackDamageMax: jspb.Message.getFieldWithDefault(msg, 18, 0),
    attackRange: jspb.Message.getFieldWithDefault(msg, 19, 0),
    rangeShots: jspb.Message.getFieldWithDefault(msg, 20, 0),
    rangeShotsMod: jspb.Message.getFieldWithDefault(msg, 21, 0),
    shotDistance: jspb.Message.getFloatingPointFieldWithDefault(msg, 22, 0.0),
    magicResist: jspb.Message.getFieldWithDefault(msg, 23, 0),
    magicResistMod: jspb.Message.getFieldWithDefault(msg, 24, 0),
    canCastSpells: jspb.Message.getBooleanFieldWithDefault(msg, 25, false),
    canFly: jspb.Message.getBooleanFieldWithDefault(msg, 26, false),
    exp: jspb.Message.getFloatingPointFieldWithDefault(msg, 27, 0.0),
    size: jspb.Message.getFieldWithDefault(msg, 28, 0),
    level: jspb.Message.getFieldWithDefault(msg, 29, 0),
    spellsList: (f = jspb.Message.getRepeatedField(msg, 30)) == null ? undefined : f,
    abilitiesList: (f = jspb.Message.getRepeatedField(msg, 31)) == null ? undefined : f,
    effectsList: (f = jspb.Message.getRepeatedField(msg, 32)) == null ? undefined : f,
    amountAlive: jspb.Message.getFieldWithDefault(msg, 33, 0),
    amountDied: jspb.Message.getFieldWithDefault(msg, 34, 0),
    luckMod: jspb.Message.getFieldWithDefault(msg, 35, 0),
    attackMultiplier: jspb.Message.getFloatingPointFieldWithDefault(msg, 36, 0.0)
  };

  if (includeInstance) {
    obj.$jspbMessageInstance = msg;
  }
  return obj;
};
}


/**
 * Deserializes binary data (in protobuf wire format).
 * @param {jspb.ByteSource} bytes The bytes to deserialize.
 * @return {!proto.public.Unit}
 */
proto.public.Unit.deserializeBinary = function(bytes) {
  var reader = new jspb.BinaryReader(bytes);
  var msg = new proto.public.Unit;
  return proto.public.Unit.deserializeBinaryFromReader(msg, reader);
};


/**
 * Deserializes binary data (in protobuf wire format) from the
 * given reader into the given message object.
 * @param {!proto.public.Unit} msg The message object to deserialize into.
 * @param {!jspb.BinaryReader} reader The BinaryReader to use.
 * @return {!proto.public.Unit}
 */
proto.public.Unit.deserializeBinaryFromReader = function(msg, reader) {
  while (reader.nextField()) {
    if (reader.isEndGroup()) {
      break;
    }
    var field = reader.getFieldNumber();
    switch (field) {
    case 1:
      var value = /** @type {!Uint8Array} */ (reader.readBytes());
      msg.setId(value);
      break;
    case 2:
      var value = /** @type {!proto.public.Race} */ (reader.readEnum());
      msg.setRace(value);
      break;
    case 3:
      var value = /** @type {string} */ (reader.readString());
      msg.setName(value);
      break;
    case 4:
      var value = /** @type {!proto.public.Team} */ (reader.readEnum());
      msg.setTeam(value);
      break;
    case 5:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setMaxHp(value);
      break;
    case 6:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setHp(value);
      break;
    case 7:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setSteps(value);
      break;
    case 8:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setStepsMod(value);
      break;
    case 9:
      var value = /** @type {number} */ (reader.readInt32());
      msg.setMorale(value);
      break;
    case 10:
      var value = /** @type {number} */ (reader.readInt32());
      msg.setLuck(value);
      break;
    case 11:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setSpeed(value);
      break;
    case 12:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setArmorMod(value);
      break;
    case 13:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setBaseArmor(value);
      break;
    case 14:
      var value = /** @type {!proto.public.AttackType} */ (reader.readEnum());
      msg.setAttackType(value);
      break;
    case 15:
      var value = /** @type {!proto.public.AttackType} */ (reader.readEnum());
      msg.setAttackTypeSelected(value);
      break;
    case 16:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setAttack(value);
      break;
    case 17:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setAttackDamageMin(value);
      break;
    case 18:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setAttackDamageMax(value);
      break;
    case 19:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setAttackRange(value);
      break;
    case 20:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setRangeShots(value);
      break;
    case 21:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setRangeShotsMod(value);
      break;
    case 22:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setShotDistance(value);
      break;
    case 23:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setMagicResist(value);
      break;
    case 24:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setMagicResistMod(value);
      break;
    case 25:
      var value = /** @type {boolean} */ (reader.readBool());
      msg.setCanCastSpells(value);
      break;
    case 26:
      var value = /** @type {boolean} */ (reader.readBool());
      msg.setCanFly(value);
      break;
    case 27:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setExp(value);
      break;
    case 28:
      var value = /** @type {!proto.public.UnitSize} */ (reader.readEnum());
      msg.setSize(value);
      break;
    case 29:
      var value = /** @type {!proto.public.UnitLevel} */ (reader.readEnum());
      msg.setLevel(value);
      break;
    case 30:
      var value = /** @type {string} */ (reader.readString());
      msg.addSpells(value);
      break;
    case 31:
      var value = /** @type {string} */ (reader.readString());
      msg.addAbilities(value);
      break;
    case 32:
      var value = /** @type {string} */ (reader.readString());
      msg.addEffects(value);
      break;
    case 33:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setAmountAlive(value);
      break;
    case 34:
      var value = /** @type {number} */ (reader.readUint32());
      msg.setAmountDied(value);
      break;
    case 35:
      var value = /** @type {number} */ (reader.readInt32());
      msg.setLuckMod(value);
      break;
    case 36:
      var value = /** @type {number} */ (reader.readDouble());
      msg.setAttackMultiplier(value);
      break;
    default:
      reader.skipField();
      break;
    }
  }
  return msg;
};


/**
 * Serializes the message to binary data (in protobuf wire format).
 * @return {!Uint8Array}
 */
proto.public.Unit.prototype.serializeBinary = function() {
  var writer = new jspb.BinaryWriter();
  proto.public.Unit.serializeBinaryToWriter(this, writer);
  return writer.getResultBuffer();
};


/**
 * Serializes the given message to binary data (in protobuf wire
 * format), writing to the given BinaryWriter.
 * @param {!proto.public.Unit} message
 * @param {!jspb.BinaryWriter} writer
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.public.Unit.serializeBinaryToWriter = function(message, writer) {
  var f = undefined;
  f = message.getId_asU8();
  if (f.length > 0) {
    writer.writeBytes(
      1,
      f
    );
  }
  f = message.getRace();
  if (f !== 0.0) {
    writer.writeEnum(
      2,
      f
    );
  }
  f = message.getName();
  if (f.length > 0) {
    writer.writeString(
      3,
      f
    );
  }
  f = message.getTeam();
  if (f !== 0.0) {
    writer.writeEnum(
      4,
      f
    );
  }
  f = message.getMaxHp();
  if (f !== 0) {
    writer.writeUint32(
      5,
      f
    );
  }
  f = message.getHp();
  if (f !== 0) {
    writer.writeUint32(
      6,
      f
    );
  }
  f = message.getSteps();
  if (f !== 0.0) {
    writer.writeDouble(
      7,
      f
    );
  }
  f = message.getStepsMod();
  if (f !== 0.0) {
    writer.writeDouble(
      8,
      f
    );
  }
  f = message.getMorale();
  if (f !== 0) {
    writer.writeInt32(
      9,
      f
    );
  }
  f = message.getLuck();
  if (f !== 0) {
    writer.writeInt32(
      10,
      f
    );
  }
  f = message.getSpeed();
  if (f !== 0) {
    writer.writeUint32(
      11,
      f
    );
  }
  f = message.getArmorMod();
  if (f !== 0.0) {
    writer.writeDouble(
      12,
      f
    );
  }
  f = message.getBaseArmor();
  if (f !== 0.0) {
    writer.writeDouble(
      13,
      f
    );
  }
  f = message.getAttackType();
  if (f !== 0.0) {
    writer.writeEnum(
      14,
      f
    );
  }
  f = message.getAttackTypeSelected();
  if (f !== 0.0) {
    writer.writeEnum(
      15,
      f
    );
  }
  f = message.getAttack();
  if (f !== 0) {
    writer.writeUint32(
      16,
      f
    );
  }
  f = message.getAttackDamageMin();
  if (f !== 0) {
    writer.writeUint32(
      17,
      f
    );
  }
  f = message.getAttackDamageMax();
  if (f !== 0) {
    writer.writeUint32(
      18,
      f
    );
  }
  f = message.getAttackRange();
  if (f !== 0) {
    writer.writeUint32(
      19,
      f
    );
  }
  f = message.getRangeShots();
  if (f !== 0) {
    writer.writeUint32(
      20,
      f
    );
  }
  f = message.getRangeShotsMod();
  if (f !== 0) {
    writer.writeUint32(
      21,
      f
    );
  }
  f = message.getShotDistance();
  if (f !== 0.0) {
    writer.writeDouble(
      22,
      f
    );
  }
  f = message.getMagicResist();
  if (f !== 0) {
    writer.writeUint32(
      23,
      f
    );
  }
  f = message.getMagicResistMod();
  if (f !== 0) {
    writer.writeUint32(
      24,
      f
    );
  }
  f = message.getCanCastSpells();
  if (f) {
    writer.writeBool(
      25,
      f
    );
  }
  f = message.getCanFly();
  if (f) {
    writer.writeBool(
      26,
      f
    );
  }
  f = message.getExp();
  if (f !== 0.0) {
    writer.writeDouble(
      27,
      f
    );
  }
  f = message.getSize();
  if (f !== 0.0) {
    writer.writeEnum(
      28,
      f
    );
  }
  f = message.getLevel();
  if (f !== 0.0) {
    writer.writeEnum(
      29,
      f
    );
  }
  f = message.getSpellsList();
  if (f.length > 0) {
    writer.writeRepeatedString(
      30,
      f
    );
  }
  f = message.getAbilitiesList();
  if (f.length > 0) {
    writer.writeRepeatedString(
      31,
      f
    );
  }
  f = message.getEffectsList();
  if (f.length > 0) {
    writer.writeRepeatedString(
      32,
      f
    );
  }
  f = message.getAmountAlive();
  if (f !== 0) {
    writer.writeUint32(
      33,
      f
    );
  }
  f = message.getAmountDied();
  if (f !== 0) {
    writer.writeUint32(
      34,
      f
    );
  }
  f = message.getLuckMod();
  if (f !== 0) {
    writer.writeInt32(
      35,
      f
    );
  }
  f = message.getAttackMultiplier();
  if (f !== 0.0) {
    writer.writeDouble(
      36,
      f
    );
  }
};


/**
 * optional bytes id = 1;
 * @return {!(string|Uint8Array)}
 */
proto.public.Unit.prototype.getId = function() {
  return /** @type {!(string|Uint8Array)} */ (jspb.Message.getFieldWithDefault(this, 1, ""));
};


/**
 * optional bytes id = 1;
 * This is a type-conversion wrapper around `getId()`
 * @return {string}
 */
proto.public.Unit.prototype.getId_asB64 = function() {
  return /** @type {string} */ (jspb.Message.bytesAsB64(
      this.getId()));
};


/**
 * optional bytes id = 1;
 * Note that Uint8Array is not supported on all browsers.
 * @see http://caniuse.com/Uint8Array
 * This is a type-conversion wrapper around `getId()`
 * @return {!Uint8Array}
 */
proto.public.Unit.prototype.getId_asU8 = function() {
  return /** @type {!Uint8Array} */ (jspb.Message.bytesAsU8(
      this.getId()));
};


/**
 * @param {!(string|Uint8Array)} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setId = function(value) {
  return jspb.Message.setProto3BytesField(this, 1, value);
};


/**
 * optional Race race = 2;
 * @return {!proto.public.Race}
 */
proto.public.Unit.prototype.getRace = function() {
  return /** @type {!proto.public.Race} */ (jspb.Message.getFieldWithDefault(this, 2, 0));
};


/**
 * @param {!proto.public.Race} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setRace = function(value) {
  return jspb.Message.setProto3EnumField(this, 2, value);
};


/**
 * optional string name = 3;
 * @return {string}
 */
proto.public.Unit.prototype.getName = function() {
  return /** @type {string} */ (jspb.Message.getFieldWithDefault(this, 3, ""));
};


/**
 * @param {string} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setName = function(value) {
  return jspb.Message.setProto3StringField(this, 3, value);
};


/**
 * optional Team team = 4;
 * @return {!proto.public.Team}
 */
proto.public.Unit.prototype.getTeam = function() {
  return /** @type {!proto.public.Team} */ (jspb.Message.getFieldWithDefault(this, 4, 0));
};


/**
 * @param {!proto.public.Team} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setTeam = function(value) {
  return jspb.Message.setProto3EnumField(this, 4, value);
};


/**
 * optional uint32 max_hp = 5;
 * @return {number}
 */
proto.public.Unit.prototype.getMaxHp = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 5, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setMaxHp = function(value) {
  return jspb.Message.setProto3IntField(this, 5, value);
};


/**
 * optional uint32 hp = 6;
 * @return {number}
 */
proto.public.Unit.prototype.getHp = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 6, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setHp = function(value) {
  return jspb.Message.setProto3IntField(this, 6, value);
};


/**
 * optional double steps = 7;
 * @return {number}
 */
proto.public.Unit.prototype.getSteps = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 7, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setSteps = function(value) {
  return jspb.Message.setProto3FloatField(this, 7, value);
};


/**
 * optional double steps_mod = 8;
 * @return {number}
 */
proto.public.Unit.prototype.getStepsMod = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 8, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setStepsMod = function(value) {
  return jspb.Message.setProto3FloatField(this, 8, value);
};


/**
 * optional int32 morale = 9;
 * @return {number}
 */
proto.public.Unit.prototype.getMorale = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 9, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setMorale = function(value) {
  return jspb.Message.setProto3IntField(this, 9, value);
};


/**
 * optional int32 luck = 10;
 * @return {number}
 */
proto.public.Unit.prototype.getLuck = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 10, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setLuck = function(value) {
  return jspb.Message.setProto3IntField(this, 10, value);
};


/**
 * optional uint32 speed = 11;
 * @return {number}
 */
proto.public.Unit.prototype.getSpeed = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 11, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setSpeed = function(value) {
  return jspb.Message.setProto3IntField(this, 11, value);
};


/**
 * optional double armor_mod = 12;
 * @return {number}
 */
proto.public.Unit.prototype.getArmorMod = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 12, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setArmorMod = function(value) {
  return jspb.Message.setProto3FloatField(this, 12, value);
};


/**
 * optional double base_armor = 13;
 * @return {number}
 */
proto.public.Unit.prototype.getBaseArmor = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 13, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setBaseArmor = function(value) {
  return jspb.Message.setProto3FloatField(this, 13, value);
};


/**
 * optional AttackType attack_type = 14;
 * @return {!proto.public.AttackType}
 */
proto.public.Unit.prototype.getAttackType = function() {
  return /** @type {!proto.public.AttackType} */ (jspb.Message.getFieldWithDefault(this, 14, 0));
};


/**
 * @param {!proto.public.AttackType} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttackType = function(value) {
  return jspb.Message.setProto3EnumField(this, 14, value);
};


/**
 * optional AttackType attack_type_selected = 15;
 * @return {!proto.public.AttackType}
 */
proto.public.Unit.prototype.getAttackTypeSelected = function() {
  return /** @type {!proto.public.AttackType} */ (jspb.Message.getFieldWithDefault(this, 15, 0));
};


/**
 * @param {!proto.public.AttackType} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttackTypeSelected = function(value) {
  return jspb.Message.setProto3EnumField(this, 15, value);
};


/**
 * optional uint32 attack = 16;
 * @return {number}
 */
proto.public.Unit.prototype.getAttack = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 16, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttack = function(value) {
  return jspb.Message.setProto3IntField(this, 16, value);
};


/**
 * optional uint32 attack_damage_min = 17;
 * @return {number}
 */
proto.public.Unit.prototype.getAttackDamageMin = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 17, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttackDamageMin = function(value) {
  return jspb.Message.setProto3IntField(this, 17, value);
};


/**
 * optional uint32 attack_damage_max = 18;
 * @return {number}
 */
proto.public.Unit.prototype.getAttackDamageMax = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 18, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttackDamageMax = function(value) {
  return jspb.Message.setProto3IntField(this, 18, value);
};


/**
 * optional uint32 attack_range = 19;
 * @return {number}
 */
proto.public.Unit.prototype.getAttackRange = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 19, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttackRange = function(value) {
  return jspb.Message.setProto3IntField(this, 19, value);
};


/**
 * optional uint32 range_shots = 20;
 * @return {number}
 */
proto.public.Unit.prototype.getRangeShots = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 20, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setRangeShots = function(value) {
  return jspb.Message.setProto3IntField(this, 20, value);
};


/**
 * optional uint32 range_shots_mod = 21;
 * @return {number}
 */
proto.public.Unit.prototype.getRangeShotsMod = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 21, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setRangeShotsMod = function(value) {
  return jspb.Message.setProto3IntField(this, 21, value);
};


/**
 * optional double shot_distance = 22;
 * @return {number}
 */
proto.public.Unit.prototype.getShotDistance = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 22, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setShotDistance = function(value) {
  return jspb.Message.setProto3FloatField(this, 22, value);
};


/**
 * optional uint32 magic_resist = 23;
 * @return {number}
 */
proto.public.Unit.prototype.getMagicResist = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 23, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setMagicResist = function(value) {
  return jspb.Message.setProto3IntField(this, 23, value);
};


/**
 * optional uint32 magic_resist_mod = 24;
 * @return {number}
 */
proto.public.Unit.prototype.getMagicResistMod = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 24, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setMagicResistMod = function(value) {
  return jspb.Message.setProto3IntField(this, 24, value);
};


/**
 * optional bool can_cast_spells = 25;
 * @return {boolean}
 */
proto.public.Unit.prototype.getCanCastSpells = function() {
  return /** @type {boolean} */ (jspb.Message.getBooleanFieldWithDefault(this, 25, false));
};


/**
 * @param {boolean} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setCanCastSpells = function(value) {
  return jspb.Message.setProto3BooleanField(this, 25, value);
};


/**
 * optional bool can_fly = 26;
 * @return {boolean}
 */
proto.public.Unit.prototype.getCanFly = function() {
  return /** @type {boolean} */ (jspb.Message.getBooleanFieldWithDefault(this, 26, false));
};


/**
 * @param {boolean} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setCanFly = function(value) {
  return jspb.Message.setProto3BooleanField(this, 26, value);
};


/**
 * optional double exp = 27;
 * @return {number}
 */
proto.public.Unit.prototype.getExp = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 27, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setExp = function(value) {
  return jspb.Message.setProto3FloatField(this, 27, value);
};


/**
 * optional UnitSize size = 28;
 * @return {!proto.public.UnitSize}
 */
proto.public.Unit.prototype.getSize = function() {
  return /** @type {!proto.public.UnitSize} */ (jspb.Message.getFieldWithDefault(this, 28, 0));
};


/**
 * @param {!proto.public.UnitSize} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setSize = function(value) {
  return jspb.Message.setProto3EnumField(this, 28, value);
};


/**
 * optional UnitLevel level = 29;
 * @return {!proto.public.UnitLevel}
 */
proto.public.Unit.prototype.getLevel = function() {
  return /** @type {!proto.public.UnitLevel} */ (jspb.Message.getFieldWithDefault(this, 29, 0));
};


/**
 * @param {!proto.public.UnitLevel} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setLevel = function(value) {
  return jspb.Message.setProto3EnumField(this, 29, value);
};


/**
 * repeated string spells = 30;
 * @return {!Array<string>}
 */
proto.public.Unit.prototype.getSpellsList = function() {
  return /** @type {!Array<string>} */ (jspb.Message.getRepeatedField(this, 30));
};


/**
 * @param {!Array<string>} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setSpellsList = function(value) {
  return jspb.Message.setField(this, 30, value || []);
};


/**
 * @param {string} value
 * @param {number=} opt_index
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.addSpells = function(value, opt_index) {
  return jspb.Message.addToRepeatedField(this, 30, value, opt_index);
};


/**
 * Clears the list making it empty but non-null.
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.clearSpellsList = function() {
  return this.setSpellsList([]);
};


/**
 * repeated string abilities = 31;
 * @return {!Array<string>}
 */
proto.public.Unit.prototype.getAbilitiesList = function() {
  return /** @type {!Array<string>} */ (jspb.Message.getRepeatedField(this, 31));
};


/**
 * @param {!Array<string>} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAbilitiesList = function(value) {
  return jspb.Message.setField(this, 31, value || []);
};


/**
 * @param {string} value
 * @param {number=} opt_index
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.addAbilities = function(value, opt_index) {
  return jspb.Message.addToRepeatedField(this, 31, value, opt_index);
};


/**
 * Clears the list making it empty but non-null.
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.clearAbilitiesList = function() {
  return this.setAbilitiesList([]);
};


/**
 * repeated string effects = 32;
 * @return {!Array<string>}
 */
proto.public.Unit.prototype.getEffectsList = function() {
  return /** @type {!Array<string>} */ (jspb.Message.getRepeatedField(this, 32));
};


/**
 * @param {!Array<string>} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setEffectsList = function(value) {
  return jspb.Message.setField(this, 32, value || []);
};


/**
 * @param {string} value
 * @param {number=} opt_index
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.addEffects = function(value, opt_index) {
  return jspb.Message.addToRepeatedField(this, 32, value, opt_index);
};


/**
 * Clears the list making it empty but non-null.
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.clearEffectsList = function() {
  return this.setEffectsList([]);
};


/**
 * optional uint32 amount_alive = 33;
 * @return {number}
 */
proto.public.Unit.prototype.getAmountAlive = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 33, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAmountAlive = function(value) {
  return jspb.Message.setProto3IntField(this, 33, value);
};


/**
 * optional uint32 amount_died = 34;
 * @return {number}
 */
proto.public.Unit.prototype.getAmountDied = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 34, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAmountDied = function(value) {
  return jspb.Message.setProto3IntField(this, 34, value);
};


/**
 * optional int32 luck_mod = 35;
 * @return {number}
 */
proto.public.Unit.prototype.getLuckMod = function() {
  return /** @type {number} */ (jspb.Message.getFieldWithDefault(this, 35, 0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setLuckMod = function(value) {
  return jspb.Message.setProto3IntField(this, 35, value);
};


/**
 * optional double attack_multiplier = 36;
 * @return {number}
 */
proto.public.Unit.prototype.getAttackMultiplier = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 36, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.public.Unit} returns this
 */
proto.public.Unit.prototype.setAttackMultiplier = function(value) {
  return jspb.Message.setProto3FloatField(this, 36, value);
};


goog.object.extend(exports, proto.public);
