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

1. Create a **new project for this deployment** in the [Google Cloud console](https://console.cloud.google.com/), not one shared with other apps. Google revokes per project: "Revocation removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued access or refresh tokens for all clients registered under that project" ([Revoking a token](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)). Every time a user disconnects here, the app revokes, and that would also sign them out of any other app on the same project.
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

A new External app starts with the publishing status **Testing**. That status is fine for trying it yourself and not for anyone else ([Manage app audience](https://support.google.com/cloud/answer/15549945)):

- **Only listed test users can connect**, and there can be at most 100 of them. A user added counts against the 100 for good: removing them does not give the place back.
- Test users see a warning that the app is not verified before the consent screen.
- **Every refresh token expires after 7 days**, because the app asks for more than name, email and profile ([OAuth 2.0 overview, refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)). A week after connecting, `/api/token` gets `invalid_grant` from Google, and the app asks the user to connect again. Nothing is lost: notes stay on the device and in Drive. But everyone reconnects weekly until you publish.

## Going to production

On the **Audience** page, **Publish app**. The app asks only for non-sensitive scopes, so Google does not require verification before anyone with a Google account can connect ([Verification requirements](https://support.google.com/cloud/answer/13463073)). The warnings and the 100-user cap that go with unverified apps are for sensitive and restricted scopes, which this app does not ask for.

**Brand verification** is optional. Google asks for it only if the consent screen is to show your app's name and logo. It checks the branding details (name, logo, home page, privacy policy, authorised domains) and asks you to prove you own the domains.

Once published, refresh tokens no longer expire after a week. They still stop working when:
- the user revokes access;
- the token goes unused for six months;
- the account holds more than 100 live refresh tokens for this client, in which case the oldest goes;
- the user granted time-based access and the time is up.

Each of these reaches the app as `invalid_grant`, and the user is asked to connect again.

There is one exception. A Workspace admin who marks Drive as restricted for their users makes Google answer `admin_policy_enforced`. The app treats that as the provider being unavailable, not as a reason to reconnect, because reconnecting would be refused the same way: sync stops with an error until the admin changes the policy. The Worker log shows the code.

## What users see

- **Connect:** Google's account chooser, then the consent screen. Google lets the user untick individual permissions. If they untick Drive, nothing is stored and the app says access to their files was not granted and to connect again (`connect=partial`). Nothing is revoked either, since a revoke would also end the same user's working connection on another device. What they did grant (name and email) stays listed on their Google account until they remove it.
- **Disconnect:** the app revokes the grant at Google, so it disappears from the user's [third-party access](https://myaccount.google.com/connections) page as well. The revoke covers the whole project, so the same account connected on another device is disconnected there too, at its next token refresh.
- **Reconnect weekly** while the app is in Testing (above).
