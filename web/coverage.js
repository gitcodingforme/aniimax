// "How sure is this data?": for each recipe, the best check behind its numbers. Pure (no DOM, no
// imports); the card is web/cards/coverage.js and the tests are tests/coverage.test.mjs.
//
// Inputs
//   items         the parsed get_all_items result (RecipeInfo in src/wasm.rs), one object per recipe:
//                 { name, facility, facility_level, production_time, workload (null for crops and
//                 trees), yield_amount, sell_value, season (a harvest_moon_festival.csv row),
//                 verified (false for a row of data/unverified.csv), ... }
//   sources       web/data-sources.json (scripts/build_sources.py, committed):
//                 { web: [{ kind, facility, key, column, value, source, url, checked_on }],
//                   owner: [{ file, match, column, value, verified_on, note }] (data/overrides/values.csv) }
//   verification  web/verification.json (scripts/verify_data.py; local only, gitignored, so the public
//                 site gets a 404): its `rows` are [{ facility, item, column, key, status, day }] with
//                 status agree | disagree | conflict. No screen values, frames or times of day.
//
// One status per recipe, the first that applies:
//   game          checked in game: a values.csv row for it, or every local check of it agrees
//   game-differs  a local check disagrees with the data, or two sightings disagree (conflict)
//   wiki          every wiki value for it equals the data
//   wiki-differs  a wiki value no longer equals the data ("wiki X, data Y"; a crop's time is compared
//                 after watering, see WATERING_FACTOR)
//   unverified    upstream lists it in data/unverified.csv
//   unchecked     nothing checks it yet
// Facility levels and RV costs (unlocks, output caps, upgrade costs, RV coin costs) get their own
// table: the wiki values against ctx.config (FACILITIES unlocks, OUTPUT_CAPS, FACILITY_UPGRADE_COSTS,
// LEVEL_UP_COSTS), the page's override-patched copies.

export const STATUSES = ['game', 'game-differs', 'wiki', 'wiki-differs', 'unverified', 'unchecked'];

export const STATUS_LABELS = {
    game: 'Checked in game',
    'game-differs': 'Game differs',
    wiki: 'Matches the wiki',
    'wiki-differs': 'Wiki differs',
    unverified: 'Not confirmed upstream',
    unchecked: 'Not checked',
};

// Wiki recipe columns this page can compare, and where the item holds each one.
const ITEM_VALUES = {
    facility_level: item => item.facility_level,
    production_time: item => item.production_time,
    workload: item => item.workload,
    yield: item => item.yield_amount,
    sell_value: item => item.sell_value,
};

const COLUMN_NAMES = {
    facility_level: 'facility level',
    production_time: 'time',
    emode_seconds: 'E-mode time',
    recipe: 'facility',
    sell_value: 'sell value',
};

// Facility-level wiki facts: the columns accepted for each kind and the value in ctx.config.
const LEVEL_FACTS = {
    unlock: { columns: ['needs_rv', 'rv_level'], label: 'needs RV', data: (c, f, lv) => c.FACILITIES?.find?.(x => x?.name === f)?.unlocks?.[lv] },
    cap: { columns: ['output_cap', 'output_capacity'], label: 'output cap', data: (c, f, lv) => c.OUTPUT_CAPS?.[f]?.[lv - 1] },
    upgrade_cost: { columns: ['coins'], label: 'upgrade cost', data: (c, f, lv) => c.FACILITY_UPGRADE_COSTS?.[f]?.[lv] },
    rv_cost: { columns: ['coins'], label: 'coin cost', data: (c, _f, lv) => c.LEVEL_UP_COSTS?.[lv]?.coins },
};

const LOCAL_STATUSES = new Set(['agree', 'disagree', 'conflict']);
const SEASON_FILE = 'harvest_moon_festival.csv';
const text = v => (typeof v === 'string' ? v.trim() : '');
const columnName = c => COLUMN_NAMES[c] || String(c).replace(/_/g, ' ');
const keyOf = (facility, item) => `${facility}\u0000${item}`;
const slugFile = facility => `${facility.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}.csv`;
const fileOf = item => (item.season ? SEASON_FILE : slugFile(item.facility));
const latest = days => days.filter(Boolean).sort().at(-1) || '';
const shown = v => (v === null || v === undefined || v === '' ? 'none' : String(v));

