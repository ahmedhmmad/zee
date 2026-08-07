/*
 * Basemap abstraction.
 *
 * Two implementations behind one small interface, because the choice is
 * operational rather than technical:
 *
 *   Google — far better data for Libya. OpenStreetMap coverage there is thin
 *            and often out of date, and a basemap dispatchers do not recognise
 *            is worse than no basemap. Costs an API key and a billing account,
 *            and Google's terms forbid proxying their tiles, so each browser
 *            must reach Google directly.
 *
 *   OSM    — proxied through our own server, which is what makes it work from
 *            Libya at all. No key, no cost, no external dependency. Used
 *            whenever no Google key is configured.
 */

const TRIPOLI = { lat: 32.8872, lng: 13.1913 };

/** Generous bounds: Libya plus border regions, so cross-border trips work. */
const LIBYA_BOUNDS = { north: 35, south: 17, west: 7, east: 28 };

/** Dark styling, so the map sits inside the console rather than glaring out. */
const GOOGLE_DARK = [
  { elementType: 'geometry', stylers: [{ color: '#1b2429' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0f1417' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ba0ad' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#4b5f6a' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#93a7b2' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1d2f28' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c3a42' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#35464f' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4a5f6b' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#93a7b2' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#222d33' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#16303d' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4a6b7a' }] },
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

// --- Google ----------------------------------------------------------------

async function createGoogleMap(container, apiKey, onMarkerClick, theme) {
  // With loading=async the script resolves before the library is usable, so
  // wait on Google's own callback rather than the script's load event.
  const ready = new Promise((resolve) => {
    window.__gmapsReady = resolve;
  });

  // `language=ar` gives Arabic labels; `region=LY` biases place names and
  // borders to Libyan usage. `loading=async` is Google's recommended pattern
  // and avoids blocking the parser while the library downloads.
  await loadScript(
    `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      '&language=ar&region=LY&loading=async&callback=__gmapsReady',
  );
  await ready;

  const map = new google.maps.Map(container, {
    center: TRIPOLI,
    zoom: 11,
    minZoom: 5,
    restriction: { latLngBounds: LIBYA_BOUNDS, strictBounds: false },
    // null restores Google's own colours; the array applies our dark theme.
    styles: theme === 'light' ? null : GOOGLE_DARK,
    mapTypeControl: true,
    mapTypeControlOptions: {
      // Satellite is genuinely useful here: depot layouts, gates, tank
      // positions are all legible from imagery and absent from any vector map.
      mapTypeIds: ['roadmap', 'hybrid'],
    },
    streetViewControl: false,
    fullscreenControl: false,
  });

  const markers = new Map();
  const destinations = new Map();
  let trailLines = [];
  let routeLine = null;
  let directionsService = null;

  /**
   * google.maps.Marker is deprecated in favour of AdvancedMarkerElement, but
   * kept deliberately: AdvancedMarkerElement requires a cloud-configured Map
   * ID, and setting `mapId` makes Google ignore the inline `styles` above -
   * so the dark theme would have to be rebuilt in the Cloud console instead.
   * Google give at least 12 months notice before removal, so this is a
   * migration to make when there is a reason, not a fire.
   */
  /**
   * A moving vehicle gets an arrow pointing where it is going; a stationary one
   * gets a circle. Heading is meaningless at rest - the GPS reports whatever
   * direction it last happened to be facing - so showing an arrow then would
   * be inventing information.
   */
  const iconFor = (kind, heading, moving) => {
    const fillColor = kind === 'unlocked' ? '#d9483b' : kind === 'offline' ? '#55666f' : '#2f9e6e';
    return moving
      ? {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 5.5,
          rotation: heading ?? 0,
          fillColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 1.5,
        }
      : {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        };
  };

  return {
    provider: 'google',
    supportsTheme: true,
    setTheme(next) {
      map.setOptions({ styles: next === 'light' ? null : GOOGLE_DARK });
    },
    setMarker(id, lat, lon, { title, kind, heading, moving }) {
      let marker = markers.get(id);
      if (!marker) {
        marker = new google.maps.Marker({ map, position: { lat, lng: lon }, title });
        marker.addListener('click', () => onMarkerClick(id));
        markers.set(id, marker);
      } else {
        marker.setPosition({ lat, lng: lon });
        marker.setTitle(title);
      }
      marker.setIcon(iconFor(kind, heading, moving));
    },
    removeMarker(id) {
      const marker = markers.get(id);
      if (marker) {
        marker.setMap(null);
        markers.delete(id);
      }
    },

    /** Destination pin, its arrival radius, and a line from the vehicle. */
    setDestination(id, lat, lon, { radiusM, label, from }) {
      let d = destinations.get(id);
      if (!d) {
        d = {
          marker: new google.maps.Marker({
            map,
            position: { lat, lng: lon },
            title: label,
            icon: {
              path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
              scale: 5,
              fillColor: '#d9922b',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 1.5,
            },
            zIndex: 1,
          }),
          circle: new google.maps.Circle({
            map,
            center: { lat, lng: lon },
            radius: radiusM,
            strokeColor: '#d9922b',
            strokeOpacity: 0.8,
            strokeWeight: 1.5,
            fillColor: '#d9922b',
            fillOpacity: 0.12,
          }),
          line: new google.maps.Polyline({
            map,
            strokeColor: '#d9922b',
            strokeOpacity: 0,
            // Dashed, so it reads as "distance to go" rather than a route.
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 3 }, offset: '0', repeat: '12px' }],
          }),
        };
        destinations.set(id, d);
      }
      d.marker.setPosition({ lat, lng: lon });
      d.marker.setTitle(label);
      d.circle.setCenter({ lat, lng: lon });
      d.circle.setRadius(radiusM);
      d.line.setPath(from ? [{ lat: from.lat, lng: from.lon }, { lat, lng: lon }] : []);
    },
    clearDestinations() {
      for (const d of destinations.values()) {
        d.marker.setMap(null);
        d.circle.setMap(null);
        d.line.setMap(null);
      }
      destinations.clear();
    },

    /**
     * A real driving route from Google Directions, drawn solid blue so it
     * cannot be confused with the amber straight-line fallback. Returns the
     * path so the caller can cache it - Directions requests are billed, and
     * re-routing on every position report would add up fast.
     */
    async fetchRoute(from, to) {
      try {
        directionsService ??= new google.maps.DirectionsService();
        const res = await directionsService.route({
          origin: { lat: from.lat, lng: from.lon },
          destination: { lat: to.lat, lng: to.lon },
          travelMode: google.maps.TravelMode.DRIVING,
        });
        const path = res.routes?.[0]?.overview_path;
        return path?.length ? path.map((p) => ({ lat: p.lat(), lng: p.lng() })) : null;
      } catch (err) {
        // Most likely the Directions API is not enabled on this key. The
        // dashed straight line still works, so degrade quietly.
        console.info('[map] road route unavailable, using straight line', err?.code ?? err);
        return null;
      }
    },
    setRoutePath(path) {
      routeLine ??= new google.maps.Polyline({
        map,
        strokeColor: '#4a9eda',
        strokeOpacity: 0.9,
        strokeWeight: 4,
        zIndex: 2,
      });
      routeLine.setPath(path);
    },
    clearRoute() {
      routeLine?.setPath([]);
    },

    /**
     * Roads actually driven, from our own stored positions. Takes an array of
     * segments so separate journeys stay separate - joining the end of one
     * trip to the start of the next would draw a road nobody drove.
     */
    setTrail(segments) {
      for (const line of trailLines) line.setMap(null);
      trailLines = segments.map(
        (coords) =>
          new google.maps.Polyline({
            map,
            path: coords.map(([lat, lon]) => ({ lat, lng: lon })),
            strokeColor: '#57c795',
            strokeOpacity: 0.85,
            strokeWeight: 3,
            zIndex: 0,
          }),
      );
    },
    clearTrail() {
      for (const line of trailLines) line.setMap(null);
      trailLines = [];
    },
    flyTo(lat, lon, zoom = 15) {
      map.panTo({ lat, lng: lon });
      if (map.getZoom() < zoom) map.setZoom(zoom);
    },
    raw: map,
  };
}

// --- OpenStreetMap fallback ------------------------------------------------

function createOsmMap(container, onMarkerClick) {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          // Proxied through our own origin: OSM is not reliably reachable
          // from Libya, and the cache keeps the map alive if it goes down.
          tiles: [`${location.origin}/api/tiles/{z}/{x}/{y}.png`],
          tileSize: 256,
          attribution: '© OpenStreetMap',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [TRIPOLI.lng, TRIPOLI.lat],
    zoom: 11,
    minZoom: 5,
    maxZoom: 18,
    // Raster labels each country in its own language; staying inside Libya
    // keeps them Arabic.
    maxBounds: [
      [LIBYA_BOUNDS.west, LIBYA_BOUNDS.south],
      [LIBYA_BOUNDS.east, LIBYA_BOUNDS.north],
    ],
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  const markers = new Map();

  return {
    provider: 'osm',
    // Raster labels and colours are baked into the tile images, so there is
    // nothing to restyle. The toggle hides itself rather than doing nothing.
    supportsTheme: false,
    setTheme() {},
    setMarker(id, lat, lon, { title, kind, heading, moving }) {
      let marker = markers.get(id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'truck-marker';
        el.innerHTML = '<span class="truck-arrow">➤</span>';
        el.addEventListener('click', () => onMarkerClick(id));
        marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
        markers.set(id, marker);
      } else {
        marker.setLngLat([lon, lat]);
      }
      const el = marker.getElement();
      el.classList.toggle('unlocked', kind === 'unlocked');
      el.classList.toggle('offline', kind === 'offline');
      el.classList.toggle('moving', !!moving);
      el.title = title;
      // The glyph points east at rest, so subtract 90 to align with bearing.
      el.querySelector('.truck-arrow').style.transform = moving
        ? `rotate(${(heading ?? 0) - 90}deg)`
        : 'none';
    },

    /**
     * MapLibre has no circle geometry, so approximate one as a polygon. 64
     * points is indistinguishable from a circle at any zoom an operator uses.
     */
    setDestination(id, lat, lon, { radiusM, from }) {
      const ring = [];
      for (let i = 0; i <= 64; i++) {
        const angle = (i / 64) * 2 * Math.PI;
        const dLat = (radiusM * Math.cos(angle)) / 111320;
        const dLon = (radiusM * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
        ring.push([lon + dLon, lat + dLat]);
      }

      const data = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } },
          ...(from
            ? [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [[from.lon, from.lat], [lon, lat]] },
              }]
            : []),
        ],
      };

      if (map.getSource('destinations')) {
        map.getSource('destinations').setData(data);
        return;
      }
      map.addSource('destinations', { type: 'geojson', data });
      map.addLayer({
        id: 'destination-fill',
        type: 'fill',
        source: 'destinations',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#d9922b', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'destination-line',
        type: 'line',
        source: 'destinations',
        paint: { 'line-color': '#d9922b', 'line-width': 1.5, 'line-dasharray': [2, 2] },
      });
    },
    clearDestinations() {
      if (map.getSource('destinations')) {
        map.getSource('destinations').setData({ type: 'FeatureCollection', features: [] });
      }
    },
    async fetchRoute() {
      return null; // no routing without Google; dashed straight line remains
    },
    setRoutePath() {},
    clearRoute() {},
    setTrail(segments) {
      const data = {
        type: 'FeatureCollection',
        features: segments.length
          ? [{
              type: 'Feature',
              geometry: {
                type: 'MultiLineString',
                coordinates: segments.map((coords) => coords.map(([lat, lon]) => [lon, lat])),
              },
            }]
          : [],
      };
      if (map.getSource('trail')) {
        map.getSource('trail').setData(data);
        return;
      }
      map.addSource('trail', { type: 'geojson', data });
      map.addLayer({
        id: 'trail-line',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#57c795', 'line-width': 3, 'line-opacity': 0.85 },
      });
    },
    clearTrail() {
      map.getSource('trail')?.setData({ type: 'FeatureCollection', features: [] });
    },
    removeMarker(id) {
      const marker = markers.get(id);
      if (marker) {
        marker.remove();
        markers.delete(id);
      }
    },
    flyTo(lat, lon, zoom = 15) {
      map.flyTo({ center: [lon, lat], zoom, duration: 800 });
    },
    raw: map,
  };
}

/** Google when a key is configured, OpenStreetMap otherwise. */
export async function createMap(container, apiKey, onMarkerClick, theme = 'dark') {
  if (apiKey) {
    try {
      return await createGoogleMap(container, apiKey, onMarkerClick, theme);
    } catch (err) {
      // A billing problem or an unreachable Google should degrade to a working
      // map, not to a blank panel.
      console.error('[map] Google Maps failed, falling back to OpenStreetMap', err);
    }
  }
  return createOsmMap(container, onMarkerClick);
}
