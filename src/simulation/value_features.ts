// Position feature extractor for the LEARNED VALUE FUNCTION (the lookahead's leaf eval). Given a board
// state and the acting team, returns a fixed-length feature vector describing the position from THAT team's
// perspective, so a model fit on (features -> did-acting-team-win) predicts P(win). Cheap, pure, no RNG.
import type { FightProperties } from "../fights/fight_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { GRID_SIZE } from "../grid/grid_constants";
import type { UnitsHolder } from "../units/units_holder";

const LEFT = PBTypes.TeamVals.LEFT;
const RANGE = PBTypes.AttackVals.RANGE;
const MAGIC = PBTypes.AttackVals.MAGIC;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

export const VALUE_FEATURE_NAMES = [
    "hpAdv", // normalized (ourHP - enemyHP)
    "cntAdv", // normalized (ourStacks - enemyStacks)
    "atkAdv", // normalized (ourFirepower - enemyFirepower), firepower = attack * amountAlive
    "rangedAdv", // (ourRanged - enemyRanged) / totalStacks
    "woundedOurs", // avg fraction of our stacks already dead
    "woundedEnemy", // avg fraction of enemy stacks already dead
    "advOurs", // avg board advancement of our units toward the enemy edge (0..1)
    "advEnemy", // avg board advancement of enemy units
    "lapNorm", // game progress = min(lap/10, 1)
    // --- TEMPO / SEAT block (the second-mover signal the static features are blind to) -------------------
    "seatAdv", // (enemyYetToAct - ourYetToAct) / totalStacks — POSITIVE = we act later this lap (2nd-mover)
    "enemyExposed", // enemyYetToAct / totalStacks — raw enemy exposure (what strategic hourglass feeds on)
    "ourExposed", // ourYetToAct / totalStacks
    "hourglassFrac", // units parked in the hourglass queue / totalStacks
    "upNextFrac", // remaining upNext queue size / totalStacks (how much of the lap is left)
    // --- SPATIAL block (v0.7 B2: cheap board-geometry terms for the rollout-search leaf) -----------------
    "nearEnemyDistOurs", // avg normalized Chebyshev distance from each of our stacks to its nearest enemy
    "nearEnemyDistEnemy", // same for the enemy's stacks (their engagement distance to us)
    "spreadOurs", // avg pairwise Chebyshev distance among our stacks (dispersion vs clustering)
    "spreadEnemy", // same for the enemy
    "centerDistOurs", // avg normalized Chebyshev distance of our stacks to the board center (narrowing safety)
    "centerDistEnemy", // same for the enemy
] as const;

/**
 * V2 RAW (Phase-B multi-cohort refit, 2026-07-10): the 20 base features above + a CLASS/COMPOSITION
 * block. The base 20 were fit on LIVETWIN MELEE drafts only; on ranged/mixed armies the leaf is
 * out-of-distribution (rangedAdv is the lone class signal and it saturates in mirrors where both sides
 * field the same counts). The extra dims describe WHAT each army is made of and how much shooting is
 * left, so one model can value melee, ranged, hybrid and mixed boards. Extractor kept separate —
 * extractValueFeatures stays byte-identical for the committed 20-dim leaf and the 41-dim wait scorer.
 */
export const VALUE_FEATURE_NAMES_V2_RAW = [
    ...VALUE_FEATURE_NAMES,
    "ownRangedFrac", // our RANGE stacks / our living stacks
    "enemyRangedFrac",
    "ownFlyerFrac", // canFly stacks / living stacks
    "enemyFlyerFrac",
    "ownCasterFrac", // MAGIC or MELEE_MAGIC stacks / living stacks
    "enemyCasterFrac",
    "rangedHpFracOurs", // HP share of our army sitting in RANGE stacks
    "rangedHpFracEnemy",
    "shotsAdv", // norm(our remaining range shots, enemy remaining range shots) over RANGE stacks
    "xRangedDist", // ownRangedFrac * nearEnemyDistOurs — shooters value standoff distance
] as const;

