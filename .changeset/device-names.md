---
'@skysa/api': minor
'@skysa/web': minor
---

The storage panel's device list names each device by its browser and system,
"Safari on iPhone", and lists only the other devices, folded behind a count:
"2 other devices signed in on this account". The server keeps the label, worked
out from the User-Agent when a device connects, and never the header itself.

Migration `0006_grant_device` adds a nullable `grants.device` column. Apply it
before deploying (`wrangler d1 migrations apply`). Devices that connected before
it show as "A device" until they next connect.
