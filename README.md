# 《NULL：無聲協定》

三人線上合作的 3D 第一人稱密室逃脫。三位玩家各自被封住一種感官：

- **A 盲區員**：看不見，只能靠聲音辨位；聽得見、能說話
- **B 靜默員**：看得見；聽不見任何聲音；能說話
- **C 失語員**：看得見、聽得見；不能說話，也沒有文字聊天，只能用信號器

這些限制由**伺服器強制執行**（設備權限、依角色過濾的面板內容、語音路由、信號器過濾），不是靠玩家自律。第一章「失聯設施」是十個房間、十道謎題，每一題都需要三個人的資訊拼在一起才能解開（伺服器測試會窮舉確認每題唯一解、少任何一個人都解不開）。

## 功能

- React + TypeScript + Vite 前端，Three.js／React Three Fiber 3D 場景（第一人稱、碰撞、門、設備、隊友角色）
- Node + Express + Socket.IO 權威伺服器：房間（6 碼代碼）、選角、位置與速度驗證、章節引擎與十個謎題模組、統一的 `puzzle:action`（`requestId` 去重）、三層錯誤回饋、提示、失敗鎖定、同步窗口、斷線重連
- 依角色授權的 3D 場景線索（例如門燈只出現在靜默員的畫面、門後聲音只有盲區員聽得到）；依感官過濾的回饋事件
- 開發者工具（只在開發環境）：查看正解與條件、重置／直接完成謎題、重新初始化房間
- 內建 WebRTC 語音：依角色路由（盲區員→失語員、靜默員→盲區員、靜默員→失語員），伺服器驗證 signaling；空間音訊
- 盲區員：沒有環境影像（不載入 3D 場景），按 F 時出現約 3.6 秒的回聲視野（反白的房間與物品結構模型，冷卻 5 秒），以及振動提示。空間感知系統：方向基準（轉向提示、朝向播報、每個房間的參考音）、主動回聲（回聲視野＋16 道射線的材質音色與殘響）、聲學地標、回聲風險區（R8 的聲學感測器）、音訊校準與單聲道模式、分開的音量（見 [`docs/BLIND_NAVIGATION.md`](docs/BLIND_NAVIGATION.md)）；另有設備指引音、腳步／撞牆聲、語音播報
- 美術：3D 場景是 PS1 時代的工業恐怖——冷色、有限的方向光與硬陰影、霧、低解析度貼圖；朱紅只用於警示，黃銅只用於機械部件。介面是研究設施的技術文件排版；統一的 NULL 圖形符號（未閉合迴路、斷開路徑、錯位節點）
- 角色：程式產生的 PS1 風格低多邊形角色（Blender 腳本輸出 GLB：蒙皮網格、19 根骨骼、15 組動畫），三人靠感官裝置與剪影區分；動畫狀態機（待機、走、跑、起步、停下、轉身、蹲下、操作、觀察、受傷）；蹲下、操作、受傷會同步給隊友。正式模型可透過 manifest 替換（見 [`docs/CHARACTERS.md`](docs/CHARACTERS.md)）
- 信號器：敲擊／燈號／符號／手勢的固定詞彙，依接收者感官過濾
- 第一章十道謎題（線索分配與設計取捨見 [`docs/PUZZLES.md`](docs/PUZZLES.md)）、三層提示、失語員的標記工具、結局（只有全部完成才會出現）

設計細節見 [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md)，美術見 [`docs/ART_DIRECTION.md`](docs/ART_DIRECTION.md)，網路與安全見 [`docs/NETWORKING.md`](docs/NETWORKING.md)，測試見 [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)。

## 需求

- Node.js 20 以上（建議 22）
- 遊玩：桌機版 Chrome／Edge（Firefox 應可運作但未測試）、耳機、麥克風（盲區員與靜默員）

## 安裝與開發

```bash
npm install
npm run dev        # 伺服器 http://localhost:3001 + 前端 http://localhost:5173（Vite 代理 socket.io 與 /api）
```

開三個瀏覽器視窗（或三台電腦）打開 http://localhost:5173，一人建立房間、另外兩人輸入房間代碼加入，三人各選一個角色後由房主開始。
同一台電腦測試時開三個分頁即可（每個分頁有自己的重連憑證）；但三個分頁同時開麥克風會互相回授，建議戴耳機或只開一個麥克風。

