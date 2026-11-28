import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async req => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const key = req.headers.get("x-reminder-key");
  if (!key) return new Response(null, { status: 401 });

  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) return new Response("LINE token not configured", { status: 500 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: reminders, error } = await admin.rpc("claim_feeding_reminders", { p_worker_key: key });
  if (error) {
    if (error.code === "42501") return new Response(null, { status: 403 });
    console.error("Claiming feeding reminders failed", error.code);
    return new Response(null, { status: 500 });
  }

  const results = await Promise.allSettled(reminders.map(async reminder => {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Line-Retry-Key": reminder.delivery_id,
      },
      body: JSON.stringify({
        to: reminder.group_id,
        messages: [{
          type: "text",
          text: `🐾 PetFeeder 餵食提醒\n${reminder.pet_name}的「${reminder.meal_name}」截至 ${reminder.reminder_at} 還沒有餵食紀錄。請先確認是否已餵，再到 PetFeeder 記錄。`,
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const accepted = response.ok || (response.status === 409 && response.headers.has("x-line-accepted-request-id"));
    if (!accepted) {
      console.error("LINE reminder request failed", response.status);
      if (response.status >= 500 || response.status === 429) return false;
    }
    const { error: updateError } = await admin.from("feeding_reminder_deliveries")
      .update({ finished: true }).eq("id", reminder.delivery_id);
    if (updateError) throw updateError;
    return accepted;
  }));

  const sent = results.filter(result => result.status === "fulfilled" && result.value).length;
  if (sent !== reminders.length) console.error("Some reminders could not be sent", reminders.length - sent);
  return Response.json({ claimed: reminders.length, sent });
});
