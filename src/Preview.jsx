import { useMemo, useState } from 'react';
import { previewPaths, PREVIEW_WIDTH, PREVIEW_HEIGHT } from './preview.js';

export default function Preview({ comparison }) {
	const [show, setShow] = useState({ original: true, buffered: true });
	const paths = useMemo(() => previewPaths(comparison), [comparison]);
	const toggle = (layer) => setShow((current) => ({ ...current, [layer]: !current[layer] }));
	return (
		<div className="preview">
			<div className="legend">
				<label><input type="checkbox" checked={show.original} onChange={() => toggle('original')} />
					<span className="swatch original" />Original boundary</label>
				<label><input type="checkbox" checked={show.buffered} onChange={() => toggle('buffered')} />
					<span className="swatch buffered" />Adjusted boundary</label>
			</div>
			<svg viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`} role="img" aria-label="Original and adjusted boundaries">
				{show.buffered && <g className="layer buffered">{paths.buffered.map((d, i) => <path key={i} d={d} />)}</g>}
				{show.original && <g className="layer original">{paths.original.map((d, i) => <path key={i} d={d} />)}</g>}
				<text x={PREVIEW_WIDTH - 44} y="36" textAnchor="middle" className="north">N ↑</text>
			</svg>
			<p className="note">Simple preview without a basemap. North is up. Open the KML in Google Earth or QGIS to see it on a map.</p>
		</div>
	);
}
