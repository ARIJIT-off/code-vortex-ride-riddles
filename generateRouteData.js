'use strict';
// generateRouteData.js — run once with `node generateRouteData.js`
// Produces routeData.json with all 240 A→B directed route pairs.
const fs = require('fs');
const path = require('path');

// ── 16 landmark coordinates (from the user's dataset) ──────────────────────
const NODES = {
    "IEM Newtown": { lat: 22.5765, lon: 88.4725 },
    "St. Xavier's University": { lat: 22.5803, lon: 88.4698 },
    "UEM Newtown": { lat: 22.5756, lon: 88.4712 },
    "WB Judicial Academy": { lat: 22.5820, lon: 88.4650 },
    "NKDA Office": { lat: 22.5890, lon: 88.4800 },
    "Hidco Bhaban": { lat: 22.5867, lon: 88.4756 },
    "Eco Park": { lat: 22.5973, lon: 88.4698 },
    "Biswa Bangla Gate": { lat: 22.5623, lon: 88.4723 },
    "City Centre 2": { lat: 22.5784, lon: 88.4634 },
    "Rosedale Garden": { lat: 22.5745, lon: 88.4680 },
    "City Centre 1": { lat: 22.5726, lon: 88.4195 },
    "Salt Lake Stadium": { lat: 22.5768, lon: 88.4063 },
    "Sector V": { lat: 22.5697, lon: 88.4342 },
    "Howrah Bridge": { lat: 22.5852, lon: 88.3467 },
    "Victoria Memorial": { lat: 22.5448, lon: 88.3426 },
    "Park Street": { lat: 22.5523, lon: 88.3511 }
};

// ── Zones ───────────────────────────────────────────────────────────────────
const ZONE = {
    "IEM Newtown": 'newtown', "St. Xavier's University": 'newtown',
    "UEM Newtown": 'newtown', "WB Judicial Academy": 'newtown',
    "NKDA Office": 'newtown', "Hidco Bhaban": 'newtown',
    "Eco Park": 'newtown', "Biswa Bangla Gate": 'newtown',
    "City Centre 2": 'newtown', "Rosedale Garden": 'newtown',
    "City Centre 1": 'saltlake', "Salt Lake Stadium": 'saltlake',
    "Sector V": 'saltlake',
    "Howrah Bridge": 'central', "Victoria Memorial": 'central',
    "Park Street": 'central'
};

