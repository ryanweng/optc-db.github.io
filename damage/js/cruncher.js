/* jshint evil: true */

(function() {

/* Terminology: 
 * - Hit modifiers:       Array of elements detailing the type of hits (Miss, Good, Great or Perfect) used in the
 *                        attack chain. Also used to specify the activation conditions for the captain effects of
 *                        certain types of units (G3, Killer, etc.) when provided via the `hitModifiers` property
 *                        in the `captains` file. Must have 6 elements, each element the hit modifier to be used
 *                        in the corresponding turn.  When provided through the `hitModifiers` property, the unit
 *                        is also expected to specify how to apply its own captain effect (via the `hitAtk` property).
 * - Bonus multiplier:    Multiplier associated to each hit modifier (close to 1.9x for Perfect hits, close to 1.4x
 *                        for Great's, ...). Affected by the unit's effective attack, CMB stat and by the enemy's defense.
 *                        Cannot be modified by captains or specials (so far).
 * - Chain multiplier:    Multiplier associated to the combo chain. Applied to the damage contribution of each unit.
 *                        Increased by 0.3 when hitting Perfect's, by 0.1 when hitting Great's, left untouched
 *                        when hitting Good's and reset back to its initial value of 1.0 when hitting Misses.
 *                        Can be modified by captain effects (via the chain modifier, see below) but not specials (so far).
 * - Chain modifier:      Modifier applied to the chain multiplier when computing its new value for the following
 *                        turn. Affects the amount the multiplier is increased by.  Typically a static value (eg 4.0 for
 *                        Rayleigh, 2.0 for Domino). Provided in the `captains` file via the `chainModifier` property.
 * - Orb multiplier:      Multiplier applied to the damage contribution of each unit, depending on the type of
 *                        the orb assigned to the unit itself (controlled by the `orbs` module).  Units with matching
 *                        orbs get a 2.0 orb multiplier, units with opposite orbs get 0.5  and units with unrelated orbs
 *                        get 1.0. Cannot be modified by captain effects or specials (so far), though some captains (eg
 *                        SW Ace) use the multiplier as the activation condition for their captain effects.
 * - Special multipliers: Multiplier granted by specials, applied to the damage contribution of every unit affected
 *                        by the special itself. The multipliers can be class-based (eg Zephyr),
 *                        type-based (eg Impact Usopp) or orb-based (eg Coby). Type-based and class-based multipliers
 *                        can't stack with each other or with themselves, but they do stack with orb-based multipliers.
 *                        Class-based and type-based multipliers are provided in the `specials` file via the `atk`
 *                        property and must have a `type` property describing whether they are class-based or type-based.
 *                        Orb-based multipliers are provided in the `specials` file via the `orb` property.
 *                        There's actually a fourth type of multiplier (indicated by a `type` property with value
 *                        `all`) for specials whose effect and stacking model are not completely clear; it's tipically
 *                        used for specials that boost the whole party (eg Sadi-chan, Usoppun etc.). Right now
 *                        "all-based" multipliers stack with all the other multipliers and with themselves; this
 *                        might need to be modified.
 * - Type multiplier:     Multiplier applied to the damage contribution of each unit, depending on the type 
 *                        compatibility between the unit itself and the hypothetical enemy. For example, STR units get
 *                        a 2.0 type multiplier when calculating the damage on DEX enemies, a 0.5 multiplier for QCK
 *                        enemies and a 1.0 multiplier for all other enemies. Cannot be modified by captain effects or
 *                        specials (so far).
 */

var DEFAULT_HIT_MODIFIERS = [ 'Perfect', 'Perfect', 'Perfect', 'Perfect', 'Perfect', 'Perfect' ]; 
var DEFENSE_THRESHOLD = 10000;

var team = [ null, null, null, null, null, null ];
var enabledSpecials = [ null, null, null, null, null, null ];
var captainAbilities = [ null, null ];

var merryBonus = 1;
var currentHP = 1, maxHP = 1, percHP = 100.0;

var defense = 0;
var currentDefense = 0;

var crunchingEnabled = true;

var specialsCombinations = [ ];

/* * * * * Crunching * * * * */

var crunch = function() {
    if (!crunchingEnabled) return;
    var result = { };
    ['STR','QCK','DEX','PSY','INT'].forEach(function(type) {
        result[type] = crunchForType(type,false);
    });
    result.HP = 0;
    team.forEach(function(x,n) {
        if (x === null) return;
        var hp = getHpOfUnit(x);
        result.HP += applyCaptainEffectsToHP(x,hp);
    });
    result.HP = Math.max(1,result.HP);
    result.team = getTeamDetails();
    $(document).trigger('numbersCrunched',result);
};

var crunchForType = function(type,withDetails) {
    var damage = [ ];
    // apply type & orb multipliers
    var isDefenseDown = enabledSpecials.some(function(x) { return x !== null && x.hasOwnProperty('def'); });
    team.forEach(function(x,n) {
        if (x === null) return;
        var atk = getAttackOfUnit(x); // basic attack (scales with level);
        atk *= x.orb; // orb multiplier (fixed)
        atk *= getTypeMultiplierOfUnit(x,type); // type multiplier (fixed)
        damage.push([ x, atk * merryBonus, n ]);
    });
    damage = applySpecialMultipliers(damage,isDefenseDown); // special multipliers (modify the whole array)
    // initialize ability array
    var abilities = [ ];
    if (captainAbilities[0] !== null) abilities.push(captainAbilities[0]);
    if (captainAbilities[1] !== null) abilities.push(captainAbilities[1]);
    // apply static multipliers and sort from weakest to stongest
    for (var i=0;i<abilities.length;++i) {
        if (!abilities[i].hasOwnProperty('atk')) continue;
        damage = applyCaptainEffectToDamage(damage,abilities[i].atk);
    }
    damage.sort(function(x,y) { return x[1] - y[1]; });
    /*
     * 1st scenario: no captains with hit modifiers
     * -> We can just apply the chain and bonus multipliers and call it a day
     * 2nd scenario: 1 captain with hit modifiers
     * -> We need to check which hit modifiers (the captain's or the default ones) return the highest damage (2 checks)
     * -> The effect of the captain only applies if its modifiers are the same as the ones being used during the check
     * 3rd scenario: both captains with hit modifiers
     * -> We need to check which hit modifiers (the captains' or the default ones) return the highest damage (3 checks)
     * -> The effect of each captain only applies if their modifiers are the same as the ones being used during the check
     */
    var captainsWithHitModifiers = abilities.filter(function(x) { return x.hasOwnProperty('hitModifiers'); });
    var captainsWithChainModifiers = abilities.filter(function(x) { return x.hasOwnProperty('chainModifier'); });
    // get data struct ready
    var data = [ damage ];
    for (i=0;i<captainsWithHitModifiers.length;++i) data.push(damage);
    // compute damages
    for (i=0;i<data.length;++i) {
        var modifiers = (i === 0 ? DEFAULT_HIT_MODIFIERS : captainsWithHitModifiers[i-1].hitModifiers);
        // apply compatible captain effects
        for (var j=1;j<data.length;++j) {
            if (!arraysAreEqual(modifiers,captainsWithHitModifiers[j-1].hitModifiers)) continue;
            data[i] = applyCaptainEffectToDamage(data[i],captainsWithHitModifiers[j-1].hitAtk);
        }
        var damageWithChainMultipliers = applyChainAndBonusMultipliers(data[i],modifiers,captainsWithChainModifiers);
        var overallDamage = damageWithChainMultipliers.result.reduce(function(prev,x) { return prev + x[1]; },0);
        data[i] = { damage: damageWithChainMultipliers, overall: overallDamage, hitModifiers: modifiers };
    }
    // find index of maxiumum damage
    var index = 0, currentMax = data[0].overall;
    for (i=1;i<data.length;++i) {
        if (data[i].overall < currentMax) continue;
        index = i;
        currentMax = data[i].overall;
    }
    // return results
    if (!withDetails) return currentMax;
    // provide details
    var result = {
        modifiers: data[index].hitModifiers,
        multipliers: data[index].damage.chainMultipliers,
        order: data[index].damage.result
    };
    return result;
};

/* * * * * * Static multipliers/modifiers * * * * */

var getTypeMultiplierOfUnit = function(data,against) {
    var type = data.unit.type;
    if (type == 'STR' && against == 'DEX') return 2;
    if (type == 'QCK' && against == 'STR') return 2;
    if (type == 'DEX' && against == 'QCK') return 2;
    if (type == 'INT' && against == 'PSY') return 2;
    if (type == 'PSY' && against == 'INT') return 2;
    if (type == 'STR' && against == 'QCK') return 0.5;
    if (type == 'QCK' && against == 'DEX') return 0.5;
    if (type == 'DEX' && against == 'STR') return 0.5;
    return 1;
};

var getChainMultiplier = function(currentChainMultiplier,hit,chainModifier) {
    if (hit == 'Perfect') return currentChainMultiplier + 0.3 * chainModifier;
    else if (hit == 'Great') return currentChainMultiplier +  0.1 * chainModifier;
    else if (hit == 'Good') return currentChainMultiplier;
    return 1.0;
};

/* * * * * Captain effects/specials * * * * */

var applyChainAndBonusMultipliers = function(damage,modifiers,captains) {
    // NOTE: all the captains provided must have a chain modifier (array can be empty - don't include them if they don't)
    var multipliersUsed = [ ];
    var currentChainMultiplier = 1.0;
    var result = damage.map(function(x,n) {
        var unit = x[0], damage = x[1], order = x[2];
        var result = damage * currentChainMultiplier;
        var chainModifier = captains.reduce(function(x,y) {
            return x * y.chainModifier(unit.unit,n,currentHP,maxHP,percHP,modifiers[n]);
        },1);
        result = computeDamageOfUnit(unit.unit,result,modifiers[n]);
        // update chain multiplier for the next hit
        multipliersUsed.push(currentChainMultiplier);
        currentChainMultiplier = getChainMultiplier(currentChainMultiplier,modifiers[n],chainModifier);
        // return value
        return [ unit, result, order ];
    });
    return { result: result, chainMultipliers: multipliersUsed };
};

var applyCaptainEffectToDamage = function(damage,func) {
    return damage.map(function(x,n) {
        var unit = x[0], damage = x[1], order = x[2];
        damage *= func(unit.unit,n,currentHP,maxHP,percHP,null,null,unit.orb);
        return [ unit, damage, order ];
    });
};

var applyCaptainEffectsToHP = function(unit,hp) {
    for (var i=0;i<2;++i) {
        if (captainAbilities[i] !== null && captainAbilities[i].hasOwnProperty('hp'))
            hp *= captainAbilities[i].hp(unit.unit);
    }
    return hp;
};

var applySpecialMultipliers = function(damage,isDefenseDown) {
    var result = damage, current = damage.reduce(function(prev,next) { return prev + next[1]; });
    specialsCombinations.forEach(function(specials) {
        var temp = damage.map(function(x,n) {
            var unit = x[0], damage = x[1], order = x[2];
            specials.forEach(function(func) {
                damage *= func(unit.unit,order,currentHP,maxHP,percHP,null,isDefenseDown,unit.orb);
            });
            return [ unit, damage, order ];
        });
        var total = temp.reduce(function(prev,next) { return prev + next[1]; },0);
        if (total < current) return;
        result = temp;
        current = total;
    });
    return result;
};

/* The effective damage of a unit is affected by the hit modifier being used and by the defense threshold of an enemy.
 * The estimates being used right now are:
 * FULL MISS hits : BASE_DAMAGE *  CMB
 * MISS hits      : BASE_DAMAGE * (CMB - 2)
 * GOOD hits      : BASE_DAMAGE * (CMB - 2) + BONUS_DAMAGE_GOOD
 * GREAT hits     : BASE_DAMAGE * (CMB - 1) + BONUS_DAMAGE_GREAT
 * PERFECT hits   : BASE_DAMAGE *  CMB      + BONUS_DAMAGE_PERFECT
 * where:
 * - BASE_DAMAGE          = floor(max(1,STARTING_DAMAGE / CMB - DEFENSE))
 * - BONUS_DAMAGE_GOOD    = floor(STARTING_DAMAGE * (0.2 + DEFENSE_BONUS_MODIFIER))
 * - BONUS_DAMAGE_GREAT   = floor(STARTING_DAMAGE * (0.4 + DEFENSE_BONUS_MODIFIER))
 * - BONUS_DAMAGE_PERFECT = floor(STARTING_DAMAGE * (0.9 + DEFENSE_BONUS_MODIFIER))
 * - STARTING_DAMAGE is the damage computed for the unit, including the Merry's bonus
 * - DEFENSE_BONUS_MODIFIER is 0.25 if DEFENSE >= DEFENSE_THRESHOLD, 0 otherwise
 * The bonus damages seem to bypass the enemy's defense when under a certain threshold (DEFENSE_THRESHOLD); when
 * the threshold is above said value, the defense is factored in but the bonus seems to get an additional 0.25
 * (additive, not multiplicative).
 */
var computeDamageOfUnit = function(unit,unitAtk,hitModifier) {
    var baseDamage = Math.floor(Math.max(1,unitAtk / unit.combo - currentDefense));
    var overThreshold = (currentDefense >= DEFENSE_THRESHOLD), bonusModifier = (overThreshold ? 0.25 : 0);
    var bonus, overallBaseDamage;
    if (hitModifier == 'Full Miss') return baseDamage * unit.combo;
    if (hitModifier == 'Miss') return baseDamage * (unit.combo -2);
    if (hitModifier == 'Good') {
        bonus = Math.floor(unitAtk * (0.2 + bonusModifier));
        overallBaseDamage = baseDamage * (unit.combo - 2);
    } else if (hitModifier == 'Great') {
        bonus = Math.floor(unitAtk * (0.4 + bonusModifier));
        overallBaseDamage = baseDamage * (unit.combo - 1);
    } else if (hitModifier == 'Perfect') { 
        bonus = Math.floor(unitAtk * (0.9 + bonusModifier));
        overallBaseDamage = baseDamage * unit.combo;
    }
    if (!overThreshold) return overallBaseDamage + (bonus > currentDefense ? bonus : 1);
    else return overallBaseDamage + Math.max(1,bonus - currentDefense);
};

/* Computes all the possible combinations of specials given the following conditions:
 * - Type-based and class-based are incompatible with each other and with themselves, but they stack with
 *   orb-based multipliers and with "all-based" multipliers;
 * - Orb-based multipliers are incompatible with themselves, but they stack with type-based OR class-based
 *   multipliers and with "all-based" multipliers;
 * - All-based multipliers stack with all the other multipliers and with themselves
 * The function should return true if there's a conflict between specials
 */
var computeSpecialsCombinations = function() {
    var result = { type: [ ], class: [ ], orb: [ ], all: [ ] };
    enabledSpecials.forEach(function(data) {
        if (data === null) return;
        if (data.hasOwnProperty('atk'))
            result[data.type].push(data.atk);
        if (data.hasOwnProperty('orb'))
            result.orb.push(data.orb);
    });
    specialsCombinations = Utils.arrayProduct([ result.type.concat(result.class), result.orb ]);
    if (result.all.length > 0 && specialsCombinations.length > 0)
        specialsCombinations = specialsCombinations.map(function(x) { return x.concat(result.all); });
    else if (result.all.length > 0)
        specialsCombinations = [ result.all ];
    return (result.class.length + result.type.length > 1) || result.orb.length > 1 || result.all.length > 1;
};

/* Computes the actual defense threshold of the enemy after the specials are factored in.
 * Defense-reducing specials do not stack with each other, so we just use the one that grants the lowest defense.
 */
var computeActualDefense = function() {
    currentDefense = defense;
    enabledSpecials.forEach(function(x) {
        if (x === null || !x.hasOwnProperty('def')) return;
        currentDefense = Math.min(currentDefense,defense * x.def());
    });
};

/* * * * * * Utility functions * * * * */

var getAttackOfUnit = function(data) {
    var unit = data.unit;
    var level = data.level;
    return Math.floor(unit.minATK + (unit.maxATK - unit.minATK) / (unit.maxLevel == 1 ? 1 : (unit.maxLevel-1)) * (level-1));
};

var getHpOfUnit = function(data) {
    var unit = data.unit;
    var level = data.level;
    return Math.floor(unit.minHP + (unit.maxHP - unit.minHP) / (unit.maxLevel == 1 ? 1 : (unit.maxLevel-1)) * (level-1));
};

var setCaptain = function(slotNumber) {
    if (team[slotNumber] === null)
        captainAbilities[slotNumber] = null;
    else if (captains.hasOwnProperty(team[slotNumber].unit.number+1))
        captainAbilities[slotNumber] = createFunctions(captains[team[slotNumber].unit.number+1]);
    else
        captainAbilities[slotNumber] = null;
};

var createFunctions = function(data) {
    var result = { };
    for (var key in data) {
        if (data[key] === undefined)
            Utils.warn("The unit you selected has a strange ass ability that can't be parsed correctly yet",'captains');
        else if (key == 'atk' || key == 'hitAtk' || key == 'hp' || key == 'chainModifier' || key == 'orb')
            result[key] = new Function('unit','chainPosition','currentHP','maxHP','percHP','modifier','defenseDown','orb','return ' + data[key]);
        else if (key == 'def')
            result[key] = new Function('return ' + data[key]);
        else
            result[key] = data[key];
    }
    return result;
};

var arraysAreEqual = function(a,b) {
    return a.length == b.length && a.every(function(x,n) { return x == b[n]; });
};

var getTeamDetails = function() {
    return team.map(function(data) {
        if (data === null) return null;
        return { name: data.unit.name, hp: getHpOfUnit(data), atk: getAttackOfUnit(data) };
    });
};

/* * * * * Event callbacks * * * * */

var onUnitPick = function(event,slotNumber,unitNumber) {
    team[slotNumber] = { unit: units[unitNumber], level: 1, orb: 1 };
    if (slotNumber < 2) setCaptain(slotNumber);
    enabledSpecials[slotNumber] = null;
    crunch();
};

var onLevelChange = function(event,slotNumber,level) {
    team[slotNumber].level = level;
    crunch();
};

var onMerryChange = function(event,bonus) {
    merryBonus = bonus;
    crunch();
};

var onDefenseChanged = function(event,value) {
    defense = value;
    computeActualDefense();
    crunch();
};

var onHpChange = function(event,current,max,perc) {
    currentHP = current;
    maxHP = max;
    percHP = perc;
    crunch();
};

var onOrbMultiplierChanged = function(event,slotNumber,multiplier) {
    team[slotNumber].orb = multiplier;
    crunch();
};

var onUnitsSwitched = function(event,slotA,slotB) {
    var teamA = team[slotA];
    team[slotA] = team[slotB];
    team[slotB] = teamA;
    if (slotA === 0 || slotB === 0) setCaptain(0);
    if (slotA == 1 || slotB == 1) setCaptain(1);
    var specialA = enabledSpecials[slotA];
    enabledSpecials[slotA] = enabledSpecials[slotB];
    enabledSpecials[slotB] = specialA;
    crunch();
};

var onUnitRemoved = function(event,slotNumber) {
    team[slotNumber] = null;
    if (slotNumber < 2) captainAbilities[slotNumber] = null;
    enabledSpecials[slotNumber] = null;
    crunch();
};

var onDetailsRequested = function(event,type) {
    $(document).trigger('detailsReady',crunchForType(type.toUpperCase(),true));
};

var onCrunchToggled = function(event,enabled) {
    crunchingEnabled = enabled;
    if (enabled) crunch();
};

var onSpecialToggled = function(event,slotNumber,enabled) {
    if (!enabled) enabledSpecials[slotNumber] = null;
    else enabledSpecials[slotNumber] = createFunctions(specials[team[slotNumber].unit.number+1]);
    computeActualDefense();
    if (computeSpecialsCombinations())
        Utils.warn('Two or more specials you selected are incompatible with each other.','specials');
    crunch();
};

/* * * * * Events * * * * */

// core
$(document).on('unitPicked',onUnitPick);
$(document).on('unitLevelChanged',onLevelChange);
$(document).on('merryBonusUpdated',onMerryChange);
$(document).on('hpChanged',onHpChange);
$(document).on('defenseChanged',onDefenseChanged);
// loader
$(document).on('crunchingToggled',onCrunchToggled);
// orb control
$(document).on('orbMultiplierChanged',onOrbMultiplierChanged);
// drag & drop
$(document).on('unitsSwitched',onUnitsSwitched);
$(document).on('unitRemoved',onUnitRemoved);
// details
$(document).on('detailsRequested',onDetailsRequested);
// specials
$(document).on('specialToggled',onSpecialToggled);

})();
