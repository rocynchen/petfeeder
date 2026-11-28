(() => {
  const cfg = window.PETFEEDER_CONFIG || {};
  const $ = id => document.getElementById(id);
  const show = (id, yes=true) => $(id).classList.toggle("hidden", !yes);
  const msg = (s) => alert(s);
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_")) { show("setup"); return; }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  let user=null, household=null, pets=[], meals=[], feedings=[], historyRecords=[], activePet=null, members=[], historyMonth=null, selectedHistoryDate="", selectedFeeder="all", selectedPet="all", selectedRecordType="all";
let householdChannel = null;
  const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const taipeiDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const dateKey = (value = new Date()) => taipeiDate.format(new Date(value));
  const timeText = v => new Date(v).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
  let displayNamePromptPending=false;
  async function init() {
    const {data:{session}} = await sb.auth.getSession();
    user=session?.user || null;
    $("user-area").textContent="";
    $("profile-email").textContent=user?.email || "";
    show("auth",!user); show("app",!!user);
    displayNamePromptPending=false;
    if(user){
      const {data:profile}=await sb.from("profiles")
        .select("display_name,display_name_prompt_seen").eq("id",user.id).maybeSingle();
      displayNamePromptPending=profile?.display_name_prompt_seen===false;
      const displayName=profile?.display_name?.trim() || "";
      $("display-name").value=displayName;
      $("user-area").textContent=displayName || "使用者";
      await load();
    }
  }
  $("login-form").addEventListener("submit", async e => {
  e.preventDefault();

  const email = $("email").value.trim();
  const { error } = await sb.auth.signInWithOtp({ email });

  if (error) {
    $("auth-message").textContent = "寄送失敗：" + error.message;
    return;
  }

  $("otp-form").classList.remove("hidden");
  $("auth-message").textContent = "驗證碼已寄出，請查看信箱。";
});

$("otp-form").addEventListener("submit", async e => {
  e.preventDefault();

  const email = $("email").value.trim();
  const token = $("otp-token").value.trim();

  const { error } = await sb.auth.verifyOtp({
    email,
    token,
    type: "email"
  });

  if (error) {
    $("auth-message").textContent = "驗證失敗：" + error.message;
    return;
  }

  $("auth-message").textContent = "登入成功，正在載入 PetFeeder…";
});
  document.querySelectorAll("[data-signout]").forEach(button=>{
    button.onclick=async()=>{await sb.auth.signOut();location.reload();};
  });
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
if (householdChannel) {
  await sb.removeChannel(householdChannel);
  householdChannel = null;
}

householdChannel = sb.channel("household-" + household.id)
  .on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "feedings",
      filter: "household_id=eq." + household.id
    },
    refreshData
  )
  .on("postgres_changes",{event:"*",schema:"public",table:"medication_plans",filter:"household_id=eq."+household.id},loadMedication)
  .on("postgres_changes",{event:"INSERT",schema:"public",table:"medication_records",filter:"household_id=eq."+household.id},()=>{
    loadMedication();
    loadHistory();
  })
  .subscribe();
  }
  async function refreshData(){
    if(!household)return;

    if(!selectedHistoryDate){
      selectedHistoryDate=dateKey();
      historyMonth=new Date(`${selectedHistoryDate.slice(0,7)}-01T12:00:00`);
    }

    const [p,m,f]=await Promise.all([
      sb.from("pets").select("*").eq("household_id",household.id).eq("active",true).order("created_at"),
      sb.from("meal_types").select("*").eq("household_id",household.id).eq("active",true).order("sort_order"),
      sb.from("feedings").select("*,pets(name),meal_types(name),profiles(display_name)").eq("household_id",household.id).gte("fed_at",new Date(Date.now()-30*86400000).toISOString()).order("fed_at",{ascending:false}),
    ]);

    if(p.error||m.error||f.error){
      console.error(p.error,m.error,f.error);
      msg("載入資料失敗，請稍後再試。");
      return;
    }

    pets=p.data||[];
    meals=m.data||[];
    feedings=f.data||[];

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

    renderPets();
    renderBathForm();
    renderHouseholdMembers();
    await Promise.all([loadHistory(),loadMedication()]);
  }


