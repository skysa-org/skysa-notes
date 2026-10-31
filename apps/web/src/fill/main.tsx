// First: before any module that builds a zod schema (see the module).
import '../jitless.js';
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { StaleTabGate } from '../components/shell/StaleTabGate.js';
import { openChannel } from './channel.js';
import { FillPage } from './FillPage.js';

/**
 * The fill window's page, `fill.html` (docs/ARCHITECTURE.md §7, "Filling in
 * on a site", and §8): a page of the app's own beside the app, with nothing
 * of the app's sync, router or editors. It opens the app's database as the
 * app does (`store/db.ts`), so a window from another build gives way to a
 * newer one as a tab of the app does (`StaleTabGate`).
 */

// Before anything is drawn: the page's answer to `ready` must have something
// to hear it (`channel.ts`).
const channel = openChannel(window);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from fill.html');

createRoot(rootElement).render(
	<StrictMode>
		<StaleTabGate>
			<FillPage channel={channel} />
		</StaleTabGate>
	</StrictMode>
);
