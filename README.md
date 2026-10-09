# dsh-damage-number

给 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 小鲸鱼挂件加一层「**伤害数字**」：
每轮对话的消耗落进你设定的区间时，在**鲸鱼头顶**弹出一个红色数字，向上飘起并淡出；区间内按概率随机，**达到区间上限必定弹出**。

就是「花了几分钱，鲸鱼头上跳一下红字」的那个手感 —— 多数时候随机、偶尔必中。

```
        -¥0.03        ← 弹出 → 过冲放大 → 上浮 96px → 淡出
          🐋
```

## 前置

需要先装好 **`dsh-whale-widget`**（本插件从它的 `/dsh-whale/last-turn.json` 读每轮金额）。
挂件没装时本插件不会报错，只是安静地什么都不做。

## 安装

### 桌面端（Electron 客户端）

桌面端读的是 `desktop` profile，而 `dsh plugin` 命令行**按设计拒绝**碰它
（`error: profile "desktop" is managed exclusively by the Electron application`）。
所以先在任意位置克隆本仓库，再**在桌面端的会话里让 DSH 自己装**：

```powershell
git clone https://github.com/water2H2O/dsh-damage-number.git D:\Plugins\dsh-damage-number
```

> 把 `dsh-damage-number` 装上，源目录是 `D:\Plugins\dsh-damage-number`

（它会调用内置 `plugin_manager`，在本 profile 里用自带 pnpm 完成 `link:` 安装并写进 `dsh.profile.bundles`。）

⚠️ 克隆到的目录**之后不能移动或重命名** —— `link:` 安装是指向该目录的软链，移动后要重新 add 一次。

### 普通 `dsh web`

```powershell
git clone https://github.com/water2H2O/dsh-damage-number.git
dsh plugin --profile web add link:<克隆到的绝对路径>
```

也可以直接按 Git 源安装（pnpm 会自己拉取）：

```powershell
dsh plugin --profile web add github:water2H2O/dsh-damage-number
```

> `link:` 是软链安装：源目录里的文件改了立即生效；**装完不能移动/重命名该目录**。
> 想改成拷贝安装用 `file:<绝对路径>`（此后源目录改动不同步，需重新 add）。
> 升级 `dsh-whale-widget` 不会影响本插件 —— 两者没有代码耦合，只通过 HTTP 接口通信。

## 生效方式

- 改 `lib/index.js`（宿主半区）→ **需要重开客户端**（或重启 `dsh web`）。
- 改 `assets/overlay.js`（浏览器半区）→ 宿主按 mtime 热读取，**硬刷新页面（Ctrl+F5）** 即生效。
- 注入行走的是 `webserver/index-inject` 结构化行（桌面端唯一通道）+ `tapIndex`（web 形态）。
  若新装后页面里没有反应，先刷新页面；仍无反应再重开客户端（桌面端存在"新装需要重开一次"的已知现象）。

## 触发规则

设区间 `[minAmount, maxAmount]`：

| 本轮消耗 | 行为 |
|---|---|
| `amount < minAmount` | 不跳 |
| `minAmount ≤ amount < maxAmount` | 以概率 `minProbability + (1 - minProbability) × 区间内进度` 跳 |
| `amount ≥ maxAmount` | **必定跳** |
| `minAmount == maxAmount` | 退化成纯阈值：达到即必跳 |

默认 `minAmount = 0.01`、`maxAmount = 0.10`、`minProbability = 0.25`：

| 消耗 | 触发概率 |
|---|---|
| ¥0.010 | 25% |
| ¥0.0325 | 43.75% |
| ¥0.055 | 62.5% |
| ¥0.0775 | 81.25% |
| ≥ ¥0.10 | 100% |

### 轮次对齐（刷新页面不漏）

触发靠轮询 `/dsh-whale/last-turn.json` 的 `seq`，并把"已结算到哪个 seq"持久化在
`localStorage` 的 `dshw-dmg-last-seq`（与小鲸鱼自己的 `dshw-last-seq` 分开）：

- **本机第一次运行**：只立基准，绝不把账本里的历史轮次当成"刚刚花的钱"补弹一遍。
- **刷新页面 / 重开客户端**：在页面不在时结束的那一轮会被补上（启动轮就判定），不会漏。
- **seq 落后于记忆**（挂件重启、`.dshw-turn.json` 丢失）：只拉齐基准，不飘字 —— 避免用陈旧基准乱跳。
- 浏览器禁用了 `localStorage`（隐私模式）：退化成"本次会话内对齐"，功能不报错。

