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
        } else {
            enemyHP += hp;
            enemyCnt += 1;
            enemyAtk += atk;
            enemyRanged += isRanged;
            enemyWounded += wounded;
            enemyAdv += adv;
            enemyYet += yet;
        }
    }
    const norm = (a: number, b: number): number => (a - b) / (a + b + 1);
    const totalStacks = ourCnt + enemyCnt + 1;
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
    ];
}
