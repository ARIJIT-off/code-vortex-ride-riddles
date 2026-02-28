/**
 * biDirRouter.js — Bidirectional A* Router for RIDE_RIDDLES
 *
 * Runs two simultaneous A* searches — forward from start, backward from goal.
 * When the two frontiers meet, the best combined path is extracted.
 *
 * This is significantly faster than one-directional A* on large OSM graphs
 * because it explores roughly half the nodes (two circles instead of one).
 *
 * Edge cost model:
 *   cost = dist × modeMultiplier(mode) × prefMultiplier(quality, preference) × penalty
 *
 * Road quality distribution guaranteed by osmGraph.js:
 *   50% smooth · 25% shaded · 25% problematic
 *
 * Top-3 diverse routes via Penalty Inflation (×8 on used edges, overlap < 60%).
 */

'use strict';

// ---------------------------------------------------------------------------
// Binary Min-Heap (priority queue keyed on `.f`)
// ---------------------------------------------------------------------------
class MinHeap {
    constructor() { this._d = []; }
    push(item) { this._d.push(item); this._up(this._d.length - 1); }
    pop() {
        const top = this._d[0];
        const last = this._d.pop();
        if (this._d.length > 0) { this._d[0] = last; this._dn(0); }
        return top;
    }
    get size() { return this._d.length; }
    _up(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this._d[p].f <= this._d[i].f) break;
            [this._d[p], this._d[i]] = [this._d[i], this._d[p]];
            i = p;
        }
    }
    _dn(i) {
        const n = this._d.length;
        while (true) {
            let sm = i, l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._d[l].f < this._d[sm].f) sm = l;
            if (r < n && this._d[r].f < this._d[sm].f) sm = r;
            if (sm === i) break;
            [this._d[sm], this._d[i]] = [this._d[i], this._d[sm]];
            i = sm;
        }
    }
}

// ---------------------------------------------------------------------------
// Mode cost multiplier  (how suitable is this road for this vehicle?)
// ---------------------------------------------------------------------------
function modeMultiplier(edge, mode) {
    const h = (edge.tags && edge.tags.highway) || '';
    if (mode === 'foot') {
        if (['footway', 'path', 'pedestrian', 'living_street'].includes(h)) return 0.55;
        if (['residential', 'service'].includes(h)) return 0.80;
        if (['primary', 'secondary', 'trunk', 'motorway'].includes(h)) return 3.80;
        return 1.0;
    }
    if (mode === '4-wheeler') {
        if (['motorway', 'trunk', 'primary'].includes(h) || h.endsWith('_link')) return 0.50;
        if (['secondary'].includes(h)) return 0.70;
        if (['residential'].includes(h)) return 1.20;
        if (['service'].includes(h)) return 1.90;
        if (['footway', 'path', 'pedestrian', 'track', 'steps'].includes(h)) return Infinity;
        return 1.05;
    }
    if (mode === 'ev') {
        if (['primary', 'secondary', 'trunk', 'motorway'].includes(h)) return 0.60;
        if (['residential'].includes(h)) return 0.85;
        if (['footway', 'path', 'steps', 'track'].includes(h)) return Infinity;
        return 0.95;
    }
    if (mode === '2-wheeler') {
        if (['residential', 'service', 'tertiary', 'unclassified'].includes(h)) return 0.65;
        if (['secondary'].includes(h)) return 0.80;
        if (['motorway', 'trunk'].includes(h)) return Infinity;
        if (['footway', 'pedestrian', 'steps'].includes(h)) return Infinity;
        return 0.95;
    }
    return 1.0;
}

// ---------------------------------------------------------------------------
// Preference cost multiplier  (matches user preference to road quality)
// ---------------------------------------------------------------------------
function prefMultiplier(edge, preference) {
    const q = edge.quality; // 'smooth' | 'shaded' | 'problematic'
    if (preference === 'smooth') {
        if (q === 'smooth') return 0.45;
        if (q === 'shaded') return 1.30;
        if (q === 'problematic') return 3.80;
    }
    if (preference === 'shaded') {
        if (q === 'shaded') return 0.45;
        if (q === 'smooth') return 1.40;
        if (q === 'problematic') return 2.20;
    }
    return 1.0; // 'shortest' — pure distance
}

// ---------------------------------------------------------------------------
// Composite edge cost
// ---------------------------------------------------------------------------
function edgeCost(edge, mode, preference, penalties) {
    const mm = modeMultiplier(edge, mode);
    if (mm === Infinity) return Infinity;
    const pm = prefMultiplier(edge, preference);
    const pen = penalties.get(edge.wayId) || 1.0;
    return edge.dist * mm * pm * pen;
}

