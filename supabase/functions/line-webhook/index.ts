import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const encoder = new TextEncoder();
async function hmacSha256(secret:string, body:string) {
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(body)))));
}
async function sha256(s:string) {
  const hash=await crypto.subtle.digest("SHA-256",encoder.encode(s));
  return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
Deno.serve(async req=>{
  if(req.method!=="POST") return new Response("Method not allowed",{status:405});
  const raw=await req.text(), signature=req.headers.get("x-line-signature")||"";
  const secret=Deno.env.get("LINE_CHANNEL_SECRET")||"";
  if(!secret || await hmacSha256(secret,raw)!==signature) return new Response("Invalid signature",{status:401});
  const body=JSON.parse(raw), sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  for(const ev of body.events||[]){
    if(ev.type!=="message"||ev.message?.type!=="text"||ev.source?.type!=="group") continue;
    const match=ev.message.text.trim().match(/^綁定\\s+([A-F0-9]{10})$/i);
    if(!match) continue;
    const code=match[1].toUpperCase(), hash=await sha256(code);
    const {data:pair}=await sb.from("line_pairings").select("id,household_id").eq("code_hash",hash).is("used_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
    if(!pair) { await reply(ev.replyToken,"配對碼無效或已逾期，請回 PetFeeder 重新產生。"); continue; }
    const {data:existing}=await sb.from("households").select("id").eq("line_group_id",ev.source.groupId).maybeSingle();
    if(existing && existing.id!==pair.household_id){await reply(ev.replyToken,"這個 LINE 群組已綁定其他家庭。");continue;}
    const {error}=await sb.from("households").update({line_group_id:ev.source.groupId}).eq("id",pair.household_id);
    if(error){await reply(ev.replyToken,"綁定失敗，請稍後再試。");continue;}
    await sb.from("line_pairings").update({used_at:new Date().toISOString()}).eq("id",pair.id);
    await reply(ev.replyToken,"PetFeeder 家庭群組綁定成功！之後的餵食紀錄會通知這個群組。");
  }
  return new Response("OK");
});
async function reply(token:string,text:string){
 const access=Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN"); if(!access)return;
 await fetch("https://api.line.me/v2/bot/message/reply",{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${access}`},body:JSON.stringify({replyToken:token,messages:[{type:"text",text}]})});
}
