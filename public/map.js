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

/**
 * Load a script once, however many times this is called.
 *
 * Switching basemap away from Google and back used to append the Maps API a
 * second time, which Google warns about explicitly ("You have included the
 * Google Maps JavaScript API multiple times") and which then fails to
 * re-register every one of its custom elements. Caching the promise per URL
 * makes a repeat call resolve against the load already in flight.
 */
const scriptLoads = new Map();

function loadScript(src) {
  const cached = scriptLoads.get(src);
  if (cached) return cached;

  const load = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => {
      // Not cached on failure: a network blip should not poison every later
      // attempt for the life of the page.
      scriptLoads.delete(src);
      reject(new Error(`failed to load ${src}`));
    };
    document.head.appendChild(el);
  });

  scriptLoads.set(src, load);
  return load;
}

// --- Google ----------------------------------------------------------------

async function createGoogleMap(container, apiKey, onMarkerClick, theme) {
  // Already loaded by an earlier basemap switch. Google's `callback` fires
  // once per script load, so waiting on it a second time would never resolve
  // and the map would simply never appear.
  if (!window.google?.maps) {
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
  }

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
          // Sit the name clear of the glyph. labelOrigin is in path units, so
          // it scales with the symbol - hence a different value per shape.
          labelOrigin: new google.maps.Point(0, 4.2),
        }
      : {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          labelOrigin: new google.maps.Point(0, 2.1),
        };
  };

  /**
   * Marker labels have no halo, so the colour has to change with the basemap
   * or the name disappears against it. Tracked here and re-applied on theme
   * change, since Google gives no way to restyle a label in place.
   */
  let currentTheme = theme;
  const labelFor = (text) => ({
    text: text || ' ',
    color: currentTheme === 'light' ? '#1b2429' : '#ffffff',
    fontSize: '12px',
    fontWeight: '700',
    fontFamily: 'Cairo, system-ui, sans-serif',
  });

  let track = null;

  return {
    provider: 'google',
    supportsTheme: true,
    /** Draw the recent route. `coords` is [{lat, lon}], oldest first. */
    setTrack(coords) {
      track?.setMap(null);
      track = null;
      if (!coords || coords.length < 2) return;
      track = new google.maps.Polyline({
        map,
        path: coords.map((c) => ({ lat: c.latitude, lng: c.longitude })),
        strokeColor: '#2f9e6e',
        strokeOpacity: 0.9,
        strokeWeight: 4,
      });
    },
    setTheme(next) {
      currentTheme = next;
      map.setOptions({ styles: next === 'light' ? null : GOOGLE_DARK });
      // Re-apply every label so the text stays legible against the new basemap.
      for (const marker of markers.values()) {
        const label = marker.getLabel();
        if (label?.text) marker.setLabel(labelFor(label.text));
      }
    },
    setMarker(id, lat, lon, { title, label, kind, heading, moving, freshness }) {
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
      marker.setLabel(label ? labelFor(label) : null);
      // Fade rather than hide: an operator still needs to see roughly where
      // a truck was, they just must not read it as current.
      marker.setOpacity(freshness === 'stale' ? 0.35 : freshness === 'aging' ? 0.6 : 1);
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
    /**
     * Recentre without touching zoom. Used to follow a moving vehicle, where
     * yanking the zoom on every position would be unusable.
     */
    panTo(lat, lon) {
      map.panTo({ lat, lng: lon });
    },
    raw: map,
  };
}

// --- Raster basemaps (OpenStreetMap, Esri) ---------------------------------

/**
 * Raster providers the console can offer, all proxied through our own origin.
 *
 * Proxied rather than fetched directly because tile hosts are not reliably
 * reachable from Libya, and the server-side cache keeps the map alive when an
 * upstream is down.
 *
 * Esri is imagery only, with no names baked in, so it is paired with Esri's
 * transparent places layer on top - otherwise the map is beautiful and
 * unreadable, and you cannot tell one fuel depot from the next.
 */
const RASTER_BASEMAPS = {
  osm: {
    label: 'خريطة الشوارع',
    tiles: ['osm'],
    attribution: '© OpenStreetMap',
  },
  esri: {
    label: 'قمر صناعي',
    // Imagery plus street names. Two layers, not three: every extra raster
    // layer multiplies the tile requests for one view, and a third was enough
    // for Chrome to start refusing them outright with ERR_INSUFFICIENT_RESOURCES
    // while the proxy was still fetching the first ones from Esri.
    //
    // World_Transportation is the one worth having. The boundaries layer it
    // replaces returned about 2.6 KB per tile over Tripoli against 16 KB here,
    // because it carries administrative lines and major settlement names
    // rather than the streets an operator actually navigates by.
    tiles: ['esri', 'esri-transport'],
    attribution: 'Esri, Maxar',
  },
};

function createOsmMap(container, onMarkerClick, basemap = 'osm') {
  const spec = RASTER_BASEMAPS[basemap] ?? RASTER_BASEMAPS.osm;
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

  return {
    provider: basemap,
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
    panTo(lat, lon) {
      map.panTo([lon, lat], { duration: 600 });
    },
    raw: map,
  };
}

/**
 * Build the map for the requested provider.
 *
 * `provider` is 'google', 'esri' or 'osm'. Google is used only when a key is
 * configured and only when actually asked for; anything else, or a Google that
 * fails to load, falls through to a raster basemap. A billing problem or an
 * invalid key must degrade to a working map rather than to a blank panel -
 * which is exactly what an expired key produced in Tripoli.
 */
export async function createMap(
  container,
  apiKey,
  onMarkerClick,
  theme = 'dark',
  provider = 'google',
  arcgis = null,
) {
  if (provider === 'arcgis') {
    try {
      // Imported on demand: the ArcGIS SDK is large, and an operator who
      // never selects it should not pay to download it.
      const { createArcgisMap } = await import('/map-arcgis.js');
      return await createArcgisMap(
        container,
        arcgis?.apiKey ?? '',
        onMarkerClick,
        theme,
        arcgis?.version || '4.31',
      );
    } catch (err) {
      // Esri's CDN unreachable, a rejected key, or a retired SDK version. Fall
      // back to imagery rather than to a blank panel: a dispatcher needs to
      // see where the trucks are more than they need the licensed basemap.
      console.error('[map] ArcGIS failed, falling back to Esri imagery', err);
      return createOsmMap(container, onMarkerClick, 'esri');
    }
  }
  if (provider === 'google' && apiKey) {
    try {
      return await createGoogleMap(container, apiKey, onMarkerClick, theme);
    } catch (err) {
      console.error('[map] Google Maps failed, falling back to Esri imagery', err);
      return createOsmMap(container, onMarkerClick, 'esri');
    }
  }
  return createOsmMap(container, onMarkerClick, provider === 'esri' ? 'esri' : 'osm');
}

/**
 * Basemap choices the UI offers, so it does not hardcode the list.
 *
 * ArcGIS is listed first when licensed: it is the client's own basemap, and
 * the one they expect to be looking at.
 */
export function availableBasemaps(hasGoogleKey, hasArcgisKey = false) {
  return [
    ...(hasArcgisKey ? [{ id: 'arcgis', label: 'إيسري' }] : []),
    ...(hasGoogleKey ? [{ id: 'google', label: 'جوجل' }] : []),
    { id: 'esri', label: RASTER_BASEMAPS.esri.label },
    { id: 'osm', label: RASTER_BASEMAPS.osm.label },
  ];
}
