import { classify, CLASSIFY_TABLE, extractKeywords } from "../app/src/classify.js";
import { utilityScore, UTILITY_WEIGHTS, gateFactor } from "../app/src/utility.js";
import { valve, depthTier, searchPlan, clampBounds, adaptBounds } from "../app/src/gatescore.js";
import { engagementOf, reward, costOf } from "../app/src/score.js";
import { createProactive } from "../app/src/proactive.js";
import { createStore } from "../app/src/store.js";
import { createAddressee } from "../app/src/addressee.js";
import { parseEvents, buildArgs, brainEnv, cacheHitRate, PROFILE_DEFAULT, DEPTH_POLICY_DEFAULT } from "../app/src/brain.js";
import { maskKey, parseRefsApiKey, pickApiKey, loadSecrets, saveSecrets } from "../app/src/secrets.js";
import { buildPersonaText, renderProfilePatch, writeProfilePatch, DEFAULT_PERSONA, PROFILE_ID } from "../app/src/dshprofile.js";
import { DATA_ROOT, DSH_HOME, APP_ROOT, BRAIN_TMP_DIR } from "../app/src/paths.js";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

let pass = 0; const fails = [];
function t(name, fn) { try { fn(); pass += 1; } catch (e) { fails.push(name + " :: " + String(e && e.message).slice(0, 160)); } }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || "") + " 期望 " + JSON.stringify(b) + " 实得 " + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || "应为真"); }

t("classify: 提问桶", function () { ok(classify("这个报错怎么解").buckets.includes("question"), "应落 question"); });
t("classify: 梗桶", function () { ok(classify("哈哈这波太典了笑死").buckets.includes("banter"), "应落 banter"); });
t("classify: 游戏桶", function () { ok(classify("第五层那个 boss 怎么打").buckets.includes("game"), "应落 game"); });
t("classify: 求助标记", function () { ok(classify("帮我写个 ffmpeg 命令").flags.isRequest, "isRequest 应为真"); });
t("classify: 详细标记", function () { ok(classify("详细讲讲原理并写进文档").flags.isDetailAsk, "isDetailAsk 应为真"); });
t("classify: 话题深度 3", function () { eq(classify("详细讲讲这个报错的原因和原理，我要写进文档里").topicDepth, 3); });
t("classify: 闲聊深度 0", function () { eq(classify("大家晚饭吃了吗").topicDepth <= 1, true); });
t("classify: 关键词非空", function () { ok(extractKeywords("这个报错怎么解", {}).length > 0); });
t("classify: 兴趣命中", function () { eq(classify("今晚开黑吗", { interests: ["开黑"] }).interestHit, ["开黑"]); });

t("utility: pSay 单调", function () {
  const a = utilityScore({ pSay: 0.9, sem: 0.5, cont: 1, demand: 1, diff: 0.3, cost: 200, costScale: 900, gate: 0.5 });
  const b = utilityScore({ pSay: 0.1, sem: 0.5, cont: 1, demand: 1, diff: 0.3, cost: 200, costScale: 900, gate: 0.5 });
  ok(a.U > b.U, "高 pSay 的 U 应更大");
});
t("utility: gate 地板", function () { ok(gateFactor(1) > gateFactor(0), "硬触发 gate 应更大"); });
t("utility: 成本拉低 U", function () {
  const a = utilityScore({ pSay: 0.8, sem: 0.5, cont: 1, demand: 1, diff: 0.9, cost: 2000, costScale: 900 });
  const b = utilityScore({ pSay: 0.8, sem: 0.5, cont: 1, demand: 1, diff: 0.9, cost: 200, costScale: 900 });
  ok(a.U < b.U, "成本高的 U 应更小");
});

t("gatescore: 阀门三态", function () {
  eq(valve(0.1, null).verdict, "no");
  eq(valve(0.9, null).verdict, "yes");
  eq(valve(0.5, null).verdict, "grey");
});
t("gatescore: 深档映射", function () {
  eq(depthTier(0.1, null).tier, "low");
  eq(depthTier(0.4, null).tier, "mid");
  eq(depthTier(0.8, null).tier, "high");
});
t("gatescore: 低档不搜", function () { eq(searchPlan("low", ["a"]).search, 0); eq(searchPlan("high", ["a"]).search, 1); });
t("gatescore: 边界自适应有界", function () {
  const b = adaptBounds({ lo: 0.4, hi: 0.75 }, { missedRate: 0.9, auditFlipRate: 0.9 });
  ok(b.lo >= 0.25 && b.hi <= 0.92, "应在边界内");
});

