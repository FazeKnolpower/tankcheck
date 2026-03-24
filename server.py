import io
import math
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request, send_from_directory
import requests
from PIL import Image
import pytesseract

app = Flask(__name__)

TANKSERVICE_BASE = "https://tankservice.app-it-up.com/Tankservice/v2"
FETCH_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://directlease.nl/"}
STATIC_DIR = os.path.join(os.path.dirname(__file__), "tankprijs-app")
CACHE_TTL = 3600  # 1 uur

# In-memory cache
_stations_cache: dict = {}     # fuel_code -> {data, ts}
_price_cache: dict = {}        # station_id -> {prices, address, ts}

FUEL_TYPES = [
    {"code": "euro95",  "name": "Euro 95"},
    {"code": "diesel",  "name": "Diesel"},
    {"code": "super98", "name": "Super 98"},
    {"code": "lpg",     "name": "LPG"},
    {"code": "cng",     "name": "CNG"},
]

API_FUEL_MAP = {
    "euro95":  "fuel_euro95",
    "diesel":  "fuel_diesel",
    "super98": "fuel_super98",
    "lpg":     "fuel_lpg",
    "cng":     "fuel_cng",
}


# ===== HELPERS =====

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def get_all_stations(fuel_code="euro95"):
    now = time.time()
    api_fuel = API_FUEL_MAP.get(fuel_code, "fuel_euro95")
    cached = _stations_cache.get(fuel_code)
    if cached and now - cached["ts"] < CACHE_TTL:
        return cached["data"]
    try:
        r = requests.get(
            f"{TANKSERVICE_BASE}/places",
            params={"fmt": "web", "country": "NL", "fuel": api_fuel, "lang": "nl"},
            headers=FETCH_HEADERS,
            timeout=15,
        )
        data = r.json() if r.status_code == 200 else []
    except Exception:
        data = []
    _stations_cache[fuel_code] = {"data": data, "ts": now}
    return data


def parse_prices_from_ocr(text: str) -> dict:
    """Extract fuel prices and address from Tesseract OCR output."""
    result = {"prices": {}, "address": "", "postal_city": ""}
    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]

    for i, line in enumerate(lines):
        # First two non-empty lines = address
        if i == 0:
            result["address"] = line
        elif i == 1:
            result["postal_city"] = line

        # Normalize superscript digit (OCR reads ⁹ as °)
        norm = line.replace("°", "9")

        m = re.search(r"[€£]\s*([\d,.]+)", norm)
        if not m:
            continue

        raw = re.sub(r"[€£,.\s]", "", m.group(0))
        try:
            if len(raw) == 3:
                price = float(f"{raw[0]}.{raw[1:]}0")
            elif len(raw) == 4:
                price = float(f"{raw[0]}.{raw[1:]}")
            else:
                continue
        except ValueError:
            continue

        ll = line.lower()
        if "euro 95" in ll or "euro95" in ll or "e10" in ll:
            result["prices"]["euro95"] = price
        elif "euro 98" in ll or "euro98" in ll or "e5" in ll:
            result["prices"]["super98"] = price
        elif "premium diesel" in ll:
            result["prices"]["diesel_premium"] = price
        elif "diesel" in ll:
            result["prices"]["diesel"] = price
        elif "lpg" in ll:
            result["prices"]["lpg"] = price
        elif "cng" in ll:
            result["prices"]["cng"] = price

    return result


def fetch_station_prices(station_id: int) -> dict:
    """Fetch + OCR a station PNG. Results are cached for CACHE_TTL seconds."""
    now = time.time()
    cached = _price_cache.get(station_id)
    if cached and now - cached["ts"] < CACHE_TTL:
        return cached

    try:
        r = requests.get(
            f"{TANKSERVICE_BASE}/places/{station_id}.png?lang=nl",
            headers=FETCH_HEADERS,
            timeout=8,
        )
        if r.status_code != 200:
            return {}
        img = Image.open(io.BytesIO(r.content))
        text = pytesseract.image_to_string(img, lang="nld")
        parsed = parse_prices_from_ocr(text)
        parsed["ts"] = now
        _price_cache[station_id] = parsed
        return parsed
    except Exception:
        return {}


# ===== ROUTES =====

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/fuel-types")
def fuel_types():
    return jsonify(FUEL_TYPES)


@app.route("/api/stations")
def stations():
    try:
        user_lat = float(request.args.get("lat"))
        user_lon = float(request.args.get("lon"))
        radius_km = float(request.args.get("radius_km", 5))
        fuel_code = request.args.get("fuel", "euro95")
    except (TypeError, ValueError):
        return jsonify({"error": "Ongeldige parameters"}), 400

    all_stations = get_all_stations(fuel_code)

    # Filter op afstand
    nearby = [
        s for s in all_stations
        if haversine_km(user_lat, user_lon, s["lat"], s["lng"]) <= radius_km
    ]

    # Begrens tot 60 stations voor snelheid
    nearby.sort(key=lambda s: haversine_km(user_lat, user_lon, s["lat"], s["lng"]))
    nearby = nearby[:60]

    # Haal prijzen concurrent op via OCR
    def enrich(station):
        info = fetch_station_prices(station["id"])
        return {
            "id":       station["id"],
            "lat":      station["lat"],
            "lng":      station["lng"],
            "brand":    station.get("brand", "Onbekend"),
            "city":     station.get("city", ""),
            "address":  info.get("address", ""),
            "prices":   info.get("prices", {}),
        }

    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(enrich, nearby))

    # Stuur alleen stations terug die een prijs hebben voor het gekozen type
    results_with_price = [s for s in results if fuel_code in s["prices"]]

    return jsonify(results_with_price)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"TankCheck server draait op http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
