/**
 * What a deployment's own Worker entry builds on (docs/self-hosting.md): the
 * server is the kit's (`@skysa/server`), and these are the names this package
 * has always offered for it, so an entry written against them builds unchanged.
 */

export {
	type App,
	type AppConfig,
	type AppEnv,
	type AuthedEnv,
	type Bindings,
	createApp,
	type CreateAppOptions,
	envWarnings,
	misconfigured,
	parseEnv,
	type Variables,
} from '@skysa/server';
