# age test vectors

Copied unchanged from the C2SP Community Cryptography Test Vectors,
[`age/testdata`](https://github.com/C2SP/CCTV/tree/main/age/testdata) at commit
`50a8ecf2a220f4c8bdc4f085789b8e85c26829e7`. Their license is
`(0BSD OR CC0-1.0 OR Unlicense)` (`age/package.json` there), which allows copying
them without attribution.

The format of each file, and what its `expect` means, is in that directory's
README. `../testkit.test.ts` runs every one this implementation can: those with
X25519 identities, or none. It skips the scrypt-only and the post-quantum hybrid
ones.

To update, copy the directory again and change the commit above.
