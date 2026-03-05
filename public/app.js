/**
 * app.js — RIDE_RIDDLES · Single Drawer Layout
 */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
    const findBtn = document.getElementById('find-path-btn');
    const swapBtn = document.getElementById('swap-btn');
    const srcSel = document.getElementById('source');
    const dstSel = document.getElementById('destination');
    const modeSel = document.getElementById('mode');
    const prefSel = document.getElementById('preference');
    const loadingOv = document.getElementById('loading-overlay');
    const loadingTxt = document.getElementById('loading-text');
    const qualSection = document.getElementById('quality-section');
    const altSection = document.getElementById('alt-section');
    const altList = document.getElementById('alt-list');
    const pathtypeRows = document.getElementById('pathtype-rows');
    const trafficBadge = document.getElementById('traffic-badge');

    swapBtn.addEventListener('click', () => {
        const tmp = srcSel.value;
        srcSel.value = dstSel.value;
        dstSel.value = tmp;
    });

    let currentRoutes = [];
    let currentMode = 'foot';
    let currentSrc = '';
    let currentDst = '';

    findBtn.addEventListener('click', runRoute);

    async function runRoute() {
        const source = srcSel.value;
        const destination = dstSel.value;
        const mode = modeSel.value;
        const preference = prefSel.value;

        if (source === destination) { alert('Source and destination must be different.'); return; }

        findBtn.disabled = true;
        loadingTxt.textContent = 'Computing optimal route…';
        loadingOv.style.display = 'flex';
        qualSection.style.display = 'none';
        altSection.style.display = 'none';
        altList.innerHTML = '';

        if (window.MapRenderer) window.MapRenderer.clearRoutes();

        try {
            const res = await fetch('/api/path', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source, destination, mode, preference })
            });
            const data = await res.json();

            if (!data.success) { loadingOv.style.display = 'none'; alert(`\u274c ${data.error || 'No route found.'}`); return; }

            currentRoutes = [data.main, ...(data.alternatives || [])];
            currentMode = mode;
            currentSrc = source;
            currentDst = destination;

            if (window.MapRenderer?.prefetchAllGeometry) {
                window.MapRenderer.prefetchAllGeometry(currentRoutes, mode);
            }

            renderSummary(data.main, 'Main Route');
            renderQuality(data.main.qualityBreakdown);
            renderPathType(data.main.typeBreakdown, data.main.roadSamples, data.main.trafficLevel);
            renderAlternatives(data.alternatives || []);

            if (window.MapRenderer) {
                window.MapRenderer.showRoutes(currentRoutes, 0, mode, source, destination);
            }

            // Unlock drawer tabs
            if (window.unlockDrawerTabs) window.unlockDrawerTabs();

        } catch (err) {
            console.error(err);
            alert('\u26a0\ufe0f Server error. Make sure the backend is running.');
        } finally {
            loadingOv.style.display = 'none';
            findBtn.disabled = false;
        }
    }

    function renderSummary(route, label) {
        const km = ((route.distanceMetres || 0) / 1000).toFixed(2);
        const min = route.estTimeMin || '?';
        const routeLabel = label || 'Main Route';
        const srcDst = currentSrc && currentDst
            ? `<span style="color:#94a3b8;font-size:0.85em">${currentSrc} → ${currentDst}</span><br>` : '';
        document.getElementById('summary-status').innerHTML =
            `${srcDst}✅ <strong>${routeLabel}</strong> — <strong>${km} km</strong> • ~${min} min`;
    }

    function renderQuality(qb) {
        if (!qb) return;
        const s = qb.smooth || 0, sh = qb.shaded || 0, r = qb.problematic || 0;
        document.getElementById('qb-smooth').style.width = s + '%';
        document.getElementById('qb-shaded').style.width = sh + '%';
        document.getElementById('qb-rough').style.width = r + '%';
        document.getElementById('ql-smooth').textContent = s;
        document.getElementById('ql-shaded').textContent = sh;
        document.getElementById('ql-rough').textContent = r;
        qualSection.style.display = 'block';
    }

    let altButtons = [];

    function renderAlternatives(alts) {
        altButtons = [];
        if (!alts.length) return;
        altSection.style.display = 'block';

        altList.appendChild(makeAltBtn('Main Route', '#2563EB', currentRoutes[0], 0));
        const colors = ['#16a34a', '#b91c1c'];
        const labels = ['Alternative 1', 'Alternative 2'];
        alts.forEach((a, i) => altList.appendChild(makeAltBtn(labels[i] || `Alt ${i + 1}`, colors[i] || '#888', a, i + 1)));
        setActiveAltBtn(0);
    }

    function setActiveAltBtn(idx) {
        altButtons.forEach((b, i) => {
            b.style.borderColor = i === idx ? 'var(--primary)' : '';
            b.style.background = i === idx ? 'rgba(37,99,235,0.12)' : '';
        });
    }

    function makeAltBtn(label, color, route, idx) {
        const btn = document.createElement('button');
        btn.className = 'alt-btn';
        altButtons.push(btn);
        const km = ((route.distanceMetres || 0) / 1000).toFixed(2);
        const min = route.estTimeMin || '?';

        let diff = '';
        if (idx > 0 && currentRoutes[0]) {
            const dM = (route.distanceMetres || 0) - (currentRoutes[0].distanceMetres || 0);
            const dT = (route.estTimeMin || 0) - (currentRoutes[0].estTimeMin || 0);
            const p = [];
            if (Math.abs(dT) >= 1) p.push(`<span class="alt-btn-diff" style="color:${dT > 0 ? '#ef4444' : '#22c55e'}">${dT > 0 ? '+' : ''}${dT} min</span>`);
            if (Math.abs(dM) >= 50) p.push(`<span class="alt-btn-diff" style="color:${dM > 0 ? '#ef4444' : '#22c55e'}">${dM > 0 ? '+' : ''}${(dM / 1000).toFixed(1)} km</span>`);
            diff = p.length ? ' ' + p.join(' ') : '';
        }

        btn.innerHTML = `
            <span style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block;"></span>
            <span class="alt-btn-text">
                <span class="alt-btn-label">${label}</span>
                <span class="alt-btn-meta">${km} km &bull; ~${min} min${diff}</span>
            </span>`;

        btn.onclick = () => {
            setActiveAltBtn(idx);
            if (window.MapRenderer) window.MapRenderer.showRoutes(currentRoutes, idx, currentMode, currentSrc, currentDst);
            renderSummary(route, label);
            renderQuality(route.qualityBreakdown);
            renderPathType(route.typeBreakdown, route.roadSamples, route.trafficLevel);
        };
        return btn;
    }

    // ── Path Type ────────────────────────────────────────────────────────
    const TYPE_META = {
        '6-lane': { label: '6-Lane Road', cls: 'lane6' },
        '4-lane': { label: '4-Lane Road', cls: 'lane4' },
        '2-lane': { label: '2-Lane Road', cls: 'lane2' },
        'one way': { label: 'One-Way Road', cls: 'oneway' },
        'narrow alley': { label: 'Narrow Alley', cls: 'narrow' },
    };

    function computeTraffic(tb, h) {
        const pk = h >= 9 && h < 21;
        const w = ((tb['6-lane'] || 0) / 100) * 30 + ((tb['4-lane'] || 0) / 100) * 25 +
            (((tb['2-lane'] || 0) + (tb['one way'] || 0)) / 100) * (pk ? 50 : 10);
        const s = Math.min(100, w);
        if (s < 10) return { label: 'FREE', cls: 'traf-free' };
        if (s < 25) return { label: 'LOW', cls: 'traf-low' };
        if (s < 45) return { label: 'MEDIUM', cls: 'traf-medium' };
        return { label: 'HIGH', cls: 'traf-high' };
    }

    function renderPathType(tb, samples, serverTrafficLevel) {
        if (!tb) return;
        const order = ['6-lane', '4-lane', '2-lane', 'one way', 'narrow alley'];
        pathtypeRows.innerHTML = order.map(key => {
            const pct = tb[key] || 0, m = TYPE_META[key];
            const rn = (samples && samples[key]) ? samples[key] : null;
            return `<div class="pt-row">
                <div class="pt-row-top">
                    <span class="pt-dot ${m.cls}"></span>
                    <span class="pt-name">${m.label}</span>
                    <span class="pt-pct">${pct}%</span>
                </div>
                ${rn ? `<div class="pt-road-name">${rn}</div>` : ''}
                <div class="pt-bar-track"><div class="pt-bar-fill ${m.cls}" style="width:${pct}%"></div></div>
            </div>`;
        }).join('');

        let traffic;
        if (serverTrafficLevel) {
            const MAP = { 'Low': { label: 'LOW', cls: 'traf-low' }, 'Medium': { label: 'MEDIUM', cls: 'traf-medium' }, 'High': { label: 'HIGH', cls: 'traf-high' } };
            traffic = MAP[serverTrafficLevel] || computeTraffic(tb, new Date().getHours());
        } else { traffic = computeTraffic(tb, new Date().getHours()); }
        trafficBadge.textContent = traffic.label;
        trafficBadge.className = 'traffic-badge ' + traffic.cls;
    }
});
