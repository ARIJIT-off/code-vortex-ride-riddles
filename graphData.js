// Real-world Graph nodes based on Action Area 3 (Kolkata)
// Center: 88.4527 E, 22.5816 N. Zoom: 13. Image: 650x450
const nodes = [
    // --- MAIN LANDMARKS (X/Y Coordinates precisely mapped to your screenshot snippet) ---
    { id: 'IEM Newtown', x: 0.355, y: 0.145, isLandmark: true },
    { id: 'Downtown Mall', x: 0.560, y: 0.280, isLandmark: true },
    { id: 'St Xaviers', x: 0.250, y: 0.120, isLandmark: true },
    { id: 'IIT Kharagpur', x: 0.585, y: 0.455, isLandmark: true },
    { id: 'Judicial Academy', x: 0.480, y: 0.475, isLandmark: true },
    { id: 'Wetland', x: 0.930, y: 0.485, isLandmark: true },
    { id: 'Kulberia Mandir', x: 0.530, y: 0.860, isLandmark: true },
    { id: 'Shani Mandir', x: 0.090, y: 0.540, isLandmark: true },

    // --- 8 NEW DISTANT LANDMARK NODES ---
    { id: 'Eco Park Gate', x: 0.820, y: 0.065, isLandmark: true },
    { id: 'Biswa Bangla Gate', x: 0.780, y: 0.185, isLandmark: true },
    { id: 'Canal Bank Rd', x: 0.870, y: 0.300, isLandmark: true },
    { id: 'Rosedale Plaza', x: 0.400, y: 0.040, isLandmark: true },
    { id: 'Jagannath Temple', x: 0.430, y: 0.370, isLandmark: true },
    { id: 'Dharmatala Mandir', x: 0.290, y: 0.700, isLandmark: true },
    { id: 'Panchuria Rd', x: 0.160, y: 0.770, isLandmark: true },
    { id: 'Heria Kalyan Rd', x: 0.430, y: 0.640, isLandmark: true },

    // --- FAKE NODES (Invisible routing junctions to bend paths along real-world streets) ---
    { id: 'Junction A', x: 0.400, y: 0.320, isLandmark: false },
    { id: 'Junction B', x: 0.650, y: 0.600, isLandmark: false },
    { id: 'Junction C', x: 0.200, y: 0.500, isLandmark: false },
    { id: 'Junction D', x: 0.750, y: 0.300, isLandmark: false },
    { id: 'Junction E', x: 0.600, y: 0.130, isLandmark: false },
    { id: 'Junction F', x: 0.840, y: 0.400, isLandmark: false },
    { id: 'Junction G', x: 0.320, y: 0.620, isLandmark: false },
    { id: 'Junction H', x: 0.500, y: 0.750, isLandmark: false }
];

// Generate deterministic edges for every node pair × every mode
function generateEdges() {
    const edges = [];
    const modes = ['foot', 'ev', '4-wheeler', '2-wheeler'];
    const nodeIds = nodes.map(n => n.id);

    // 4 edges per ordered pair (one per mode).
    // With 20 nodes: 20*19 = 380 pairs → 380*4 = 1520 edges total.
    let edgeId = 1;
    for (let i = 0; i < nodeIds.length; i++) {
        for (let j = 0; j < nodeIds.length; j++) {
            if (i === j) continue;

            modes.forEach((mode, mIdx) => {
                const typeIndex = (mIdx + i + j) % 4;

                let type = '2-lane';
                if (typeIndex === 0) type = '4-lane';
                else if (typeIndex === 1) type = '2-lane';
                else if (typeIndex === 2) type = 'one way';
                else if (typeIndex === 3) type = 'narrow alley';

                // Distance base
                const baseDistance = 10 + ((i * 7 + j * 13 + mIdx * 17) % 91);

                // Seed geometry distinctly for every permutation
                const seed = i * 1000 + j * 100 + mIdx * 7;
                const waypoints = generateCityBlockWaypoints(nodes[i], nodes[j], seed);

                edges.push({
                    id: `e${edgeId++}`,
                    source: nodeIds[i],
                    target: nodeIds[j],
                    distance: baseDistance,
                    type: type,
                    feature: 'none',
                    waypoints: waypoints,
                    intendedMode: mode,      // Used to guarantee unique route
                    intendedPref: 'shortest' // Baseline pref so we don't multiply by 3
                });
            });
        }
    }
    return edges;
}

// Generate organic but rectilinear waypoints between two nodes
function generateCityBlockWaypoints(nodeA, nodeB, seed) {
    const points = [];
    let cx = nodeA.x;
    let cy = nodeA.y;
    const tx = nodeB.x;
    const ty = nodeB.y;

    // Divide path into 2-4 segments based on distance
    const dx = tx - cx;
    const dy = ty - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Tighter segments since nodes are closer together on a real map
    const segments = Math.max(2, Math.floor(dist * 20) + (seed % 3));

    for (let s = 0; s < segments - 1; s++) {
        const remainingSegments = segments - 1 - s;

        let stepX = (tx - cx) / remainingSegments;
        let stepY = (ty - cy) / remainingSegments;

        // Much tighter orthogonal randomness so paths look like adjacent streets, not wild spaghetti
        const orthoDrift = ((seed * (s + 1) * 31) % 100 - 50) / 100 * 0.02; // -0.01 to +0.01

        if ((seed + s) % 2 === 0) {
            cx += stepX;
            cy += stepY + orthoDrift;
        } else {
            cx += stepX + orthoDrift;
            cy += stepY;
        }

        points.push({ x: cx, y: cy });
    }
    return points;
}

const edges = generateEdges();

// Dynamic weighting logic
// User parameters: mode (foot, ev, 4-wheeler, 2-wheeler), preference (smooth, shaded, shortest)
function calculateDynamicWeight(edge, mode, preference) {
    // 1. Strict Logical Constraints mapped from UI configuration
    if (mode === '4-wheeler' && (edge.type === 'narrow alley' || edge.type === 'one way')) {
        return Infinity; // Hard blocked for 4-wheelers on these road types
    }

    // 2. Base weight
    let weight = edge.distance;

    // 3. Affinity matching: 
    // We generated 4 edges between each node (one for each main mode).
    // Penalize heavily if the vehicle takes a road not designed for it
    if (edge.intendedMode === mode) {
        weight *= 0.5;
    } else {
        weight *= 5.0;
    }

    // Apply feature/preference multipliers 
    if (preference === 'smooth' && edge.type !== '4-lane' && edge.type !== '2-lane') weight *= 2;
    if (preference === 'shaded' && edge.type !== 'narrow alley') weight *= 1.5;

    return Math.max(0.0001, weight);
}

module.exports = {
    nodes,
    edges,
    calculateDynamicWeight
};
