// Setup checklist: the solved plan as a tick list, one line per facility row and per environment
// building, so the homeland can be set up in game without missing anything. Ticks are kept per
// plan (they reset when the plan changes). Pure functions only (no DOM, no storage); tested in
// tests/checklist.test.mjs. app.js wires the card, storage and the reminders button.
export const CHECKLIST_KEY = 'aniimax-checklist-v1';

export function pretty(name) {
    return String(name ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Two environment buildings placed to overlap come out of the engine as three assignments, all
// named after the first building: zone 0 is the first building's own reach, zone 1 where both
// reach (temperatures added), zone 2 the second's own. `partner` names the second building and
// `pair_modes` what each is set to. These say which building a zone really is.
function zoneWhere(a) {
    if (!a.partner) return `a ${a.building}`;
    const [first, second] = a.pair_modes || [a.mode, a.mode];
    if (a.zone === 2) return `a ${a.partner[0]}`;
    if (a.zone === 1) return `the overlap of a ${a.building} (${first}) and a ${a.partner[0]} (${second})`;
    return `a ${a.building}`;
}

// The building (or overlap) that gives a plan row its environment, if the plan covers it with one.
function coveringAssignment(step, assignments) {
    return (assignments || []).find(a => a && a.mode === step.environment
        && (a.covered || []).some(c => c && c.facility === step.facility));
}

function coversText(a) {
    return (a.covered || []).filter(c => c && c.count > 0).map(c => `${c.count} ${c.facility}`).join(', ');
}

// One entry per producing facility row, then one per environment building:
// { id, kind: 'facility'|'environment', facility, count, item, environment, aniimo, text }.
// `roster` is the player's Aniimo cards (each with a name), used to say who works a row.
export function checklistRows(plan, roster = []) {
    const assignments = plan?.environment_assignments || [];
    const seen = new Map();
    const unique = id => {
        const n = (seen.get(id) || 0) + 1;
        seen.set(id, n);
        return n === 1 ? id : `${id}#${n}`;
    };
    const rows = [];
    for (const s of plan?.coin_items || []) {
        if (!s || s.status !== 'producing' || !s.item_name || !(s.facility_count > 0)) continue;
        let text = `${s.facility} x${s.facility_count}: ${pretty(s.item_name)}`;
        if (s.environment) {
            const assignment = coveringAssignment(s, assignments);
            if (assignment) text += `, needs ${s.environment} (${assignment.partner && assignment.zone === 1 ? 'in' : 'under'} ${zoneWhere(assignment)})`;
            else if (s.environment !== 'Adequate') text += `, needs ${s.environment}`;
        }
        const a = s.aniimo;
        if (a && a.ability) {
            text += `, ${a.ability} Aniimo level ${a.level}${a.personality_bonus ? ' with personality bonus' : ''}`;
        }
        if (Number.isInteger(s.crew) && s.crew >= 0 && s.crew < (roster || []).length) {
            const name = String(roster[s.crew]?.name ?? '').trim() || `Aniimo ${s.crew + 1}`;
            text += `, worked by ${name}`;
        }
        rows.push({
            id: unique(`${s.facility}|${s.item_name}`), kind: 'facility', facility: s.facility, count: s.facility_count,
            item: s.item_name, environment: s.environment || null, aniimo: a || null, crew: Number.isInteger(s.crew) ? s.crew : null, text,
        });
    }
    // One row per building on its own, and one per overlapping pair (its three zones together).
    const pairs = new Map();
    assignments.forEach((a, i) => {
        if (!a) return;
        if (a.partner) {
            const key = `${a.building}+${a.partner[0]}`;
            if (!pairs.has(key)) pairs.set(key, { first: a.building, second: a.partner[0], modes: a.pair_modes || [a.mode, a.mode], units: 0, zones: [], index: i });
            const pair = pairs.get(key);
            pair.units = Math.max(pair.units, a.units || 1);
            pair.zones.push(a);
            return;
        }
        const covers = coversText(a);
        const units = a.units > 1 ? ` x${a.units}` : '';
        rows.push({
            id: unique(`env|${a.building}|${a.mode}|${i}`), kind: 'environment', facility: a.building, count: a.units || 1,
            item: null, environment: a.mode, aniimo: null,
            text: `${a.building}${units} (${a.mode})${covers ? `: covers ${covers}` : ''}`,
        });
    });
    pairs.forEach(pair => {
        const units = pair.units > 1 ? ` x${pair.units}` : '';
        const sides = pair.zones.map(z => {
            const covers = coversText(z);
            if (!covers) return null;
            const side = z.zone === 1 ? `overlap (${z.mode})` : z.zone === 2 ? `${pair.second} side` : `${pair.first} side`;
            return `${side} covers ${covers}`;
        }).filter(Boolean).join('; ');
        rows.push({
            id: unique(`env|${pair.first}+${pair.second}|${pair.index}`), kind: 'environment', facility: pair.first, count: pair.units,
            item: null, environment: pair.modes.join('+'), aniimo: null,
            text: `${pair.first} (${pair.modes[0]}) overlapping a ${pair.second} (${pair.modes[1]})${units}${sides ? `: ${sides}` : ''}`,
        });
    });
    return rows;
}

// A short fingerprint of "which plan is this": the setup hash, which Aniimo setup tab the plan
// is for, and every row's id, count, worker and Aniimo level, so two different plans for the same
// inputs (Best vs Minimum Aniimo, or a roster change that moves a worker) do not share ticks.
export function checklistHash(setupHash, rows, tab = '') {
    const text = `${setupHash ?? ''}|${tab ?? ''}|${(rows || []).map(r => `${r.id}:${r.count ?? ''}:${r.crew ?? ''}:${r.aniimo?.level ?? ''}`).join(';')}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

// --- state ----------------------------------------------------------------------------------

export function emptyState(planHash) {
    return { planHash: planHash ?? null, ticked: [] };
}

// The saved ticks (a JSON string or null) if they belong to this plan; otherwise a fresh empty
// state, which is how ticks reset when the plan changes.
export function readState(raw, planHash) {
    if (typeof raw !== 'string' || !raw) return emptyState(planHash);
    let saved;
    try { saved = JSON.parse(raw); } catch { return emptyState(planHash); }
    if (!saved || typeof saved !== 'object' || saved.planHash == null || saved.planHash !== planHash || !Array.isArray(saved.ticked)) {
        return emptyState(planHash);
    }
    return { planHash, ticked: [...new Set(saved.ticked.filter(id => typeof id === 'string'))] };
}

export function writeState(state) {
    return JSON.stringify({ planHash: state?.planHash ?? null, ticked: [...new Set(state?.ticked || [])] });
}

export function toggle(state, id, on) {
    const ticked = new Set(state?.ticked || []);
    if (on) ticked.add(id); else ticked.delete(id);
    return { planHash: state?.planHash ?? null, ticked: [...ticked] };
}

export function tickAll(state, rows) {
    return { planHash: state?.planHash ?? null, ticked: (rows || []).map(r => r.id) };
}

export function untickAll(state) {
    return { planHash: state?.planHash ?? null, ticked: [] };
}

export function isTicked(state, id) {
    return (state?.ticked || []).includes(id);
}

// How many of these rows are ticked (ids no longer in the plan are not counted).
export function doneCount(state, rows) {
    return (rows || []).filter(r => isTicked(state, r.id)).length;
}

export function allTicked(state, rows) {
    return (rows || []).length > 0 && doneCount(state, rows) === rows.length;
}
