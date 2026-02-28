/**
 * osmGraph.js — Real road graph from Overpass API + self-geocoding landmarks
 *
 * On startup this module:
 *  1. Fetches live OSM road network from Overpass (wider Kolkata BBOX)
 *  2. Geocodes every landmark by its real OSM name via a second Overpass call
 *  3. Falls back to hard-coded coordinates if geocoding fails
 *
 * Road quality (deterministic from OSM way ID):
 *   id % 4 === 0 or 1  → "smooth"      (50%)
 *   id % 4 === 2        → "shaded"      (25%)
 *   id % 4 === 3        → "problematic" (25%)
 */

'use strict';

// ---------------------------------------------------------------------------
// Bounding box — wider to cover Kolkata city (allows landmarks beyond New Town)
// ---------------------------------------------------------------------------
const BBOX = '22.520,88.320,22.640,88.520';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ---------------------------------------------------------------------------
// Road data query (OSM highway network)
// ---------------------------------------------------------------------------
const ROAD_QUERY = `
[out:json][timeout:120];
(
  way["highway"]["highway"!~"proposed|construction|abandoned|platform|raceway"]
     (${BBOX});
);
out body;
>;
out skel qt;
`;

// ---------------------------------------------------------------------------
// Haversine distance in metres
// ---------------------------------------------------------------------------
function haversine(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------------------------------------------------------------------------
// Road quality from OSM way ID
// ---------------------------------------------------------------------------
function qualityFromId(osmId) {
    const v = Number(osmId) % 4;
    if (v === 0 || v === 1) return 'smooth';
    if (v === 2) return 'shaded';
    return 'problematic';
}

// ---------------------------------------------------------------------------
// OSM highway tag → road-type label
// ---------------------------------------------------------------------------
function roadType(tags = {}) {
    const h = tags.highway || '';
    if (['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(h)) return '4-lane';
    if (['primary', 'primary_link', 'secondary', 'secondary_link'].includes(h)) return '2-lane';
    if (['tertiary', 'tertiary_link', 'unclassified', 'residential'].includes(h)) return '2-lane';
    if (h === 'service') return 'one way';
    if (['footway', 'path', 'pedestrian', 'steps', 'track', 'living_street'].includes(h)) return 'narrow alley';
    return '2-lane';
}

// ---------------------------------------------------------------------------
// Mode access rules
// ---------------------------------------------------------------------------
function modeAllowed(mode, tags = {}) {
    const h = tags.highway || '';
    if (mode === 'foot')
        return !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(h);
    if (mode === '4-wheeler')
        return !['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track'].includes(h);
    if (mode === 'ev')
        return !['footway', 'path', 'pedestrian', 'steps', 'track'].includes(h);
    if (mode === '2-wheeler')
        return !['motorway', 'motorway_link', 'footway', 'pedestrian', 'steps'].includes(h);
    return true;
}

// ---------------------------------------------------------------------------
// Build adjacency graph from raw Overpass JSON
// ---------------------------------------------------------------------------
function buildGraph(overpassData) {
    const coordMap = new Map();
    const adj = new Map();

    for (const el of overpassData.elements) {
        if (el.type === 'node') {
            coordMap.set(el.id, { lat: el.lat, lon: el.lon });
        }
    }

    for (const el of overpassData.elements) {
        if (el.type !== 'way') continue;
        const refs = el.nodes;
        const tags = el.tags || {};
        const isOneway = tags.oneway === 'yes' || tags.junction === 'roundabout';
        const quality = qualityFromId(el.id);
        const type = roadType(tags);

        for (let i = 0; i < refs.length - 1; i++) {
            const a = refs[i], b = refs[i + 1];
            const cA = coordMap.get(a), cB = coordMap.get(b);
            if (!cA || !cB) continue;

            const dist = haversine(cA, cB);
            if (dist < 0.1) continue;

            if (!adj.has(a)) adj.set(a, []);
            if (!adj.has(b)) adj.set(b, []);

            adj.get(a).push({ to: b, dist, quality, type, tags, wayId: el.id });
            if (!isOneway) {
                adj.get(b).push({ to: a, dist, quality, type, tags, wayId: el.id });
            }
        }
    }

    return { nodes: coordMap, adj };
}

// ---------------------------------------------------------------------------
// Fetch OSM road graph from Overpass
// ---------------------------------------------------------------------------
async function fetchRoadGraph() {
    console.log('🗺  Fetching OSM road data from Overpass API...');
    try {
        const res = await fetch(OVERPASS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(ROAD_QUERY),
            signal: AbortSignal.timeout(120000)
        });
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        const json = await res.json();
        console.log(`✅ OSM data fetched: ${json.elements.length} elements`);
        return buildGraph(json);
    } catch (err) {
        console.warn('⚠️  Road graph fetch failed:', err.message);
        console.warn('   Falling back to offline landmark graph.');
        return null;
    }
}

// ---------------------------------------------------------------------------
// LANDMARK DEFINITIONS
//
// Each entry has:
//   name       – display name shown in the UI dropdown & map popup
//   searchName – the OSM name= tag to look up (may differ from display name)
//   lat / lon  – FALLBACK coordinates used if Overpass geocoding fails
//
// Covers New Town (Action Area I/II/III) + broader Kolkata landmarks
// so that routes can span a larger, real-world network.
// ---------------------------------------------------------------------------
const LANDMARKS = [
    // ── New Town / Action Area III ────────────────────────────────────────
    {
        name: 'IEM Salt Lake',
        searchName: 'Institute of Engineering & Management',
        lat: 22.5776, lon: 88.4625
    },
    {
        name: 'St. Xaviers University',
        searchName: "St. Xavier's University",
        lat: 22.5789, lon: 88.4608
    },
    {
        name: 'WB Judicial Academy',
        searchName: 'West Bengal Judicial Academy',
        lat: 22.5697, lon: 88.4718
    },
    {
        name: 'NKDA Office',
        searchName: 'New Town Kolkata Development Authority',
        lat: 22.5800, lon: 88.4701
    },
    {
        name: 'Hidco Bhaban',
        searchName: 'HIDCO Bhaban',
        lat: 22.5842, lon: 88.4783
    },
    // ── Eco Park / Action Area II ─────────────────────────────────────────
    {
        name: 'Eco Park',
        searchName: 'Eco Park',
        lat: 22.5954, lon: 88.4718
    },
    {
        name: 'Biswa Bangla Gate',
        searchName: 'Biswa Bangla Gate',
        lat: 22.5780, lon: 88.4780
    },
    {
        name: 'City Centre 2',
        searchName: 'City Centre 2',
        lat: 22.5725, lon: 88.4744
    },
    {
        name: 'Rosedale Garden',
        searchName: 'Rosedale Garden',
        lat: 22.5802, lon: 88.4651
    },
    // ── Salt Lake / Sector V ──────────────────────────────────────────────
    {
        name: 'City Centre 1',
        searchName: 'City Centre 1',
        lat: 22.5697, lon: 88.4304
    },
    {
        name: 'Salt Lake Stadium',
        searchName: 'Vivekananda Yuba Bharati Krirangan',
        lat: 22.5729, lon: 88.4160
    },
    {
        name: 'Sector V',
        searchName: 'Sector V',
        lat: 22.5766, lon: 88.4374
    },
    // ── Central Kolkata ───────────────────────────────────────────────────
    {
        name: 'Howrah Bridge',
        searchName: 'Howrah Bridge',
        lat: 22.5853, lon: 88.3467
    },
    {
        name: 'Victoria Memorial',
        searchName: 'Victoria Memorial',
        lat: 22.5448, lon: 88.3426
    },
    {
        name: 'Park Street',
        searchName: 'Park Street',
        lat: 22.5524, lon: 88.3523
    },
];

// ---------------------------------------------------------------------------
// Geocode all landmarks at once using a single Overpass query
// Returns a Map: searchName → { lat, lon }
// ---------------------------------------------------------------------------
async function geocodeLandmarksByName(landmarks) {
    // Build a union query asking for nodes/ways/relations for every search name
    const parts = landmarks.map(lm => {
        const escaped = lm.searchName.replace(/"/g, '\\"');
        return [
            `node["name"="${escaped}"](${BBOX});`,
            `way["name"="${escaped}"](${BBOX});`,
            `relation["name"="${escaped}"](${BBOX});`
        ].join('\n');
    }).join('\n');

    const query = `[out:json][timeout:60];\n(\n${parts}\n);\nout center;`;

    console.log('📍 Geocoding landmarks from OSM...');
    try {
        const res = await fetch(OVERPASS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
            signal: AbortSignal.timeout(60000)
        });
        if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
        const json = await res.json();

        // Build a map from OSM name → first-found {lat, lon}
        const resolved = new Map();
        for (const el of json.elements) {
            const elName = el.tags && el.tags.name;
            if (!elName) continue;
            if (resolved.has(elName)) continue; // first hit wins

            let lat, lon;
            if (el.type === 'node') {
                lat = el.lat; lon = el.lon;
            } else if (el.center) {
                lat = el.center.lat; lon = el.center.lon;
            }
            if (lat !== undefined) resolved.set(elName, { lat, lon });
        }

        const found = resolved.size;
        console.log(`✅ Geocoded ${found} / ${landmarks.length} landmarks from OSM`);

        // Log each result
        for (const lm of landmarks) {
            const r = resolved.get(lm.searchName);
            if (r) {
                console.log(`   ✓ ${lm.name}: ${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`);
            } else {
                console.log(`   ✗ ${lm.name}: using fallback (${lm.lat}, ${lm.lon})`);
            }
        }

        return resolved;

    } catch (err) {
        console.warn('⚠️  Geocoding failed:', err.message, '— using fallback coords.');
        return new Map();
    }
}

// ---------------------------------------------------------------------------
// Snap a {lat, lon} to the nearest OSM road node in the graph (mode-blind)
// ---------------------------------------------------------------------------
function findNearestNode(lat, lon, coordMap) {
    let best = null, bestDist = Infinity;
    for (const [id, coord] of coordMap) {
        const d = haversine({ lat, lon }, coord);
        if (d < bestDist) { bestDist = d; best = id; }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Snap a {lat, lon} to the nearest OSM node that has at least one outgoing
// edge the given transport mode can actually traverse.
//
// One O(n) pass — O(deg) inner check per node, deg is usually ≤ 6.
// Falls back to absolute nearest if nothing mode-accessible is found.
// ---------------------------------------------------------------------------
const MODE_FORBIDDEN = {
    '4-wheeler': new Set(['footway', 'path', 'pedestrian', 'track', 'steps', 'cycleway', 'bridleway']),
    'ev': new Set(['footway', 'path', 'pedestrian', 'steps', 'track', 'cycleway', 'bridleway']),
    '2-wheeler': new Set(['motorway', 'motorway_link', 'footway', 'pedestrian', 'steps', 'cycleway']),
    'foot': new Set()   // foot can traverse everything
};

function findNearestAccessibleNode(lat, lon, adj, nodes, mode) {
    const forbidden = MODE_FORBIDDEN[mode] || new Set();

    let bestId = null, bestDist = Infinity;   // nearest with a usable edge
    let fallId = null, fallDist = Infinity;   // absolute nearest (safety net)

    for (const [id, coord] of nodes) {
        const d = haversine({ lat, lon }, coord);

        // Track absolute nearest as an ultimate fallback
        if (d < fallDist) { fallDist = d; fallId = id; }

        // Track nearest node with at least one mode-accessible outgoing edge
        if (d < bestDist) {
            const edges = adj.get(id);
            if (edges && edges.length > 0) {
                const ok = edges.some(e => {
                    const h = (e.tags && e.tags.highway) || '';
                    return !forbidden.has(h);
                });
                if (ok) { bestDist = d; bestId = id; }
            }
        }
    }

    // If mode-accessible snap is more than 500 m farther than absolute nearest,
    // the landmark is truly inside a pedestrian-only zone. Still use it — the
    // relaxed fallback in the router will handle the crossing.
    return bestId || fallId;
}


// ---------------------------------------------------------------------------
// Offline fallback graph (used if Overpass road fetch completely fails)
// ---------------------------------------------------------------------------
function buildFallbackGraph() {
    const coordMap = new Map();
    const adj = new Map();

    LANDMARKS.forEach((lm, idx) => {
        const id = 1000 + idx;
        coordMap.set(id, { lat: lm.lat, lon: lm.lon, name: lm.name });
        adj.set(id, []);
    });

    const qualities = ['smooth', 'smooth', 'shaded', 'problematic'];
    const types = ['4-lane', '2-lane', 'one way', 'narrow alley'];
    const lmIds = Array.from(coordMap.keys());

    for (let i = 0; i < lmIds.length; i++) {
        for (let j = i + 1; j < lmIds.length; j++) {
            const a = lmIds[i], b = lmIds[j];
            const cA = coordMap.get(a), cB = coordMap.get(b);
            const dist = haversine(cA, cB);
            const q = qualities[(i + j) % 4];
            const t = types[(i * 3 + j) % 4];
            const wId = (i + 1) * 100 + (j + 1);
            adj.get(a).push({ to: b, dist, quality: q, type: t, tags: { highway: 'residential' }, wayId: wId });
            adj.get(b).push({ to: a, dist, quality: q, type: t, tags: { highway: 'residential' }, wayId: wId });
        }
    }

    return { nodes: coordMap, adj };
}

// ---------------------------------------------------------------------------
// Main export — called once at server startup
// ---------------------------------------------------------------------------
async function loadOSMGraph() {
    // 1. Fetch road network
    const graphResult = await fetchRoadGraph();
    const { nodes, adj } = graphResult || buildFallbackGraph();

    // 2. Geocode landmark names via Overpass (parallel with road fetch is OK
    //    but we need nodes first for snapping, so we do it sequentially)
    const geocoded = await geocodeLandmarksByName(LANDMARKS);

    // 3. Merge geocoded coords (real OSM position) with fallback coords,
    //    then snap each landmark to the nearest road node
    const landmarkNodes = LANDMARKS.map(lm => {
        const real = geocoded.get(lm.searchName);
        const lat = real ? real.lat : lm.lat;
        const lon = real ? real.lon : lm.lon;
        const nodeId = findNearestNode(lat, lon, nodes);
        // Update the snapped node's coord entry with the landmark name (for popups)
        if (nodeId && nodes.has(nodeId)) {
            // don't overwrite the coord, just record the landmark name
        }
        return { name: lm.name, lat, lon, nodeId, geocoded: !!real };
    });

    return { nodes, adj, landmarks: landmarkNodes, haversine, modeAllowed };
}

module.exports = { loadOSMGraph, haversine, modeAllowed, LANDMARKS, findNearestAccessibleNode };