// get_all_items reports a crop's or tree's time AFTER the Aniimo's watering (src/wasm.rs calls
// crate::models::apply_watering on every item; watered_time in src/models.rs takes off two
// waterings of WATERING_SAVES = 1/8 each), while the wiki and data/*.csv hold the unwatered grow
// time. So a wiki time is compared as wiki x WATERING_FACTOR, rounded to the second, within 1 s.
export const WATERING_FACTOR = 1 - 2 * 0.125;
const WATERING_TOLERANCE = 1;

// A crop or tree: grown on its own (no workload) with a time; apply_watering touches only these.
const isCrop = item => (item.workload === null || item.workload === undefined) && Number(item.production_time) > 0;
const watered = (r, item) => r.column === 'production_time' && isCrop(item) && Number.isFinite(Number(r.value)) && r.value !== '';

// Whether a wiki recipe value equals the item's, the watering taken into account.
function wikiMatches(r, item) {
    const data = ITEM_VALUES[r.column](item);
    if (!watered(r, item)) return same(r.value, data);
    return Math.abs(Math.round(Number(r.value) * WATERING_FACTOR) - Number(data)) <= WATERING_TOLERANCE;
}

// "wiki 240 (180 after watering)" for a crop's time, "wiki 162" otherwise.
function wikiShown(r, item) {
    return watered(r, item) ? `${shown(r.value)} (${Math.round(Number(r.value) * WATERING_FACTOR)} after watering)` : shown(r.value);
}
const unique = list => [...new Set(list)];

// Numbers compare as numbers (2400 and "2400.0" are the same); anything else as text.
function same(a, b) {
    const blank = v => v === null || v === undefined || v === '';
    const x = Number(a);
    const y = Number(b);
    if (!blank(a) && !blank(b) && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) < 1e-6;
    return String(a ?? '') === String(b ?? '');
}

// The values.csv row's target: `rose` (the first column) or `name=wheat;step=Sowing`.
function ownerTarget(row) {
    const match = text(row.match);
    if (!match.includes('=')) return { name: match, facility: '' };
    const pairs = Object.fromEntries(match.split(';').map(part => part.split('=').map(s => s.trim())));
    return { name: pairs.name || '', facility: pairs.facility || '' };
}

function cleanItems(items) {
    return (Array.isArray(items) ? items : []).filter(i => i && typeof i === 'object' && text(i.name) && text(i.facility));
}

function cleanWeb(web) {
    return (Array.isArray(web) ? web : [])
        .filter(r => r && typeof r === 'object' && text(r.kind) && text(r.column)
            && (typeof r.key === 'string' || typeof r.key === 'number') && (typeof r.value === 'number' || typeof r.value === 'string'))
        .map(r => ({ ...r, facility: text(r.facility), key: String(r.key).trim() }));
}

function cleanOwner(owner) {
    return (Array.isArray(owner) ? owner : []).filter(r => r && typeof r === 'object' && text(r.file) && text(r.match) && text(r.column));
}

function cleanLocal(verification) {
    const rows = Array.isArray(verification?.rows) ? verification.rows : [];
    return rows
        .filter(r => r && typeof r === 'object' && text(r.facility) && typeof r.column === 'string' && LOCAL_STATUSES.has(r.status))
        .map(r => ({ facility: text(r.facility), item: text(r.item), column: r.column, key: String(r.key ?? ''), status: r.status, day: text(r.day) }));
}

function push(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}

