// Runs in the page before the app (`context.addInitScript`). Records what a
// scenario reads back through `window.__perf`: long tasks, frame intervals,
// slow input events, and how many IndexedDB rows the app read and wrote.
(() => {
	const perf = {
		since: 0,
		longtasks: [],
		events: [],
		idb: { reads: {}, rows: 0, writes: 0 },
		frames: [],
		framing: false,
	};
	window.__perf = perf;

	const observe = (type, into, options = {}) => {
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) into(entry);
			}).observe({ type, buffered: true, ...options });
		} catch {
			// Not in this browser.
		}
	};
	observe('longtask', (entry) =>
		perf.longtasks.push({ start: entry.startTime, duration: entry.duration })
	);
	observe(
		'event',
		(entry) =>
			perf.events.push({
				name: entry.name,
				start: entry.startTime,
				duration: entry.duration,
			}),
		{ durationThreshold: 16 }
	);

	// When a touch, and text put into a field, first reached the page: the
	// start of what the app does about it. The harness sets each to null
	// before it acts, and reads it after.
	perf.touched = null;
	perf.typed = null;
	for (const type of ['touchstart', 'pointerdown']) {
		addEventListener(
			type,
			(event) => {
				perf.touched ??= event.timeStamp;
			},
			{ capture: true, passive: true }
		);
	}
	addEventListener(
		'input',
		(event) => {
			perf.typed ??= event.timeStamp;
		},
		{ capture: true, passive: true }
	);

	// IndexedDB: rows read per store, and writes.
	const count = (store, rows) => {
		perf.idb.reads[store] = (perf.idb.reads[store] ?? 0) + rows;
		perf.idb.rows += rows;
	};
	const storeName = (source) =>
		source instanceof IDBIndex ? source.objectStore.name : source.name;
	for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype]) {
		for (const method of ['get', 'getAll', 'getAllKeys', 'getKey', 'count']) {
			const original = proto[method];
			if (typeof original !== 'function') continue;
			proto[method] = function (...args) {
				const request = original.apply(this, args);
				const name = storeName(this);
				request.addEventListener('success', () => {
					const { result } = request;
					if (method === 'count') return;
					count(
						name,
						Array.isArray(result) ? result.length : result === undefined ? 0 : 1
					);
				});
				return request;
			};
		}
		for (const method of ['openCursor', 'openKeyCursor']) {
			const original = proto[method];
			proto[method] = function (...args) {
				const request = original.apply(this, args);
				const name = storeName(this);
				request.addEventListener('success', () => {
					if (request.result) count(name, 1);
				});
				return request;
			};
		}
	}
	for (const method of ['put', 'add', 'delete']) {
		const original = IDBObjectStore.prototype[method];
		IDBObjectStore.prototype[method] = function (...args) {
			perf.idb.writes += 1;
			performance.mark(`idb:${method}:${this.name}`);
			return original.apply(this, args);
		};
	}

	perf.reset = () => {
		perf.since = performance.now();
		perf.longtasks = perf.longtasks.filter((task) => task.start + task.duration > perf.since);
		perf.events = [];
		perf.idb = { reads: {}, rows: 0, writes: 0 };
	};

	perf.frames = [];
	perf.startFrames = () => {
		perf.frames = [];
		perf.framing = true;
		let last = performance.now();
		const tick = (now) => {
			if (!perf.framing) return;
			perf.frames.push(now - last);
			last = now;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	};
	perf.stopFrames = () => {
		perf.framing = false;
		return perf.frames;
	};

	/** Resolves after the frame that follows `test()` turning true, with the time it did; or null at `timeout`. */
	perf.until = (test, timeout = 60_000) =>
		new Promise((resolve) => {
			const start = performance.now();
			const check = () => {
				if (test()) {
					requestAnimationFrame(() => {
						const channel = new MessageChannel();
						channel.port1.onmessage = () => resolve(performance.now());
						channel.port2.postMessage(null);
					});
					return true;
				}
				return false;
			};
			if (check()) return;
			const observer = new MutationObserver(() => {
				if (check()) {
					observer.disconnect();
					clearInterval(poll);
				}
			});
			observer.observe(document, { subtree: true, childList: true, attributes: true });
			const poll = setInterval(() => {
				if (check() || performance.now() - start > timeout) {
					observer.disconnect();
					clearInterval(poll);
					if (performance.now() - start > timeout) resolve(null);
				}
			}, 50);
		});

	/** Resolves once no long task has ended for `quiet` ms, with the end of the last one. */
	perf.quiet = (quiet = 1_000, timeout = 60_000) =>
		new Promise((resolve) => {
			const start = performance.now();
			const poll = setInterval(() => {
				const now = performance.now();
				const last = perf.longtasks.reduce(
					(end, task) => Math.max(end, task.start + task.duration),
					perf.since
				);
				if (now - last >= quiet || now - start > timeout) {
					clearInterval(poll);
					resolve(last);
				}
			}, 100);
		});

	perf.summary = () => {
		const tasks = perf.longtasks.filter((task) => task.start + task.duration > perf.since);
		return {
			tbt: tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
			longest: tasks.reduce((most, task) => Math.max(most, task.duration), 0),
			longtasks: tasks.length,
			idbRows: perf.idb.rows,
			idbNotes: perf.idb.reads.notes ?? 0,
			idbWrites: perf.idb.writes,
			nodes: document.getElementsByTagName('*').length,
		};
	};
})();
