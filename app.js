(() => {
  const cfg = window.PETFEEDER_CONFIG || {};
  const $ = id => document.getElementById(id);
  const show = (id, yes=true) => $(id).classList.toggle("hidden", !yes);
  const msg = (s) => alert(s);
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_")) { show("setup"); return; }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  let user=null, household=null, pets=[], meals=[], feedings=[], historyFeedings=[], activePet=null, members=[], historyMonth=new Date(), selectedHistoryDate="", selectedFeeder="all", selectedPet="all";
  const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const dateKey = () => new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei"}).format(new Date());
  const timeText = v => new Date(v).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
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
    $("settings-family-name").textContent=household.name;
    $("invite-code").textContent=household.invite_code;
    $("line-status").textContent=household.line_group_id?"已綁定 LINE 群組 ✓":"尚未綁定 LINE 群組";
    await refreshData();
    const channel=sb.channel("household-"+household.id)
      .on("postgres_changes",{event:"*",schema:"public",table:"feedings",filter:"household_id=eq."+household.id},refreshData)
      .subscribe();
  }
  async function refreshData(){
    if(!household)return;

    const year=historyMonth.getFullYear();
    const month=historyMonth.getMonth();
    const monthStart=new Date(year,month,1).toLocaleDateString("en-CA");
    const nextMonthStart=new Date(year,month+1,1).toLocaleDateString("en-CA");

    const [p,m,f,h,profile]=await Promise.all([
      sb.from("pets").select("*").eq("household_id",household.id).eq("active",true).order("created_at"),
      sb.from("meal_types").select("*").eq("household_id",household.id).eq("active",true).order("sort_order"),
      sb.from("feedings").select("*,pets(name),meal_types(name),profiles(display_name)").eq("household_id",household.id).gte("fed_at",new Date(Date.now()-30*86400000).toISOString()).order("fed_at",{ascending:false}),
      sb.from("feedings").select("*,pets(name),meal_types(name),profiles(display_name)").eq("household_id",household.id).gte("feeding_date",monthStart).lt("feeding_date",nextMonthStart).order("fed_at",{ascending:false}),
      sb.from("profiles").select("display_name").eq("id",user.id).maybeSingle()
    ]);

    if(p.error||m.error||f.error||h.error){
      console.error(p.error,m.error,f.error,h.error);
      msg("載入資料失敗，請稍後再試。");
      return;
    }

    pets=p.data||[];
    meals=m.data||[];
    feedings=f.data||[];
    historyFeedings=h.data||[];

    const {data:memberRows,error:memberError}=await sb.from("household_members").select("user_id,role").eq("household_id",household.id);

    if(memberError){
      console.error(memberError);
      msg("載入家庭成員失敗："+memberError.message);
      return;
    }

    const memberIds=(memberRows||[]).map(x=>x.user_id);
    if(memberIds.length){
      const {data:profilesData,error:profilesError}=await sb.from("profiles").select("id,display_name").in("id",memberIds);
      if(profilesError){
        console.error(profilesError);
        msg("載入成員名稱失敗："+profilesError.message);
        return;
      }
      members=(profilesData||[]).map(profile=>({
        ...profile,
        role:(memberRows||[]).find(row=>row.user_id===profile.id)?.role||"member"
      }));
    }else{
      members=[];
    }

    if(!selectedHistoryDate)selectedHistoryDate=dateKey();

    if(!profile.error && profile.data){
      $("display-name").value=profile.data.display_name||"";
    }

    renderPets();
    renderHistory();
    renderHouseholdMembers();
  }


function renderHouseholdMembers(){
  const container=$("household-members-list");
  if(!container)return;

  const myRole=members.find(member=>member.id===user.id)?.role;

  container.innerHTML=members.length?members.map(member=>{
    const isCurrentUser=member.id===user.id;

    const roleLabel=member.role==="founder"
      ?"家庭建立者"
      :member.role==="owner"
        ?"共同管理者"
        :"家庭成員";

    let actions="";

    const actionButton=(action,label,extraClass="")=>
      `<button type="button" class="member-action ${extraClass}"
        data-member-action="${action}"
        data-user-id="${esc(member.id)}"
        data-member-name="${esc(member.display_name||"家庭成員")}">${label}</button>`;

    if(!isCurrentUser && myRole==="founder"){
      if(member.role==="member"){
        actions+=actionButton("promote","升級管理者");
      }
      if(member.role==="owner"){
        actions+=actionButton("demote","降為一般成員");
      }
      actions+=actionButton("remove","移除成員","danger");
      actions+=actionButton("transfer","轉移建立者");
    }else if(!isCurrentUser && myRole==="owner" && member.role==="member"){
      actions+=actionButton("promote","升級管理者");
      actions+=actionButton("remove","移除成員","danger");
    }

    return `<div class="member-row">
      <div class="member-avatar">👤</div>
      <div class="member-info">
        <strong>${esc(member.display_name||"家庭成員")}</strong>
        <span class="muted">${isCurrentUser?"目前登入帳號":""}</span>
      </div>
      <span class="member-role">${roleLabel}</span>
      ${actions?`<div class="member-actions">${actions}</div>`:""}
    </div>`;
  }).join(""):'<p class="muted">目前沒有家庭成員資料。</p>';
}



const memberActionsContainer=$("household-members-list");

if(memberActionsContainer){
  memberActionsContainer.addEventListener("click",async e=>{
    const button=e.target.closest("[data-member-action]");
    if(!button)return;

    const action=button.dataset.memberAction;
    const memberId=button.dataset.userId;
    const memberName=button.dataset.memberName;

    const actionNames={
      promote:"升級為共同管理者",
      demote:"降為一般成員",
      remove:"移除家庭成員",
      transfer:"轉移家庭建立者身分"
    };

    if(!actionNames[action])return;

    const confirmMessages={
      promote:`確定要將 ${memberName} 升級為共同管理者嗎？`,
      demote:`確定要將 ${memberName} 降為一般成員嗎？`,
      remove:`確定要將 ${memberName} 移出家庭嗎？`,
      transfer:`確定將家庭建立者身分轉移給 ${memberName} 嗎？你將變成共同管理者。`
    };

    if(!window.confirm(confirmMessages[action]))return;

    const rpcNames={
      promote:"promote_household_member",
      demote:"demote_household_member",
      remove:"remove_household_member",
      transfer:"transfer_household_founder"
    };

    button.disabled=true;

    try{
      const {error}=await sb.rpc(rpcNames[action],{
        p_household_id:household.id,
        p_user_id:memberId
      });

      if(error)throw error;

      msg(`${memberName}：${actionNames[action]}成功。`);
      await refreshData();
    }catch(error){
      msg(error.message||"操作失敗，請稍後再試。");
      button.disabled=false;
    }
  });
}
$("profile-form").addEventListener("submit",async e=>{
    e.preventDefault();
    const display_name=$("display-name").value.trim();
    const {error}=await sb.from("profiles").update({display_name}).eq("id",user.id);
    if(error)msg(error.message);else {msg("顯示名稱已更新。");await refreshData();}
  });
  function renderHistory(){
    const year=historyMonth.getFullYear();
    const month=historyMonth.getMonth();
    const monthLabel=`${year} 年 ${String(month+1).padStart(2,"0")} 月`;
    const firstDay=new Date(year,month,1).getDay();
    const daysInMonth=new Date(year,month+1,0).getDate();

    const calendarCells=Array(firstDay).fill('<span class="calendar-empty"></span>');
    for(let day=1;day<=daysInMonth;day++){
      const date=`${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const hasRecords=historyFeedings.some(f=>f.feeding_date===date);
      calendarCells.push(`<button type="button" class="calendar-day ${selectedHistoryDate===date?"selected":""} ${hasRecords?"has-records":""}" data-date="${date}">${day}${hasRecords?'<span class="calendar-dot"></span>':""}</button>`);
    }

    const petOptions=pets.map(p=>`<option value="${esc(p.id)}" ${selectedPet===p.id?"selected":""}>${esc(p.name)}</option>`).join("");
    const feederOptions=members.map(m=>`<option value="${esc(m.id)}" ${selectedFeeder===m.id?"selected":""}>${esc(m.display_name||"家庭成員")}</option>`).join("");

    const filtered=historyFeedings.filter(f=>
      f.feeding_date===selectedHistoryDate &&
      (selectedPet==="all"||f.pet_id===selectedPet) &&
      (selectedFeeder==="all"||f.fed_by===selectedFeeder)
    );

    $("feeding-history").innerHTML=`
      <div class="history-calendar">
        <div class="calendar-toolbar">
          <button type="button" class="secondary" id="history-prev">‹</button>
          <strong>${monthLabel}</strong>
          <button type="button" class="secondary" id="history-next">›</button>
        </div>
        <div class="calendar-weekdays">
          ${["日","一","二","三","四","五","六"].map(d=>`<span>${d}</span>`).join("")}
        </div>
        <div class="calendar-grid">${calendarCells.join("")}</div>
        <p class="muted calendar-hint">有圓點表示當天有餵食紀錄，點選日期查看。</p>
      </div>
      <div class="history-filters">
        <label>寵物
          <select id="history-pet-filter">
            <option value="all">全部寵物</option>${petOptions}
          </select>
        </label>
        <label>餵食者
          <select id="history-feeder-filter">
            <option value="all">所有家庭成員</option>${feederOptions}
          </select>
        </label>
      </div>
      <h3 class="history-date-title">${selectedHistoryDate==="all"?"全部日期":selectedHistoryDate}</h3>
      <div class="history-record-list">
        ${filtered.length?filtered.map(f=>`<div class="meal-item"><div><strong>${esc(f.pets?.name||"寵物")} · ${esc(f.meal_types?.name||"餐次")}</strong><br><span class="muted">餵食者：${esc(f.profiles?.display_name||"家庭成員")}　｜　${esc(timeText(f.fed_at))}</span></div></div>`).join(""):'<p class="muted">這一天沒有符合篩選條件的餵食紀錄。</p>'}
      </div>`;

    $("history-prev").onclick=async()=>{
      historyMonth=new Date(year,month-1,1);
      const day=Math.min(Number(selectedHistoryDate.slice(-2))||1,new Date(historyMonth.getFullYear(),historyMonth.getMonth()+1,0).getDate());
      selectedHistoryDate=`${historyMonth.getFullYear()}-${String(historyMonth.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      await refreshData();
    };
    $("history-next").onclick=async()=>{
      historyMonth=new Date(year,month+1,1);
      const day=Math.min(Number(selectedHistoryDate.slice(-2))||1,new Date(historyMonth.getFullYear(),historyMonth.getMonth()+1,0).getDate());
      selectedHistoryDate=`${historyMonth.getFullYear()}-${String(historyMonth.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      await refreshData();
    };
    $("feeding-history").querySelectorAll(".calendar-day").forEach(button=>{
      button.onclick=()=>{
        selectedHistoryDate=button.dataset.date;
        renderHistory();
      };
    });
    $("history-pet-filter").onchange=e=>{
      selectedPet=e.target.value;
      renderHistory();
    };
    $("history-feeder-filter").onchange=e=>{
      selectedFeeder=e.target.value;
      renderHistory();
    };
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
    show("pairing-panel");
  };

  $("copy-pairing").onclick=()=>{
    const code=$("pairing-code").textContent;
    if(!code)return;
    navigator.clipboard.writeText(code).then(()=>msg("已複製 LINE 配對碼"));
  };
  $("copy-invite").onclick=()=>navigator.clipboard.writeText($("invite-code").textContent).then(()=>msg("已複製邀請碼"));

  // Main navigation: home, feeding history, family settings
  document.querySelectorAll(".nav-item").forEach(button=>{
    button.addEventListener("click",()=>{
      const target=button.dataset.page;
      document.querySelectorAll(".app-page").forEach(page=>{
        page.classList.toggle("hidden",page.id!==target);
      });
      document.querySelectorAll(".nav-item").forEach(item=>{
        item.classList.toggle("active",item===button);
      });
      $("page-title").textContent=button.dataset.title;
      window.scrollTo({top:0,behavior:"smooth"});
    });
  });

  const params=new URLSearchParams(location.search);
  sb.auth.onAuthStateChange((_event,session)=>{user=session?.user||null;init();});
  init().then(async()=>{if(user&&params.get("pet")){await refreshData();const p=pets.find(x=>x.public_token===params.get("pet"));if(p){const m=meals.find(x=>x.pet_id===p.id);if(m)openFeed(p.id,m.id);}}});
})();