// One row per recipe: { facility, item, status, detail, verified }. Wiki rows and local checks for a
// facility or item the data does not have are ignored.
export function coverageRows(items, sources, verification) {
    const list = cleanItems(items);
    const web = cleanWeb(sources?.web);
    const owner = cleanOwner(sources?.owner);
    const local = cleanLocal(verification).filter(r => r.column !== 'unlock' && r.item);
    const itemKeys = new Set(list.map(i => keyOf(i.facility, i.name)));
    const itemFiles = new Set(list.map(fileOf));

    const wikiBy = new Map();
    for (const r of web) {
        if (r.kind === 'recipe' && Object.hasOwn(ITEM_VALUES, r.column) && itemKeys.has(keyOf(r.facility, r.key))) push(wikiBy, keyOf(r.facility, r.key), r);
    }
    const localBy = new Map();
    const misplaced = new Map(); // the game showed this item at a facility whose data does not have it
    for (const r of local) {
        if (itemKeys.has(keyOf(r.facility, r.item))) push(localBy, keyOf(r.facility, r.item), r);
        else if (r.column === 'recipe' && r.status !== 'agree') push(misplaced, r.item, r);
    }

    return list.map(item => {
        const k = keyOf(item.facility, item.name);
        const base = { facility: item.facility, item: item.name, verified: item.verified !== false };
        const mine = owner.filter(o => {
            const target = ownerTarget(o);
            if (target.name !== item.name || (target.facility && target.facility !== item.facility)) return false;
            return itemFiles.has(o.file) ? o.file === fileOf(item) : true; // grower_steps.csv and the like name no facility file
        });
        if (mine.length) {
            const day = latest(mine.map(o => text(o.verified_on)));
            return { ...base, status: 'game', detail: `checked in game by you${day ? ` on ${day}` : ''} (${unique(mine.map(o => columnName(o.column))).join(', ')}; data/overrides/values.csv)` };
        }
        const seen = [...(localBy.get(k) || []), ...(misplaced.get(item.name) || [])];
        if (seen.length) {
            const day = latest(seen.map(r => r.day));
            const bad = seen.filter(r => r.status !== 'agree');
            if (!bad.length) {
                return { ...base, status: 'game', detail: `seen in game${day ? ` on ${day}` : ''}, agreeing (${unique(seen.map(r => columnName(r.column))).join(', ')})` };
            }
            const said = unique(bad.map(r => (r.column === 'recipe' && r.facility !== item.facility
                ? `the game showed it at ${r.facility}`
                : `${columnName(r.column)}: ${r.status === 'conflict' ? 'sightings disagree with each other' : 'the game differs from the data'}`)));
            return { ...base, status: 'game-differs', detail: `${said.join('; ')}${day ? ` (last seen ${day})` : ''}; the local report has the values` };
        }
        const wiki = wikiBy.get(k) || [];
        if (wiki.length) {
            const where = unique(wiki.map(r => text(r.source) || 'the wiki')).join(', ');
            const differs = wiki.filter(r => !wikiMatches(r, item));
            if (differs.length) {
                const said = differs.map(r => `${columnName(r.column)}: wiki ${wikiShown(r, item)}, data ${shown(ITEM_VALUES[r.column](item))}`).join('; ');
                return { ...base, status: 'wiki-differs', detail: `${said} (${where}, read ${latest(differs.map(r => text(r.checked_on))) || 'on an unknown day'})` };
            }
            const wateredNote = wiki.filter(r => watered(r, item))
                .map(r => `; ${columnName(r.column)}: wiki ${wikiShown(r, item)}, data ${shown(ITEM_VALUES[r.column](item))}`).join('');
            return { ...base, status: 'wiki', detail: `matches ${where} (${unique(wiki.map(r => columnName(r.column))).join(', ')}), read ${latest(wiki.map(r => text(r.checked_on))) || 'on an unknown day'}${wateredNote}` };
        }
        if (item.verified === false) return { ...base, status: 'unverified', detail: 'upstream lists it in data/unverified.csv' };
        return { ...base, status: 'unchecked', detail: 'no source checks it yet' };
    });
}

function emptyCounts() {
    return Object.fromEntries(STATUSES.map(s => [s, 0]));
}

// How many recipes have each status: { game: n, 'game-differs': n, ... }.
export function countStatuses(rows) {
    const counts = emptyCounts();
    for (const row of rows || []) if (Object.hasOwn(counts, row?.status)) counts[row.status] += 1;
    return counts;
}

// Per facility, in name order: [{ facility, total, counts: { status: n } }].
export function facilitySummary(rows) {
    const by = new Map();
    for (const row of rows || []) if (row?.facility) push(by, row.facility, row);
    return [...by.keys()].sort((a, b) => a.localeCompare(b))
        .map(facility => ({ facility, total: by.get(facility).length, counts: countStatuses(by.get(facility)) }));
}

