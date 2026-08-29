/*
 * The map: MapLibre over OpenStreetMap, proxied through our own server.
 *
 * One basemap and one library, which is the same arrangement the partner
 * platform draws its stations and shipments on. An operator moving between the
 * two systems sees one map behaving one way, and code that places a marker
 * here places it there.
 *
 * Proxied rather than fetched from the tile host directly, because tile hosts
 * are not reliably reachable from Libya and the server-side cache keeps the
 * map alive while an upstream is down. No key, no billing account, no external
 * dependency in the browser.
 *
 * This replaced three implementations behind one interface — Google, the ArcGIS
 * SDK and this one — with a picker to choose between them. The tile proxy still
 * carries an Esri provider (src/api/tiles.ts) and its axis-order test, so
 * satellite imagery is one entry in RASTER_BASEMAPS away should anyone want it
 * back; nothing server-side would have to return with it.
 *
 * The ArcGIS key that remains is not a basemap. It buys one thing: the road
 * route drawn to an arrival point, from Esri's routing service. See
 * fetchEsriRoute.
 */

const TRIPOLI = { lat: 32.8872, lng: 13.1913 };

/** Generous bounds: Libya plus border regions, so cross-border trips work. */
const LIBYA_BOUNDS = { north: 35, south: 17, west: 7, east: 28 };

/**
 * A stable colour per ride.
 *
 * Hashed from the arrival's id rather than drawn at random each time, so a
 * route keeps its colour across refreshes and basemap switches - a line that
 * changed colour on every redraw would suggest something about the ride had
 * changed. Hue only: saturation and lightness are fixed so every ride stays
 * legible over both satellite imagery and a pale street map, which random RGB
 * does not guarantee.
 */
