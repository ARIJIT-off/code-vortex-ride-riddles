/**
 * app.js — RIDE_RIDDLES Application Logic (Bidirectional A* edition)
 * Handles UI interactions and connects to the Bidirectional A* backend.
 */

'use strict';

document.addEventListener('DOMContentLoaded', () => {
    // ── DOM refs ─────────────────────────────────────────────────────────────
    const findBtn = document.getElementById('find-path-btn');
    const swapBtn = document.getElementById('swap-btn');
    const srcSel = document.getElementById('source');
    const dstSel = document.getElementById('destination');
    const modeSel = document.getElementById('mode');
    const prefSel = document.getElementById('preference');
    const summaryCard = document.getElementById('summary-card');
    const loadingOv = document.getElementById('loading-overlay');
    const loadingTxt = document.getElementById('loading-text');
    const qualSection = document.getElementById('quality-section');
    const altSection = document.getElementById('alt-section');
    const altList = document.getElementById('alt-list');

    // ── Pre-select different default destinations ────────────────────────────
    dstSel.value = 'Eco Park';

    // ── Swap source / destination ────────────────────────────────────────────
    swapBtn.addEventListener('click', () => {
        const tmp = srcSel.value;
        srcSel.value = dstSel.value;
        dstSel.value = tmp;
    });

    // ── State ────────────────────────────────────────────────────────────────
    let currentRoutes = [];
    let currentMode = 'foot';
    let currentSrc = '';
    let currentDst = '';

    // ── Find Route ────────────────────────────────────────────────────────────
    findBtn.addEventListener('click', runRoute);

    async function runRoute() {
        const source = srcSel.value;
        const destination = dstSel.value;
        const mode = modeSel.value;
        const preference = prefSel.value;

        if (source === destination) {
            alert('Source and destination must be different.');
            return;
        }

        // Loading state
        findBtn.disabled = true;
        loadingTxt.textContent = 'Computing optimal route…';
        loadingOv.style.display = 'flex';
        summaryCard.style.display = 'none';
        qualSection.style.display = 'none';
        altSection.style.display = 'none';
        altList.innerHTML = '';

        if (window.MapRenderer) window.MapRenderer.clearRoutes();
        document.getElementById('pathtype-card').style.display = 'none';

        try {
            const res = await fetch('/api/path', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source, destination, mode, preference })
            });
            const data = await res.json();

            if (!data.success) {
                loadingOv.style.display = 'none';
                alert(`❌ ${data.error || 'No route found.'}`);
                return;
            }

            currentRoutes = [data.main, ...(data.alternatives || [])];
            currentMode = mode;
            currentSrc = source;
            currentDst = destination;

            renderSummary(data.main, 'Main Route');
            renderQuality(data.main.qualityBreakdown);
            renderPathType(data.main.typeBreakdown, data.main.roadSamples);
            renderAlternatives(data.alternatives || []);

            if (window.MapRenderer) {
                window.MapRenderer.showRoutes(currentRoutes, 0, mode, source, destination);
            }

        } catch (err) {
            console.error(err);
            alert('⚠️ Server error. Make sure the backend is running.');
        } finally {
            loadingOv.style.display = 'none';
            findBtn.disabled = false;
        }
    }

    // ── Render summary stats ─────────────────────────────────────────────────────
    function renderSummary(route, label) {
        const km = (route.distanceMetres / 1000).toFixed(2);
        const statusEl = document.getElementById('summary-status');
        statusEl.innerHTML = `✅ <strong>${label || 'Main Route'}</strong> — <strong>${km} km</strong> • ~${route.estTimeMin} min`;
        summaryCard.style.display = 'block';
    }

    // ── Road quality bar ──────────────────────────────────────────────────────
    function renderQuality(qb) {
        if (!qb) return;
        const smooth = qb.smooth || 0;
        const shaded = qb.shaded || 0;
        const rough = qb.problematic || 0;

        document.getElementById('qb-smooth').style.width = `${smooth}%`;
        document.getElementById('qb-shaded').style.width = `${shaded}%`;
        document.getElementById('qb-rough').style.width = `${rough}%`;

        document.getElementById('ql-smooth').textContent = smooth;
        document.getElementById('ql-shaded').textContent = shaded;
        document.getElementById('ql-rough').textContent = rough;

        qualSection.style.display = 'block';
    }

    // ── Alternative route buttons ──────────────────────────────────────────────────
    function renderAlternatives(alternatives) {
        if (!alternatives.length) return;
        altSection.style.display = 'block';

        // Main route button
        altList.appendChild(makeAltBtn('Main Route', '#2563EB', currentRoutes[0], 0));

        // Alt buttons
        const colors = ['#f59e0b', '#10b981'];
        const labels = ['Alternative 1', 'Alternative 2'];
        alternatives.forEach((alt, idx) => {
            altList.appendChild(makeAltBtn(labels[idx] || `Alt ${idx + 1}`, colors[idx] || '#888', alt, idx + 1));
        });
    }

    function makeAltBtn(label, color, route, idx) {
        const btn = document.createElement('button');
        btn.className = 'alt-btn';

        const km = (route.distanceMetres / 1000).toFixed(2);
        // colored dot + text
        btn.innerHTML = `
            <span style="width:14px;height:14px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block;"></span>
            <span class="alt-btn-text">
                <span class="alt-btn-label">${label}</span>
                <span class="alt-btn-meta">${km} km • ~${route.estTimeMin} min</span>
            </span>
        `;

        btn.onclick = () => {
            if (window.MapRenderer) {
                window.MapRenderer.showRoutes(currentRoutes, idx, currentMode, currentSrc, currentDst);
            }
            renderSummary(route, label);
            renderQuality(route.qualityBreakdown);
            renderPathType(route.typeBreakdown, route.roadSamples);
        };
        return btn;
    }

    // ── PATH TYPE card ───────────────────────────────────────────────────────
    const pathtypeCard = document.getElementById('pathtype-card');
    const pathtypeRows = document.getElementById('pathtype-rows');
    const trafficBadge = document.getElementById('traffic-badge');

    /** Position pathtype-card snugly below the search-card */
    function positionPathtypeCard() {
        const searchCard = document.getElementById('search-card');
        const rect = searchCard.getBoundingClientRect();
        // top of search card relative to .map-stage
        const mapStage = document.querySelector('.map-stage');
        const stageRect = mapStage.getBoundingClientRect();
        const topOffset = rect.bottom - stageRect.top + 10; // 10px gap
        pathtypeCard.style.top = topOffset + 'px';
    }

    /**
     * Traffic model (per user spec):
     *  - 4-lane:       always 25% crowded
     *  - 2-lane/oneway: 50% crowded 09:00–21:00, otherwise 10%
     *  - narrow alley:  always 0% crowded
     * h = current local hour (0-23)
     */
    function computeTraffic(tb, h) {
        // tb = { '4-lane': pct, '2-lane': pct, 'one way': pct, 'narrow alley': pct }
        const isPeak = h >= 9 && h < 21;     // 9 AM – 9 PM
        const isMorn = h >= 9 && h < 12;     // 9 AM – 12 PM (small roads busier)
        const isEve = h >= 16 && h < 18;    // 4 PM – 6 PM (small roads busier)

        const lane4pct = tb['4-lane'] || 0;
        const lane2pct = (tb['2-lane'] || 0) + (tb['one way'] || 0);
        const narrowpct = tb['narrow alley'] || 0;

        // Weighted congestion score (0-100)
        const lane4factor = 25;  // always
        const lane2factor = isPeak ? 50 : 10;
        const narrowfactor = 0;   // never crowded
        const smallFactor = (isMorn || isEve) ? 10 : 5;

        const weighted =
            (lane4pct / 100) * lane4factor +
            (lane2pct / 100) * lane2factor +
            (narrowpct / 100) * narrowfactor;

        // Normalise to 0-100
        const score = Math.min(100, weighted);

        if (score < 10) return { label: 'FREE', cls: 'traf-free' };
        if (score < 25) return { label: 'LOW', cls: 'traf-low' };
        if (score < 45) return { label: 'MEDIUM', cls: 'traf-medium' };
        return { label: 'HIGH', cls: 'traf-high' };
    }

    const TYPE_META = {
        '4-lane': { label: '4-Lane Road', cls: 'lane4' },
        '2-lane': { label: '2-Lane Road', cls: 'lane2' },
        'one way': { label: 'One-Way Road', cls: 'oneway' },
        'narrow alley': { label: 'Narrow Alley', cls: 'narrow' },
    };

    function renderPathType(tb, samples) {
        if (!tb) return;

        pathtypeRows.innerHTML = '';

        const order = ['4-lane', '2-lane', 'one way', 'narrow alley'];
        for (const key of order) {
            const pct = tb[key] || 0;
            const meta = TYPE_META[key];
            const roadName = (samples && samples[key]) ? samples[key] : null;

            const row = document.createElement('div');
            row.className = 'pt-row';
            row.innerHTML = `
                <div class="pt-row-top">
                    <span class="pt-dot ${meta.cls}"></span>
                    <span class="pt-name">${meta.label}</span>
                    <span class="pt-pct">${pct}%</span>
                </div>
                ${roadName ? `<div class="pt-road-name">${roadName}</div>` : ''}
                <div class="pt-bar-track">
                    <div class="pt-bar-fill ${meta.cls}" style="width:${pct}%"></div>
                </div>
            `;
            pathtypeRows.appendChild(row);
        }

        // Traffic
        const nowHour = new Date().getHours(); // real local hour
        const traffic = computeTraffic(tb, nowHour);
        trafficBadge.textContent = traffic.label;
        trafficBadge.className = 'traffic-badge ' + traffic.cls;

        // Position & show
        positionPathtypeCard();
        pathtypeCard.style.display = 'flex';
    }

    function hidePathType() {
        pathtypeCard.style.display = 'none';
    }
});