// Facility levels and RV costs: [{ facility, levels, checks, matching, differs: [{ kind, key, label,
// wiki, data }], seen: { agree, differs } }] in the page's facility order, with "RV" (the RV
// level-up coin costs) last. `levels` is how many of its levels have a wiki value; `seen` counts the
// local unlock checks. Facilities ctx.config does not have are left out.
export function facilityFacts(web, config, verification = null) {
    if (!config || typeof config !== 'object') return [];
    const names = (Array.isArray(config.FACILITIES) ? config.FACILITIES : []).map(f => f?.name).filter(Boolean);
    const known = new Set(names);
    const by = new Map();
    const entry = facility => {
        if (!by.has(facility)) by.set(facility, { facility, levels: new Set(), checks: 0, matching: 0, differs: [], seen: { agree: 0, differs: 0 } });
        return by.get(facility);
    };
    for (const r of cleanWeb(web)) {
        const fact = LEVEL_FACTS[r.kind];
        if (!fact || !fact.columns.includes(r.column) || !/^\d+$/.test(r.key)) continue;
        const rv = r.kind === 'rv_cost';
        if (rv ? !['', 'RV'].includes(r.facility) : !known.has(r.facility)) continue;
        const facility = rv ? 'RV' : r.facility;
        const level = Number(r.key);
        const data = fact.data(config, facility, level);
        const e = entry(facility);
        e.levels.add(level);
        e.checks += 1;
        if (same(r.value, data)) e.matching += 1;
        else e.differs.push({ kind: r.kind, key: level, label: fact.label, wiki: r.value, data: data ?? null });
    }
    for (const r of cleanLocal(verification)) {
        if (r.column !== 'unlock' || !known.has(r.facility)) continue;
        if (r.status === 'agree') entry(r.facility).seen.agree += 1;
        else entry(r.facility).seen.differs += 1;
    }
    const order = [...names, 'RV'];
    return [...by.values()].sort((a, b) => order.indexOf(a.facility) - order.indexOf(b.facility)).map(e => ({ ...e, levels: e.levels.size }));
}

async function fetchJson(fetchImpl, url, cache) {
    try {
        const res = await fetchImpl(url, { cache });
        if (!res || !res.ok) return { ok: false, status: res?.status };
        return { ok: true, data: await res.json() };
    } catch {
        return { ok: false };
    }
}

