// source: types.proto
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

goog.exportSymbol('proto.public.AttackType', null, global);
goog.exportSymbol('proto.public.Creature', null, global);
goog.exportSymbol('proto.public.GridType', null, global);
goog.exportSymbol('proto.public.PickPhase', null, global);
goog.exportSymbol('proto.public.Race', null, global);
goog.exportSymbol('proto.public.StringList', null, global);
goog.exportSymbol('proto.public.Team', null, global);
goog.exportSymbol('proto.public.UnitLevel', null, global);
goog.exportSymbol('proto.public.UnitSize', null, global);
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
proto.public.StringList = function(opt_data) {
  jspb.Message.initialize(this, opt_data, 0, -1, proto.public.StringList.repeatedFields_, null);
};
goog.inherits(proto.public.StringList, jspb.Message);
if (goog.DEBUG && !COMPILED) {
  /**
   * @public
   * @override
   */
  proto.public.StringList.displayName = 'proto.public.StringList';
}

/**
 * List of repeated fields within this message type.
 * @private {!Array<number>}
 * @const
 */
proto.public.StringList.repeatedFields_ = [1];



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
proto.public.StringList.prototype.toObject = function(opt_includeInstance) {
  return proto.public.StringList.toObject(opt_includeInstance, this);
};


/**
 * Static version of the {@see toObject} method.
 * @param {boolean|undefined} includeInstance Deprecated. Whether to include
 *     the JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @param {!proto.public.StringList} msg The msg instance to transform.
 * @return {!Object}
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.public.StringList.toObject = function(includeInstance, msg) {
  var f, obj = {
    valuesList: (f = jspb.Message.getRepeatedField(msg, 1)) == null ? undefined : f
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
 * @return {!proto.public.StringList}
 */
proto.public.StringList.deserializeBinary = function(bytes) {
  var reader = new jspb.BinaryReader(bytes);
  var msg = new proto.public.StringList;
  return proto.public.StringList.deserializeBinaryFromReader(msg, reader);
};


/**
 * Deserializes binary data (in protobuf wire format) from the
 * given reader into the given message object.
 * @param {!proto.public.StringList} msg The message object to deserialize into.
 * @param {!jspb.BinaryReader} reader The BinaryReader to use.
 * @return {!proto.public.StringList}
 */
proto.public.StringList.deserializeBinaryFromReader = function(msg, reader) {
  while (reader.nextField()) {
    if (reader.isEndGroup()) {
      break;
    }
    var field = reader.getFieldNumber();
    switch (field) {
    case 1:
      var value = /** @type {string} */ (reader.readString());
      msg.addValues(value);
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
proto.public.StringList.prototype.serializeBinary = function() {
  var writer = new jspb.BinaryWriter();
  proto.public.StringList.serializeBinaryToWriter(this, writer);
  return writer.getResultBuffer();
};


/**
 * Serializes the given message to binary data (in protobuf wire
 * format), writing to the given BinaryWriter.
 * @param {!proto.public.StringList} message
 * @param {!jspb.BinaryWriter} writer
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.public.StringList.serializeBinaryToWriter = function(message, writer) {
  var f = undefined;
  f = message.getValuesList();
  if (f.length > 0) {
    writer.writeRepeatedString(
      1,
      f
    );
  }
};


/**
 * repeated string values = 1;
 * @return {!Array<string>}
 */
proto.public.StringList.prototype.getValuesList = function() {
  return /** @type {!Array<string>} */ (jspb.Message.getRepeatedField(this, 1));
};


/**
 * @param {!Array<string>} value
 * @return {!proto.public.StringList} returns this
 */
proto.public.StringList.prototype.setValuesList = function(value) {
  return jspb.Message.setField(this, 1, value || []);
};


/**
 * @param {string} value
 * @param {number=} opt_index
 * @return {!proto.public.StringList} returns this
 */
proto.public.StringList.prototype.addValues = function(value, opt_index) {
  return jspb.Message.addToRepeatedField(this, 1, value, opt_index);
};


/**
 * Clears the list making it empty but non-null.
 * @return {!proto.public.StringList} returns this
 */
proto.public.StringList.prototype.clearValuesList = function() {
  return this.setValuesList([]);
};


/**
 * @enum {number}
 */
proto.public.Race = {
  CHAOS: 0,
  MIGHT: 1,
  NATURE: 2,
  LIFE: 3
};

/**
 * @enum {number}
 */
proto.public.Team = {
  NO_TEAM: 0,
  UPPER: 1,
  LOWER: 2
};

/**
 * @enum {number}
 */
proto.public.AttackType = {
  MELEE: 0,
  RANGE: 1,
  MAGIC: 2,
  MELEE_MAGIC: 3
};

/**
 * @enum {number}
 */
proto.public.UnitSize = {
  NO_SIZE: 0,
  SMALL: 1,
  LARGE: 2
};

/**
 * @enum {number}
 */
proto.public.UnitLevel = {
  NO_LEVEL: 0,
  FIRST: 1,
  SECOND: 2,
  THIRD: 3,
  FOURTH: 4
};

/**
 * @enum {number}
 */
proto.public.GridType = {
  NO_TYPE: 0,
  NORMAL: 1,
  WATER_CENTER: 2,
  LAVA_CENTER: 3,
  BLOCK_CENTER: 4
};

/**
 * @enum {number}
 */
proto.public.PickPhase = {
  INITIAL_PICK: 0,
  EXTENDED_PICK: 1,
  EXTENDED_BAN: 2,
  PICK: 3,
  BAN: 4,
  ARTIFACT_1: 5,
  ARTIFACT_2: 6,
  AUGMENTS: 7,
  AUGMENTS_SCOUT: 8
};

/**
 * @enum {number}
 */
proto.public.Creature = {
  NO_CREATURE: 0,
  ORC: 1,
  SCAVENGER: 2,
  TROGLODYTE: 3,
  TROLL: 4,
  MEDUSA: 5,
  BEHOLDER: 6,
  GOBLIN_KNIGHT: 7,
  EFREET: 8,
  BLACK_DRAGON: 9,
  HYDRA: 10,
  CENTAUR: 11,
  BERSERKER: 12,
  WOLF_RIDER: 13,
  HARPY: 14,
  NOMAD: 15,
  HYENA: 16,
  CYCLOPS: 17,
  OGRE_MAGE: 18,
  THUNDERBIRD: 19,
  BEHEMOTH: 20,
  WOLF: 21,
  FAIRY: 22,
  LEPRECHAUN: 23,
  ELF: 24,
  WHITE_TIGER: 25,
  SATYR: 26,
  MANTIS: 27,
  UNICORN: 28,
  GARGANTUAN: 29,
  PEGASUS: 30,
  PEASANT: 31,
  SQUIRE: 32,
  ARBALESTER: 33,
  VALKYRIE: 34,
  PIKEMAN: 35,
  HEALER: 36,
  GRIFFIN: 37,
  CRUSADER: 38,
  TSAR_CANNON: 39,
  ANGEL: 40
};

goog.object.extend(exports, proto.public);
