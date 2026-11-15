const polygonsOf = (geometry) => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

export const PREVIEW_WIDTH = 1000;
export const PREVIEW_HEIGHT = 660;

/** SVG path data per layer, using a local equirectangular display projection (north up). */
export function previewPaths(comparison) {
	let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
	for (const feature of comparison.features) {
		for (const [longitude, latitude] of polygonsOf(feature.geometry).flat(2)) {
			west = Math.min(west, longitude);
			south = Math.min(south, latitude);
			east = Math.max(east, longitude);
			north = Math.max(north, latitude);
		}
	}
	// Longitude degrees shrink with latitude; this keeps shapes undistorted for a local area.
	const cosine = Math.cos((south + north) / 2 * Math.PI / 180);
	const width = Math.max((east - west) * cosine, 1e-9);
	const height = Math.max(north - south, 1e-9);
	const scale = Math.min((PREVIEW_WIDTH - 80) / width, (PREVIEW_HEIGHT - 80) / height);
	const x = (longitude) => (PREVIEW_WIDTH / 2 + (longitude - (west + east) / 2) * cosine * scale).toFixed(2);
	const y = (latitude) => (PREVIEW_HEIGHT / 2 - (latitude - (south + north) / 2) * scale).toFixed(2);
	const pathsFor = (kind) => comparison.features
		.filter((feature) => feature.properties.kind === kind)
		.map((feature) => polygonsOf(feature.geometry).map((polygon) => polygon.map((ring) =>
			ring.map(([longitude, latitude], index) => `${index ? 'L' : 'M'}${x(longitude)},${y(latitude)}`).join(' ') + ' Z'
		).join(' ')).join(' '));
	return { original: pathsFor('original'), buffered: pathsFor('buffered') };
}
