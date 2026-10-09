"""Genera las dos configuraciones del add-in Shipment Tracker.

  dist/config-embebido.json : todo el código dentro del JSON (no requiere hosting).
  dist/config-hosted.json   : apunta a los archivos publicados (GitHub Pages).

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

META = {
    "name": "Shipment Tracker",
    "supportEmail": "soporte@cesetti.com.ar",
    "version": "1.0.1",
}
MENU = {"es": "Shipment Tracker", "en": "Shipment Tracker"}
PATH = "ActivityLink/"

html = (ROOT / "shipmentTracker.html").read_text(encoding="utf-8")
css = (ROOT / "styles" / "main.css").read_text(encoding="utf-8")
js = (ROOT / "scripts" / "main.js").read_text(encoding="utf-8")

# --- Embebido: CSS y JS en línea dentro de un único HTML ---
inline = (html
          .replace('<link rel="stylesheet" href="styles/main.css">', "<style>\n" + css + "\n</style>")
          .replace('<script src="scripts/main.js"></script>', "<script>\n" + js + "\n</script>"))
assert "<style>" in inline and "geotab.addin.shipmentTracker" in inline, "falló el inline"

embedded = dict(META)
embedded["items"] = [{"url": "shipmentTracker.html", "path": PATH, "menuName": MENU}]
embedded["files"] = {"shipmentTracker.html": inline}
(DIST / "config-embebido.json").write_text(json.dumps(embedded, ensure_ascii=False, indent=2), encoding="utf-8")
(DIST / "shipmentTracker-standalone.html").write_text(inline, encoding="utf-8")

# --- Hosted ---
hosted = dict(META)
hosted["items"] = [{
    "url": BASE_URL + "/shipmentTracker.html",
    "path": PATH,
    "menuName": MENU,
    "svgIcon": BASE_URL + "/images/icon.svg",
}]
(DIST / "config-hosted.json").write_text(json.dumps(hosted, ensure_ascii=False, indent=2), encoding="utf-8")

print("OK ->", ", ".join(p.name for p in sorted(DIST.iterdir())))
