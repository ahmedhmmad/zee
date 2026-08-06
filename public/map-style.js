/*
 * Vector basemap style for the Protomaps schema, labelled in Arabic.
 *
 * Written by hand rather than pulled from a theme package, because the whole
 * reason for moving off raster tiles is label-language control, and that means
 * owning the text-field expressions.
 *
 * Every label uses `name:ar` where OpenStreetMap has it and falls back to the
 * local `name` otherwise — so Libyan places read in Arabic, and anywhere
 * missing an Arabic name still shows something rather than a blank.
 */

/* global maplibregl */

/** Arabic name, falling back to the default name. */
const LABEL = ['coalesce', ['get', 'name:ar'], ['get', 'name']];

const C = {
  earth: '#1b2429',
  water: '#16303d',
  green: '#1d2f28',
  built: '#222d33',
  building: '#2b373e',
  highway: '#4a5f6b',
  major: '#3e515c',
  medium: '#35464f',
  minor: '#2c3a42',
  boundary: '#4b5f6a',
  text: '#cbd8df',
  textHalo: '#0f1417',
  textMuted: '#93a7b2',
};

/**
 * `widthStops` is a flat [zoom, width, zoom, width, ...] list. Expressed as a
 * top-level interpolate: MapLibre only accepts ["zoom"] as the direct input to
 * interpolate or step, never nested inside another expression.
 */
function road(id, kinds, color, widthStops, minzoom) {
  return {
    id,
    type: 'line',
    source: 'protomaps',
    'source-layer': 'roads',
    minzoom,
    filter: ['match', ['get', 'kind'], kinds, true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], ...widthStops],
    },
  };
}

export function buildStyle(pmtilesUrl, glyphsUrl) {
  return {
    version: 8,
    glyphs: glyphsUrl,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> · Protomaps',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': C.earth } },
      {
        id: 'earth',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'earth',
        paint: { 'fill-color': C.earth },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'landuse',
        paint: {
          'fill-color': [
            'match',
            ['get', 'kind'],
            ['park', 'forest', 'grass', 'nature_reserve', 'wood'], C.green,
            ['residential', 'commercial', 'industrial', 'neighbourhood'], C.built,
            C.earth,
          ],
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'water',
        paint: { 'fill-color': C.water },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'buildings',
        minzoom: 14,
        paint: { 'fill-color': C.building, 'fill-opacity': 0.7 },
      },

      road('roads-minor', ['minor_road', 'path'], C.minor, [12, 0.4, 16, 3, 18, 8], 12),
      road('roads-medium', ['medium_road'], C.medium, [9, 0.5, 14, 3, 18, 14], 8),
      road('roads-major', ['major_road'], C.major, [7, 0.7, 14, 4, 18, 18], 6),
      road('roads-highway', ['highway'], C.highway, [5, 0.8, 14, 5, 18, 22], 4),

      {
        id: 'boundaries',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'boundaries',
        paint: {
          'line-color': C.boundary,
          'line-width': 1,
          'line-dasharray': [3, 2],
        },
      },

      // --- Labels ---------------------------------------------------------

      {
        id: 'road-labels',
        type: 'symbol',
        source: 'protomaps',
        'source-layer': 'roads',
        minzoom: 13,
        filter: ['match', ['get', 'kind'], ['highway', 'major_road', 'medium_road'], true, false],
        layout: {
          'symbol-placement': 'line',
          'text-field': LABEL,
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: {
          'text-color': C.textMuted,
          'text-halo-color': C.textHalo,
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'protomaps',
        'source-layer': 'places',
        layout: {
          'text-field': LABEL,
          'text-font': ['Noto Sans Regular'],
          // Bigger type for bigger places, so Tripoli outranks a village.
          // Zoom must be the direct input to interpolate, with the per-kind
          // match nested inside each stop rather than the other way round.
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6, ['match', ['get', 'kind'], 'country', 13, 'region', 11, 10],
            12, ['match', ['get', 'kind'], 'country', 16, 'region', 14, 13],
            16, ['match', ['get', 'kind'], 'country', 18, 'region', 16, 15],
          ],
          'text-max-width': 8,
        },
        paint: {
          'text-color': C.text,
          'text-halo-color': C.textHalo,
          'text-halo-width': 1.8,
        },
      },
    ],
  };
}
