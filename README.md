# Shapefile boundary: add an outward buffer

This Node.js script takes a ZIP containing a polygon shapefile, expands the area
outward by a chosen distance (**1,000 metres** by default), and exports a single
KML containing both the original and adjusted boundaries.

## Web app

A React UI lets you drag in a ZIP, choose a buffer distance, preview the result,
and download the KML. Everything runs in your browser; files are never uploaded.

```sh
npm run dev      # local development server
npm run build    # production build into dist/
```

### Deploy (GitHub Pages, free)

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, builds, and
publishes the site. One-time setup: repo **Settings → Pages → Source: GitHub
Actions**. The site is then at `https://<user>.github.io/boundary-adjuster/`.
(Pages on private repos needs a paid GitHub plan.)

## Requirements

- Node.js 22 or newer and npm. No Python, GDAL, GIS application, or API key needed.
- One polygon layer in a ZIP, with matching `.shp`, `.shx`, `.dbf`, and `.prj`
  files. A `.cpg` encoding file is optional. They can be inside a subfolder;
  extensions are case-insensitive. Extra GeoJSON, KML, and KMZ exports are ignored.
- A valid CRS definition in `.prj` that Proj4js supports. Coordinates are never
  assumed to be metres just because they are numbers.

## Install

Open a terminal in this directory and run:

```sh
npm ci
```

## Run

Using your own ZIP (quote paths containing spaces):

```sh
node script.js "/path/to/boundary.zip"
```

Set the buffer distance in **metres**, for example 500 metres:

```sh
node script.js "/path/to/boundary.zip" --buffer 500
```

Distances must be positive, finite numbers; decimals such as `250.5` are accepted.
Zero, negative, and nonnumeric values are rejected.

By default, results are saved in the **same directory as the input ZIP**.
The KML name includes the buffer distance: `boundary.zip` with `--buffer 500`
becomes `boundary-adjusted-boundary-500m.kml`. With the default distance, it becomes
`boundary-adjusted-boundary-1000m.kml`. Decimals are retained, for example
`boundary-adjusted-boundary-250.5m.kml`. Different distances produce separate files.
The original ZIP is not changed.

To save results in a different directory:

```sh
node script.js "/path/to/boundary.zip" --output "./my-results"
```

Existing output files are not replaced unless you explicitly add `--overwrite`:

```sh
node script.js "/path/to/boundary.zip" --overwrite
```

For usage, run `node script.js --help`.

## Results

The only output is `<input-name>-adjusted-boundary-<metres>m.kml`. No ZIP, GeoJSON, or HTML
files are generated. Files from previous runs are not deleted.

Open the KML in Google Earth, QGIS, or another KML-compatible viewer:

- **Original boundary**: green, with a placemark for each original feature.
- **Adjusted boundary**: blue, with the dissolved, expanded area and the chosen
  distance in its placemark name.

The two folders can be toggled independently. Polygon holes and disconnected
parts are preserved. Coordinates use WGS84 longitude/latitude, clamped to ground;
the KML is not exported in the input's projected CRS.

Original feature attributes are included as KML extended data. The adjusted area
has `kind = buffered` and `buffer_m` set to the chosen distance in metres; source
attributes are not assigned to the dissolved result. Comparison attributes `kind` and `buffer_m` override source
attributes with those names in the KML only. The input ZIP remains unchanged.

Without a `.cpg`, attribute text uses the shapefile reader's default decoding.
Include a correct `.cpg` if non-ASCII text is decoded incorrectly.

## What the buffer means

- This is a **positive outward buffer**: the output includes the original area
  and the additional land within approximately the chosen distance of its edges.
  It is not just a thin outline or a hollow band.
- Multiple input polygons are dissolved first, so internal shared edges do not
  become separate boundaries. Nearby areas may merge; islands remain multipart
  where they do not touch.
- Normal polygon-buffer semantics apply to holes: they shrink, and holes narrower
  than about twice the buffer distance can disappear. Corners are rounded, with
  64 segments per quarter circle. Z/M dimensions are not preserved in the generated boundary.
- The script reads the input CRS, transforms to WGS84, and uses Turf/JSTS with a
  **local azimuthal-equidistant projection in metres** for buffering. It then
  transforms the generated result back to WGS84 for export. It does **not** add
  metre distances to geographic degree coordinates.

### Accuracy and supported scope

Use this for valid local/regional Polygon or MultiPolygon boundaries, such as a
district or site. This is an approximate spherical, locally projected buffer, not
an exact ellipsoidal/geodesic or survey-grade offset. Projection distortion and
the spherical Earth model affect ground distances; do not assume centimetre-level
accuracy. For legal, engineering, or survey work, use a suitable local authoritative
projected CRS and a validated GIS workflow instead.

To avoid misleading global results, the script rejects layers spanning more than
5 degrees in either axis, antimeridian-crossing layers with that extent, and
latitudes at or beyond 85 degrees. The generated buffer must also remain within
those bounds. All components are processed in memory; use modest, trusted ZIPs,
not very large or untrusted archives. Input topology should be valid; the script
checks basic rings and coordinates but is not a full topology-repair tool.

## Troubleshooting

- **Missing or empty component:** include matching `.shp`, `.shx`, `.dbf`, and
  `.prj` files in the ZIP. A `.prj` is required to avoid silently using the wrong
  units or location. A `.cpg` is optional, but must be nonempty if supplied.
- **More than one shapefile:** make a ZIP containing only the intended layer.
- **Unsupported CRS/projection:** re-export the source with a Proj4js-supported
  CRS (for example EPSG:4326), including a correct `.prj`.
- **Point/line/null geometry or invalid rings:** export a valid polygon boundary
  first. Topology errors may also cause union/buffering to fail.
- **Output already exists:** choose a different `--output` directory or add
  `--overwrite`.

Failures print an error and exit with a non-zero status.

## Tests

```sh
npm test
```

Tests generate their own shapefile fixtures and cover projected input, buffer
distance, holes/multipart geometry, KML attributes, required files, invalid input,
and the single-file command-line output.