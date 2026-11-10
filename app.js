(() => {
  const cfg = window.PETFEEDER_CONFIG || {};
  const $ = id => document.getElementById(id);
  const show = (id, yes=true) => $(id).classList.toggle("hidden", !yes);
  const msg = (s) => alert(s);
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_")) { show("setup"); return; }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  let user=null, household=null, pets=[], meals=[], feedings=[], activePet=null;
  const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const dateKey = () => new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei"}).format(new Date());
  const timeText = v => new Date(v).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false});
  async function init() {
    const {data:{session}} = await sb.auth.getSession();
    user=session?.user || null;
    $("user-area").textContent=user ? user.email : "";
    show("auth",!user); show("app",!!user);
    if(user) await load();
  }
  $("login-form").addEventListener("submit",async e=>{
    e.preventDefault(); const {error}=await sb.auth.signInWithOtp({email:$("email").value,options:{emailRedirectTo:location.href}});
    $("auth-message").textContent=error?.message || "登入連結已寄出，請查看信箱。";
  });
  $("signout").onclick=async()=>{await sb.auth.signOut();location.reload();};
  async function load() {
    const {data:m,error}=await sb.from("household_members").select("household_id,households(id,name,invite_code,line_group_id)").eq("user_id",user.id).limit(1).maybeSingle();
    if(error){msg(error.message);return;}
    if(!m){show("family-setup");show("dashboard",false);return;}
    household=m.households; show("family-setup",false);show("dashboard");
    $("family-name").textContent=household.name;
    $("invite-code").textContent=household.invite_code;
    $("line-status").textContent=household.line_group_id?"已綁定 LINE 群組 ✓":"尚未綁定 LINE 群組";
    await refreshData();
    const channel=sb.channel("household-"+household.id)
      .on("postgres_changes",{event:"*",schema:"public",table:"feedings",filter:"household_id=eq."+household.id},refreshData)
      .subscribe();
  }
  async function refreshData(){
    if(!household)return;
    const [p,m,f,profile]=await Promise.all([
      sb.from("pets").select("*").eq("household_id",household.id).eq("active",true).order("created_at"),
      sb.from("meal_types").select("*").eq("household_id",household.id).eq("active",true).order("sort_order"),
      sb.from("feedings").select("*,pets(name),meal_types(name),profiles(display_name)").eq("household_id",household.id).gte("fed_at",new Date(Date.now()-3*86400000).toISOString()).order("fed_at",{ascending:false})
    ]);
    if(p.error||m.error||f.error){console.error(p.error,m.error,f.error);return;}
    pets=p.data||[]; meals=m.data||[]; feedings=f.data||[]; renderPets();
  }

  $("profile-form").addEventListener("submit",async e=>{
    e.preventDefault();
    const display_name=$("display-name").value.trim();
    const {error}=await sb.from("profiles").update({display_name}).eq("id",user.id);
    if(error)msg(error.message);else {msg("顯示名稱已更新。");await refreshData();}
  });
  function renderHistory(){
    $("feeding-history").innerHTML=feedings.length?feedings.map(f=>`<div class="meal-item"><div><strong>${esc(f.pets?.name||"寵物")} · ${esc(f.meal_types?.name||"餐次")}</strong><br><span class="muted">餵食者：${esc(f.profiles?.display_name||"家庭成員")}　｜　${esc(timeText(f.fed_at))}</span></div></div>`).join(""):`<p class="muted">最近 30 天尚無餵食紀錄。</p>`;
  }

  $("create-family").addEventListener("submit",async e=>{
    e.preventDefault();const {error}=await sb.rpc("create_household",{p_name:$("new-family-name").value.trim()});
    if(error)msg(error.message);else await load();
  });
  $("join-family").addEventListener("submit",async e=>{
    e.preventDefault();const {error}=await sb.rpc("join_household",{p_invite_code:$("join-code").value.trim().toUpperCase()});
    if(error)msg(error.message);else await load();
  });
  $("add-pet").onclick=()=>openPet();
  function openPet(p=null){
    $("pet-form").reset();$("pet-id").value=p?.id||"";$("pet-name").value=p?.name||"";$("pet-kind").value=p?.kind||"";
    $("pet-dialog-title").textContent=p?"編輯寵物":"新增寵物";$("meal-editor").innerHTML="";
    const current=meals.filter(x=>x.pet_id===p?.id);
    (current.length?current:[{name:"早餐",scheduled_time:"08:00"},{name:"晚餐",scheduled_time:"18:00"}]).forEach(addMealRow);
    $("pet-dialog").showModal();
  }
  function addMealRow(m={name:"",scheduled_time:"12:00"}){
    const node=$("meal-row-template").content.cloneNode(true), row=node.querySelector(".meal-row");
    row.querySelector(".meal-name").value=m.name||"";row.querySelector(".meal-time").value=m.scheduled_time||"12:00";
    row.querySelector(".remove-meal").onclick=()=>row.remove();$("meal-editor").append(node);
  }
  $("add-meal").onclick=()=>addMealRow();
  $("save-pet").onclick=async()=>{
    const id=$("pet-id").value, name=$("pet-name").value.trim(), kind=$("pet-kind").value.trim();
    const rows=[...$("meal-editor").querySelectorAll(".meal-row")];
    if(!name||!rows.length){msg("請填寫寵物名稱，並至少設定一個餐次。");return;}
    const slots=rows.map((r,i)=>({name:r.querySelector(".meal-name").value.trim(),scheduled_time:r.querySelector(".meal-time").value,sort_order:i}));
    if(slots.some(x=>!x.name||!x.scheduled_time)){msg("請完整填寫每個餐次的名稱與時間。");return;}
    let petId=id;
    if(id){const {error}=await sb.from("pets").update({name,kind}).eq("id",id);if(error){msg(error.message);return;}}
    else {const {data,error}=await sb.from("pets").insert({household_id:household.id,name,kind,created_by:user.id}).select("id").single();if(error){msg(error.message);return;}petId=data.id;}
    const {error:de}=await sb.from("meal_types").update({active:false}).eq("pet_id",petId);
    if(de){msg(de.message);return;}
    const {error:ie}=await sb.from("meal_types").insert(slots.map(x=>({...x,household_id:household.id,pet_id:petId,active:true})));
    if(ie){msg(ie.message);return;}
    $("pet-dialog").close();await refreshData();
  };
  function renderPets(){
    $("pets").innerHTML=pets.length?pets.map(p=>{
      const pm=meals.filter(m=>m.pet_id===p.id), today=feedings.filter(f=>f.pet_id===p.id&&f.feeding_date===dateKey());
      return `<article class="pet-card"><div class="pet-top"><div><h3>🐾 ${esc(p.name)}</h3><span class="muted">${esc(p.kind||"")}</span></div><button class="secondary edit-pet" data-id="${p.id}">編輯</button></div><div class="meal-list">${pm.map(m=>{const f=today.find(x=>x.meal_id===m.id);return `<div class="meal-item"><div><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.scheduled_time)}</span><br><span class="${f?"fed":"muted"}">${f?`✓ ${esc(f.profiles?.display_name||"家庭成員")} · ${esc(timeText(f.fed_at))}`:"尚未餵食"}</span></div><button data-pet="${p.id}" data-meal="${m.id}" class="feed-one" ${f?"disabled":""}>${f?"已完成":"記錄餵食"}</button></div>`}).join("")}</div><button class="secondary show-nfc" data-id="${p.id}">查看 NFC 連結</button></article>`;
    }).join(""):`<div class="panel"><p>尚未新增寵物，按「新增寵物」開始設定。</p></div>`;
    document.querySelectorAll(".edit-pet").forEach(b=>b.onclick=()=>openPet(pets.find(p=>p.id===b.dataset.id)));
    document.querySelectorAll(".feed-one").forEach(b=>b.onclick=()=>openFeed(b.dataset.pet,b.dataset.meal));
    document.querySelectorAll(".show-nfc").forEach(b=>b.onclick=()=>{const p=pets.find(x=>x.id===b.dataset.id);const url=location.origin+location.pathname+"?pet="+p.public_token;msg("請將此網址寫入 NTAG NFC 標籤：\\n"+url);});
  }
  function openFeed(petId,mealId){
    const p=pets.find(x=>x.id===petId), pm=meals.filter(x=>x.pet_id===petId);
    $("feed-pet-id").value=petId;$("feed-title").textContent=`你餵了 ${p.name} 嗎？`;
    $("feed-meal").innerHTML=pm.map(m=>`<option value="${m.id}" ${m.id===mealId?"selected":""}>${esc(m.name)}（${esc(m.scheduled_time)}）</option>`).join("");
    $("feed-dialog").showModal();
  }
  $("confirm-feed").onclick=async()=>{
    const petId=$("feed-pet-id").value, mealId=$("feed-meal").value;
    const meal=meals.find(m=>m.id===mealId);
    const {data,error}=await sb.from("feedings").insert({household_id:household.id,pet_id:petId,meal_id:mealId,feeding_date:dateKey(),fed_by:user.id}).select("id").single();
    if(error){msg(error.code==="23505"?"這個餐次今天已經有餵食紀錄。":error.message);return;}
    $("feed-dialog").close();await refreshData();
    const {error:pushError}=await sb.functions.invoke("line-push",{body:{feeding_id:data.id}});
    if(pushError)console.warn("餵食已記錄，但 LINE 通知未成功",pushError);
  };
  $("make-pairing").onclick=async()=>{
    const {data,error}=await sb.rpc("create_line_pairing");
    if(error){msg(error.message);return;}
    $("pairing-code").textContent=data;
  };
  $("copy-invite").onclick=()=>navigator.clipboard.writeText($("invite-code").textContent).then(()=>msg("已複製邀請碼"));
  const params=new URLSearchParams(location.search);
  sb.auth.onAuthStateChange((_event,session)=>{user=session?.user||null;init();});
  init().then(async()=>{if(user&&params.get("pet")){await refreshData();const p=pets.find(x=>x.public_token===params.get("pet"));if(p){const m=meals.find(x=>x.pet_id===p.id);if(m)openFeed(p.id,m.id);}}});
})();