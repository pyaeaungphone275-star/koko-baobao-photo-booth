# Koko & BaoBao Remote Photo Booth

## Files

- index.html
- style.css
- script.js
- SUPABASE_SETUP.sql

## What this version does

1. Create a Supabase account.
2. Log in from one device.
3. Create a 6-character booth code.
4. Send the code to the other person.
5. The other person logs in and joins the code.
6. Both cameras can be shared through WebRTC.
7. Supabase Realtime handles presence and WebRTC signaling.
8. Photos are saved locally in each browser.

## Important

Replace these two values at the top of script.js:

SUPABASE_URL
SUPABASE_ANON_KEY

Use the public Supabase URL and the browser-safe anon/publishable key.
Never put a Supabase service_role/secret key in this website.

## Local testing

Use VS Code Live Server.

Do not open index.html directly with file://.

Camera and microphone permissions work on localhost and HTTPS.

## Cross-device video

WebRTC uses a public Google STUN server in this starter version.

Most normal networks should connect directly. Some restrictive networks
will require a TURN server. If the connection reaches "failed", add a TURN
server to the iceServers array in script.js.

## Deployment

For GitHub Pages, push these files to your repository and enable Pages.

Use the HTTPS GitHub Pages URL when testing camera access.
