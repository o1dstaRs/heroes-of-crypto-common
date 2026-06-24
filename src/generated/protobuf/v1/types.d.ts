import * as pb_1 from "google-protobuf";
export declare namespace PBTypes {
    enum FactionVals {
        NO_FACTION = 0,
        CHAOS = 1,
        MIGHT = 2,
        NATURE = 3,
        LIFE = 4,
        DEATH = 5,
        ORDER = 6
    }
    enum TeamVals {
        NO_TEAM = 0,
        UPPER = 1,
        LOWER = 2
    }
    enum AttackVals {
        NO_ATTACK = 0,
        MELEE = 1,
        RANGE = 2,
        MAGIC = 3,
        MELEE_MAGIC = 4
    }
    enum UnitSizeVals {
        NO_SIZE = 0,
        SMALL = 1,
        LARGE = 2
    }
    enum UnitLevelVals {
        NO_LEVEL = 0,
        FIRST = 1,
        SECOND = 2,
        THIRD = 3,
        FOURTH = 4
    }
    enum GridVals {
        NO_TYPE = 0,
        NORMAL = 1,
        WATER_CENTER = 2,
        LAVA_CENTER = 3,
        BLOCK_CENTER = 4
    }
    enum PickPhaseVals {
        INITIAL_PICK = 0,
        EXTENDED_PICK = 1,
        EXTENDED_BAN = 2,
        PICK = 3,
        BAN = 4,
        ARTIFACT_1 = 5,
        ARTIFACT_2 = 6,
        AUGMENTS = 7,
        AUGMENTS_SCOUT = 8
    }
    enum PickPhaseActionVals {
        NO_ACTION = 0,
        PICK_INITIAL_PAIR = 1,
        PICK_UNIT = 2,
        BAN_UNIT = 3,
        SELECT_ARTIFACT = 4,
        AUGMENT = 5,
        REVEAL = 6
    }
    enum AugmentVals {
        NO_AUGMENT = 0,
        AUGMENTS_AND_MAP_SCOUT = 1,
        ALL_UNITS_SCOUT = 2
    }
    enum AllUnitsScoutAugmentVals {
        NO_AUGMENTED_ALL_UNITS_SCOUT = 0,
        AUGMENTED_ALL_UNITS_SCOUT = 1
    }
    enum AugmentsAndMapScoutAugmentVals {
        NO_AUGMENTED_AUGMENTS_AND_MAP_SCOUT = 0,
        AUGMENTED_AUGMENTS_AND_MAP_SCOUT = 1
    }
    enum MovementVals {
        NO_MOVEMENT = 0,
        WALK = 1,
        FLY = 2,
        TELEPORT = 3
    }
    enum UnitVals {
        NO_UNIT = 0,
        CREATURE = 1,
        HERO = 2
    }
    enum CreatureVals {
        NO_CREATURE = 0,
        ORC = 1,
        SCAVENGER = 2,
        TROGLODYTE = 3,
        TROLL = 4,
        MEDUSA = 5,
        BEHOLDER = 6,
        GOBLIN_KNIGHT = 7,
        EFREET = 8,
        BLACK_DRAGON = 9,
        HYDRA = 10,
        CENTAUR = 11,
        BERSERKER = 12,
        WOLF_RIDER = 13,
        HARPY = 14,
        NOMAD = 15,
        HYENA = 16,
        CYCLOPS = 17,
        OGRE_MAGE = 18,
        THUNDERBIRD = 19,
        BEHEMOTH = 20,
        WOLF = 21,
        FAIRY = 22,
        LEPRECHAUN = 23,
        ELF = 24,
        WHITE_TIGER = 25,
        SATYR = 26,
        MANTIS = 27,
        UNICORN = 28,
        GARGANTUAN = 29,
        PEGASUS = 30,
        PEASANT = 31,
        SQUIRE = 32,
        ARBALESTER = 33,
        VALKYRIE = 34,
        PIKEMAN = 35,
        HEALER = 36,
        GRIFFIN = 37,
        CRUSADER = 38,
        TSAR_CANNON = 39,
        ANGEL = 40
    }
    class StringList extends pb_1.Message {
        #private;
        constructor(data?: any[] | {
            values?: string[];
        });
        get values(): string[];
        set values(value: string[]);
        static fromObject(data: {
            values?: string[];
        }): StringList;
        toObject(): {
            values?: string[];
        };
        serialize(): Uint8Array;
        serialize(w: pb_1.BinaryWriter): void;
        static deserialize(bytes: Uint8Array | pb_1.BinaryReader): StringList;
        serializeBinary(): Uint8Array;
        static deserializeBinary(bytes: Uint8Array): StringList;
    }
}
