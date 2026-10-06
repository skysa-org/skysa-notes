---
'@skysa/api': minor
---

The change relay can be turned on: `RELAY = "true"` in `wrangler.toml`'s `[vars]`. Its hub is a Durable Object per connection, `ConnectionRelay`, bound as `RELAY_HUB`. It is declared in `wrangler.toml` whether or not the relay is on, and it costs nothing while nobody addresses it. With the relay on, a device that has pushed tells the connection's other devices, which then sync within a second or two. Read docs/self-hosting.md, "Instant updates between devices", first: the server learns when each connection is edited, and on Workers Free the relay spends the request cap that token refresh shares.

**For an operator with a Worker entry of their own:** it must now `export { ConnectionRelay }`, from `@skysa/api/relay` outside `apps/api/src`, because `wrangler.toml` binds that class and a deploy whose entry does not export it is refused. `RELAY = "true"` without the binding refuses to boot.
