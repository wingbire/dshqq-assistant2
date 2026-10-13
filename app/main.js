import fs from "node:fs";
import path from "node:path";

import { loadConfig, runtimeConfig, redactConfig, loadFieldTable, saveConfig, defaultsFromTable } from "./src/config.js";
import { createStore } from "./src/store.js";
import { createBot } from "./src/index.js";
import { createOneBot } from "./src/onebot.js";
import { createRuntime } from "./src/runtime.js";
import { runBrain, ensureBrainProfile, resolveDshCli } from "./src/brain.js";
import { personaFromConfig } from "./src/dshprofile.js";
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

log("模式：" + (rc.observe ? "观察（只判定不发送，N9 默认）" : "实际发送"));
log("数据根：" + DATA_ROOT);
log("人设：" + persona.botName + " / " + persona.age);
log("接入：" + rc.onebot.wsUrl + "（N7 占位，等真实参数）");
log("预算：日 " + rc.budget.dailyTokens + " token，超 " + (rc.budget.softRatio * 100) + "% 关主动");

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

const runtime = createRuntime({
  config: cfg, runtime: rc, store: store, bot: bot,
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