t("score: engagement 档位", function () {
  eq(engagementOf({ outcome: "continued_with_bot", nickCall: true }), 4);
  eq(engagementOf({ outcome: "continued_with_bot" }), 2);
  eq(engagementOf({ outcome: "went_to_others" }), -1);
  eq(engagementOf({ outcome: "annoyed" }), -2);
});
t("score: 输出按 2 倍计费", function () { eq(costOf({ inTokens: 100, outTokens: 50 }), 200); });
t("score: reward 随成本下降", function () {
  const hi = reward({ outcome: "continued_with_bot", inTokens: 100, outTokens: 200 }, { lambda: 1 }, 100);
  const lo = reward({ outcome: "continued_with_bot", inTokens: 100, outTokens: 20 }, { lambda: 1 }, 100);
  ok(hi < lo, "成本高的 reward 应更低");
});

t("proactive: 未命中兴趣不插话", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1 } });
  eq(p.consider({ text: "今天天气不错", now: 1000000, uid: "u1" }, { action: "ignore" }, { interests: ["开黑"] }).speak, false);
});
t("proactive: 兴趣命中 + 概率过 → 插话", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1 } });
  eq(p.consider({ text: "今晚开黑吗", now: 1000000, uid: "u1" }, { action: "ignore" }, { interests: ["开黑"] }).speak, true);
});
t("proactive: 冷却生效", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1, minGapSec: 120 } });
  ok(p.consider({ text: "今晚开黑吗", now: 1000000, uid: "u1" }, { action: "ignore" }, { interests: ["开黑"] }).speak);
  p.markSpoken(1000000);
  eq(p.consider({ text: "今晚开黑吗", now: 1010000, uid: "u1" }, { action: "ignore" }, { interests: ["开黑"] }).speak, false);
});
t("proactive: 已有回复动作时让位", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1 } });
  eq(p.consider({ text: "今晚开黑吗", now: 1000000 }, { action: "brain" }, { interests: ["开黑"] }).speak, false);
});
t("proactive: 每小时配额", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1, maxPerHour: 1, minGapSec: 0 } });
  p.markSpoken(1000000);
  eq(p.consider({ text: "今晚开黑吗", now: 1001000 }, { action: "ignore" }, { interests: ["开黑"] }).speak, false);
});

t("store: 追加与读取 jsonl", function () {
  const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "dsh-data", "_test");
  fs.mkdirSync(BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(BASE, "a-"));
  const s = createStore(dir, { jsonlMaxLines: 3 });
  s.appendJsonl(s.paths.feedback, { a: 1 });
  s.appendJsonl(s.paths.feedback, { a: 2 });
  eq(s.readJsonl(s.paths.feedback).length, 2);
  s.appendJsonl(s.paths.feedback, { a: 3 });
  s.appendJsonl(s.paths.feedback, { a: 4 });
  eq(s.jsonlCount(s.paths.feedback), 1, "超过 3 行应轮转");
  eq(s.readJsonl(s.paths.feedback).length, 4, "读取应含上一代");
  ok(fs.existsSync(s.paths.feedback + ".1"), "应存在上一代文件");
});
t("store: 群档案读写", function () {
  const BASE2 = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "dsh-data", "_test");
  fs.mkdirSync(BASE2, { recursive: true });
  const dir = fs.mkdtempSync(path.join(BASE2, "b-"));
  const s = createStore(dir, {});
  s.saveProfile("255452871", { interests: ["开黑"] });
  eq(s.loadProfile("255452871").interests, ["开黑"]);
});

t("addressee: @ 提升置信度", function () {
  const a = createAddressee({});
  const hi = a.judge("g", { text: "这个怎么解", atBot: true, botNames: ["小助手"] }).conf;
  const lo = a.judge("g", { text: "这个怎么解", atBot: false, botNames: ["小助手"] }).conf;
  ok(hi > lo, "@ 的置信度应更高");
});
t("addressee: 点到别人名字降权", function () {
  const a = createAddressee({});
  const withOther = a.judge("g", { text: "阿伟你会不会", botNames: ["小助手"], groupNames: ["阿伟"] }).conf;
  const without = a.judge("g", { text: "你会不会", botNames: ["小助手"], groupNames: ["阿伟"] }).conf;
  ok(withOther < without, "点到别人的名字应降权");
});