function openStoolDialog(){
  if(!pets.length){
    msg("請先新增寵物，再建立異常便便紀錄。");
    return;
  }

  $("stool-form").reset();

  $("stool-pet").innerHTML=pets.map(p=>
    `<option value="${p.id}">${esc(p.name)}</option>`
  ).join("");

  $("stool-recorded-at").value=
    new Date(Date.now()-new Date().getTimezoneOffset()*60000)
      .toISOString().slice(0,16);

  $("stool-dialog").showModal();
}

$("add-stool-record").onclick=openStoolDialog;

$("close-stool-dialog").onclick=()=>{
  $("stool-dialog").close();
};

$("cancel-stool").onclick=()=>{
  $("stool-dialog").close();
};


$("stool-form").addEventListener("submit",async e=>{
  e.preventDefault();

  const petId=$("stool-pet").value;
  const stoolType=$("stool-type").value;
  const recordedValue=$("stool-recorded-at").value;
if(!recordedValue){
  msg("請選擇紀錄時間。");
  return;
}
const recordedAt=new Date(recordedValue).toISOString();
  const symptoms=[...document.querySelectorAll('input[name="stool-symptom"]:checked')]
    .map(input=>input.value);
  const note=$("stool-note").value.trim();

  const saveButton=$("save-stool");
  saveButton.disabled=true;

  try{
    const {error}=await sb.from("stool_records").insert({
      household_id:household.id,
      pet_id:petId,
      recorded_by:user.id,
      stool_type:stoolType,
      recorded_at:recordedAt,
      symptoms,
      note:note||null
    });

    if(error)throw error;

    $("stool-dialog").close();
    msg("異常便便紀錄已儲存！");
    await refreshData();

  }catch(error){
    msg("儲存失敗："+error.message);
  }finally{
    saveButton.disabled=false;
  }
});
$("add-pad-change").onclick = async () => {
  if (!pets.length) {
    msg("請先新增寵物。");
    return;
  }

  const button = $("add-pad-change");
  button.disabled = true;

  try {
    const { data, error } = await sb
      .from("pad_changes")
      .insert({
        household_id: household.id,
        pet_id: pets[0].id,
        recorded_by: user.id
      })
      .select("id")
      .single();

    if (error) throw error;

    const { error: pushError } = await sb.functions.invoke(
      "line-push",
      { body: { pad_change_id: data.id } }
    );

    await refreshData();

    if (pushError) {
      console.error("尿墊紀錄已儲存，但 LINE 通知失敗：", pushError);
      msg("尿墊更換紀錄已儲存，但 LINE 通知未成功。");
    } else {
      msg("尿墊更換紀錄已儲存，LINE 通知已送出！");
    }

  } catch (error) {
    console.error(error);
    msg("尿墊更換紀錄失敗：" + error.message);
  } finally {
    button.disabled = false;
  }
};
const stoolTypeLabels={
  soft:"軟便",
  diarrhea:"腹瀉（水狀）",
  other:"其他異常"
};
const dewormingTypeLabels={internal:"體內驅蟲",external:"體外驅蟲"};

function bindDatedCareForm({key,label,table,dateId,dateColumn,details,requiredDetailsMessage}){
  const form=$(`${key}-form`);
  const dialog=$(`${key}-dialog`);
  const pet=$(`${key}-pet`);
  const date=$(dateId);
  const due=$(`${key}-due-on`);
  const status=$(`${key}-error`);
  const button=$(`save-${key}`);

  $(`add-${key}`).onclick=()=>{
    if(!pets.length){
      msg(`請先新增寵物，再建立${label}紀錄。`);
      return;
    }
    form.reset();
    pet.replaceChildren(...pets.map(p=>new Option(p.name,p.id)));
    date.max=dateKey();
    date.value=date.max;
    status.textContent="";
    dialog.showModal();
  };

  $(`cancel-${key}`).onclick=()=>dialog.close();
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    if(button.disabled)return;
    const recordDetails=details();
    if(!recordDetails){
      status.textContent=requiredDetailsMessage;
      return;
    }
    if(due.value&&due.value<=date.value){
      status.textContent="下次預計日期要晚於本次日期。";
      return;
    }
    status.textContent="";
    button.disabled=true;
    try {
      const {error}=await sb.from(table).insert({
        household_id:household.id,pet_id:pet.value,recorded_by:user.id,
        [dateColumn]:date.value,next_due_on:due.value||null,...recordDetails
      });
      if(error)throw error;
      dialog.close();
      await loadHistory();
      msg(`${label}紀錄已儲存。`);
    } catch(error){
      console.error(`${label}紀錄儲存失敗`,error);
      status.textContent="儲存失敗，請再試一次。";
    } finally {
      button.disabled=false;
    }
  });
}

