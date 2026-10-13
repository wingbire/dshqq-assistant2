# 安装与首次运行

> 这个包是**分发版**：不含任何 API 密钥，也不含任何表情包素材。
> 每位使用者用自己的 DeepSeek 账号和 key，自己付费（BYO key）。

## 一、环境

| 需要 | 说明 |
|---|---|
| Windows 10 / 11 | 托盘启动器是 WinForms，用系统自带的 .NET Framework 4.x 运行，**不需要装任何 SDK** |
| Node.js ≥ 22 | 程序本体。若安装目录下有 `runtime/node/node.exe` 则优先用它 |
| DSH（DeepSeek Harness） | 大脑通道。需要你在本机建一个专用 profile，见下面第三节 |
| NapCat / OneBot v11 | 收发 QQ 群消息，需自备（本包不附带，授权与体积原因） |

## 二、三步跑起来

1. **解压**到任意目录（建议路径不含空格，例如 `D:\DSHQQ`）
2. **双击** `launcher\DSHQQTray.exe` —— 它会自己启动程序，并打开配置端页面 `http://127.0.0.1:8799`
3. 在**接入**页填 NapCat 的 WS 地址与令牌，在**人设**页填小助手的名字 / 年龄段 / 三条性格 / 兴趣 / 雷点

> 托盘图标右键可：启动 / 停止 / 重启 / 打开配置端 / 打开数据目录 / 查看日志 / 开机自启。

## 三、大脑通道（DSH）

程序会在安装目录下的 `app/dsh-home/` 里自建一个**专属 profile**（`qq-brain`），**不会写你 `~/.dsh` 里的任何东西**。

需要你准备一把 DeepSeek API key（[控制台](https://platform.deepseek.com/) → API Keys），二选一：

    # A. 写进工作区自持的密钥文件（推荐）
    #    文件：app/dsh-data/config/secrets.json
    { "deepseekApiKey": "sk-你自己的key" }

    # B. 或者让程序从本机既有的 DSH 凭据里导入一次（只读 ~/.dsh，不写）
    node demo/import-key.mjs

## 四、表情包图库（重要）

**本包不附带任何表情素材** —— 内置那套图库的授权是 personal，不能再分发。你有两条路：

- 自己攒一套：在安装目录建 `app/meme-lib/<情绪标签>/*.jpg`，程序会按标签与文件名匹配
- 或安装 DSH 的 `dsh-meme` 插件并把图库指向它（程序会自动去找）

找不到图库时**不影响运行**，只是不配图。

## 五、默认行为（都可以在配置端改）

    新群：先观察 80 条消息（只判定、一个字都不发）
      ↓ 攒满
    半自动 3 天：只回被 @ / 被回复 / 被叫外号
      ↓
    全自动：打开主动搭话，无 @ 也能在感兴趣的话题插一句

**刹车**：群内 `/停` `/开` `/状态`（群主/管理/白名单可用）、配置端暂停、安装目录根放一个 `STOP` 文件即可全局停。

## 六、自检与排错

    node test/run-tests.mjs         # 135 项骨架回归测试
    node demo/run-acceptance.mjs    # 全量验收（快，不花 API 额度）

- **连不上 QQ**：看配置端「接入」页与 `app/dsh-data/logs/bot.log`
- **报 MISSING_CREDENTIAL**：key 没配好，回第三节
- **配置端打不开**：端口被占用，配置端页里换一个（默认 8799）
- **数据在哪**：全部在 `app/dsh-data/`，删掉即重置
