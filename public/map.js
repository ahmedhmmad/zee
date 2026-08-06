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

async function createGoogleMap(container, apiKey, onMarkerClick) {
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
    styles: GOOGLE_DARK,
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

  /**
   * google.maps.Marker is deprecated in favour of AdvancedMarkerElement, but
   * kept deliberately: AdvancedMarkerElement requires a cloud-configured Map
   * ID, and setting `mapId` makes Google ignore the inline `styles` above -
   * so the dark theme would have to be rebuilt in the Cloud console instead.
   * Google give at least 12 months notice before removal, so this is a
   * migration to make when there is a reason, not a fire.
   */
  const iconFor = (kind) => ({
    path: google.maps.SymbolPath.CIRCLE,
    scale: 11,
    fillColor: kind === 'unlocked' ? '#d9483b' : kind === 'offline' ? '#55666f' : '#2f9e6e',
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
  });

  return {
    provider: 'google',
    setMarker(id, lat, lon, { title, kind }) {
      let marker = markers.get(id);
      if (!marker) {
        marker = new google.maps.Marker({ map, position: { lat, lng: lon }, title });
        marker.addListener('click', () => onMarkerClick(id));
        markers.set(id, marker);
      } else {
        marker.setPosition({ lat, lng: lon });
        marker.setTitle(title);
      }
      marker.setIcon(iconFor(kind));
    },
    removeMarker(id) {
      const marker = markers.get(id);
      if (marker) {
        marker.setMap(null);
        markers.delete(id);
      }
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
    setMarker(id, lat, lon, { title, kind }) {
      let marker = markers.get(id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'truck-marker';
        el.textContent = '🚛';
        el.addEventListener('click', () => onMarkerClick(id));
        marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
        markers.set(id, marker);
      } else {
        marker.setLngLat([lon, lat]);
      }
      const el = marker.getElement();
      el.classList.toggle('unlocked', kind === 'unlocked');
      el.classList.toggle('offline', kind === 'offline');
      el.title = title;
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
export async function createMap(container, apiKey, onMarkerClick) {
  if (apiKey) {
    try {
      return await createGoogleMap(container, apiKey, onMarkerClick);
    } catch (err) {
      // A billing problem or an unreachable Google should degrade to a working
      // map, not to a blank panel.
      console.error('[map] Google Maps failed, falling back to OpenStreetMap', err);
    }
  }
  return createOsmMap(container, onMarkerClick);
}
