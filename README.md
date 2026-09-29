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

WebRTC always uses a public Google STUN server. Some networks (mobile
carriers, strict NATs, corporate/school Wi-Fi) also need a TURN relay.

TURN credentials are never stored in script.js (it is public on GitHub
Pages). Instead the Supabase Edge Function in
`supabase/functions/turn-credentials` fetches the Metered TURN ICE-server
configuration for signed-in users:

1. In the Metered dashboard, open your TURN credential and copy its
   API key (not the account Secret Key), and note your app name
   (the `<name>` in `<name>.metered.live`).
2. With the Supabase CLI:

   ```
   supabase link --project-ref keymklolnvpfgwsszmgr
   supabase secrets set METERED_APP_NAME=... METERED_API_KEY=...
   supabase functions deploy turn-credentials --no-verify-jwt
   ```

   (`--no-verify-jwt` because the function checks the user's session itself.)

If the function is not deployed or fails, the app falls back to STUN only
and logs a warning in the browser console.

## Deployment

For GitHub Pages, push these files to your repository and enable Pages.

Use the HTTPS GitHub Pages URL when testing camera access.