bindDatedCareForm({
  key:"deworming",label:"驅蟲",table:"deworming_records",dateId:"dewormed-on",dateColumn:"treated_on",
  details:()=>({treatment_type:$("deworming-type").value})
});
bindDatedCareForm({
  key:"vaccination",label:"疫苗",table:"vaccination_records",dateId:"vaccinated-on",dateColumn:"vaccinated_on",
  requiredDetailsMessage:"請輸入疫苗名稱。",
  details:()=>{
    const name=$("vaccine-name").value.trim();
    return name ? {vaccine_name:name} : null;
  }
});

bindDatedCareForm({
  key:"vet-visit",label:"就醫",table:"vet_visit_records",dateId:"visited-on",dateColumn:"visited_on",
  requiredDetailsMessage:"請輸入就醫原因。",
  details:()=>{
    const reason=$("visit-reason").value.trim();
    return reason ? {visit_reason:reason,vet_notes:$("vet-notes").value.trim()||null} : null;
  }
});

let medicationLoadId=0;

async function loadMedication(){
  if(!household)return;
  const loadId=++medicationLoadId;
  const today=dateKey();
  const householdId=household.id;
  const [plans,given]=await Promise.all([
    sb.from("medication_plans").select("id,pet_id,medication_name,scheduled_time,starts_on,ends_on")
      .eq("household_id",householdId).eq("active",true).order("scheduled_time"),
    sb.from("medication_records").select("plan_id").eq("household_id",householdId).eq("medication_date",today)
  ]);
  if(loadId!==medicationLoadId)return;
  const slots=$("medication-slots");
  const status=$("medication-status");
  if(plans.error||given.error){
    slots.replaceChildren();
    status.textContent="目前無法確認用藥狀態，請稍後重新整理。";
    return;
  }
  const activePets=new Map(pets.map(pet=>[pet.id,pet.name]));
  const activePlans=plans.data.filter(plan=>activePets.has(plan.pet_id)&&(!plan.ends_on||plan.ends_on>=today));
  const givenIds=new Set(given.data.map(record=>record.plan_id));
  status.textContent=activePlans.length ? "" : "尚未設定用藥時段。";
  slots.innerHTML=activePlans.map(plan=>{
    const done=givenIds.has(plan.id);
    const upcoming=plan.starts_on>today;
    const label=`${activePets.get(plan.pet_id)} · ${plan.medication_name} · ${plan.scheduled_time.slice(0,5)}`;
    return `<div class="meal-item medication-slot">
      <div><strong>${esc(label)}</strong>
      ${upcoming?`<br><span class="muted">${esc(plan.starts_on)} 開始</span>`:""}</div>
      <div class="medication-actions">
        ${done?'<span class="fed">✓ 已給藥</span>':upcoming?"":`<button type="button" data-give="${esc(plan.id)}" aria-label="${esc(label)}，登記已給藥">已給藥</button>`}
        <button type="button" class="secondary" data-stop="${esc(plan.id)}" aria-label="結束${esc(label)}的用藥時段">結束時段</button>
      </div>
    </div>`;
  }).join("");
  slots.querySelectorAll("[data-give]").forEach(button=>{
    button.onclick=async()=>{
      button.disabled=true;
      const {data,error}=await sb.rpc("record_medication",{p_plan_id:button.dataset.give,p_expected_date:today});
      await Promise.all([loadMedication(),loadHistory()]);
      if(error)msg(error.message);
      else if(!data)msg("這個時段今天已有人登記給藥。");
    };
  });
  slots.querySelectorAll("[data-stop]").forEach(button=>{
    button.onclick=async()=>{
      if(!confirm("要結束這個用藥時段嗎？過往紀錄會保留。"))return;
      button.disabled=true;
      const {error}=await sb.rpc("stop_medication_plan",{p_plan_id:button.dataset.stop});
      await loadMedication();
      if(error)msg(error.message);
    };
  });
}

