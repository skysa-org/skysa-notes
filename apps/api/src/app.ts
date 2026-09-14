import { Hono } from 'hono'
import { alwaysAllowed, type EntitlementProvider } from '@skysa/core'
import { createDb, type Database } from './db/client.js'
import type { AppConfig } from './env.js'

export type Bindings = {
  DB: D1Database
}

export type Variables = {
  db: Database
  config: AppConfig
  entitlements: EntitlementProvider
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }

export interface CreateAppOptions {
  config: AppConfig
  /**
   * Who may mint tokens or use the WebDAV proxy. Defaults to `alwaysAllowed`;
   * operators of a shared instance substitute their own here instead of forking.
   */
  entitlements?: EntitlementProvider
  // `identityProviders` joins this signature with the account-first login routes
  // in Phase 9 (docs/PLAN.md §10).
}

/**
 * The composition root. Nothing under `apps/api` reads the environment — every
 * deployment-specific value arrives here. `src/worker.ts` is the default caller.
 */
export function createApp(options: CreateAppOptions) {
  const { config, entitlements = alwaysAllowed } = options

  const app = new Hono<AppEnv>().basePath('/api')

  app.use('*', async (c, next) => {
    c.set('db', createDb(c.env.DB))
    c.set('config', config)
    c.set('entitlements', entitlements)
    await next()
  })

  app.get('/health', (c) => c.json({ ok: true }))

  /**
   * What this instance offers. The client uses it to decide which connect
   * buttons to show. Contains no secrets.
   */
  app.get('/config', (c) =>
    c.json({
      authMode: config.authMode,
      providers: config.enabledProviders,
    }),
  )

  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
