#!/bin/sh
# Write apps/api/.dev.vars by asking for what .dev.vars.example says is needed.
#
# Run it as `pnpm run setup`, with the `run`. Bare `pnpm setup` is pnpm's own
# built-in — it installs pnpm itself — and would quietly do something else
# entirely. Same for `pnpm run deploy`.
#
# Deliberately a POSIX shell script with no dependencies: it runs before
# `pnpm install` has necessarily happened, and the whole point is to get a
# clone to the point where it boots.
#
# It asks only for the providers you say you want. Listing a provider in
# ENABLED_PROVIDERS commits the deployment to having its credentials —
# `parseEnv` refuses to boot without them — so asking for all three would make
# a Dropbox-only setup fail at boot with two blanks it never needed.
#
# Secrets are read with `read`, not echoed back, and never passed as arguments,
# so they do not reach the process list or the shell history.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target="$root/apps/api/.dev.vars"

say() { printf '%s\n' "$*"; }

# A value, with a default in brackets if there is one.
ask() {
	prompt=$1
	fallback=${2-}
	if [ -n "$fallback" ]; then
		printf '%s [%s]: ' "$prompt" "$fallback" >&2
	else
		printf '%s: ' "$prompt" >&2
	fi
	read -r answer || answer=''
	[ -n "$answer" ] || answer=$fallback
	printf '%s' "$answer"
}

# A secret: the same, without echoing it to the terminal.
ask_secret() {
	printf '%s: ' "$1" >&2
	if [ -t 0 ]; then
		stty -echo 2>/dev/null || true
		read -r answer || answer=''
		stty echo 2>/dev/null || true
		printf '\n' >&2
	else
		read -r answer || answer=''
	fi
	printf '%s' "$answer"
}

yes_to() {
	printf '%s [y/N]: ' "$1" >&2
	read -r answer || answer=''
	case $answer in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

say "skysa-notes — local setup"
say ""
say "This writes apps/api/.dev.vars, which is gitignored and must stay that way."
say "For a deployed instance, set each of these with 'wrangler secret put <KEY>'"
say "instead; see docs/self-hosting.md."
say ""

if [ -e "$target" ]; then
	say "$target already exists."
	yes_to "Overwrite it?" || {
		say "Left alone. Nothing was written."
		exit 0
	}
fi

app_origin=$(ask "Public origin of this deployment" "http://localhost:5173")

say ""
say "Which providers should this deployment offer? Each needs its own app"
say "registration. Dropbox is the least work; Google is the most."
providers=''
for provider in dropbox onedrive gdrive; do
	if yes_to "Enable $provider?"; then
		providers="${providers:+$providers,}$provider"
	fi
done
if [ -z "$providers" ]; then
	say ""
	say "No providers enabled. The app will run and store notes locally, but"
	say "nothing will sync until you re-run this with at least one."
fi

# A key that does not decode to exactly 32 bytes is refused at boot, so it is
# generated here rather than asked for whenever there is anything to generate
# it with.
say ""
if command -v openssl >/dev/null 2>&1; then
	secrets_key=$(openssl rand -base64 32)
	say "Generated SECRETS_KEY (32 random bytes, base64)."
else
	say "openssl not found. Generate 32 random bytes, base64, and paste them."
	say "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
	secrets_key=$(ask_secret "SECRETS_KEY")
fi

dropbox_id=''
dropbox_secret=''
microsoft_id=''
microsoft_secret=''
microsoft_tenant='common'
google_id=''
google_secret=''

case ",$providers," in *,dropbox,*)
	say ""
	say "Dropbox — App Console, app named 'skysa-notes' (names are immutable),"
	say "Scoped access / App folder. Redirect URI:"
	say "  $app_origin/api/auth/connect/dropbox/callback"
	dropbox_id=$(ask "DROPBOX_CLIENT_ID")
	dropbox_secret=$(ask_secret "DROPBOX_CLIENT_SECRET")
	;;
esac

case ",$providers," in *,onedrive,*)
	say ""
	say "OneDrive — Entra app registration, display name 'skysa-notes' (OneDrive"
	say "derives the app folder name from it). Web platform, not SPA."
	say "Redirect URI:"
	say "  $app_origin/api/auth/connect/onedrive/callback"
	microsoft_id=$(ask "MICROSOFT_CLIENT_ID")
	microsoft_secret=$(ask_secret "MICROSOFT_CLIENT_SECRET")
	microsoft_tenant=$(ask "MICROSOFT_TENANT" "common")
	;;
esac

case ",$providers," in *,gdrive,*)
	say ""
	say "Google Drive — Cloud console, OAuth client of type Web application."
	say "Redirect URI:"
	say "  $app_origin/api/auth/connect/gdrive/callback"
	say "See docs/google-oauth.md for the scopes and the Testing-status caveats."
	google_id=$(ask "GOOGLE_CLIENT_ID")
	google_secret=$(ask_secret "GOOGLE_CLIENT_SECRET")
	;;
esac

umask 077
cat > "$target" <<VARS
# Written by 'pnpm setup'. Never commit this file.
# Every key is documented in .dev.vars.example.

APP_ORIGIN="$app_origin"
AUTH_MODE="storage-first"
ENABLED_PROVIDERS="$providers"

SECRETS_KEY="$secrets_key"
SECRETS_KEY_ID="k1"

WEBDAV_ALLOW_PRIVATE="false"

DROPBOX_CLIENT_ID="$dropbox_id"
DROPBOX_CLIENT_SECRET="$dropbox_secret"

MICROSOFT_CLIENT_ID="$microsoft_id"
MICROSOFT_CLIENT_SECRET="$microsoft_secret"
MICROSOFT_TENANT="$microsoft_tenant"

GOOGLE_CLIENT_ID="$google_id"
GOOGLE_CLIENT_SECRET="$google_secret"
VARS

say ""
say "Wrote $target"
say ""
say "Next:"
say "  pnpm install"
say "  pnpm db:migrate     # create the local D1 database"
say "  pnpm dev            # Vite on :5173, wrangler dev on :8787"