$("add-medication").onclick=()=>{
  if(!pets.length){msg("請先新增寵物，再設定用藥時段。");return;}
  $("medication-form").reset();
  $("medication-pet").replaceChildren(...pets.map(pet=>new Option(pet.name,pet.id)));
  $("medication-start").value=dateKey();
  $("medication-form-status").textContent="";
  $("medication-dialog").showModal();
};
$("cancel-medication").onclick=()=>$("medication-dialog").close();
$("medication-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const button=$("save-medication");
  if(button.disabled)return;
  const status=$("medication-form-status");
  const name=$("medication-name").value.trim();
  const start=$("medication-start").value;
  const end=$("medication-end").value;
  if(!name){status.textContent="請輸入藥品名稱。";return;}
  if(end&&end<start){status.textContent="結束日期不能早於開始日期。";return;}
  button.disabled=true;
  status.textContent="";
  try {
    const {error}=await sb.rpc("save_medication_plan",{
      p_pet_id:$("medication-pet").value,p_name:name,p_time:$("medication-time").value,
      p_starts_on:start,p_ends_on:end||null
    });
    if(error){status.textContent=error.message;return;}
    $("medication-dialog").close();
    await loadMedication();
  } finally {
    button.disabled=false;
  }
});

document.addEventListener("visibilitychange",()=>{
  if(!document.hidden&&!$("care-page").classList.contains("hidden"))loadMedication();
});

function renderBathForm(){
  const petSelect=$("bath-pet");
  const selected=petSelect.value;
  petSelect.replaceChildren(...pets.map(p=>new Option(p.name,p.id)));
  if(pets.some(p=>p.id===selected))petSelect.value=selected;
  show("bath-pet-label",pets.length>1);
  show("bath-pet",pets.length>1);
  $("add-bath").disabled=!pets.length;
  show("bath-no-pets",!pets.length);
}

