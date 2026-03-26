(function () {
    'use strict';

    // --- Config ---
    let FUEL_TYPE = 'euro95';

    // --- State ---
    let map, userLocation, stations = [], selectedStation = null;
    let userMarker, routeLayer, routeOutline, routeLabel;
    let stationMarkerMap = {};
    let radiusMinutes = 5;
    let fetchTimer = null;

    // --- DOM ---
    const loading      = document.getElementById('loading');
    const loadingBar   = document.getElementById('loading-bar-fill');
    const topBar       = document.getElementById('top-bar');
    const sliderBar    = document.getElementById('slider-bar');
    const sliderText   = document.getElementById('slider-text');
    const slider       = document.getElementById('radius-slider');
    const bottomCard   = document.getElementById('bottom-card');
    const cardStation  = document.getElementById('card-station');
    const cardBadge    = document.getElementById('card-badge');
    const cardName     = document.getElementById('card-name');
    const cardAddress  = document.getElementById('card-address');
    const cardPrice    = document.getElementById('card-price');
    const cardDistance  = document.getElementById('card-distance');
    const btnFlits     = document.getElementById('btn-flits');
    const btnGoogle    = document.getElementById('btn-google');
    const btnApple     = document.getElementById('btn-apple');

    // --- Loading steps ---
    function setLoadingStep(stepId, progress) {
        // Mark previous steps as done
        const steps = ['step-location', 'step-map', 'step-fuel', 'step-route'];
        const idx = steps.indexOf(stepId);
        steps.forEach((s, i) => {
            const el = document.getElementById(s);
            if (i < idx) {
                el.classList.remove('active');
                el.classList.add('done');
            } else if (i === idx) {
                el.classList.add('active');
                el.classList.remove('done');
            } else {
                el.classList.remove('active', 'done');
            }
        });
        loadingBar.style.width = progress + '%';
    }

    // --- Haversine ---
    function dist(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // --- Brandstofprijs ophalen ---
    function getPrice(station) {
        return (station.prices && station.prices[FUEL_TYPE]) || null;
    }

    // --- Minuten naar km (±48 km/h stedelijk) ---
    function minutesToKm(min) {
        return min * 0.8;
    }

    // --- Slider kleurovergang bijwerken ---
    function updateSliderTrack() {
        const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100;
        slider.style.background =
            `linear-gradient(to right, #007AFF ${pct}%, #E5E5EA ${pct}%)`;
    }

    // --- Slider hoogte responsive op schermformaat ---
    function resizeSlider() {
        const track = document.querySelector('.slider-track');
        if (!track) return;
        const trackHeight = track.clientHeight;
        slider.style.width = trackHeight + 'px';
    }

    // --- Polyline decoderen (Valhalla precision 6) ---
    function decodePolyline(encoded) {
        const factor = 1e6;
        const coords = [];
        let lat = 0, lng = 0, i = 0;
        while (i < encoded.length) {
            let shift = 0, result = 0, byte;
            do {
                byte = encoded.charCodeAt(i++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);
            shift = 0; result = 0;
            do {
                byte = encoded.charCodeAt(i++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            lng += (result & 1) ? ~(result >> 1) : (result >> 1);
            coords.push([lat / factor, lng / factor]);
        }
        return coords;
    }

    // --- Valhalla routing ---
    async function getRoute(from, to) {
        try {
            const params = {
                locations: [
                    { lat: from.lat, lon: from.lng },
                    { lat: to.lat,   lon: to.lng   }
                ],
                costing: 'auto',
                units: 'km'
            };
            const url = `https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(params))}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.trip && data.trip.legs && data.trip.legs.length > 0) {
                const leg = data.trip.legs[0];
                return {
                    coords:   decodePolyline(leg.shape),
                    duration: Math.round(data.trip.summary.time / 60),
                    distance: data.trip.summary.length
                };
            }
        } catch (e) {
            console.warn('Routing mislukt:', e);
        }
        return {
            coords:   [[from.lat, from.lng], [to.lat, to.lng]],
            duration: null,
            distance: dist(from.lat, from.lng, to.lat, to.lng)
        };
    }

    // --- Kaart initialiseren ---
    function initMap(lat, lng) {
        map = L.map('map', {
            center: [lat, lng],
            zoom: 13,
            zoomControl: false,
            attributionControl: false,
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            subdomains: 'abcd'
        }).addTo(map);

        const icon = L.divIcon({
            className: '',
            html: '<div class="user-dot"></div>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
        });
        userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    }

    // --- Markers ---
    function clearMarkers() {
        Object.values(stationMarkerMap).forEach(m => map.removeLayer(m));
        stationMarkerMap = {};
    }

    function renderMarkers(visibleStations) {
        clearMarkers();
        if (!visibleStations.length) return;

        const withPrice = visibleStations.filter(s => getPrice(s) !== null);
        const cheapestId = withPrice.length
            ? withPrice.reduce((a, b) => getPrice(a) < getPrice(b) ? a : b).id
            : null;

        visibleStations.forEach((station, i) => {
            const price = getPrice(station);
            const isSelected = selectedStation && station.id === selectedStation.id;

            let cls = 'station-pin';
            if (isSelected)              cls += ' selected';
            else if (station.id === cheapestId) cls += ' cheapest';

            const label = price !== null ? `€${price.toFixed(3)}` : '€---';

            const icon = L.divIcon({
                className: '',
                html: `<div class="${cls}" style="animation-delay:${i * 30}ms">${label}</div>`,
                iconSize: [72, 28],
                iconAnchor: [36, 14],
            });

            const marker = L.marker(
                [station.lat, station.lng],
                { icon }
            ).addTo(map).on('click', () => selectStation(station));

            stationMarkerMap[station.id] = marker;
        });
    }

    // --- Route tekenen ---
    async function drawRoute(station) {
        if (routeLayer)   { map.removeLayer(routeLayer);   routeLayer   = null; }
        if (routeOutline) { map.removeLayer(routeOutline); routeOutline = null; }
        if (routeLabel)   { map.removeLayer(routeLabel);   routeLabel   = null; }

        const to = { lat: station.lat, lng: station.lng };
        const route = await getRoute(userLocation, to);

        routeOutline = L.polyline(route.coords, {
            color: '#0055D4', weight: 8, opacity: 0.12,
            lineCap: 'round', lineJoin: 'round'
        }).addTo(map);

        routeLayer = L.polyline(route.coords, {
            color: '#007AFF', weight: 5, opacity: 0.9,
            lineCap: 'round', lineJoin: 'round'
        }).addTo(map);

        // Rijtijdlabel midden op de route
        if (route.duration) {
            const mid = route.coords[Math.floor(route.coords.length / 2)];
            routeLabel = L.marker(mid, {
                icon: L.divIcon({
                    className: '',
                    html: `<div class="route-label">${route.duration} min</div>`,
                    iconSize: [72, 26],
                    iconAnchor: [36, 13],
                }),
                interactive: false,
                zIndexOffset: 500,
            }).addTo(map);
        }

        // Ruimte voor slider rechts (70px) en bottom card
        map.fitBounds(
            L.latLngBounds([[userLocation.lat, userLocation.lng], [to.lat, to.lng]]),
            { paddingTopLeft: [20, 80], paddingBottomRight: [70, 280],
              maxZoom: 15, animate: true, duration: 0.6 }
        );

        if (route.duration) {
            cardDistance.textContent =
                `${route.duration} min · ${route.distance.toFixed(1)} km`;
        } else {
            cardDistance.textContent = `${route.distance.toFixed(1)} km`;
        }
    }

    // --- Station selecteren ---
    async function selectStation(station) {
        const isNewStation = !selectedStation || selectedStation.id !== station.id;
        selectedStation = station;
        const price = getPrice(station);
        const km = dist(
            userLocation.lat, userLocation.lng,
            station.lat, station.lng
        );

        // Fade-out card content during update
        if (isNewStation) cardStation.classList.add('updating');

        const sorted = stations
            .filter(s => getPrice(s) !== null)
            .sort((a, b) => getPrice(a) - getPrice(b));
        const rank = sorted.findIndex(s => s.id === station.id) + 1;

        // Kleine delay voor smooth transition
        await new Promise(r => setTimeout(r, isNewStation ? 150 : 0));

        if (rank === 1) {
            cardBadge.textContent = 'Goedkoopst';
            cardBadge.style.background = 'rgba(52,199,89,0.12)';
            cardBadge.style.color = '#248A3D';
        } else if (rank > 0) {
            cardBadge.textContent = `#${rank} goedkoopst`;
            cardBadge.style.background = 'rgba(0,122,255,0.1)';
            cardBadge.style.color = '#0055D4';
        } else {
            cardBadge.textContent = 'Geen prijs';
            cardBadge.style.background = 'rgba(0,0,0,0.06)';
            cardBadge.style.color = '#8E8E93';
        }

        cardName.textContent    = station.brand || station.city;
        cardAddress.textContent = station.address
            ? `${station.address}, ${station.city}` : station.city;

        if (price) {
            cardPrice.textContent = `€${price.toFixed(3)}`;
            cardPrice.classList.remove('no-price');
        } else {
            cardPrice.textContent = '€---';
            cardPrice.classList.add('no-price');
        }

        cardDistance.textContent = `${km.toFixed(1)} km`;

        const lat = station.lat;
        const lng = station.lng;
        btnFlits.href  = `flitsmeister://navigate?lat=${lat}&lon=${lng}`;
        btnGoogle.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
        btnApple.href  = `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d&t=m`;

        // Fade card back in
        cardStation.classList.remove('updating');

        renderMarkers(stations);
        if (isNewStation) await drawRoute(station);
    }

    // --- Brandstoftypes laden ---
    async function loadFuelTypes() {
        try {
            const resp  = await fetch('/api/fuel-types');
            const types = await resp.json();
            if (!types.length) return;

            const euro95 = types.find(
                t => t.code === 'euro95' ||
                     (t.name && t.name.toLowerCase().includes('euro 95'))
            );
            FUEL_TYPE = euro95 ? euro95.code : types[0].code;

            const selector = document.getElementById('fuel-selector');
            selector.innerHTML = types.map(t => `
                <button class="fuel-pill${t.code === FUEL_TYPE ? ' active' : ''}"
                        data-code="${t.code}">
                    ${t.name}
                </button>
            `).join('');

            selector.querySelectorAll('.fuel-pill').forEach(btn => {
                btn.addEventListener('click', () => {
                    FUEL_TYPE = btn.dataset.code;
                    selector.querySelectorAll('.fuel-pill')
                        .forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    const withPrice = stations.filter(s => getPrice(s) !== null);
                    if (withPrice.length) {
                        const cheapest = withPrice.reduce(
                            (a, b) => getPrice(a) < getPrice(b) ? a : b
                        );
                        selectStation(cheapest);
                    } else {
                        renderMarkers(stations);
                    }
                });
            });
        } catch (e) {
            console.error('Fout bij brandstoftypes:', e);
        }
    }

    // --- Stations ophalen en renderen ---
    async function fetchAndRender() {
        const radiusKm = minutesToKm(radiusMinutes);
        try {
            const resp = await fetch(
                `/api/stations?lat=${userLocation.lat}&lon=${userLocation.lng}&radius_km=${radiusKm}&fuel=${FUEL_TYPE}`
            );
            stations = await resp.json();
        } catch (e) {
            console.error('Fout bij ophalen stations:', e);
            return;
        }

        if (!stations.length) {
            clearMarkers();
            cardBadge.textContent   = 'Geen resultaten';
            cardName.textContent    = 'Geen stations gevonden';
            cardAddress.textContent = 'Vergroot de zoekradius';
            cardPrice.textContent   = '—';
            cardPrice.classList.add('no-price');
            cardDistance.textContent = '—';
            return;
        }

        renderMarkers(stations);

        // Selecteer goedkoopste met prijs, of anders dichtstbijzijnde
        const withPrice = stations.filter(s => getPrice(s) !== null);
        const best = withPrice.length
            ? withPrice.reduce((a, b) => getPrice(a) < getPrice(b) ? a : b)
            : stations[0];
        await selectStation(best);
    }

    // --- Slider ---
    slider.addEventListener('input', () => {
        radiusMinutes = parseInt(slider.value);
        sliderText.innerHTML = `${radiusMinutes}<small>min</small>`;
        updateSliderTrack();
        clearTimeout(fetchTimer);
        fetchTimer = setTimeout(fetchAndRender, 500);
    });

    // --- Show UI elements with stagger ---
    function showUI() {
        setTimeout(() => topBar.classList.add('visible'), 100);
        setTimeout(() => {
            sliderBar.classList.add('visible');
            setTimeout(resizeSlider, 50);
        }, 250);
        setTimeout(() => bottomCard.classList.add('visible'), 400);
    }

    // Resize slider on orientation/window change
    window.addEventListener('resize', resizeSlider);

    // --- Init ---
    async function init() {
        setLoadingStep('step-location', 10);

        userLocation = await new Promise((resolve) => {
            navigator.geolocation.getCurrentPosition(
                p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
                () => resolve({ lat: 52.3676, lng: 4.9041 }), // fallback Amsterdam
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });

        setLoadingStep('step-map', 30);
        initMap(userLocation.lat, userLocation.lng);

        setLoadingStep('step-fuel', 55);
        await loadFuelTypes();

        setLoadingStep('step-route', 80);
        await fetchAndRender();

        // Complete loading
        loadingBar.style.width = '100%';
        document.getElementById('step-route').classList.remove('active');
        document.getElementById('step-route').classList.add('done');

        await new Promise(r => setTimeout(r, 400));

        setTimeout(() => map.invalidateSize(), 100);
        loading.classList.add('done');
        updateSliderTrack();

        // Stagger UI elements in
        showUI();
    }

    init();
})();