/**
 * V2 DEPLOYED basis: raw 30 + a RANGEDNESS-interaction copy (xRg_<name> = <name> * boardRangedness,
 * boardRangedness = (ownRangedFrac + enemyRangedFrac) / 2). One linear model over this basis expresses
 * "shared weights + a ranged-board delta block" — melee boards score through the shared block alone
 * (rangedness ~ 0 zeroes the copy), shootout boards add the delta. A fit that finds no ranged-specific
 * structure leaves the xRg_ block ~0, so the 30-dim raw model is this basis's special case.
 */
export const VALUE_FEATURE_NAMES_V2: readonly string[] = [
    ...VALUE_FEATURE_NAMES_V2_RAW,
    ...VALUE_FEATURE_NAMES_V2_RAW.map((name) => `xRg_${name}`),
] as const;

export interface IValueFeatureScratch {
    ourCells: { x: number; y: number }[];
    enemyCells: { x: number; y: number }[];
}

export function createValueFeatureScratch(): IValueFeatureScratch {
    return { ourCells: [], enemyCells: [] };
}

const normalizedDifference = (a: number, b: number): number => (a - b) / (a + b + 1);
const chebyshevDistance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function nearestEnemyDistance(
    own: readonly { x: number; y: number }[],
    other: readonly { x: number; y: number }[],
    span: number,
): number {
    if (!own.length || !other.length) {
        return 0;
    }
    let sum = 0;
    for (const cell of own) {
        let best = Infinity;
        for (const enemyCell of other) {
            const distance = chebyshevDistance(cell, enemyCell);
            if (distance < best) {
                best = distance;
            }
        }
        sum += best;
    }
    return sum / own.length / span;
}

function averageSpread(cells: readonly { x: number; y: number }[], span: number): number {
    if (cells.length < 2) {
        return 0;
    }
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
            sum += chebyshevDistance(cells[i], cells[j]);
            pairs += 1;
        }
    }
    return sum / pairs / span;
}

function averageCenterDistance(cells: readonly { x: number; y: number }[], span: number): number {
    if (!cells.length) {
        return 0;
    }
    const center = span / 2;
    let sum = 0;
    for (const cell of cells) {
        sum += Math.max(Math.abs(cell.x - center), Math.abs(cell.y - center));
    }
    return sum / cells.length / center;
}

