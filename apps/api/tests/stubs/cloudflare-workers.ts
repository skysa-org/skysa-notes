/**
 * `cloudflare:workers` for the tests, which run on Node. Only `DurableObject`,
 * and only what a subclass reaches through it.
 */
export class DurableObject<Env = unknown> {
	constructor(
		protected readonly ctx: DurableObjectState,
		protected readonly env: Env
	) {}
}
