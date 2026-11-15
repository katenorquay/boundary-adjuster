import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join, dirname, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseZip } from 'shpjs';
import shpWrite from '@mapbox/shp-write';
import buffer from '@turf/buffer';
import union from '@turf/union';
import { featureCollection } from '@turf/helpers';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const DISTANCE_METRES = 1000;
const EXTENSIONS = ['shp', 'shx', 'dbf', 'prj', 'cpg'];
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

/** Read one polygon layer, requiring a CRS rather than guessing coordinate units. */
export async function readBoundary(bytes) {
	const entries = unzipSync(bytes);
	const files = new Map();
	for (const [name, content] of Object.entries(entries)) {
		if (name.split('/').includes('__MACOSX') || name.split('/').at(-1).startsWith('._')) continue;
		const key = name.toLowerCase();
		if (files.has(key)) throw new Error(`Duplicate ZIP entry (ignoring case): ${name}`);
		files.set(key, content);
	}
	const shapes = [...files.keys()].filter((name) => name.endsWith('.shp'));
	if (shapes.length !== 1) {
		throw new Error(`Expected exactly one shapefile layer in the ZIP; found ${shapes.length}.`);
	}
	const stem = shapes[0].slice(0, -4);
	const originalFiles = {};
	const normalizedFiles = {};
	for (const extension of EXTENSIONS) {
		const content = files.get(`${stem}.${extension}`);
		if (extension === 'cpg' && content === undefined) continue;
		if (!content?.length) throw new Error(`Missing or empty .${extension} file matching ${stem}.shp.`);
		originalFiles[`original.${extension}`] = content;
		normalizedFiles[`input.${extension}`] = content;
	}
	// parseZip rejects unknown projections; the object-based reader can silently
	// fall back to unprojected coordinates when a .prj cannot be parsed.
	const original = await parseZip(zipSync(normalizedFiles));
	validatePolygons(original);
	return { original, originalFiles };
}

function validatePolygons(collection) {
	if (!collection?.features?.length) throw new Error('The shapefile has no features.');
	const bounds = [Infinity, Infinity, -Infinity, -Infinity];
	for (const [index, feature] of collection.features.entries()) {
		const geometry = feature.geometry;
		if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
			throw new Error(`Feature ${index + 1} must be a Polygon or MultiPolygon, not ${geometry?.type ?? 'null'}.`);
		}
		const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
		if (!polygons.length) throw new Error(`Feature ${index + 1} has empty geometry.`);
		for (const polygon of polygons) {
			if (!polygon.length) throw new Error(`Feature ${index + 1} has an empty polygon.`);
			for (const ring of polygon) {
				if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
					throw new Error(`Feature ${index + 1} has a short or unclosed polygon ring.`);
				}
				for (const [longitude, latitude] of ring) {
					if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
							Math.abs(longitude) > 180 || Math.abs(latitude) >= 85) {
						throw new Error('Invalid coordinates after CRS conversion, or latitude outside supported range (-85°, 85°).');
					}
					bounds[0] = Math.min(bounds[0], longitude);
					bounds[1] = Math.min(bounds[1], latitude);
					bounds[2] = Math.max(bounds[2], longitude);
					bounds[3] = Math.max(bounds[3], latitude);
				}
			}
		}
	}
	if (bounds[2] - bounds[0] > 5 || bounds[3] - bounds[1] > 5) {
		throw new Error('Use a local/regional boundary spanning at most 5° per axis; global or antimeridian-crossing data is unsupported.');
	}
}

/** Dissolve internal borders, then expand the whole area (not a hollow ring). */
export function bufferBoundary(original) {
	validatePolygons(original);
	const dissolved = original.features.length === 1
		? original.features[0]
		: union(original);
	if (!dissolved) throw new Error('Could not dissolve the input polygons. Check their topology.');
	// Turf projects to a local azimuthal-equidistant CRS in metres before using
	// JSTS buffering, then transforms back to WGS84. Never buffer degree values.
	const buffered = buffer(dissolved, DISTANCE_METRES, { units: 'meters', steps: 64 });
	if (!buffered?.geometry) throw new Error('Buffering produced no geometry. Check the input polygons.');
	buffered.properties = { kind: 'buffered', buffer_m: DISTANCE_METRES };
	validatePolygons(featureCollection([buffered]));
	return buffered;
}

/** Shapefile exteriors must be clockwise; holes must be counterclockwise. */
function orientRing(ring, clockwise) {
	const area = ring.slice(1).reduce((sum, point, index) => {
		const previous = ring[index];
		return sum + previous[0] * point[1] - point[0] * previous[1];
	}, 0);
	return (area < 0) === clockwise ? ring : [...ring].reverse();
}

