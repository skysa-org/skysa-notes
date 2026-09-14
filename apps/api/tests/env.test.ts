import { describe, expect, it } from 'vitest'
import { parseEnv } from '../src/env.js'

const base = {
  APP_ORIGIN: 'https://notes.example.com',
  SECRETS_KEY: 'SGVsbG8gdGhlcmUsIHRoaXMgaXMgMzIgYnl0ZXMh',
}

describe('parseEnv', () => {
  it('defaults to storage-first with all providers enabled', () => {
    const config = parseEnv({
      ...base,
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'gs',
      MICROSOFT_CLIENT_ID: 'm',
      MICROSOFT_CLIENT_SECRET: 'ms',
      DROPBOX_CLIENT_ID: 'd',
      DROPBOX_CLIENT_SECRET: 'ds',
    })
    expect(config.authMode).toBe('storage-first')
    expect(config.enabledProviders).toEqual(['gdrive', 'onedrive', 'dropbox', 'webdav'])
    expect(config.secretsKeyId).toBe('k1')
    expect(config.webdavAllowPrivate).toBe(false)
  })

  it('parses ENABLED_PROVIDERS and ignores whitespace', () => {
    const config = parseEnv({
      ...base,
      ENABLED_PROVIDERS: ' webdav , dropbox ',
      DROPBOX_CLIENT_ID: 'd',
      DROPBOX_CLIENT_SECRET: 'ds',
    })
    expect(config.enabledProviders).toEqual(['webdav', 'dropbox'])
  })

  it('only builds OAuth credentials for enabled providers', () => {
    const config = parseEnv({
      ...base,
      ENABLED_PROVIDERS: 'dropbox',
      DROPBOX_CLIENT_ID: 'd',
      DROPBOX_CLIENT_SECRET: 'ds',
      // Present but unused: gdrive is not enabled.
      GOOGLE_CLIENT_ID: 'g',
      GOOGLE_CLIENT_SECRET: 'gs',
    })
    expect(config.oauth.dropbox).toEqual({ clientId: 'd', clientSecret: 'ds' })
    expect(config.oauth.gdrive).toBeUndefined()
  })

  it('requires credentials for each enabled OAuth provider', () => {
    expect(() => parseEnv({ ...base, ENABLED_PROVIDERS: 'gdrive' })).toThrow(
      /GOOGLE_CLIENT_ID: required because ENABLED_PROVIDERS includes "gdrive"/,
    )
  })

  it('needs no credentials for a webdav-only instance', () => {
    const config = parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav' })
    expect(config.oauth).toEqual({})
  })

  it('rejects an unknown provider', () => {
    expect(() => parseEnv({ ...base, ENABLED_PROVIDERS: 'icloud' })).toThrow(/ENABLED_PROVIDERS/)
  })

  it('rejects an empty provider list', () => {
    expect(() => parseEnv({ ...base, ENABLED_PROVIDERS: '' })).toThrow(/at least one provider/)
  })

  it('requires a sign-in provider in account-first mode', () => {
    expect(() =>
      parseEnv({
        ...base,
        AUTH_MODE: 'account-first',
        ENABLED_PROVIDERS: 'webdav',
      }),
    ).toThrow(/account-first requires a sign-in provider/)
  })

  it('accepts account-first when Microsoft credentials are present', () => {
    const config = parseEnv({
      ...base,
      AUTH_MODE: 'account-first',
      ENABLED_PROVIDERS: 'webdav',
      MICROSOFT_CLIENT_ID: 'm',
      MICROSOFT_CLIENT_SECRET: 'ms',
    })
    expect(config.authMode).toBe('account-first')
  })

  it('reads WEBDAV_ALLOW_PRIVATE as a string flag', () => {
    expect(
      parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', WEBDAV_ALLOW_PRIVATE: 'true' })
        .webdavAllowPrivate,
    ).toBe(true)
    expect(
      parseEnv({ ...base, ENABLED_PROVIDERS: 'webdav', WEBDAV_ALLOW_PRIVATE: 'false' })
        .webdavAllowPrivate,
    ).toBe(false)
  })

  it('rejects a missing or malformed APP_ORIGIN', () => {
    expect(() => parseEnv({ SECRETS_KEY: 'x', ENABLED_PROVIDERS: 'webdav' })).toThrow(/APP_ORIGIN/)
    expect(() => parseEnv({ ...base, APP_ORIGIN: 'notaurl', ENABLED_PROVIDERS: 'webdav' })).toThrow(
      /APP_ORIGIN/,
    )
  })

  it('strips a trailing slash from APP_ORIGIN so redirect URIs concatenate cleanly', () => {
    const config = parseEnv({
      ...base,
      APP_ORIGIN: 'https://notes.example.com/',
      ENABLED_PROVIDERS: 'webdav',
    })
    expect(config.appOrigin).toBe('https://notes.example.com')
  })

  it('lists every problem at once', () => {
    try {
      parseEnv({ ENABLED_PROVIDERS: 'gdrive' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('APP_ORIGIN')
      expect(message).toContain('SECRETS_KEY')
      expect(message).toContain('GOOGLE_CLIENT_ID')
    }
  })
})