開發模式下伺服器會開啟開發者工具：遊戲中按 `` ` `` 打開（查看正解、重置或直接完成目前謎題、重新初始化房間）。正式環境（`NODE_ENV=production`）預設關閉，可用 `DEBUG_TOOLS=1` 強制開啟。

角色預覽：http://localhost:5173/?preview=crew（`&clip=Walk&t=0.25&role=DEAF&cam=34&sil=1`）。

美術審視：不連伺服器的離線預覽 http://localhost:5173/?preview=room&room=4&role=MUTE（`start`／`room`／`ending`，可加 `&yaw=度`），細節見 `docs/ART_DIRECTION.md`。

## 測試

```bash
npm run typecheck   # shared / server / client / e2e 全部型別檢查
npm test            # 伺服器：共用框架、逐題行為、唯一解與三人必要性（窮舉）、Socket 整合（三個客戶端走完十題）、盲區員的聲學規則
```

瀏覽器端到端測試（三個 Chromium 透過 UI 從建立房間玩到結局；角色資產的載入失敗與正式模型匯入）：

```bash
npm run build && NODE_ENV=production npm start   # 另開一個終端機
npx playwright install chromium     # 第一次
npm run e2e
npm run e2e:assets
npm run e2e:blind   # 盲區員測試關卡：雙耳方位、音訊路由、風險區、自動玩家只靠聲音走完
```

盲區員測試關卡可以直接在瀏覽器開啟：`/?preview=blind-lab`（`&map=1` 顯示設計者用的俯視圖、`&mono=1` 單聲道）。

重新產生角色模型（需要 Python 3.13）：`pip install bpy==5.2.2 && npm run models`。產出的 GLB 已提交進版本庫，部署時不需要 Blender。

## 建置與部署

```bash
npm run build      # client → client/dist；server → server/dist/index.cjs
npm start          # 同一個 Node 程序提供前端、Socket.IO 與 API（PORT 預設 3001）
```

### Render

1. 把專案推上 GitHub。
2. Render → New → Blueprint，選這個 repo（會讀取 [`render.yaml`](render.yaml)），或手動建立 Web Service：
   - Build Command：`npm ci --include=dev && npm run build`
   - Start Command：`npm start`
   - Health Check Path：`/healthz`
   - 環境變數：`NODE_ENV=production`
3. （強烈建議）在 Render 後台設定 `TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL`。

環境變數說明見 [`.env.example`](.env.example)。

## 專案結構

```
shared/   前後端共用：角色、語音路由規則、信號器詞彙、關卡幾何與碰撞、事件型別、
          聲學資料與規則（acoustics.ts：回聲、參考音、地標、風險區）、盲區員測試關卡（blindLab.ts）
server/   權威伺服器
  src/rooms/        房間、玩家、位置驗證、事件處理、頻率限制
  src/game/chapter.ts           章節引擎：請求驗證、去重、權限、鎖定、提示、完成與開門、除錯
  src/game/chapter01/p01–p10    十個謎題模組（PuzzleModule）
  src/game/chapter01/data.ts    第一章固定資料與規則函式（答案只在這裡）
  src/voice/sdp.ts  語音 SDP 驗證
  test/             框架／逐題／必要性／整合測試與玩家模擬解題器
client/   前端
  src/game/         第一人稱控制器、3D 場景、遊戲迴圈
  src/game/characters/  角色資產載入與驗證、動畫狀態機、隊友模型
  src/game/blind/   盲區員的空間感知：方向基準、主動回聲、聲學地標、風險區預警、空間聲源管理
  src/audio/        程序化音訊引擎（Web Audio）、語音播報
  src/voice/        WebRTC 語音管理
  src/ui/           大廳、角色說明、HUD、設備面板、信號器、線索紀錄、說明、結局、開發者工具
tools/characters/build_crew.py   角色模型、骨架、動畫的產生器（Blender Python）
client/public/models/           角色 GLB 與 manifest.json
e2e/      瀏覽器端到端測試
docs/     設計、網路、測試文件
```

## 已知問題與限制

- **房間存在記憶體**：伺服器重啟或重新部署會清空所有房間；目前只適合單一伺服器實例（Render 免費方案閒置會休眠，第一次連線需要等待喚醒）。
- **語音穿越 NAT**：只有 STUN 時，部分網路（對稱型 NAT、公司／學校網路）可能無法建立語音，需要 TURN。語音只在同一台機器的三個無頭 Chromium 之間實測過。
- **十道謎題都沒有經過真人試玩**：可解性、唯一解與三人必要性由自動化測試保證，但難度、時間、提示是否足夠、規則文件是否讀得懂，都需要真人測試。P09（不曾發生的循環）的規則是依規格精神補完的（見 `docs/PUZZLES.md`），最需要試玩確認。
- **盲區員的空間感知系統未經真人試聽**：參考音、地標、回聲材質的音量與辨識度，以及 R8 感測器的週期長短，都是依原則選的參數，需要實際試玩調整（見 `docs/BLIND_NAVIGATION.md` 第 11 節）。
- **聽覺線索的辨識度未經真人測試**：音效全部即時合成；R02 門後聲音的方位（HRTF）、R04 四種回音、R07 左右聲源、R08 間歇震動，在一般耳機上是否分得出來需要實際試玩調整。
- **門洞傳送與移動中的競態**：玩家傳送前送出的最後幾個位置會被伺服器忽略 250 ms；在高延遲網路下，傳送後的第一步可能會被伺服器修正一次（畫面會輕微跳一下）。
- 3D 場景只在軟體算繪環境截圖確認過，沒有在真實 GPU 上量過幀率（軟體算繪下單一頁面約 4–5 fps；加入陰影與蒙皮角色後比原本慢）。
- **角色是程式產生的原型等級模型**，不是建模師手工製作的正式資產；動畫是手寫關鍵影格，沒有在真人試玩中檢查過手感。正式模型可以透過 manifest 替換，但共用動畫只適用於靜止姿勢相近的骨架（見 `docs/CHARACTERS.md` 的限制）。
- 步行速度由 3.4 m/s 調為 2.3 m/s、跑步 4.4 m/s（配合動畫步頻與恐怖節奏）；走完十個房間會比以前久。
- 開發者工具以「是否為正式環境」開關，沒有獨立的管理員帳號；若在正式環境以 `DEBUG_TOOLS=1` 開啟，房間裡的每個人都能使用。
- 遊戲無法阻止玩家使用外部通話軟體繞過角色限制；遊戲內提供的所有通道都遵守規則。
- 只有第一章；只支援桌機（鍵盤＋滑鼠，Pointer Lock）。
- 字型（Noto Sans TC、IBM Plex Mono）隨前端打包，`client/dist` 約 13 MB，但瀏覽器只會下載實際用到的字元子集。
