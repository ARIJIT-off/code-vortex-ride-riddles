'use strict';

// ---------------------------------------------------------------------------
// routeLookup.js — loads routeData.json and enriches route results with
// real road data (distance, time, quality, type, traffic) from the dataset.
//
// Gracefully falls back to OSM-computed values when:
//   • routeData.json doesn't exist
//   • a specific A→B pair isn't in the dataset
// ---------------------------------------------------------------------------

const path = require('path');

// ── Name normaliser ─────────────────────────────────────────────────────────
// The JSON was created with original names; map them to current app names.
const NAME_MAP = {
    "IEM Newtown": "IEM Salt Lake",
    "UEM Newtown": "IEM Newtown",
    "St. Xavier's University": "St. Xavier's University",   // keep same
    "St. Xaviers University": "St. Xavier's University"    // alt spelling
};

function norm(name) {
    return NAME_MAP[name] || name;
}

// ── Quality / type helpers ───────────────────────────────────────────────────
function deriveQuality(r) {
    // returns { smooth, shaded, problematic } percentages
    if (r.smooth_road && r.shade_overall) {
        return { smooth: 75, shaded: 20, problematic: 5 };
    }
    if (r.smooth_road) {
        return { smooth: 85, shaded: 10, problematic: 5 };
    }
    if (r.shade_overall) {
        return { smooth: 15, shaded: 75, problematic: 10 };
    }
    // rough road
    const poth = r.pothole_risk;
    const issues = poth === 'Very High' ? 80 : poth === 'High' ? 60 : 35;
    return { smooth: 100 - issues - 10, shaded: 10, problematic: issues };
}

function deriveTypeBreakdown(r) {
    // returns typeBreakdown { '6-lane'|'4-lane'|'2-lane'|'one way'|'narrow alley': pct }
    const LABELS = {
        '6-Lane': '6-lane',
        '4-Lane': '4-lane',
        '2-Lane': '2-lane',
        'One Way': 'one way',
        'Narrow Lane': 'narrow alley'
    };
    const key = LABELS[r.road_type_label] || '2-lane';
    const out = { '6-lane': 0, '4-lane': 0, '2-lane': 0, 'one way': 0, 'narrow alley': 0 };
    out[key] = 100;
    return out;
}

function deriveRoadSamples(r) {
    // pick a plausible sample road name based on highway class
    const samples = {
        primary: 'EM Bypass',
        trunk: 'VIP Road',
        secondary: 'Action Area Road',
        tertiary: 'Internal Road',
        residential: 'Local Lane'
    };
    const key = r.highway_class || 'residential';
    return { [deriveTypeKey(r.road_type_label)]: samples[key] || 'Local Road' };
}

function deriveTypeKey(label) {
    return ({
        '6-Lane': '6-lane', '4-Lane': '4-lane', '2-Lane': '2-lane',
        'One Way': 'one way', 'Narrow Lane': 'narrow alley'
    })[label] || '2-lane';
}

// ── Dataset loader ───────────────────────────────────────────────────────────
let routeMap = null;

function loadRouteData() {
    try {
        const filePath = path.join(__dirname, 'routeData.json');
        const data = JSON.parse(require('fs').readFileSync(filePath, 'utf8'));
        routeMap = new Map();
        for (const r of data.routes) {
            const from = norm(r.place_from);
            const to = norm(r.place_to);
            routeMap.set(`${from}|${to}`, r);
        }
        console.log(`📊 Route dataset loaded: ${routeMap.size} pairs from routeData.json`);
    } catch (e) {
        console.warn('⚠  routeData.json not found — will use OSM-computed values for all routes');
        routeMap = new Map();
    }
}

function lookupRoute(from, to) {
    if (!routeMap) loadRouteData();
    return routeMap.get(`${from}|${to}`) || null;
}

// ── Public enricher ──────────────────────────────────────────────────────────
// Takes the AMCR router result and, if a dataset entry exists for this A→B
// pair, replaces the computed values with the curated dataset values.
// If no entry found, returns the original result unchanged.
function enrichRoute(result, fromName, toName) {
    const r = lookupRoute(fromName, toName);

    // Always normalise the router's distMetres field name first
    const base = {
        ...result,
        distanceMetres: result.distanceMetres ?? result.distMetres ?? 0
    };

    if (!r) return base;   // no dataset entry → return with just the field-name fix

    const qualityBreakdown = deriveQuality(r);
    const typeBreakdown = deriveTypeBreakdown(r);
    const roadSamples = deriveRoadSamples(r);

    return {
        ...base,
        distanceMetres: Math.round(r.distance_km * 1000),
        estTimeMin: Math.round(r.estimated_travel_time_min),
        qualityBreakdown,
        typeBreakdown,
        roadSamples,
        // extra fields forwarded to frontend
        trafficLevel: r.traffic_level,
        shadeOverall: r.shade_overall,
        smoothRoad: r.smooth_road,
        fastestRoute: r.fastest_route
    };
}

module.exports = { loadRouteData, lookupRoute, enrichRoute };
