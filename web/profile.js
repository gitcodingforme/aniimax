// Homeland profile: the app's saved setup (`currentConfig()` in app.js) wrapped with a little
// metadata, as one JSON file the player keeps. Browser storage is per browser and can be wiped;
// a file in the player's own cloud folder moves between a PC and a Mac without the site knowing.
// Pure functions only (no DOM), so Node can test them (tests/profile.test.mjs).
export const PROFILE_FORMAT = 'aniimax-profile';
export const PROFILE_VERSION = 1;
const MAX_PROFILE_BYTES = 2_000_000;
const MAX_NOTE_LENGTH = 500;

// The one thing a setup must have; the app validates the rest field by field when it loads it.
function isSetup(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && !!value.facilityTiers && typeof value.facilityTiers === 'object' && !Array.isArray(value.facilityTiers);
}

function isoOrEmpty(value) {
    if (value === undefined || value === null || value === '') return '';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function text(value, max = 200) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanToolkits(value) {
    return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v !== ''))] : [];
}

// What the game showed when the profile was saved: optional, and only sensible numbers survive.
function cleanActual(value) {
    const actual = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return actual;
    if (Number.isInteger(value.rv) && value.rv >= 1) actual.rv = value.rv;
    if (Number.isFinite(value.coins) && value.coins >= 0) actual.coins = value.coins;
    if (value.stock && typeof value.stock === 'object' && !Array.isArray(value.stock)) {
        const stock = Object.fromEntries(Object.entries(value.stock)
            .filter(([name, n]) => name !== '' && Number.isFinite(n) && n >= 0));
        if (Object.keys(stock).length > 0) actual.stock = stock;
    }
    return actual;
}

export function buildProfile({ setup, note = '', site = {}, toolkits = [], actual = {}, savedAt = new Date() } = {}) {
    if (!isSetup(setup)) throw new Error('there is no homeland setup to save');
    return {
        format: PROFILE_FORMAT,
        version: PROFILE_VERSION,
        savedAt: isoOrEmpty(savedAt),
        note: text(note, MAX_NOTE_LENGTH),
        site: { appVersion: text(site?.appVersion), dataVersion: text(site?.dataVersion) },
        setup,
        toolkits: cleanToolkits(toolkits),
        actual: cleanActual(actual),
    };
}

// Turns a file's text into a clean profile, or throws a short plain-language reason.
export function parseProfile(content) {
    if (typeof content !== 'string') throw new Error('this is not a text file');
    if (content.length > MAX_PROFILE_BYTES) throw new Error('this file is too large to be a profile');
    let data;
    try {
        data = JSON.parse(content);
    } catch (_) {
        throw new Error('this file is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== PROFILE_FORMAT) {
        throw new Error('this file is not an Aniimax profile');
    }
    if (!Number.isInteger(data.version) || data.version < 1) throw new Error('this profile has no valid version number');
    if (data.version > PROFILE_VERSION) {
        throw new Error(`this profile is version ${data.version}; this site reads up to version ${PROFILE_VERSION}`);
    }
    if (!isSetup(data.setup)) throw new Error('this profile has no homeland setup in it');
    return buildProfile({ ...data, savedAt: data.savedAt ?? '' });
}

// `aniimax-2026-10-14_1905.profile.json` (local time); `*.profile.json` is gitignored in this fork.
export function profileFilename(savedAt, now = new Date()) {
    const parsed = new Date(savedAt);
    const date = Number.isNaN(parsed.getTime()) ? now : parsed;
    const pad = n => String(n).padStart(2, '0');
    return `aniimax-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `_${pad(date.getHours())}${pad(date.getMinutes())}.profile.json`;
}

// A few numbers to show before a loaded profile replaces the current setup.
export function summarizeProfile(profile) {
    const setup = profile.setup;
    const facilities = Object.values(setup.facilityTiers)
        .flatMap(tiers => (Array.isArray(tiers) ? tiers : []))
        .reduce((n, tier) => n + (Number(tier?.count) || 0), 0);
    const aniimo = Array.isArray(setup.roster)
        ? setup.roster.reduce((n, entry) => n + (Number(entry?.count) || 0), 0)
        : 0;
    const rv = profile.actual?.rv ?? (Number(setup['home-level']) || '?');
    return { rv, facilities, aniimo };
}
