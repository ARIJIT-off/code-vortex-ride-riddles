'use strict';

const express = require('express');
const cors = require('cors');
const { loadOSMGraph, findNearestAccessibleNode } = require('./osmGraph');
const { findRoutes } = require('./amcrRouter');
const { enrichRoute } = require('./routeLookup');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let GRAPH = null;

(async () => {
    GRAPH = await loadOSMGraph();
    console.log(`🚀 RIDE_RIDDLES ready → http://localhost:${PORT}`);
    console.log(`   Graph: ${GRAPH.nodes.size} OSM nodes | ${GRAPH.landmarks.length} landmarks`);
})();

// Helper: landmark name → graph node ID, mode-aware
// Snaps to nearest OSM node that the given transport mode can actually leave from.
function resolveNodeForMode(name, mode) {
    if (!GRAPH) return null;
    const lm = GRAPH.landmarks.find(l => l.name === name);
    if (!lm) return null;
    // Mode-aware snap: finds nearest node with at least one traversable edge
    return findNearestAccessibleNode(lm.lat, lm.lon, GRAPH.adj, GRAPH.nodes, mode);
}


// ── GET /api/graph — landmark pins for the Leaflet map ────────────────────
app.get('/api/graph', (req, res) => {
    if (!GRAPH) return res.status(503).json({ error: 'Graph not ready yet, retry in a moment.' });
    res.json({
        landmarks: GRAPH.landmarks.map(lm => ({
            name: lm.name,
            lat: lm.lat,
            lon: lm.lon
        }))
    });
});

// ── POST /api/path — Bidirectional A*, return top-3 diverse routes ─────────
app.post('/api/path', (req, res) => {
    if (!GRAPH) return res.status(503).json({ success: false, error: 'Graph still loading, please retry.' });

    const { source, destination, mode, preference } = req.body;
    if (!source || !destination || !mode || !preference)
        return res.status(400).json({ success: false, error: 'Missing parameters' });
    if (source === destination)
        return res.status(400).json({ success: false, error: 'Source and destination must differ' });

    const startId = resolveNodeForMode(source, mode);
    const goalId = resolveNodeForMode(destination, mode);
    if (!startId || !goalId)
        return res.status(404).json({ success: false, error: `Landmark not found: ${!startId ? source : destination}` });

    const routes = findRoutes(startId, goalId, GRAPH.adj, GRAPH.nodes, mode, preference, GRAPH.haversine);

    if (!routes || routes.length === 0)
        return res.json({ success: false, error: 'No valid path found for this combination.' });

    const [main, ...alternatives] = routes;

    const fmt = r => ({
        latLngs: r.latLngs,
        distanceMetres: r.distanceMetres,
        estTimeMin: r.estTimeMin,
        totalCost: parseFloat(r.totalCost.toFixed(2)),
        qualityBreakdown: r.qualityBreakdown,
        typeBreakdown: r.typeBreakdown,
        roadSamples: r.roadSamples,
        trafficLevel: r.trafficLevel || null,
        shadeOverall: r.shadeOverall ?? null,
        smoothRoad: r.smoothRoad ?? null,
        fastestRoute: r.fastestRoute ?? null
    });

    // Enrich main + alternatives with dataset values (falls back if pair not found)
    const enrich = r => enrichRoute(r, source, destination);
    res.json({ success: true, main: fmt(enrich(main)), alternatives: alternatives.map(r => fmt(enrich(r))) });
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
