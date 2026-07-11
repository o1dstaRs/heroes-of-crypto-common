// Position feature extractor for the LEARNED VALUE FUNCTION (the lookahead's leaf eval). Given a board
// state and the acting team, returns a fixed-length feature vector describing the position from THAT team's
// perspective, so a model fit on (features -> did-acting-team-win) predicts P(win). Cheap, pure, no RNG.
import type { FightProperties } from "../fights/fight_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { GRID_SIZE } from "../grid/grid_constants";
import type { UnitsHolder } from "../units/units_holder";

const LOWER = PBTypes.TeamVals.LOWER;
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

export function extractValueFeatures(
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
): number[] {
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
    const ourCells: { x: number; y: number }[] = [];
    const enemyCells: { x: number; y: number }[] = [];
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
        const adv = u.getTeam() === LOWER ? cell.y / (GRID_SIZE - 1) : (GRID_SIZE - 1 - cell.y) / (GRID_SIZE - 1);
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
    const norm = (a: number, b: number): number => (a - b) / (a + b + 1);
    const totalStacks = ourCnt + enemyCnt + 1;
    // --- spatial block (O(n^2) over <=~16 living stacks — trivially cheap) ---
    const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
        Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const span = GRID_SIZE - 1;
    const nearestEnemyDist = (own: { x: number; y: number }[], other: { x: number; y: number }[]): number => {
        if (!own.length || !other.length) {
            return 0;
        }
        let sum = 0;
        for (const c of own) {
            let best = Infinity;
            for (const e of other) {
                const d = cheb(c, e);
                if (d < best) {
                    best = d;
                }
            }
            sum += best;
        }
        return sum / own.length / span;
    };
    const spread = (own: { x: number; y: number }[]): number => {
        if (own.length < 2) {
            return 0;
        }
        let sum = 0;
        let pairs = 0;
        for (let i = 0; i < own.length; i += 1) {
            for (let j = i + 1; j < own.length; j += 1) {
                sum += cheb(own[i], own[j]);
                pairs += 1;
            }
        }
        return sum / pairs / span;
    };
    const center = { x: span / 2, y: span / 2 };
    const centerDist = (own: { x: number; y: number }[]): number => {
        if (!own.length) {
            return 0;
        }
        let sum = 0;
        for (const c of own) {
            sum += Math.max(Math.abs(c.x - center.x), Math.abs(c.y - center.y));
        }
        return sum / own.length / (span / 2);
    };
    return [
        norm(ourHP, enemyHP),
        norm(ourCnt, enemyCnt),
        norm(ourAtk, enemyAtk),
        (ourRanged - enemyRanged) / totalStacks,
        ourCnt ? ourWounded / ourCnt : 0,
        enemyCnt ? enemyWounded / enemyCnt : 0,
        ourCnt ? ourAdv / ourCnt : 0,
        enemyCnt ? enemyAdv / enemyCnt : 0,
        Math.min(fightProperties.getCurrentLap() / 10, 1),
        (enemyYet - ourYet) / totalStacks,
        enemyYet / totalStacks,
        ourYet / totalStacks,
        fightProperties.getHourglassQueueSize() / totalStacks,
        fightProperties.getUpNextQueueSize() / totalStacks,
        nearestEnemyDist(ourCells, enemyCells),
        nearestEnemyDist(enemyCells, ourCells),
        spread(ourCells),
        spread(enemyCells),
        centerDist(ourCells),
        centerDist(enemyCells),
    ];
}

/** V2 raw = base 20 (identical to extractValueFeatures) + the class/composition block. Pure, no RNG. */
export function extractValueFeaturesV2Raw(
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
): number[] {
    const f = extractValueFeatures(unitsHolder, fightProperties, team);
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
    const norm = (a: number, b: number): number => (a - b) / (a + b + 1);
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
        norm(ownShots, enemyShots),
        ownRangedFrac * f[NEAR_ENEMY_DIST_OURS_IDX],
    );
    return f;
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
export function extractValueFeaturesV2(
    unitsHolder: UnitsHolder,
    fightProperties: FightProperties,
    team: TeamType,
): number[] {
    return expandValueFeaturesV2(extractValueFeaturesV2Raw(unitsHolder, fightProperties, team));
}
