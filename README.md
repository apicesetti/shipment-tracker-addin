# Shipment Tracker — Add-in MyGeotab (yusen) · v3.1

Trazabilidad de **shipments → contenedores → camiones**. Todo se guarda en **AddInData** (no usa `customProperties`).

## Flujo
1. **Shipments → + Nuevo shipment**: número + contenedores (máximo configurable, 5 por defecto).
2. En la gestión del shipment, cada contenedor se **asigna a un camión** (nombre o patente).
3. **Liberar** un contenedor = entregado/descargado. **Finalizar shipment** libera lo que siga en ruta y cierra el shipment.
4. **Anular** (cualquier usuario, con motivo obligatorio): el shipment sale de listas, mapa y validaciones —el número y los contenedores quedan libres— pero se conserva en el historial (filtro *Incluir / Solo anulados*). No borra nada.

## Borrar datos (solo administradores)
En **⚙ Configuración**, visible solo para usuarios con perfil **Administrador** de MyGeotab (`GroupEverythingSecurityId`):
1. Filtro: todos los registros, o creados hasta una fecha; opcionalmente solo los creados por un usuario. Borrar un shipment arrastra sus asignaciones.
2. **Descargar respaldo** (JSON con todos los registros del add-in) — obligatorio antes de cada borrado.
3. Escribir **BORRAR** y confirmar. Por defecto conserva la configuración. Solo toca registros de este `addInId`.

## Reglas
- Camión simple: 1 contenedor. Camión en el grupo de Geotab **"bitren"** (o subgrupos): 2.
- Un contenedor está en un solo camión a la vez (reasignar cierra el período anterior).
- Un contenedor pertenece a un solo shipment abierto; el número de shipment no se repite.
- Contenedores: validación ISO 6346 con aviso (se puede guardar igual).
- **⚙ Configuración**: máximo por shipment, nombre del grupo bitren, contenedores por camión/bitren.

## Componentes
| Ítem | Dónde | Qué hace |
|---|---|---|
| `shipmentTracker.html` | Actividad → Shipment Tracker | Pestañas Shipments · Vehículos · Historial |
| `map.html` | Mapa → pestaña **Cargas** | Panel con buscador y centrado + tooltip sobre cada vehículo |

## Modelo de datos (AddInData, `addInId = ad4_hnI9SRnKRGHRvRl88fw`)
| `details.type` | Uno por | Campos principales |
|---|---|---|
| `shipment` | shipment | `shipmentNumber`, `containers[]`, `status` (open/closed/void), `createdAt/By`, `closedAt/By`, `voidedAt/By`, `voidReason` |
| `shipmentAssignment` | contenedor en un camión (período) | `shipmentId`, `shipmentNumber`, `container`, `containers[]`, `deviceId`, `deviceName`, `licensePlate`, `from`, `to` (null = en ruta), `assignedBy`, `closedBy`, `voided`, `voidReason` |
| `settings` | base | `maxContainersPerShipment`, `bitrenGroupName`, `containersPerTruck`, `containersPerBitren` |

Todos llevan `updatedAt` / `updatedBy`. Los registros v1/v2 se siguen leyendo (en Vehículos se pueden liberar).

## Consulta por API (Python)
```python
recs = api.get("AddInData", search={"addInId": "ad4_hnI9SRnKRGHRvRl88fw"})
shipments = [r["details"] for r in recs if r["details"].get("type") == "shipment"]
en_ruta   = [r["details"] for r in recs
             if r["details"].get("type") == "shipmentAssignment" and not r["details"].get("to")]
vigentes  = [s for s in shipments if s.get("status") != "void"]   # excluir anulados
```
El `whereClause` de AddInData exige `selectClause` y no admite AND/OR; el add-in trae todo y filtra en el cliente.

## Instalación
Pegar `dist/config-hosted.json` en *Administración → Sistema → Configuración del sistema → Add-Ins*. Regenerar con `python build.py [URL_BASE]`.

## Permisos
Lectura/escritura de datos de add-ins (Administrador, Supervisor, Usuario predeterminado). ViewOnly solo consulta.