export async function createShapefileZip(originalFiles, buffered) {
	const polygons = buffered.geometry.type === 'Polygon'
		? [buffered.geometry.coordinates]
		: buffered.geometry.coordinates;
	const rings = polygons.flatMap((polygon) => polygon.map((ring, index) => orientRing(ring, index === 0)));
	// One multipart record avoids a writer limitation that can overwrite layers
	// when a collection mixes Polygon and MultiPolygon geometry types.
	const files = await new Promise((resolveFiles, reject) => {
		shpWrite.write([buffered.properties], 'POLYGON', [rings], (error, result) => {
			if (error) reject(error);
			else resolveFiles(result);
		});
	});
	return zipSync({
		...originalFiles,
		'buffered.shp': new Uint8Array(files.shp.buffer),
		'buffered.shx': new Uint8Array(files.shx.buffer),
		'buffered.dbf': new Uint8Array(files.dbf.buffer),
		'buffered.prj': strToU8(WGS84),
		'buffered.cpg': strToU8('UTF-8'),
	});
}

export function createComparison(original, buffered) {
	// Both layers here use WGS84. The original shapefile bytes in the ZIP retain
	// the source CRS and attributes, including their original character encoding.
	return featureCollection([
		...original.features.map((feature) => ({
			...feature,
			properties: { ...feature.properties, kind: 'original', buffer_m: 0 },
		})),
		buffered,
	]);
}

export function createKml(comparison) {
	validatePolygons(comparison);
	const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
	})[character]);
	const polygonXml = (polygon) => `<Polygon><altitudeMode>clampToGround</altitudeMode>${polygon.map((ring, index) => {
		const boundary = index === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs';
		const coordinates = orientRing(ring, index !== 0).map(([longitude, latitude]) => `${longitude},${latitude},0`).join(' ');
		return `<${boundary}><LinearRing><coordinates>${coordinates}</coordinates></LinearRing></${boundary}>`;
	}).join('')}</Polygon>`;
	const folders = [
		['buffered', 'Adjusted boundary (+1 km)'],
		['original', 'Original boundary'],
	].map(([kind, name]) => {
		const placemarks = comparison.features.filter((feature) => feature.properties.kind === kind).map((feature, index) => {
			const geometry = feature.geometry.type === 'Polygon'
				? polygonXml(feature.geometry.coordinates)
				: `<MultiGeometry>${feature.geometry.coordinates.map(polygonXml).join('')}</MultiGeometry>`;
			const data = Object.entries(feature.properties).map(([key, value]) =>
				`<Data name="${escapeXml(key)}"><value>${escapeXml(value)}</value></Data>`).join('');
			return `<Placemark><name>${escapeXml(name)} ${index + 1}</name><styleUrl>#${kind}</styleUrl><ExtendedData>${data}</ExtendedData>${geometry}</Placemark>`;
		}).join('\n');
		return `<Folder><name>${escapeXml(name)}</name>${placemarks}</Folder>`;
	}).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Original and adjusted boundaries</name>
