/**
 * Shipment Tracker — página MyGeotab (base: yusen) · v2
 *
 * Todo se registra en AddInData (ver scripts/shared.js). No usa customProperties.
 * Un vehículo puede llevar varios shipments a la vez; cada asignación tiene
 * su lista de contenedores y su propio período (from / to).
 *
 * API de add-ins de página (verificada):
 *   api.call(method, params, success, error)
 *   api.multiCall(calls, success, error)
 *   api.getSession(callback[, newSession:boolean])   ← el 2.º NO es callback de error
 *   state.getGroupFilter(), state.gotoPage(page, args)
 *
 * Ingeniero Jorge Cesetti SRL
 */
/* global geotab, ShipmentTrackerShared */
geotab.addin.shipmentTracker = function () {
    'use strict';

    var S = ShipmentTrackerShared;
    var esc = S.esc;

    var api, state, root;
    var session = { userName: '' };
    var devices = [];          // [{ id, name, licensePlate }]
    var records = [];          // todos los registros de asignación
    var openMap = {};          // deviceId -> [registros abiertos]
    var historyRows = [];
    var selected = {};
    var modalDeviceId = null;
    var busy = false;

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------
    function $(sel) { return root.querySelector(sel); }

    function call(method, params) {
        return new Promise(function (resolve, reject) {
            api.call(method, params, resolve, reject);
        });
    }

    function multiCall(calls) {
        if (!calls.length) { return Promise.resolve([]); }
        return new Promise(function (resolve, reject) {
            api.multiCall(calls, resolve, reject);
        });
    }

    function deviceById(id) {
        for (var i = 0; i < devices.length; i++) { if (devices[i].id === id) { return devices[i]; } }
        return null;
    }

    function openOf(deviceId) { return openMap[deviceId] || []; }

    function showMsg(text, kind) {
        var el = $('#st-msg');
        el.textContent = text;
        el.className = 'st-msg st-msg-' + (kind || 'info');
        el.hidden = false;
        clearTimeout(showMsg.t);
        if (kind !== 'error') {
            showMsg.t = setTimeout(function () { el.hidden = true; }, 6000);
        }
    }

    function setBusy(b) {
        busy = b;
        root.classList.toggle('is-busy', b);
        Array.prototype.forEach.call(root.querySelectorAll('button, input, select, textarea'), function (el) {
            el.disabled = b;
        });
    }

    function nowIso() { return new Date().toISOString(); }

    // ------------------------------------------------------------------
    // AddInData
    // ------------------------------------------------------------------
    /**
     * Trae todos los registros del add-in y filtra en el cliente.
     * (El whereClause de AddInData exige selectClause, no admite AND/OR ni
     *  null documentado; por robustez no se usa.)
     */
    function loadRecords() {
        return call('Get', { typeName: 'AddInData', search: { addInId: S.ADDIN_ID } })
            .then(function (list) {
                records = (list || []).filter(S.isAssignment);
                openMap = S.openByDevice(records);
            });
    }

    function newRecord(device, shipment, containers, source) {
        var now = nowIso();
        return {
            addInId: S.ADDIN_ID,
            groups: [{ id: 'GroupCompanyId' }],
            details: {
                type: S.RECORD_TYPE,
                version: 2,
                status: 'open',
                deviceId: device.id,
                deviceName: device.name || '',
                licensePlate: device.licensePlate || '',
                shipmentNumber: shipment,
                containers: containers || [],
                from: now,
                to: null,
                assignedBy: session.userName,
                closedBy: null,
                updatedAt: now,
                updatedBy: session.userName,
                source: source || 'addin'
            }
        };
    }

    function withDetails(rec, changes) {
        var d = JSON.parse(JSON.stringify(rec.details));
        Object.keys(changes).forEach(function (k) { d[k] = changes[k]; });
        d.updatedAt = nowIso();
        d.updatedBy = session.userName;
        return {
            id: rec.id,
            addInId: S.ADDIN_ID,
            groups: rec.groups || [{ id: 'GroupCompanyId' }],
            details: d
        };
    }

    function closedVersion(rec) {
        return withDetails(rec, { to: nowIso(), closedBy: session.userName, status: 'closed' });
    }

    /** Aplica en memoria el resultado de una escritura. */
    function applyLocal(rec) {
        var i;
        for (i = 0; i < records.length; i++) {
            if (records[i].id === rec.id) { records[i] = rec; break; }
        }
        if (i === records.length) { records.push(rec); }
        openMap = S.openByDevice(records);
    }

    // ------------------------------------------------------------------
    // Operaciones
    // ------------------------------------------------------------------
    /** Agrega un shipment (con contenedores) a un vehículo. Si ya lo tiene abierto, suma contenedores. */
    function addLoad(deviceId, shipment, containers) {
        var dev = deviceById(deviceId);
        if (!dev) { return Promise.reject(new Error('Vehículo no encontrado')); }
        var existing = openOf(deviceId).filter(function (r) { return r.details.shipmentNumber === shipment; })[0];
        if (existing) {
            var merged = S.parseContainers(S.containersOf(existing).concat(containers).join(' '));
            if (merged.length === S.containersOf(existing).length) { return Promise.resolve('unchanged'); }
            var upd = withDetails(existing, { containers: merged });
            return call('Set', { typeName: 'AddInData', entity: upd }).then(function () {
                applyLocal(upd);
                return 'updated';
            });
        }
        var rec = newRecord(dev, shipment, containers);
        return call('Add', { typeName: 'AddInData', entity: rec }).then(function (id) {
            rec.id = id;
            applyLocal(rec);
            return 'added';
        });
    }

    function closeLoads(recs) {
        if (!recs.length) { return Promise.resolve(0); }
        var closed = recs.map(closedVersion);
        return multiCall(closed.map(function (r) {
            return ['Set', { typeName: 'AddInData', entity: r }];
        })).then(function () {
            closed.forEach(applyLocal);
            return closed.length;
        });
    }

    function updateContainers(rec, containers) {
        var upd = withDetails(rec, { containers: containers });
        return call('Set', { typeName: 'AddInData', entity: upd }).then(function () { applyLocal(upd); });
    }

    /** Confirma contenedores que no pasan ISO 6346 (se permiten, pero se avisa). */
    function confirmContainers(list) {
        var bad = S.invalidContainers(list);
        if (!bad.length) { return true; }
        return window.confirm(
            'Estos contenedores no cumplen el formato ISO 6346 (4 letras + 7 dígitos con dígito verificador):\n\n' +
            bad.join('\n') + '\n\n¿Guardar igual?'
        );
    }

    function runBatch(ids, fn, okText) {
        if (busy || !ids.length) { return Promise.resolve(); }
        setBusy(true);
        var ok = 0, fails = [];
        var chain = Promise.resolve();
        ids.forEach(function (id) {
            chain = chain.then(function () {
                return fn(id).then(function (r) { if (r !== 'unchanged' && r !== 0) { ok++; } }, function (e) {
                    var d = deviceById(id);
                    fails.push((d ? d.name : id) + ': ' + S.errText(e));
                });
            });
        });
        return chain.then(function () {
            setBusy(false);
            renderDevices();
            if (modalDeviceId) { renderModal(); }
            if (fails.length) {
                showMsg(ok + ' ' + okText + ', ' + fails.length + ' con error → ' + fails.join(' | '), 'error');
            } else {
                showMsg(ok + ' ' + okText + '.', 'ok');
            }
        });
    }

    // ------------------------------------------------------------------
    // Carga inicial
    // ------------------------------------------------------------------
    function loadDevices() {
        var search = { fromDate: nowIso() };
        var groupFilter = state && state.getGroupFilter ? state.getGroupFilter() : null;
        if (groupFilter && groupFilter.length) { search.groups = groupFilter; }
        return call('Get', { typeName: 'Device', search: search }).then(function (list) {
            devices = (list || []).filter(function (d) {
                return !(d.groups || []).some(function (g) { return g.id === 'GroupTrailerId'; });
            }).map(function (d) {
                return { id: d.id, name: d.name || '', licensePlate: d.licensePlate || '' };
            }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        });
    }

    function reloadAll() {
        setBusy(true);
        return Promise.all([loadDevices(), loadRecords()])
            .then(function () { renderDevices(); })
            .catch(function (e) { showMsg('No se pudieron cargar los datos: ' + S.errText(e), 'error'); })
            .then(function () { setBusy(false); });
    }

    // ------------------------------------------------------------------
    // Render: vehículos
    // ------------------------------------------------------------------
    function searchText(d) {
        var parts = [d.name, d.licensePlate];
        openOf(d.id).forEach(function (r) {
            parts.push(r.details.shipmentNumber);
            parts = parts.concat(S.containersOf(r));
        });
        return parts.join(' ').toLowerCase();
    }

    function filteredDevices() {
        var q = ($('#st-filter').value || '').trim().toLowerCase();
        var st = $('#st-state-filter').value;
        return devices.filter(function (d) {
            var has = openOf(d.id).length > 0;
            if (st === 'with' && !has) { return false; }
            if (st === 'without' && has) { return false; }
            if (q && searchText(d).indexOf(q) < 0) { return false; }
            return true;
        });
    }

    function loadChips(deviceId) {
        var loads = openOf(deviceId);
        if (!loads.length) { return '<span class="st-muted">—</span>'; }
        return loads.map(function (r) {
            var c = S.containersOf(r);
            return '<span class="st-chip" title="' + esc(c.join(', ') || 'Sin contenedores') + '">' +
                esc(r.details.shipmentNumber) +
                (c.length ? ' <b>' + c.length + '</b>' : '') + '</span>';
        }).join(' ');
    }

    function renderDevices() {
        var list = filteredDevices();
        $('#st-devices').innerHTML = list.map(function (d) {
            return '<tr data-id="' + esc(d.id) + '">' +
                '<td class="st-col-check"><input type="checkbox" class="st-check" ' + (selected[d.id] ? 'checked' : '') + '></td>' +
                '<td>' + esc(d.name) + '</td>' +
                '<td>' + esc(d.licensePlate) + '</td>' +
                '<td class="st-loads">' + loadChips(d.id) + '</td>' +
                '<td class="st-col-actions">' +
                '<button class="st-btn st-btn-sm" data-act="open">Gestionar carga</button>' +
                '<button class="st-btn st-btn-sm st-btn-ghost" data-act="hist">Historial</button>' +
                '</td></tr>';
        }).join('');
        $('#st-devices-empty').hidden = list.length > 0;
        var withLoad = devices.filter(function (d) { return openOf(d.id).length; }).length;
        $('#st-devices-count').textContent = list.length + ' de ' + devices.length + ' vehículos · ' + withLoad + ' con carga';
        updateBulk();
    }

    function updateBulk() {
        var n = Object.keys(selected).length;
        $('#st-bulk').hidden = n === 0;
        $('#st-bulk-count').textContent = n + ' seleccionado' + (n === 1 ? '' : 's');
        var visible = filteredDevices();
        $('#st-check-all').checked = visible.length > 0 && visible.every(function (d) { return selected[d.id]; });
    }

    // ------------------------------------------------------------------
    // Detalle de vehículo (modal)
    // ------------------------------------------------------------------
    function openModal(deviceId) {
        modalDeviceId = deviceId;
        var d = deviceById(deviceId);
        $('#st-modal-title').textContent = d.name + (d.licensePlate && d.licensePlate !== d.name ? ' · ' + d.licensePlate : '');
        $('#st-add-shipment').value = '';
        $('#st-add-containers').value = '';
        renderModal();
        $('#st-modal').hidden = false;
        $('#st-add-shipment').focus();
    }

    function closeModal() {
        modalDeviceId = null;
        $('#st-modal').hidden = true;
    }

    function renderModal() {
        var loads = openOf(modalDeviceId);
        if (!loads.length) {
            $('#st-modal-loads').innerHTML = '<p class="st-empty">Sin carga asignada.</p>';
            return;
        }
        $('#st-modal-loads').innerHTML = loads.map(function (r) {
            var c = S.containersOf(r);
            return '<div class="st-load" data-rec="' + esc(r.id) + '">' +
                '<div class="st-load-head"><strong>' + esc(r.details.shipmentNumber) + '</strong>' +
                '<span class="st-muted">desde ' + esc(S.fmtDate(r.details.from)) + ' · ' + esc(r.details.assignedBy) + '</span></div>' +
                '<textarea class="st-load-containers" rows="2" placeholder="Sin contenedores">' + esc(c.join('\n')) + '</textarea>' +
                '<div class="st-load-actions">' +
                '<button class="st-btn st-btn-sm st-btn-ghost" data-load="save">Guardar contenedores</button>' +
                '<button class="st-btn st-btn-sm st-btn-danger" data-load="close">Finalizar shipment</button>' +
                '</div></div>';
        }).join('') +
            (loads.length > 1 ? '<div class="st-load-all"><button class="st-btn st-btn-sm st-btn-danger" data-load="close-all">Finalizar toda la carga</button></div>' : '');
    }

    function recordById(id) {
        for (var i = 0; i < records.length; i++) { if (records[i].id === id) { return records[i]; } }
        return null;
    }

    // ------------------------------------------------------------------
    // Historial
    // ------------------------------------------------------------------
    function searchHistory() {
        var text = ($('#st-h-text').value || '').trim().toUpperCase();
        var dev = ($('#st-h-device').value || '').trim().toLowerCase();
        var from = $('#st-h-from').value ? new Date($('#st-h-from').value + 'T00:00:00') : null;
        var to = $('#st-h-to').value ? new Date($('#st-h-to').value + 'T23:59:59') : null;

        setBusy(true);
        loadRecords().then(function () {
            historyRows = records.filter(function (r) {
                var d = r.details;
                if (text) {
                    var hay = [d.shipmentNumber].concat(S.containersOf(r)).join(' ').toUpperCase();
                    if (hay.indexOf(text) < 0) { return false; }
                }
                if (dev && ((d.deviceName || '') + ' ' + (d.licensePlate || '')).toLowerCase().indexOf(dev) < 0) { return false; }
                var rf = new Date(d.from), rt = d.to ? new Date(d.to) : new Date();
                if (from && rt < from) { return false; }
                if (to && rf > to) { return false; }
                return true;
            }).sort(function (a, b) { return a.details.from < b.details.from ? 1 : -1; });
            renderHistory();
            renderDevices();
        }).catch(function (e) {
            showMsg('No se pudo leer el historial: ' + S.errText(e), 'error');
        }).then(function () { setBusy(false); });
    }

    function renderHistory() {
        $('#st-history').innerHTML = historyRows.map(function (r, i) {
            var d = r.details;
            var c = S.containersOf(r);
            return '<tr>' +
                '<td><strong>' + esc(d.shipmentNumber) + '</strong></td>' +
                '<td class="st-mono">' + (c.length ? esc(c.join(', ')) : '<span class="st-muted">—</span>') + '</td>' +
                '<td>' + esc(d.deviceName) + (d.licensePlate && d.licensePlate !== d.deviceName ? ' <span class="st-muted">' + esc(d.licensePlate) + '</span>' : '') + '</td>' +
                '<td>' + esc(S.fmtDate(d.from)) + '</td>' +
                '<td>' + (d.to ? esc(S.fmtDate(d.to)) : '<span class="st-badge">En curso</span>') + '</td>' +
                '<td>' + esc(S.fmtDuration(d.from, d.to)) + '</td>' +
                '<td>' + esc(d.assignedBy) + (d.source === 'sync' ? ' <span class="st-muted">(sync)</span>' : '') + '</td>' +
                '<td>' + esc(d.closedBy || '') + '</td>' +
                '<td class="st-col-actions"><button class="st-btn st-btn-sm st-btn-ghost" data-trip="' + i + '">Ver recorrido</button></td>' +
                '</tr>';
        }).join('');
        $('#st-history-empty').hidden = historyRows.length > 0;
        $('#st-history-count').textContent = historyRows.length ? historyRows.length + ' registro(s)' : '';
    }

    function openTrips(idx) {
        var d = historyRows[idx] && historyRows[idx].details;
        if (!d || !state || !state.gotoPage) { return; }
        state.gotoPage('tripsHistory', {
            devices: [d.deviceId],
            dateRange: { startDate: d.from, endDate: d.to || nowIso() }
        });
    }

    function exportCsv() {
        if (!historyRows.length) { showMsg('No hay registros para exportar.', 'info'); return; }
        var cols = ['shipmentNumber', 'containers', 'deviceName', 'licensePlate', 'from', 'to', 'assignedBy', 'closedBy', 'updatedAt', 'updatedBy'];
        var lines = [cols.join(';')].concat(historyRows.map(function (r) {
            return cols.map(function (c) {
                var v = c === 'containers' ? S.containersOf(r).join(' ') : r.details[c];
                v = v === null || v === undefined ? '' : String(v);
                return '"' + v.replace(/"/g, '""') + '"';
            }).join(';');
        }));
        var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'shipments_' + nowIso().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    // ------------------------------------------------------------------
    // Eventos
    // ------------------------------------------------------------------
    function switchTab(name) {
        Array.prototype.forEach.call(root.querySelectorAll('.st-tab'), function (t) {
            t.classList.toggle('is-active', t.getAttribute('data-tab') === name);
        });
        $('#st-tab-assign').hidden = name !== 'assign';
        $('#st-tab-history').hidden = name !== 'history';
    }

    function bindEvents() {
        Array.prototype.forEach.call(root.querySelectorAll('.st-tab'), function (t) {
            t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
        });

        $('#st-filter').addEventListener('input', renderDevices);
        $('#st-state-filter').addEventListener('change', renderDevices);
        $('#st-refresh').addEventListener('click', reloadAll);

        $('#st-check-all').addEventListener('change', function (e) {
            filteredDevices().forEach(function (d) {
                if (e.target.checked) { selected[d.id] = true; } else { delete selected[d.id]; }
            });
            renderDevices();
        });

        var tbody = $('#st-devices');
        tbody.addEventListener('change', function (e) {
            if (!e.target.classList.contains('st-check')) { return; }
            var id = e.target.closest('tr').getAttribute('data-id');
            if (e.target.checked) { selected[id] = true; } else { delete selected[id]; }
            updateBulk();
        });
        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-act]');
            if (!btn) { return; }
            var id = btn.closest('tr').getAttribute('data-id');
            if (btn.getAttribute('data-act') === 'open') {
                openModal(id);
            } else {
                var d = deviceById(id);
                $('#st-h-text').value = '';
                $('#st-h-device').value = d.name;
                $('#st-h-from').value = '';
                $('#st-h-to').value = '';
                switchTab('history');
                searchHistory();
            }
        });

        // Masivo
        $('#st-bulk-assign').addEventListener('click', function () {
            var ship = S.normalizeShipment($('#st-bulk-value').value);
            var err = S.validateShipment(ship);
            if (err) { showMsg(err, 'error'); return; }
            runBatch(Object.keys(selected), function (id) { return addLoad(id, ship, []); }, 'vehículo(s) actualizados')
                .then(function () { selected = {}; $('#st-bulk-value').value = ''; renderDevices(); });
        });
        $('#st-bulk-clear').addEventListener('click', function () {
            var ids = Object.keys(selected).filter(function (id) { return openOf(id).length; });
            if (!ids.length) { showMsg('Los vehículos seleccionados no tienen carga.', 'info'); return; }
            if (!window.confirm('¿Finalizar toda la carga de ' + ids.length + ' vehículo(s)?')) { return; }
            runBatch(ids, function (id) { return closeLoads(openOf(id)); }, 'vehículo(s) finalizados')
                .then(function () { selected = {}; renderDevices(); });
        });

        // Modal
        $('#st-modal').addEventListener('click', function (e) {
            if (e.target.id === 'st-modal' || e.target.hasAttribute('data-close')) { closeModal(); return; }
            var btn = e.target.closest('button[data-load]');
            if (!btn || busy) { return; }
            var act = btn.getAttribute('data-load');
            if (act === 'close-all') {
                if (window.confirm('¿Finalizar todos los shipments de este vehículo?')) {
                    runBatch([modalDeviceId], function (id) { return closeLoads(openOf(id)); }, 'carga finalizada');
                }
                return;
            }
            var rec = recordById(btn.closest('.st-load').getAttribute('data-rec'));
            if (!rec) { return; }
            if (act === 'close') {
                if (window.confirm('¿Finalizar el shipment ' + rec.details.shipmentNumber + '?')) {
                    runBatch([modalDeviceId], function () { return closeLoads([rec]); }, 'shipment finalizado');
                }
            } else if (act === 'save') {
                var list = S.parseContainers(btn.closest('.st-load').querySelector('textarea').value);
                if (!confirmContainers(list)) { return; }
                runBatch([modalDeviceId], function () { return updateContainers(rec, list); }, 'contenedores guardados');
            }
        });
        root.ownerDocument.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modalDeviceId) { closeModal(); }
        });
        $('#st-add-form').addEventListener('submit', function (e) {
            e.preventDefault();
            var ship = S.normalizeShipment($('#st-add-shipment').value);
            var err = S.validateShipment(ship);
            if (err) { showMsg(err, 'error'); return; }
            var list = S.parseContainers($('#st-add-containers').value);
            if (!confirmContainers(list)) { return; }
            runBatch([modalDeviceId], function (id) { return addLoad(id, ship, list); }, 'carga registrada')
                .then(function () {
                    $('#st-add-shipment').value = '';
                    $('#st-add-containers').value = '';
                });
        });

        // Historial
        $('#st-h-search').addEventListener('click', searchHistory);
        ['#st-h-text', '#st-h-device'].forEach(function (sel) {
            $(sel).addEventListener('keydown', function (e) { if (e.key === 'Enter') { searchHistory(); } });
        });
        $('#st-h-export').addEventListener('click', exportCsv);
        $('#st-history').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-trip]');
            if (btn) { openTrips(parseInt(btn.getAttribute('data-trip'), 10)); }
        });
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------
    var bound = false;

    return {
        initialize: function (freshApi, freshState, callback) {
            api = freshApi;
            state = freshState;
            root = document.getElementById('shipmentTracker');
            if (!bound) { bindEvents(); bound = true; }
            var done = false;
            function finish() { if (!done) { done = true; callback(); } }
            try {
                api.getSession(function (s) {
                    session.userName = s && s.userName ? s.userName : '';
                    finish();
                });
            } catch (e) {
                finish();
            }
        },
        focus: function (freshApi, freshState) {
            api = freshApi;
            state = freshState;
            reloadAll();
        },
        blur: function () {
            selected = {};
            closeModal();
        }
    };
};
