# Korea Drive — design contract

A second app in this repo (`drive.html`, `js/drive/`) that drives a car along a real Korean route built from an
OpenStreetMap extract, seen from inside the car, in any time of day and in rain. Geometry is procedural, in the
same spirit as the Manhattan city: real roads and footprints from OSM, everything OSM lacks (heights, facades,
street furniture, rural filler) filled in by seeded rules. The Manhattan app (`index.html`, `js/*.js`) keeps
working unchanged; drive modules import the shared modules (`js/tsl-materials.js`, `js/actor-models.js`,
`js/lighting.js`, `js/post-processing.js`, …) rather than copying them.

Prototype target: **서울역 → 강남역** (city, flat). The pipeline accepts any two points (부산 → 서울 too), but
terrain (DEM), tunnels-into-mountains and rural filler are later phases.

## World frame

- 1 unit = 1 m. Local tangent plane at `route.origin` (lat/lon of the route start).
- `x` = east, `z` = south (so north is `-z`, as in the Manhattan frame), `y` = up. Ground is `y = 0` for now.
- Conversion (equirectangular about the origin, fine for city-scale; long routes keep the same formula):
  `x = (lon - lon0) * 111320 * cos(lat0)`, `z = -(lat - lat0) * 110540`.
- Korea drives on the right.

## Data — `data/drive/<routeId>/`

Built offline by `tools/drive/build_route.py` from a `.osm.pbf` (not committed; path given on the command line).
Coordinates are rounded to 0.1 m and stored as flat arrays `[x0, z0, x1, z1, …]`.

### `route.json`

```jsonc
{
  "version": 1,
  "id": "seoul-station-gangnam",
  "name": "서울역 → 강남역",
  "from": { "name": "서울역", "lat": 37.5547, "lon": 126.9707 },
  "to":   { "name": "강남역", "lat": 37.4979, "lon": 127.0276 },
  "origin": { "lat": 37.5547, "lon": 126.9707 },
  "lengthM": 9400,
  "tileSize": 500,                       // m, tiles are aligned to multiples of tileSize in the world frame
  "path": [x0, z0, x1, z1, ...],         // route centreline (road centreline of the ways driven), start → end
  "segments": [                          // consecutive ranges of path points sharing one OSM way's attributes
    { "i0": 0, "i1": 14, "highway": "primary", "name": "한강대로", "ref": null,
      "lanes": 6, "oneway": false, "maxspeed": 50, "tunnel": false, "bridge": false, "layer": 0 }
  ],
  "signals": [37, 102],                  // path point indices with highway=traffic_signals
  "tiles": ["-2_1", "-1_1", ...]         // "<tx>_<tz>" of every tile in the corridor, in route order
}
```

`lanes` / `maxspeed` are filled with defaults by highway class when OSM has none (and `lanesTagged` /
`maxspeedTagged` booleans say which). `i1` of a segment equals `i0` of the next.

### `tiles/<tx>_<tz>.json`

Tile `(tx, tz)` covers `x ∈ [tx·S, (tx+1)·S)`, `z ∈ [tz·S, (tz+1)·S)`. A feature is stored in the tile holding its
centroid (roads: split at tile borders so each piece lives in one tile). Corridor: tiles within ~400 m of the path.

```jsonc
{
  "tx": -1, "tz": 1, "bounds": [minX, minZ, maxX, maxZ],
  "roads": [ { "id": 123, "highway": "secondary", "name": "…", "lanes": 4, "width": 14.0, "oneway": false,
               "tunnel": false, "bridge": false, "layer": 0, "pts": [x, z, ...] } ],
  "buildings": [ { "id": 456, "pts": [x, z, ...], "holes": [[x, z, ...]],   // outer ring CCW seen from above (+y)
                   "levels": 15, "height": null, "minHeight": 0, "type": "apartments",
                   "name": "…", "use": "retail" } ],                         // use: amenity/shop/office hint or null
  "areas": [ { "key": "landuse", "kind": "residential", "pts": [...], "holes": [] } ],   // landuse/natural/leisure, water
  "points": [ { "kind": "tree", "x": 0, "z": 0 }, { "kind": "street_lamp", ... }, { "kind": "traffic_signals", ... } ]
}
```

`levels` / `height` are as tagged (null when absent); estimating missing heights is the city builder's job, seeded by
`id` so a building always comes out the same.

## Runtime modules — `js/drive/`

