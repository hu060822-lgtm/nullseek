# 網路架構

## 1. 整體

```
瀏覽器（React + R3F）  ──Socket.IO──►  Node 伺服器（Express + Socket.IO）
   │                                     │  房間、角色、位置驗證、謎題狀態機、信號器過濾、語音 signaling 驗證
   └──────── WebRTC（純音訊，單向）────────┘（伺服器不經手音訊，只轉發並驗證 offer/answer/ICE）
```

- **伺服器權威**：房間、角色、位置、門、謎題狀態、提示、答案判定全部在伺服器。客戶端只送「意圖」（移動、開啟設備、按下按鈕、送出信號）。
- **單一服務部署**：正式環境由同一個 Node 程序提供 `client/dist`、Socket.IO 與 `/api/*`，前端永遠使用同源網址（不需要 CORS）。開發時 Vite 以 proxy 轉發 `/socket.io` 與 `/api`。
- 房間資料存在記憶體（重新部署或伺服器重啟會清空所有房間）。

## 2. 事件

型別定義在 `shared/src/events.ts`（前後端共用）。

客戶端 → 伺服器（全部有頻率限制，payload 一律視為不可信）：

| 事件 | 說明 |
| --- | --- |
| `room:create` `{name}` / `room:join` `{name, code}` | 建立／加入，回傳 `roomCode`、`token`（重連憑證，只回給本人）、`playerId` 與完整同步資料 |
| `room:rejoin` `{code, token}` | 斷線重連，恢復角色、位置、私人線索紀錄 |
| `room:leave` / `room:selectRole` / `room:start` / `room:restart` | 大廳操作（開始、重新開始只限房主） |
| `player:move` `{x,y,z,yaw,seq}` | 位置（約 15Hz，volatile） |
| `device:open` `{deviceId}` | 開啟設備面板（伺服器依角色產生內容） |
| `puzzle:action` `{puzzleId, actionType, targetId, payload, requestId}` | 規格 1.3 的統一謎題操作（設備按鈕、推門、走進門洞）。`requestId` 必填；客戶端逾時會用**同一個** `requestId` 重送一次 |
| `signal:emit` `{tokens}` | 信號器 |
| `signal:mark` `{targetId, token?}` | 失語員的標記工具（不推進任何謎題狀態） |
| `debug:state` / `debug:command` `{cmd}` | 開發者工具（見第 7 節） |
| `hint:request` | 請求下一層提示 |
| `voice:ready` / `voice:signal` | 語音 |

伺服器 → 客戶端：

| 事件 | 說明 |
| --- | --- |
| `room:state` | 大廳／房間狀態 |
| `puzzle:state` | 公開世界狀態：十題的狀態、目前謎題、門、階段資訊（嘗試次數、階段、同步剩餘時間）、提示。不含任何線索或答案 |
| `puzzle:clues` | **只給本人**的 3D 場景線索（依角色授權，例如門燈只給靜默員、門後聲音只給盲區員）；內容改變時才送 |
| `puzzle:feedback` | 謎題回饋（聲音／視覺／倒數）。依接收者感官過濾：聽不見的人收不到 `sound`、看不見的人收不到 `visual`，兩者都沒有就不送 |
| `puzzle:completed` / `puzzle:reset` / `puzzle:hint` | 完成（每題只廣播一次）、重置、提示 |
| `signal:received` / `signal:marker` | 信號、標記（附帶的符號依接收者感官過濾） |
| `world:positions` / `player:correct` | 位置（10Hz）、位置修正；`teleport: true` 表示謎題造成的傳送 |
| `player:log` | 私人線索紀錄 |
| `device:refresh` | 謎題狀態真的改變時，要求開著的面板重新取得內容（純查詢操作不會觸發，避免蓋掉操作回傳的專屬畫面） |
| `notice`、`chapter:complete`、`room:closed`、`game:restarted`、`voice:signal`、`voice:peer` | 其他 |

**任何廣播都不含重連憑證或答案**（整合測試會掃描所有事件確認）。

## 3. 移動驗證

- 前後端共用 `shared/src/level.ts` 的碰撞盒（牆、設備、尚未開啟的門）。
- 伺服器對每次移動：檢查數值合法、在地圖範圍內、以「累積移動額度」限制速度（`MAX_SPEED` 7 m/s，額度上限 2.5 m，不會因為單次封包容忍而被連續利用）、沿路徑做**掃掠碰撞檢查**（大步長也無法穿過薄牆）。違規時回 `player:correct` 把玩家拉回伺服器位置。
- `device:open`／`puzzle:action` 需在設備 `SERVER_INTERACT_RANGE`（3.6 m）內，且角色有權限；走進門洞需在門洞前 `SERVER_PORTAL_RANGE`（2 m）內。
- 謎題傳送後 250 ms 內收到的移動會被忽略（那是客戶端在收到傳送前送出的舊位置，否則會把玩家拉回門洞前）。

## 3.1 謎題操作的驗證順序（`server/src/game/chapter.ts`）