// Everything the card shows. `getItems` resolves with the items (a rejection is passed on, so the
// card can show a retry hint). A missing data-sources.json gives no wiki values and a note; a
// missing or broken verification.json (always so on the public site) gives localChecks: false.
export async function loadCoverage({ getItems, fetchImpl = globalThis.fetch?.bind(globalThis), config = null } = {}) {
    const items = await getItems();
    const notes = [];
    // no-cache: revalidated online, and the service worker keeps a copy for offline use (web/sw.js).
    const sourcesFile = await fetchJson(fetchImpl, './data-sources.json', 'no-cache');
    let sources = { web: [], owner: [] };
    if (sourcesFile.ok && sourcesFile.data?.format === 'aniimax-data-sources') {
        sources = { web: cleanWeb(sourcesFile.data.web), owner: cleanOwner(sourcesFile.data.owner) };
    } else {
        notes.push('The wiki checks (data-sources.json) could not be loaded, so no wiki values are shown.');
    }
    // no-store: personal data, never cached (the service worker bypasses it).
    const localFile = await fetchJson(fetchImpl, './verification.json', 'no-store');
    const verification = localFile.ok && localFile.data?.format === 'aniimax-verification' ? localFile.data : null;
    if (verification && !Array.isArray(verification.rows)) {
        notes.push('Your verification.json has no per-value rows yet: run python scripts/verify_data.py --web-dir web again.');
    }
    const rows = coverageRows(items, sources, verification);
    return {
        rows,
        counts: countStatuses(rows),
        facilities: facilitySummary(rows),
        facts: facilityFacts(sources.web, config, verification),
        localChecks: Boolean(verification),
        checkedOn: latest(sources.web.map(r => text(r.checked_on))),
        webRows: sources.web.length,
        ownerRows: sources.owner.length,
        notes,
    };
}

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// The card's markup for a loadCoverage model. `format` is ctx.format: every name and detail goes
// through format.escape (escapeHtml without one); item names are shown with format.item.
export function coverageHtml(model, format = {}) {
    const esc = typeof format?.escape === 'function' ? format.escape : escapeHtml;
    const itemName = name => esc(typeof format?.item === 'function' ? format.item(name) : name);
    const num = n => `<td class="coverage-num${n ? '' : ' coverage-zero'}">${Number(n) || 0}</td>`;
    const counts = model?.counts || emptyCounts();
    const local = Boolean(model?.localChecks);
    const out = [];
    out.push(`<p class="feature-status">Each recipe's numbers, by the best check behind them. Wiki values come from a fan site${model?.checkedOn ? ` (read ${esc(model.checkedOn)})` : ''}: a match is corroboration, not proof.</p>`);
    out.push('<ul class="feature-chips coverage-chips" aria-label="Recipes by check">');
    for (const s of STATUSES) out.push(`<li class="coverage-chip coverage-is-${s}">${STATUS_LABELS[s]}: ${Number(counts[s]) || 0}</li>`);
    out.push('</ul>');

    out.push('<h3>Recipes by facility</h3><div class="feature-scroll"><table class="coverage-table"><thead><tr><th>Facility</th><th class="coverage-num">Recipes</th>');
    for (const s of STATUSES) out.push(`<th class="coverage-num">${STATUS_LABELS[s]}</th>`);
    out.push('</tr></thead><tbody>');
    for (const f of model?.facilities || []) {
        out.push(`<tr><td>${esc(f.facility)}</td>${num(f.total)}${STATUSES.map(s => num(f.counts?.[s])).join('')}</tr>`);
    }
    out.push('</tbody></table></div>');

    const facts = model?.facts || [];
    if (facts.length) {
        out.push('<h3>Facility levels and RV costs</h3>');
        out.push('<p class="feature-status">Per facility level: the RV level it needs, its output cap and its upgrade cost; per RV level: its coin cost. Each against the wiki.</p>');
        out.push('<div class="feature-scroll"><table class="coverage-table"><thead><tr><th>Facility</th><th class="coverage-num">Levels with wiki values</th>'
            + `<th class="coverage-num">Values that match</th><th>Differ</th>${local ? '<th class="coverage-num">Unlocks seen in game</th>' : ''}</tr></thead><tbody>`);
        for (const f of facts) {
            const rv = f.facility === 'RV';
            const differs = f.differs.length
                ? f.differs.map(d => esc(`${rv ? `RV ${d.key}` : `Lv.${d.key}`} ${d.label}: wiki ${shown(d.wiki)}, data ${shown(d.data)}`)).join('<br>')
                : '<span class="coverage-zero">none</span>';
            const seenCount = f.seen.agree + f.seen.differs;
            const seen = local ? `<td class="coverage-num">${seenCount ? `${f.seen.agree} agree${f.seen.differs ? `, ${f.seen.differs} differ` : ''}` : '<span class="coverage-zero">0</span>'}</td>` : '';
            out.push(`<tr><td>${esc(rv ? 'RV level-ups' : f.facility)}</td>${num(f.levels)}<td class="coverage-num">${f.matching} of ${f.checks}</td><td>${differs}</td>${seen}</tr>`);
        }
        out.push('</tbody></table></div>');
    }

    const differing = (model?.rows || []).filter(r => r.status === 'game-differs' || r.status === 'wiki-differs');
    out.push('<h3>Values that differ</h3>');
    if (!differing.length) {
        out.push('<p class="feature-status">Nothing differs from the data.</p>');
    } else {
        out.push('<ul class="coverage-differs">');
        for (const r of differing) {
            out.push(`<li><strong>${itemName(r.item)}</strong> (${esc(r.facility)}) <span class="coverage-is-${r.status}">${STATUS_LABELS[r.status]}</span>: ${esc(r.detail)}</li>`);
        }
        out.push('</ul>');
    }
    for (const note of model?.notes || []) out.push(`<p class="feature-status">${esc(note)}</p>`);
    out.push('<p class="hint small coverage-footnote">Sell values, yields and seed costs: no source checks these yet.</p>');
    if (!local) out.push('<p class="hint small coverage-footnote">Your own in-game checks appear on your local site (scripts/verify_data.py).</p>');
    return out.join('');
}
