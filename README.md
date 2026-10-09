# Shipment Tracker — Add-in MyGeotab (yusen) · v3

Trazabilidad de **shipments → contenedores → camiones**. Todo se guarda en **AddInData** (no usa `customProperties`).

## Flujo
1. **Shipments → + Nuevo shipment**: número + contenedores (máximo configurable, 5 por defecto).
2. En la gestión del shipment, cada contenedor se **asigna a un camión** (nombre o patente).
3. **Liberar** un contenedor = entregado/descargado. **Finalizar shipment** libera lo que siga en ruta y cierra el shipment.

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
| `shipment` | shipment | `shipmentNumber`, `containers[]`, `status` (open/closed), `createdAt/By`, `closedAt/By` |
| `shipmentAssignment` | contenedor en un camión (período) | `shipmentNumber`, `container`, `containers[]`, `deviceId`, `deviceName`, `licensePlate`, `from`, `to` (null = en ruta), `assignedBy`, `closedBy` |
| `settings` | base | `maxContainersPerShipment`, `bitrenGroupName`, `containersPerTruck`, `containersPerBitren` |

Todos llevan `updatedAt` / `updatedBy`. Los registros v1/v2 se siguen leyendo (en Vehículos se pueden liberar).

## Consulta por API (Python)
```python
recs = api.get("AddInData", search={"addInId": "ad4_hnI9SRnKRGHRvRl88fw"})
shipments = [r["details"] for r in recs if r["details"].get("type") == "shipment"]
en_ruta   = [r["details"] for r in recs
             if r["details"].get("type") == "shipmentAssignment" and not r["details"].get("to")]
```
El `whereClause` de AddInData exige `selectClause` y no admite AND/OR; el add-in trae todo y filtra en el cliente.

## Instalación
Pegar `dist/config-hosted.json` en *Administración → Sistema → Configuración del sistema → Add-Ins*. Regenerar con `python build.py [URL_BASE]`.

## Permisos
Lectura/escritura de datos de add-ins (Administrador, Supervisor, Usuario predeterminado). ViewOnly solo consulta.
