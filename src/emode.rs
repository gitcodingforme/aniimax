//! E-mode (Electric Mode): from RV 12 a processor can run on power from a Crackle Generator
//! instead of an Aniimo, at a fixed time per batch whatever Aniimo the homeland has.
//!
//! The planner gives every recipe that has an E-mode time an electric copy (`name__electric`, see
//! [`electric_variants`]) and lets the exact planner choose which units to electrify within the
//! generators' power budget (see `crate::exact`). Nothing changes unless the player enters a
//! generator.
//!
//! **Every game number in this module is INFERRED fan data, not verified in game** (fan sites and
//! upstream pull request 31, compared in the owner's workspace notes, docs/plans/emode.md). The web
//! page mirrors them in `web/facility-config.js` (`EMODE`), and `tests/data_tests.rs` checks that
//! the two agree. Only [`POWER_TIE_BREAK`] is a design constant of the planner's own.

use crate::models::{EmodeTimes, FacilityCounts, Power, ProductionItem, ELECTRIC_SUFFIX};

/// Watts one Crackle Generator supplies at generator levels 1 to 5. INFERRED (fan data: the
/// generator is levelled up with Home Coins; upstream pull request 31 ties the same five numbers to
/// RV 12 to 20 instead).
pub const GENERATOR_CAPACITY: [u32; 5] = [600, 800, 1000, 1200, 1500];

/// Watts an electrified unit draws per level of its facility: a level 3 Blazing Stove draws 45.
/// INFERRED (fan data; it reproduces 13 of the 14 fixed numbers in pull request 31).
pub const DRAW_PER_LEVEL: f64 = 15.0;

/// Facilities that draw twice [`DRAW_PER_LEVEL`] a level. INFERRED (fan data). None of them is in
/// [`EMODE_FACILITIES`], so the planner never electrifies one; listed so the mirror is complete.
pub const DOUBLE_DRAW: [&str; 4] = ["Mine", "Well", "Aniipod Maker", "Dance Pad Polisher"];

/// How much faster batches run at the 120% supply setting, which in exchange allows a load of only
/// the generators' capacity ÷ 1.2, rounded down. INFERRED (pull request 31's menu offers 100% and
/// 120% only).
pub const BOOST_RATE: f64 = 1.2;

/// The processors with an E-mode switch: the twelve pull request 31 gives E-mode times, the
/// Woodworking Bench and Chimney Kiln included; the Mine, Well, Aniipod Maker and Dance Pad Polisher
/// left out. INFERRED.
pub const EMODE_FACILITIES: [&str; 12] = [
    "Carousel Mill",
    "Jukebox Dryer",
    "Claw Game Cooker",
    "Crafting Table",
    "Simmering Pot",
    "Phonolfactory Table",
    "Bouncy Brew Keg",
    "Blazing Stove",
    "Pickling Jar",
    "Joy Wheel Loom",
    "Woodworking Bench",
    "Chimney Kiln",
];

/// What each watt an electrified unit draws costs in the objective: far too little to give up any
/// income for, but enough that of otherwise equal plans the one electrifying fewest watts wins (an
/// idle electrified unit is just a unit taken from its Aniimo). A design constant, not a game number.
pub const POWER_TIE_BREAK: f64 = 1e-8;

/// Whether `facility` has an E-mode switch (see [`EMODE_FACILITIES`]).
pub fn has_emode(facility: &str) -> bool {
    EMODE_FACILITIES.contains(&facility)
}

/// Watts one electrified unit of `facility` at `level` draws, at `per_level` watts a level
/// ([`DRAW_PER_LEVEL`] unless the player says otherwise), doubled for [`DOUBLE_DRAW`].
///
/// ```
/// use aniimax::emode::{draw, DRAW_PER_LEVEL};
///
/// assert_eq!(draw("Carousel Mill", 2, DRAW_PER_LEVEL), 30.0);
/// assert_eq!(draw("Well", 2, DRAW_PER_LEVEL), 60.0);
/// ```
pub fn draw(facility: &str, level: u32, per_level: f64) -> f64 {
    let double = if DOUBLE_DRAW.contains(&facility) { 2.0 } else { 1.0 };
    per_level * level as f64 * double
}

/// Watts one generator at `level` supplies, or `None` for a level the game doesn't have.
pub fn generator_capacity(level: u32) -> Option<u32> {
    GENERATOR_CAPACITY.get(level.checked_sub(1)? as usize).copied()
}

/// The most the electrified units may draw from generators supplying `capacity` watts in all: all of
/// it at 100% supply, `capacity ÷ 1.2` rounded down at 120% (500 W from a 600 W generator).
///
/// ```
/// use aniimax::emode::budget;
///
/// assert_eq!(budget(600, false), 600.0);
/// assert_eq!(budget(600, true), 500.0);
/// assert_eq!(budget(1000, true), 833.0);
/// ```
pub fn budget(capacity: u32, boosted: bool) -> f64 {
    if boosted {
        // A hair over before rounding down, so 600 ÷ 1.2 comes to 500 and not 499.
        (capacity as f64 / BOOST_RATE + 1e-9).floor()
    } else {
        capacity as f64
    }
}

/// The electric copy of every recipe in `items` that can run in E-mode: at a facility with the
/// switch ([`EMODE_FACILITIES`]), with an E-mode time in `times`, and a facility owned at the
/// recipe's level. Each is `name__electric`, takes the E-mode time ÷ `power.rate`, has no workload
/// and no Aniimo, so nothing retimes it for an Aniimo. A copy named in `exclude` is left out (the
/// recipe itself stays); a recipe excluded by its own name has no copy, since `items` is filtered
/// first. `items` must be the recipes before any Aniimo setup is applied (a roster setup moves each
/// recipe's own level out of reach).
pub fn electric_variants(
    items: &[ProductionItem],
    times: &EmodeTimes,
    power: &Power,
    counts: &FacilityCounts,
    exclude: &[String],
) -> Vec<ProductionItem> {
    items
        .iter()
        .filter(|item| has_emode(&item.facility) && !item.name.contains("__"))
        .filter(|item| counts.get_count(&item.facility) > 0 && counts.can_produce(&item.facility, item.facility_level))
        .filter_map(|item| {
            let seconds = times.get(&item.facility, &item.name).filter(|s| s.is_finite() && *s > 0.0)?;
            let name = format!("{}{ELECTRIC_SUFFIX}", item.name);
            (!exclude.contains(&name)).then(|| ProductionItem {
                name,
                production_time: seconds / power.rate,
                workload: None,
                crew: None,
                ..item.clone()
            })
        })
        .collect()
}

/// `copies` without the ones no plan would want outside My Aniimo mode: an electric copy no faster
/// than its own recipe as `items` time it (after the Aniimo setup) only takes a unit and power for
/// nothing. With the player's roster all are kept, since an electrified unit frees its Aniimo's
/// hours for other work.
pub fn keep_useful(copies: Vec<ProductionItem>, items: &[ProductionItem], roster: bool) -> Vec<ProductionItem> {
    if roster {
        return copies;
    }
    copies
        .into_iter()
        .filter(|copy| {
            let base = crate::models::base_item_name(&copy.name);
            items
                .iter()
                .find(|item| item.name == base && item.facility == copy.facility)
                .is_none_or(|item| copy.production_time < item.production_time)
        })
        .collect()
}
