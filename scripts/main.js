/**
 * Shipment Tracker — página MyGeotab (base: yusen) · v3.1 (anular + borrar datos)
 *
 * Flujo principal POR SHIPMENT:
 *   1. Alta del shipment con sus contenedores (máximo configurable, 5 por defecto).
 *   2. Cada contenedor se asigna a un camión (un período en AddInData).
 *
 * Reglas:
 *   - Un camión lleva 1 contenedor; si pertenece al grupo "bitren", hasta 2.
 *   - Un contenedor está en un solo camión a la vez (reasignar = cerrar + abrir).
 *   - Un contenedor pertenece a un solo shipment abierto.
 *
 * Todo vive en AddInData (ver scripts/shared.js). No usa customProperties.
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

    var devices = [];            // [{ id, name, licensePlate, isBitren }]
    var assignments = [];        // registros contenedor→camión
    var shipments = [];          // registros de shipment
    var settingsRec = null;      // registro de configuración (o null)
    var settings = clone(S.DEFAULT_SETTINGS);
    var openMap = {};            // deviceId → [asignaciones abiertas]
    var rawRecords = [];         // todos los registros del add-in (para respaldo/borrado)
    var historyRows = [];
    var modal = null;            // { mode: 'new'|'shipment'|'settings', id, voidOpen }
    var busy = false;
    var isAdmin = false;         // perfil Administrador (GroupEverythingSecurityId)
    var adminChecked = false;
    var purge = { scope: 'all', until: '', user: '', keepSettings: true, confirm: '', backupDone: false };

    var ADMIN_SECURITY_ID = 'GroupEverythingSecurityId';
    var PURGE_WORD = 'BORRAR';
    var PURGE_CHUNK = 100;

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function $(sel) { return root.querySelector(sel); }
    function nowIso() { return new Date().toISOString(); }

    function call(method, params) {
        return new Promise(function (resolve, reject) { api.call(method, params, resolve, reject); });
    }

    function multiCall(calls) {
        if (!calls.length) { return Promise.resolve([]); }
        return new Promise(function (resolve, reject) { api.multiCall(calls, resolve, reject); });
    }

    function fail(text) { var e = new Error(text); e.userFacing = true; return Promise.reject(e); }

    function showMsg(text, kind) {
        var el = $('#st-msg');
        el.textContent = text;
        el.className = 'st-msg st-msg-' + (kind || 'info');
        el.hidden = false;
        clearTimeout(showMsg.t);
        if (kind !== 'error') { showMsg.t = setTimeout(function () { el.hidden = true; }, 6000); }
    }

    function setBusy(b) {
        busy = b;
        root.classList.toggle('is-busy', b);
        Array.prototype.forEach.call(root.querySelectorAll('button, input, select, textarea'), function (el) {
            el.disabled = b;
        });
        if (!b) { updatePurgeUi(); }
    }

    /** Ejecuta una operación con bloqueo de UI, mensaje y re-render. */
    function run(fn, okText) {
        if (busy) { return Promise.resolve(); }
        setBusy(true);
        return Promise.resolve().then(fn).then(function (res) {
            setBusy(false);
            renderAll();
            if (okText && res !== 'cancel') { showMsg(okText, 'ok'); }
            return res;
        }, function (e) {
            setBusy(false);
            // No se re-renderiza el modal para no perder lo que el usuario escribió
            renderShipments();
            renderVehicles();
            showMsg(S.errText(e), 'error');
        });
    }

    function deviceById(id) {
        for (var i = 0; i < devices.length; i++) { if (devices[i].id === id) { return devices[i]; } }
        return null;
    }

    function deviceLabel(d) {
        return d.name + (d.licensePlate && d.licensePlate !== d.name ? ' · ' + d.licensePlate : '');
    }

    function findDevice(text) {
        var t = String(text || '').trim().toLowerCase();
        if (!t) { return null; }
        for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            if (d.name.toLowerCase() === t || d.licensePlate.toLowerCase() === t || deviceLabel(d).toLowerCase() === t) { return d; }
        }
        return null;
    }

    function capacity(d) { return d.isBitren ? settings.containersPerBitren : settings.containersPerTruck; }

    function loadCount(deviceId) {
        return (openMap[deviceId] || []).reduce(function (n, r) { return n + S.containersOf(r).length; }, 0);
    }

    // ------------------------------------------------------------------
    // Datos
    // ------------------------------------------------------------------
    function loadRecords() {
        return call('Get', { typeName: 'AddInData', search: { addInId: S.ADDIN_ID } }).then(function (list) {
            list = list || [];
            rawRecords = list;
            assignments = list.filter(S.isAssignment);
            shipments = list.filter(function (r) { return r.details && r.details.type === S.SHIPMENT_TYPE; });
            settingsRec = list.filter(function (r) { return r.details && r.details.type === S.SETTINGS_TYPE; })[0] || null;
            settings = clone(S.DEFAULT_SETTINGS);
            if (settingsRec) {
                Object.keys(settings).forEach(function (k) {
                    if (settingsRec.details[k] !== undefined && settingsRec.details[k] !== null) { settings[k] = settingsRec.details[k]; }
                });
            }
            openMap = S.openByDevice(assignments);
        });
    }

    /** Ids del grupo bitren y de todos sus subgrupos. */
    function bitrenGroupIds(groups) {
        var byId = {}, ids = {};
        (groups || []).forEach(function (g) { byId[g.id] = g; });
        var target = String(settings.bitrenGroupName || '').trim().toLowerCase();
        function walk(g) {
            if (!g || ids[g.id]) { return; }
            ids[g.id] = true;
            (g.children || []).forEach(function (c) { walk(byId[c.id]); });
        }
        (groups || []).forEach(function (g) {
            if (target && String(g.name || '').trim().toLowerCase() === target) { walk(g); }
        });
        return ids;
    }

    function loadDevices() {
        var search = { fromDate: nowIso() };
        var gf = state && state.getGroupFilter ? state.getGroupFilter() : null;
        if (gf && gf.length) { search.groups = gf; }
        return Promise.all([
            call('Get', { typeName: 'Device', search: search }),
            call('Get', { typeName: 'Group' })
        ]).then(function (res) {
            var bitren = bitrenGroupIds(res[1]);
            devices = (res[0] || []).filter(function (d) {
                return !(d.groups || []).some(function (g) { return g.id === 'GroupTrailerId'; });
            }).map(function (d) {
                return {
                    id: d.id,
                    name: d.name || '',
                    licensePlate: d.licensePlate || '',
                    isBitren: (d.groups || []).some(function (g) { return bitren[g.id]; })
                };
            }).sort(function (a, b) { return a.name.localeCompare(b.name); });
            $('#st-device-list').innerHTML = devices.map(function (d) {
                return '<option value="' + esc(d.name) + '">' + esc((d.licensePlate !== d.name ? d.licensePlate + ' · ' : '') + (d.isBitren ? 'Bitren' : 'Simple')) + '</option>';
            }).join('');
        });
    }

    /** Administrador = perfil de seguridad "Administrador" de MyGeotab. Ante cualquier duda, no es admin. */
    function loadAdmin() {
        if (adminChecked || !session.userName) { return Promise.resolve(); }
        return call('Get', { typeName: 'User', search: { name: session.userName } }).then(function (list) {
            var u = list && list[0];
            isAdmin = !!(u && (u.securityGroups || []).some(function (g) { return g.id === ADMIN_SECURITY_ID; }));
            adminChecked = true;
        }, function () { isAdmin = false; });
    }

    function reloadAll() {
        setBusy(true);
        return Promise.all([loadRecords(), loadAdmin()])
            .then(loadDevices)   // después de settings: el nombre del grupo bitren es configurable
            .then(function () { renderAll(); })
            .catch(function (e) { showMsg('No se pudieron cargar los datos: ' + S.errText(e), 'error'); })
            .then(function () { setBusy(false); });
    }

    // ------------------------------------------------------------------
    // Consultas sobre el modelo
    // ------------------------------------------------------------------
    function shipmentById(id) {
        return shipments.filter(function (s) { return s.id === id; })[0] || null;
    }

    function isVoid(s) { return s && s.details.status === 'void'; }

    /** Cualquier shipment con ese número (incluye anulados). */
    function shipmentByNumber(num) {
        return shipments.filter(function (s) { return s.details.shipmentNumber === num; })[0] || null;
    }

    /** Shipment vigente (no anulado) con ese número: el número de un anulado se puede reutilizar. */
    function activeShipmentByNumber(num) {
        return shipments.filter(function (s) { return s.details.shipmentNumber === num && !isVoid(s); })[0] || null;
    }

    /** Asignaciones de un shipment: por shipmentId (v3.1+) o, en registros previos, por número. */
    function assignmentsOf(ship) {
        return assignments.filter(function (r) {
            if (r.details.shipmentId) { return r.details.shipmentId === ship.id; }
            return r.details.shipmentNumber === ship.details.shipmentNumber;
        });
    }

    function openAssignmentOfContainer(code) {
        return assignments.filter(function (r) { return S.isOpen(r) && S.containersOf(r).indexOf(code) >= 0; })[0] || null;
    }

    /** Estado de un contenedor dentro de su shipment. */
    function containerState(ship, code) {
        var mine = assignmentsOf(ship).filter(function (r) {
            return S.containersOf(r).indexOf(code) >= 0;
        });
        var open = mine.filter(S.isOpen)[0];
        if (open) { return { state: 'route', rec: open }; }
        if (mine.length) {
            mine.sort(function (a, b) { return a.details.to < b.details.to ? 1 : -1; });
            return { state: 'done', rec: mine[0] };
        }
        return { state: 'pending' };
    }

    function shipmentSummary(ship) {
        var cs = ship.details.containers || [];
        var route = 0, done = 0, trucks = {};
        cs.forEach(function (c) {
            var st = containerState(ship, c);
            if (st.state === 'route') { route++; trucks[st.rec.details.deviceName] = true; }
            if (st.state === 'done') { done++; }
        });
        return { total: cs.length, route: route, done: done, pending: cs.length - route - done, trucks: Object.keys(trucks) };
    }

    /** Contenedores ya usados por otro shipment abierto. */
    function containerOwners(codes, exceptShipId) {
        var out = [];
        shipments.forEach(function (s) {
            if (s.id === exceptShipId || s.details.status !== 'open') { return; }
            (s.details.containers || []).forEach(function (c) {
                if (codes.indexOf(c) >= 0) { out.push(c + ' (en ' + s.details.shipmentNumber + ')'); }
            });
        });
        return out;
    }

    function confirmIso(list) {
        var bad = S.invalidContainers(list);
        if (!bad.length) { return true; }
        return window.confirm(
            'Estos contenedores no cumplen el formato ISO 6346 (4 letras + 7 dígitos con dígito verificador):\n\n' +
            bad.join('\n') + '\n\n¿Guardar igual?'
        );
    }

    // ------------------------------------------------------------------
    // Escrituras
    // ------------------------------------------------------------------
    function baseEntity(rec, details) {
        var e = { addInId: S.ADDIN_ID, groups: (rec && rec.groups) || [{ id: 'GroupCompanyId' }], details: details };
        if (rec && rec.id) { e.id = rec.id; }
        return e;
    }

    function touched(details) {
        details.updatedAt = nowIso();
        details.updatedBy = session.userName;
        return details;
    }

    function newAssignment(device, ship, code) {
        var now = nowIso();
        return baseEntity(null, {
            type: S.RECORD_TYPE, version: 3, status: 'open',
            deviceId: device.id, deviceName: device.name, licensePlate: device.licensePlate,
            shipmentId: ship.id, shipmentNumber: ship.details.shipmentNumber, container: code, containers: [code],
            from: now, to: null,
            assignedBy: session.userName, closedBy: null,
            updatedAt: now, updatedBy: session.userName, source: 'addin'
        });
    }

    function closedAssignment(rec) {
        var d = clone(rec.details);
        d.to = nowIso();
        d.closedBy = session.userName;
        d.status = 'closed';
        return baseEntity(rec, touched(d));
    }

    function setCalls(entities) {
        return entities.map(function (e) { return ['Set', { typeName: 'AddInData', entity: e }]; });
    }

    // ---- Shipment ----
    function createShipment(num, codes) {
        return loadRecords().then(function () {
            var err = S.validateShipment(num);
            if (err) { return fail(err); }
            var existing = activeShipmentByNumber(num);
            if (existing) {
                return fail('El shipment ' + num + ' ya existe' + (existing.details.status === 'closed' ? ' (finalizado).' : '.'));
            }
            if (!codes.length) { return fail('Ingresá al menos un contenedor.'); }
            if (codes.length > settings.maxContainersPerShipment) {
                return fail('Un shipment admite hasta ' + settings.maxContainersPerShipment + ' contenedores (ingresaste ' + codes.length + ').');
            }
            var owners = containerOwners(codes, null);
            if (owners.length) { return fail('Contenedores ya registrados en otro shipment abierto: ' + owners.join(', ')); }
            if (!confirmIso(codes)) { return 'cancel'; }
            var now = nowIso();
            var ent = baseEntity(null, {
                type: S.SHIPMENT_TYPE, version: 3, status: 'open',
                shipmentNumber: num, containers: codes,
                createdAt: now, createdBy: session.userName,
                closedAt: null, closedBy: null,
                updatedAt: now, updatedBy: session.userName
            });
            return call('Add', { typeName: 'AddInData', entity: ent }).then(function (id) {
                ent.id = id;
                shipments.push(ent);
                return id;
            });
        });
    }

    function saveShipment(ship, changes) {
        var d = clone(ship.details);
        Object.keys(changes).forEach(function (k) { d[k] = changes[k]; });
        var ent = baseEntity(ship, touched(d));
        return call('Set', { typeName: 'AddInData', entity: ent }).then(function () {
            shipments = shipments.map(function (s) { return s.id === ent.id ? ent : s; });
            return ent;
        });
    }

    function addContainer(shipId, code) {
        return loadRecords().then(function () {
            var ship = shipmentById(shipId);
            if (!ship || ship.details.status !== 'open') { return fail('El shipment no está abierto.'); }
            var cs = ship.details.containers || [];
            if (!code) { return fail('Ingresá un contenedor.'); }
            if (cs.indexOf(code) >= 0) { return fail(code + ' ya está en este shipment.'); }
            if (cs.length >= settings.maxContainersPerShipment) {
                return fail('El shipment ya tiene el máximo de ' + settings.maxContainersPerShipment + ' contenedores.');
            }
            var owners = containerOwners([code], shipId);
            if (owners.length) { return fail('Contenedor ya registrado en otro shipment abierto: ' + owners.join(', ')); }
            if (!confirmIso([code])) { return 'cancel'; }
            return saveShipment(ship, { containers: cs.concat([code]) });
        });
    }

    function removeContainer(shipId, code) {
        return loadRecords().then(function () {
            var ship = shipmentById(shipId);
            if (!ship || ship.details.status !== 'open') { return fail('El shipment no está abierto.'); }
            if (containerState(ship, code).state === 'route') {
                return fail('Liberá el contenedor ' + code + ' antes de quitarlo.');
            }
            if (!window.confirm('¿Quitar ' + code + ' del shipment ' + ship.details.shipmentNumber + '?')) { return 'cancel'; }
            return saveShipment(ship, { containers: (ship.details.containers || []).filter(function (c) { return c !== code; }) });
        });
    }

    function assignContainer(shipId, code, deviceText) {
        var device = findDevice(deviceText);
        if (!device) { return fail('Elegí un camión de la lista (nombre o patente).'); }
        return loadRecords().then(function () {
            var ship = shipmentById(shipId);
            if (!ship || ship.details.status !== 'open') { return fail('El shipment no está abierto.'); }
            if ((ship.details.containers || []).indexOf(code) < 0) { return fail(code + ' no pertenece a este shipment.'); }

            var current = openAssignmentOfContainer(code);
            if (current && current.details.deviceId === device.id) { return 'cancel'; }

            var used = loadCount(device.id);
            var cap = capacity(device);
            if (used + 1 > cap) {
                return fail(device.name + ' ya lleva ' + used + '/' + cap + ' contenedor' + (cap === 1 ? '' : 'es') +
                    (device.isBitren ? ' (bitren).' : '. Solo los bitren llevan 2.'));
            }
            if (current && !window.confirm(code + ' está en ' + current.details.deviceName + '. ¿Pasarlo a ' + device.name + '?')) {
                return 'cancel';
            }
            var calls = [];
            if (current) { calls = setCalls([closedAssignment(current)]); }
            var ent = newAssignment(device, ship, code);
            calls.push(['Add', { typeName: 'AddInData', entity: ent }]);
            return multiCall(calls).then(loadRecords);
        });
    }

    function releaseRecords(recs) {
        if (!recs.length) { return Promise.resolve('cancel'); }
        return multiCall(setCalls(recs.map(closedAssignment))).then(loadRecords);
    }

    function releaseContainer(code) {
        return loadRecords().then(function () {
            var rec = openAssignmentOfContainer(code);
            if (!rec) { return 'cancel'; }
            if (!window.confirm('¿Liberar ' + code + ' de ' + rec.details.deviceName + '? (entregado / descargado)')) { return 'cancel'; }
            return releaseRecords([rec]);
        });
    }

    function finishShipment(shipId) {
        return loadRecords().then(function () {
            var ship = shipmentById(shipId);
            if (!ship || ship.details.status !== 'open') { return 'cancel'; }
            var open = assignmentsOf(ship).filter(S.isOpen);
            var txt = '¿Finalizar el shipment ' + ship.details.shipmentNumber + '?' +
                (open.length ? '\nSe liberarán ' + open.length + ' contenedor(es) que siguen en ruta.' : '');
            if (!window.confirm(txt)) { return 'cancel'; }
            var calls = setCalls(open.map(closedAssignment));
            var d = clone(ship.details);
            d.status = 'closed'; d.closedAt = nowIso(); d.closedBy = session.userName;
            calls = calls.concat(setCalls([baseEntity(ship, touched(d))]));
            return multiCall(calls).then(loadRecords);
        });
    }

    /**
     * Anular: el shipment queda con status 'void' + motivo. Sus asignaciones se marcan
     * como anuladas (y las que seguían en ruta se cierran). Nada se borra.
     */
    function voidShipment(shipId, reason) {
        reason = String(reason || '').trim();
        if (reason.length < 3) { return fail('Indicá el motivo de la anulación.'); }
        return loadRecords().then(function () {
            var ship = shipmentById(shipId);
            if (!ship || isVoid(ship)) { return 'cancel'; }
            var now = nowIso();
            var recs = assignmentsOf(ship).map(function (r) {
                var d = clone(r.details);
                if (!d.to) { d.to = now; d.closedBy = session.userName; }
                d.status = 'closed';
                d.voided = true;
                d.voidReason = reason;
                return baseEntity(r, touched(d));
            });
            var sd = clone(ship.details);
            sd.statusBeforeVoid = sd.status;
            sd.status = 'void';
            sd.voidedAt = now;
            sd.voidedBy = session.userName;
            sd.voidReason = reason;
            return multiCall(setCalls(recs.concat([baseEntity(ship, touched(sd))]))).then(loadRecords);
        });
    }

    function releaseDevice(deviceId) {
        return loadRecords().then(function () {
            var recs = openMap[deviceId] || [];
            var d = deviceById(deviceId);
            if (!recs.length) { return 'cancel'; }
            if (!window.confirm('¿Liberar toda la carga de ' + (d ? d.name : deviceId) + '?')) { return 'cancel'; }
            return releaseRecords(recs);
        });
    }

    function saveSettings(values) {
        var d = settingsRec ? clone(settingsRec.details) : { type: S.SETTINGS_TYPE, version: 3 };
        Object.keys(values).forEach(function (k) { d[k] = values[k]; });
        var ent = baseEntity(settingsRec, touched(d));
        var p = settingsRec ? call('Set', { typeName: 'AddInData', entity: ent }) : call('Add', { typeName: 'AddInData', entity: ent });
        return p.then(function () { return loadRecords(); }).then(loadDevices);
    }

    // ------------------------------------------------------------------
    // Render: shipments
    // ------------------------------------------------------------------
    function renderShipments() {
        var q = ($('#st-s-filter').value || '').trim().toUpperCase();
        var st = $('#st-s-status').value;
        var list = shipments.filter(function (s) {
            if (st !== 'all' && s.details.status !== st) { return false; }
            if (!q) { return true; }
            var sum = shipmentSummary(s);
            var hay = [s.details.shipmentNumber].concat(s.details.containers || [], sum.trucks).join(' ').toUpperCase();
            return hay.indexOf(q) >= 0;
        }).sort(function (a, b) { return a.details.createdAt < b.details.createdAt ? 1 : -1; });

        $('#st-shipments').innerHTML = list.map(function (s) {
            var sum = shipmentSummary(s);
            var closed = s.details.status !== 'open';
            var badge = isVoid(s) ? '<span class="st-badge st-badge-void" title="' + esc(s.details.voidReason) + '">Anulado</span>' :
                closed ? '<span class="st-badge st-badge-off">Finalizado</span>' :
                    (sum.pending ? '<span class="st-badge st-badge-warn">Pendiente</span>' : '<span class="st-badge">En curso</span>');
            var bar = sum.total ? Math.round((sum.route + sum.done) / sum.total * 100) : 0;
            return '<tr data-ship="' + esc(s.id) + '"' + (isVoid(s) ? ' class="is-void"' : '') + '>' +
                '<td><strong>' + esc(s.details.shipmentNumber) + '</strong></td>' +
                '<td><div class="st-progress" title="' + sum.route + ' en ruta · ' + sum.done + ' entregados · ' + sum.pending + ' pendientes">' +
                '<span style="width:' + bar + '%"></span></div>' +
                '<span class="st-muted">' + (sum.route + sum.done) + '/' + sum.total + ' asignados' + (sum.route ? ' · ' + sum.route + ' en ruta' : '') + '</span></td>' +
                '<td>' + (sum.trucks.length ? esc(sum.trucks.join(', ')) : '<span class="st-muted">—</span>') + '</td>' +
                '<td class="st-muted">' + esc(S.fmtDate(s.details.createdAt)) + '</td>' +
                '<td>' + badge + '</td>' +
                '<td class="st-col-actions"><button class="st-btn st-btn-sm" data-open-ship>' + (closed ? 'Ver' : 'Gestionar') + '</button></td>' +
                '</tr>';
        }).join('');
        $('#st-shipments-empty').hidden = list.length > 0;

        var orphans = assignments.filter(function (r) { return S.isOpen(r) && !shipmentByNumber(r.details.shipmentNumber); }).length;
        var openCount = shipments.filter(function (s) { return s.details.status === 'open'; }).length;
        $('#st-shipments-count').textContent = openCount + ' shipment(s) abiertos · límite ' + settings.maxContainersPerShipment + ' contenedores por shipment' +
            (orphans ? ' · ' + orphans + ' carga(s) de versiones anteriores sin shipment (liberar desde Vehículos)' : '');
    }

    // ------------------------------------------------------------------
    // Render: vehículos
    // ------------------------------------------------------------------
    function vehicleLoadHtml(deviceId) {
        var groups = S.groupByShipment(openMap[deviceId] || []);
        if (!groups.length) { return '<span class="st-muted">—</span>'; }
        return groups.map(function (g) {
            return '<span class="st-chip">' + esc(g.shipmentNumber) +
                (g.containers.length ? ' · <span class="st-mono">' + esc(g.containers.join(', ')) + '</span>' : '') + '</span>';
        }).join(' ');
    }

    function renderVehicles() {
        var q = ($('#st-filter').value || '').trim().toLowerCase();
        var st = $('#st-state-filter').value;
        var list = devices.filter(function (d) {
            var has = (openMap[d.id] || []).length > 0;
            if (st === 'with' && !has) { return false; }
            if (st === 'without' && has) { return false; }
            if (st === 'bitren' && !d.isBitren) { return false; }
            if (!q) { return true; }
            var hay = [d.name, d.licensePlate];
            (openMap[d.id] || []).forEach(function (r) { hay.push(r.details.shipmentNumber); hay = hay.concat(S.containersOf(r)); });
            return hay.join(' ').toLowerCase().indexOf(q) >= 0;
        });
        $('#st-devices').innerHTML = list.map(function (d) {
            var used = loadCount(d.id), cap = capacity(d);
            return '<tr data-id="' + esc(d.id) + '">' +
                '<td>' + esc(d.name) + '</td>' +
                '<td>' + esc(d.licensePlate) + '</td>' +
                '<td>' + (d.isBitren ? '<span class="st-tag">Bitren</span>' : '<span class="st-muted">Simple</span>') + '</td>' +
                '<td class="st-loads"><span class="st-cap' + (used >= cap ? ' is-full' : '') + '">' + used + '/' + cap + '</span> ' + vehicleLoadHtml(d.id) + '</td>' +
                '<td class="st-col-actions">' +
                ((openMap[d.id] || []).length ? '<button class="st-btn st-btn-sm st-btn-danger" data-act="release">Liberar carga</button>' : '') +
                '<button class="st-btn st-btn-sm st-btn-ghost" data-act="hist">Historial</button>' +
                '</td></tr>';
        }).join('');
        $('#st-devices-empty').hidden = list.length > 0;
        var withLoad = devices.filter(function (d) { return (openMap[d.id] || []).length; }).length;
        var bitrens = devices.filter(function (d) { return d.isBitren; }).length;
        $('#st-devices-count').textContent = list.length + ' de ' + devices.length + ' vehículos · ' + withLoad + ' con carga · ' + bitrens + ' bitren' +
            (bitrens ? '' : ' (no se encontró el grupo "' + settings.bitrenGroupName + '")');
    }

    // ------------------------------------------------------------------
    // Modal
    // ------------------------------------------------------------------
    function openModal(mode, id) {
        modal = { mode: mode, id: id || null };
        renderModal();
        $('#st-modal').hidden = false;
        var first = $('#st-modal-body').querySelector('input:not([disabled]), textarea');
        if (first) { first.focus(); }
    }

    function closeModal() {
        modal = null;
        purge.confirm = '';
        purge.backupDone = false;
        $('#st-modal').hidden = true;
        $('#st-modal-body').innerHTML = '';
    }

    function renderModal() {
        if (!modal) { return; }
        if (modal.mode === 'new') { return renderNewModal(); }
        if (modal.mode === 'settings') { return renderSettingsModal(); }
        return renderShipmentModal();
    }

    function renderNewModal() {
        $('#st-modal-title').textContent = 'Nuevo shipment';
        $('#st-modal-body').innerHTML =
            '<form class="st-form" data-form="new" autocomplete="off">' +
            '<label>Número de shipment<input name="ship" type="text" placeholder="Ej. SHP-0001" required></label>' +
            '<label>Contenedores <span class="st-muted">(hasta ' + settings.maxContainersPerShipment + '; uno por línea o separados por coma)</span>' +
            '<textarea name="containers" rows="5" placeholder="MSCU1234565&#10;TGHU7654321"></textarea></label>' +
            '<div class="st-form-actions"><button type="button" class="st-btn st-btn-ghost" data-close>Cancelar</button>' +
            '<button type="submit" class="st-btn">Crear y asignar camiones</button></div>' +
            '</form>';
    }

    function renderSettingsModal() {
        $('#st-modal-title').textContent = 'Configuración';
        $('#st-modal-body').innerHTML =
            '<form class="st-form" data-form="settings" autocomplete="off">' +
            '<label>Máximo de contenedores por shipment<input name="max" type="number" min="1" max="50" value="' + esc(settings.maxContainersPerShipment) + '" required></label>' +
            '<label>Grupo de Geotab para bitren <span class="st-muted">(sin distinguir mayúsculas; incluye subgrupos)</span>' +
            '<input name="group" type="text" value="' + esc(settings.bitrenGroupName) + '" required></label>' +
            '<div class="st-form-row">' +
            '<label>Contenedores por camión<input name="truck" type="number" min="1" max="5" value="' + esc(settings.containersPerTruck) + '" required></label>' +
            '<label>Contenedores por bitren<input name="bitren" type="number" min="1" max="5" value="' + esc(settings.containersPerBitren) + '" required></label>' +
            '</div>' +
            '<p class="st-muted st-note">El nuevo máximo aplica a altas y contenedores agregados desde ahora; no modifica shipments existentes.</p>' +
            '<div class="st-form-actions"><button type="button" class="st-btn st-btn-ghost" data-close>Cancelar</button>' +
            '<button type="submit" class="st-btn">Guardar</button></div>' +
            '</form>' +
            (isAdmin ? purgeSectionHtml() : '');
        if (isAdmin) { updatePurgeUi(); }
    }

    // ---- Borrar datos (solo administradores) ----
    function purgeSectionHtml() {
        return '<section class="st-danger-zone" data-purge>' +
            '<h3>Borrar datos <span class="st-tag st-tag-admin">Solo administradores</span></h3>' +
            '<p class="st-muted st-note">Elimina registros del add-in de forma definitiva. Para el uso diario, usá <b>Anular</b> en el shipment.</p>' +
            '<div class="st-purge-grid">' +
            '<label class="st-radio"><input type="radio" name="purge-scope" value="all"' + (purge.scope === 'all' ? ' checked' : '') + '> Todos los registros</label>' +
            '<label class="st-radio"><input type="radio" name="purge-scope" value="until"' + (purge.scope === 'until' ? ' checked' : '') + '> Creados hasta el ' +
            '<input type="date" data-purge-field="until" value="' + esc(purge.until) + '"></label>' +
            '<label>Solo creados por <span class="st-muted">(opcional, usuario exacto)</span>' +
            '<input type="text" data-purge-field="user" placeholder="usuario@dominio" value="' + esc(purge.user) + '"></label>' +
            '<label class="st-check-lbl"><input type="checkbox" data-purge-field="keepSettings"' + (purge.keepSettings ? ' checked' : '') + '> Conservar la configuración</label>' +
            '</div>' +
            '<p class="st-purge-preview" id="st-purge-preview"></p>' +
            '<div class="st-purge-steps">' +
            '<button type="button" class="st-btn st-btn-ghost" data-purge-backup>1. Descargar respaldo</button>' +
            '<input type="text" data-purge-field="confirm" placeholder="Escribí ' + PURGE_WORD + '" value="' + esc(purge.confirm) + '" autocomplete="off">' +
            '<button type="button" class="st-btn st-btn-danger-solid" data-purge-run>2. Borrar</button>' +
            '</div>' +
            '</section>';
    }

    function recordDate(r) {
        var d = r.details || {};
        if (d.type === S.SHIPMENT_TYPE) { return d.createdAt; }
        if (d.type === S.RECORD_TYPE) { return d.from; }
        return d.updatedAt || d.createdAt || d.from || null;
    }

    function recordUser(r) {
        var d = r.details || {};
        if (d.type === S.SHIPMENT_TYPE) { return d.createdBy; }
        if (d.type === S.RECORD_TYPE) { return d.assignedBy; }
        return d.updatedBy || d.createdBy || d.assignedBy || '';
    }

    /** Registros a borrar según el filtro. Si se borra un shipment, también sus asignaciones. */
    function purgeSelection() {
        var until = purge.scope === 'until' && purge.until ? new Date(purge.until + 'T23:59:59.999') : null;
        var user = String(purge.user || '').trim().toLowerCase();
        if (purge.scope === 'until' && !until) { return null; }
        var ids = {};
        rawRecords.forEach(function (r) {
            var type = r.details && r.details.type;
            if (type === S.SETTINGS_TYPE && purge.keepSettings) { return; }
            if (until) {
                var dt = recordDate(r);
                if (!dt || new Date(dt) > until) { return; }
            }
            if (user && String(recordUser(r) || '').toLowerCase() !== user) { return; }
            ids[r.id] = true;
        });
        shipments.forEach(function (s) {
            if (ids[s.id]) { assignmentsOf(s).forEach(function (a) { ids[a.id] = true; }); }
        });
        var sel = rawRecords.filter(function (r) { return ids[r.id]; });
        var count = { total: sel.length, shipments: 0, assignments: 0, other: 0 };
        sel.forEach(function (r) {
            var t = r.details && r.details.type;
            if (t === S.SHIPMENT_TYPE) { count.shipments++; } else if (t === S.RECORD_TYPE) { count.assignments++; } else { count.other++; }
        });
        return { records: sel, count: count };
    }

    function updatePurgeUi() {
        var box = root.querySelector('[data-purge]');
        if (!box) { return; }
        var sel = purgeSelection();
        var prev = box.querySelector('#st-purge-preview');
        if (!sel) {
            prev.textContent = 'Elegí la fecha límite.';
        } else {
            var c = sel.count;
            prev.textContent = c.total ?
                'Se borrarán ' + c.total + ' registro(s): ' + c.shipments + ' shipment(s), ' + c.assignments + ' asignación(es)' +
                (c.other ? ', ' + c.other + ' otro(s)' : '') + '.' :
                'No hay registros que coincidan.';
        }
        var ready = !!sel && sel.count.total > 0 && purge.backupDone && purge.confirm === PURGE_WORD;
        box.querySelector('[data-purge-run]').disabled = busy || !ready;
        box.querySelector('[data-purge-backup]').classList.toggle('is-done', purge.backupDone);
        box.querySelector('[data-purge-backup]').textContent = purge.backupDone ? '1. Respaldo descargado ✓' : '1. Descargar respaldo';
        box.querySelector('[data-purge-field=confirm]').disabled = busy || !purge.backupDone;
    }

    function downloadBackup() {
        var payload = {
            addInId: S.ADDIN_ID,
            exportedAt: nowIso(),
            exportedBy: session.userName,
            count: rawRecords.length,
            records: rawRecords
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'shipment-tracker-respaldo_' + nowIso().replace(/[:.]/g, '-').slice(0, 19) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    function purgeData() {
        if (!isAdmin) { return fail('Solo un administrador puede borrar datos.'); }
        if (purge.confirm !== PURGE_WORD || !purge.backupDone) { return fail('Descargá el respaldo y escribí ' + PURGE_WORD + ' para confirmar.'); }
        return loadRecords().then(function () {
            var sel = purgeSelection();
            if (!sel || !sel.count.total) { return 'cancel'; }
            var ids = sel.records.map(function (r) { return r.id; });
            var chunks = [];
            for (var i = 0; i < ids.length; i += PURGE_CHUNK) { chunks.push(ids.slice(i, i + PURGE_CHUNK)); }
            var removed = 0;
            return chunks.reduce(function (p, chunk) {
                return p.then(function () {
                    return multiCall(chunk.map(function (id) {
                        return ['Remove', { typeName: 'AddInData', entity: { id: id } }];
                    })).then(function () { removed += chunk.length; });
                });
            }, Promise.resolve()).then(function () {
                purge.confirm = '';
                purge.backupDone = false;
                return loadRecords().then(loadDevices).then(function () { return removed; });
            }, function (e) {
                return loadRecords().then(function () {
                    return fail('Se borraron ' + removed + ' de ' + ids.length + ' registros y luego falló: ' + S.errText(e));
                });
            });
        });
    }

    function renderShipmentModal() {
        var ship = shipmentById(modal.id);
        if (!ship) { closeModal(); return; }
        var d = ship.details;
        var voided = isVoid(ship);
        var closed = d.status !== 'open';
        var cs = d.containers || [];
        $('#st-modal-title').textContent = 'Shipment ' + d.shipmentNumber + (voided ? ' (anulado)' : '');

        var rows = cs.map(function (code) {
            var st = containerState(ship, code);
            var stateHtml, truckVal = '';
            if (voided) {
                stateHtml = st.rec ? '<span class="st-muted">' + esc(st.rec.details.deviceName) + ' · ' + esc(S.fmtDate(st.rec.details.from)) + ' → ' + esc(S.fmtDate(st.rec.details.to)) + '</span>' :
                    '<span class="st-muted">Sin camión</span>';
            } else if (st.state === 'route') {
                truckVal = st.rec.details.deviceName;
                stateHtml = '<span class="st-badge">En ruta</span> <span class="st-muted">desde ' + esc(S.fmtDate(st.rec.details.from)) + '</span>';
            } else if (st.state === 'done') {
                stateHtml = '<span class="st-badge st-badge-off">Entregado</span> <span class="st-muted">' + esc(st.rec.details.deviceName) + ' · ' + esc(S.fmtDate(st.rec.details.to)) + '</span>';
            } else {
                stateHtml = '<span class="st-badge st-badge-warn">Sin camión</span>';
            }
            var actions = '';
            if (!closed) {
                actions =
                    '<input class="st-truck" list="st-device-list" placeholder="Camión (nombre o patente)" value="' + esc(truckVal) + '">' +
                    '<button class="st-btn st-btn-sm" data-c="assign">' + (st.state === 'route' ? 'Cambiar' : 'Asignar') + '</button>' +
                    (st.state === 'route' ? '<button class="st-btn st-btn-sm st-btn-danger" data-c="release">Liberar</button>' :
                        '<button class="st-btn st-btn-sm st-btn-ghost" data-c="remove" title="Quitar del shipment">Quitar</button>');
            }
            return '<div class="st-crow" data-code="' + esc(code) + '">' +
                '<div class="st-crow-main"><span class="st-mono st-code">' + esc(code) + '</span>' + stateHtml + '</div>' +
                (actions ? '<div class="st-crow-actions">' + actions + '</div>' : '') +
                '</div>';
        }).join('');

        var canAdd = !closed && cs.length < settings.maxContainersPerShipment;
        var meta = 'Alta ' + esc(S.fmtDate(d.createdAt)) + ' por ' + esc(d.createdBy || '—') +
            (d.closedAt ? ' · Finalizado ' + esc(S.fmtDate(d.closedAt)) + ' por ' + esc(d.closedBy || '—') : '') +
            ' · ' + cs.length + '/' + settings.maxContainersPerShipment + ' contenedores';
        var voidInfo = voided ?
            '<div class="st-void-info"><strong>Anulado</strong> el ' + esc(S.fmtDate(d.voidedAt)) + ' por ' + esc(d.voidedBy || '—') +
            '<div>Motivo: ' + esc(d.voidReason) + '</div></div>' : '';
        var voidForm = (!voided && modal.voidOpen) ?
            '<form class="st-void-form" data-form="void" autocomplete="off">' +
            '<label>Motivo de la anulación<textarea name="reason" rows="2" placeholder="Ej. cargado por error, duplicado, prueba" required></textarea></label>' +
            '<p class="st-muted st-note">El shipment desaparece de las listas, del mapa y de las validaciones (el número y los contenedores quedan libres), pero se conserva en el historial.</p>' +
            '<div class="st-form-actions"><button type="button" class="st-btn st-btn-ghost" data-void-cancel>Volver</button>' +
            '<button type="submit" class="st-btn st-btn-danger-solid">Confirmar anulación</button></div>' +
            '</form>' : '';

        $('#st-modal-body').innerHTML =
            '<p class="st-muted st-note">' + meta + '</p>' + voidInfo +
            (rows || '<p class="st-empty">Sin contenedores.</p>') +
            (canAdd && !modal.voidOpen ? '<form class="st-add-row" data-form="add-container" autocomplete="off">' +
                '<input name="code" type="text" placeholder="Agregar contenedor (ej. MSCU1234565)">' +
                '<button type="submit" class="st-btn st-btn-sm st-btn-ghost">Agregar</button></form>' : '') +
            voidForm +
            (modal.voidOpen ? '' :
                '<div class="st-form-actions">' +
                '<button type="button" class="st-btn st-btn-ghost" data-hist="' + esc(d.shipmentNumber) + '">Ver historial</button>' +
                (voided ? '' : '<button type="button" class="st-btn st-btn-ghost st-btn-void" data-void-open>Anular</button>') +
                (closed ? '' : '<button type="button" class="st-btn st-btn-danger" data-finish>Finalizar shipment</button>') +
                '</div>');
        if (modal.voidOpen) {
            var ta = $('#st-modal-body').querySelector('textarea[name=reason]');
            if (ta) { ta.focus(); }
        }
    }

    // ------------------------------------------------------------------
    // Historial
    // ------------------------------------------------------------------
    function searchHistory() {
        var text = ($('#st-h-text').value || '').trim().toUpperCase();
        var dev = ($('#st-h-device').value || '').trim().toLowerCase();
        var from = $('#st-h-from').value ? new Date($('#st-h-from').value + 'T00:00:00') : null;
        var to = $('#st-h-to').value ? new Date($('#st-h-to').value + 'T23:59:59') : null;
        var voidMode = $('#st-h-void').value;   // exclude | include | only
        setBusy(true);
        loadRecords().then(function () {
            historyRows = assignments.filter(function (r) {
                var d = r.details;
                if (voidMode === 'exclude' && d.voided) { return false; }
                if (voidMode === 'only' && !d.voided) { return false; }
                if (text && [d.shipmentNumber].concat(S.containersOf(r)).join(' ').toUpperCase().indexOf(text) < 0) { return false; }
                if (dev && ((d.deviceName || '') + ' ' + (d.licensePlate || '')).toLowerCase().indexOf(dev) < 0) { return false; }
                var rf = new Date(d.from), rt = d.to ? new Date(d.to) : new Date();
                if (from && rt < from) { return false; }
                if (to && rf > to) { return false; }
                return true;
            }).sort(function (a, b) { return a.details.from < b.details.from ? 1 : -1; });
            renderHistory();
        }).catch(function (e) {
            showMsg('No se pudo leer el historial: ' + S.errText(e), 'error');
        }).then(function () { setBusy(false); renderAll(); });
    }

    function renderHistory() {
        $('#st-history').innerHTML = historyRows.map(function (r, i) {
            var d = r.details, c = S.containersOf(r);
            return '<tr' + (d.voided ? ' class="is-void"' : '') + '>' +
                '<td><strong>' + esc(d.shipmentNumber) + '</strong>' +
                (d.voided ? ' <span class="st-badge st-badge-void" title="' + esc(d.voidReason) + '">Anulado</span>' : '') + '</td>' +
                '<td class="st-mono">' + (c.length ? esc(c.join(', ')) : '<span class="st-muted">—</span>') + '</td>' +
                '<td>' + esc(d.deviceName) + (d.licensePlate && d.licensePlate !== d.deviceName ? ' <span class="st-muted">' + esc(d.licensePlate) + '</span>' : '') + '</td>' +
                '<td>' + esc(S.fmtDate(d.from)) + '</td>' +
                '<td>' + (d.to ? esc(S.fmtDate(d.to)) : '<span class="st-badge">En curso</span>') + '</td>' +
                '<td>' + esc(S.fmtDuration(d.from, d.to)) + '</td>' +
                '<td>' + esc(d.assignedBy) + '</td>' +
                '<td>' + esc(d.closedBy || '') + '</td>' +
                '<td class="st-col-actions"><button class="st-btn st-btn-sm st-btn-ghost" data-trip="' + i + '">Ver recorrido</button></td>' +
                '</tr>';
        }).join('');
        $('#st-history-empty').hidden = historyRows.length > 0;
        $('#st-history-count').textContent = historyRows.length ? historyRows.length + ' registro(s)' : '';
    }

    function goHistory(text, device, includeVoid) {
        $('#st-h-void').value = includeVoid ? 'include' : 'exclude';
        $('#st-h-text').value = text || '';
        $('#st-h-device').value = device || '';
        $('#st-h-from').value = '';
        $('#st-h-to').value = '';
        closeModal();
        switchTab('history');
        searchHistory();
    }

    function openTrips(idx) {
        var d = historyRows[idx] && historyRows[idx].details;
        if (!d || !state || !state.gotoPage) { return; }
        state.gotoPage('tripsHistory', { devices: [d.deviceId], dateRange: { startDate: d.from, endDate: d.to || nowIso() } });
    }

    function exportCsv() {
        if (!historyRows.length) { showMsg('No hay registros para exportar.', 'info'); return; }
        var cols = ['shipmentNumber', 'containers', 'deviceName', 'licensePlate', 'from', 'to', 'assignedBy', 'closedBy', 'voided', 'voidReason', 'updatedAt', 'updatedBy'];
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
    function renderAll() {
        renderShipments();
        renderVehicles();
        if (modal) { renderModal(); }
    }

    function switchTab(name) {
        Array.prototype.forEach.call(root.querySelectorAll('.st-tab'), function (t) {
            t.classList.toggle('is-active', t.getAttribute('data-tab') === name);
        });
        ['shipments', 'vehicles', 'history'].forEach(function (n) { $('#st-tab-' + n).hidden = n !== name; });
    }

    function bindEvents() {
        Array.prototype.forEach.call(root.querySelectorAll('.st-tab'), function (t) {
            t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
        });
        Array.prototype.forEach.call(root.querySelectorAll('.st-refresh'), function (b) {
            b.addEventListener('click', reloadAll);
        });

        // Shipments
        $('#st-s-filter').addEventListener('input', renderShipments);
        $('#st-s-status').addEventListener('change', renderShipments);
        $('#st-s-new').addEventListener('click', function () { openModal('new'); });
        $('#st-s-settings').addEventListener('click', function () { openModal('settings'); });
        $('#st-shipments').addEventListener('click', function (e) {
            var tr = e.target.closest('tr[data-ship]');
            if (tr && e.target.closest('[data-open-ship]')) { openModal('shipment', tr.getAttribute('data-ship')); }
        });

        // Vehículos
        $('#st-filter').addEventListener('input', renderVehicles);
        $('#st-state-filter').addEventListener('change', renderVehicles);
        $('#st-devices').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-act]');
            if (!btn) { return; }
            var id = btn.closest('tr').getAttribute('data-id');
            if (btn.getAttribute('data-act') === 'release') {
                run(function () { return releaseDevice(id); }, 'Carga liberada.');
            } else {
                goHistory('', deviceById(id).name);
            }
        });

        // Modal: clics
        $('#st-modal').addEventListener('click', function (e) {
            if (e.target.id === 'st-modal' || e.target.closest('[data-close]')) { closeModal(); return; }
            if (busy || !modal) { return; }
            var hist = e.target.closest('[data-hist]');
            if (hist) { goHistory(hist.getAttribute('data-hist'), '', isVoid(shipmentById(modal.id))); return; }
            if (e.target.closest('[data-void-open]')) { modal.voidOpen = true; renderModal(); return; }
            if (e.target.closest('[data-void-cancel]')) { modal.voidOpen = false; renderModal(); return; }
            if (e.target.closest('[data-purge-backup]')) {
                run(function () {
                    return loadRecords().then(function () {
                        downloadBackup();
                        purge.backupDone = true;
                        return 'cancel';
                    });
                });
                showMsg('Respaldo descargado. Escribí ' + PURGE_WORD + ' para habilitar el borrado.', 'info');
                return;
            }
            if (e.target.closest('[data-purge-run]')) {
                var c = (purgeSelection() || { count: { total: 0 } }).count.total;
                if (!window.confirm('Se borrarán ' + c + ' registro(s) de forma definitiva. ¿Continuar?')) { return; }
                run(function () { return purgeData(); }).then(function (n) {
                    if (typeof n === 'number') { showMsg(n + ' registro(s) borrados.', 'ok'); }
                });
                return;
            }
            if (e.target.closest('[data-finish]')) {
                var sid = modal.id;
                run(function () { return finishShipment(sid); }, 'Shipment finalizado.');
                return;
            }
            var btn = e.target.closest('button[data-c]');
            if (!btn) { return; }
            var row = btn.closest('.st-crow');
            var code = row.getAttribute('data-code');
            var act = btn.getAttribute('data-c');
            var shipId = modal.id;
            if (act === 'assign') {
                var txt = row.querySelector('.st-truck').value;
                run(function () { return assignContainer(shipId, code, txt); }, code + ' asignado.');
            } else if (act === 'release') {
                run(function () { return releaseContainer(code); }, code + ' liberado.');
            } else if (act === 'remove') {
                run(function () { return removeContainer(shipId, code); }, code + ' quitado del shipment.');
            }
        });
        $('#st-modal').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && e.target.classList.contains('st-truck')) {
                e.preventDefault();
                var b = e.target.closest('.st-crow').querySelector('[data-c=assign]');
                if (b) { b.click(); }
            }
        });

        // Modal: formularios
        $('#st-modal').addEventListener('submit', function (e) {
            e.preventDefault();
            var form = e.target;
            var kind = form.getAttribute('data-form');
            if (kind === 'new') {
                var num = S.normalizeShipment(form.ship.value);
                var codes = S.parseContainers(form.containers.value);
                run(function () {
                    return createShipment(num, codes).then(function (id) {
                        if (id && id !== 'cancel') { modal = { mode: 'shipment', id: id }; }
                        return id;
                    });
                }, 'Shipment ' + num + ' creado. Asigná cada contenedor a un camión.');
            } else if (kind === 'add-container') {
                var code = S.parseContainers(form.code.value)[0] || '';
                var shipId = modal.id;
                run(function () { return addContainer(shipId, code); }, code + ' agregado.');
            } else if (kind === 'void') {
                var reason = form.reason.value;
                var vid = modal.id;
                run(function () {
                    return voidShipment(vid, reason).then(function (r) {
                        if (r !== 'cancel' && modal) { modal.voidOpen = false; }
                        return r;
                    });
                }, 'Shipment anulado.');
            } else if (kind === 'settings') {
                var vals = {
                    maxContainersPerShipment: parseInt(form.max.value, 10),
                    bitrenGroupName: String(form.group.value || '').trim(),
                    containersPerTruck: parseInt(form.truck.value, 10),
                    containersPerBitren: parseInt(form.bitren.value, 10)
                };
                if (!(vals.maxContainersPerShipment >= 1) || !vals.bitrenGroupName || !(vals.containersPerTruck >= 1) || !(vals.containersPerBitren >= 1)) {
                    showMsg('Revisá los valores de configuración.', 'error');
                    return;
                }
                run(function () { return saveSettings(vals).then(closeModal); }, 'Configuración guardada.');
            }
        });

        // Borrar datos: campos del filtro
        function onPurgeInput(e) {
            var t = e.target;
            if (t.name === 'purge-scope') { purge.scope = t.value; }
            var f = t.getAttribute && t.getAttribute('data-purge-field');
            if (!f) { if (t.name !== 'purge-scope') { return; } }
            else if (f === 'keepSettings') { purge.keepSettings = t.checked; }
            else if (f === 'confirm') { purge.confirm = String(t.value || '').trim().toUpperCase(); }
            else { purge[f] = t.value; }
            if (f === 'until' && t.value) {
                purge.scope = 'until';
                var r = root.querySelector('input[name=purge-scope][value=until]');
                if (r) { r.checked = true; }
            }
            updatePurgeUi();
        }
        $('#st-modal').addEventListener('input', onPurgeInput);
        $('#st-modal').addEventListener('change', onPurgeInput);

        root.ownerDocument.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal) { closeModal(); }
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
            closeModal();
        }
    };
};
