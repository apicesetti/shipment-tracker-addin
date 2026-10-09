/**
 * Shipment Tracker — MyGeotab page add-in (base: yusen)
 *
 * - Asigna el ShipmentNumber de cada camión en Device.customProperties.
 * - Registra cada asignación como un período en AddInData (historial):
 *     { type, deviceId, deviceName, licensePlate, shipmentNumber,
 *       from, to, assignedBy, closedBy, source }
 *   Un registro con to === null es el shipment "abierto" (vigente) del camión.
 *
 * Ingeniero Jorge Cesetti SRL
 */
/* global geotab */
geotab.addin.shipmentTracker = function () {
    'use strict';

    // ------------------------------------------------------------------
    // Configuración
    // ------------------------------------------------------------------
    var CONFIG = {
        // AddInData: identificador único de este add-in (no cambiar una vez en producción)
        addInId: 'ad4_hnI9SRnKRGHRvRl88fw',
        recordType: 'shipmentAssignment',
        // Custom property de yusen. Si el nombre se encuentra en los devices,
        // se usa la definición que viene de la base; los IDs son el respaldo.
        propertyName: 'ShipmentNumber',
        propertyId: 'aihgC0czqFEiEw4cSMia9yg',
        propertySetId: 'aFyN7U4GoKUm0-RCuo5d98g',
        // Validación del número: alfanumérico, guion, barra y punto, 1–50 caracteres
        shipmentPattern: /^[A-Za-z0-9\-\/\.]{1,50}$/,
        uppercase: true
    };

    var api, state, root;
    var session = { userName: '' };
    var propertyDef = null;          // definición de Property tomada de la base
    var devices = [];                // [{ id, name, licensePlate, value }]
    var openRecords = {};            // deviceId -> AddInData abierto
    var historyRows = [];            // últimos resultados del historial
    var selected = {};               // deviceId -> true
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

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function errText(e) {
        if (!e) { return 'Error desconocido'; }
        if (typeof e === 'string') { return e; }
        return e.message || e.name || JSON.stringify(e);
    }

    function fmtDate(iso) {
        if (!iso) { return ''; }
        var d = new Date(iso);
        if (isNaN(d)) { return ''; }
        return d.toLocaleString('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    function fmtDuration(fromIso, toIso) {
        if (!fromIso) { return ''; }
        var ms = (toIso ? new Date(toIso) : new Date()) - new Date(fromIso);
        if (ms < 0) { return ''; }
        var min = Math.floor(ms / 60000);
        var d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
        return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
    }

    function normalize(v) {
        v = (v || '').trim();
        return CONFIG.uppercase ? v.toUpperCase() : v;
    }

    function validate(v) {
        if (!v) { return 'Ingresá un ShipmentNumber.'; }
        if (!CONFIG.shipmentPattern.test(v)) {
            return 'ShipmentNumber inválido: solo letras, números, "-", "/" o "." (máx. 50).';
        }
        return null;
    }

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
        Array.prototype.forEach.call(root.querySelectorAll('button, input, select'), function (el) {
            el.disabled = b;
        });
    }

    // ------------------------------------------------------------------
    // Custom property
    // ------------------------------------------------------------------
    function findPropValue(device) {
        var props = device.customProperties || [];
        for (var i = 0; i < props.length; i++) {
            var p = props[i].property || {};
            if (p.id === CONFIG.propertyId || p.name === CONFIG.propertyName) { return props[i]; }
        }
        return null;
    }

    function currentValue(device) {
        var pv = findPropValue(device);
        return pv && pv.value ? String(pv.value) : '';
    }

    function learnPropertyDef(deviceList) {
        for (var i = 0; i < deviceList.length; i++) {
            var pv = findPropValue(deviceList[i]);
            if (pv && pv.property && pv.property.id) {
                propertyDef = pv.property;
                CONFIG.propertyId = pv.property.id;
                return;
            }
        }
        propertyDef = {
            id: CONFIG.propertyId,
            name: CONFIG.propertyName,
            propertyType: 'String',
            propertySet: { id: CONFIG.propertySetId }
        };
    }

    /** Devuelve el device con el valor aplicado (o quitado si value === ''). */
    function applyValue(device, value) {
        device.customProperties = device.customProperties || [];
        var pv = findPropValue(device);
        if (!pv) {
            pv = { property: propertyDef };
            device.customProperties.push(pv);
        }
        if (value) {
            pv.value = value;
        } else {
            delete pv.value;
        }
        return device;
    }

    // ------------------------------------------------------------------
    // AddInData (historial)
    // ------------------------------------------------------------------
    function getRecords(where) {
        var search = { addInId: CONFIG.addInId };
        if (where) { search.whereClause = where; }
        return call('Get', { typeName: 'AddInData', search: search })
            .catch(function (e) {
                // Si el servidor no acepta el whereClause, se filtra en el cliente.
                if (!where) { throw e; }
                return call('Get', { typeName: 'AddInData', search: { addInId: CONFIG.addInId } });
            })
            .then(function (list) {
                return (list || []).filter(function (r) {
                    return r.details && r.details.type === CONFIG.recordType;
                });
            });
    }

    function newRecord(device, shipment, source) {
        return {
            addInId: CONFIG.addInId,
            groups: [{ id: 'GroupCompanyId' }],
            details: {
                type: CONFIG.recordType,
                deviceId: device.id,
                deviceName: device.name || '',
                licensePlate: device.licensePlate || '',
                shipmentNumber: shipment,
                from: new Date().toISOString(),
                to: null,
                assignedBy: session.userName,
                closedBy: null,
                source: source || 'addin'
            }
        };
    }

    function closeRecord(rec, by) {
        var d = JSON.parse(JSON.stringify(rec.details));
        d.to = new Date().toISOString();
        d.closedBy = by || session.userName;
        return {
            id: rec.id,
            addInId: CONFIG.addInId,
            groups: rec.groups || [{ id: 'GroupCompanyId' }],
            details: d
        };
    }

    function loadOpenRecords() {
        return getRecords('to = null').then(function (list) {
            openRecords = {};
            list.forEach(function (r) {
                if (r.details.to) { return; }
                var prev = openRecords[r.details.deviceId];
                // Si por algún motivo hay más de uno abierto, queda el más reciente
                if (!prev || prev.details.from < r.details.from) {
                    openRecords[r.details.deviceId] = r;
                }
            });
        });
    }

    // ------------------------------------------------------------------
    // Carga de vehículos
    // ------------------------------------------------------------------
    function loadDevices() {
        var search = { fromDate: new Date().toISOString() };   // solo activos
        var groupFilter = state && state.getGroupFilter ? state.getGroupFilter() : null;
        if (groupFilter && groupFilter.length) { search.groups = groupFilter; }

        return call('Get', { typeName: 'Device', search: search }).then(function (list) {
            list = (list || []).filter(function (d) {
                return !(d.groups || []).some(function (g) { return g.id === 'GroupTrailerId'; });
            });
            learnPropertyDef(list);
            devices = list.map(function (d) {
                return {
                    id: d.id,
                    name: d.name || '',
                    licensePlate: d.licensePlate || '',
                    value: currentValue(d)
                };
            }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        });
    }

    function reloadAll() {
        setBusy(true);
        return Promise.all([loadDevices(), loadOpenRecords()])
            .then(function () { renderDevices(); })
            .catch(function (e) { showMsg('No se pudieron cargar los datos: ' + errText(e), 'error'); })
            .then(function () { setBusy(false); });
    }

    // ------------------------------------------------------------------
    // Asignación
    // ------------------------------------------------------------------
    /**
     * Asigna (o finaliza, si shipment === '') el shipment de un vehículo.
     * 1) relee el device, 2) Set Device, 3) cierra registro abierto, 4) abre registro nuevo.
     */
    function assignOne(deviceId, shipment) {
        var fresh;
        return call('Get', { typeName: 'Device', search: { id: deviceId } })
            .then(function (list) {
                if (!list || !list.length) { throw new Error('Vehículo ' + deviceId + ' no encontrado'); }
                fresh = list[0];
                var open = openRecords[deviceId];
                var histVal = open ? open.details.shipmentNumber : '';
                if (currentValue(fresh) === shipment && histVal === shipment) {
                    return 'unchanged';
                }
                if (currentValue(fresh) === shipment) {
                    return 'device-ok';   // el vehículo ya tiene el valor; solo falta el historial
                }
                return call('Set', { typeName: 'Device', entity: applyValue(fresh, shipment) });
            })
            .then(function (res) {
                if (res === 'unchanged') { return 'unchanged'; }
                var calls = [];
                var open = openRecords[deviceId];
                var rec = shipment ? newRecord(fresh, shipment) : null;
                if (open) {
                    calls.push(['Set', { typeName: 'AddInData', entity: closeRecord(open) }]);
                }
                if (rec) {
                    calls.push(['Add', { typeName: 'AddInData', entity: rec }]);
                }
                return multiCall(calls).then(function (results) {
                    delete openRecords[deviceId];
                    if (rec) {
                        rec.id = results[results.length - 1];
                        openRecords[deviceId] = rec;
                    }
                    return 'ok';
                }, function (e) {
                    // El vehículo quedó actualizado pero el historial falló: avisar.
                    var err = new Error('El vehículo se actualizó, pero no se pudo registrar el historial: ' + errText(e));
                    err.partial = true;
                    throw err;
                });
            })
            .then(function (r) {
                var d = devices.filter(function (x) { return x.id === deviceId; })[0];
                if (d) { d.value = shipment; }
                return r;
            });
    }

    function assignMany(ids, shipment) {
        if (busy || !ids.length) { return; }
        if (shipment) {
            var err = validate(shipment);
            if (err) { showMsg(err, 'error'); return; }
        }
        setBusy(true);
        var ok = 0, same = 0, fails = [];
        // Secuencial para no saturar la API ni pisar cambios entre sí
        var chain = Promise.resolve();
        ids.forEach(function (id) {
            chain = chain.then(function () {
                return assignOne(id, shipment).then(function (r) {
                    if (r === 'unchanged') { same++; } else { ok++; }
                }, function (e) {
                    var d = devices.filter(function (x) { return x.id === id; })[0];
                    fails.push((d ? d.name : id) + ': ' + errText(e));
                });
            });
        });
        return chain.then(function () {
            setBusy(false);
            selected = {};
            renderDevices();
            var verb = shipment ? 'asignado' : 'finalizado';
            if (fails.length) {
                showMsg(ok + ' ' + verb + '(s), ' + fails.length + ' con error → ' + fails.join(' | '), 'error');
            } else {
                showMsg(ok + ' vehículo(s) ' + verb + '(s)' + (same ? ', ' + same + ' sin cambios' : '') + '.', 'ok');
            }
        });
    }

    /**
     * Si el valor se cambió desde la UI nativa de MyGeotab, el historial queda
     * desfasado. Esta acción lo alinea con el valor actual del vehículo.
     */
    function reconcile(deviceId) {
        var d = devices.filter(function (x) { return x.id === deviceId; })[0];
        if (!d) { return; }
        setBusy(true);
        var calls = [];
        var open = openRecords[deviceId];
        if (open) {
            calls.push(['Set', { typeName: 'AddInData', entity: closeRecord(open, session.userName + ' (sincronización)') }]);
        }
        var rec = d.value ? newRecord(d, d.value, 'sync') : null;
        if (rec) { calls.push(['Add', { typeName: 'AddInData', entity: rec }]); }
        multiCall(calls).then(function (results) {
            delete openRecords[deviceId];
            if (rec) { rec.id = results[results.length - 1]; openRecords[deviceId] = rec; }
            showMsg('Historial de ' + d.name + ' sincronizado.', 'ok');
        }, function (e) {
            showMsg('No se pudo sincronizar: ' + errText(e), 'error');
        }).then(function () { setBusy(false); renderDevices(); });
    }

    function isMismatch(d) {
        var open = openRecords[d.id];
        var histVal = open ? open.details.shipmentNumber : '';
        return histVal !== d.value;
    }

    // ------------------------------------------------------------------
    // Render: asignación
    // ------------------------------------------------------------------
    function filteredDevices() {
        var q = ($('#st-filter').value || '').toLowerCase();
        var st = $('#st-state-filter').value;
        return devices.filter(function (d) {
            if (q && (d.name + ' ' + d.licensePlate + ' ' + d.value).toLowerCase().indexOf(q) < 0) { return false; }
            if (st === 'with' && !d.value) { return false; }
            if (st === 'without' && d.value) { return false; }
            if (st === 'mismatch' && !isMismatch(d)) { return false; }
            return true;
        });
    }

    function renderDevices() {
        var list = filteredDevices();
        var html = list.map(function (d) {
            var open = openRecords[d.id];
            var mismatch = isMismatch(d);
            var since = open && !mismatch ? fmtDate(open.details.from) : '';
            return '<tr data-id="' + esc(d.id) + '"' + (mismatch ? ' class="is-mismatch"' : '') + '>' +
                '<td class="st-col-check"><input type="checkbox" class="st-check" ' + (selected[d.id] ? 'checked' : '') + '></td>' +
                '<td>' + esc(d.name) + '</td>' +
                '<td>' + esc(d.licensePlate) + '</td>' +
                '<td><input class="st-inline" type="text" value="' + esc(d.value) + '" placeholder="—" autocomplete="off"></td>' +
                '<td class="st-muted">' + esc(since) +
                (mismatch ? '<span class="st-warn" title="El valor no coincide con el historial (se modificó fuera del add-in)">⚠ difiere del historial</span>' : '') +
                '</td>' +
                '<td class="st-col-actions">' +
                '<button class="st-btn st-btn-sm" data-act="save">Guardar</button>' +
                (d.value ? '<button class="st-btn st-btn-sm st-btn-danger" data-act="clear">Finalizar</button>' : '') +
                (mismatch ? '<button class="st-btn st-btn-sm st-btn-ghost" data-act="sync">Sincronizar</button>' : '') +
                '<button class="st-btn st-btn-sm st-btn-ghost" data-act="hist">Historial</button>' +
                '</td></tr>';
        }).join('');
        $('#st-devices').innerHTML = html;
        $('#st-devices-empty').hidden = list.length > 0;
        var withShip = devices.filter(function (d) { return d.value; }).length;
        $('#st-devices-count').textContent = list.length + ' de ' + devices.length + ' vehículos · ' + withShip + ' con shipment asignado';
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
    // Historial
    // ------------------------------------------------------------------
    function searchHistory() {
        var ship = normalize($('#st-h-shipment').value);
        var dev = ($('#st-h-device').value || '').trim().toLowerCase();
        var from = $('#st-h-from').value ? new Date($('#st-h-from').value + 'T00:00:00') : null;
        var to = $('#st-h-to').value ? new Date($('#st-h-to').value + 'T23:59:59') : null;

        setBusy(true);
        var where = ship ? 'shipmentNumber = "' + ship.replace(/"/g, '') + '"' : null;
        getRecords(where).then(function (list) {
            historyRows = list.filter(function (r) {
                var d = r.details;
                if (ship && String(d.shipmentNumber).toUpperCase().indexOf(ship.toUpperCase()) < 0) { return false; }
                if (dev && (d.deviceName + ' ' + d.licensePlate).toLowerCase().indexOf(dev) < 0) { return false; }
                // Período que se solapa con el rango elegido
                var rf = new Date(d.from), rt = d.to ? new Date(d.to) : new Date();
                if (from && rt < from) { return false; }
                if (to && rf > to) { return false; }
                return true;
            }).sort(function (a, b) { return a.details.from < b.details.from ? 1 : -1; });
            renderHistory();
        }).catch(function (e) {
            showMsg('No se pudo leer el historial: ' + errText(e), 'error');
        }).then(function () { setBusy(false); });
    }

    function renderHistory() {
        $('#st-history').innerHTML = historyRows.map(function (r, i) {
            var d = r.details;
            return '<tr>' +
                '<td><strong>' + esc(d.shipmentNumber) + '</strong></td>' +
                '<td>' + esc(d.deviceName) + (d.licensePlate && d.licensePlate !== d.deviceName ? ' <span class="st-muted">' + esc(d.licensePlate) + '</span>' : '') + '</td>' +
                '<td>' + esc(fmtDate(d.from)) + '</td>' +
                '<td>' + (d.to ? esc(fmtDate(d.to)) : '<span class="st-badge">En curso</span>') + '</td>' +
                '<td>' + esc(fmtDuration(d.from, d.to)) + '</td>' +
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
        if (!d) { return; }
        var params = {
            devices: [d.deviceId],
            dateRange: {
                startDate: d.from,
                endDate: d.to || new Date().toISOString()
            }
        };
        if (state && state.gotoPage) {
            state.gotoPage('tripsHistory', params);
        }
    }

    function exportCsv() {
        if (!historyRows.length) { showMsg('No hay registros para exportar.', 'info'); return; }
        var cols = ['shipmentNumber', 'deviceName', 'licensePlate', 'from', 'to', 'assignedBy', 'closedBy', 'source'];
        var lines = [cols.join(';')].concat(historyRows.map(function (r) {
            return cols.map(function (c) {
                var v = r.details[c] === null || r.details[c] === undefined ? '' : String(r.details[c]);
                return '"' + v.replace(/"/g, '""') + '"';
            }).join(';');
        }));
        var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'shipments_' + new Date().toISOString().slice(0, 10) + '.csv';
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
        tbody.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && e.target.classList.contains('st-inline')) {
                var tr = e.target.closest('tr');
                assignMany([tr.getAttribute('data-id')], normalize(e.target.value));
            }
        });
        tbody.addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-act]');
            if (!btn) { return; }
            var tr = btn.closest('tr');
            var id = tr.getAttribute('data-id');
            var act = btn.getAttribute('data-act');
            var d = devices.filter(function (x) { return x.id === id; })[0];
            if (act === 'save') {
                var v = normalize(tr.querySelector('.st-inline').value);
                if (!v) {
                    showMsg('Para quitar el shipment usá "Finalizar".', 'info');
                    return;
                }
                assignMany([id], v);
            } else if (act === 'clear') {
                if (window.confirm('¿Finalizar el shipment ' + d.value + ' de ' + d.name + '?')) {
                    assignMany([id], '');
                }
            } else if (act === 'sync') {
                reconcile(id);
            } else if (act === 'hist') {
                $('#st-h-shipment').value = '';
                $('#st-h-device').value = d.name;
                $('#st-h-from').value = '';
                $('#st-h-to').value = '';
                switchTab('history');
                searchHistory();
            }
        });

        $('#st-bulk-assign').addEventListener('click', function () {
            assignMany(Object.keys(selected), normalize($('#st-bulk-value').value));
        });
        $('#st-bulk-clear').addEventListener('click', function () {
            var ids = Object.keys(selected);
            if (window.confirm('¿Finalizar el shipment de ' + ids.length + ' vehículo(s)?')) {
                assignMany(ids, '');
            }
        });

        $('#st-h-search').addEventListener('click', searchHistory);
        $('#st-h-shipment').addEventListener('keydown', function (e) { if (e.key === 'Enter') { searchHistory(); } });
        $('#st-h-device').addEventListener('keydown', function (e) { if (e.key === 'Enter') { searchHistory(); } });
        $('#st-h-export').addEventListener('click', exportCsv);
        $('#st-history').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-trip]');
            if (btn) { openTrips(parseInt(btn.getAttribute('data-trip'), 10)); }
        });
    }

    // ------------------------------------------------------------------
    // Ciclo de vida del add-in
    // ------------------------------------------------------------------
    var bound = false;

    return {
        initialize: function (freshApi, freshState, callback) {
            api = freshApi;
            state = freshState;
            root = document.getElementById('shipmentTracker');
            if (!bound) { bindEvents(); bound = true; }
            api.getSession(function (s) {
                session.userName = s && s.userName ? s.userName : '';
                callback();
            }, function () { callback(); });
        },
        focus: function (freshApi, freshState) {
            api = freshApi;
            state = freshState;
            reloadAll();
        },
        blur: function () {
            selected = {};
        },
        // Expuesto solo para pruebas
        _test: { normalize: normalize, validate: validate, applyValue: applyValue, CONFIG: CONFIG }
    };
};
