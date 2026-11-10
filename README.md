# PetFeeder｜多家庭寵物餵食紀錄

支援每個家庭多隻寵物、每隻寵物不限餐次與自訂餐名/時間、每個家庭獨立綁定 LINE 群組。每筆餵食紀錄會保存**寵物、餐次、餵食者帳號及實際時間**，並避免同一寵物同一餐次同一天重複登記。

> 這是可自行部署的完整起始專案，不代表已替你建立雲端服務或完成第三方帳號設定。正式公開營運前，請依下列步驟部署並完成安全測試。

## 專案內容
- `index.html`, `styles.css`, `app.js`：響應式網頁介面、Email Magic Link 登入、寵物/餐次管理、餵食紀錄。
- `supabase/migrations/001_initial.sql`：資料表、RLS、家庭建立/加入與 LINE 配對 RPC。
- `supabase/functions/line-webhook`：驗證 LINE 簽章，以一次性配對碼綁定群組。
- `supabase/functions/line-push`：確認登入者屬於該家庭後，發送餵食通知。
- `.github/workflows/pages.yml`：GitHub Pages 自動部署。

## 1. 建立 Supabase
1. 建立 Supabase project。
2. 到 SQL Editor 執行 `supabase/migrations/001_initial.sql`。
3. 到 Authentication → URL Configuration，將 Site URL 與 Redirect URLs 設為你的 GitHub Pages 網址，例如 `https://你的帳號.github.io/PetFeeder/`。
4. 在專案根目錄複製 `config.example.js` 為 `config.js`，填入 Project URL 與 anon/public key。`config.js` 已列入 `.gitignore`，請勿提交私密設定。GitHub Pages 若採用此方式，需改用 GitHub Actions Secrets 注入設定（見下方）。

## 2. 設定 LINE Messaging API
1. 建立 LINE Official Account，啟用 Messaging API，取得 Channel access token 與 Channel secret。
2. 在 LINE Developers 設定 Webhook URL：`https://<PROJECT_REF>.supabase.co/functions/v1/line-webhook`，並啟用 webhook。
3. 允許 Bot 加入群組/多人聊天室，將 Bot 邀請到每個家庭自己的 LINE 群組。
4. 在 Supabase Edge Function Secrets 設定：
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`（只放 Supabase Functions secrets，絕不可放前端）
5. 部署函式：
   ```bash
   supabase functions deploy line-webhook --no-verify-jwt
   supabase functions deploy line-push
   ```
6. 家庭擁有者登入 PetFeeder，按「產生 LINE 配對碼」，在已邀請 Bot 的家庭群組輸入 `綁定 配對碼`。配對碼 10 分鐘後失效且只能使用一次。

## 3. 本機測試
```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy line-webhook --no-verify-jwt
supabase functions deploy line-push
```
以靜態伺服器開啟網頁（不要直接用 `file://`），例如：
```bash
python3 -m http.server 8000
```
先複製並設定 `config.js`。

## 4. GitHub Pages 部署
1. 建立 GitHub repository，將本專案內容推送至 `main`。
2. Repository → Settings → Secrets and variables → Actions，新增：
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
3. Repository → Settings → Pages → Build and deployment，選 GitHub Actions。
4. 工作流程會產生 `config.js` 並部署至 Pages。
5. 把 Pages 網址加入 Supabase Auth Redirect URLs。

## 餵食者與時間如何記錄
- 登入者按下「是，我餵好了」時，資料庫以登入者的 `auth.uid()` 寫入 `fed_by`，不接受前端自行指定餵食者，避免冒名。
- `fed_at` 由資料庫 `now()` 產生，保存實際時間戳（timestamptz）。
- UI 顯示家庭成員名稱與台灣時間；LINE 訊息同步顯示寵物、餐次、餵食者與時間。
- 家庭成員可在個人資料中修改顯示名稱（目前可透過 Supabase `profiles.display_name` 更新；後續可擴充 UI）。

## NFC 使用方式
每隻寵物卡片的「查看 NFC 連結」會顯示專屬網址。將網址寫入 NTAG NFC 標籤即可。掃描後需登入家庭帳號，再選擇餐次並確認；NFC 本身不會在未經確認下自動寫入餵食紀錄。

## 資料與限制
- 一個帳號目前加入一個家庭；一個家庭可有多位成員。
- 每個家庭最多綁定一個 LINE 群組；一個 LINE 群組不能重複綁定不同家庭。
- 每日重複判斷依 `Asia/Taipei` 日期。若將來開放不同時區，應把餵食日期改為依 household.timezone 在資料庫端計算。
- 餐次更新採停用舊餐次並建立新餐次；既有餵食紀錄保留原始餐次關聯。
- LINE 推播失敗不會回滾已成功寫入的餵食紀錄。

## 上線前必做的安全/品質檢查
1. 目前 SQL 的家庭成員/擁有者政策適合小規模試用；公開 SaaS 前請進行獨立 RLS 審查、濫用/速率限制、邀請碼輪替、資料刪除與隱私政策測試。
2. 對 `pets`/`meal_types` 的 UPDATE/DELETE 可再細分角色，避免一般成員修改家庭設定。
3. `line-push` 應加上請求頻率限制及重送/冪等機制；LINE API 配額依官方帳號方案而定。
4. 請設定 Supabase Auth SMTP 與備援登入方式，並測試手機 Safari、iOS NFC、LINE 群組 webhook。
5. 本專案未內建付款、訂閱、管理後台、客服與多語系功能。

## 資料表核心欄位
- `pets`: 家庭、寵物名稱、種類、公開 NFC token
- `meal_types`: 寵物、餐名、排程時間、排序
- `feedings`: 寵物、餐次、餵食日期、`fed_at`、`fed_by`
- `profiles`: 成員顯示名稱
- `households`: 家庭與獨立 LINE group id