| Module | Owner | Exports |
|---|---|---|
| `route-data.js` | data | `loadRoute(baseUrl)` → route object; `TileStreamer` |
| `world-builder.js` (+ helpers) | city | `createWorldBuilder(scene, { route })` |
| `autopilot.js` | drive | `createAutopilot(route, opts)` |
| `car-cabin.js` | drive | `createCarCabin(scene, opts)` |
| `environment.js` | environment | `createEnvironment({ scene, renderer, lighting, route })` |
| `main.js`, `drive.html` | integration | — |

### `route-data.js`
- `await loadRoute('data/drive/seoul-station-gangnam/')` → the parsed `route.json` plus `pointAt(distanceM)` →
  `{ x, z, heading, segment }` and `cumulative` (Float64Array of distance at each path point).
- `new TileStreamer({ baseUrl, route, radius = 700, onLoad(tile), onUnload(key) })`, `.update(x, z)` loads tiles
  within `radius` (fetch, at most 2 in flight, nearest first) and unloads tiles beyond `radius + 200`.

### `world-builder.js`
- `createWorldBuilder(scene, { route })` → `{ buildTile(tile) → Promise<THREE.Object3D>, removeTile(key), update(camera) }`.
- Builds road surfaces + lane paint, sidewalks/curbs, building masses with facade shaders (Korean styles: 아파트
  단지 slabs, 상가 with signage bands, low-rise 주택, glass offices), ground per landuse, trees, street lamps,
  signals. Must not hitch the frame: budget ≈ 8 ms per slice, yield between slices.
- Disposes geometry/materials it owns on `removeTile`. Shared materials are created once.

### `autopilot.js`
- `createAutopilot(route, { lane = 'right', startDistance = 0 })` →
  `{ update(dt, timeScale) → state, state, jumpTo(distanceM) }`,
  `state = { distance, position: Vector3, heading (rad, 0 = -z, clockwise positive), pitch, roll, speed (m/s), segment, finished }`.
- Speed from `maxspeed`, slowing for curvature and stopping at some `signals`; smooth accel/brake; lane offset to
  the right of the centreline by lane count.

### `car-cabin.js`
- `createCarCabin(scene, { spec })` → `{ group, windshield, setPose(state), views, setView(id), update(dt, input) }`.
- The player car (exterior from `actor-models.js`) plus an interior: dashboard, A-pillars, roof liner, door cards,
  steering wheel, mirrors. `windshield` is the front glass mesh (environment replaces its material).
- Views: `driver` (default), `passenger-side` (looking out the right window), `rear-seat`, `chase` (outside).
  Mouse/touch drag looks around within limits.

### `environment.js`
- `createEnvironment({ scene, renderer, lighting, route })` →
  `{ setTime(hours /* 0–24 local */), setDate(date), setWeather('clear' | 'overcast' | 'rain'), attachWindshield(mesh),
     update(dt, camera, carState) }`.
- Sun direction from `route.origin` lat/lon + date + time (solar position). Continuous dawn → day → dusk → night by
  blending the existing `LightingSystem` presets (add an `applyParams(params)` to `lighting.js` instead of
  duplicating it). Night: interior/streetlight glow via `cityUniforms`.
- Rain: falling streaks around the camera (instanced, GPU-animated), `cityUniforms.uRoadWetness` ramps, darker
  overcast sky + fog, droplets running on `windshield` with a wiper sweep.

## As implemented (deviations from the contract above)
- Tiles: areas spanning several tiles are clipped into each corridor tile (not stored once by centroid); rings do
  not repeat their first point; relation-built features use the negative relation id; footways/cycleways/paths/steps
  and `building:part` are not exported. `TileStreamer` sets `tile.key` and keeps `pending` (Set of keys in flight).
- Autopilot: `state.segment` is the segment object; `state.distance` is along the raw centreline; `heading` is
  unwrapped; extra fields `curvature`, `accel`, `limit`, `waiting`.
- Cabin owns `cabin.camera`; look input is CSS pixels (0.004 rad/px).
- Environment: `state.look` names the colour-grading preset to apply; road wetness follows weather only; the
  shadow light switches to a moon at night; `lighting.applyParams(p, bake)` and exported `TIME_PRESETS`.

## Conventions
- Native ES modules, no build step, no new runtime dependencies. Match the code style of `js/` (comment density,
  naming, TSL usage).
- Tests: `node --test tests/*.test.*`, harness `tests/helpers/module.cjs` for unit tests of pure logic.
- Offline Python tooling may use `osmium` (pyosmium); list it in `tools/drive/requirements.txt`.
