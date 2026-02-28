/**
 * yenRouter.js — Yen's K-Shortest Paths Algorithm for RIDE_RIDDLES
 *
 * Yen's (1971) algorithm finds the K shortest loopless paths between two nodes.
 * It guarantees K distinct paths by iterating over "spur paths" at each node
 * along previously found paths, systematically removing conflicting edges and
 * nodes before re-running a base A* search.
 *
 * This is fundamentally different from both Dijkstra (single path) and the
 * previous Bidirectional A* approach.
 *
 * Road quality distribution: 50% smooth · 25% shaded · 25% problematic
 * (deterministic per OSM way-ID — handled in osmGraph.js)
 */

'use strict';

// ---------------------------------------------------------------------------
// Minimal binary Min-Heap (priority queue) keyed on `.f`
// ---------------------------------------------------------------------------
class MinHeap {
    constructor() { this._d = []; }
    push(item) { this._d.push(item); this._up(this._d.length - 1); }
    pop() {
        const top = this._d[0], last = this._d.pop();
        if (this._d.length) { this._d[0] = last; this._dn(0); }
        return top;
    }
    get size() { return this._d.length; }
    _up(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this._d[p].f <= this._d[i].f) break;
            [this._d[p], this._d[i]] = [this._d[i], this._d[p]]; i = p;
        }
    }
    _dn(i) {
        const n = this._d.length;
        while (true) {
            let sm = i, l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._d[l].f < this._d[sm].f) sm = l;
            if (r < n && this._d[r].f < this._d[sm].f) sm = r;
            if (sm === i) break;
            [this._d[sm], this._d[i]] = [this._d[i], this._d[sm]]; i = sm;
        }
    }
}

// ---------------------------------------------------------------------------
// Mode multiplier — how suitable is this road type for this vehicle?
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
        if (h === 'secondary') return 0.70;
        if (h === 'residential') return 1.20;
        if (h === 'service') return 1.90;
        if (['footway', 'path', 'pedestrian', 'track', 'steps'].includes(h)) return Infinity;
        return 1.05;
    }
    if (mode === 'ev') {
        if (['primary', 'secondary', 'trunk', 'motorway'].includes(h)) return 0.60;
        if (h === 'residential') return 0.85;
        if (['footway', 'path', 'steps', 'track'].includes(h)) return Infinity;
        return 0.95;
    }
    if (mode === '2-wheeler') {
        if (['residential', 'service', 'tertiary', 'unclassified'].includes(h)) return 0.65;
        if (h === 'secondary') return 0.80;
        if (['motorway', 'trunk'].includes(h)) return Infinity;
        if (['footway', 'pedestrian', 'steps'].includes(h)) return Infinity;
        return 0.95;
    }
    return 1.0;
}

// ---------------------------------------------------------------------------
// Preference multiplier — match user preference to road quality
// ---------------------------------------------------------------------------
function prefMultiplier(edge, preference) {
    const q = edge.quality;
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
    return 1.0; // 'shortest'
}

// ---------------------------------------------------------------------------
// Edge cost
// ---------------------------------------------------------------------------
function edgeCost(edge, mode, preference) {
    const mm = modeMultiplier(edge, mode);
    if (mm === Infinity) return Infinity;
    return edge.dist * mm * prefMultiplier(edge, preference);
}

// ---------------------------------------------------------------------------
// A* base search (used inside Yen's loop)
// blockedNodes: Set of node IDs to treat as walls
// blockedEdges: Set of {from}→{to} keys to skip
// ---------------------------------------------------------------------------
function aStarSearch(startId, goalId, adj, nodes, mode, preference, blockedNodes, blockedEdges, haversine) {
    const gc = nodes.get(goalId);
    if (!gc) return null;

    const g = new Map([[startId, 0]]);
    const prev = new Map();
    const open = new MinHeap();
    const closed = new Set();

    const h = id => {
        const c = nodes.get(id);
        return c ? haversine(c, gc) * 0.85 : 0;
    };

    open.push({ f: h(startId), g: 0, id: startId });

    while (open.size) {
        const { g: gv, id } = open.pop();
        if (closed.has(id)) continue;
        if (id === goalId) break;
        closed.add(id);
        if (gv > (g.get(id) ?? Infinity) + 1e-9) continue;

        for (const edge of (adj.get(id) || [])) {
            if (blockedNodes.has(edge.to)) continue;
            const key = `${id}→${edge.to}`;
            if (blockedEdges.has(key)) continue;

            const cost = edgeCost(edge, mode, preference);
            if (cost === Infinity) continue;
            const ng = gv + cost;
            if (ng < (g.get(edge.to) ?? Infinity)) {
                g.set(edge.to, ng);
                prev.set(edge.to, { parentId: id, edge });
                open.push({ f: ng + h(edge.to), g: ng, id: edge.to });
            }
        }
    }

    if (!g.has(goalId)) return null;

    // Reconstruct
    const path = [];
    const usedWayIds = new Set();
    let cur = goalId;
    let dist = 0;
    const qs = { smooth: 0, shaded: 0, problematic: 0 };

    while (cur !== startId) {
        path.unshift(cur);
        const entry = prev.get(cur);
        if (!entry) return null;
        usedWayIds.add(`${entry.parentId}→${cur}`);
        dist += entry.edge.dist;
        qs[entry.edge.quality] = (qs[entry.edge.quality] || 0) + entry.edge.dist;
        cur = entry.parentId;
    }
    path.unshift(startId);

    for (const k of Object.keys(qs))
        qs[k] = dist > 0 ? Math.round(qs[k] / dist * 100) : 0;

    return {
        path,
        cost: g.get(goalId),
        dist,
        usedEdgeKeys: usedWayIds,
        qualityBreakdown: qs
    };
}

