/**
 * Shipment Tracker — add-in de MAPA (tooltip + panel lateral) · v2
 *
 * API de add-ins de mapa (developers.geotab.com/myGeotab/addIns/mapAddIns):
 *   geotab.addin.<nombre> = function (elt, service) { ... }
 *   service.api.call(method, params)              → Promise
 *   service.events.attach('over'|'change', fn)    data.type === 'device', data.entity.id,
 *                                                 'change' trae data.location { lat, lng }
 *   service.tooltip.show(pattern, sequence)       pattern { icon, main, secondary[], additional[] }
 *   service.map.setBounds({ sw:{lat,lng}, ne:{lat,lng} }) → Promise
 *   service.page.getFilterState()                 → Promise<[{ id }]>
 *   service.page.attach('focus'|'filterChange', fn)
 */
/* global geotab, ShipmentTrackerShared */
geotab.addin.shipmentTrackerMap = function (elt, service) {
    'use strict';

    var S = ShipmentTrackerShared;
    var esc = S.esc;
    var REFRESH_MS = 60000;
    var TOOLTIP_SEQUENCE = 10;
    var MAX_TOOLTIP_CONTAINERS = 8;

    var loads = {};          // deviceId -> [registros abiertos]
    var allowed = null;      // Set de deviceIds del filtro de grupos (null = todos)
    var locations = {};      // deviceId -> { lat, lng } (desde eventos 'change')
    var lastUpdate = null;
    var timer = null;

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    elt.innerHTML =
        '<div class="stm">' +
        '  <div class="stm-head">' +
        '    <div><strong>Cargas en ruta</strong><div class="stm-sub" id="stm-count"></div></div>' +
        '    <button class="stm-btn" id="stm-refresh" title="Actualizar">↻</button>' +
        '  </div>' +
        '  <input class="stm-search" id="stm-search" type="search" placeholder="Buscar patente, shipment o contenedor…" autocomplete="off">' +
        '  <div class="stm-msg" id="stm-msg" hidden></div>' +
        '  <ul class="stm-list" id="stm-list"></ul>' +
        '  <div class="stm-foot" id="stm-foot"></div>' +
        '</div>';

    function q(sel) { return elt.querySelector(sel); }

    function msg(text) {
        var el = q('#stm-msg');
        el.textContent = text || '';
        el.hidden = !text;
    }

    // ------------------------------------------------------------------
    // Datos
    // ------------------------------------------------------------------
    function loadFilter() {
        return service.page.getFilterState().then(function (groups) {
            groups = (groups || []).filter(function (g) { return g && g.id; });
            var onlyCompany = !groups.length || (groups.length === 1 && groups[0].id === 'GroupCompanyId');
            if (onlyCompany) { allowed = null; return; }
            return service.api.call('Get', {
                typeName: 'Device',
                search: { groups: groups, fromDate: new Date().toISOString() }
            }).then(function (devs) {
                allowed = {};
                (devs || []).forEach(function (d) { allowed[d.id] = true; });
            });
        }).catch(function () { allowed = null; });
    }

    function loadRecords() {
        return service.api.call('Get', { typeName: 'AddInData', search: { addInId: S.ADDIN_ID } })
            .then(function (list) {
                loads = S.openByDevice((list || []).filter(S.isAssignment));
                lastUpdate = new Date();
            });
    }

    function refresh() {
        return Promise.all([loadFilter(), loadRecords()])
            .then(function () { msg(''); render(); })
            .catch(function (e) { msg('No se pudo actualizar: ' + S.errText(e)); });
    }

    function visibleDeviceIds() {
        return Object.keys(loads).filter(function (id) { return !allowed || allowed[id]; });
    }

    // ------------------------------------------------------------------
    // Panel
    // ------------------------------------------------------------------
    function deviceLabel(rec) {
        var d = rec.details;
        return (d.deviceName || d.deviceId) + (d.licensePlate && d.licensePlate !== d.deviceName ? ' · ' + d.licensePlate : '');
    }

    function render() {
        var term = (q('#stm-search').value || '').trim().toUpperCase();
        var ids = visibleDeviceIds().filter(function (id) {
            if (!term) { return true; }
            var recs = loads[id];
            var hay = [deviceLabel(recs[0])];
            recs.forEach(function (r) { hay.push(r.details.shipmentNumber); hay = hay.concat(S.containersOf(r)); });
            return hay.join(' ').toUpperCase().indexOf(term) >= 0;
        }).sort(function (a, b) { return deviceLabel(loads[a][0]).localeCompare(deviceLabel(loads[b][0])); });

        q('#stm-list').innerHTML = ids.length ? ids.map(function (id) {
            var recs = loads[id];
            return '<li class="stm-item" data-id="' + esc(id) + '" tabindex="0" title="Centrar en el mapa">' +
                '<div class="stm-dev">' + esc(deviceLabel(recs[0])) + '</div>' +
                recs.map(function (r) {
                    var c = S.containersOf(r);
                    return '<div class="stm-ship"><span class="stm-chip">' + esc(r.details.shipmentNumber) + '</span>' +
                        '<span class="stm-since">' + esc(S.fmtDuration(r.details.from, null)) + '</span>' +
                        (c.length ? '<div class="stm-cont">' + esc(c.join(' · ')) + '</div>' : '') +
                        '</div>';
                }).join('') +
                '</li>';
        }).join('') : '<li class="stm-empty">' + (term ? 'Sin coincidencias.' : 'No hay vehículos con carga.') + '</li>';

        var total = visibleDeviceIds().length;
        q('#stm-count').textContent = total + ' vehículo' + (total === 1 ? '' : 's') + ' con carga';
        q('#stm-foot').textContent = lastUpdate ? 'Actualizado ' + lastUpdate.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    }

    function centerOn(deviceId) {
        var known = locations[deviceId];
        var getLoc = known ? Promise.resolve(known) :
            service.api.call('Get', { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: deviceId } } })
                .then(function (list) {
                    var s = list && list[0];
                    return s && typeof s.latitude === 'number' ? { lat: s.latitude, lng: s.longitude } : null;
                });
        getLoc.then(function (loc) {
            if (!loc) { msg('No hay posición disponible para este vehículo.'); return; }
            var d = 0.01;
            return service.map.setBounds({
                sw: { lat: loc.lat - d, lng: loc.lng - d },
                ne: { lat: loc.lat + d, lng: loc.lng + d }
            });
        }).catch(function (e) { msg('No se pudo centrar el mapa: ' + S.errText(e)); });
    }

    // ------------------------------------------------------------------
    // Tooltip
    // ------------------------------------------------------------------
    function tooltipFor(deviceId) {
        var recs = loads[deviceId];
        if (!recs || !recs.length) { return null; }
        var secondary = recs.map(function (r) {
            var n = S.containersOf(r).length;
            return 'Shipment ' + r.details.shipmentNumber + (n ? ' · ' + n + ' contenedor' + (n === 1 ? '' : 'es') : '');
        });
        var containers = [];
        recs.forEach(function (r) { containers = containers.concat(S.containersOf(r)); });
        var additional = containers.slice(0, MAX_TOOLTIP_CONTAINERS);
        if (containers.length > MAX_TOOLTIP_CONTAINERS) {
            additional.push('+' + (containers.length - MAX_TOOLTIP_CONTAINERS) + ' más');
        }
        return { main: 'Carga', secondary: secondary, additional: additional };
    }

    service.events.attach('over', function (data) {
        if (!data || data.type !== 'device' || !data.entity) { return; }
        var t = tooltipFor(data.entity.id);
        if (t) { service.tooltip.show(t, TOOLTIP_SEQUENCE); }
    });

    service.events.attach('change', function (data) {
        if (data && data.type === 'device' && data.entity && data.location) {
            locations[data.entity.id] = data.location;
        }
    });

    // ------------------------------------------------------------------
    // Eventos del panel y de la página
    // ------------------------------------------------------------------
    q('#stm-search').addEventListener('input', render);
    q('#stm-refresh').addEventListener('click', refresh);
    q('#stm-list').addEventListener('click', function (e) {
        var li = e.target.closest('.stm-item');
        if (li) { centerOn(li.getAttribute('data-id')); }
    });
    q('#stm-list').addEventListener('keydown', function (e) {
        var li = e.target.closest('.stm-item');
        if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); centerOn(li.getAttribute('data-id')); }
    });

    service.page.attach('focus', refresh);
    service.page.attach('filterChange', refresh);
    timer = setInterval(refresh, REFRESH_MS);
    service.page.attach('blur', function () { if (timer) { clearInterval(timer); timer = null; } });
    service.page.attach('focus', function () { if (!timer) { timer = setInterval(refresh, REFRESH_MS); } });

    refresh();

    // Expuesto solo para pruebas
    return { _tooltipFor: tooltipFor, _refresh: refresh };
};
