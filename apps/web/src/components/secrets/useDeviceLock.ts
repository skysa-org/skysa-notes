import { cell } from '@skysa/core';
import { useEffect, useState } from 'react';

import { BROWSER_DEVICE_LOCK, type DeviceLock } from '../../secrets/deviceLock.js';

/**
 * The device's own lock, and whether it is offered: asked as the dialog
 * opens, and not offered again once making a passkey found it cannot keep a
 * key in this browser.
 */
export const useDeviceLock = (given: DeviceLock | undefined) => {
	const deviceLock = given ?? BROWSER_DEVICE_LOCK;
	const [deviceOffered, setDeviceOffered] = useState(false);
	useEffect(() => {
		const open = cell(true);
		void deviceLock.offered().then((offered) => {
			if (open.current) setDeviceOffered(offered);
		});
		return () => {
			open.current = false;
		};
	}, [deviceLock]);
	return { deviceLock, deviceOffered, setDeviceOffered };
};
