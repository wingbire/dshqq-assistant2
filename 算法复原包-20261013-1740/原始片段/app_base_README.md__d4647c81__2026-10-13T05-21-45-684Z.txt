# 来源会话: dsh-session-d4647c81-f620-4491-b1db-d257a6dea743
# 记录时间: 2026-10-13T05:21:45.684Z
# 原始路径名: app/base/README.md
# 提取方式: 文件块(67行,已去行号)
# ---------- 以下为逐字内容 ----------
# 前置模组（app/base）· 六层架构

> 本轮按你给的分层图重写。**L1/L2 是视频工坊程序自己的**（已有、零改动）；
> 前置模组负责 **L3 编排 · L4 注册表 · L5 执行 · L6 存储**，并把 L2 接上来。

## 分层对位

| 层 | 该有的东西 | 本模组的落点 | 对位的现有工具 | 状态 |
| --- | --- | --- | --- | --- |
| L1 前端 UI | PR 式编辑器 / 指令输入框 / 任务中心 / 项目·素材箱·时间线·监视器·效果控件·导出 | *不在 base 内* | `app/web/editor.html`(56 KB) · `page.html` · `capabilities.html` | 现有 |
| L2 应用核心 | Project / Timeline / Asset / Undo / Command Bus / Selection / Sequence / Track | *不在 base 内*，由 `接入/` 对接 | `app/lib/sequence.mjs` · `commands.mjs`(19 指令) · `server.mjs`(history/undo/redo) | 现有 |
| **L3 DSH 编排** | 自然语言解析 → 意图/槽位 → 澄清 → 规划 DAG → 能力选择 → 参数填充 → 调度 → 解释 | `编排/agent.mjs` | `app/lib/dsh.mjs`（`dsh headless` 桥） | **本轮新建** |
| **L4 能力注册表** | Manifest + JSON Schema + Tool API + 权限 | `注册表/registry.mjs` · `注册表/内置能力.mjs` · `通道/render-ops.mjs` | `E:\AI素材生成\ops.json`（对端登记表，唯一真源，现读） | **本轮重写** |
| **L5 执行渲染** | Scheduler / Queue / Worker / Runtime Adapter / 缓存 / 日志 / 取消 / 重试 | `执行/executor.mjs` | ffmpeg（NVENC/QSV/AMF）· 对端 python venv · 远程占位 | **本轮新建** |
| **L6 存储** | Project DB / Asset Store / Job Log / Cache / 向量索引 / 版本血缘 / 工程导出 | `存储/store.mjs` | `期数/`（工程，跟着 ROOT 走）· `数据/`（素材库索引 · 任务日志 · 缓存 · 血缘） | **本轮重写**（向量索引留接口） |

## 通道（横跨 L4→L5→L6）

```
自然语言输入 → L3 编排(agent) → L4 能力选择 → L5 调度执行
├─ 外部算子 → 单向契约写对端 inbox
└─ 本地能力 → 直接执行
→ 【通道出口】 → 结果.json → L6 素材库 + 血缘
→ 素材库可被自然语言调用（use_library）→ 回到 L2 时间线
```

- `通道/channel.mjs`：入口（受理/分配任务id/路由）+ 出口（收口/入库/血缘）
- `通道/render-ops.mjs`：外部渲染算子提供者（8 就绪 / 7 缺件）

## 能力三态（不许合并）

| 状态 | 含义 | 回答 |
| --- | --- | --- |
| 可用 | 有运行体、依赖齐、权限放行 | 执行 |
| **缺件** | 已登记但缺实现/目录/依赖（含业务模型槽位） | 「已登记但未就绪」+ 逐条列缺什么 |
| 已移除 | 刻意删掉对接 | 「已移除」+ 缺什么才能补回 |

## 权限（L4 的第四件）

每条 Manifest 声明 `权限：{文件, 网络, 跨工作区, 算力}`。分派前过权限闸：
**跨工作区写 / 网络 / 远程算力默认全部关闭，必须显式加「确认」放行**。

## 用法

```
node app/base/cli.mjs 分层            # 六层对位 + 能力统计
node app/base/cli.mjs 能力 [组]        # 注册表清单
node app/base/cli.mjs 工程 / 素材库 / 任务 / 血缘
node app/base/cli.mjs 问 "把第 3 段删掉"      # 只看计划（DAG + 澄清），不执行
node app/base/cli.mjs 干 "把第 3 段删掉"      # 端到端（解析 → 调度 → 执行 → 解释）
node app/base/cli.mjs 通道 ref.analyze 视频=x   # 渲染通道入口（默认干跑）
node app/base/cli.mjs 通道出口 <任务id> <文件> [能力=x] [标签=y]
node app/base/cli.mjs 桥自检 / 工具清单
```

## 已知缺口（如实记）

1. **L2 的剪辑运行体仍委派给旧 `app/lib/commands.mjs`** —— 第二刀本地化，届时旧文件不再被引用
2. **向量索引只有接口**（`存储/store.mjs 的 语义检索()` 返回缺口）
3. **远程算力（Runtime Adapter 的远程分支）未实现**，只留权限位
4. **L1 前端尚未接 L3**：`/api/edit/ask` 还在旧 `server.mjs`，第二刀改接 `编排/agent.mjs`
5. 素材库当前只有 1 条演示素材（假 PNG），真实库要等提供商产出

## 旧文件

v1 的 `registry/capabilities/routes/bridge/channel/models/library/outlet/render-ops` 已移入 `_v1-归档/`，
**没有删除**：第二刀搬完实现后再决定去留。"}]