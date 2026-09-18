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
# It will not write a file the Worker would refuse to boot from. An empty
# ENABLED_PROVIDERS and a blank client id are both boot failures, so both are
# asked again rather than written down, and a run with nothing to answer from
# stops instead of leaving a broken file behind.
#
# Secrets are read with `read`, not echoed back, and never passed as arguments,
# so they do not reach the process list or the shell history.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target="$root/apps/api/.dev.vars"

say() { printf '%s\n' "$*"; }

# Everything the user is asked, and everything said while asking, goes to
# stderr: the ask functions are called inside `$(…)`, which captures stdout.
tell() { printf '%s\n' "$*" >&2; }

# Ctrl-C at a secret prompt would otherwise leave the terminal with echo off
# and no obvious way back.
restore_tty() {
	if [ -t 0 ]; then
		stty echo 2>/dev/null || true
	fi
}
trap restore_tty EXIT
# A signal trap returns to where it was interrupted unless it exits, and
# carrying on from a Ctrl-C at the Dropbox prompt is the wrong answer.
trap 'restore_tty; exit 130' INT HUP TERM

# There is nothing useful to do with EOF here, and the one thing that must not
# happen is writing a file out of unanswered questions. `exit` inside `$(…)`
# leaves only the subshell, but `set -e` makes the assignment it is feeding
# fail, which stops the script.
give_up() {
	tell ''
	tell 'Input ended, so nothing was written.'
	exit 1
}

# Wrangler reads .dev.vars with dotenv and then runs dotenv-expand over the
# result, which substitutes `$NAME` and `${NAME}` from the environment — or
# with nothing, where the name is unset. A client secret containing a `$` would
# arrive at the Worker with a piece missing. dotenv-expand's own escape is
# `\$`, which it strips again on the way out, so that is what is written.
#
# A backslash has no such escape (dotenv rewrites `\n` and `\r` inside a
# double-quoted value before expansion ever sees it), which is why one is
# refused at the prompt rather than mangled here.
escaped() { printf '%s' "$1" | sed 's/\$/\\$/g'; }

has_backslash() { case $1 in *\\*) return 0 ;; *) return 1 ;; esac; }

# A value, with a default in brackets if there is one. Asked again while the
# answer is empty and there is no default to fall back on: every caller here is
# a key the Worker refuses to boot without.
ask() {
	prompt=$1
	fallback=${2-}
	answer=''
	while [ -z "$answer" ]; do
		if [ -n "$fallback" ]; then
			printf '%s [%s]: ' "$prompt" "$fallback" >&2
		else
			printf '%s: ' "$prompt" >&2
		fi
		read -r answer || give_up
		[ -n "$answer" ] || answer=$fallback
		if [ -z "$answer" ]; then
			tell 'Required — there is no default for this one.'
		elif has_backslash "$answer"; then
			tell 'A backslash cannot be stored in .dev.vars. Paste it again without one.'
			answer=''
		fi
	done
	printf '%s' "$answer"
}

# A secret: the same, without echoing it to the terminal.
ask_secret() {
	answer=''
	while [ -z "$answer" ]; do
		printf '%s: ' "$1" >&2
		if [ -t 0 ]; then
			stty -echo 2>/dev/null || true
			read -r answer || give_up
			stty echo 2>/dev/null || true
			printf '\n' >&2
		else
			read -r answer || give_up
		fi
		if [ -z "$answer" ]; then
			tell 'Required — the Worker refuses to boot without it.'
		elif has_backslash "$answer"; then
			tell 'A backslash cannot be stored in .dev.vars. Paste it again without one.'
			answer=''
		fi
	done
	printf '%s' "$answer"
}

yes_to() {
	printf '%s [y/N]: ' "$1" >&2
	read -r answer || give_up
	case $answer in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

say "skysa-notes — local setup"
say ""
say "This writes apps/api/.dev.vars, which is gitignored and must stay that way."
say "For a deployed instance, set each of these with 'wrangler secret put <KEY>'"
say "instead; see docs/self-hosting.md."
say ""

# Every question below needs an answer, so a run with nothing to read from is
# stopped here rather than three prompts in, having half-written the file.
if [ ! -t 0 ]; then
	say "This asks questions and needs a terminal. Copy .dev.vars.example to"
	say "apps/api/.dev.vars and fill it in instead."
	exit 1
fi

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
while [ -z "$providers" ]; do
	for provider in dropbox onedrive gdrive; do
		if yes_to "Enable $provider?"; then
			providers="${providers:+$providers,}$provider"
		fi
	done
	if [ -z "$providers" ]; then
		say ""
		say "At least one is needed. ENABLED_PROVIDERS is not allowed to be empty —"
		say "the Worker refuses to boot rather than serve an API that can connect"
		say "nothing — so an empty answer here would write a file that does not run."
	fi
done

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
	secrets_key=''
	while [ ${#secrets_key} -ne 44 ]; do
		secrets_key=$(ask_secret "SECRETS_KEY")
		# base64 of 32 bytes is always 44 characters. Not a decode — there is
		# nothing here to decode with — but it catches the passphrase someone
		# types when they meant to paste a key, which the Worker would
		# otherwise refuse at boot with nothing to point at.
		if [ ${#secrets_key} -ne 44 ]; then
			say "That is ${#secrets_key} characters; base64 of 32 bytes is 44."
		fi
	done
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
# Written by 'pnpm run setup'. Never commit this file.
# Every key is documented in .dev.vars.example.

APP_ORIGIN="$(escaped "$app_origin")"
AUTH_MODE="storage-first"
ENABLED_PROVIDERS="$providers"

SECRETS_KEY="$(escaped "$secrets_key")"
SECRETS_KEY_ID="k1"

WEBDAV_ALLOW_PRIVATE="false"

DROPBOX_CLIENT_ID="$(escaped "$dropbox_id")"
DROPBOX_CLIENT_SECRET="$(escaped "$dropbox_secret")"

MICROSOFT_CLIENT_ID="$(escaped "$microsoft_id")"
MICROSOFT_CLIENT_SECRET="$(escaped "$microsoft_secret")"
MICROSOFT_TENANT="$(escaped "$microsoft_tenant")"

GOOGLE_CLIENT_ID="$(escaped "$google_id")"
GOOGLE_CLIENT_SECRET="$(escaped "$google_secret")"
VARS

say ""
say "Wrote $target"
say ""
say "Next:"
say "  pnpm install"
say "  pnpm db:migrate     # create the local D1 database"
say "  pnpm dev            # Vite on :5173, wrangler dev on :8787"