1. `requestId` 必填；同一位玩家重送同一個 `requestId` 直接回傳上一次的結果（每人保留最近 64 個）
2. `puzzleId` 合法、payload 不過大
3. 謎題已完成 → 拒絕；尚未開始 → 拒絕
4. 目標是存在的設備或門洞，且屬於目前謎題的房間
5. 角色有權限；這個角色在這台設備上沒有被鎖定
6. 交給謎題模組判定（客戶端送來的 `isCorrect`、`success` 之類欄位一律無效）
7. 成功時章節引擎做唯一一次「完成」轉換：開門、廣播 `puzzle:completed`、啟動下一題

## 4. 房間與重連

- 房間代碼 6 碼，字母表排除易混淆的 I/O/0/1，用 `crypto.randomInt` 產生；重連憑證為 192-bit 隨機值（`crypto.randomBytes`），以 `timingSafeEqual` 比對。
- 加入／重連失敗次數過多會被暫時封鎖（每個連線）。
- 憑證存在瀏覽器 `sessionStorage`（只在該分頁有效）；重新整理頁面會自動重連。同一個憑證在另一個分頁重連時，舊連線會被取代。
- 遊戲中斷線不會移除玩家：角色與進度保留，隊友看到「離線」；同步窗口會被取消，避免離線玩家讓同步「意外成功」或卡住。大廳中斷線有寬限時間，逾時才釋放位置。房主離線超過寬限時間會自動移交給在線的玩家。
- 閒置房間（預設 15 分鐘）會被清除。

## 5. 頻率限制

每個 socket 有獨立的 token bucket：一般操作（30，每秒回補 15）、移動（60／40）、語音 signaling（200／100）、建立房間（每分鐘 5 次）。信號器另有 1.2 秒冷卻與 6 個 token 上限。

## 6. 語音（WebRTC）

### 6.1 路由規則

`voiceEdgeAllowed(from, to) = from ≠ to ∧ canSpeak(from) ∧ canHear(to)`，結果恰為三條邊：

| 發話者 → 接收者 | 允許 |
| --- | --- |
| 盲區員 → 失語員 | ✅ |
| 靜默員 → 盲區員 | ✅ |
| 靜默員 → 失語員 | ✅ |
| 盲區員 → 靜默員 | ❌（靜默員聽不見） |
| 失語員 → 任何人 | ❌（失語員不能說話） |

### 6.2 連線方式

- **每條邊一條獨立、單向的 RTCPeerConnection**：發話者建立 `sendonly` 的純音訊 offer，接收者回 `recvonly` answer。
- 由發話者發起：伺服器以 `voice:peer` 通知「某位隊友的語音上線／離線」，發話者據此（重新）建立連線；連線失敗會自動重試。
- 伺服器在轉發之前驗證：
  1. 寄件者在房間內、有角色，且 socket 是該玩家目前的連線；
  2. 這條邊被角色規則允許；
  3. offer 只能由該邊的發話者送、answer 只能由接收者送（不能冒充）；
  4. SDP 只能有 `m=audio` 區段（拒絕 video 與 DataChannel，避免被當成隱蔽通道），方向必須是 offer=`sendonly`、answer=`recvonly`／`inactive`，長度有上限；
  5. ICE candidate 大小有上限。
  不符合的訊息直接丟棄。
- 客戶端的第二道防線：收到的 signaling 再檢查一次邊是否允許；聽不見的角色的音訊引擎拒絕接上任何遠端串流；失語員從不要求麥克風權限。

### 6.3 STUN／TURN

- ICE 伺服器由 `/api/ice-servers` 提供（TURN 憑證只放在伺服器環境變數）。預設只有公用 STUN。
- **正式上線強烈建議設定 TURN**（`TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL`）：在對稱型 NAT、公司或學校網路下，只有 STUN 時 P2P 可能連不上，語音會沒有聲音。
- 本專案在無頭 Chromium 中驗證過三個瀏覽器之間（同一台機器）建立的語音連線恰好是上面三條；尚未在真實的跨網路環境測試。

### 6.4 空間音訊

接收到的語音接到 Web Audio 的 HRTF `PannerNode`，位置跟著說話者在場景中的位置（衰減很緩和，跨房間仍聽得清楚），讓盲區員可以靠聲音判斷隊友方向。

## 7. 開發者工具（規格 8）

- 啟用條件：`DEBUG_TOOLS=1`，或 `NODE_ENV` 不是 `production` 且沒有設定 `DEBUG_TOOLS=0`。**正式環境預設關閉**：伺服器拒絕 `debug:*` 事件，同步資料的 `debug` 為 `false`，前端不會顯示面板。
- 功能（遊戲中按 `` ` ``）：查看目前謎題、狀態、正解、已滿足的條件、最近 10 筆操作、玩家與角色；重置目前謎題、直接完成目前謎題、重新初始化房間。
- 固定資料：第一章的謎題資料是固定的（種子 `chapter01-v1`），每局都一樣，方便重現問題。
