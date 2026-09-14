import { createApp } from './app.js';
import { parseEnv } from './env.js';

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

const build = (env: Env): AppOrError => {
	try {
		return createApp({ config: parseEnv(env) });
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
};

const appFor = (env: Env): AppOrError => {
	const cached = cache.get('singleton');
	if (cached !== undefined) return cached;

	const built = build(env);
	cache.set('singleton', built);
	return built;
};

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => {
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
} satisfies ExportedHandler<Env>;
