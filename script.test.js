import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import shpWrite from '@mapbox/shp-write';
import { parseZip } from 'shpjs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  readBoundary, bufferBoundary, createShapefileZip, createComparison, createPreview,
} from './script.js';

const sampleUrl = new URL('./north_london_test_area_shapefile.zip', import.meta.url);
const scriptPath = fileURLToPath(new URL('./script.js', import.meta.url));
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const WEB_MERCATOR = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"]]';

const square = (west = -0.01, south = -0.01, east = 0.01, north = 0.01) =>
  [[west, south], [west, north], [east, north], [east, south], [west, south]];
const feature = (coordinates, type = 'Polygon') => ({
  type: 'Feature', properties: { label: 'test' }, geometry: { type, coordinates },
});
const collection = (...features) => ({ type: 'FeatureCollection', features });
const polygonsOf = (geometry) => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
const positionsOf = (geometry) => polygonsOf(geometry).flat(2);

async function fixture(rings, prj = WGS84) {
  const files = await new Promise((resolve, reject) => {
    shpWrite.write([{ label: 'test' }], 'POLYGON', [rings], (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  return zipSync({
    'nested/AREA.SHP': new Uint8Array(files.shp.buffer),
    'nested/AREA.SHX': new Uint8Array(files.shx.buffer),
    'nested/AREA.DBF': new Uint8Array(files.dbf.buffer),
    'nested/AREA.PRJ': strToU8(prj),
    'nested/AREA.CPG': strToU8('UTF-8'),
  });
}

function haversine(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const h = Math.sin(radians(b[1] - a[1]) / 2) ** 2 +
    Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(radians(b[0] - a[0]) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

test('supplied sample buffers and exports complete, readable shapefile layers', async () => {
  const source = await readFile(sampleUrl);
  const { original, originalFiles } = await readBoundary(source);
  const buffered = bufferBoundary(original);
  assert.equal(buffered.properties.buffer_m, 1000);
  const archive = await createShapefileZip(originalFiles, buffered);
  const files = unzipSync(archive);
  assert.equal(Object.keys(files).length, 10);
  for (const [name, bytes] of Object.entries(originalFiles)) assert.deepEqual(files[name], bytes);
  const layers = await parseZip(archive);
  assert.equal(layers.length, 2);
  const expanded = layers.find((layer) => layer.fileName === 'buffered');
  assert.equal(expanded.features.length, 1);
  assert.equal(expanded.features[0].properties.buffer_m, 1000);
  assert.equal(new TextDecoder().decode(files['buffered.cpg']), 'UTF-8');
  const comparison = createComparison(original, buffered);
  const html = createPreview(comparison);
  assert.match(html, /id="original"/);
  assert.match(html, /id="buffered"/);
  assert.match(html, /data-layer="original"/);
  assert.match(html, /data-layer="buffered"/);
  assert.doesNotMatch(html, /NaN|Infinity|<script src=/);
});

test('buffer extends about 1,000 metres, rather than 1,000 degrees', () => {
  const buffered = bufferBoundary(collection(feature([square()])));
  const positions = positionsOf(buffered.geometry);
  const eastern = positions.reduce((best, point) => point[0] > best[0] ? point : best);
  const closestCorner = [0.01, eastern[1] >= 0 ? 0.01 : -0.01];
  assert.ok(Math.abs(haversine(closestCorner, eastern) - 1000) < 1);
  assert.ok(eastern[0] > 0.018 && eastern[0] < 0.020);
});

test('overlapping input polygons dissolve into one expanded area', () => {
  const input = collection(feature([square()]), feature([square(0, -0.01, 0.02, 0.01)]));
  const buffered = bufferBoundary(input);
  assert.equal(buffered.geometry.type, 'Polygon');
  assert.equal(buffered.geometry.coordinates.length, 1);
  assert.equal(input.features.length, 2);
  assert.deepEqual(input.features[0].properties, { label: 'test' });
});

test('multipart polygons and surviving holes round-trip through the writer', async () => {
  const input = collection(feature([
    [square(-0.15, -0.15, 0.15, 0.15), [...square(-0.08, -0.08, 0.08, 0.08)].reverse()],
    [square(0.5, 0.5, 0.52, 0.52)],
  ], 'MultiPolygon'));
  const buffered = bufferBoundary(input);
  const archive = await createShapefileZip({}, buffered);
  const result = await parseZip(archive);
  const polygons = polygonsOf(result.features[0].geometry);
  assert.equal(polygons.length, 2);
  assert.equal(polygons.filter((polygon) => polygon.length === 2).length, 1);
  const hole = polygons.find((polygon) => polygon.length === 2)[1];
  assert.ok(Math.max(...hole.map((point) => point[0])) < 0.08);
});

test('projected coordinates, nested folders, and uppercase extensions are supported', async () => {
  const toMercator = ([longitude, latitude]) => [
    6378137 * longitude * Math.PI / 180,
    6378137 * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)),
  ];
  const source = await fixture([square(-0.15, 51.5, -0.13, 51.52).map(toMercator)], WEB_MERCATOR);
  const { original } = await readBoundary(source);
  const point = original.features[0].geometry.coordinates[0][0];
  assert.ok(Math.abs(point[0] + 0.15) < 1e-8);
  assert.ok(Math.abs(point[1] - 51.5) < 1e-8);
  const buffered = bufferBoundary(original);
  assert.ok(Math.max(...positionsOf(buffered.geometry).map((position) => position[1])) > 51.528);
});

test('missing components and ambiguous archives fail clearly', async () => {
  const bytes = await fixture([square()]);
  const files = unzipSync(bytes);
  for (const extension of ['SHP', 'SHX', 'DBF', 'PRJ', 'CPG']) {
    const incomplete = { ...files };
    delete incomplete[`nested/AREA.${extension}`];
    await assert.rejects(readBoundary(zipSync(incomplete)), /Missing or empty|exactly one/);
  }
  await assert.rejects(readBoundary(zipSync({ ...files, 'extra.shp': files['nested/AREA.SHP'] })), /exactly one/);
  await assert.rejects(readBoundary(zipSync({ ...files, 'nested/AREA.PRJ': strToU8('not a CRS') }))); 
  await assert.rejects(readBoundary(strToU8('not a zip')));
});

test('empty, nonpolygon, invalid-coordinate, and over-wide input are rejected', () => {
  assert.throws(() => bufferBoundary(collection()), /no features/);
  assert.throws(() => bufferBoundary(collection(feature([0, 0], 'Point'))), /Polygon/);
  assert.throws(() => bufferBoundary(collection(feature([square(0, 0, 10, 1)]))), /at most 5/);
  assert.throws(() => bufferBoundary(collection(feature([square(0, 85, 1, 86)]))), /latitude/);
  assert.throws(() => bufferBoundary(collection(feature([[[0, 0], [1, 0], [1, 1]]]))), /unclosed/);
  const bad = square();
  bad[1][0] = NaN;
  assert.throws(() => bufferBoundary(collection(feature([bad]))), /Invalid coordinates/);
});

test('CLI creates outputs, protects existing files, and reports errors', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'boundary-buffer-'));
  try {
    const output = join(temporary, 'results');
    const args = [scriptPath, fileURLToPath(sampleUrl), '--output', output];
    const run = (parameters) => spawnSync(process.execPath, parameters, { encoding: 'utf8', cwd: temporary });
    const first = run(args);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual((await readdir(output)).sort(), ['boundaries.geojson', 'boundary_comparison.zip', 'comparison.html']);
    const geojson = JSON.parse(await readFile(join(output, 'boundaries.geojson'), 'utf8'));
    assert.ok(geojson.features.some((item) => item.properties.kind === 'original'));
    assert.ok(geojson.features.some((item) => item.properties.kind === 'buffered'));
    assert.equal(run(args).status, 1);
    assert.equal(run([...args, '--overwrite']).status, 0);
    assert.equal(run([scriptPath, '--help']).status, 0);
    assert.equal(run([scriptPath]).status, 1);
    assert.equal(run([scriptPath, 'missing.zip']).status, 1);
    assert.equal(run([scriptPath, '--unknown']).status, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});