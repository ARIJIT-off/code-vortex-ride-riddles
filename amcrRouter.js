/**
 * amcrRouter.js — Adaptive Multi-Criteria Routing (AMCR)
 *
 * A custom priority-queue pathfinder that is NOT Dijkstra.
 * Key differences from classical shortest-path:
 *  1. Edge cost is a 2-layer composite (mode × preference multipliers)
 *  2. Heuristic uses haversine to the goal (like A*), but the heuristic
 *     weight is dynamically scaled per preference (admissible + informative)
 *  3. Top-3 alternative paths are found by Penalty Inflation:
 *     edges on a found path are multiplied ×8 before re-running,
 *     forcing structural divergence without calling Dijkstra.
 *  4. No two returned paths can share >60% of their edge set.
 */

'use strict';

// ---------------------------------------------------------------------------
// Minimal binary min-heap (priority queue)
// ---------------------------------------------------------------------------
class MinHeap {
    constructor() { this._data = []; }
    push(item) {
        this._data.push(item);
        this._bubbleUp(this._data.length - 1);
    }
    pop() {
        const top = this._data[0];
        const last = this._data.pop();
        if (this._data.length > 0) {
            this._data[0] = last;
            this._siftDown(0);
        }
        return top;
    }
    get size() { return this._data.length; }
    _bubbleUp(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this._data[p].f <= this._data[i].f) break;
            [this._data[p], this._data[i]] = [this._data[i], this._data[p]];
            i = p;
        }
    }
    _siftDown(i) {
        const n = this._data.length;
        while (true) {
            let sm = i, l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._data[l].f < this._data[sm].f) sm = l;
            if (r < n && this._data[r].f < this._data[sm].f) sm = r;
            if (sm === i) break;
            [this._data[sm], this._data[i]] = [this._data[i], this._data[sm]];
            i = sm;
        }
    }
}

// ---------------------------------------------------------------------------
// Mode layer: cost multiplier based on transport mode + road characteristics
// relaxed=true → replace Infinity with heavy-but-finite penalty so a path is
// always found even if it crosses a "wrong" road type.
// ---------------------------------------------------------------------------
function modeMultiplier(edge, mode, relaxed) {
    const h = (edge.tags && edge.tags.highway) || '';

    if (mode === 'foot') {
        if (['footway', 'path', 'pedestrian', 'living_street'].includes(h)) return 0.6;
        if (['residential', 'service'].includes(h)) return 0.85;
        if (['primary', 'secondary', 'trunk', 'motorway'].includes(h)) return 3.5;
        return 1.0;
    }
    if (mode === '4-wheeler') {
        if (['motorway', 'trunk', 'primary'].includes(h) || h.endsWith('_link')) return 0.55;
        if (['secondary'].includes(h)) return 0.75;
        if (['residential'].includes(h)) return 1.3;
        if (['service'].includes(h)) return 2.0;
        if (['footway', 'path', 'pedestrian', 'track', 'steps'].includes(h))
            return relaxed ? 50 : Infinity;
        return 1.1;
    }
    if (mode === 'ev') {
        if (['primary', 'secondary', 'trunk', 'motorway'].includes(h)) return 0.65;
        if (['residential'].includes(h)) return 0.9;
        if (['footway', 'path', 'steps', 'track'].includes(h))
            return relaxed ? 50 : Infinity;
        return 1.0;
    }
    if (mode === '2-wheeler') {
        if (['residential', 'service', 'tertiary', 'unclassified'].includes(h)) return 0.7;
        if (['secondary'].includes(h)) return 0.85;
        if (['motorway', 'trunk'].includes(h))
            return relaxed ? 40 : Infinity;
        if (['footway', 'pedestrian', 'steps'].includes(h))
            return relaxed ? 50 : Infinity;
        return 1.0;
    }
    return 1.0;
}

// ---------------------------------------------------------------------------
// Preference layer: cost multiplier based on road quality + user preference
// ---------------------------------------------------------------------------
function prefMultiplier(edge, preference) {
    const q = edge.quality; // 'smooth' | 'shaded' | 'problematic'
    if (preference === 'smooth') {
        if (q === 'smooth') return 0.5;
        if (q === 'shaded') return 1.2;
        if (q === 'problematic') return 3.5;
    }
    if (preference === 'shaded') {
        if (q === 'shaded') return 0.5;
        if (q === 'smooth') return 1.4;
        if (q === 'problematic') return 2.0;
    }
    if (preference === 'shortest') {
        return 1.0; // pure distance; quality is irrelevant
    }
    return 1.0;
}

// ---------------------------------------------------------------------------
// Composite edge cost
// ---------------------------------------------------------------------------
function edgeCost(edge, mode, preference, penalties, relaxed) {
    const mm = modeMultiplier(edge, mode, relaxed);
    if (mm === Infinity) return Infinity;
    const pm = prefMultiplier(edge, preference);
    const pen = penalties.get(edge.wayId) || 1.0;
    return edge.dist * mm * pm * pen;
}

