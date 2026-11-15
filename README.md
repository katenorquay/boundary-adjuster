# Shapefile boundary: add a 1 km buffer

This Node.js script takes a ZIP containing a polygon shapefile, expands the area
outward by **1,000 metres**, and exports the new boundary alongside the original.
It also creates a standalone HTML comparison that works offline.

## Requirements

- Node.js 22 or newer and npm. No Python, GDAL, GIS application, or API key needed.
- One polygon layer in a ZIP, with matching `.shp`, `.shx`, `.dbf`, `.prj`, and
  `.cpg` files. They can be inside a subfolder; extensions are case-insensitive.
- A valid CRS definition in `.prj` that Proj4js supports. Coordinates are never
  assumed to be metres just because they are numbers.

## Install

Open a terminal in this directory and run:

```sh
npm ci
```

## Run

Using the supplied sample:

```sh
node script.js north_london_test_area_shapefile.zip
```

Using your own ZIP and output directory (quote paths containing spaces):

```sh
node script.js "/path/to/boundary.zip" --output "./my-results"
```

By default, results go into `output/` relative to the terminal's current directory.
Existing output files are not replaced unless you explicitly add `--overwrite`:

```sh
node script.js north_london_test_area_shapefile.zip --overwrite
```

For usage, run `node script.js --help`. The distance is fixed at 1 km.

## Results

| File in your output directory | Contents |
| --- | --- |
| `boundary_comparison.zip` | Two complete shapefile layers: `original` and `buffered`, each with `.shp`, `.shx`, `.dbf`, `.prj`, and `.cpg` companions. |
| `comparison.html` | Offline visual comparison. Open in a browser; green is the original, blue is the expanded area. Checkboxes toggle either layer. No web server or internet required. |
| `boundaries.geojson` | Both boundaries together in WGS84 longitude/latitude, with `kind` and `buffer_m` attributes for styling/filtering. |

**To view the shapefiles in QGIS or ArcGIS:** extract the output ZIP and add both
`original.shp` and `buffered.shp`. Keep each layer's companion files together.
Draw the original above the buffer, with different outline/fill colours. A shapefile
does not store layer styling, so use the HTML preview for a ready-made comparison.

The original layer's five files are copied **byte-for-byte**, preserving its CRS,
features, attribute data, and character encoding. The new buffered layer uses
**WGS84 / EPSG:4326**, with a matching `.prj` and UTF-8 `.cpg`. GIS software can
overlay the two CRSs automatically. This is intentionally not an export back into
the input CRS.

The new layer has one Polygon/multipart Polygon record for the dissolved area,
with `kind = buffered` and `buffer_m = 1000`. Source attributes are not assigned to
the dissolved result; they remain on the original layer. GeoJSON comparison
attributes `kind` and `buffer_m` override any source attributes with those names;
the original shapefile's attributes are not changed.

## What “1 km boundary” means

- This is a **positive outward buffer**: the output includes the original area
  and the additional land within approximately 1 km of its edges. It is not just
  a thin outline or a hollow 1 km-wide band.
- Multiple input polygons are dissolved first, so internal shared edges do not
  become separate boundaries. Nearby areas may merge; islands remain multipart
  where they do not touch.
- Normal polygon-buffer semantics apply to holes: they shrink, and holes narrower
  than about 2 km can disappear. Corners are rounded, with 64 segments per quarter
  circle. Z/M dimensions are not preserved in the generated boundary.
- The script reads the input CRS, transforms to WGS84, and uses Turf/JSTS with a
  **local azimuthal-equidistant projection in metres** for buffering. It then
  transforms the generated result back to WGS84 for export. It does **not** add
  1,000 to geographic degree coordinates.

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

The preview uses a local display projection with north up, and no basemap. Its
display transform is separate from the metric buffer calculation.

## Troubleshooting

- **Missing or empty component:** put all five matching files in the ZIP. A `.prj`
  is required to avoid silently using the wrong units or location.
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

Tests cover the supplied ZIP, projected input, buffer distance, holes/multipart
round-tripping, required files, invalid input, and the command-line outputs.