// ---------- 隔离性专项（跨群不串用） ----------
import { createBandit, bucketOf } from "../app/src/bandit.js";
import { refitProfile } from "../app/src/profile.js";
import { createBot } from "../app/src/index.js";

t("bandit: 跨群隔离（A 群学的不能影响 B 群）", function () {
  const b = createBandit({ rng: function () { return 0.5; } });
  for (let i = 0; i < 6; i++) b.update("question", "terse", 1, "groupA");
  const keys = Object.keys(b.state());
  ok(keys.length > 0 && keys.every(function (k) { return k.startsWith("groupA|"); }), "状态只应含 A 群");
  const pick = b.choose("question", "groupB");
  const anyLearned = pick.detail.some(function (x) { return x.n > 0; });
  eq(anyLearned, false, "B 群应是全新先验");
  ok(b.groups().includes("groupA") && !b.groups().includes("groupB"), "群列表应先只有 A");
});

t("proactive: 跨群冷却独立", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1, minGapSec: 120 } });
  const evA = { gid: "A", text: "今晚开黑吗", now: 1000000 };
  const evB = { gid: "B", text: "今晚开黑吗", now: 1000000 };
  ok(p.consider(evA, { action: "ignore" }, { interests: ["开黑"] }).speak, "A 应先能说");
  p.markSpoken(1000000, "A");
  eq(p.consider(evB, { action: "ignore" }, { interests: ["开黑"] }).speak, true, "B 不应被 A 的冷却挡住");
});

t("proactive: 跨群配额独立", function () {
  const p = createProactive({ rng: function () { return 0; }, config: { rate: 1, maxPerHour: 1, minGapSec: 0 } });
  p.markSpoken(1000000, "A");
  eq(p.consider({ gid: "A", text: "今晚开黑吗", now: 1001000 }, { action: "ignore" }, { interests: ["开黑"] }).speak, false, "A 配额已满");
  eq(p.consider({ gid: "B", text: "今晚开黑吗", now: 1001000 }, { action: "ignore" }, { interests: ["开黑"] }).speak, true, "B 配额独立");
});

t("profile: 小助手自己的名字不被学成兴趣", function () {
  const prof = refitProfile([
    { gid: "A", outcome: "continued_with_bot", tokens: ["小肥鱼", "报错"] },
    { gid: "A", outcome: "continued_with_bot", tokens: ["小肥鱼"] }
  ], null, { exclude: ["小肥鱼", "肥鱼", "小助手"] });
  ok(!prof.interests.includes("小肥鱼"), "不应把名字学成兴趣");
  ok(prof.interests.includes("报错"), "正常词应保留");
});

t("profile: 代词助词碎片被过滤", function () {
  const prof = refitProfile([{ gid: "A", outcome: "continued_with_bot", tokens: ["你在吗", "游戏"] }], null, { exclude: [] });
  eq(prof.interests.includes("游戏"), true);
  eq(prof.interests.includes("你在吗"), false);
});

t("端到端隔离：B 群事件不会写进 A 群档案", function () {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "dsh-data", "_test", "iso-" + Date.now());
  const bot = createBot({ dataRoot: dir, score: { refN: 2 } });
  bot.observe({ gid: "A", uid: "u1", arm: "terse", bucket: "game", outcome: "continued_with_bot", tokens: ["开黑"], inTokens: 10, outTokens: 5 });
  const r = bot.observe({ gid: "B", uid: "u2", arm: "terse", bucket: "general", outcome: "continued_with_bot", tokens: ["追星"], inTokens: 10, outTokens: 5 });
  ok(r && r.refit, "第 2 次回复应触发重炼");
  const profB = bot.store.loadProfile("B");
  eq(profB.interests.includes("追星"), true, "B 应学到自己的词");
  eq(profB.interests.includes("开黑"), false, "B 不应学到 A 的词");
  eq(bot.store.loadProfile("A"), null, "此时 A 还没有档案，不应被创建");
});