function haversine(a, b) {
    const R = 6371, toR = x => x * Math.PI / 180;
    const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ── Road profile from zone pair ─────────────────────────────────────────────
function roadProfile(from, to) {
    const fz = ZONE[from], tz = ZONE[to];
    const pair = `${fz}-${tz}`;

    // Special cases matching the original dataset
    const isBBGCC2 = (from === 'Biswa Bangla Gate' && to === 'City Centre 2') ||
        (from === 'City Centre 2' && to === 'Biswa Bangla Gate');
    const isTertiary = ((from === 'Biswa Bangla Gate' || from === 'City Centre 2') && to === 'Rosedale Garden') ||
        (to === 'Biswa Bangla Gate' || to === 'City Centre 2') && from === 'Rosedale Garden' ||
        (from === 'Rosedale Garden' && to === 'City Centre 2') ||
        (from === 'City Centre 2' && to === 'Rosedale Garden');

    if (isBBGCC2) return { label: '6-Lane', cls: 'primary', lanes: 6, freeKph: 45, peakKph: 22, age: '2012', pothole: 'Medium', trees: true, bldgs: true, traffic: 'High', smooth: true };
    if (isTertiary) return { label: '2-Lane', cls: 'tertiary', lanes: 2, freeKph: 25, peakKph: 18, age: '2012', pothole: 'High', trees: true, bldgs: true, traffic: 'Medium', smooth: false };

    if (pair === 'central-central')
        return { label: '2-Lane', cls: 'tertiary', lanes: 2, freeKph: 25, peakKph: 18, age: '1970', pothole: 'High', trees: true, bldgs: true, traffic: 'Medium', smooth: false };
    if (pair === 'newtown-newtown' || pair === 'saltlake-newtown' || pair === 'newtown-saltlake') {
        // short residential vs standard 4-lane decided by caller using dist
        return { label: '4-Lane', cls: 'secondary', lanes: 4, freeKph: 35, peakKph: 25, age: '2012', pothole: 'High', trees: true, bldgs: true, traffic: 'Medium', smooth: false };
    }
    if (pair === 'saltlake-saltlake')
        return { label: '4-Lane', cls: 'secondary', lanes: 4, freeKph: 35, peakKph: 25, age: '1990', pothole: 'High', trees: true, bldgs: false, traffic: 'Medium', smooth: false };
    if (pair === 'central-saltlake' || pair === 'saltlake-central')
        return { label: '4-Lane', cls: 'primary', lanes: 4, freeKph: 45, peakKph: 22, age: '1980', pothole: 'High', trees: true, bldgs: true, traffic: 'High', smooth: false };
    // cross-city (central ↔ newtown, etc.)
    return { label: '6-Lane', cls: 'primary', lanes: 6, freeKph: 45, peakKph: 22, age: '2005', pothole: 'High', trees: false, bldgs: true, traffic: 'High', smooth: false };
}

// ── Build all 240 pairs ─────────────────────────────────────────────────────
const nodeNames = Object.keys(NODES);
const routes = [];

for (const from of nodeNames) {
    const fromRoutes = [];
    for (const to of nodeNames) {
        if (from === to) continue;

        const straight = haversine(NODES[from], NODES[to]);
        const distKm = parseFloat((straight * 1.33).toFixed(2));
        const p = roadProfile(from, to);

        // Short residential override (< 0.5 km Newtown internal)
        let profile = p;
        if (distKm < 0.5 && ZONE[from] === 'newtown' && ZONE[to] === 'newtown') {
            profile = { label: '2-Lane', cls: 'residential', lanes: 2, freeKph: 20, peakKph: 20, age: '2012', pothole: 'Very High', trees: true, bldgs: true, traffic: 'Low', smooth: false };
        }

        const noTrafficMin = parseFloat((distKm / profile.freeKph * 60).toFixed(1));
        const estTimeMin = parseFloat((distKm / profile.peakKph * 60).toFixed(1));
        const maxBldg = profile.bldgs ? (ZONE[to] === 'central' ? 8 : ZONE[to] === 'saltlake' ? 3 : 6) : 2;

        fromRoutes.push({
            place_from: from,
            place_to: to,
            road_type_label: profile.label,
            highway_class: profile.cls,
            lanes: profile.lanes,
            is_oneway: false,
            distance_km: distKm,
            duration_min_no_traffic: noTrafficMin,
            estimated_travel_time_min: estTimeMin,
            avg_speed_kmph: profile.peakKph,
            surface_material: 'asphalt',
            road_age_start_date: profile.age,
            pothole_risk: profile.pothole,
            shade_trees: profile.trees,
            shade_buildings: profile.bldgs,
            shade_overall: profile.trees || profile.bldgs,
            max_building_levels_nearby: maxBldg,
            traffic_peak_hours: '8AM-10AM, 5PM-8PM',
            traffic_level: profile.traffic,
            smooth_road: profile.smooth,
            fastest_route: false,
            data_source: 'OSM-based synthetic (Nominatim coords + OSM road logic + Kolkata zone profiles)'
        });
    }
    // Mark fastest route per source
    if (fromRoutes.length) {
        fromRoutes.reduce((m, r) => r.estimated_travel_time_min < m.estimated_travel_time_min ? r : m).fastest_route = true;
    }
    routes.push(...fromRoutes);
}

const output = {
    metadata: {
        project: 'RideRiddles', city: 'Kolkata, West Bengal, India',
        total_pairs: routes.length, nodes_count: nodeNames.length,
        nodes: nodeNames, coordinates: NODES,
        data_sources: ['Verified GPS coordinates', 'OSM highway classification', 'Kolkata zone profiles', 'Peak hour traffic patterns'],
        preferences_map: {
            'SMOOTH ROAD': 'Filter where smooth_road == true',
            'TRAFFIC': 'Sort/filter by traffic_level (Low preferred)',
            'SHADE': 'Filter where shade_overall == true',
            'FASTEST': 'Filter where fastest_route == true OR sort by estimated_travel_time_min'
        }
    },
    routes
};

const outPath = path.join(__dirname, 'routeData.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`✅ routeData.json written — ${routes.length} route pairs across ${nodeNames.length} nodes`);
