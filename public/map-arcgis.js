/**
 * ArcGIS Maps SDK basemap.
 *
 * Added because the client standardises on Esri and has bought a licence for
 * the country: their console has to show an Esri map, not Google's.
 *
 * Note what this is NOT. Vehicle positions still come from our own JSON feed
 * and are drawn on top as graphics - nothing is published into their ArcGIS
 * Online organisation, and no feature service is involved. Esri supplies the
 * map underneath; we supply what moves on it.
 *
 * Loaded from Esri's CDN as ES modules because this project has no bundler,
 * so the @arcgis/core npm package (which must be bundled) is not an option.
 * Same arrangement as Google Maps today: the browser fetches the SDK directly.
 *
 * Implements the same adapter contract as createGoogleMap and createOsmMap so
 * the console does not care which is in use.
 */

const TRIPOLI = { lat: 32.8872, lng: 13.1913 };

/**
 * Basemaps by theme.
 *
 * Imagery is the satellite view the Ministry's own system shows; navigation
 * and dark-gray are the street equivalents of our light and dark themes.
 */
const BASEMAPS = {
  imagery: 'arcgis/imagery',
  light: 'arcgis/navigation',
  dark: 'arcgis/dark-gray',
};

/** Matches the Google adapter exactly, so a vehicle reads the same either way. */
const COLOURS = {
  unlocked: [217, 72, 59],
  offline: [85, 102, 111],
  locked: [47, 158, 110],
};

/**
 * An arrow drawn nose-up, so ArcGIS's `angle` (clockwise from north) maps
 * straight onto a GPS heading with no correction.
 */
const ARROW_PATH =
  'M 16,0 L 32,32 L 16,24 L 0,32 Z';

function colourFor(kind) {
  return COLOURS[kind] ?? COLOURS.locked;
}

/**
 * Load the SDK.
 *
 * The version is a parameter rather than a constant because Esri retires CDN
 * versions on their own schedule; when one goes, the fix should be an .env
 * change on the server rather than a code release.
 */
async function loadSdk(version) {
  const base = `https://js.arcgis.com/${version}/@arcgis/core`;

  if (!document.getElementById('arcgis-css')) {
    const link = document.createElement('link');
    link.id = 'arcgis-css';
    link.rel = 'stylesheet';
    link.href = `https://js.arcgis.com/${version}/esri/themes/light/main.css`;
    document.head.appendChild(link);
  }

  // Esri's Map class is deliberately named EsriMap: leaving it as `Map` would
  // shadow the built-in, and this module uses a real Map to track markers.
  const [
    esriConfig, EsriMap, MapView, GraphicsLayer, Graphic, geometryEngine,
  ] = await Promise.all([
    import(`${base}/config.js`),
    import(`${base}/Map.js`),
    import(`${base}/views/MapView.js`),
    import(`${base}/layers/GraphicsLayer.js`),
    import(`${base}/Graphic.js`),
    import(`${base}/geometry/geometryEngine.js`),
  ]).then((mods) => mods.map((m) => m.default ?? m));

  return { esriConfig, EsriMap, MapView, GraphicsLayer, Graphic, geometryEngine };
}