t("决策里带话风臂", function () {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "dsh-data", "_test", "arm-" + Date.now());
  const bot = createBot({ dataRoot: dir, rng: function () { return 0.5; } });
  return bot.handleEvent({ gid: "A", uid: "u1", text: "@小助手 在吗", atBot: true, botNames: ["小助手"], now: 1 }).then(function (d) {
    ok(d.action !== "ignore", "应触发回复");
    ok(["terse", "standard", "detailed"].includes(d.arm), "应带合法 arm，实得 " + d.arm);
  });
});

t("bandit: 落盘后恢复，且恢复后跨群仍隔离", function () {
  const b1 = createBandit({ rng: function () { return 0.5; } });
  for (let i = 0; i < 4; i++) b1.update("question", "terse", 1, "A");
  b1.update("question", "terse", -1, "B");
  const snap = b1.state();
  const b2 = createBandit({ rng: function () { return 0.5; } });
  eq(b2.hydrate(snap), 2, "应恢复 2 个格子");
  eq(b2.state(), snap, "恢复后状态应一致");
  eq(Object.keys(b2.state()).every(function (k) { return k.indexOf("|") === 1 || k.split("|")[0] === "A" || k.split("|")[0] === "B"; }), true);
  const pickB = b2.choose("question", "A");
  ok(pickB.detail.some(function (x) { return x.n === 4; }), "A 的样本数应为 4（未被 B 污染）");
});

// ===== P0：大脑通道与真实 CLI 对齐 =====

t("brain: 解析真实 CLI 事件（final 优先）", function () {
  const raw = [
    '{"type":"session","sessionId":"s1"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"thinking","text":""}',
    '{"type":"text","text":"我到了"}',
    '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5646,"outputTokens":3,"cacheReadTokens":384,"cacheWriteTokens":0,"totalTokens":6033}}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    '{"type":"final","text":"我到了"}'
  ].join(String.fromCharCode(10));
  const p = parseEvents(raw);
  eq(p.text, "我到了");
  eq(p.sessionId, "s1");
  eq(p.steps, 1);
  eq(p.usage.inputTokens, 5646);
  eq(p.error, null);
});

t("brain: 没有 final 时回落到 text 片段", function () {
  const raw = '{"type":"text","text":"前半"}' + String.fromCharCode(10) + '{"type":"text","text":"后半"}';
  eq(parseEvents(raw).text, "前半后半");
});

t("brain: 裸文本兜底（mock CLI 形状不回归）", function () {
  const raw = '{"type":"status","phase":"step_end","usage":{"inputTokens":127,"outputTokens":45,"cacheReadTokens":1000,"cacheWriteTokens":90}}'
    + String.fromCharCode(10) + "我上次也卡这儿。" + String.fromCharCode(10) + '{"type":"status","phase":"session_end"}';
  const p = parseEvents(raw);
  eq(p.text, "我上次也卡这儿。");
  eq(p.usage.cacheReadTokens, 1000);
  eq(Math.round(cacheHitRate(p.usage) * 1000) / 10, 82.2);
});

t("brain: turn_end 的错误会被识别", function () {
  const raw = '{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"message":"no API key","code":"MISSING_CREDENTIAL"}}}';
  ok(String(parseEvents(raw).error).includes("no API key"));
});

t("brain: buildArgs 带 profile 与 --json，任务在最后", function () {
  const args = buildArgs({ launch: { cliJs: "C:/x/cli.js" }, profile: "qq-brain", appName: "headless", promptText: "在吗" });
  eq(args[args.length - 1], "在吗");
  ok(args.includes("--json"), "应带 --json 才能拿到 usage");
  ok(args.includes("qq-brain"), "应带 profile");
  eq(args[args.indexOf("--profile") + 1], "qq-brain");
  eq(args.indexOf("--json") < args.indexOf("在吗"), true, "--json 必须在任务文本之前（headless 只把最后一个位置当任务）");
});

t("brain: brainEnv 注入 DSH_HOME 与密钥", function () {
  const env = brainEnv({ dshHome: "C:/ws/app/dsh-home", apiKey: "sk-test-1234567890" });
  eq(env.DSH_HOME, "C:/ws/app/dsh-home");
  eq(env.DEEPSEEK_API_KEY, "sk-test-1234567890");
  const env2 = brainEnv({ dshHome: "C:/ws/app/dsh-home", apiKey: null, env: {} });
  eq(env2.DEEPSEEK_API_KEY, undefined, "没有密钥时不应乱塞");
});