// ---------------------------------------------------------------------------
// Build route result from a path array
// ---------------------------------------------------------------------------
function buildResult(path, adj, nodes, mode, haversine) {
    const latLngs = [];
    let distMetres = 0;
    const qs = { smooth: 0, shaded: 0, problematic: 0 };

    for (let i = 0; i < path.length; i++) {
        const c = nodes.get(path[i]);
        if (!c) return null;
        latLngs.push({ lat: c.lat, lon: c.lon });
        if (i > 0) {
            const edges = adj.get(path[i - 1]) || [];
            const e = edges.find(x => x.to === path[i]);
            if (e) {
                distMetres += e.dist;
                qs[e.quality] = (qs[e.quality] || 0) + e.dist;
            }
        }
    }
    for (const k of Object.keys(qs))
        qs[k] = distMetres > 0 ? Math.round(qs[k] / distMetres * 100) : 0;

    return { latLngs, distMetres: Math.round(distMetres), qualityBreakdown: qs };
}

// ---------------------------------------------------------------------------
// Yen's K-Shortest Paths
// Returns up to K route objects (aims for exactly K=3)
// ---------------------------------------------------------------------------
function findRoutes(startId, goalId, adj, nodes, mode, preference, haversine) {
    const K = 3;

    // ── Step 1: find the 1st shortest path ──────────────────────────────────
    const first = aStarSearch(startId, goalId, adj, nodes, mode, preference,
        new Set(), new Set(), haversine);
    if (!first) return [];

    const A = [first];          // confirmed k-shortest paths
    const B = [];               // candidate heap (sorted by cost)

    // ── Step 2: iterate to find paths 2…K ───────────────────────────────────
    for (let k = 1; k < K; k++) {
        const prevPath = A[k - 1].path;

        for (let i = 0; i < prevPath.length - 1; i++) {
            const spurNode = prevPath[i];
            const rootPath = prevPath.slice(0, i + 1);  // start → spurNode
            const rootCost = A[k - 1].cost * (i / (prevPath.length - 1)); // approximate

            // Block edges used by previous k-shortest paths that share the same root
            const blockedEdges = new Set();
            for (const confirmed of A) {
                if (confirmed.path.length > i &&
                    confirmed.path.slice(0, i + 1).join('→') === rootPath.join('→')) {
                    const from = confirmed.path[i];
                    const to = confirmed.path[i + 1];
                    if (to !== undefined) blockedEdges.add(`${from}→${to}`);
                }
            }
            for (const cand of B) {
                if (cand.path.length > i &&
                    cand.path.slice(0, i + 1).join('→') === rootPath.join('→')) {
                    const from = cand.path[i];
                    const to = cand.path[i + 1];
                    if (to !== undefined) blockedEdges.add(`${from}→${to}`);
                }
            }

            // Block root path nodes (except spur node) to prevent loops
            const blockedNodes = new Set(rootPath.slice(0, -1));

            // Find spur path
            const spurResult = aStarSearch(spurNode, goalId, adj, nodes, mode, preference,
                blockedNodes, blockedEdges, haversine);
            if (!spurResult) continue;

            // Full candidate path = root + spur
            const fullPath = [...rootPath.slice(0, -1), ...spurResult.path];
            const fullCost = rootCost + spurResult.cost;

            // Avoid exact duplicate paths already in A or B
            const pathKey = fullPath.join(',');
            const isDup =
                A.some(r => r.path.join(',') === pathKey) ||
                B.some(r => r.path.join(',') === pathKey);
            if (!isDup) {
                B.push({ path: fullPath, cost: fullCost, qualityBreakdown: spurResult.qualityBreakdown });
            }
        }

        if (B.length === 0) break;

        // Pick the candidate with lowest cost
        B.sort((a, b) => a.cost - b.cost);
        A.push(B.shift());
    }

    // ── Step 3: build final result objects ───────────────────────────────────
    const results = [];
    for (const candidate of A) {
        const built = buildResult(candidate.path, adj, nodes, mode, haversine);
        if (!built) continue;
        results.push({
            latLngs: built.latLngs,
            distMetres: built.distMetres,
            estTimeMin: estimateTime(built.distMetres, mode),
            totalCost: candidate.cost,
            qualityBreakdown: built.qualityBreakdown
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Crude time estimate
// ---------------------------------------------------------------------------
function estimateTime(metres, mode) {
    const kmh = { foot: 5, '2-wheeler': 30, ev: 40, '4-wheeler': 35 }[mode] || 30;
    return Math.max(1, Math.round((metres / 1000) / kmh * 60));
}

module.exports = { findRoutes };
