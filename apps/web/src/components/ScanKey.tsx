import { cell } from '@skysa/core';
import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';

/** What a frame of the camera says, where a QR code is in it. */
type ReadFrame = (video: HTMLVideoElement) => string | undefined;

/** The camera, and how its frames are read. */
export interface Scanner {
	readonly camera: () => Promise<MediaStream>;
	readonly reader: () => Promise<ReadFrame>;
}

/** The widest a frame is read at: a code held up to the camera fills enough of it, and more only takes longer. */
const FRAME_WIDTH = 640;

/** How often a frame is read. */
const EVERY_MS = 150;

/**
 * jsQR, loaded only as a scan begins: it is no part of the app until a key is
 * scanned. Pure JavaScript, so nothing for the CSP (§9); the browser's own
 * `BarcodeDetector` is on some devices and not others.
 */
const loadJsqr = () => import('jsqr');

/** jsQR, over each frame drawn small on a canvas of its own. */
const jsqrReader = async (): Promise<ReadFrame> => {
	const { default: jsQR } = await loadJsqr();
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d', { willReadFrequently: true });
	return (video) => {
		if (context === null || video.videoWidth === 0) return undefined;
		const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
		const width = Math.round(video.videoWidth * scale);
		const height = Math.round(video.videoHeight * scale);
		canvas.setAttribute('width', String(width));
		canvas.setAttribute('height', String(height));
		context.drawImage(video, 0, 0, width, height);
		const { data } = context.getImageData(0, 0, width, height);
		return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data;
	};
};

/**
 * The browser's camera, where the page may ask for one — the one facing away,
 * on a phone — or none: a page served over plain HTTP has no `mediaDevices`.
 */
export const browserScanner = (): Scanner | undefined => {
	if (typeof navigator === 'undefined' || !('mediaDevices' in navigator)) return undefined;
	const devices = navigator.mediaDevices;
	return {
		camera: () => devices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }),
		reader: jsqrReader,
	};
};

type Said = 'scanning' | 'notKey' | 'refused' | 'noCamera';

const SAID: Readonly<Record<Said, () => string>> = {
	scanning: () => t('secrets.recovery.scanning'),
	notKey: () => t('secrets.recovery.notKeyCode'),
	refused: () => t('secrets.recovery.cameraRefused'),
	noCamera: () => t('secrets.recovery.noCamera'),
};

export interface ScanKeyProps {
	readonly scanner: Scanner;
	/**
	 * Whether what a code says is what is wanted. Where it is, it is taken,
	 * and the camera let go of; where not, the scan goes on, and says so.
	 */
	readonly accept: (text: string) => boolean;
	/** Cancel scanning, or Escape: the camera let go of, and the key typed instead. */
	readonly onCancel: () => void;
}

/**
 * A recovery key read from its QR code with the camera (docs/ARCHITECTURE.md
 * §7, "Secrets in a note"): the printed page's, or another device's screen.
 * The frames are read on the device and go nowhere, and the camera is let go
 * of as soon as a key is read, or the scan is cancelled, or this goes.
 */
export const ScanKey = ({ scanner, accept, onCancel }: ScanKeyProps) => {
	const box = useRef<HTMLDivElement>(null);
	const video = useRef<HTMLVideoElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const [said, setSaid] = useState<Said>('scanning');
	// The latest of each, for the scan begun once.
	const latest = useRef({ accept, onCancel });
	useEffect(() => {
		latest.current = { accept, onCancel };
	});

	useEffect(() => {
		const gone = cell(false);
		// Asked as a call: whether this went is not known until it is asked.
		const ended = () => gone.current;
		const stream = cell<MediaStream | undefined>(undefined);
		const timer = cell<number | undefined>(undefined);
		const letGo = () => {
			window.clearInterval(timer.current);
			stream.current?.getTracks().forEach((track) => {
				track.stop();
			});
			stream.current = undefined;
		};
		const begin = async () => {
			const got = await scanner.camera();
			stream.current = got;
			const element = video.current;
			if (ended() || element === null) {
				letGo();
				return;
			}
			element.srcObject = got;
			const read = await scanner.reader();
			if (ended()) return;
			timer.current = window.setInterval(() => {
				const text = read(element);
				if (text === undefined) return;
				if (latest.current.accept(text)) {
					letGo();
					return;
				}
				setSaid('notKey');
			}, EVERY_MS);
		};
		void begin().catch((error: unknown) => {
			letGo();
			if (ended()) return;
			const refused =
				error instanceof DOMException &&
				(error.name === 'NotAllowedError' || error.name === 'SecurityError');
			setSaid(refused ? 'refused' : 'noCamera');
		});
		return () => {
			gone.current = true;
			letGo();
		};
	}, [scanner]);

	// Its own way out first: a listener, as an inline question's is, so the
	// dialog it is in does not take Escape for its own Cancel.
	useEffect(() => {
		const element = box.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			latest.current.onCancel();
		};
		element.addEventListener('keydown', onKey);
		cancel.current?.focus();
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, []);

	const failed = said === 'refused' || said === 'noCamera';
	return (
		<div ref={box} className="scan-key">
			<video
				ref={video}
				className="scan-key-video"
				hidden={failed}
				autoPlay
				muted
				playsInline
				aria-hidden="true"
			/>
			<p className="scan-key-said" role="status">
				{SAID[said]()}
			</p>
			<button ref={cancel} type="button" onClick={onCancel}>
				{t('secrets.recovery.scanCancel')}
			</button>
		</div>
	);
};
