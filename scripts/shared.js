/**
 * Shipment Tracker — utilidades compartidas entre la página y el add-in de mapa.
 *
 * Modelo (AddInData, addInId fijo):
 *   details = {
 *     type: 'shipmentAssignment', version: 2,
 *     deviceId, deviceName, licensePlate,
 *     shipmentNumber, containers: [..],
 *     from, to,                       // to === null → carga vigente
 *     assignedBy, closedBy, updatedAt, updatedBy, source
 *   }
 * Un vehículo puede tener varios registros abiertos (uno por shipment).
 * Los registros v1 (sin containers) se leen igual.
 */
(function (root) {
    'use strict';

    var ADDIN_ID = 'ad4_hnI9SRnKRGHRvRl88fw';
    var RECORD_TYPE = 'shipmentAssignment';

    // ISO 6346: valores de letras (se saltean múltiplos de 11)
    var LETTER_VALUES = (function () {
        var map = {}, v = 10;
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function (ch) {
            if (v % 11 === 0) { v++; }
            map[ch] = v++;
        });
        return map;
    }());

    function iso6346Valid(code) {
        if (!/^[A-Z]{3}[UJZR][0-9]{7}$/.test(code)) { return false; }
        var sum = 0;
        for (var i = 0; i < 10; i++) {
            var ch = code.charAt(i);
            var val = i < 4 ? LETTER_VALUES[ch] : parseInt(ch, 10);
            sum += val * Math.pow(2, i);
        }
        return (sum % 11) % 10 === parseInt(code.charAt(10), 10);
    }

    function normalizeShipment(v) {
        return String(v || '').trim().toUpperCase();
    }

    function validateShipment(v) {
        if (!v) { return 'Ingresá un número de shipment.'; }
        if (!/^[A-Z0-9\-\/\.]{1,50}$/.test(v)) {
            return 'Shipment inválido: solo letras, números, "-", "/" o "." (máx. 50).';
        }
        return null;
    }

    /** Texto libre → lista de contenedores en mayúsculas, sin espacios ni duplicados. */
    function parseContainers(text) {
        var seen = {}, out = [];
        String(text || '').toUpperCase().split(/[\s,;]+/).forEach(function (c) {
            c = c.replace(/[^A-Z0-9]/g, '');
            if (c && !seen[c]) { seen[c] = true; out.push(c); }
        });
        return out;
    }

    function invalidContainers(list) {
        return (list || []).filter(function (c) { return !iso6346Valid(c); });
    }

    function containersOf(rec) {
        var c = rec && rec.details && rec.details.containers;
        return Array.isArray(c) ? c : [];
    }

    function isAssignment(rec) {
        return !!(rec && rec.details && rec.details.type === RECORD_TYPE);
    }

    function isOpen(rec) {
        return isAssignment(rec) && !rec.details.to;
    }

    /** deviceId → [registros abiertos], ordenados por inicio. */
    function openByDevice(records) {
        var map = {};
        (records || []).forEach(function (r) {
            if (!isOpen(r)) { return; }
            (map[r.details.deviceId] = map[r.details.deviceId] || []).push(r);
        });
        Object.keys(map).forEach(function (k) {
            map[k].sort(function (a, b) { return a.details.from < b.details.from ? -1 : 1; });
        });
        return map;
    }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtDate(iso) {
        if (!iso) { return ''; }
        var d = new Date(iso);
        if (isNaN(d)) { return ''; }
        return d.toLocaleString('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    function fmtDuration(fromIso, toIso) {
        if (!fromIso) { return ''; }
        var ms = (toIso ? new Date(toIso) : new Date()) - new Date(fromIso);
        if (ms < 0 || isNaN(ms)) { return ''; }
        var min = Math.floor(ms / 60000);
        var d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
        return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
    }

    function errText(e) {
        if (!e) { return 'Error desconocido'; }
        if (typeof e === 'string') { return e; }
        return e.message || e.name || JSON.stringify(e);
    }

    root.ShipmentTrackerShared = {
        ADDIN_ID: ADDIN_ID,
        RECORD_TYPE: RECORD_TYPE,
        iso6346Valid: iso6346Valid,
        normalizeShipment: normalizeShipment,
        validateShipment: validateShipment,
        parseContainers: parseContainers,
        invalidContainers: invalidContainers,
        containersOf: containersOf,
        isAssignment: isAssignment,
        isOpen: isOpen,
        openByDevice: openByDevice,
        esc: esc,
        fmtDate: fmtDate,
        fmtDuration: fmtDuration,
        errText: errText
    };
}(window));
