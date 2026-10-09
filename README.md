# Shipment Tracker — Add-in MyGeotab (yusen) · v2

Registro de **shipments y contenedores por camión** con historial de trazabilidad. Todo se guarda en **AddInData**; no se usan `customProperties`.

## Componentes
| Ítem | Dónde aparece | Qué hace |
|---|---|---|
| Página `shipmentTracker.html` | Actividad → Shipment Tracker | Gestionar carga por vehículo (varios shipments, contenedores), asignación masiva, historial, CSV, "Ver recorrido" |
| Panel de mapa `map.html` | Mapa → pestaña **Cargas** | Lista de vehículos con carga (buscador, clic para centrar) y **tooltip** con shipments y contenedores al pasar sobre un vehículo |

## Modelo de datos (AddInData)
`addInId = ad4_hnI9SRnKRGHRvRl88fw` — un registro por **vehículo + shipment**:
```json
{
  "type": "shipmentAssignment", "version": 2, "status": "open",
  "deviceId": "b1E7", "deviceName": "AA285SH", "licensePlate": "AA285SH",
  "shipmentNumber": "SHP-001", "containers": ["MSCU1234565", "TGHU7654321"],
  "from": "2026-10-09T19:00:00Z", "to": null,
  "assignedBy": "usuario", "closedBy": null,
  "updatedAt": "2026-10-09T19:05:00Z", "updatedBy": "usuario", "source": "addin"
}
```
- `to = null` → carga vigente. Un vehículo puede tener varios registros abiertos.
- Agregar un shipment que el vehículo ya tiene abierto suma los contenedores al mismo registro.
- Contenedores: mayúsculas, sin duplicados; se valida ISO 6346 (si no cumple, se avisa y se puede guardar igual).
- Los registros v1 (sin `containers`/`status`) se leen igual.

## Consulta por API (Python)
```python
recs = api.get("AddInData", search={"addInId": "ad4_hnI9SRnKRGHRvRl88fw"})
abiertos = [r["details"] for r in recs
            if r["details"].get("type") == "shipmentAssignment" and not r["details"].get("to")]
```
El `whereClause` de AddInData exige `selectClause` y no admite AND/OR, por eso el add-in trae todo y filtra en el cliente.

## Instalación
Pegar `dist/config-hosted.json` en *Administración → Sistema → Configuración del sistema → Add-Ins* (reemplaza la config anterior). Regenerar con `python build.py [URL_BASE]`.

## Permisos
Los usuarios necesitan acceso de lectura/escritura a datos de add-ins (Administrador, Supervisor y Usuario predeterminado lo tienen; ViewOnly solo lectura). Ya no hace falta permiso para editar vehículos.

## Estructura
```
shipmentTracker.html  página          scripts/main.js   lógica de la página
map.html              panel de mapa   scripts/map.js    tooltip + panel
                                      scripts/shared.js modelo, validaciones, formato
styles/               estilos         translations/     (vacío, lo pide MyGeotab)
```
