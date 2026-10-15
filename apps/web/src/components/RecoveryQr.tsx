import { encode } from 'uqr';

import { t } from '../i18n/t.js';

/**
 * The recovery key as a QR code (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"), shown and printed beside its groups, for a device being set up to
 * read with its camera (`ScanKey`) rather than have typed. It holds the key as
 * age writes it, `AGE-SECRET-KEY-1…`, and nothing else: no address, so a phone
 * that reads it with its own camera shows the key and sends it nowhere.
 *
 * Dark squares on white whatever the theme, with the quiet zone of four
 * modules a reader looks for around them; medium error correction, so a crease
 * or a smudge on the printed page still reads.
 */
export const RecoveryQr = ({ text }: { text: string }) => {
	const { data, size } = encode(text, { ecc: 'M', border: 4 });
	const squares = data
		.flatMap((row, y) =>
			row.flatMap((dark, x) => (dark ? [`M${String(x)} ${String(y)}h1v1h-1z`] : []))
		)
		.join('');
	const box = String(size);
	return (
		<svg
			className="recovery-qr"
			role="img"
			aria-label={t('secrets.key.qr')}
			viewBox={`0 0 ${box} ${box}`}
			shapeRendering="crispEdges"
		>
			<rect width={box} height={box} fill="#fff" />
			<path d={squares} fill="#000" />
		</svg>
	);
};
