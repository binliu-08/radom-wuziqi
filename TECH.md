# 局域网五子棋 — 技术文档

> 状态：已实现（与代码同步）  
> 日期：2026-08-21

---

## 1. 目标

在当前目录实现一个**浏览器网页对战**的五子棋小游戏：

- 本机启动服务后，同局域网内另一名玩家可通过房间号或链接加入
- 功能范围仅限：建房/加入、对局、胜负判定、「再来一局」
- **不包含**：悔棋、聊天、观战、AI、账号体系

### 1.1 可验证验收标准

| 编号 | 验收项 |
|------|--------|
| A1 | `npm start`（或等价命令）后，本机浏览器可打开游戏页 |
| A2 | 终端打印本机局域网访问地址（如 `http://192.168.x.x:3000`） |
| A3 | 房主可创建房间，获得房间号与可分享链接 |
| A4 | 另一设备用房间号或链接加入同一房间 |
| A5 | 满 2 人后可对局；非法落子（非己方回合、非空位）被拒绝 |
| A6 | 五子连珠正确判胜；棋盘下满且无胜者判和 |
| A7 | 首局：房主执黑先行 |
| A8 | 「再来一局」：上一局**输家**执黑先行；和棋则保持上一局先手方 |
| A9 | 一方断线时，对局暂停并提示；重连/对方离开的行为见 §5.4 |

---

## 2. 玩法规则

### 2.1 棋盘与胜负

- 棋盘：**15×15**
- 落子：交叉点落子，黑白轮流，每次一子
- 胜利：横 / 竖 / 斜任意方向连续 **≥5** 同色子即胜（自由五子棋，长连也算胜）
- 和棋：棋盘无空位且无人达成五连

### 2.2 先手（执黑）规则

| 场景 | 谁执黑（先行） |
|------|----------------|
| 房间创建后的**第一局** | **房主** |
| 「再来一局」且上一局有胜负 | **上一局的输家** |
| 「再来一局」且上一局为和棋 | **保持上一局的先手方**（避免无意义随机） |

说明：

- 「房主」= 创建房间的那名玩家，房间生命周期内身份不变
- 黑棋固定为先手；白棋为后手
- 再来一局时，双方颜色可能对调（例如：首局房主黑、客人白；房主赢 → 下一局客人执黑）

### 2.3 开局条件

- 房间内必须恰好 **2** 名玩家才进入可落子状态
- 未满 2 人时展示等待界面（房间号 + 链接），不可落子

---

## 3. 技术选型

| 层级 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js（LTS） | 与 WebSocket 生态契合，部署简单 |
| HTTP | Express | 托管静态前端、健康检查 |
| 实时通信 | `ws`（原生 WebSocket） | 对战只需推送状态，无需 Socket.IO 全套能力，依赖更轻 |
| 前端 | 原生 HTML + CSS + JS | 无构建步骤，本地启动即用 |
| 房间 ID | 短码（如 6 位大写字母数字） | 口头/局域网分享方便 |

**备选方案对比（已取舍）：**

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| Express + `ws` | 轻量、够用 | 需自管心跳/重连 | **采用** |
| Socket.IO | 断线重连开箱即用 | 偏重 | 本期不需要 |
| Python Flask + SocketIO | 亦可 | 与目录空项目无既有栈绑定，Node 前端协作更直接 | 不采用 |

---

## 4. 目录结构（拟）

```
radom-wuziqi/
├── TECH.md                 # 本文档
├── README.md               # 启动说明（实现阶段补充）
├── package.json
├── server/
│   ├── index.js            # HTTP + WebSocket 入口
│   ├── roomManager.js      # 房间创建/加入/销毁
│   ├── game.js             # 棋盘、落子校验、胜负、先手轮换
│   └── protocol.js         # 消息类型常量（可选）
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## 5. 系统架构

```
浏览器 A（房主）          浏览器 B（客人）
     │                         │
     │   WebSocket             │   WebSocket
     └──────────┬──────────────┘
                │
         Node 服务 (0.0.0.0:PORT)
         ├── Express 静态资源
         └── RoomManager
                └── Room { players, gameState }
```

- HTTP：只负责静态页与（可选）健康检查
- 游戏状态以**服务端为权威**；客户端只发意图（join / move / rematch），展示服务端下发的快照

### 5.1 房间模型

```text
Room {
  id: string                 // 房间号
  hostId: string             // 房主 playerId（首局执黑依据）
  players: Map<playerId, {
    id, name?, ws, role      // role: 'host' | 'guest'
  }>
  game: GameState | null     // 未满 2 人可为 null / waiting
  status: 'waiting' | 'playing' | 'finished'
}
```

### 5.2 对局状态（GameState）

```text
GameState {
  board: number[15][15]      // 0 空, 1 黑, 2 白
  blackPlayerId: string      // 当前局执黑者
  whitePlayerId: string
  current: 1 | 2             // 当前该谁下
  winner: null | 1 | 2 | 0   // null 进行中；1/2 胜；0 和
  moveCount: number
}
```

颜色与玩家绑定按「当前局」的 `blackPlayerId` / `whitePlayerId` 决定，再来一局时重新计算。

### 5.3 先手轮换算法

```text
function resolveBlackPlayerId(room, previousResult):
  // previousResult: null（首局）| { winnerPlayerId } | { draw: true }

  if previousResult == null:
    return room.hostId

  if previousResult.draw:
    return room.game.blackPlayerId   // 保持上一局先手

  // 有胜者 → 输家执黑
  loserId = 对方玩家 id（非 winnerPlayerId）
  return loserId