t("brain: 默认 profile 名与实际 profile 一致", function () { eq(PROFILE_DEFAULT, PROFILE_ID); eq(PROFILE_DEFAULT, "qq-brain"); });

t("brain: N8 决策——进 prompt 的上下文窗口为 10", function () {
  eq(DEPTH_POLICY_DEFAULT.mid.contextWindow, 10);
  eq(DEPTH_POLICY_DEFAULT.high.contextWindow, 10);
});

t("dshprofile: 人设文本逐字节稳定", function () {
  const a = buildPersonaText(DEFAULT_PERSONA);
  const b = buildPersonaText(Object.assign({}, DEFAULT_PERSONA));
  eq(a, b);
  ok(a.includes("小肥鱼"));
  ok(a.includes("【身份内核】"));
  ok(!/\d{4}-\d{2}-\d{2}/.test(a), "人设里不能有时间戳，否则前缀缓存永远不命中");
});

t("dshprofile: patch 是 loader 数组且人设落在 personaPrefix", function () {
  const patch = JSON.parse(renderProfilePatch("【测试】人设"));
  eq(Array.isArray(patch), true);
  eq(patch.length, 1);
  eq(patch[0].id, "system-prompt");
  eq(patch[0].config.personaPrefix, "【测试】人设");
  eq(patch[0].config.includeHarnessIdentity, false);
});

t("dshprofile: writeProfilePatch 落盘可回读", function () {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "dsh-data", "_test", "prof-" + Date.now());
  const file = writeProfilePatch(dir, "qq-brain", "【落盘】人设");
  ok(fs.existsSync(file));
  eq(JSON.parse(fs.readFileSync(file, "utf8"))[0].config.personaPrefix, "【落盘】人设");
});

t("secrets: maskKey 不泄露明文", function () {
  eq(maskKey(""), null);
  eq(maskKey("short"), "***");
  const m = maskKey("sk-TESTFIXTURE0000000000000000000000");
  ok(m.startsWith("sk-843"));
  ok(!m.includes("654abb"), "中段必须被遮住");
});

t("secrets: parseRefsApiKey 只认 refs 块里的目标键", function () {
  const yaml = ["version: 1", "refs:", "  DEEPSEEK_API_KEY: sk-abc123456789", "  OTHER: zzz", "records:", "  DEEPSEEK_API_KEY: should-not-win"].join(String.fromCharCode(10));
  eq(parseRefsApiKey(yaml), "sk-abc123456789");
  eq(parseRefsApiKey("records:" + String.fromCharCode(10) + "  DEEPSEEK_API_KEY: nope"), null);
  eq(parseRefsApiKey('refs:' + String.fromCharCode(10) + '  DEEPSEEK_API_KEY: "sk-quoted"'), "sk-quoted");
});

t("secrets: pickApiKey 文件优先于环境变量", function () {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "dsh-data", "_test", "sec-" + Date.now());
  const f = path.join(dir, "secrets.json");
  saveSecrets({ deepseekApiKey: "sk-from-file" }, f);
  eq(pickApiKey({ DEEPSEEK_API_KEY: "sk-from-env" }, f), "sk-from-file");
  eq(pickApiKey({ DEEPSEEK_API_KEY: "sk-from-env" }, path.join(dir, "missing.json")), "sk-from-env");
  eq(pickApiKey({}, path.join(dir, "missing.json")), null);
  eq(loadSecrets(f).deepseekApiKey, "sk-from-file");
});

t("paths: 数据根稳定指向 <工作区>/app/dsh-data", function () {
  ok(APP_ROOT.endsWith("app"), "APP_ROOT 应是 app 目录，实得 " + APP_ROOT);
  eq(DATA_ROOT, path.join(APP_ROOT, "dsh-data"));
  ok(BRAIN_TMP_DIR.startsWith(DATA_ROOT), "brain 临时目录必须在数据根内（原实现在 cwd 下）");
  ok(DSH_HOME.endsWith("dsh-home") || !!process.env.DSHQQ_DSH_HOME, "DSH_HOME 应落在程序目录内");
});

console.log("=== 骨架回归测试 ===");
console.log("通过 " + pass + " 项，失败 " + fails.length + " 项");
for (const f of fails) console.log("  FAIL " + f);
process.exitCode = fails.length === 0 ? 0 : 1;
