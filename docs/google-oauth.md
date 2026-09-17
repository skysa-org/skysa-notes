# Google Drive: setting up Google OAuth

For operators enabling `gdrive` in `ENABLED_PROVIDERS`. It covers the Google Cloud project, the OAuth client, and what "Testing" and "In production" mean for the people connecting.

Google's console is renamed and rearranged often. What follows names things as the Google Auth Platform showed them when this was written (September 2026). If a label has moved, the linked Google pages are the authority.

## What the app asks for

| Scope | Why | Google's classification |
|---|---|---|
| `openid`, `email` | An ID token naming the account (`sub`) and an address to show for the connection | Basic sign-in scopes |
| `https://www.googleapis.com/auth/drive.file` | Files the app creates, which is only its own `skysa-notes` folder and what is in it | Non-sensitive ([Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)) |

Nothing sensitive or restricted is requested, so no security assessment (CASA) applies.

Under `drive.file` the app **cannot see files it did not create**. Notes put into the `skysa-notes` folder through the Drive website or another tool don't sync. Notes made by this app, on any device connected to the same deployment, do.

## 1. Project and API

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/), or pick one.
2. Enable the **Google Drive API** (APIs & Services → Library).

## 2. Consent screen (Google Auth Platform)

1. **Branding:**
   - Set the app name to what your users should see (the app folder it makes in Drive is always `skysa-notes`).
   - Add a support email.
   - Add your home page, privacy policy and terms URLs if you have them.
   - Add the domain of `APP_ORIGIN` under authorised domains.
2. **Audience:**
   - Choose **External**, unless everyone who will connect is in your own Google Workspace organisation. In that case **Internal** avoids everything under "Testing" below.
3. **Data access:** add the three scopes in the table above.

## 3. OAuth client

1. **Clients → Create client**, type **Web application**.
2. Authorised redirect URI: `<APP_ORIGIN>/api/auth/connect/gdrive/callback`, for example `https://notes.example.com/api/auth/connect/gdrive/callback`. For local development, add `http://localhost:5173/api/auth/connect/gdrive/callback` as well.
3. No JavaScript origins are needed. The browser never talks to Google's token endpoint; the exchange happens on this server, with the secret.
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, using `wrangler secret put` in production or `apps/api/.dev.vars` locally.

## Testing: the trap

A new External app starts with the publishing status **Testing**. That status is fine for trying it yourself and not for anyone else:

- **Only listed test users can connect**, and there can be at most 100 of them ([Manage app audience](https://support.google.com/cloud/answer/15549945)).
- **Every refresh token expires after 7 days**, because the app asks for more than name, email and profile ([OAuth 2.0 overview, refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)). A week after connecting, `/api/token` gets `invalid_grant` from Google, and the app asks the user to connect again. Nothing is lost: notes stay on the device and in Drive. But everyone reconnects weekly until you publish.

## Going to production

On the **Audience** page, **Publish app**. With only non-sensitive scopes, Google's [verification requirements](https://support.google.com/cloud/answer/13463073) come down to **brand verification**. That lighter check covers the app name, logo, home page, privacy policy and authorised domains, and is what lets the consent screen show your app's name and logo. Expect Google to ask you to prove you own the domains.

Until verification completes, Google may show an "unverified app" screen, and a user cap may apply ([When verification is not needed](https://support.google.com/cloud/answer/13464323)). Once published, refresh tokens no longer expire after a week. They still stop working when:
- the user revokes access;
- the token goes unused for six months;
- the account holds more than 100 live refresh tokens for this client, in which case the oldest goes;
- a Workspace admin restricts Drive for their users.

Each of these ends up as the same "connect again".

## What users see

- **Connect:** Google's account chooser, then the consent screen. Google lets the user untick individual permissions. If they untick Drive, the grant is given back to Google and the app says access to their files was not granted and to connect again (`connect=partial`).
- **Disconnect:** the app revokes the grant at Google, so it disappears from the user's [third-party access](https://myaccount.google.com/connections) page as well.
- **Reconnect weekly** while the app is in Testing (above).
