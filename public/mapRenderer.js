/**
 * mapRenderer.js — Leaflet map renderer for RIDE_RIDDLES (Bidirectional A* edition)
 *
 * Renders a Leaflet map centred on Action Area III, New Town, Kolkata.
 * Exposes window.MapRenderer = { init, showRoutes, clearRoutes, loadLandmarks }
 */

'use strict';

(() => {
    const ROUTE_COLORS = ['#2563EB', '#111111', '#b91c1c'];
    const ROUTE_WEIGHTS = [6, 3.5, 3.5];

    // ── State ────────────────────────────────────────────────────────────────
    let map = null;
    let routeLayers = [];
    let lmMarkers = [];
    let movingMarker = null;
    let animInterval = null;

    // New Town, Kolkata centroid (Action Area III)
    const CENTER = [22.578, 88.475];

    // ── SVG pin factory ──────────────────────────────────────────────────────
    function svgPin(fill, size = 28) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 1.29)}" viewBox="0 0 28 36">
          <path d="M14 0C6.3 0 0 6.3 0 14c0 9.6 14 22 14 22s14-12.4 14-22C28 6.3 21.7 0 14 0z"
                fill="${fill}" stroke="#fff" stroke-width="2.5"/>
          <circle cx="14" cy="14" r="5.5" fill="#fff" opacity="0.92"/>
        </svg>`;
        return L.divIcon({
            html: svg, className: '',
            iconSize: [size, Math.round(size * 1.29)],
            iconAnchor: [size / 2, Math.round(size * 1.29)],
            popupAnchor: [0, -Math.round(size * 1.1)]
        });
    }

    const PIN_DEFAULT = svgPin('#64748b');
    const PIN_START = svgPin('#16a34a', 32);
    const PIN_END = svgPin('#dc2626', 32);

    // ── Moving vehicle icon ──────────────────────────────────────────────────
    function vehicleIcon(mode) {
        const emojis = { foot: '🚶', ev: '⚡🚗', '4-wheeler': '🚗', '2-wheeler': '🏍' };
        const e = emojis[mode] || '📍';
        return L.divIcon({
            html: `<div style="font-size:42px;line-height:1;filter:drop-shadow(0 2px 5px #0009);transition:transform .1s">${e}</div>`,
            className: '', iconSize: [50, 50], iconAnchor: [25, 25]
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        if (map) return;
        map = L.map('map', { center: CENTER, zoom: 14, zoomControl: true });

        // OSM tile layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        }).addTo(map);

        // Kick off landmark fetch
        loadLandmarks();
    }

    // ── Load landmark pins ───────────────────────────────────────────────────
    async function loadLandmarks(startName, endName) {
        try {
            const res = await fetch('/api/graph');
            const data = await res.json();
            drawLandmarks(data.landmarks || [], startName, endName);
        } catch (e) {
            console.warn('Landmark fetch failed:', e.message);
        }
    }

    function drawLandmarks(landmarks, startName, endName) {
        // Remove old markers
        lmMarkers.forEach(m => map.removeLayer(m));
        lmMarkers = [];

        if (!landmarks.length) return;

        // Pan to centroid
        const avgLat = landmarks.reduce((s, l) => s + l.lat, 0) / landmarks.length;
        const avgLon = landmarks.reduce((s, l) => s + l.lon, 0) / landmarks.length;
        map.setView([avgLat, avgLon], 14);

        for (const lm of landmarks) {
            let icon = PIN_DEFAULT;
            if (lm.name === startName) icon = PIN_START;
            else if (lm.name === endName) icon = PIN_END;

            const m = L.marker([lm.lat, lm.lon], { icon })
                .bindPopup(`
                    <div class="popup-name">${lm.name}</div>
                    <div class="popup-coords">${lm.lat.toFixed(4)}°N, ${lm.lon.toFixed(4)}°E</div>
                `)
                .addTo(map);
            lmMarkers.push(m);
        }
    }

    // ── Clear routes + stop animation ────────────────────────────────────────
    function clearRoutes() {
        stopAnimation();
        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];
        if (movingMarker) { map.removeLayer(movingMarker); movingMarker = null; }
    }

    // ── Draw routes ──────────────────────────────────────────────────────────
    function showRoutes(routes, activeIdx, mode, sourceName, destName) {
        clearRoutes();
        if (!routes || routes.length === 0) return;

        routes.forEach((route, idx) => {
            const lls = route.latLngs.map(p => [p.lat, p.lon]);
            const isActive = idx === activeIdx;
            const color = ROUTE_COLORS[idx] || '#888';
            const weight = ROUTE_WEIGHTS[idx] || 3;
            const opacity = isActive ? 0.92 : 0.42;

            // Glow/shadow underlay
            const shadow = L.polyline(lls, {
                color: '#000', weight: isActive ? 10 : 6,
                opacity: 0.12, lineJoin: 'round', lineCap: 'round'
            }).addTo(map);

            // Colored route line
            const line = L.polyline(lls, {
                color, weight, opacity,
                lineJoin: 'round', lineCap: 'round',
                dashArray: isActive ? null : '10 7'
            }).addTo(map);

            // Hover tooltip on active route
            if (isActive) {
                line.bindTooltip(
                    `Main Route — ${(route.distanceMetres / 1000).toFixed(2)} km · ~${route.estTimeMin} min`,
                    { sticky: true, className: 'leaflet-tooltip' }
                );
            }

            routeLayers.push(shadow, line);
        });

        // Fit map to active route
        const active = routes[activeIdx];
        const activeLls = active.latLngs.map(p => [p.lat, p.lon]);
        if (activeLls.length > 1) map.fitBounds(activeLls, { padding: [80, 80] });

        // Refresh landmark pins with start/end highlight
        loadLandmarks(sourceName, destName);

        // Animate moving marker on active route
        startAnimation(active.latLngs, mode);
    }

    // ── Animated vehicle marker ───────────────────────────────────────────────
    function stopAnimation() {
        if (animInterval) { clearInterval(animInterval); animInterval = null; }
    }

    function startAnimation(latLngs, mode) {
        stopAnimation();
        if (!latLngs || latLngs.length < 2) return;

        const pts = latLngs.map(p => L.latLng(p.lat, p.lon));

        // Build densely interpolated path
        const fullPath = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const steps = Math.max(10, Math.round(
                map.distance(a, b) / 12   // ~1 frame per 12 m
            ));
            for (let s = 0; s < steps; s++) {
                const t = s / steps;
                fullPath.push(L.latLng(
                    a.lat + (b.lat - a.lat) * t,
                    a.lng + (b.lng - a.lng) * t
                ));
            }
        }
        fullPath.push(pts[pts.length - 1]);

        const icon = vehicleIcon(mode);
        movingMarker = L.marker(fullPath[0], { icon, zIndexOffset: 1000 }).addTo(map);

        let step = 0;
        animInterval = setInterval(() => {
            step = (step + 1) % fullPath.length;
            movingMarker.setLatLng(fullPath[step]);
        }, 60);
    }

    // ── Expose API ────────────────────────────────────────────────────────────
    window.MapRenderer = { init, loadLandmarks, showRoutes, clearRoutes };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