export async function createArcgisMap(container, apiKey, onMarkerClick, theme = 'dark', version = '4.31') {
  const sdk = await loadSdk(version);
  const { EsriMap, MapView, GraphicsLayer, Graphic, geometryEngine } = sdk;

  // Without a key Esri's hosted basemaps return 401 and the view comes up
  // blank, which looks like a broken console rather than a missing licence.
  if (apiKey) sdk.esriConfig.apiKey = apiKey;

  let currentTheme = theme;

  // Separate layers so one kind of overlay can be cleared without walking a
  // single graphics list looking for the right things to remove.
  const trackLayer = new GraphicsLayer();
  const trailLayer = new GraphicsLayer();
  const routeLayer = new GraphicsLayer();
  const destLayer = new GraphicsLayer();
  const markerLayer = new GraphicsLayer();

  const map = new EsriMap({
    basemap: BASEMAPS[currentTheme === 'light' ? 'light' : 'dark'],
    // Order matters: markers are added last so they draw above the routes and
    // geofences rather than disappearing under them.
    layers: [trackLayer, trailLayer, routeLayer, destLayer, markerLayer],
  });

  const view = new MapView({
    container,
    map,
    center: [TRIPOLI.lng, TRIPOLI.lat],
    zoom: 11,
    constraints: { minZoom: 5, maxZoom: 19 },
    // The default popup would open on top of our own vehicle panel.
    popupEnabled: false,
    ui: { components: ['zoom', 'attribution'] },
  });

  await view.when();

  /** id -> { symbol: Graphic, label: Graphic } */
  const markers = new Map();

  // Click resolves to the marker's device id via the graphic's attributes,
  // rather than by comparing coordinates, which would break the moment two
  // vehicles parked in the same yard.
  view.on('click', async (event) => {
    const hit = await view.hitTest(event, { include: markerLayer });
    const graphic = hit.results?.[0]?.graphic;
    const id = graphic?.attributes?.deviceId;
    if (id && onMarkerClick) onMarkerClick(id);
  });

  const point = (lat, lon) => ({ type: 'point', longitude: lon, latitude: lat });

  function labelSymbol(text) {
    return {
      type: 'text',
      text: text || ' ',
      // Esri renders a halo, unlike Google, so the label stays readable over
      // both satellite and street basemaps without swapping colour by theme.
      color: currentTheme === 'light' ? [27, 36, 41] : [255, 255, 255],
      haloColor: currentTheme === 'light' ? [255, 255, 255] : [0, 0, 0],
      haloSize: 1.5,
      font: { size: 11, weight: 'bold', family: 'Cairo, system-ui, sans-serif' },
      yoffset: -18,
    };
  }

  function vehicleSymbol(kind, heading, moving) {
    const colour = colourFor(kind);
    // A moving vehicle gets an arrow pointing where it is going; a stationary
    // one gets a circle. At rest the GPS reports whatever direction it last
    // faced, so an arrow would be inventing information.
    return moving
      ? {
          type: 'simple-marker',
          style: 'path',
          path: ARROW_PATH,
          color: colour,
          angle: heading ?? 0,
          size: 16,
          outline: { color: [255, 255, 255], width: 1.5 },
        }
      : {
          type: 'simple-marker',
          style: 'circle',
          color: colour,
          size: 13,
          outline: { color: [255, 255, 255], width: 2 },
        };
  }

  return {
    provider: 'arcgis',
    supportsTheme: true,

    setTheme(next) {
      currentTheme = next;
      map.basemap = BASEMAPS[next === 'light' ? 'light' : 'dark'];
      // Labels carry their own colour, so they have to be re-symbolised
      // rather than inheriting the new basemap.
      for (const { label } of markers.values()) {
        if (label) label.symbol = labelSymbol(label.attributes?.text);
      }
    },

    /** Draw the recent route. `coords` is [{latitude, longitude}], oldest first. */
    setTrack(coords) {
      trackLayer.removeAll();
      if (!coords || coords.length < 2) return;
      trackLayer.add(
        new Graphic({
          geometry: {
            type: 'polyline',
            paths: [coords.map((c) => [c.longitude, c.latitude])],
          },
          symbol: { type: 'simple-line', color: [47, 158, 110, 0.9], width: 3 },
        }),
      );
    },

    setMarker(id, lat, lon, { title, label, kind, heading, moving } = {}) {
      const existing = markers.get(id);
      const geometry = point(lat, lon);

      if (existing) {
        existing.symbol.geometry = geometry;
        existing.symbol.symbol = vehicleSymbol(kind, heading, moving);
        existing.label.geometry = geometry;
        existing.label.symbol = labelSymbol(label ?? title);
        existing.label.attributes = { text: label ?? title };
        return;
      }

      const symbol = new Graphic({
        geometry,
        symbol: vehicleSymbol(kind, heading, moving),
        attributes: { deviceId: id, title },
      });
      const text = new Graphic({
        geometry,
        symbol: labelSymbol(label ?? title),
        attributes: { text: label ?? title },
      });
      markerLayer.addMany([symbol, text]);
      markers.set(id, { symbol, label: text });
    },

    removeMarker(id) {
      const m = markers.get(id);
      if (!m) return;
      markerLayer.removeMany([m.symbol, m.label]);
      markers.delete(id);
    },

    /**
     * An arrival point and the radius that counts as "arrived".
     *
     * The circle is a geodesic buffer, not a screen-space circle: at Tripoli's
     * latitude a naive circle drawn in degrees is noticeably wider than it is
     * tall, and this one marks the boundary where a lock opens by itself.
     */
    setDestination(id, lat, lon, { radiusM = 100, label } = {}) {
      const centre = point(lat, lon);
      const ring = geometryEngine.geodesicBuffer(centre, radiusM, 'meters');

      destLayer.addMany([
        new Graphic({
          geometry: ring,
          symbol: {
            type: 'simple-fill',
            color: [47, 158, 110, 0.12],
            outline: { color: [47, 158, 110, 0.8], width: 1.5 },
          },
          attributes: { destinationId: id },
        }),
        new Graphic({
          geometry: centre,
          symbol: {
            type: 'simple-marker',
            style: 'diamond',
            color: [47, 158, 110],
            size: 10,
            outline: { color: [255, 255, 255], width: 1.5 },
          },
          attributes: { destinationId: id },
        }),
        ...(label
          ? [new Graphic({ geometry: centre, symbol: labelSymbol(label) })]
          : []),
      ]);
    },

    clearDestinations() {
      destLayer.removeAll();
    },

    setRoutePath(path) {
      routeLayer.removeAll();
      if (!path || path.length < 2) return;
      routeLayer.add(
        new Graphic({
          geometry: {
            type: 'polyline',
            paths: [path.map((p) => [p.longitude ?? p.lng, p.latitude ?? p.lat])],
          },
          symbol: { type: 'simple-line', color: [64, 132, 214, 0.85], width: 4 },
        }),
      );
    },

    clearRoute() {
      routeLayer.removeAll();
    },

    setTrail(segments) {
      trailLayer.removeAll();
      if (!segments?.length) return;
      for (const seg of segments) {
        const pts = seg.points ?? seg;
        if (!pts || pts.length < 2) continue;
        trailLayer.add(
          new Graphic({
            geometry: {
              type: 'polyline',
              paths: [pts.map((p) => [p.longitude ?? p.lng, p.latitude ?? p.lat])],
            },
            symbol: {
              type: 'simple-line',
              color: seg.color ?? [150, 160, 170, 0.7],
              width: 2,
            },
          }),
        );
      }
    },

    clearTrail() {
      trailLayer.removeAll();
    },

    flyTo(lat, lon, zoom = 15) {
      void view.goTo({ center: [lon, lat], zoom }, { duration: 600 });
    },

    panTo(lat, lon) {
      void view.goTo({ center: [lon, lat] }, { duration: 400 });
    },

    raw: view,
  };
}