// ---------------------------------------------------------------------------
// Bidirectional A* core search
//
//   Returns { path, latLngs, totalCost, distMetres, estTimeMin,
//             qualityBreakdown, usedEdges } or null
// ---------------------------------------------------------------------------
function biDirSearch(startId, goalId, adj, nodes, mode, preference, penalties, haversine) {
    if (startId === goalId) return null;
    const startCoord = nodes.get(startId);
    const goalCoord = nodes.get(goalId);
    if (!startCoord || !goalCoord) return null;

    // Heuristic scale (admissible — actual road distance >= straight-line)
    const hScale = preference === 'shortest' ? 1.0 : preference === 'smooth' ? 0.75 : 0.65;

    const hFwd = id => {
        const c = nodes.get(id); return c ? haversine(c, goalCoord) * hScale : 0;
    };
    const hBwd = id => {
        const c = nodes.get(id); return c ? haversine(c, startCoord) * hScale : 0;
    };

    // Forward search state
    const gF = new Map([[startId, 0]]);
    const prevF = new Map();                    // nodeId → {parentId, edge}
    const closedF = new Set();
    const openF = new MinHeap();
    openF.push({ f: hFwd(startId), g: 0, id: startId });

    // Backward search state
    const gB = new Map([[goalId, 0]]);
    const prevB = new Map();
    const closedB = new Set();
    const openB = new MinHeap();
    openB.push({ f: hBwd(goalId), g: 0, id: goalId });

    let bestCost = Infinity;
    let meetNode = null;

    // Helper: expand one node from a frontier
    function expand(heapSrc, gSrc, prevSrc, closedSrc, gOther, closedOther, modeFn) {
        if (heapSrc.size === 0) return false;
        const { g, id } = heapSrc.pop();
        if (closedSrc.has(id)) return true;
        closedSrc.add(id);

        if (g > (gSrc.get(id) ?? Infinity) + 1e-9) return true;

        // Check if we can form a complete path through this node
        if (gOther.has(id)) {
            const combined = g + gOther.get(id);
            if (combined < bestCost) { bestCost = combined; meetNode = id; }
        }

        const neighbours = modeFn(id);
        for (const edge of neighbours) {
            const cost = edgeCost(edge, mode, preference, penalties);
            if (cost === Infinity) continue;
            const ng = g + cost;
            if (ng < (gSrc.get(edge.to) ?? Infinity)) {
                gSrc.set(edge.to, ng);
                prevSrc.set(edge.to, { parentId: id, edge });
                heapSrc.push({ f: ng + (heapSrc === openF ? hFwd(edge.to) : hBwd(edge.to)), g: ng, id: edge.to });
            }
        }
        return true;
    }

    // Build reverse adjacency lazily using existing adj (roads are mostly bidirectional)
    const getNeighBwd = id => {
        const edges = adj.get(id) || [];
        return edges;
    };

    const MAX_ITER = 300000;
    for (let iter = 0; iter < MAX_ITER; iter++) {
        const fDone = !expand(openF, gF, prevF, closedF, gB, closedB, id => adj.get(id) || []);
        const bDone = !expand(openB, gB, prevB, closedB, gF, closedF, getNeighBwd);

        if (fDone && bDone) break;

        // Termination: both top-of-heap costs exceed best found so far
        const fBest = openF.size > 0 ? openF._d[0].f : Infinity;
        const bBest = openB.size > 0 ? openB._d[0].f : Infinity;
        if (meetNode && fBest + bBest >= bestCost - 1e-9) break;
    }

    if (!meetNode) return null;

    // Reconstruct forward half: start → meetNode
    const fwdPath = [];
    let cur = meetNode;
    while (cur !== startId) {
        fwdPath.unshift(cur);
        const entry = prevF.get(cur);
        if (!entry) return null;
        cur = entry.parentId;
    }
    fwdPath.unshift(startId);

    // Reconstruct backward half: meetNode → goal
    const bwdPath = [];
    cur = meetNode;
    while (cur !== goalId) {
        const entry = prevB.get(cur);
        if (!entry) break;
        bwdPath.push(entry.edge.to);
        cur = entry.edge.to;
    }
    // Deduplicate: meetNode already included in fwdPath
    const fullPath = [...fwdPath, ...bwdPath];

    if (fullPath.length < 2) return null;

    // Build latLngs and collect edges
    const latLngs = [];
    const usedEdges = new Set();
    let distMetres = 0;

    const qs = { smooth: 0, shaded: 0, problematic: 0 };
    let totalQDist = 0;

    for (let i = 0; i < fullPath.length; i++) {
        const c = nodes.get(fullPath[i]);
        if (!c) return null;
        latLngs.push({ lat: c.lat, lon: c.lon });

        if (i > 0) {
            const edgesOut = adj.get(fullPath[i - 1]) || [];
            const e = edgesOut.find(x => x.to === fullPath[i]);
            if (e) {
                usedEdges.add(e.wayId);
                distMetres += e.dist;
                qs[e.quality] = (qs[e.quality] || 0) + e.dist;
                totalQDist += e.dist;
            }
        }
    }

    for (const k of Object.keys(qs)) {
        qs[k] = totalQDist > 0 ? Math.round(qs[k] / totalQDist * 100) : 0;
    }

    return {
        path: fullPath,
        latLngs,
        totalCost: bestCost,
        distMetres: Math.round(distMetres),
        estTimeMin: estimateTime(distMetres, mode),
        qualityBreakdown: qs,
        usedEdges
    };
}

// ---------------------------------------------------------------------------
// Time estimate based on mode
// ---------------------------------------------------------------------------
function estimateTime(metres, mode) {
    const speeds = { foot: 5, '2-wheeler': 30, ev: 40, '4-wheeler': 35 };
    return Math.max(1, Math.round((metres / 1000) / (speeds[mode] || 30) * 60));
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
// Public: find up to 3 diverse routes using Penalty Inflation
// ---------------------------------------------------------------------------
function findRoutes(startId, goalId, adj, nodes, mode, preference, haversine) {
    const INFLATION = 8.0;
    const MAX_OVERLAP = 0.60;
    const penalties = new Map();
    const results = [];

    for (let attempt = 0; attempt < 8 && results.length < 3; attempt++) {
        const route = biDirSearch(startId, goalId, adj, nodes, mode, preference, penalties, haversine);
        if (!route) break;

        let tooSimilar = false;
        for (const prev of results) {
            if (overlapRatio(route.usedEdges, prev.usedEdges) > MAX_OVERLAP) {
                tooSimilar = true;
                break;
            }
        }

        if (!tooSimilar) results.push(route);

        for (const wayId of route.usedEdges) {
            penalties.set(wayId, (penalties.get(wayId) || 1.0) * INFLATION);
        }
    }

    return results;
}

module.exports = { findRoutes };
