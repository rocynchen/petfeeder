
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  const auth = req.headers.get("Authorization") || "";

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } }
  );

  const { data: { user }, error: ue } = await sb.auth.getUser();

  if (ue || !user) {
    return new Response("Unauthorized", {
      status: 401,
      headers: corsHeaders,
    });
  }

  const { feeding_id } = await req.json();

  if (!feeding_id) {
    return new Response("Missing feeding_id", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: f, error } = await admin
    .from("feedings")
    .select("fed_at,feeding_date,household_id,pets(name),meal_types(name),profiles(display_name)")
    .eq("id", feeding_id)
    .single();

  if (error || !f) {
    return new Response("Not found", {
      status: 404,
      headers: corsHeaders,
    });
  }

  const { data: member } = await admin
    .from("household_members")
    .select("household_id")
    .eq("household_id", f.household_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) {
    return new Response("Forbidden", {
      status: 403,
      headers: corsHeaders,
    });
  }

  const { data: h } = await admin
    .from("households")
    .select("line_group_id")
    .eq("id", f.household_id)
    .single();

  if (!h?.line_group_id) {
    return Response.json(
      { sent: false, reason: "LINE group not connected" },
      { headers: corsHeaders }
    );
  }

  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");

  if (!token) {
    return new Response("LINE token not configured", {
      status: 500,
      headers: corsHeaders,
    });
  }

  const pet = (f.pets as any)?.name || "寵物";
  const meal = (f.meal_types as any)?.name || "餐次";
  const who = (f.profiles as any)?.display_name || "家庭成員";

  const when = new Date(f.fed_at).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: h.line_group_id,
      messages: [{
        type: "text",
        text: `🐾 PetFeeder 餵食紀錄\n寵物：${pet}\n餐次：${meal}\n餵食者：${who}\n時間：${when}`,
      }],
    }),
  });

  if (!res.ok) {
    return new Response(await res.text(), {
      status: 502,
      headers: corsHeaders,
    });
  }

  return Response.json(
    { sent: true },
    { headers: corsHeaders }
  );
});
