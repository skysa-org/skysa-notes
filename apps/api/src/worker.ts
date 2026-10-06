import { createApp } from './app.js';
import { parseEnv } from './env.js';
import { durableObjectRelay } from './relay/durableObject.js';

/** The change relay's Durable Object, which the runtime finds by this export. */
export { ConnectionRelay } from './relay/durableObject.js';

/**
 * The default Worker entry: the only module in `apps/api` that reads the
 * environment. An operator who needs different behavior writes their own entry
 * that imports `createApp` and passes its own seams, instead of forking.
 */

type AppOrError = ReturnType<typeof createApp> | Error;

/**
 * Built once per isolate. A Map rather than a mutable binding so the cache is an
 * explicit, single-purpose piece of state rather than ambient module mutation.
 */
const cache = new Map<'singleton', AppOrError>();

/**
 * The relay's binding is declared in wrangler.toml whether or not it is used,
 * but a deployment can drop it; the generated `Env` cannot know that.
 */
type WorkerEnv = Omit<Env, 'RELAY_HUB'> & { RELAY_HUB?: Env['RELAY_HUB'] };

const build = (env: WorkerEnv): AppOrError => {
	try {
		const config = parseEnv(env);
		if (config.relay && env.RELAY_HUB === undefined) {
			// The same shape as `parseEnv`'s refusals, so the operator reads one kind
			// of message for every way the environment is wrong.
			throw new Error(
				'Invalid environment:\n  RELAY: true, but the RELAY_HUB Durable Object binding ' +
					'is missing from wrangler.toml (docs/self-hosting.md)'
			);
		}
		return createApp({
			config,
			...(config.relay && env.RELAY_HUB !== undefined
				? { relay: durableObjectRelay(env.RELAY_HUB) }
				: {}),
		});
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
};

const appFor = (env: WorkerEnv): AppOrError => {
	const cached = cache.get('singleton');
	if (cached !== undefined) return cached;

	const built = build(env);
	cache.set('singleton', built);
	return built;
};

export default {
	fetch: (
		request: Request,
		env: WorkerEnv,
		ctx: ExecutionContext
	): Response | Promise<Response> => {
		const app = appFor(env);

		if (app instanceof Error) {
			// Misconfiguration is an operator problem, not a user one: log the detail
			// and return something generic.
			console.error(app.message);
			return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
				status: 500,
				headers: { 'content-type': 'application/json' },
			});
		}

		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<WorkerEnv>;