<Style id="original"><LineStyle><color>ff537915</color><width>2</width></LineStyle><PolyStyle><color>66c5e4a7</color></PolyStyle></Style>
<Style id="buffered"><LineStyle><color>ffeb6325</color><width>2</width></LineStyle><PolyStyle><color>55faa560</color></PolyStyle></Style>
${folders}
</Document>
</kml>
`;
}

export function createPreview(comparison) {
	const polygonsOf = (geometry) => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
	const positions = comparison.features.flatMap((feature) => polygonsOf(feature.geometry).flat(2));
	let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
	for (const [longitude, latitude] of positions) {
		west = Math.min(west, longitude);
		south = Math.min(south, latitude);
		east = Math.max(east, longitude);
		north = Math.max(north, latitude);
	}
	// A local equirectangular view avoids stretching longitude at UK latitudes.
	// This is a display transform only, not the buffer calculation.
	const cosine = Math.cos((south + north) / 2 * Math.PI / 180);
	const scale = Math.min(880 / ((east - west) * cosine), 580 / (north - south));
	const x = (longitude) => (500 + (longitude - (west + east) / 2) * cosine * scale).toFixed(3);
	const y = (latitude) => (330 - (latitude - (south + north) / 2) * scale).toFixed(3);
	const paths = (kind) => comparison.features.filter((feature) => feature.properties.kind === kind)
		.map((feature) => `<path d="${polygonsOf(feature.geometry).map((polygon) => polygon.map((ring) =>
			ring.map(([longitude, latitude], index) => `${index ? 'L' : 'M'}${x(longitude)},${y(latitude)}`).join(' ') + ' Z'
		).join(' ')).join(' ')}"/>`).join('\n');
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Boundary comparison · 1 km buffer</title>
	<style>
		:root { font-family: system-ui, sans-serif; color: #172f42; background: #eef3f8; }
		body { max-width: 1120px; margin: auto; padding: 32px 20px; }
		h1 { margin-bottom: 8px; letter-spacing: -.04em; font-size: clamp(26px, 4vw, 40px); }
		p { color: #52677b; line-height: 1.6; }
		.card { background: white; border: 1px solid #d5e0eb; border-radius: 20px; overflow: hidden; box-shadow: 0 12px 40px #172f420c; }
		.controls { display: flex; flex-wrap: wrap; gap: 24px; padding: 20px 24px; border-bottom: 1px solid #e6edf4; }
		label { cursor: pointer; display: flex; align-items: center; gap: 8px; }
		input { accent-color: #2265cf; }
		.swatch { width: 14px; height: 14px; border-radius: 4px; background: #60a5fa; border: 2px solid #2563eb; }
		.green { background: #a7e4c5; border-color: #157953; }
		svg { display: block; width: 100%; background: #fbfdff; }
		path { stroke-width: 2; stroke-linejoin: round; fill-rule: evenodd; vector-effect: non-scaling-stroke; }
		#buffered { fill: #60a5fa55; stroke: #2563eb; }
		#original { fill: #a7e4c5b3; stroke: #157953; }
		.note { font-size: 13px; }
	</style>
</head>
<body>
	<h1>A little more room. Exactly 1 km requested.</h1>
	<p>The expanded area contains the original boundary plus a 1,000 metre outward buffer. Toggle either layer to compare.</p>
	<div class="card">
		<div class="controls">
			<label><input type="checkbox" checked data-layer="original"><span class="swatch green"></span>Original boundary</label>
			<label><input type="checkbox" checked data-layer="buffered"><span class="swatch"></span>Expanded boundary (+1 km)</label>
		</div>
		<svg viewBox="0 0 1000 660" role="img" aria-labelledby="map-title map-desc">
			<title id="map-title">Original and expanded boundaries</title>
			<desc id="map-desc">Green shows the original area; blue shows the area expanded by one kilometre. North is up.</desc>
			<g id="buffered">${paths('buffered')}</g>
			<g id="original">${paths('original')}</g>
			<text x="956" y="36" text-anchor="middle" fill="#52677b" font-size="16">N ↑</text>
		</svg>
	</div>
	<p class="note">Offline preview · no basemap or external services · local display projection, not a survey drawing.<br>
	Buffering uses a local spherical projection; distance accuracy is approximate. Blue also fills inward from hole edges, shrinking holes.</p>
	<script>
		for (const input of document.querySelectorAll('input[data-layer]')) {
			input.addEventListener('change', () => {
				document.getElementById(input.dataset.layer).style.display = input.checked ? '' : 'none';
			});
		}
	</script>
</body>
</html>`;
}

export async function main(args = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			output: { type: 'string', short: 'o' },
			overwrite: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (values.help) {
		console.log('Usage: node script.js <input.zip> [--output <directory>] [--overwrite]\n\nCreates one KML containing the original boundary and a 1,000 m outward buffer.\nDefaults to the input directory; file is named <input-name>-adjusted-boundary.kml.\nSee README.md.');
		return;
	}
	if (positionals.length !== 1) throw new Error('Provide exactly one input ZIP. Run node script.js --help for usage.');
	const input = resolve(positionals[0]);
	const directory = values.output === undefined ? dirname(input) : resolve(values.output);
	const output = join(directory, `${basename(input, extname(input))}-adjusted-boundary.kml`);
	if (!values.overwrite) {
		const exists = await access(output).then(() => true, (error) => {
			if (error.code === 'ENOENT') return false;
			throw error;
		});
		if (exists) throw new Error(`${output} already exists. Use --overwrite or choose another output directory.`);
	}
	const { original } = await readBoundary(await readFile(input));
	const buffered = bufferBoundary(original);
	const comparison = createComparison(original, buffered);
	const kml = createKml(comparison);
	await mkdir(directory, { recursive: true });
	await writeFile(output, kml, { flag: values.overwrite ? 'w' : 'wx' });
	console.log(`Created ${output}`);
	console.log(`Buffered ${original.features.length} original feature(s) outward by ${DISTANCE_METRES} metres.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`Error: ${error.message}`);
		process.exitCode = 1;
	});
}
