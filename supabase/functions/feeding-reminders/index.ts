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
  const [feeding, deworming, vaccination, vetVisit, hygiene] = await Promise.all([
    admin.rpc("claim_feeding_reminders", { p_worker_key: key }),
    admin.rpc("claim_deworming_reminders", { p_worker_key: key }),
    admin.rpc("claim_vaccination_reminders", { p_worker_key: key }),
    admin.rpc("claim_vet_visit_reminders", { p_worker_key: key }),
    admin.rpc("claim_hygiene_reminders", { p_worker_key: key }),
  ]);
  const errors = [feeding.error, deworming.error, vaccination.error, vetVisit.error, hygiene.error].filter(Boolean);
  if (errors.some(error => error?.code === "42501")) {
    return new Response(null, { status: 403 });
  }
  if (feeding.error) console.error("Claiming feeding reminders failed", feeding.error.code);
  if (deworming.error) console.error("Claiming deworming reminders failed", deworming.error.code);

  if (vaccination.error) console.error("Claiming vaccination reminders failed", vaccination.error.code);

  if (vetVisit.error) console.error("Claiming vet visit reminders failed", vetVisit.error.code);

  if (hygiene.error) console.error("Claiming bath and grooming reminders failed", hygiene.error.code);

  const reminders = [
    ...(feeding.data ?? []).map(reminder => ({
      ...reminder,
      table: "feeding_reminder_deliveries",
      text: `🐾 PetFeeder 餵食提醒\n${reminder.pet_name}的「${reminder.meal_name}」截至 ${reminder.reminder_at} 還沒有餵食紀錄。請先確認是否已餵，再到 PetFeeder 記錄。`,
    })),
    ...(deworming.data ?? []).map(reminder => ({
      ...reminder,
      table: "deworming_reminder_deliveries",
      text: `🐾 PetFeeder 驅蟲提醒\n${reminder.pet_name}的${reminder.kind === "internal" ? "體內" : "體外"}驅蟲預計日期是今天（${reminder.reminder_date}）。完成後請到 PetFeeder 的每日照護記錄。`,
    })),
    ...(vaccination.data ?? []).map(reminder => ({
      ...reminder,
      table: "vaccination_reminder_deliveries",
      text: `🐾 PetFeeder 疫苗提醒\n${reminder.pet_name}的「${reminder.vaccine_name}」預計施打日期是今天（${reminder.reminder_date}）。完成後可以到 PetFeeder 的每日照護記錄。`,
    })),
    ...(vetVisit.data ?? []).map(reminder => ({
      ...reminder,
      table: "vet_visit_reminder_deliveries",
      text: `🐾 PetFeeder 回診提醒\n${reminder.pet_name}的「${reminder.visit_reason}」預計回診日期是今天（${reminder.reminder_date}）。`,
    })),
    ...(hygiene.data ?? []).map(reminder => {
      const activity = reminder.kind === "bath" ? "洗澡" : "美容";
      return {
        ...reminder,
        table: "hygiene_reminder_deliveries",
        text: `🐾 PetFeeder ${activity}提醒\n${reminder.pet_name}的${activity}日期是今天（${reminder.reminder_date}）。`,
      };
    }),
  ];

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
          text: reminder.text,
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const accepted = response.ok || (response.status === 409 && response.headers.has("x-line-accepted-request-id"));
    if (!accepted) {
      console.error("LINE reminder request failed", response.status);
      if (response.status >= 500 || response.status === 429) return false;
    }
    const { error: updateError } = await admin.from(reminder.table)
      .update({ finished: true }).eq("id", reminder.delivery_id);
    if (updateError) throw updateError;
    return accepted;
  }));

  const sent = results.filter(result => result.status === "fulfilled" && result.value).length;
  if (sent !== reminders.length) console.error("Some reminders could not be sent", reminders.length - sent);
  return Response.json({ claimed: reminders.length, sent }, { status: errors.length ? 500 : 200 });
});
