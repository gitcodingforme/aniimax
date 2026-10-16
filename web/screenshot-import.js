// Screenshot readings: what scripts/read_screenshots.py extracted from game screenshots with a local
// vision model, as a partial setup. Nothing is applied blindly: `proposeChanges` lists every
// difference against the current setup and `applyChanges` applies only the ones the player ticked.
// Pure functions only; tested in tests/screenshot_import.test.mjs.
export const READING_FORMAT = 'aniimax-screenshot-reading';
export const READING_VERSION = 1;
const MAX_FILE_BYTES = 5_000_000;
const MODULES = [
    ['ecological-module-level', 'Ecological Module'],
    ['kitchen-module-level', 'Kitchen Module'],
    ['resource-detector-level', 'Resource Detector'],
    ['crafting-module-level', 'Crafting Module'],
];

function pretty(name) {
    return String(name ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function tiersText(tiers) {
    const parts = (Array.isArray(tiers) ? tiers : []).filter(t => Number(t?.count) > 0).map(t => `${Number(t.count)}×Lv.${Number(t.level) || 1}`);
    return parts.length ? parts.join(' + ') : 'none';
}

function rosterText(roster) {
    return (roster || []).map(r => `${r.name || 'Aniimo'} (${Object.entries(r.abilities || {}).map(([a, l]) => `${a} ${l}`).join(', ')})`).join('; ') || 'none';
}

export function parseReading(content) {
    if (typeof content !== 'string') throw new Error('this is not a text file');
    if (content.length > MAX_FILE_BYTES) throw new Error('this file is too large to be a screenshot reading');
    let data;
    try {
        data = JSON.parse(content);
    } catch (_) {
        throw new Error('this file is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== READING_FORMAT) {
        throw new Error('this file is not a screenshot reading (expected reading.json from scripts/read_screenshots.py)');
    }
    if (!Number.isInteger(data.version) || data.version < 1) throw new Error('this reading has no valid version number');
    if (data.version > READING_VERSION) throw new Error(`this reading is version ${data.version}; this site reads up to version ${READING_VERSION}`);
    const setup = data.setup && typeof data.setup === 'object' && !Array.isArray(data.setup) ? data.setup : {};
    const actual = data.actual && typeof data.actual === 'object' ? data.actual : {};
    return {
        setup,
        actual,
        model: String(data.model ?? ''),
        readAt: String(data.readAt ?? ''),
        screens: Array.isArray(data.screens) ? data.screens.length : 0,
        failed: Array.isArray(data.screens) ? data.screens.filter(s => s && s.error).length : 0,
        notes: Array.isArray(data.notes) ? data.notes.map(String) : [],
    };
}

// Every difference between the current setup and what was read, as { id, what, before, after,
// apply(setup, meta) }. Only fields the reading contains are compared; the rest is left alone.
export function proposeChanges(current, reading) {
    const changes = [];
    const read = reading.setup || {};
    const add = (id, what, before, after, apply) => {
        if (String(before) !== String(after)) changes.push({ id, what, before: String(before), after: String(after), apply });
    };

    if ('home-level' in read) {
        add('home-level', 'RV level', current['home-level'] ?? '?', read['home-level'], setup => { setup['home-level'] = String(read['home-level']); });
    }
    for (const [key, label] of MODULES) {
        if (key in read) add(key, label, current[key] ?? '0', read[key], setup => { setup[key] = String(read[key]); });
    }
    for (const [facility, readTiers] of Object.entries(read.facilityTiers || {})) {
        // The game's facility panel shows the level but never how many are owned (count null): keep the
        // count the setup already has (all of them together), or 1 for a facility not in the setup yet.
        const have = current.facilityTiers?.[facility] || [];
        const levelOnly = readTiers.length > 0 && readTiers.every(t => t.count === null || t.count === undefined);
        const tiers = levelOnly
            ? [{ count: have.reduce((n, t) => n + (Number(t.count) || 0), 0) || 1, level: Number(readTiers[readTiers.length - 1].level) || 1 }]
            : readTiers.map(t => ({ count: Number(t.count) || 0, level: Number(t.level) || 1 }));
        const what = levelOnly ? `${facility} (level read from its panel; the game does not show the count)` : facility;
        add(`facility:${facility}`, what, tiersText(have), tiersText(tiers), setup => {
            setup.facilityTiers = { ...(setup.facilityTiers || {}), [facility]: tiers };
        });
    }
    for (const [item, amount] of Object.entries(read.levelUpStock || {})) {
        add(`stock:${item}`, `Stock: ${pretty(item)}`, current.levelUpStock?.[item] ?? 0, amount, setup => {
            setup.levelUpStock = { ...(setup.levelUpStock || {}), [item]: Number(amount) || 0 };
        });
    }
    if (Array.isArray(read.roster) && read.roster.length > 0) {
        add('roster', 'Aniimo roster', rosterText(current.roster), rosterText(read.roster), setup => {
            setup.roster = read.roster.map(r => ({
                name: String(r.name || ''), count: Math.max(1, Number(r.count) || 1),
                abilities: { ...(r.abilities || {}) }, personalities: [...(r.personalities || [])],
            }));
        });
    }
    const coins = reading.actual?.coins;
    if (Number.isFinite(coins)) {
        add('coins', 'Coins on hand (profile)', reading.currentCoins ?? '?', coins, (setup, meta) => { if (meta) meta.coins = coins; });
    }
    return changes;
}

// A new setup (and profile meta) with only the ticked changes applied; the inputs are not mutated.
export function applyChanges(current, meta, changes, selectedIds) {
    const setup = JSON.parse(JSON.stringify(current));
    const nextMeta = meta ? JSON.parse(JSON.stringify(meta)) : null;
    const chosen = new Set(selectedIds);
    let applied = 0;
    for (const change of changes) {
        if (!chosen.has(change.id)) continue;
        change.apply(setup, nextMeta);
        applied++;
    }
    return { setup, meta: nextMeta, applied };
}

// One line for Profile details from verification.json, which scripts/verify_data.py writes next to
// the local site: how many facts the watcher saw on facility panels and how they compare with this
// site's data. '' when the file is not a usable summary, so nothing is shown. `unclear` is optional:
// facts the watcher saw only once and could not judge (open the panel again); when the file carries
// a usable count it is mentioned after `unknown`, otherwise the line is exactly as it was before.
export function verificationSummary(data) {
    if (!data || data.format !== 'aniimax-verification') return '';
    const counts = ['observations', 'agree', 'disagree', 'unknown'].map(key => data[key]);
    if (!counts.every(n => Number.isInteger(n) && n >= 0) || counts[0] === 0) return '';
    const [observations, agree, disagree, unknown] = counts;
    const report = typeof data.report === 'string' && data.report ? data.report : 'screenshots/verification.md';
    const unclearText = Number.isInteger(data.unclear) && data.unclear >= 0 ? `, ${data.unclear} unclear` : '';
    return `Verified against ${observations} observation${observations === 1 ? '' : 's'} from the watcher: ${agree} agree, ${disagree} disagree, ${unknown} unknown${unclearText} (report: ${report})`;
}

// One line for Profile details from the `questions` counts in verification.json (the open game
// questions in scripts/game_questions.json: how many are answered, how many have facts captured and
// are waiting for the owner to check, how many have not been seen yet). Counts only, so nothing
// personal can be in it. '' when the counts are missing or not usable, so nothing is shown.
export function questionsSummary(verification) {
    const q = verification && typeof verification === 'object' ? verification.questions : null;
    if (!q || typeof q !== 'object' || Array.isArray(q)) return '';
    const counts = ['total', 'answered', 'evidence', 'open'].map(key => q[key]);
    if (!counts.every(n => Number.isInteger(n) && n >= 0)) return '';
    const [total, answered, evidence] = counts;
    if (total === 0 || answered + evidence > total) return '';
    return `${answered} of ${total} game question${total === 1 ? '' : 's'} answered, ${evidence} waiting for you to check`;
}
