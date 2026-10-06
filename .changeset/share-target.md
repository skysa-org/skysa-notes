---
'@skysa/web': minor
---

The installed app is a share target on Android and ChromeOS. Text, links and files shared to it from the system's share sheet go on the clipboard of the source showing, once the user says so. The app always asks, naming what came, and offers to show the clipboard where it is hidden. Files over 25 MB are left out and named. Notes kept on this device only, and a source no longer connected, have no clipboard, and the app says so. The service worker answers the share itself and keeps it on the device until the page has asked; nothing shared is sent to the server.
