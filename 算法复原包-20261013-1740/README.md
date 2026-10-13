# 算法复原包 · E:\dshQ群小助手配置端（2026-10-13）

## 这是什么

按你选的**方案 B**：放弃磁盘侧（见下"DiskGenius 结论"），从**对话存档**里把项目自身的内容逐字取回来。
全部内容来自 OpenViking 待发队列的离线副本（`临时/openviking归档-20261013-1730/全量/`），**不是推测，是逐字摘录**。

## 目录

| 文件/目录 | 内容 |
|---|---|
| `设计原理复原.md` | 六因子统一效用、公式与实测常数、代价感知评分、对象判断、话风臂 Thompson Sampling、当时的验收口径 |
| `缺口清单.md` | 哪些文件永远回不来、哪些只有片段、重建最短路径 |
| `版本对照.md` | 163 个文件块 × 138 个文件名的**全部快照**（含时间戳），可挑所需时间点 |
| `原始片段/` | 163 个逐字内容文件；每个文件头部写有 `来源会话 / 记录时间 / 原始路径名 / 提取方式` |
| `manifest.jsonl` | 机读索引：name / t / sid / kind / bytes / out |

## 取回情况速览

- **核心算法主件**：`utility.js` 225 行、`src/score.js` 164 行、`src/bandit.js` 188 行、`src/addressee.js` 306 行（另有 127 行版本）
- **周边**：`src/config.js` 270、`src/store.js` 304、`src/balance.js` 280、`src/learner.js` 358、`src/feedback.js` 347、`src/commands.js` 157、`src/lessonmatch.js` 103、`src/server.js` 431、`src/main.js` 218、`src/kernel.js` 27、`build/kernel-check.mjs` 49
- **启动器 C#**：`launcher/TrayLauncher.cs` 561 行、`Api.cs` 200 行
- **文档/登记**：`项目.md` 55 行、`模块.json` 181 行、`接续.md`、`交接.md` 114 行、`M0-验证报告.md` 152 行、`build/check.mjs`、`dsh-data/config/app.json` 191 行
- **仍未取回**：`gatescore.js / labels.js / proactive.js / untrusted.js / triggers.js`（零命中）、`gates.js` 正文、`技术架构文档.md`(237KB) 等 —— 详见 `缺口清单.md`

## 提取方法与可信度

- 来源：插件待发队列中**工具的原始输入/输出**（`tool_input.code` 里的 `tools.read/write/edit` 载荷、以及 `tool_output` 里被打印的文件正文）
- 规范化：JSON 转义（`\\n` → 换行）还原；同名文件保留**最大/最完整**的版本，其余版本保留在 `原始片段/` 并在 `版本对照.md` 列出
- 每个块都在头部标注了来源会话与记录时间，可回溯核对（原始记录在归档的 `全量/pending/` 里）
- **抽检已人工核对**：`utility.js`、`score.js`、`bandit.js`、`addressee.js`、`train-addressee.cjs` 的头部注释与代码均为真源码，与原文一致

## DiskGenius 结论（方案 A 为何未执行）

- 沙箱内的 shell **拿不到 TLS 凭据句柄**（`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`；`Invoke-WebRequest` 同样报 SSL 失败），TCP 443 连通正常 → 是**沙箱限制**，不是网络问题，所以我在会话内下不了 DiskGenius。
- 另外：E: 是 **WD Blue SN580 NVMe SSD** 且 **TRIM 开启**（`DisableDeleteNotify = 0`），删除已过 ~1.5 小时，**磁盘 undelete 拿到正文的概率本来就很低**。
- 若仍要试：你自己在浏览器下载 **DiskGenius 免费版**（中文站 `diskgenius.cn/download.php`，或直接下便携版 zip），**保存并解压到 C:**，然后按：选中 E: → 「恢复文件」→ 勾"恢复已删除的文件" → 快速扫描 → 过滤 `*.js;*.json;*.md;*.cs` → 找目录 `dshQ群小助手配置端` → **恢复目标写 C:**（绝不写 E:）。
