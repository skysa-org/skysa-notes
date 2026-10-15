/**
 * A key made for these tests and nothing else, and secrets sealed to it, each
 * checked against the age command line tool when it was written: `age-keygen -y`
 * gives `RECIPIENT` for `IDENTITY`, and `age -d` opens `SEALED_HERE` to
 * `SEALED_HERE_WORDS`. `SEALED_BY_AGE` was made by `age -a -r` and opens here.
 */

export const IDENTITY =
	'AGE-SECRET-KEY-10YTH4K0VTTKT563MG39SHTTRL8JSMMS053K4PFJLWD96TN3JURRSQG9D43';

export const RECIPIENT = 'age1320ux0hct0gutc9fu789mqlqjns4fv84w9cz3ytr9mh8fx86fsasr4slrh';

export const SEALED_HERE_WORDS = 'Door code: 4711\nWi-Fi: correct horse battery staple';

export const SEALED_HERE = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBFMm15cVdPN3AwUkluVXNL
SStkWVZQdFIrY2liOHRkcXRyd3JGU1VLY2pzCitUbDZBT1MwQnlJcmswWDcwK3Ex
dkw1M09udTdrWGNZL1ZlYkpuUTBER00KLS0tIEZ3ZXZEcFBXMWVUdjNnZUo4Njl4
emgxYmJYOE5KR0RTcHBtNmNNN0JhbGcKULiXPf/2QZl2BlRQTjwGNOzB1pscLjVb
lMO8GyW4dOUjwRlwGv0ahXkK0JlgsweJMIB0c1AtSwXjSkXadxP3gMVjijmWvaSU
TBxdWMC285pNrbY=
-----END AGE ENCRYPTED FILE-----`;

export const SEALED_BY_AGE_WORDS = 'Sealed by the age command line tool ✓';

export const SEALED_BY_AGE = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBzSDdZdG10WDdmZ0RXSWtN
SXZ4NFpiMitYNy80Ny9udE5RdDF4L0RPZlhVCmc5Z0ovZDYzSVZpSSsyUTIzeWth
eGp1ZWhsSUg4QXNvcTFIUEZINE4xWUEKLS0tIEh1am9CRG9MQXBiK095MUZvTFVk
SXpOZlY0cE9pUzVoaThrUHJ5bXBZUDQKJ0Qgrow7GeN+qy/KedadvhrON6+6tual
fuVODa4j6vcMuvnRjPRIjecO0wvMZQDR7MZGr5M+Tu+qNxq1rUiRtjssDHRADDE=
-----END AGE ENCRYPTED FILE-----`;