$("add-bath").onclick=async()=>{
  const button=$("add-bath");
  const petId=$("bath-pet").value;
  if(!petId||!household||!user)return;
  button.disabled=true;
  try {
    const {data,error}=await sb.from("bath_records").insert({
      household_id:household.id, pet_id:petId, recorded_by:user.id
    }).select("id").single();
    if(error){
      msg("洗澡紀錄儲存失敗："+error.message);
      return;
    }
    const {data:notification,error:pushError}=await sb.functions.invoke("line-push",{
      body:{bath_record_id:data.id}
    });
    await refreshData();
    if(notification?.sent===true){
      msg("洗澡紀錄已儲存，LINE 通知已送出！");
    }else if(notification?.reason==="LINE group not connected"){
      msg("洗澡紀錄已儲存，家庭尚未綁定 LINE 群組。");
    }else{
      console.error("洗澡紀錄已儲存，但 LINE 通知失敗",pushError);
      msg("洗澡紀錄已儲存，但 LINE 通知未成功。");
    }
  } finally {
    button.disabled=!pets.length;
  }
};

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
async function saveDisplayName(display_name){
    const {error}=await sb.from("profiles").update({display_name}).eq("id",user.id);
    if(error)return error;
    $("display-name").value=display_name;
    $("user-area").textContent=display_name;
    return null;
  }
  $("profile-form").addEventListener("submit",async e=>{
    e.preventDefault();
    const displayName=$("display-name").value.trim();
    if(!displayName){msg("請輸入顯示名稱。");return;}
    const error=await saveDisplayName(displayName);
    if(error){msg(error.message);return;}
    msg("顯示名稱已更新。");
    await refreshData();
  });

  async function showDisplayNamePrompt(){
    if(!user||!displayNamePromptPending)return;
    displayNamePromptPending=false;
    const userId=user.id;
    const {data,error}=await sb.from("profiles").update({display_name_prompt_seen:true})
      .eq("id",userId).eq("display_name_prompt_seen",false).select("id").maybeSingle();
    if(error){
      console.error("無法記錄顯示名稱提示狀態",error);
      return;
    }
    if(!data||user?.id!==userId)return;
    $("first-name-form").reset();
    $("first-name-error").textContent="";
    $("first-name-dialog").showModal();
  }

  $("first-name-skip").onclick=()=>$("first-name-dialog").close();
  $("first-name-form").addEventListener("submit",async e=>{
    e.preventDefault();
    const displayName=$("first-display-name").value.trim();
    if(!displayName){
      $("first-name-error").textContent="請輸入顯示名稱。";
      return;
    }
    const button=$("first-name-save");
    button.disabled=true;
    try {
      const error=await saveDisplayName(displayName);
      if(error){
        $("first-name-error").textContent="儲存失敗，請再試一次。";
        return;
      }
      $("first-name-dialog").close();
      await refreshData();
    } finally {
      button.disabled=false;
    }
  });
  let historyLoadId=0;
  let historyError=false;

  async function loadHistory(){
    const loadId=++historyLoadId;
    const year=historyMonth.getFullYear();
    const month=historyMonth.getMonth();
    const monthStart=`${year}-${String(month+1).padStart(2,"0")}-01`;
    const nextMonth=new Date(year,month+1,1);
    const nextMonthStart=`${nextMonth.getFullYear()}-${String(nextMonth.getMonth()+1).padStart(2,"0")}-01`;
    const start=`${monthStart}T00:00:00+08:00`;
    const end=`${nextMonthStart}T00:00:00+08:00`;
    const householdId=household.id;

    async function readMonth(table,columns,dateColumn,from,to){
      const rows=[];
      const pageSize=500;
      for(let offset=0;;offset+=pageSize){
        const {data,error}=await sb.from(table).select(columns).eq("household_id",householdId)
          .gte(dateColumn,from).lt(dateColumn,to).order(dateColumn).order("id")
          .range(offset,offset+pageSize-1);
        if(error)throw error;
        rows.push(...data);
        if(data.length<pageSize)return rows;
      }
    }

    try {
      const [feeding,pad,bath,stool,deworming,vaccination,visits,medication]=await Promise.all([
        readMonth("feedings","*,pets(name),meal_types(name),profiles(display_name)","feeding_date",monthStart,nextMonthStart),
        readMonth("pad_changes","*,pets(name)","changed_at",start,end),
        readMonth("bath_records","*,pets(name)","bathed_at",start,end),
        readMonth("stool_records","*,pets(name)","recorded_at",start,end),
        readMonth("deworming_records","*,pets(name)","treated_on",monthStart,nextMonthStart),
        readMonth("vaccination_records","*,pets(name)","vaccinated_on",monthStart,nextMonthStart),
        readMonth("vet_visit_records","*,pets(name)","visited_on",monthStart,nextMonthStart),
        readMonth("medication_records","*,pets(name),medication_plans(medication_name,scheduled_time)","medication_date",monthStart,nextMonthStart)
      ]);
      if(loadId!==historyLoadId)return;
      const careRecord=(record,type,label,time,date=dateKey(time))=>({
        type,label,time,date,petId:record.pet_id,petName:record.pets?.name,
        memberId:record.recorded_by,memberName:members.find(m=>m.id===record.recorded_by)?.display_name,
        symptoms:record.symptoms,note:record.note
      });
      historyRecords=[
        ...feeding.map(f=>({
          type:"feeding",label:`餵食 · ${f.meal_types?.name||"餐次"}`,time:f.fed_at,date:f.feeding_date,
          petId:f.pet_id,petName:f.pets?.name,memberId:f.fed_by,memberName:f.profiles?.display_name
        })),
        ...pad.map(p=>careRecord(p,"pad","更換尿墊",p.changed_at)),
        ...bath.map(b=>careRecord(b,"bath","洗澡",b.bathed_at)),
        ...stool.map(s=>careRecord(s,"stool",`異常便便 · ${stoolTypeLabels[s.stool_type]||"其他異常"}`,s.recorded_at)),
        ...deworming.map(d=>({
          ...careRecord(d,"deworming",dewormingTypeLabels[d.treatment_type],null,d.treated_on),
          nextDueOn:d.next_due_on
        })),
        ...vaccination.map(v=>({
          ...careRecord(v,"vaccination",`疫苗 · ${v.vaccine_name}`,null,v.vaccinated_on),
          nextDueOn:v.next_due_on
        })),
        ...visits.map(v=>({
          ...careRecord(v,"vet-visit",`就醫 · ${v.visit_reason}`,null,v.visited_on),
          nextDueOn:v.next_due_on,
          note:v.vet_notes
        })),
        ...medication.map(m=>careRecord(m,"medication",
          `用藥 · ${m.medication_plans?.medication_name||"藥品"}${m.medication_plans?.scheduled_time?`（${m.medication_plans.scheduled_time.slice(0,5)} 時段）`:""}`,
          m.given_at,m.medication_date))
      ].sort((a,b)=>b.date.localeCompare(a.date)||
        (b.time?Date.parse(b.time):0)-(a.time?Date.parse(a.time):0));
      historyError=false;
    } catch(error){
      if(loadId!==historyLoadId)return;
      console.error("載入歷史紀錄失敗",error);
      historyRecords=[];
      historyError=true;
    }
    renderHistory();
  }

  function renderHistory(){
    const year=historyMonth.getFullYear();
    const month=historyMonth.getMonth();
    const monthLabel=`${year} 年 ${String(month+1).padStart(2,"0")} 月`;
    const firstDay=new Date(year,month,1).getDay();
    const daysInMonth=new Date(year,month+1,0).getDate();

    const matchingRecords=historyRecords.filter(record=>
      (selectedRecordType==="all"||record.type===selectedRecordType) &&
      (selectedPet==="all"||record.petId===selectedPet) &&
      (selectedFeeder==="all"||record.memberId===selectedFeeder)
    );
    const recordDates=new Set(matchingRecords.map(record=>record.date));
    const calendarCells=Array(firstDay).fill('<span class="calendar-empty"></span>');
    for(let day=1;day<=daysInMonth;day++){
      const date=`${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const hasRecords=recordDates.has(date);
      calendarCells.push(`<button type="button" class="calendar-day ${selectedHistoryDate===date?"selected":""} ${hasRecords?"has-records":""}" data-date="${date}">${day}${hasRecords?'<span class="calendar-dot"></span>':""}</button>`);
    }

    const petOptions=pets.map(p=>`<option value="${esc(p.id)}" ${selectedPet===p.id?"selected":""}>${esc(p.name)}</option>`).join("");
    const feederOptions=members.map(m=>`<option value="${esc(m.id)}" ${selectedFeeder===m.id?"selected":""}>${esc(m.display_name||"家庭成員")}</option>`).join("");

    const filtered=matchingRecords.filter(record=>record.date===selectedHistoryDate);

    $("daily-history").innerHTML=`
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
        <p class="muted calendar-hint">有圓點的日期有符合篩選的紀錄。</p>
      </div>
      <div class="history-filters">
        <label>紀錄類型
          <select id="history-type-filter">
            <option value="all">全部類型</option>
            <option value="feeding">餵食</option>
            <option value="bath">洗澡</option>
            <option value="pad">換尿墊</option>
            <option value="stool">異常便便</option>
            <option value="deworming">驅蟲</option>
            <option value="vaccination">疫苗</option>
            <option value="vet-visit">就醫</option>
            <option value="medication">用藥</option>
          </select>
        </label>
        <label>寵物
          <select id="history-pet-filter">
            <option value="all">全部寵物</option>${petOptions}
          </select>
        </label>
        <label>紀錄者
          <select id="history-feeder-filter">
            <option value="all">所有家庭成員</option>${feederOptions}
          </select>
        </label>
      </div>
      <h3 class="history-date-title">${selectedHistoryDate}</h3>
      <div class="history-record-list">
        ${historyError?'<p class="muted">暫時無法載入歷史紀錄，請稍後重新整理。</p>':
          filtered.length?filtered.map(record=>`<div class="meal-item"><div>
            <strong>${esc(record.petName||"寵物")} · ${esc(record.label)}</strong><br>
            <span class="muted">紀錄者：${esc(record.memberName||"家庭成員")}${record.time?`　｜　${esc(timeText(record.time))}`:""}</span>
            ${record.nextDueOn?`<p class="muted">${record.type==="vet-visit"?"下次回診日期":"下次預計日期"}：${esc(record.nextDueOn)}</p>`:""}
            ${record.symptoms?.length?`<p class="muted">症狀：${record.symptoms.map(esc).join("、")}</p>`:""}
            ${record.note?`<p class="history-record-note">${record.type==="vet-visit"?"獸醫交代：":""}${esc(record.note)}</p>`:""}
          </div></div>`).join(""):'<p class="muted">這一天沒有符合篩選條件的紀錄。</p>'}
      </div>`;

    const changeMonth=async offset=>{
      historyMonth=new Date(year,month+offset,1);
      const day=Math.min(Number(selectedHistoryDate.slice(-2)),new Date(historyMonth.getFullYear(),historyMonth.getMonth()+1,0).getDate());
      selectedHistoryDate=`${historyMonth.getFullYear()}-${String(historyMonth.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      $("history-prev").disabled=true;
      $("history-next").disabled=true;
      $("daily-history").querySelectorAll(".calendar-day").forEach(button=>{button.disabled=true;});
      await loadHistory();
    };
    $("history-prev").onclick=()=>changeMonth(-1);
    $("history-next").onclick=()=>changeMonth(1);
    $("daily-history").querySelectorAll(".calendar-day").forEach(button=>{
      button.onclick=()=>{
        selectedHistoryDate=button.dataset.date;
        renderHistory();
      };
    });
    $("history-type-filter").value=selectedRecordType;
    $("history-type-filter").onchange=e=>{
      selectedRecordType=e.target.value;
      renderHistory();
      $("history-type-filter").focus();
    };
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
    row.dataset.mealId=m.id||"";
    const reminderToggle=row.querySelector(".meal-reminder-enabled");
    const reminderTime=row.querySelector(".meal-reminder-time");
    reminderToggle.checked=!!m.reminder_time;
    reminderTime.value=m.reminder_time||"";
    const updateReminderField=()=>{
      reminderTime.disabled=!reminderToggle.checked;
      reminderTime.required=reminderToggle.checked;
    };
    reminderToggle.onchange=updateReminderField;
    updateReminderField();
    row.querySelector(".remove-meal").onclick=()=>row.remove();$("meal-editor").append(node);
  }
  $("add-meal").onclick=()=>addMealRow();
  $("save-pet").onclick=async()=>{
    const id=$("pet-id").value, name=$("pet-name").value.trim(), kind=$("pet-kind").value.trim();
    const rows=[...$("meal-editor").querySelectorAll(".meal-row")];
    if(!name||!rows.length){msg("請填寫寵物名稱，並至少設定一個餐次。");return;}
    if(!$("pet-form").reportValidity())return;
    const slots=rows.map((row,sort_order)=>({
      id:row.dataset.mealId||null,
      name:row.querySelector(".meal-name").value.trim(),
      scheduled_time:row.querySelector(".meal-time").value,
      reminder_time:row.querySelector(".meal-reminder-enabled").checked
        ? row.querySelector(".meal-reminder-time").value : null,
      sort_order
    }));
    if(slots.some(slot=>!slot.name)){
      msg("請填寫每個餐次的名稱。");
      return;
    }

    const button=$("save-pet");
    button.disabled=true;
    try {
      const {error}=await sb.rpc("save_pet_meals",{
        p_pet_id:id||null,p_household_id:household.id,p_name:name,p_kind:kind,p_meals:slots
      });
      if(error){msg(error.message);return;}
      $("pet-dialog").close();
      await refreshData();
    } finally {
      button.disabled=false;
    }
  };
  function renderPets(){
    $("pets").innerHTML=pets.length?pets.map(p=>{
      const pm=meals.filter(m=>m.pet_id===p.id), today=feedings.filter(f=>f.pet_id===p.id&&f.feeding_date===dateKey());
      return `<article class="pet-card"><div class="pet-top"><div><h3>🐾 ${esc(p.name)}</h3><span class="muted">${esc(p.kind||"")}</span></div><button class="secondary edit-pet" data-id="${p.id}">編輯</button></div><div class="meal-list">${pm.map(m=>{const f=today.find(x=>x.meal_id===m.id);return `<div class="meal-item"><div><strong>${esc(m.name)}</strong> <br><span class="${f?"fed":"muted"}">${f?`✓ ${esc(f.profiles?.display_name||"家庭成員")} · ${esc(timeText(f.fed_at))}`:"尚未餵食"}</span></div><button data-pet="${p.id}" data-meal="${m.id}" class="feed-one" ${f?"disabled":""}>${f?"已完成":"記錄餵食"}</button></div>`}).join("")}</div><button class="secondary show-nfc" data-id="${p.id}">查看 NFC 連結</button></article>`;
    }).join(""):`<div class="panel"><p>尚未新增寵物，按「新增寵物」開始設定。</p></div>`;
    document.querySelectorAll(".edit-pet").forEach(b=>b.onclick=()=>openPet(pets.find(p=>p.id===b.dataset.id)));
    document.querySelectorAll(".feed-one").forEach(b=>b.onclick=()=>openFeed(b.dataset.pet,b.dataset.meal));
    document.querySelectorAll(".show-nfc").forEach(b=>b.onclick=()=>{const p=pets.find(x=>x.id===b.dataset.id);const url=location.origin+location.pathname+"?pet="+p.public_token;msg("請將此網址寫入 NTAG NFC 標籤：\\n"+url);});
  }
  function openFeed(petId,mealId){
    const p=pets.find(x=>x.id===petId), pm=meals.filter(x=>x.pet_id===petId);
    $("feed-pet-id").value=petId;$("feed-title").textContent=`你餵了${p.name}嗎？`;
    $("feed-meal").innerHTML=pm.map(m=>`<option value="${m.id}" ${m.id===mealId?"selected":""}>${esc(m.name)}</option>`).join("");
    $("feed-dialog").showModal();
  }
$("cancel-feed").onclick=()=>{
  $("feed-dialog").close();
};
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
      if(target==="care-page")loadMedication();
      window.scrollTo({top:0,behavior:"smooth"});
    });
  });


const params = new URLSearchParams(location.search);
let nfcPromptOpened = false;
let initQueue = Promise.resolve();

async function initializeAndHandleNfc() {
  await init();
  handleNfc();
  if($("feed-dialog").open){
    $("feed-dialog").addEventListener("close",showDisplayNamePrompt,{once:true});
  }else{
    await showDisplayNamePrompt();
  }
}

function handleNfc() {
  if (!user || !params.get("pet") || nfcPromptOpened) return;

  const petToken = params.get("pet");
  const p = pets.find(x => x.public_token === petToken);

  if (!p) {
    msg("找不到這隻寵物，請確認 NFC 標籤。");
    return;
  }

  const m = meals.find(x => x.pet_id === p.id);

  if (!m) {
    msg("這隻寵物尚未設定餐次。");
    return;
  }

  nfcPromptOpened = true;
  openFeed(p.id, m.id);
}

function queueInitialization() {
  initQueue = initQueue
    .then(initializeAndHandleNfc)
    .catch(error => {
      console.error("PetFeeder 初始化失敗：", error);
      msg("網頁載入時發生問題，請重新整理。");
    });
}

sb.auth.onAuthStateChange(() => {
  setTimeout(queueInitialization, 0);
});

queueInitialization();

})();
