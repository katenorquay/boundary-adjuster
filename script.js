import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join, dirname, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseZip } from 'shpjs';
import buffer from '@turf/buffer';
import union from '@turf/union';
import { featureCollection } from '@turf/helpers';
import { unzipSync, zipSync } from 'fflate';

const DEFAULT_DISTANCE_METRES = 1000;
const EXTENSIONS = ['shp', 'shx', 'dbf', 'prj', 'cpg'];

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
	const normalizedFiles = {};
	for (const extension of EXTENSIONS) {
		const content = files.get(`${stem}.${extension}`);
		if (extension === 'cpg' && content === undefined) continue;
		if (!content?.length) throw new Error(`Missing or empty .${extension} file matching ${stem}.shp.`);
		normalizedFiles[`input.${extension}`] = content;
	}
	// parseZip rejects unknown projections; the object-based reader can silently
	// fall back to unprojected coordinates when a .prj cannot be parsed.
	const original = await parseZip(zipSync(normalizedFiles));
	validatePolygons(original);
	return original;
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
export function bufferBoundary(original, distanceMetres = DEFAULT_DISTANCE_METRES) {
	validateDistance(distanceMetres);
	validatePolygons(original);
	const dissolved = original.features.length === 1
		? original.features[0]
		: union(original);
	if (!dissolved) throw new Error('Could not dissolve the input polygons. Check their topology.');
	// Turf projects to a local azimuthal-equidistant CRS in metres before using
	// JSTS buffering, then transforms back to WGS84. Never buffer degree values.
	const buffered = buffer(dissolved, distanceMetres, { units: 'meters', steps: 64 });
	if (!buffered?.geometry) throw new Error('Buffering produced no geometry. Check the input polygons.');
	buffered.properties = { kind: 'buffered', buffer_m: distanceMetres };
	validatePolygons(featureCollection([buffered]));
	return buffered;
}

function validateDistance(distanceMetres) {
	if (!Number.isFinite(distanceMetres) || distanceMetres <= 0) {
		throw new Error('Buffer distance must be a positive, finite number of metres.');
	}
}

function orientRing(ring, clockwise) {
	const area = ring.slice(1).reduce((sum, point, index) => {
		const previous = ring[index];
		return sum + previous[0] * point[1] - point[0] * previous[1];
	}, 0);
	return (area < 0) === clockwise ? ring : [...ring].reverse();
}

export function createComparison(original, buffered) {
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
		['buffered', 'Adjusted boundary'],
		['original', 'Original boundary'],
	].map(([kind, name]) => {
		const placemarks = comparison.features.filter((feature) => feature.properties.kind === kind).map((feature, index) => {
			const label = kind === 'buffered' ? `${name} (+${feature.properties.buffer_m} m)` : name;
			const geometry = feature.geometry.type === 'Polygon'
				? polygonXml(feature.geometry.coordinates)
				: `<MultiGeometry>${feature.geometry.coordinates.map(polygonXml).join('')}</MultiGeometry>`;
			const data = Object.entries(feature.properties).map(([key, value]) =>
				`<Data name="${escapeXml(key)}"><value>${escapeXml(value)}</value></Data>`).join('');
			return `<Placemark><name>${escapeXml(label)} ${index + 1}</name><styleUrl>#${kind}</styleUrl><ExtendedData>${data}</ExtendedData>${geometry}</Placemark>`;
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

export async function main(args = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			buffer: { type: 'string', default: String(DEFAULT_DISTANCE_METRES) },
			output: { type: 'string', short: 'o' },
			overwrite: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	if (values.help) {
		console.log(`Usage: node script.js <input.zip> [--buffer <metres>] [--output <directory>] [--overwrite]\n\nCreates one KML containing the original boundary and an outward buffer.\n--buffer must be a positive, finite number of metres (default: ${DEFAULT_DISTANCE_METRES}).\nDefaults to the input directory; file is named <input-name>-adjusted-boundary-<metres>m.kml.\nSee README.md.`);
		return;
	}
	if (positionals.length !== 1) throw new Error('Provide exactly one input ZIP. Run node script.js --help for usage.');
	const distanceMetres = Number(values.buffer);
	validateDistance(distanceMetres);
	const input = resolve(positionals[0]);
	const directory = values.output === undefined ? dirname(input) : resolve(values.output);
	const output = join(directory, `${basename(input, extname(input))}-adjusted-boundary-${distanceMetres}m.kml`);
	if (!values.overwrite) {
		const exists = await access(output).then(() => true, (error) => {
			if (error.code === 'ENOENT') return false;
			throw error;
		});
		if (exists) throw new Error(`${output} already exists. Use --overwrite or choose another output directory.`);
	}
	const original = await readBoundary(await readFile(input));
	const buffered = bufferBoundary(original, distanceMetres);
	const comparison = createComparison(original, buffered);
	const kml = createKml(comparison);
	await mkdir(directory, { recursive: true });
	await writeFile(output, kml, { flag: values.overwrite ? 'w' : 'wx' });
	console.log(`Created ${output}`);
	console.log(`Buffered ${original.features.length} original feature(s) outward by ${distanceMetres} metres.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(`Error: ${error.message}`);
		process.exitCode = 1;
	});
}
