// One copy of each rule the page (app.js), the plan-input copy (setup-input.js), the solver worker
// (worker.js) and the feature cards' logic modules all use. A leaf: no imports, no DOM, no storage,
// so the worker can import it too. Every value is frozen and none of them comes from
// facility-config.js, so data/overrides/structure.json never changes them (the page's
// override-patched constants reach the cards through ctx.config instead; see panels.js).
// Tested in tests/shared.test.mjs.

// The highest ability level an Aniimo reaches, and the abilities that stop short of it; mirrors
// `MAX_ANIIMO_LEVEL` and `ABILITY_DEFAULTS` in src/models.rs. There is no level-4 Perfumery
// Aniimo in the game yet, so one isn't assumed, but a player who has one can say so.
export const MAX_ANIIMO_LEVEL = 4;
export const ABILITY_DEFAULTS = Object.freeze({ Perfumery: 3 });
export const defaultLevelFor = ability => ABILITY_DEFAULTS[ability] ?? MAX_ANIIMO_LEVEL;

// What the Priorities strategy can rank (see `JsPlanInput::priorities` in src/wasm.rs). `season`
// ones show only while the season is on. The page puts its own labels on these ids.
export const PRIORITY_TARGETS = Object.freeze([
    { id: 'coins' }, { id: 'aniimo_exp' }, { id: 'aniipods' },
    { id: 'Wood Blocks' }, { id: 'Mineral Sand' }, { id: 'season_points', season: true },
].map(t => Object.freeze(t)));

// The ability each environment building's Aniimo needs (confirmed in game).
export const ENVIRONMENT_BUILDING_ABILITY = Object.freeze({
    'Heat Furnace': 'Fire',
    'Cooling Unit': 'Ice',
    'Sunlamp': 'Light',
});

// The smallest gain worth ranking, as a share of what the plan already makes: below it, a
// difference is as likely to be the solver's tolerances as a real improvement.
export const RANK_MIN_GAIN = 1e-3;

// A ranking's level-up `top` is level-ups per day (PACE_UNIT = 86400 in src/exact.rs), so the
// level-up takes PACE_UNIT_SECONDS / top seconds.
export const PACE_UNIT_SECONDS = 86400;

// How many of a facility `tiers` (`[{ count, level }]`) hold, and the highest level among them.
// A tier with no count, or a negative one, counts as none.
export const tierCount = tiers => (tiers || []).reduce((sum, t) => sum + (t?.count > 0 ? t.count : 0), 0);
export const tierLevel = tiers => Math.max(0, ...(tiers || []).filter(t => t?.count > 0).map(t => t.level));

// Text made safe to put in HTML, as element content or inside a quoted attribute.
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// What a ranked change is measured by: level-up time for a level-up plan that can be worked
// toward, else the first ranked priority, else Home Coins. `input` is a plan input, `context` the
// 'plan' topic's planContext.
export function measureFor(input, context) {
    if (context?.levelUp && !context.unavailable && !context.ready) return 'level_up';
    return (input?.priorities || [])[0] || 'coins';
}

// `load()` run once and its promise kept, unless it fails: a rejected (or throwing) load is
// forgotten, so the next call tries again instead of repeating the old failure.
export function onceUntilFailed(load) {
    let pending = null;
    return () => {
        if (!pending) {
            const attempt = new Promise(resolve => resolve(load()));
            pending = attempt;
            attempt.catch(() => {
                if (pending === attempt) pending = null;
            });
        }
        return pending;
    };
}
