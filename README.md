# Shipment Tracker — Add-in MyGeotab (yusen)

Página de MyGeotab para asignar el `ShipmentNumber` de cada camión (custom property del Device) y guardar el historial de asignaciones en AddInData.

## Qué hace
- **Asignación**: lista de vehículos activos (respeta el filtro de grupos de MyGeotab y excluye remolques), edición en línea, asignación masiva y "Finalizar shipment".
- **Historial**: cada asignación es un período `{shipmentNumber, deviceId, from, to, assignedBy, closedBy}` en AddInData. Se puede buscar por shipment, patente o rango de fechas, abrir el recorrido del período en *Historial de viajes* y exportar a CSV.
- **Diferencias**: si alguien cambia el valor desde la ficha nativa del vehículo, la fila se marca "difiere del historial" y el botón **Sincronizar** alinea el historial.

## Datos
| Elemento | Valor |
|---|---|
| Property | `ShipmentNumber` · id `aihgC0czqFEiEw4cSMia9yg` |
| PropertySet | `aFyN7U4GoKUm0-RCuo5d98g` |
| AddInData addInId | `ad4_hnI9SRnKRGHRvRl88fw` (no cambiar una vez en producción) |
| Validación | `^[A-Za-z0-9\-/.]{1,50}$`, se guarda en mayúsculas |

## Instalación en MyGeotab
*Administración → Sistema → Configuración del sistema → Add-Ins → Nuevo add-in*, pegar uno de:
- `dist/config-hosted.json` si los archivos están publicados en GitHub Pages (editar la URL base con `python build.py <URL>`).
- `dist/config-embebido.json` para instalar todo dentro del JSON, sin hosting.

Aparece en el menú **Actividad → Shipment Tracker**.

## Permisos
El usuario necesita poder **editar vehículos** (Set Device) y **administrar datos de add-ins** (AddInData).

## Estructura
```
shipmentTracker.html   página
scripts/main.js        lógica (geotab.addin.shipmentTracker)
styles/main.css        estilos
images/icon.svg        ícono del menú
build.py               genera dist/
```