## 配置

配置文件：`$DSH_HOME/.dshdmg.json`（默认 `~/.dsh/.dshdmg.json`），**不存在也能跑**（用默认值）。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `minAmount` | `0.01` | 伤害区间下限（元）：低于它必不跳 |
| `maxAmount` | `0.1` | 伤害区间上限（元）：达到/超过必跳 |
| `minProbability` | `0.25` | 刚好到下限时的触发概率（0~1） |
| `prefix` | `"-¥"` | 金额前缀 |
| `decimals` | `2` | 小数位；2 位会把"小于半分钱"显示成 0.00 时自动补到 3 位 |
| `color` | `"#ff3b30"` | 数字颜色 |
| `strokeColor` | `"#ffffff"` | 描边颜色（保证在任何背景上都看得清） |
| `strokeWidth` | `3` | 描边宽度（px），设 0 关闭描边 |
| `fontSizePx` | `30` | 字号（px） |
| `risePx` | `96` | 上浮距离（px） |
| `riseMs` | `1200` | 单次动画时长（ms） |
| `headOffsetX` | `0.5` | 落点横向位置（相对鲸鱼精灵图宽度的比例，0.5 = 居中） |
| `headOffsetY` | `0.12` | 落点纵向位置（相对鲸鱼精灵图高度的比例，0.12 ≈ 头顶） |
| `jitterX` | `0.18` | 横向随机抖动幅度（相对鲸鱼宽度），避免多次飘字完全重叠 |
| `maxStack` | `6` | 同屏最多几个飘字（超了丢最旧的） |

读配置：`GET /dsh-dmg/config.json`；改配置：`PUT /dsh-dmg/config.json`（**仅限本机回环**）。
改完最迟 30 秒生效（前端每 30 秒重取一次），刷新页面立即生效。

## 自查

```powershell
# 插件状态:版本、配置落点、数据源、信任栅栏是否可用
curl http://127.0.0.1:3080/dsh-dmg/status.json
# 当前配置
curl http://127.0.0.1:3080/dsh-dmg/config.json
# 浏览器半区脚本
curl http://127.0.0.1:3080/dsh-dmg/overlay.js
```

> 这些路由都接了 DSH 的浏览器信任栅栏，所以**不带会话凭据的裸 curl 会返回 401**，
> 伪造 Host 是 403 —— 返回 401/403 就说明路由已注册、栅栏在工作，不是接口坏了。

浏览器控制台里可以直接调：

```js
__dshDmgNumber.test(0.05)      // 立刻手动飘一个 ¥0.05
__dshDmgNumber.roll(0.05)      // 只看判定结果 { hit, p, roll, reason }
__dshDmgNumber.getConfig()     // 当前生效配置
__dshDmgNumber.setConfig({ maxAmount: 0.05 })
```

## 测试

```powershell
node tools/selftest.mjs
```

用 `node:vm` + DOM 打桩**真实执行** `assets/overlay.js`（不是复制一份逻辑另测），
覆盖区间概率边界、阈值退化、seq 驱动去重、seq 回退、数据源不可达、
配置热更新与畸形载荷、落点计算、关键帧、清理、堆叠上限、鲸鱼缺席降级等 61 项断言。

## 设计取舍

- **不碰小鲸鱼的 `node_modules`**：本插件独立安装，升级挂件不会被覆盖。
- **不解析会话日志**：金额直接取挂件算好的 `/dsh-whale/last-turn.json`，包括它的峰谷定价与缓存命中折算。
- **落点量的是精灵图**（`.dshwv-root .dshwv-img`），不是挂件根节点 —— 根节点是方块，
  精灵图只占右下 59.45%，量错了数字会飘在鲸鱼左上方的空气里。拖动鲸鱼后落点自动跟随。
- **关键帧只用 px**：外层负责定位、内层负责动画，避免 `%` 与 `calc()` 混插时插值不可靠。
- **配置读失败不重置**：一次 404/断连不会把你调好的区间静默冲回默认值。
- **轮次基准持久化**：刷新页面不会漏掉刚结束的那一轮，小鲸鱼挂件自己也是这个策略。

## 许可证

MIT。
