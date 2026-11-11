# workbuddy-gateway

**把本机已登录的 WorkBuddy / CodeBuddy 账号变成 OpenAI 兼容接口 —— 单文件,零依赖。**

[English](README.md) · [接入 DeepSeek Harness](docs/dsh.md) · [其他客户端](docs/clients.md) · [疑难排查](docs/troubleshooting.md)

```
任意 OpenAI 兼容客户端(DeepSeek Harness、VS Code、Cherry Studio、LobeChat …)
        │  POST http://127.0.0.1:8790/v1/chat/completions
        ▼
  gateway.js  ── 读桌面端登录态、自动续期、归一化流式响应
        │  POST https://copilot.tencent.com/v2/chat/completions   (本身就是 OpenAI chat 协议)
        ▼
  WorkBuddy 后端(混元 / GLM / Kimi / MiniMax / DeepSeek)
```

---

## 目录

- [开始之前](#开始之前)
- [五步装好](#五步装好)
- [验证能用](#验证能用)
- [接客户端](#接客户端)
- [VS Code 扩展](#vs-code-扩展)
- [在 WSL 里用](#在-wsl-里用)
- [接口](#接口)
- [这个网关解决什么](#这个网关解决什么)
- [模型清单与真实花费](#模型清单与真实花费)
- [配置](#配置)
- [后台运行与开机自启](#后台运行与开机自启)
- [疑难排查](#疑难排查)
- [目录结构](#目录结构)
- [安全、合规与许可](#安全合规与许可)

---

## 开始之前

只需要两样东西。

### 1. 桌面端已登录

这个网关**没有自己的登录**。它读的是 **WorkBuddy / CodeBuddy 桌面客户端**已经存好的会话,并用与客户端相同的方式续期。

> **先把桌面客户端装好、登录,确认它能正常发消息。** 桌面端没登录,后面一步都走不通 —— 没有 token 可借。

会话文件的位置随平台不同,不用自己找,安装脚本会定位。供参考:

| 系统 | 位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info` |
| Linux / WSL | `~/.local/share/CodeBuddyExtension/...`,或 `/mnt/c` 下的 Windows 路径 |

### 2. Node.js ≥ 18

```bash
node --version      # 需要 v18.x 或更高
```

版本不够的话:

- **Windows** —— `winget install OpenJS.NodeJS.LTS`,然后重开一个终端
- **macOS** —— `brew install node`
- **Linux/WSL** —— `sudo apt install nodejs npm`(注意版本,发行版自带的有时候低于 18),或用 [nvm](https://github.com/nvm-sh/nvm)

除此之外不用装任何东西。不需要 Docker、Go、`pip`、`npm install` —— 网关只用 Node 标准库。

### 3. 不要把这个端口暴露出去

网关默认只监听 `127.0.0.1`。**保持这样。** 能连上这个端口的人,就能花掉你账号的额度。详见[安全](#安全合规与许可)。

---

## 五步装好

### 第一步 —— 克隆

```bash
git clone https://github.com/zj12581/WorkBuddyToOpenAI.git
cd WorkBuddyToDeepSeekHarness
```

### 第二步 —— 跑安装脚本

这一条命令会找登录态、写配置、启动网关,然后一直等到健康检查通过。脚本是**幂等**的 —— 重复跑是修复,不会装出第二份。

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

**macOS / Linux / WSL**

```bash
bash scripts/setup.sh
```

<details>
<summary>脚本具体做了什么</summary>

| # | 动作 | 什么情况会失败 |
|---|---|---|
| 1 | 检查 Node ≥ 18,定位 `gateway.js` | Node 没装或太旧 |
| 2 | 在平台的登录目录里找 `*.info`,优先名字带 `workbuddy` 的 | 桌面端从没登录过 |
| 3 | 打印账号昵称、域、token 到期时间(不打印 token) | — |
| 4 | 确认能连上 `copilot.tencent.com` | 只警告,继续装 |
| 5 | 写 `~/.workbuddy-gateway/config.json` | 文件已存在时跳过 |
| 6 | 停掉之前启动的实例 | — |
| 7 | 后台启动,轮询 `GET /health` 最多 20 秒 | 网关崩了 —— 会打印日志尾部 |
| 8 | 若同时有 `.vsix` 和 `code` 命令,装 VS Code 扩展 | 否则静默跳过 |

常用参数:

| 用途 | Windows | macOS / Linux |
|---|---|---|
| 跳过 VS Code 那步 | `-SkipExtension` | `--skip-extension` |
| 换端口 | `-Port 8899` | `WORKBUDDY_GATEWAY_PORT=8899` |
| 指定登录文件 | `-AuthFile PATH` 或 `$env:WORKBUDDY_AUTH_FILE` | `WORKBUDDY_AUTH_FILE=PATH` |
</details>

装成功的输出长这样:

```
WorkBuddy gateway - setup

==> Checking Node.js
    v node v24.18.0
    v gateway: /path/to/WorkBuddyToDeepSeekHarness/gateway.js
==> Locating the WorkBuddy / CodeBuddy desktop login
    v login: C:\Users\you\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
    account: (昵称)  domain: www.workbuddy.cn  token valid to: 2026-10-20 15:09
==> Checking the upstream is reachable
    v upstream responded (HTTP 200)
==> Writing configuration
    v wrote C:\Users\you\.workbuddy-gateway\config.json
==> Stopping any previous instance
==> Starting the gateway on 127.0.0.1:8790
    v pid 18872
==> Waiting for the health check
    v healthy - 32 models (12 free)
```

### 第三步 —— 验证

```bash
curl -s http://127.0.0.1:8790/health -H "Authorization: Bearer workbuddy-local"
```

要看到 `"status":"ok"` 和 `models` 数组。Windows PowerShell 下:

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health -Headers @{Authorization='Bearer workbuddy-local'}
```

### 第四步 —— 真发一条消息

这一步才证明整条链路通了 —— 登录态、续期、上游、流式:

```bash
curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer workbuddy-local" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"回复两个字:好的"}]}'
```

`deepseek-v4-flash` 适合做冒烟测试:免费、不把输出预算花在推理上、回得快。**别拿 `hy4-preview-f` 做第一次测试** —— 它虽然免费,但也是被上游限流最多的那个(返回 `HTTP 429`,code `6004`),会让装好的环境看着像坏的。

想跑更全的检查(模型列表、非流式、流式、原生工具调用):

```bash
node tests/smoke-test.js
```

### 第五步 —— 停止与重启

```bash
bash scripts/stop.sh          # 或:powershell -File scripts\stop.ps1
bash scripts/setup.sh         # 再启动(复用已有配置)
```

装完了。接下来接客户端。

---

## 验证能用

三层测试,从便宜的开始。

```bash
# 1. 离线单测 —— 不需要账号、不需要网络
node --test tests/unit/core.test.js

# 2. 对运行中的网关做真实端到端自检
node tests/smoke-test.js

# 3. 你这个账号到底能跑哪些模型 id?
node probes/probe-models.js

# 4. 其中哪些有独立思考链?
node probes/probe-thinking.js
```

`probes/` 不是摆设:上游模型 id 会随时变,`probe-models.js` 就是你发现它变了的方式。某个模型开始回 `11102 service info not found` 时,跑它。

---

## 接客户端

任何讲 OpenAI chat 协议的客户端都能接。填三个值:

| 项 | 值 |
|---|---|
| 接口地址 | `http://127.0.0.1:8790/v1` |
| API Key | `workbuddy-local`(或你 `--api-key` 传的值;留空也行) |
| 模型 | `GET /v1/models` 里的任意 id |

- **DeepSeek Harness** —— 完整走法(含把额度倍率写进模型名的做法)见 [`docs/dsh.md`](docs/dsh.md)。另有一个 `/balance` 插件,显示账号剩余积分:见 [`integrations/dsh/`](integrations/dsh/README.md)。
- **Cherry Studio、LobeChat、ChatBox、NextChat、OpenAI SDK** —— 见 [`docs/clients.md`](docs/clients.md)。
- **VS Code** —— 见下一节。

选模型前有两点要知道:

1. **先用 `deepseek-v4-flash`。** 实测 `credit: 0`,而且不把输出预算花在推理上。
2. **在你自己的账号上量"免费"这件事。** 免费与否跟倍率无关,而且会变。见[什么在真正决定花费](#什么在真正决定花费),并以网关日志(`--debug`)里的 `credit=` 为准,别信任何表格,包括下面那张。

---

## VS Code 扩展

[`vscode-extension/`](vscode-extension/) 里的扩展有两条互不依赖的接入方式。细节见[它自己的 README](vscode-extension/README.md)。

### 构建与安装

```bash
cd vscode-extension
npx @vscode/vsce package --no-dependencies
code --install-extension workbuddy-agent-0.1.0.vsix
```

然后**完全重启 VS Code**(不只是重载窗口 —— 语言模型 provider 是在激活阶段注册的)。

### 方式一 —— 出现在 Chat 视图的模型选择器里(推荐)

扩展注册了一个 `LanguageModelChatProvider`,于是 WorkBuddy 的模型会出现在 VS Code **Chat 视图的模型下拉框**里。之后由 GitHub Copilot Chat(或其他任何 chat participant)用**它自己的** agent 循环、工具、审批和 diff 界面来驱动对话。

这是更好的接入方式:agent 的质量由宿主决定,而不是我们重新造一遍。

打开 Chat 视图 → 点模型下拉框 → 选一个 **WorkBuddy** 模型(`★` 是免费的)。

### 方式二 —— 独立的 agent 面板

没装 Copilot Chat 的话,扩展自带一个 agent,在**右侧辅助侧边栏**(编辑器右边那一列),同时提供 `@workbuddy` 聊天参与者。

命令面板 → **WorkBuddy Agent: Open Agent Panel (right side)**。

功能:流式回答、可折叠的工具步骤、内联权限确认(Allow once / Allow for session / Deny)、实时状态条、会话持久化、模型与推理深度选择器。

### 装进 WSL

如果 VS Code 连的是 WSL,只在 Windows 侧装不够 —— WSL 的扩展宿主有自己的目录:

```bash
bash wsl/install-extension.sh          # 在 WSL 里执行
```

---

## 在 WSL 里用

**用 VS Code 连 WSL、或者要在 WSL 里跑东西的话,这节要看。**

### 为什么 WSL 需要自己的网关

WSL 在 NAT 模式下有**自己的** `127.0.0.1`,那不是 Windows 的 loopback。所以绑在 Windows `127.0.0.1` 上的网关,WSL 里根本连不到。

两个常规解法在很多机器上都不成立:

| 解法 | 前提 |
|---|---|
| WSL 镜像网络(`networkingMode=mirrored`) | Windows 11 22H2+ —— **Windows 10 没有** |
| `netsh interface portproxy` | 需要管理员权限,而且 WSL 的 IP 每次重启会变 |

推荐在 **WSL 内运行一个网关**,通过 `/mnt/c` 读取 Windows 登录态。WSL 应用访问自己的 loopback；启用 WSL localhost 转发时，Windows 应用也可以通过 Windows 的 `127.0.0.1` 访问它。

```bash
bash wsl/start-gateway.sh     # 在 WSL 内监听 127.0.0.1:8790
bash wsl/stop-gateway.sh      # 停掉

bash wsl/install-extension.sh # 把扩展装进 WSL 的扩展宿主
```

只需一个实例：

```
127.0.0.1:8790   WSL 网关 ← WSL 应用；Windows 应用通过 localhost 转发访问
```

扩展默认探测 `8790`。先停止 Windows 上相同端口的旧网关，否则 Windows 客户端可能连接到旧实例。Windows 侧请验证 `http://127.0.0.1:8790/health`；localhost 转发不可用时需要检查 WSL 配置。自定义端口可设置 `WORKBUDDY_WSL_PORT`，停止时使用相同变量或 `--port`。

### 一个网关，多个客户端

网关就是一个 HTTP 接口，所以本机所有客户端都指向同一个 `127.0.0.1:8790`，共用一份登录会话和一份额度。这是设计意图 —— 同时跑几个网关只会把会话文件拆开，而且分不清到底是谁在扣积分。

```
                     ┌─────────────────────────────┐
  DeepSeek Harness ──┤                             │
  VS Code(Win/WSL)──┤  127.0.0.1:8790             ├── copilot.tencent.com
  机器人 / 脚本   ───┤  一个 gateway.js 进程        │
                     └─────────────────────────────┘
```

实际意味着:

- **端口上只能有一个进程。** 有两个时，先绑上那个接管流量，另一个静默收不到请求。`wsl/stop-gateway.sh` 会停掉 WSL 内全部实例，`start-gateway.sh` 拒绝在同一端口再加一个。
- **客户端唯一要对齐的就是端口。** `GET /v1/models` 会给出可用模型和上下文长度，不需要为每个客户端单独配别的。
- **客户端里的模型清单会漂移，网关不会。** 网关自己跟踪上游目录，而 DSH 这类客户端把清单写在各自配置里。`integrations/dsh/sync-models.js` 负责把网关的清单同步过去。
- **Windows↔WSL 由 WSL 自己处理。** 开启 localhost 转发(默认开启)后，绑在 WSL 内 loopback 的网关在 Windows 上就是 `127.0.0.1:8790`，由 `wslrelay.exe` 转发。这条不通时，先 `wsl --shutdown` 再重启网关，不要急着再起一个实例。

### WSL 里的前提

- **WSL 内**要有 node ≥ 18(跟 Windows 那份是两回事):`node --version`
- 能通过 `/mnt/c` 读到 Windows 的登录文件 —— `start-gateway.sh` 会自动找
- WSL 能访问 `copilot.tencent.com`(不通的话脚本会警告)

### 几点说明

- `start-gateway.sh` 用 `setsid` 脱离会话。光用 `nohup ... &` **不够** —— 通过 `wsl.exe -e bash -lc` 调用时,进程留在调用者的会话里,那个会话一结束就被回收了。
- `wsl --shutdown` 之后 WSL 实例不会自动起来,要重新跑 `start-gateway.sh`。想自动化就在 `~/.bashrc` 里加一行,或用 systemd user unit(WSL 需启用 systemd)。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/models` | 已配置的模型清单,每项带 `tier: "free"` 或 `"paid"` |
| `POST` | `/v1/chat/completions` | 流式 / 非流式,原生 `tools` / `tool_calls` |
| `GET` | `/health` | 会话状态(默认隐藏身份字段) |

不带 `/v1` 前缀的 `/models`、`/chat/completions` 也接受,给会省略前缀的客户端用。

---

## 这个网关解决什么

同类项目已有好几个(清单见 [NOTICE](NOTICE))。这个项目的差异点只有三条:

| | |
|---|---|
| **零依赖、零构建** | `node gateway.js` 就能跑。不装 Docker、不装 Go、不 `pip install`。只要有 Node ≥ 18(用内置 `fetch`)。 |
| **被真实 agent 打磨过,不是 curl 级验证** | agent 客户端会注入合规声明式系统提示词("拒绝 DoS / exploit / credential testing / C2 frameworks …"),上游内容审核把这些词当敏感输入,整条请求被拒。本项目会脱敏该提示词并重试,见下。 |
| **可复现的模型能力矩阵** | `probes/` 实测账号真正可用哪些模型 id、哪些有独立思考链。是可重跑的事实,不是抄来的文档。 |

### 它实际解决的问题

agent 客户端会把它自己的合规声明当系统提示词发出去,大意是:

> 必须拒绝 **DoS** 攻击、**exploit** 开发、**credential testing**、**C2 frameworks**、**malware** 制作 …… **privilege escalation**、**reverse shells**、**SQL injection** …

上游对这些字面词做了拦截,于是回:

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

**"我拒绝做这些事"这句话本身,被当成了"我要做这些事"。** 网关的处理:

1. **脱敏** `system` / `developer` 消息:在每个命中词内部插入零宽空格(`DoS` → `D<U+200B>oS`)。人眼和模型读起来无差别,但字面关键词匹配失效。这一步**不改用户输入**。
2. **被拦后重试一次**,升级为连 `user` / `tool` 消息一起脱敏。
3. **`developer` → `system` 归一**:上游只认 `system`/`user`/`assistant`/`tool`,而新的 OpenAI 客户端会发 `developer`。

复现故障与修复:

```bash
node gateway.js --no-desensitize --no-retry   # 终端 1:故障形态
node probes/probe-block.js                    # 终端 2:看系统提示词被拒

node gateway.js                               # 终端 1:修复形态
node probes/probe-block.js                    # 终端 2:五个场景全过
```

其他被这个网关补上的协议缺口:

| 客户端发 | 上游要 | 为什么重要 |
|---|---|---|
| `max_completion_tokens` | `max_tokens` | 新的 OpenAI 客户端发这个别名;上游忽略它,然后悄悄退回到自己那个很小的默认上限,把回答截断。 |
| `tool_choice: {type:"function", function:{name}}` | `"name"`(字符串) | 对象形式会被拒,返回 `11101`。 |
| `reasoning_effort: "off"` | *(整个字段不发送)* | DeepSeek V4 系拒收字面字符串 `"off"`,返回 `400 / 11150 invalid_reasoning_effort`。"关闭"的语义是"不要求推理",所以这个字段直接丢掉。 |

---

## 模型清单与真实花费

2026-09 用一个国内版账号实测。**这是数据不是文档** —— 用 `node probes/probe-models.js` 和 `node probes/probe-thinking.js` 可以随时重跑刷新。上游模型 id 会随时变动。

**倍率**(Mult.)来自上游 `/v3/config` 的 `credits` 字段:是标价,不一定是你实付。有些倍率非零的模型实测 `credit=0`,而 `hy4-preview-f` 在任何提示词长度下都免费。

> **看价格之前先看这段。** 同一个账号隔几天的两次测量就对不上:第一次有十二个模型 `credit: 0`,包含 `kimi-k2.7` / `kimi-k2.6` / `kimi-k2.5` / `minimax-m2.7`;第二次每个跑三轮,这四个稳定计费 `0.01`–`0.02`,而 `deepseek-v4.1-flash` 变成了免费。免费与否**不是模型 id 的固定属性**。
>
> 把下表当起点,并**在自己的账号上验证** —— 用 `--debug` 跑网关,逐条读 `credit=`。下面的数字只是一个账号在 2026-09 看到的情况。

| 模型 id | 倍率 | 上下文 | 输出 | 免费 | 思考链 | 视觉 |
|---|---|---|---|---|---|---|
| `auto`(→ `hy4-preview-f`) | — | 256K | 32K | ✅ | ✅ | ✅ |
| `hy4-preview-f` | **x0.00** | 1M | 64K | ✅ | ✅ | ✅ |
| `hy3` | **x0.00** | 192K | 64K | ✅ | ✅ | ✅ |
| `glm-5.3-flash` | x0.06 | 1M | 32K | ✅ | ✅ | ✅ |
| `glm-5.1` | x0.79 | 200K | 48K | ✅ | ✅ | ✅ |
| `glm-5.0-turbo` | x0.95 | 200K | 48K | ✅ | ✅ | ✅ |
| `deepseek-v4-flash` | x0.17 | 1M | 50K | ✅ | ✅ | ✅ |
| `deepseek-v3.2` | x0.29 | 96K | 32K | ✅ | ✅ | ✅ |
| `deepseek-v4.1-flash` | **x0.03** | 1M | 128K | ✅(会变) | ✅ | ✅ |
| `kimi-k2.7` | x0.57 | 256K | 32K | —(实测 0.02) | ✅ | ✅ |
| `kimi-k2.6` | x0.52 | 256K | 32K | —(实测 0.01) | ✅ | ✅ |
| `kimi-k2.5` | x0.45 | 256K | 32K | —(实测 0.01) | ✅ | ✅ |
| `minimax-m2.7` | x0.26 | 200K | 48K | —(实测 0.01) | ✅ | ✅ |
| `hy3-x` | x0.05 | 192K | 64K | — | ✅ | ✅ |
| `fast-model` | x0.21 | 300K | 48K | — | ✅ | ✅ |
| `minimax-m3` | x0.25 | 512K | 64K | — | ✅ | ✅ |
| `hy4-preview` | x0.29 | 1M | 64K | — | ✅ | ✅ |
| `deepseek-v3-2-volc` | x0.29 | 96K | 32K | — | ✅ | ✅ |
| `deepseek-v4-pro` | x0.51 | 1M | 128K | — | ✅ | ✅ |
| `deepseek-v3-1-lkeap` | x0.52 | 96K | 32K | — | — | ✅ |
| `deepseek-v3-0324-lkeap` | x0.52 | 112K | 16K | — | — | ✅ |
| `balanced-model` | x0.65 | 300K | 48K | — | ✅ | ✅ |
| `glm-5v-turbo` | x0.71 | 200K | 64K | — | ✅ | ✅ |
| `kimi-k2.8-preview` | x0.77 | 1M | 64K | — | ✅ | ✅ |
| `glm-5.3` | x0.79 | 1M | 64K | — | ✅ | ✅ |
| `glm-5.2` | x0.79 | 1M | 64K | — | ✅ | ✅ |
| `deep-model` | x1.20 | 300K | 48K | — | ✅ | ✅ |
| `kimi-k3` | x1.62 | 256K | 32K | — | ✅ | ✅ |
| `kimi-k3-1` | x1.62 | 1M | 32K | — | ✅ | ✅ |
| `deepseek-r1-0528-lkeap` | — | 96K | 16K | — | — | — |
| `deepseek-v3-0324` | — | 96K | 8K | — | — | — |
| `hunyuan-2.0-instruct` | — | 128K | 16K | — | ✅ | ✅ |

**免费**那列是网关 `/v1/models` 报的 `tier: "free"`,那是代码里的内置清单,所以同样有上面那个警告。

> 验证过程中 **`glm-5.3-flash` 返回了空正文**,但 `credit: 0`、HTTP 200。有思考链的模型回空,先怀疑 token 预算,别怀疑网关 —— 调大 `max_tokens`。

上游目录里列了但**实际不存在**的 id(上游回 `11102 service info not found`):`minimax-m2.5`、`glm-4.6v`、`glm-4.6`、`kimi-k2-thinking`、`kimi-k2-instruct-taiji`、`deepseek-v3-1-volc`、`deepseek-v3-1`、`deepseek-r1-0528`、`deepseek-v3-0324-taco-completion`、`completion-gf`、`default-1.1`、`default-1.2`、`hunyuan-3b`、`hunyuan-7b-dense`、`codewise-completions`。`hunyuan-image-alpha*` 回 `11103`(不是 chat 后端),`codewise-*` 是补全模型。这些都不在默认清单里。

### 一个后缀的差价

`hy4-preview` 和 `hy4-preview-f` 只差一个字符。官方客户端界面上**两个都叫 "Hy4 preview"**。客户端自己用的是 `hy4-preview-f`,实测免费;另一个在 2.3 万 token 的提示词上大约扣 0.17。

除了 API 里,这两个 id 在任何地方都看不出区别,所以要认 id 而不是认标签。

## 什么在真正决定花费

**前缀缓存命中。** 带上稳定的 `prompt_cache_key`,同一段前缀实测从 **0.68 降到 0.04**(`deepseek-v4-flash`);后续轮次里 22,735 个提示词 token 中有 22,656 个走了缓存。长 agent 会话里,这比倍率重要得多。网关用账号 uid 加会话锚点推导这个 key,所以同一会话内稳定、跨账号不碰撞。

**推理预算。** 有思考链的模型会**先**花输出预算做推理。`max_tokens` 给小了会得到空正文 + `finish_reason: "length"` —— 推理模型请给足预算。

> 产品文档在价格上是过时的:它标 `deepseek-v4-flash` 为 x0.06,上游目录说 x0.17,而实际最便宜的可用模型是 `deepseek-v4.1-flash`,x0.03。信 `/v3/config` 和 `usage.credit`,别信文档。

---

## 配置

优先级:**命令行 / 环境变量 → 配置文件 → 内置默认值。**

```bash
node gateway.js \
  --port 8790 --host 127.0.0.1 \
  --api-key workbuddy-local \
  --config ~/.workbuddy-gateway/config.json \
  --log ./logs/gateway.log \
  --debug
```

从 [`config.example.json`](config.example.json) 开始改。安装脚本已经替你写了一份在 `~/.workbuddy-gateway/config.json`。

| 参数 | 作用 |
|---|---|
| `--port` / `--host` | 监听地址(默认 `127.0.0.1:8790`) |
| `--api-key` | 要求这个 Bearer token;留空则接受任何本机客户端 |
| `--auth-file` | 固定登录文件,不自动探测 |
| `--config` | 从 JSON 文件读配置 |
| `--log` | 除了 stdout,再把结构化日志追加到文件 |
| `--debug` | 每次尝试的细节,含 `credit=` 和 `cache_hit=` |
| `--model-list a,b,c` | 替换对外暴露的模型清单 |
| `--detach` | 重新以脱离方式启动并打印 PID |
| `--no-desensitize` | 关闭系统提示词脱敏(用来演示故障) |
| `--no-retry` | 关闭被拦重试 |
| `--expose-identity` | 在 `GET /health` 里回显 `nickname` / `uid`(默认关闭) |

环境变量等价物:`WORKBUDDY_GATEWAY_PORT`、`WORKBUDDY_GATEWAY_API_KEY`、`WORKBUDDY_GATEWAY_HOST`、`WORKBUDDY_GATEWAY_CONFIG`、`WORKBUDDY_GATEWAY_LOG`、`WORKBUDDY_GATEWAY_DEBUG`、`WORKBUDDY_MODELS`、`WORKBUDDY_UPSTREAM`、`WORKBUDDY_AUTH_FILE`。

> PowerShell 5.1 的 `Set-Content -Encoding UTF8` 或记事本存出来的配置文件,开头会带 UTF-8 BOM。网关会剥掉它;但其他读同一个文件的工具不一定。

---

## 后台运行与开机自启

安装脚本本来就是以脱离方式启动的,日常用不需要额外做什么。

想手动脱离启动:

```bash
node gateway.js --port 8790 --api-key workbuddy-local --log ./logs/gateway.log --detach
# [workbuddy-gateway] detached, pid 29396 (pid file: ./logs/gateway.pid)
```

停止:Windows 用 `taskkill /PID <pid> /T /F`,其他平台 `kill <pid>`。

想**开机自启**,用平台自己的机制,别套一层脚本:

- **Linux** —— `~/.config/systemd/user/workbuddy-gateway.service`,内容是
  `ExecStart=/usr/bin/node /path/to/gateway.js --log %h/.workbuddy-gateway/gateway.log`,然后
  `systemctl --user enable --now workbuddy-gateway`
- **macOS** —— `~/Library/LaunchAgents/` 下放一个 `launchd` agent,跑同样的命令
- **Windows** —— 任务计划程序:触发器"登录时",操作
  `node C:\path\to\gateway.js --log C:\path\to\logs\gateway.log`
- **WSL** —— 在 `~/.bashrc` 里加一行调 `wsl/start-gateway.sh`,或配 systemd user unit(需 WSL 启用 systemd)

---

## 疑难排查

完整清单(带确切错误字符串)在 [`docs/troubleshooting.md`](docs/troubleshooting.md)。最常见的几个:

| 现象 | 原因 | 处理 |
|---|---|---|
| `no WorkBuddy/CodeBuddy auth file found` | 桌面端没登录,或会话在别处 | 登录,或设 `WORKBUDDY_AUTH_FILE` / `authFile` |
| `11128 Illegal API invocation from an unapproved channel` | 内容审核命中了 agent 自己的拒绝声明 | 应已自动处理;没处理就检查 `desensitize` 是否被关掉 |
| `11102 service info not found` | 这个模型 id 上游已经没有了 | `node probes/probe-models.js`,更新模型清单 |
| 空正文,`finish_reason: "length"` | `max_tokens` 对推理模型来说太小 | 调大预算,或换非推理模型 |
| `401 invalid api key` | 客户端 key ≠ 网关 `--api-key` | 让两边一致 |
| `upstream unreachable: fetch failed` | 没网,或系统代理拦了 `fetch` | 检查网关运行环境里的代理设置 |
| VS Code:模型选择器里没有 WorkBuddy 分组 | provider 是在激活阶段注册的 | 完全重启 VS Code;看 **Developer: Show Logs… → Extension Host** |
| WSL:`no gateway answered` | 绑在 Windows loopback 的网关,WSL 连不到 | 在 WSL 里跑 `bash wsl/start-gateway.sh` |
| curl 能通,agent 客户端不通 | 工具调用被回成了散文 | 该模型可能不支持工具;查它的 `supportsToolCall` |

如果是本来好好的突然不行,通常就是上游变了 —— 修复点一般在 `lib/core.js`(请求形态)或模型清单(`probes/`)。

---

## 目录结构

```
gateway.js                 服务主体(配置、路由、重试阶梯)
lib/core.js                纯逻辑:脱敏、请求构造、SSE 解析
lib/credentials.js         登录态定位、token 续期、上游请求头
scripts/setup.{ps1,sh}     一键安装
scripts/stop.{ps1,sh}      停止网关
wsl/start-gateway.sh       WSL loopback 网关（默认端口 8790）
wsl/stop-gateway.sh        停掉它
wsl/install-extension.sh   把扩展装进 WSL 的扩展宿主
vscode-extension/          VS Code 接入(模型 provider + 独立面板)
probes/probe-models.js     账号真正可用哪些模型 id
probes/probe-thinking.js   哪些模型有独立思考链
probes/probe-reasoning.js  上游对 reasoning_effort 的反应
probes/probe-limits.js     接受哪些 max_tokens(弱信号,见文件头说明)
probes/probe-block.js      复现安全策略拦截并验证修复
tests/unit/                lib/core.js 的离线单测
tests/smoke-test.js        对运行中的网关做真实端到端自检
docs/                      DeepSeek Harness 接入、其他客户端、疑难排查
```

---

## 安全、合规与许可

### 安全

- 默认只监听 `127.0.0.1`。**不要暴露到网络** —— 能连上这个端口的人就能消耗你账号的额度、读到你的输出。
- 登录文件等同账号完全控制权,别进版本库(`.gitignore` 已覆盖 `*.info`、`auths/`、`logs/`)。
- 日志可能含完整提示词与回答,只落本地,本项目不会把它们发到任何地方。
- 除了你配置的上游地址,本项目不发起任何其他外部请求,没有遥测。

### 合规边界

这是**非官方**软件,与腾讯 / CodeBuddy / WorkBuddy 无关,未获其认可或支持。

- 请**仅使用你本人持有且已授权的账号**,在自有机器或私有环境使用。
- 用代理复用桌面端登录态,可能与上游平台服务条款冲突,存在被风控或封号的可能。**该风险由使用者承担。**
- 不要共享、转售、再分发这个接口,也不要公开托管;更不要用它绕开上游对**真实有害输入**的审核 —— 脱敏功能的存在意义是阻止"拒绝声明"被误判,不是把违规请求偷运进去。
- 软件按"现状"提供,不附带任何担保。作者不对封号、数据丢失或任何使用后果负责。

上游协议与模型 id 会随时变动。失效时,修复点通常在 `lib/core.js`(请求形态)或 `probes/`(模型清单)。

### 许可

MIT,见 [LICENSE](LICENSE)。第三方致谢见 [NOTICE](NOTICE)。
