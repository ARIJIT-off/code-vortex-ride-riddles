const { nodes, edges, calculateDynamicWeight } = require('./graphData');

// Dijkstra algorithm to find the shortest path based on dynamic weights
function findPathExcluding(sourceId, targetId, mode, preference, blockedEdgeIds = []) {
    const weightedEdges = edges.map(e => ({
        ...e,
        weight: blockedEdgeIds.includes(e.id) ? Infinity : calculateDynamicWeight(e, mode, preference)
    }));

    const distances = {};
    const predecessors = {};
    const unvisited = new Set();
    const edgeToPredecessor = {};

    nodes.forEach(n => {
        distances[n.id] = Infinity;
        predecessors[n.id] = null;
        edgeToPredecessor[n.id] = null;
        unvisited.add(n.id);
    });

    distances[sourceId] = 0;

    while (unvisited.size > 0) {
        let current = null;
        let minDistance = Infinity;
        for (const nodeId of unvisited) {
            if (distances[nodeId] < minDistance) {
                minDistance = distances[nodeId];
                current = nodeId;
            }
        }

        if (current === null || current === targetId) {
            break;
        }

        unvisited.delete(current);

        const neighbors = weightedEdges.filter(e => e.source === current);

        for (const edge of neighbors) {
            const neighborId = edge.target;
            if (!unvisited.has(neighborId)) continue;
            if (edge.weight === Infinity) continue; // skip explicitly blocked

            const newDistance = distances[current] + edge.weight;
            if (newDistance < distances[neighborId]) {
                distances[neighborId] = newDistance;
                predecessors[neighborId] = current;
                edgeToPredecessor[neighborId] = edge;
            }
        }
    }

    const path = [];
    const detailedPath = [];
    let currNode = targetId;

    if (distances[targetId] === Infinity) {
        return null;
    }

    while (currNode !== null) {
        path.unshift(currNode);
        const edgeTaken = edgeToPredecessor[currNode];
        if (edgeTaken) {
            detailedPath.unshift(edgeTaken);
        }
        currNode = predecessors[currNode];
    }

    return {
        path,
        detailedPath,
        totalCost: distances[targetId]
    };
}

function findShortestPath(sourceId, targetId, mode, preference) {
    // 1. Get Main Route
    const main = findPathExcluding(sourceId, targetId, mode, preference, []);

    if (!main) return null;

    const alternatives = [];

    // 2. Get Alternative 1 (Block first edge of main path)
    let alt1 = null;
    let blockedForAlt1 = [];
    if (main.detailedPath.length > 0) {
        blockedForAlt1.push(main.detailedPath[0].id);
        alt1 = findPathExcluding(sourceId, targetId, mode, preference, blockedForAlt1);
    }

    // 3. Get Alternative 2 (Block first edge of alt1, or second edge of main)
    let alt2 = null;
    if (alt1 && alt1.detailedPath.length > 0) {
        let blockedForAlt2 = [...blockedForAlt1, alt1.detailedPath[0].id];
        alt2 = findPathExcluding(sourceId, targetId, mode, preference, blockedForAlt2);
    }

    if (alt1) alternatives.push(alt1);
    // Ignore alt2 if it is an exact duplicate (sometimes routing falls back to identical path if block didn't change downstream)
    if (alt2 && (!alt1 || alt2.detailedPath.map(e => e.id).join(',') !== alt1.detailedPath.map(e => e.id).join(','))) {
        alternatives.push(alt2);
    }

    return {
        path: main.path,
        detailedPath: main.detailedPath,
        totalCost: main.totalCost,
        alternatives
    };
}

module.exports = {
    findShortestPath
};