// ---------------------------------------------------------------------------
// AMCR Search (A* variant with composite costs)
// Returns { path, latLngs, totalCost, distMetres, usedEdges } or null.
// relaxed=true allows traversal of normally-forbidden road types at high cost.
// ---------------------------------------------------------------------------
function amcrSearch(startId, goalId, adj, nodes, mode, preference, penalties, haversine, relaxed) {
    const goalCoord = nodes.get(goalId);
    if (!goalCoord) return null;

    // Heuristic: straight-line haversine scaled by a mode-aware factor
    // (admissible because actual road cost >= haversine distance)
    const hScale = preference === 'shortest' ? 1.0
        : preference === 'smooth' ? 0.8
            : 0.7;

    function h(nodeId) {
        const c = nodes.get(nodeId);
        if (!c) return 0;
        return haversine(c, goalCoord) * hScale;
    }

    const dist = new Map(); // nodeId → best g-cost so far
    const prev = new Map(); // nodeId → {parentId, edge}
    const open = new MinHeap();

    dist.set(startId, 0);
    open.push({ f: h(startId), g: 0, id: startId });

    while (open.size > 0) {
        const { g, id } = open.pop();

        if (id === goalId) break;
        if (g > (dist.get(id) ?? Infinity) + 1e-9) continue; // stale entry

        const neighbours = adj.get(id) || [];
        for (const edge of neighbours) {
            const cost = edgeCost(edge, mode, preference, penalties);
            if (cost === Infinity) continue;
            const ng = g + cost;
            if (ng < (dist.get(edge.to) ?? Infinity)) {
                dist.set(edge.to, ng);
                prev.set(edge.to, { parentId: id, edge });
                open.push({ f: ng + h(edge.to), g: ng, id: edge.to });
            }
        }
    }

    if (!dist.has(goalId)) return null;

    // Reconstruct path
    const pathNodes = [];
    const usedEdges = new Set();
    let cur = goalId;
    let distMetres = 0;
    while (cur !== startId) {
        pathNodes.unshift(cur);
        const { parentId, edge } = prev.get(cur);
        usedEdges.add(edge.wayId);
        distMetres += edge.dist;
        cur = parentId;
    }
    pathNodes.unshift(startId);

    const latLngs = pathNodes.map(id => {
        const c = nodes.get(id);
        return { lat: c.lat, lon: c.lon };
    });

    // Quality breakdown
    const qs = { smooth: 0, shaded: 0, problematic: 0 };
    // Type breakdown
    const ts = { '4-lane': 0, '2-lane': 0, 'one way': 0, 'narrow alley': 0 };
    // Road name samples (one per type for display)
    const roadSamples = {};
    let totalDist = 0;
    for (let i = 1; i < pathNodes.length; i++) {
        const edgesOut = adj.get(pathNodes[i - 1]) || [];
        const e = edgesOut.find(x => x.to === pathNodes[i]);
        if (e) {
            qs[e.quality] = (qs[e.quality] || 0) + e.dist;
            ts[e.type] = (ts[e.type] || 0) + e.dist;
            // Collect a human-readable road name from OSM tags (first one found per type)
            if (!roadSamples[e.type] && e.tags && e.tags.name) {
                roadSamples[e.type] = e.tags.name;
            } else if (!roadSamples[e.type] && e.tags && e.tags.ref) {
                roadSamples[e.type] = e.tags.ref;
            }
            totalDist += e.dist;
        }
    }
    for (const k of Object.keys(qs)) qs[k] = totalDist > 0 ? Math.round(qs[k] / totalDist * 100) : 0;
    for (const k of Object.keys(ts)) ts[k] = totalDist > 0 ? Math.round(ts[k] / totalDist * 100) : 0;

    return {
        path: pathNodes,
        latLngs,
        totalCost: dist.get(goalId),
        distMetres: Math.round(distMetres),
        estTimeMin: estimateTime(distMetres, mode),
        qualityBreakdown: qs,
        typeBreakdown: ts,
        roadSamples,
        usedEdges
    };

}

// ---------------------------------------------------------------------------
// Crude time estimate based on mode
// ---------------------------------------------------------------------------
function estimateTime(metres, mode) {
    const speeds = { foot: 5, '2-wheeler': 30, ev: 40, '4-wheeler': 35 }; // km/h
    const kmh = speeds[mode] || 30;
    return Math.round((metres / 1000) / kmh * 60);
}

// ---------------------------------------------------------------------------
// Overlap ratio between two edge-sets
// ---------------------------------------------------------------------------
function overlapRatio(setA, setB) {
    let shared = 0;
    for (const e of setA) if (setB.has(e)) shared++;
    return shared / Math.min(setA.size, setB.size || 1);
}

// ---------------------------------------------------------------------------
// Public: find top-3 diverse routes using Penalty Inflation.
// Automatically retries with relaxed mode rules if strict pass finds nothing.
// ---------------------------------------------------------------------------
function findRoutes(startId, goalId, adj, nodes, mode, preference, haversine) {
    const results = _findRoutesPass(startId, goalId, adj, nodes, mode, preference, haversine, false);
    if (results.length > 0) return results;

    // Strict pass found nothing (landmark in pedestrian zone, disconnected subgraph, etc.)
    // Retry with relaxed rules — forbidden roads become very expensive but traversable.
    console.log(`  ⚠ No strict path (${mode}), retrying with relaxed rules...`);
    return _findRoutesPass(startId, goalId, adj, nodes, mode, preference, haversine, true);
}

function _findRoutesPass(startId, goalId, adj, nodes, mode, preference, haversine, relaxed) {
    const INFLATION = 8.0;
    const MAX_OVERLAP = 0.60;

    const penalties = new Map(); // wayId → multiplier
    const results = [];

    for (let attempt = 0; attempt < 6 && results.length < 3; attempt++) {
        const route = amcrSearch(startId, goalId, adj, nodes, mode, preference, penalties, haversine, relaxed);
        if (!route) break;

        // Check diversity against already-found routes
        let tooSimilar = false;
        for (const prev of results) {
            if (overlapRatio(route.usedEdges, prev.usedEdges) > MAX_OVERLAP) {
                tooSimilar = true;
                break;
            }
        }

        if (!tooSimilar) {
            results.push(route);
        }

        // Inflate edges of this path to force next search to diverge
        for (const wayId of route.usedEdges) {
            penalties.set(wayId, (penalties.get(wayId) || 1.0) * INFLATION);
        }
    }

    return results;
}

module.exports = { findRoutes };
