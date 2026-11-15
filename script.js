import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
	DEFAULT_DISTANCE_METRES, readBoundary, bufferBoundary, createComparison, createKml, validateDistance, kmlFileName,
} from './src/core.js';

export { readBoundary, bufferBoundary, createComparison, createKml };

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
	const output = join(directory, kmlFileName(basename(input), distanceMetres));
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