export function rideColour(seed) {
  const text = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 70%, 55%)`;
}

/**
 * Road route between two points, from Esri's World Route service.
 *
 * Used only when the client's ArcGIS key is configured. Google's Directions
 * results may only be drawn on a Google map, so their route cannot be reused
 * here - and this is the client's own licensed service, which is the reason to
 * prefer it over a third party.
 *
 * Consumes ArcGIS credits per request, so callers run it once when a
 * destination is set rather than on every position update.
 *
 * Returns [[lon, lat], ...] or null. The caller keeps the straight line it has
 * already drawn if this fails: a missing route must not take the destination
 * off the map with it.
 */
async function fetchEsriRoute(apiKey, from, to) {
  const url = new URL(
    'https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve',
  );
  url.searchParams.set('f', 'json');
  url.searchParams.set('token', apiKey);
  url.searchParams.set('stops', `${from.lon},${from.lat};${to.lon},${to.lat}`);
  url.searchParams.set('returnRoutes', 'true');
  url.searchParams.set('returnDirections', 'false');
  url.searchParams.set('outSR', '4326');

  const res = await fetch(url);
  const json = await res.json();
  // Esri answers 200 with an error object rather than an HTTP error status, so
  // res.ok alone would report success on a rejected key.
  if (json?.error) throw new Error(json.error.message ?? 'esri route failed');
  return json?.routes?.features?.[0]?.geometry?.paths?.[0] ?? null;
}

// --- The basemap -----------------------------------------------------------

/**
 * Kept as a table of one rather than inlined.
 *
 * A basemap is a tile list, a label and an attribution, and the loop below
 * already draws however many layers a spec names. Adding imagery back — which
 * needs two layers, since Esri's has no names baked into it — is an entry
 * here, not a change to the map.
 */
const RASTER_BASEMAPS = {
  osm: {
    label: 'خريطة الشوارع',
    tiles: ['osm'],
    attribution: '© OpenStreetMap',
  },
};

function createOsmMap(container, onMarkerClick, arcgisKey = '') {
  const spec = RASTER_BASEMAPS.osm;
  const sources = {};
  const layers = [];
  for (const id of spec.tiles) {
    sources[id] = {
      type: 'raster',
      tiles: [`${location.origin}/api/tiles/${id}/{z}/{x}/{y}.png`],
      tileSize: 256,
      attribution: spec.attribution,
    };
    layers.push({ id, type: 'raster', source: id });
  }

  // MapLibre defaults to 16 tile fetches in flight, which assumes a CDN that
  // answers immediately. Ours is a proxy that may be fetching from Esri on a
  // cache miss, so those requests sit open for hundreds of milliseconds each
  // and, across two layers, pile up until Chrome refuses new connections with
  // ERR_INSUFFICIENT_RESOURCES and the map comes up half-drawn. Fewer in
  // flight is slower on a cold cache and reliable instead of failing.
  if (maplibregl.config) maplibregl.config.MAX_PARALLEL_IMAGE_REQUESTS = 8;

  const map = new maplibregl.Map({
    container,
    style: { version: 8, sources, layers },
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

  /** ride id -> its GeoJSON features (geofence ring, and the path to it). */
  const destinations = new Map();

  /**
   * Redraw every armed ride from one source.
   *
   * Colour comes from each feature's own `colour` property rather than from
   * the layer, which is what allows one source and one pair of layers to draw
   * any number of rides in different colours.
   */
  function renderDestinations() {
    const data = {
      type: 'FeatureCollection',
      features: [...destinations.values()].flat(),
    };

    const apply = () => {
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
        paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'destination-ring',
        type: 'line',
        source: 'destinations',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'line-color': ['get', 'colour'],
          'line-width': 1.5,
          'line-dasharray': [2, 2],
        },
      });
      // The path to the destination, drawn solid and heavier than the
      // geofence outline so the two do not read as the same thing.
      map.addLayer({
        id: 'destination-route',
        type: 'line',
        source: 'destinations',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'colour'], 'line-width': 3.5, 'line-opacity': 0.85 },
      });
    };

    // Sources cannot be added before the style has loaded.
    map.isStyleLoaded() ? apply() : map.once('load', apply);
  }

  return {
    provider: 'osm',
    // Raster labels and colours are baked into the tile images, so there is
    // nothing to restyle. The toggle hides itself rather than doing nothing.
    supportsTheme: false,
    setTheme() {},
    setTrack(coords) {
      const data = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: (coords ?? []).map((c) => [c.longitude, c.latitude]),
        },
      };
      const apply = () => {
        if (map.getSource('track')) {
          map.getSource('track').setData(data);
          return;
        }
        map.addSource('track', { type: 'geojson', data });
        map.addLayer({
          id: 'track',
          type: 'line',
          source: 'track',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2f9e6e', 'line-width': 4, 'line-opacity': 0.9 },
        });
      };
      // Sources cannot be added before the style has loaded.
      map.isStyleLoaded() ? apply() : map.once('load', apply);
    },
    setMarker(id, lat, lon, { title, label, kind, heading, moving, freshness }) {
      let marker = markers.get(id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'truck-marker';
        // The label is a sibling of the glyph so rotating the arrow does not
        // rotate the text with it.
        el.innerHTML = '<span class="truck-arrow">➤</span><span class="truck-label"></span>';
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
      el.classList.toggle('aging', freshness === 'aging');
      el.classList.toggle('stale', freshness === 'stale');
      el.title = title;
      el.querySelector('.truck-label').textContent = label ?? '';
      // The glyph points east at rest, so subtract 90 to align with bearing.
      el.querySelector('.truck-arrow').style.transform = moving
        ? `rotate(${(heading ?? 0) - 90}deg)`
        : 'none';
    },

    /**
     * MapLibre has no circle geometry, so approximate one as a polygon. 64
     * points is indistinguishable from a circle at any zoom an operator uses.
     */
    /**
     * A ride's destination: the geofence it will unlock inside, and the path
     * to it from where the vehicle is now.
     *
     * Rides accumulate rather than replace. Each call used to overwrite the
     * whole source, so with two arrivals armed only the last one was ever
     * drawn. Each ride now keeps its own colour, which is what makes several
     * on screen at once readable.
     */
    setDestination(id, lat, lon, { radiusM = 100, from } = {}) {
      const colour = rideColour(id);

      const ring = [];
      for (let i = 0; i <= 64; i++) {
        const angle = (i / 64) * 2 * Math.PI;
        const dLat = (radiusM * Math.cos(angle)) / 111320;
        const dLon = (radiusM * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
        ring.push([lon + dLon, lat + dLat]);
      }

      const features = [
        {
          type: 'Feature',
          properties: { colour },
          geometry: { type: 'Polygon', coordinates: [ring] },
        },
      ];
      if (from) {
        features.push({
          type: 'Feature',
          properties: { colour },
          geometry: { type: 'LineString', coordinates: [[from.lon, from.lat], [lon, lat]] },
        });
      }
      destinations.set(id, features);
      renderDestinations();

      // Upgrade the straight line to a real road route when the client's Esri
      // licence is configured. Deliberately not awaited: the straight line is
      // already drawn and is a correct answer on its own, so if routing fails
      // - no routing scope on the key, no credits, no network - the line just
      // stays straight rather than the destination vanishing.
      if (arcgisKey && from) {
        fetchEsriRoute(arcgisKey, from, { lat, lon })
          .then((path) => {
            // The ride may have been cancelled while this was in flight.
            if (!path || !destinations.has(id)) return;
            const line = destinations.get(id).find((f) => f.geometry.type === 'LineString');
            if (!line) return;
            line.geometry.coordinates = path;
            renderDestinations();
          })
          .catch((err) => console.warn('[map] Esri routing unavailable; keeping straight line', err));
      }
    },
    clearDestinations() {
      destinations.clear();
      renderDestinations();
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
    panTo(lat, lon) {
      map.panTo([lon, lat], { duration: 600 });
    },
    /** See the Google adapter's getBounds. */
    getBounds() {
      const b = map.getBounds();
      if (!b) return null;
      return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    },
    raw: map,
  };
}

/**
 * Build the map.
 *
 * Kept as a named factory rather than exporting createOsmMap directly: the
 * callers should not have to change again if the basemap ever does, and the
 * two call sites (the live map and the history map) already read as a factory.
 *
 * `arcgisKey` is optional and is only ever used to draw a road route to an
 * arrival point. Without it the destination still appears, joined by a
 * straight line.
 */
export function createMap(container, onMarkerClick, arcgisKey = '') {
  return createOsmMap(container, onMarkerClick, arcgisKey);
}