export function fillValueFeatures(
    out: number[],
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
    scratch: IValueFeatureScratch = createValueFeatureScratch(),
): number[] {
    // POLICY seam, not the raw board flag: a battery's legacy control seat keeps the shipped
    // raw-Y features on a side board (see FightProperties.isSideAxisPolicyTeam).
    const sideOrientedBoard = fightProperties.isSideAxisPolicyTeam(team);
    let ourHP = 0;
    let enemyHP = 0;
    let ourCnt = 0;
    let enemyCnt = 0;
    let ourAtk = 0;
    let enemyAtk = 0;
    let ourRanged = 0;
    let enemyRanged = 0;
    let ourWounded = 0;
    let enemyWounded = 0;
    let ourAdv = 0;
    let enemyAdv = 0;
    let ourYet = 0;
    let enemyYet = 0;
    const ourCells = scratch.ourCells;
    const enemyCells = scratch.enemyCells;
    ourCells.length = 0;
    enemyCells.length = 0;
    for (const u of unitsHolder.getAllUnits().values()) {
        if (u.isDead()) {
            continue;
        }
        const hp = u.getCumulativeHp();
        const atk = u.getAttack() * u.getAmountAlive();
        const isRanged = u.getAttackType() === RANGE ? 1 : 0;
        const died = u.getAmountDied();
        const alive = u.getAmountAlive();
        const wounded = died + alive > 0 ? died / (died + alive) : 0;
        const cell = u.getBaseCell();
        // Advance is DEPTH toward the enemy, not raw Y: on the side-oriented ranked board the axis
        // of advance is X (see grid_math.advanceDepthOfCell — inlined here to keep this loop
        // allocation-free). With the wrong axis, dims 6-7 feed lateral noise into every learned
        // consumer (v0.7 leaf, wait scorer, IL, v0.9).
        const along = sideOrientedBoard ? cell.x : cell.y;
        const adv = u.getTeam() === LEFT ? along / (GRID_SIZE - 1) : (GRID_SIZE - 1 - along) / (GRID_SIZE - 1);
        // A unit "yet to act" this lap has neither made its turn nor parked on the hourglass.
        const yet =
            !fightProperties.hasAlreadyMadeTurn(u.getId()) && !fightProperties.hasAlreadyHourglass(u.getId()) ? 1 : 0;
        if (u.getTeam() === team) {
            ourHP += hp;
            ourCnt += 1;
            ourAtk += atk;
            ourRanged += isRanged;
            ourWounded += wounded;
            ourAdv += adv;
            ourYet += yet;
            ourCells.push(cell);
        } else {
            enemyHP += hp;
            enemyCnt += 1;
            enemyAtk += atk;
            enemyRanged += isRanged;
            enemyWounded += wounded;
            enemyAdv += adv;
            enemyYet += yet;
            enemyCells.push(cell);
        }
    }
    const totalStacks = ourCnt + enemyCnt + 1;
    const span = GRID_SIZE - 1;
    out.length = VALUE_FEATURE_NAMES.length;
    out[0] = normalizedDifference(ourHP, enemyHP);
    out[1] = normalizedDifference(ourCnt, enemyCnt);
    out[2] = normalizedDifference(ourAtk, enemyAtk);
    out[3] = (ourRanged - enemyRanged) / totalStacks;
    out[4] = ourCnt ? ourWounded / ourCnt : 0;
    out[5] = enemyCnt ? enemyWounded / enemyCnt : 0;
    out[6] = ourCnt ? ourAdv / ourCnt : 0;
    out[7] = enemyCnt ? enemyAdv / enemyCnt : 0;
    out[8] = Math.min(fightProperties.getCurrentLap() / 10, 1);
    out[9] = (enemyYet - ourYet) / totalStacks;
    out[10] = enemyYet / totalStacks;
    out[11] = ourYet / totalStacks;
    out[12] = fightProperties.getHourglassQueueSize() / totalStacks;
    out[13] = fightProperties.getUpNextQueueSize() / totalStacks;
    out[14] = nearestEnemyDistance(ourCells, enemyCells, span);
    out[15] = nearestEnemyDistance(enemyCells, ourCells, span);
    out[16] = averageSpread(ourCells, span);
    out[17] = averageSpread(enemyCells, span);
    out[18] = averageCenterDistance(ourCells, span);
    out[19] = averageCenterDistance(enemyCells, span);
    return out;
}

export function extractValueFeatures(
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
): number[] {
    return fillValueFeatures(new Array<number>(VALUE_FEATURE_NAMES.length), unitsHolder, fightProperties, team);
}

