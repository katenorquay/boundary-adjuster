import { useDeferredValue, useMemo, useState } from 'react';
import {
	DEFAULT_DISTANCE_METRES, readBoundary, bufferBoundary, createComparison, createKml, kmlFileName, validateDistance,
} from './core.js';
import Preview from './Preview.jsx';

function download(kml, filename) {
	const url = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
	const link = Object.assign(document.createElement('a'), { href: url, download: filename });
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export default function App() {
	const [fileName, setFileName] = useState('');
	const [original, setOriginal] = useState(null);
	const [loadError, setLoadError] = useState('');
	const [loading, setLoading] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [distanceText, setDistanceText] = useState(String(DEFAULT_DISTANCE_METRES));
	const distanceDeferred = useDeferredValue(distanceText);

	async function loadFile(file) {
		if (!file) return;
		setFileName(file.name);
		setOriginal(null);
		setLoadError('');
		if (!file.name.toLowerCase().endsWith('.zip')) {
			setLoadError('Please choose a .zip file containing a polygon shapefile.');
			return;
		}
		setLoading(true);
		try {
			setOriginal(await readBoundary(new Uint8Array(await file.arrayBuffer())));
		} catch (error) {
			setLoadError(error.message);
		} finally {
			setLoading(false);
		}
	}

	const result = useMemo(() => {
		if (!original) return null;
		try {
			const distance = distanceDeferred.trim() === '' ? NaN : Number(distanceDeferred);
			validateDistance(distance);
			const comparison = createComparison(original, bufferBoundary(original, distance));
			return { comparison, kml: createKml(comparison), filename: kmlFileName(fileName, distance), distance };
		} catch (error) {
			return { error: error.message };
		}
	}, [original, distanceDeferred, fileName]);

	return (
		<main>
			<h1>Boundary adjuster</h1>
			<p className="intro">
				Drop in a zipped polygon shapefile, choose how far to expand it, preview the result and download a KML.
				Your file is processed in your browser and is never uploaded.
			</p>

			<label
				className={`dropzone${dragging ? ' dragging' : ''}`}
				onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					loadFile(event.dataTransfer.files[0]);
				}}
			>
				<input type="file" accept=".zip,application/zip" onChange={(event) => { loadFile(event.target.files[0]); event.target.value = ''; }} />
				<strong>{fileName || 'Drag a .zip file here'}</strong>
				<span>{loading ? 'Reading…' : 'or click to choose a file'}</span>
			</label>
			{loadError && <p className="error" role="alert">{loadError}</p>}

			<div className="controls">
				<label htmlFor="distance">Buffer distance (metres)</label>
				<input
					id="distance"
					type="number"
					inputMode="decimal"
					min="0"
					step="any"
					value={distanceText}
					onChange={(event) => setDistanceText(event.target.value)}
				/>
				<button type="button" disabled={!result?.kml} onClick={() => download(result.kml, result.filename)}>
					Download KML
				</button>
			</div>

			{result?.error && <p className="error" role="alert">{result.error}</p>}
			{result?.comparison && (
				<>
					<p className="summary">
						{original.features.length} original feature{original.features.length === 1 ? '' : 's'} expanded by {result.distance} m
						<span> · {result.filename}</span>
					</p>
					<Preview comparison={result.comparison} />
				</>
			)}
		</main>
	);
}
