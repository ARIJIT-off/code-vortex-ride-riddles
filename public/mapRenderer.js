/**
 * mapRenderer.js — Leaflet map renderer for RIDE_RIDDLES
 *
 * Uses raw router latLngs directly (no OSRM re-routing which caused twisted detours).
 * OSM graph paths are already road-accurate since every edge is a real OSM way segment.
 *
 * Exposes: window.MapRenderer = { init, showRoutes, clearRoutes, prefetchAllGeometry, loadLandmarks }
 */

'use strict';

(() => {
    const ROUTE_COLORS = ['#2563EB', '#16a34a', '#dc2626'];  // blue / green / red
    const ROUTE_WEIGHTS = [5, 4.5, 4.5];

    // ── State ────────────────────────────────────────────────────────────────
    let map = null;
    let routeLayers = [];
    let lmMarkers = [];
    let movingMarker = null;
    let animFrame = null;   // requestAnimationFrame id

    const CENTER = [22.578, 88.440];

    // ── SVG pin factory ──────────────────────────────────────────────────────
    function svgPin(fill, size = 28) {
        const h = Math.round(size * 1.3);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${h}" viewBox="0 0 28 36">
          <path d="M14 0C6.3 0 0 6.3 0 14c0 9.6 14 22 14 22s14-12.4 14-22C28 6.3 21.7 0 14 0z"
                fill="${fill}" stroke="#fff" stroke-width="2.5"/>
          <circle cx="14" cy="14" r="5.5" fill="#fff" opacity="0.9"/>
        </svg>`;
        return L.divIcon({
            html: svg, className: '',
            iconSize: [size, h],
            iconAnchor: [size / 2, h],
            popupAnchor: [0, -h + 4]
        });
    }

    const PIN_DEFAULT = svgPin('#64748b');
    const PIN_START = svgPin('#16a34a', 34);
    const PIN_END = svgPin('#dc2626', 34);

    // ── Vehicle emoji icon ────────────────────────────────────────────────────
    function vehicleIcon(mode) {
        const e = { foot: '🚶', ev: '🔋🚗', '4-wheeler': '🚗', '2-wheeler': '🏍️' }[mode] || '📍';
        return L.divIcon({
            html: `<div style="
                font-size: 34px;
                line-height: 1;
                filter: drop-shadow(0 3px 6px rgba(0,0,0,0.5));
                transform-origin: center;
            ">${e}</div>`,
            className: '',
            iconSize: [44, 44],
            iconAnchor: [22, 22]
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    let currentTileLayer = null;
    const baseLayers = {
        street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors', maxZoom: 19
        }),
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community', maxZoom: 19
        }),
        hybrid: L.tileLayer('http://mt0.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}', {
            attribution: '© Google Maps', maxZoom: 19
        })
    };

    function init() {
        if (map) return;
        map = L.map('map', { center: CENTER, zoom: 14, zoomControl: true });
        setBaseLayer('street');
        loadLandmarks();
    }

    function setBaseLayer(layerName) {
        if (!map) return;
        if (currentTileLayer) {
            map.removeLayer(currentTileLayer);
        }
        currentTileLayer = baseLayers[layerName] || baseLayers.street;
        currentTileLayer.addTo(map);
    }

    // ── Landmarks ────────────────────────────────────────────────────────────
    async function loadLandmarks(startName, endName) {
        try {
            const data = await fetch('/api/graph').then(r => r.json());
            drawLandmarks(data.landmarks || [], startName, endName);
        } catch (e) { console.warn('Landmark fetch failed:', e.message); }
    }

    function drawLandmarks(landmarks, startName, endName) {
        lmMarkers.forEach(m => map.removeLayer(m));
        lmMarkers = [];
        if (!landmarks.length) return;

        const avgLat = landmarks.reduce((s, l) => s + l.lat, 0) / landmarks.length;
        const avgLon = landmarks.reduce((s, l) => s + l.lon, 0) / landmarks.length;
        map.setView([avgLat, avgLon], 13);

        for (const lm of landmarks) {
            let icon = PIN_DEFAULT;
            if (lm.name === startName) icon = PIN_START;
            else if (lm.name === endName) icon = PIN_END;

            const m = L.marker([lm.lat, lm.lon], { icon })
                .bindPopup(`
                    <div style="font-weight:700;font-size:14px;margin-bottom:2px">${lm.name}</div>
                    <div style="font-size:11px;color:#888;font-family:monospace">
                        ${lm.lat.toFixed(5)}°N, ${lm.lon.toFixed(5)}°E
                    </div>`)
                .addTo(map);
            lmMarkers.push(m);
        }
    }

    // ── Clear ─────────────────────────────────────────────────────────────────
    function clearRoutes() {
        stopAnimation();
        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];
        if (movingMarker) { map.removeLayer(movingMarker); movingMarker = null; }
    }

    // No-op prefetch — kept for API compatibility (OSRM removed, no prefetch needed)
    function prefetchAllGeometry() { return Promise.resolve(); }

    // ── Draw only the selected route ──────────────────────────────────────────
    function showRoutes(routes, activeIdx, mode, sourceName, destName) {
        clearRoutes();
        if (!routes || routes.length === 0) return;

        const route = routes[activeIdx];
        if (!route || !route.latLngs || route.latLngs.length < 2) return;

        const lls = route.latLngs.map(p => [p.lat, p.lon]);
        const color = ROUTE_COLORS[activeIdx] || '#2563EB';
        const weight = ROUTE_WEIGHTS[activeIdx] || 5;
        const km = ((route.distanceMetres || 0) / 1000).toFixed(2);
        const min = route.estTimeMin || '?';

        // Thin crisp shadow
        const shadow = L.polyline(lls, {
            color: '#0008', weight: weight + 3,
            opacity: 0.18,
            lineJoin: 'round', lineCap: 'round',
            smoothFactor: 1
        }).addTo(map);

        // Main route line
        const line = L.polyline(lls, {
            color, weight,
            opacity: 0.92,
            lineJoin: 'round', lineCap: 'round',
            smoothFactor: 1
        }).addTo(map);

        // Hover tooltip
        line.bindTooltip(
            `<b>${sourceName} → ${destName}</b><br>${km} km • ~${min} min`,
            { sticky: true, className: 'leaflet-tooltip' }
        );

        // Permanent mid-point distance+time label
        if (lls.length > 3) {
            const mid = lls[Math.floor(lls.length / 2)];
            const lbl = L.divIcon({
                html: `<div style="
                    background:#fff;
                    border:1.5px solid #e2e8f0;
                    border-radius:8px;
                    padding:3px 9px;
                    font-family:'Inter',sans-serif;
                    font-size:12px;
                    font-weight:600;
                    color:#1e293b;
                    white-space:nowrap;
                    box-shadow:0 2px 8px rgba(0,0,0,0.12);
                    pointer-events:none;
                ">${km} km &bull; ${min} min</div>`,
                className: '',
                iconAnchor: [40, 14]
            });
            const lblMarker = L.marker(mid, { icon: lbl, interactive: false, zIndexOffset: 500 }).addTo(map);
            routeLayers.push(lblMarker);
        }

        routeLayers.push(shadow, line);

        // Fit map to route with padding
        map.fitBounds(L.latLngBounds(lls), { paddingTopLeft: [280, 70], paddingBottomRight: [70, 70], maxZoom: 16 });

        // Refresh landmark pins
        loadLandmarks(sourceName, destName);

        // Start smooth vehicle animation
        startAnimation(route.latLngs, mode);
    }

    // ── Smooth rAF-based animation ─────────────────────────────────────────────
    function stopAnimation() {
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    }

    function startAnimation(latLngs, mode) {
        stopAnimation();
        if (!latLngs || latLngs.length < 2) return;

        // Build densely interpolated full path
        const fullPath = [];
        for (let i = 0; i < latLngs.length - 1; i++) {
            const a = latLngs[i], b = latLngs[i + 1];
            const dLat = b.lat - a.lat, dLon = b.lon - a.lon;
            // ~1 point per 8 m on screen (dist in degrees ≈ metres/111000)
            const dist = Math.sqrt(dLat * dLat + dLon * dLon) * 111000;
            const steps = Math.max(4, Math.ceil(dist / 8));
            for (let s = 0; s < steps; s++) {
                const t = s / steps;
                fullPath.push({ lat: a.lat + dLat * t, lon: a.lon + dLon * t });
            }
        }
        fullPath.push(latLngs[latLngs.length - 1]);

        if (fullPath.length < 2) return;

        const icon = vehicleIcon(mode);
        movingMarker = L.marker([fullPath[0].lat, fullPath[0].lon], {
            icon, zIndexOffset: 1000, interactive: false
        }).addTo(map);

        // Speed: metres/second → how many path-points to advance per rAF
        const modeSpeed = { foot: 14, '2-wheeler': 90, ev: 110, '4-wheeler': 100 };
        const speedMps = modeSpeed[mode] || 8;
        // Approx metres per path step
        const stepMetres = 8;
        const stepsPerSec = speedMps / stepMetres;

        let idx = 0;
        let lastTime = null;
        let fracStep = 0; // fractional accumulator

        function tick(ts) {
            if (!movingMarker) return;
            if (lastTime === null) lastTime = ts;
            const dt = (ts - lastTime) / 1000;  // seconds
            lastTime = ts;

            fracStep += stepsPerSec * dt;
            const advance = Math.floor(fracStep);
            fracStep -= advance;

            idx = (idx + advance) % fullPath.length;
            const p = fullPath[idx];
            movingMarker.setLatLng([p.lat, p.lon]);

            animFrame = requestAnimationFrame(tick);
        }

        animFrame = requestAnimationFrame(tick);
    }

    // ── Expose API ────────────────────────────────────────────────────────────
    window.MapRenderer = { init, loadLandmarks, showRoutes, clearRoutes, prefetchAllGeometry, setBaseLayer };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
