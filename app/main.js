import fs from "node:fs";
import path from "node:path";

import { loadConfig, runtimeConfig, redactConfig, loadFieldTable, saveConfig, defaultsFromTable } from "./src/config.js";
import { createStore } from "./src/store.js";
import { createBot } from "./src/index.js";
import { createOneBot } from "./src/onebot.js";
import { createRuntime } from "./src/runtime.js";
import { runBrain, ensureBrainProfile, resolveDshCli } from "./src/brain.js";
import { personaFromConfig } from "./src/dshprofile.js";
import { createAuditor, setAuditChannel, loadRubric } from "./src/audit.js";
import { createSearch, SEARCH_PROFILE_ID, SEARCH_PERSONA } from "./src/search.js";
import { CONFIG_FILE, DATA_ROOT } from "./src/paths.js";

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const tickMs = Number((args.find(function (a) { return a.indexOf("--tick=") === 0; }) || "").split("=")[1]) || 500;

function log() {
  const a = Array.prototype.slice.call(arguments);
  console.log("[" + new Date().toISOString().slice(11, 19) + "] " + a.join(" "));
}

log("DSH-QQ 群小助手 启动");
const table = loadFieldTable();
let cfg = loadConfig({ table: table });
if (!fs.existsSync(CONFIG_FILE)) { saveConfig(cfg, CONFIG_FILE); log("已生成默认配置：" + CONFIG_FILE); }
const rc = runtimeConfig(cfg);
const persona = personaFromConfig(cfg);

log("模式：" + (rc.stageMode === "auto" ? "auto（新群观察 " + rc.observeUntilMessages + " 条 → 半自动 " + rc.semiAutoDays + " 天 → 全自动）" : rc.stageMode === "observe" ? "强制观察" : "直接实际发送"));
log("数据根：" + DATA_ROOT);
log("人设：" + persona.botName + " / " + persona.age);
log("接入：" + rc.onebot.wsUrl + "（N7 占位，等真实参数）");
log("预算：日 " + rc.budget.dailyTokens + " token，超 " + (rc.budget.softRatio * 100) + "% 关主动");
log("搜索：通道 " + rc.searchMode.toUpperCase() + "（" + (rc.searchMode === "b" ? "DSH 独立调用" : "本机直搜") + "），外审：qq-audit / 8s 超时 → 不确定");

const store = createStore(path.join(DATA_ROOT, "data"));
const bot = createBot({ dataRoot: path.join(DATA_ROOT, "data"), botNames: [persona.botName], nicknames: [persona.botName] });
const cli = resolveDshCli();
const boot = ensureBrainProfile({ cliPath: cli, persona: persona });
log("大脑 profile：" + JSON.stringify({ ok: boot.ok, patch: boot.patch || null, error: boot.error || null }));

const ob = createOneBot({
  url: rc.onebot.wsUrl, token: rc.onebot.token, reconnectMs: rc.onebot.reconnectMs,
  onEvent: function (evt) { runtime.onEvent(evt); },
  onStatus: function (s) { if (s.state !== "reconnecting" || (s.retry || 0) % 5 === 0) log("onebot: " + s.state + (s.error ? " " + s.error : "")); }
});

// N11 外审通道：独立 qq-audit profile，8 秒超时 → 不确定
const auditor = createAuditor({
  timeoutMs: 8000,
  rubric: loadRubric(),
  runner: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    ensureBrainProfile({ cliPath: cli, profile: req.profile, personaText: req.personaText });
    return runBrain({ cliPath: cli, profile: req.profile, promptText: req.promptText, timeoutMs: req.timeoutMs });
  }
});
setAuditChannel(auditor);

// N12 搜索：默认 C（本机直搜，零模型调用）；B 走独立的 qq-search profile
const searchSvc = createSearch({
  mode: rc.searchMode,
  brainSearch: async function (req) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    ensureBrainProfile({ cliPath: cli, profile: SEARCH_PROFILE_ID, personaText: SEARCH_PERSONA });
    const r = await runBrain({ cliPath: cli, profile: SEARCH_PROFILE_ID, promptText: "搜索这几个关键词并总结：" + req.query, timeoutMs: 30000 });
    if (!r.ok) return { ok: false, error: r.error, usage: r.usage };
    return { ok: true, summary: r.text, usage: r.usage };
  }
});

const runtime = createRuntime({
  config: cfg, runtime: rc, store: store, bot: bot, search: searchSvc,
  evtDefaults: { botNames: [persona.botName], nicknames: [persona.botName], interests: persona.interests, dislikes: persona.dislikes },
  send: function (gid, text) { log("→ " + gid + " : " + text); return ob.sendGroupMsg(gid, text); },
  askBrain: async function (o) {
    if (!cli) return { ok: false, error: "找不到 DSH 启动器" };
    return runBrain({ cliPath: cli, promptText: o.promptText, timeoutMs: 60000 });
  },
  log: log
});

if (selftest) {
  const st = runtime.status();
  log("自检通过：" + JSON.stringify({ mode: st.mode, onebotState: ob.state(), config: redactConfig(cfg, table).runtime || null }));
  log("配置片断：" + JSON.stringify({ persona: redactConfig(cfg, table).persona, napcat: redactConfig(cfg, table).napcat }));
  process.exit(0);
}

ob.connect();
const timer = setInterval(function () { runtime.tick().catch(function (e) { log("tick 失败：" + e.message); }); }, tickMs);
if (timer.unref) timer.unref();
setInterval(function () { log("状态 " + JSON.stringify(runtime.status().stats)); }, 30000);

process.on("SIGINT", function () {
  log("收到 SIGINT，收尾中…");
  runtime.budget.save(path.join(DATA_ROOT, "data", "budget.json"));
  store.saveBandit({ state: bot.bandit.state(), at: new Date().toISOString() });
  ob.close();
  clearInterval(timer);
  setTimeout(function () { process.exit(0); }, 200);
});
