# 大脑通道（DSH agent preset）实现说明

> 对应《待补清单》第 3 项。你的三条决定：
> ① 走 **DSH agent preset**；② 模型 **V4.1 flash**，三档 **off / low / high** 对应回复深度；③ **上下文窗口固定条数**（默认 20，配置端可调）。

---

## 一、落地映射

| 你的决定 | 实现位置 | 具体形式 |
|---|---|---|
| 走 DSH agent preset | `dsh-preset/qq-brain-{off,low,high}.preset.yml` | 三个 preset 变体，共用同一段人设前缀 |
| V4.1 flash + 三档 | `app/src/brain.js` 的 `DEPTH_POLICY_DEFAULT` | `{model: deepseek-flash, reasoningEffort: off\|low\|high}` |
| 上下文窗口固定条数 | `depthPolicy(depth, cfg)` | `contextWindow` 默认 20，可由配置端覆盖 |

三档策略（实跑输出）：

    low   调大脑=false  模型=deepseek-flash  推理=off   搜索=0  字数≤20   窗口=20
    mid   调大脑=true   模型=deepseek-flash  推理=low   搜索=1  字数≤60   窗口=20
    high  调大脑=true   模型=deepseek-flash  推理=high  搜索=1  字数≤200  窗口=20

> 说明：`low` 档默认**不调大脑**（本地短句），这与架构一致；若你要低档也走一次 off 档模型，把 `callBrain` 改 true 即可。

---

## 二、实现文件

| 文件 | 作用 |
|---|---|
| `app/src/brain.js` | 通道主体：启动器解析、spawn、事件解析、usage 累加、命中率、三档策略、人设/任务文本构造 |
| `demo/run-brain-mock.mjs` | 用假 CLI 端到端验证（**已跑通**） |
| `demo/mock-dsh-cli.mjs` | 假 CLI：按档位吐出不同的 usage 事件 |
| `dsh-preset/*.preset.yml` + `README.md` | 三档 preset 与安装说明 |

关键接口：

    resolveDshLaunch(cliPath) -> { exe, cliJs, installRoot, source }
    depthPolicy(depth, cfg)   -> { callBrain, model, reasoningEffort, search, maxChars, contextWindow }
    buildPersonaText(persona, cfg) -> string        // 全局人设（放 personaPrefix）
    buildTaskText(depth, policy, keywords) -> string // 本轮任务（作为消息体，不进 system）
    parseEvents(stdout)       -> { text, usage, sessionId, steps }
    cacheHitRate(usage)       -> number
    runBrain({ cliPath, profile, promptText, timeoutMs, outputMode }) -> Promise<result>

---

## 三、启动器怎么找到（移植自取回的原实现）

`dsh.cmd` 本机实际内容：

    @echo off
    setlocal DisableDelayedExpansion
    set "ELECTRON_RUN_AS_NODE=1"
    "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*

`brain.js` 的 `parseCmdLauncher` 就是读这两行拿到 `exe` 与 `cli.js`（这正是取回文件 `dshlaunch.js` 的做法），拼出的调用形状：

    <exe> --expose-internals <cli.js> --profile qq-brain headless "<人设 + 任务文本>"

并带 `killTree()`（taskkill /T /F）保证超时不留孤儿进程。

---

## 四、输出方式：文件而非管道（重要）

本会话沙箱下，Node 用**管道 stdio** 捕获子进程输出会 EPERM；并且管道在大数据量下容易死锁。
因此 `runBrain` 默认 `outputMode: "file"` —— 把子进程 stdout/stderr 直接重定向到临时文件，结束后读文件再删。生产环境同样更稳。

---

## 五、实测（mock 通道，非真实模型）

    [mid]  ok=true steps=1  in=127  out=45   cacheRead=1000               命中率 82.2%
    [high] ok=true steps=1  in=350  out=232  cacheRead=1100 cacheWrite=520 命中率 55.8%

验证到的东西：事件流解析、`step_end` 上的 usage 累加、命中率计算、三档策略、人设文本生成。
**未验证**：真实模型下的 token 数与真实命中率（等 profile 建好）。

---

## 六、命中率怎么算（与 DSH 内核字段对齐）

DSH 侧字段（`dsh-llm-deepseek/lib/index.js` 第 1813–1814、1993 行）：

    cache_read_input_tokens  -> cacheReadTokens
    cache_creation_input_tokens -> cacheWriteTokens
    totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

本项目口径：

    命中率 = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)

（分母用"可缓存输入"三项之和，把写入缓存的 token 也算进去，避免高估。）

---

## 七、缓存友好的三条约束（写进装配器）

1. **人设只进 personaPrefix**（DSH 的 order 0 槽位，排在工具说明之前）→ 工具变动也不影响它命中
2. **群档案 / 上下文 / 本轮任务走消息体**，不拼进系统提示词
3. **preset 的工具面固定**（`qq-brain` 三档都不开工具），避免中段变动打散缓存

---

## 八、阻塞项：专用 profile 需要你来建

实测三条：

- `dsh --version` → `0.2.0-rc.2`（CLI 可用）
- `dsh --profile desktop headless ...` → **profile "desktop" is managed exclusively by the Electron application**（桌面主 profile 不能从 CLI 起）
- `dsh headless ...`（新建默认 profile）→ 写 `C:/Users/13518/.dsh/profiles/headless/cordis.yml` 时 **EPERM**（`~/.dsh` 在本会话沙箱之外）

所以要请你跑一次（约 1 分钟）：

    dsh qq-brain --from-default-profile headless
    dsh --profile qq-brain --dump-config

跑通后我把 `profile: "qq-brain"` 写进配置，就可以做**一次真实调用**，把"人设常驻到底省多少"用真实 `cacheReadTokens` 量出来。

---

## 九、下一步

1. 你建好 `qq-brain` profile（或告诉我用哪个现成 profile）
2. 我把 `brain.js` 接到判定中枢：`gates.decide()` 返回 `action="brain"` 时调用 `runBrain`，并落盘四个 usage 字段
3. 跑 30~60 条真实消息的"只判定不回复"观察模式，标定阈值 + 拿到真实成本与命中率
