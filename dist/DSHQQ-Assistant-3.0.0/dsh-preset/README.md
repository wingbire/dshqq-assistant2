# qq-brain preset 安装说明

## 为什么需要独立的 profile

实测（本机）：

- `dsh --profile desktop headless ...` → **报错：profile "desktop" is managed exclusively by the Electron application**（桌面主 profile 不能从 CLI 启动）
- `dsh headless ...`（不带 profile）→ 会尝试**新建** `C:/Users/13518/.dsh/profiles/headless/cordis.yml`，在本会话沙箱下报 **EPERM**（`~/.dsh` 在工作区之外）
- `dsh --version` → **0.2.0-rc.2**（CLI 本身可用）
- `E:/DeepseekHarness/resources/runtime/cli/bin/dsh.cmd` 内容就是把 Electron 当 Node 跑 `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`

**结论：大脑需要一个专用的、非 Electron 托管的 profile（建议叫 `qq-brain`），由你来创建。**

## 安装步骤（用户执行，一次）

    # 1. 从官方模板派生一个专用 profile（模板名以 dsh 实际提供为准）
    dsh qq-brain --from-default-profile headless

    # 2. 确认它能起来
    dsh --profile qq-brain --dump-config

    # 3. 把三个档位的 preset 叠加进去（重复 --patch 可叠加）
    dsh --profile qq-brain --patch 程序架构/dsh-preset/qq-brain-low.preset.yml headless "在吗"

三个档位的分工：

| preset | reasoningEffort | maxTokens | 用途 |
|---|---|---|---|
| qq-brain-off.preset.yml | off | 128 | 短评（≤20 字）——通常本地短句就够，不一定调 |
| qq-brain-low.preset.yml | low | 256 | 总结（≤60 字） |
| qq-brain-high.preset.yml | high | 1024 | 详细（≥200 字），配合搜索与外审 |

## 字段来源说明（诚实标注）

- `provider` / `model` / `reasoningEffort` / `maxTokens`：来自内核类型声明
  `dsh-agent-preset-registry` 的 `AgentOptions` 与 `LlmCallConfig`（**已核对**）
- `personaPrefix` / `personaSuffix` / `toolOrder`：来自 `dsh-system-prompt` 的 `Config`（**已核对**，第 203–207 行）
- `includeRuntimeContext` / `includeHarnessIdentity`：同上（**已核对**）
- `personaPrefixFile` / `invocation` / `tools.enabled`：**我提出的装配层字段**，需要你的装配器（brain.js）来读取；DSH 本身不认识这两个键，别指望 DSH 直接吃

## 缓存友好性的三条硬约束（务必守住）

1. **人设只放 personaPrefix**，不要放 suffix，也不要在人设里插每轮会变的东西
2. **工具面固定**：这个 preset 不开任何工具（`enabled: []`），否则工具说明中段变动会打散缓存
3. **动态内容不要进 system**：群档案、上下文、本轮任务作为**消息体**传入，而不是拼进系统提示词
