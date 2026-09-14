import { createApp } from './app.js'
import { parseEnv } from './env.js'

/**
 * The default Worker entry: the only module in `apps/api` that reads the
 * environment. An operator who needs different behavior writes their own entry
 * that imports `createApp` and passes its own seams, instead of forking.
 */

let app: ReturnType<typeof createApp> | undefined
let configError: Error | undefined

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (!app && !configError) {
      try {
        app = createApp({ config: parseEnv(env) })
      } catch (err) {
        configError = err instanceof Error ? err : new Error(String(err))
      }
    }
    if (configError) {
      // Misconfiguration is an operator problem, not a user one: log the detail
      // and return something generic.
      console.error(configError.message)
      return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    return app!.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
