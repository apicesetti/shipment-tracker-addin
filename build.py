"""Genera dist/config-hosted.json para pegar en MyGeotab (Administración → Add-Ins).

Incluye dos ítems:
  1. Página "Shipment Tracker" (Actividad → Shipment Tracker)
  2. Panel en la página Mapa ("Cargas") con tooltip sobre los vehículos

Uso: python build.py [URL_BASE_HOSTING]
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)

BASE_URL = (sys.argv[1] if len(sys.argv) > 1
            else "https://apicesetti.github.io/shipment-tracker-addin").rstrip("/")

config = {
    "name": "Shipment Tracker",
    "supportEmail": "soporte@cesetti.com.ar",
    "version": "3.0.0",
    "items": [
        {
            "url": BASE_URL + "/shipmentTracker.html",
            "path": "ActivityLink/",
            "menuName": {"es": "Shipment Tracker", "en": "Shipment Tracker"},
            "svgIcon": BASE_URL + "/images/icon.svg",
        },
        {
            "page": "map",
            "title": {"es": "Cargas", "en": "Loads"},
            "noView": False,
            "mapScript": {"url": BASE_URL + "/map.html"},
        },
    ],
}

out = DIST / "config-hosted.json"
out.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
print("OK ->", out)