/** V2 raw = base 20 (identical to extractValueFeatures) + the class/composition block. Pure, no RNG. */
export function fillValueFeaturesV2Raw(
    out: number[],
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
    scratch: IValueFeatureScratch = createValueFeatureScratch(),
): number[] {
    const f = fillValueFeatures(out, unitsHolder, fightProperties, team, scratch);
    let ownCnt = 0;
    let enemyCnt = 0;
    let ownRanged = 0;
    let enemyRanged = 0;
    let ownFly = 0;
    let enemyFly = 0;
    let ownCaster = 0;
    let enemyCaster = 0;
    let ownHp = 0;
    let enemyHp = 0;
    let ownRangedHp = 0;
    let enemyRangedHp = 0;
    let ownShots = 0;
    let enemyShots = 0;
    for (const u of unitsHolder.getAllUnits().values()) {
        if (u.isDead()) {
            continue;
        }
        const own = u.getTeam() === team;
        const attackType = u.getAttackType();
        const isRanged = attackType === RANGE;
        const isCaster = attackType === MAGIC || attackType === MELEE_MAGIC;
        const hp = u.getCumulativeHp();
        const shots = isRanged ? u.getRangeShots() : 0;
        if (own) {
            ownCnt += 1;
            ownHp += hp;
            if (isRanged) {
                ownRanged += 1;
                ownRangedHp += hp;
                ownShots += shots;
            }
            if (u.canFly()) {
                ownFly += 1;
            }
            if (isCaster) {
                ownCaster += 1;
            }
        } else {
            enemyCnt += 1;
            enemyHp += hp;
            if (isRanged) {
                enemyRanged += 1;
                enemyRangedHp += hp;
                enemyShots += shots;
            }
            if (u.canFly()) {
                enemyFly += 1;
            }
            if (isCaster) {
                enemyCaster += 1;
            }
        }
    }
    const ownRangedFrac = ownCnt ? ownRanged / ownCnt : 0;
    f.push(
        ownRangedFrac,
        enemyCnt ? enemyRanged / enemyCnt : 0,
        ownCnt ? ownFly / ownCnt : 0,
        enemyCnt ? enemyFly / enemyCnt : 0,
        ownCnt ? ownCaster / ownCnt : 0,
        enemyCnt ? enemyCaster / enemyCnt : 0,
        ownHp > 0 ? ownRangedHp / ownHp : 0,
        enemyHp > 0 ? enemyRangedHp / enemyHp : 0,
        normalizedDifference(ownShots, enemyShots),
        ownRangedFrac * f[NEAR_ENEMY_DIST_OURS_IDX],
    );
    return f;
}

export function extractValueFeaturesV2Raw(
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
): number[] {
    return fillValueFeaturesV2Raw(
        new Array<number>(VALUE_FEATURE_NAMES_V2_RAW.length),
        unitsHolder,
        fightProperties,
        team,
    );
}

const NEAR_ENEMY_DIST_OURS_IDX = (VALUE_FEATURE_NAMES as readonly string[]).indexOf("nearEnemyDistOurs");
const OWN_RANGED_FRAC_IDX = (VALUE_FEATURE_NAMES_V2_RAW as readonly string[]).indexOf("ownRangedFrac");
const ENEMY_RANGED_FRAC_IDX = (VALUE_FEATURE_NAMES_V2_RAW as readonly string[]).indexOf("enemyRangedFrac");

/** Deployed V2 basis expansion: raw 30 + xRg_ rangedness-interaction copy. Pure column arithmetic. */
export function expandValueFeaturesV2(raw: readonly number[]): number[] {
    const rangedness = (raw[OWN_RANGED_FRAC_IDX] + raw[ENEMY_RANGED_FRAC_IDX]) / 2;
    const out = raw.slice();
    for (const x of raw) {
        out.push(rangedness ? x * rangedness : 0);
    }
    return out;
}

/** The deployed V2 leaf featurization (search_driver V07_VALUE_WEIGHTS_V2). */
export function fillValueFeaturesV2(
    out: number[],
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
    scratch: IValueFeatureScratch = createValueFeatureScratch(),
): number[] {
    const raw = fillValueFeaturesV2Raw(out, unitsHolder, fightProperties, team, scratch);
    const rangedness = (raw[OWN_RANGED_FRAC_IDX] + raw[ENEMY_RANGED_FRAC_IDX]) / 2;
    const rawLength = VALUE_FEATURE_NAMES_V2_RAW.length;
    raw.length = VALUE_FEATURE_NAMES_V2.length;
    for (let i = 0; i < rawLength; i += 1) {
        raw[rawLength + i] = rangedness ? raw[i] * rangedness : 0;
    }
    return raw;
}

export function extractValueFeaturesV2(
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
): number[] {
    return fillValueFeaturesV2(new Array<number>(VALUE_FEATURE_NAMES_V2.length), unitsHolder, fightProperties, team);
}
