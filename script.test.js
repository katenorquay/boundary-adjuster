import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import shpWrite from '@mapbox/shp-write';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  readBoundary, bufferBoundary, createComparison, createKml, main,
} from './script.js';

const scriptPath = fileURLToPath(new URL('./script.js', import.meta.url));
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const WEB_MERCATOR = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"]]';

const square = (west = -0.01, south = -0.01, east = 0.01, north = 0.01) =>
  [[west, south], [west, north], [east, north], [east, south], [west, south]];
const feature = (coordinates, type = 'Polygon') => ({
  type: 'Feature', properties: { label: 'test' }, geometry: { type, coordinates },
});

test('archives without optional CPG accept companion exports and generate KML', async () => {
  const files = unzipSync(await fixture([square()]));
  delete files['nested/AREA.CPG'];
  const source = zipSync({
    ...files,
    'geo-export.geojson': strToU8(JSON.stringify(collection(feature([square()])))),
    'geo-export.kml': strToU8('<kml/>'),
    'geo-export.kmz': zipSync({ 'doc.kml': strToU8('<kml/>') }),
  });
  const original = await readBoundary(source);
  assert.equal(original.features.length, 1);
  const kml = createKml(createComparison(original, bufferBoundary(original)));
  assert.equal((kml.match(/<Placemark>/g) ?? []).length, 2);
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

test('buffer extends about 1,000 metres, rather than 1,000 degrees', () => {
  const buffered = bufferBoundary(collection(feature([square()])));
  const positions = positionsOf(buffered.geometry);
  const eastern = positions.reduce((best, point) => point[0] > best[0] ? point : best);
  const closestCorner = [0.01, eastern[1] >= 0 ? 0.01 : -0.01];
  assert.ok(Math.abs(haversine(closestCorner, eastern) - 1000) < 1);
  assert.ok(eastern[0] > 0.018 && eastern[0] < 0.020);
});

test('custom buffer distances control the geometry and KML metadata', () => {
  for (const distance of [250.5, 2000]) {
    const original = collection(feature([square()]));
    const buffered = bufferBoundary(original, distance);
    const eastern = positionsOf(buffered.geometry).reduce((best, point) => point[0] > best[0] ? point : best);
    const closestCorner = [0.01, eastern[1] >= 0 ? 0.01 : -0.01];
    assert.ok(Math.abs(haversine(closestCorner, eastern) - distance) < 1);
    const kml = createKml(createComparison(original, buffered));
    assert.ok(kml.includes(`Adjusted boundary (+${distance} m)`));
    assert.ok(kml.includes(`<Data name="buffer_m"><value>${distance}</value></Data>`));
  }
});

test('invalid buffer distances fail before reading or writing files', async () => {
  const original = collection(feature([square()]));
  for (const distance of [0, -1, NaN, Infinity, -Infinity, '500', null]) {
    assert.throws(() => bufferBoundary(original, distance), /positive, finite number of metres/);
  }
  for (const distance of ['0', '-1', 'NaN', 'Infinity', '-Infinity', 'abc', '', ' ']) {
    await assert.rejects(main(['unused.zip', `--buffer=${distance}`]), /positive, finite number of metres/);
  }
});

test('overlapping input polygons dissolve into one expanded area', () => {
  const input = collection(feature([square()]), feature([square(0, -0.01, 0.02, 0.01)]));
  const buffered = bufferBoundary(input);
  assert.equal(buffered.geometry.type, 'Polygon');
  assert.equal(buffered.geometry.coordinates.length, 1);
  assert.equal(input.features.length, 2);
  assert.deepEqual(input.features[0].properties, { label: 'test' });
});

test('buffer preserves disconnected polygons and shrinks surviving holes', () => {
  const input = collection(feature([
    [square(-0.15, -0.15, 0.15, 0.15), [...square(-0.08, -0.08, 0.08, 0.08)].reverse()],
    [square(0.5, 0.5, 0.52, 0.52)],
  ], 'MultiPolygon'));
  const buffered = bufferBoundary(input);
  const polygons = polygonsOf(buffered.geometry);
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
  const original = await readBoundary(source);
  const point = original.features[0].geometry.coordinates[0][0];
  assert.ok(Math.abs(point[0] + 0.15) < 1e-8);
  assert.ok(Math.abs(point[1] - 51.5) < 1e-8);
  const buffered = bufferBoundary(original);
  assert.ok(Math.max(...positionsOf(buffered.geometry).map((position) => position[1])) > 51.528);
});

test('missing components and ambiguous archives fail clearly', async () => {
  const bytes = await fixture([square()]);
  const files = unzipSync(bytes);
  for (const extension of ['SHP', 'SHX', 'DBF', 'PRJ']) {
    const incomplete = { ...files };
    delete incomplete[`nested/AREA.${extension}`];
    await assert.rejects(readBoundary(zipSync(incomplete)), /Missing or empty|exactly one/);
  }
  await assert.rejects(readBoundary(zipSync({ ...files, 'nested/AREA.CPG': new Uint8Array() })), /Missing or empty .cpg/);
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

test('KML includes styled original and adjusted boundaries, holes, multipart geometry, and escaped attributes', () => {
  const input = collection(feature([
    [square(-0.15, -0.15, 0.15, 0.15), [...square(-0.08, -0.08, 0.08, 0.08)].reverse()],
    [square(0.5, 0.5, 0.52, 0.52)],
  ], 'MultiPolygon'));
  input.features[0].properties = { 'label&"': '<site> & "field"' };
  const buffered = bufferBoundary(input);
  const comparison = createComparison(input, buffered);
  const kml = createKml(comparison);
  assert.match(kml, /xmlns="http:\/\/www.opengis.net\/kml\/2.2"/);
  assert.equal((kml.match(/<Placemark>/g) ?? []).length, 2);
  assert.equal((kml.match(/<MultiGeometry>/g) ?? []).length, 2);
  assert.equal((kml.match(/<innerBoundaryIs>/g) ?? []).length, 2);
  assert.match(kml, /<styleUrl>#original<\/styleUrl>/);
  assert.match(kml, /<styleUrl>#buffered<\/styleUrl>/);
  assert.match(kml, /<Data name="label&amp;&quot;"><value>&lt;site&gt; &amp; &quot;field&quot;<\/value><\/Data>/);
  assert.match(kml, /<Data name="buffer_m"><value>1000<\/value><\/Data>/);
  const coordinateLists = [...kml.matchAll(/<(outerBoundaryIs|innerBoundaryIs)><LinearRing><coordinates>([^<]+)<\/coordinates>/g)];
  assert.equal(coordinateLists.length, 6);
  for (const [index, [, boundary, text]] of coordinateLists.entries()) {
    const ring = text.split(' ').map((point) => point.split(',').map(Number));
    assert.ok(ring.every((point) => point.length === 3 && point.every(Number.isFinite) && point[2] === 0));
    assert.deepEqual(ring[0], ring.at(-1));
    const area = ring.slice(1).reduce((sum, point, i) =>
      sum + ring[i][0] * point[1] - point[0] * ring[i][1], 0);
    assert.equal(area > 0, boundary === 'outerBoundaryIs');
    const expected = positionsOf(comparison.features[index < 3 ? 1 : 0].geometry);
    for (const [longitude, latitude] of ring) {
      assert.ok(expected.some((point) => point[0] === longitude && point[1] === latitude));
    }
  }
});

test('CLI creates only KML, protects existing files, and reports errors', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'boundary-buffer-'));
  try {
    const output = join(temporary, 'results');
    const input = join(temporary, 'boundary.zip');
    await writeFile(input, await fixture([square()]));
    const args = [scriptPath, input, '--output', output, '--buffer', '250.5'];
    const run = (parameters) => spawnSync(process.execPath, parameters, { encoding: 'utf8', cwd: temporary });
    const first = run(args);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(await readdir(output), ['boundary-adjusted-boundary-250.5m.kml']);
    const kmlPath = join(output, 'boundary-adjusted-boundary-250.5m.kml');
    const kml = await readFile(kmlPath, 'utf8');
    assert.match(kml, /<styleUrl>#original<\/styleUrl>/);
    assert.match(kml, /<styleUrl>#buffered<\/styleUrl>/);
    assert.match(kml, /Adjusted boundary \(\+250\.5 m\)/);
    assert.match(kml, /<Data name="buffer_m"><value>250\.5<\/value><\/Data>/);
    assert.match(first.stdout, /outward by 250\.5 metres/);
    const coordinates = kml.match(/<styleUrl>#buffered<\/styleUrl>.*?<coordinates>([^<]+)<\/coordinates>/s)[1]
      .split(' ').map((point) => point.split(',').map(Number));
    const eastern = coordinates.reduce((best, point) => point[0] > best[0] ? point : best);
    assert.ok(Math.abs(haversine([0.01, eastern[1] >= 0 ? 0.01 : -0.01], eastern) - 250.5) < 1);
    assert.equal(run(args).status, 1);
    assert.equal(run([...args, '--overwrite']).status, 0);
    const differentBuffer = run([scriptPath, input, '--output', output, '--buffer', '500']);
    assert.equal(differentBuffer.status, 0, differentBuffer.stderr);
    assert.deepEqual((await readdir(output)).sort(), [
      'boundary-adjusted-boundary-250.5m.kml', 'boundary-adjusted-boundary-500m.kml',
    ]);
    assert.equal(await readFile(kmlPath, 'utf8'), kml);
    assert.equal(run([scriptPath, '--help']).status, 0);
    assert.equal(run([scriptPath]).status, 1);
    assert.equal(run([scriptPath, 'missing.zip']).status, 1);
    assert.equal(run([scriptPath, '--unknown']).status, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI defaults to the input directory and derives the KML name for absolute and relative paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'boundary-buffer-'));
  try {
    const source = await fixture([square()]);
    for (const useAbsolutePath of [true, false]) {
      const folder = useAbsolutePath ? 'absolute input' : 'relative input';
      const directory = join(temporary, folder);
      await mkdir(directory);
      const filename = 'my.boundary area.ZIP';
      const input = join(directory, filename);
      await writeFile(input, source);
      const args = [scriptPath, useAbsolutePath ? input : join(folder, filename)];
      const run = (parameters) => spawnSync(process.execPath, parameters, { encoding: 'utf8', cwd: temporary });
      const first = run(args);
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual((await readdir(directory)).sort(), [
        filename, 'my.boundary area-adjusted-boundary-1000m.kml',
      ].sort());
      const kml = await readFile(join(directory, 'my.boundary area-adjusted-boundary-1000m.kml'), 'utf8');
      assert.equal((kml.match(/<Placemark>/g) ?? []).length, 2);
      assert.match(kml, /<Data name="buffer_m"><value>1000<\/value><\/Data>/);
      const repeat = run(args);
      assert.equal(repeat.status, 1);
      assert.match(repeat.stderr, /my\.boundary area-adjusted-boundary-1000m\.kml already exists/);
      assert.equal(run([...args, '--overwrite']).status, 0);
      assert.deepEqual(new Uint8Array(await readFile(input)), source);
    }
    assert.deepEqual((await readdir(temporary)).sort(), ['absolute input', 'relative input']);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});