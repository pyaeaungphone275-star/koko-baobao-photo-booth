/*
  Supabase Edge Function: turn-credentials

  Returns the Metered TURN ICE-server configuration so the Metered
  API key never appears in the public frontend or in GitHub.

  Secrets (set with `supabase secrets set ...`):
    METERED_APP_NAME  - the "<name>" in <name>.metered.live
    METERED_API_KEY   - the API key of one TURN credential
                        (NOT the account Secret Key)

  Only signed-in Supabase users can get the configuration.
*/

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  const { data: userData, error: userError } =
    await supabase.auth.getUser(token);

  if (userError || !userData.user) {
    return json({ error: "Not signed in" }, 401);
  }

  const appName = Deno.env.get("METERED_APP_NAME");
  const apiKey = Deno.env.get("METERED_API_KEY");

  if (!appName || !apiKey) {
    return json({ error: "TURN is not configured" }, 500);
  }

  const response = await fetch(
    `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
  );

  if (!response.ok) {
    console.error("Metered TURN error:", response.status, await response.text());
    return json({ error: "TURN provider error" }, 502);
  }

  // Metered returns an array of RTCIceServer objects
  // (STUN, TURN UDP, TURN TCP, TURNS/TLS on 443).
  const iceServers = await response.json();

  if (!Array.isArray(iceServers)) {
    console.error("Unexpected Metered response:", iceServers);
    return json({ error: "TURN provider error" }, 502);
  }

  return json({ iceServers });
});