```

「再来一局」流程：

1. 对局进入 `finished` 后，任一方可发送 `rematch_ready`（表示本人同意再来一局）
2. 服务端记录双方的确认状态，并通过 `room_update` 下发（如 `rematchReady: { [playerId]: boolean }`），前端展示「等待对方确认」/「对方已确认」
3. **双方都确认后**才重置棋盘、清空确认状态，并应用先手轮换算法开新局
4. 任一方在双方未齐确认前可发送 `rematch_cancel` 取消自己的确认（可选；实现时一并支持，避免误点无法反悔）

### 5.4 断线与离开（最小行为）

| 事件 | 行为 |
|------|------|
| 对局中一方 WebSocket 断开 | 房间标记暂停；另一方收到「对手已断开」提示；暂时不可落子 |
| 断开方在短时间（如 60s）内重连并带上 `playerId` | 恢复座位与对局 |
| 超时未重连，或主动离开 | 房间解散或回到 waiting；另一方可收到提示并回首页 |
| 等待中房主离开 | 解散房间 |
| 等待中客人离开 | 房间回到仅房主 waiting |
| 对局进行中（双方在线）任一方想离开 | 发起离开申请；对方同意后**整房解散**；对方可拒绝，申请方可取消 |
| 对局 paused（对方断线）在线方离开 | 可直接离开，无需同意 |

本期不做复杂的观战席与断线续下超过上述范围的能力。

---

## 6. 通信协议（WebSocket JSON）

约定：每条消息为 JSON，字段 `type` + `payload`。

### 6.1 客户端 → 服务端

| type | payload | 说明 |
|------|---------|------|
| `create_room` | `{ displayName? }` | 创建房间，成为房主 |
| `join_room` | `{ roomId, displayName? }` | 加入已有房间 |
| `place` | `{ x, y }` | 在当前房间落子（0–14） |
| `rematch_ready` | `{}` | 确认再来一局（双方都确认后开新局） |
| `rematch_cancel` | `{}` | 取消自己的再来一局确认 |
| `leave` | `{}` | 主动离开 |
| `ping` | `{}` | 可选心跳 |

客户端应在首次连接后由服务端分配并本地保存 `playerId`（`localStorage`），便于刷新/短暂断线重连。

### 6.2 服务端 → 客户端

| type | payload | 说明 |
|------|---------|------|
| `welcome` | `{ playerId }` | 连接成功 |
| `room_update` | `{ roomId, status, players, youAre, shareUrl, game? }` | 房间全量/增量快照 |
| `error` | `{ code, message }` | 如房间不存在、满员、非法落子 |
| `pong` | `{}` | 心跳响应 |

`youAre` 示例：`{ playerId, color: 'black'|'white'|null, isHost: boolean }`  
`game` 在 waiting 时可为 `null`；playing/finished 时带上 `board`、`current`、`winner`、先手信息等。

### 6.3 错误码（示例）

| code | 含义 |
|------|------|
| `ROOM_NOT_FOUND` | 房间不存在 |
| `ROOM_FULL` | 已有两人 |
| `NOT_YOUR_TURN` | 非己方回合 |
| `INVALID_MOVE` | 坐标非法或非空位 |
| `NOT_READY` | 未在 playing 状态 |

---

## 7. 前端交互

### 7.1 页面状态机

```text
lobby（首页）
  → creating / joining
  → waiting（展示房间号、复制链接、等待对手）
  → playing（棋盘可点）
  → finished（胜负文案 + 「再来一局」）
  →（对手断开）paused 提示
```

### 7.2 UI 要素（精简）

- 首页：创建房间、输入房间号加入
- 等待页：房间号、一键复制链接、`http://<lan-ip>:<port>/?room=XXXXXX`
- 棋盘：15×15；标明己方颜色、当前回合
- 结束：胜 / 负 / 和 + 再来一局按钮
- 不引入聊天、排行、复杂动画库

### 7.3 视觉

- 单页、棋盘为视觉中心；木质棋盘色 + 黑白子即可
- 适配桌面与手机浏览器（触控落子）

---

## 8. 服务启动与局域网

- 监听：`0.0.0.0`，默认端口 `3000`（可用环境变量 `PORT` 覆盖）
- 启动时打印：
  - 本机：`http://localhost:3000`
  - 局域网：枚举常见网卡 IPv4，打印 `http://<ip>:3000`
- 分享链接使用**访问者当前打开的 host**（或等待页展示服务端探测到的 LAN 地址），保证对方点开即带 `?room=`

---

## 9. 实现顺序（评审通过后执行）

1. 脚手架：`package.json`、Express 静态托管、WebSocket 升级
2. `game.js`：棋盘、落子、胜负、先手解析（含单测或手测用例）
3. `roomManager.js`：创建/加入/离开/广播
4. 前端：大厅 → 等待 → 对局 → 再来一局
5. 局域网地址打印与 `?room=` 深链
6. README 启动说明 + 自测清单（对照 §1.1）

---

## 10. 待评审确认点

已确认：

- [x] **再来一局**：必须双方都点确认后才开新局
- [x] **和棋后再来一局**：保持上一局先手方

文档规则已对齐上述确认项。确认无误后回复「按文档实现」，或标注其他修改项，再进入编码阶段。
