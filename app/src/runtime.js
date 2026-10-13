import { createCoalescer, pickAnchor } from "./coalesce.js";
import { splitReply } from "./split.js";
import { createBudget } from "./budget.js";
import { createBrakes, parseAdminCommand, isAdmin } from "./brakes.js";
import { localReply } from "./localreply.js";
import { depthPolicy, buildTaskText } from "./brain.js";
import { parseMeme } from "./audit.js";

// P1 接入层装配。所有外部副作用（send / askBrain / now / rng / store）都可注入，
// 所以整套流程能在没有 QQ、没有模型的情况下被测试。
export function createRuntime(deps) {
  const d = deps || {};
  const cfg = d.config || {};
  const rc = d.runtime || {};
  const store = d.store || null;
  const bot = d.bot;
  const send = d.send || function () { return false; };
  const askBrain = d.askBrain || null;
  const now = d.now || function () { return Date.now(); };
  const rng = d.rng || Math.random;
  const log = d.log || function () {};
  const sleep = d.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const sendGapMs = d.sendGapMs != null ? d.sendGapMs : 400;

  const evtDefaults = d.evtDefaults || {};      // botNames / nicknames / interests 等，来自人设配置
  const lastBot = new Map();                    // gid -> { lastBotText, lastBotAt }，供「连续性」特征用
  const coalescer = createCoalescer({ windowMs: rc.coalesceWindowMs, maxBatch: rc.coalesceMaxBatch });
  const budget = d.budget || createBudget({ limits: rc.budget, now: now });
  const brakes = d.brakes || createBrakes({ config: cfg, now: now });

  const stats = { events: 0, ignored: 0, observed: 0, replies: 0, segments: 0, brainCalls: 0, tokens: 0, stopped: 0, adminCmds: 0 };
  let busy = false;

  function observe(rec) {
    stats.observed += 1;
    if (store && store.addObservation) { try { store.addObservation(rec); } catch (e) {} }
  }

  function adminConfig() { return cfg.admin || {}; }

  async function onEvent(evt) {
    stats.events += 1;
    const st = brakes.state(evt.gid, evt.now);
    if (st.stopped) { stats.stopped += 1; return { action: "stopped", reason: st.reason }; }

    const cmd = parseAdminCommand(evt.text);
    if (cmd) {
      if (!isAdmin(evt, adminConfig())) return { action: "ignored", reason: "非管理员" };
      stats.adminCmds += 1;
      if (cmd.cmd === "stop") {
        brakes.stopGroup(evt.gid, cmd.minutes, evt.now);
        send(evt.gid, "行，我先闭嘴 " + cmd.minutes + " 分钟。");
        return { action: "admin_stop", minutes: cmd.minutes };
      }
      if (cmd.cmd === "resume") {
        brakes.resumeGroup(evt.gid);
        send(evt.gid, "好，我回来了。");
        return { action: "admin_resume" };
      }
      const s = budget.status();
      send(evt.gid, "今天用了 " + s.used + "/" + s.limit + "，" + s.mode);
      return { action: "admin_status", budget: s };
    }

    coalescer.push(evt);
    return { action: "pending", pending: coalescer.size() };
  }

  async function tick(t) {
    const at = t == null ? now() : t;
    if (busy) return { skipped: "busy" };
    const batches = coalescer.flushDue(at);
    if (!batches.length) return { batches: 0, results: [] };
    busy = true;
    const results = [];
    try { for (const b of batches) results.push(await handleBatch(b, at)); }
    finally { busy = false; }
    return { batches: batches.length, results: results };
  }

  async function handleBatch(batch, at) {
    const decisions = [];
    for (const rawEvt of batch.evts) {
      const evt = Object.assign({}, evtDefaults, lastBot.get(String(rawEvt.gid)) || {}, rawEvt);
      const dec = await bot.handleEvent(evt);
      decisions.push(Object.assign({}, dec, { evt: evt }));
      observe({
        kind: "decision", gid: batch.gid, uid: batch.uid, speaker: evt.speaker,
        text: evt.text, atBot: !!evt.atBot, replyToBot: !!evt.replyToBot,
        action: dec.action, verdict: dec.verdict, pSay: dec.pSay, U: dec.U,
        tier: dec.tier, maxChars: dec.maxChars, search: dec.search, keywords: dec.keywords,
        bucket: dec.bucket, arm: dec.arm, reason: dec.reason, injected: dec.injected
      });
    }
    // N23：整批当成一轮来判定 —— 这样这一串里任何一条带 @/回复的硬触发都能生效；
    // 锚点仍取「最近一条单独判定过得去的」，用于把这次回复归属到具体那个人/那条消息。
    const mergedEvt = Object.assign({}, evtDefaults, lastBot.get(String(batch.gid)) || {}, {
      gid: batch.gid, uid: batch.uid,
      speaker: (batch.evts[batch.evts.length - 1] || {}).speaker || "",
      text: batch.plainText || batch.text,
      atBot: !!batch.atBot, replyToBot: !!batch.replyToBot,
      now: batch.lastAt, mergedCount: batch.count
    });
    const mergedDec = Object.assign({}, await bot.handleEvent(mergedEvt), { evt: mergedEvt });
    const anchor = pickAnchor(decisions);
    if (mergedDec.action === "ignore") {
      stats.ignored += 1;
      observe({ kind: "merged_ignore", gid: batch.gid, uid: batch.uid, mergedCount: batch.count, verdict: mergedDec.verdict, pSay: mergedDec.pSay });
      return { gid: batch.gid, action: "ignore", merged: batch.count, verdict: mergedDec.verdict };
    }
    const dec = mergedDec;
    const evt = (anchor && anchor.evt) || mergedEvt;
    const hard = !!(mergedEvt.atBot || mergedEvt.replyToBot);

    if (!budget.allowReply(hard)) {
      observe({ kind: "budget_block", gid: batch.gid, uid: batch.uid, hard: hard, budget: budget.status() });
      return { gid: batch.gid, action: "budget_block", budget: budget.status() };
    }

    // 观察模式（N9 默认）：只记账，不发送
    if (rc.observe === true) {
      observe({ kind: "observe_only", gid: batch.gid, uid: batch.uid, tier: dec.tier, action: dec.action, mergedCount: batch.count });
      return { gid: batch.gid, action: "observe_only", tier: dec.tier, merged: batch.count };
    }

    let text = "";
    let usage = null;
    if (dec.action === "local_short") {
      text = localReply(dec, { rng: rng });
    } else if (dec.action === "brain") {
      if (!askBrain) return { gid: batch.gid, action: "brain_unavailable" };
      const policy = depthPolicy(dec.tier, { contextWindow: rc.contextWindow });
      const prompt = buildTaskText(dec.tier, policy, dec.keywords)
        + String.fromCharCode(10, 10)
        + "【群里刚刚说的】" + String.fromCharCode(10)
        + batch.evts.map(function (e) { return e.speaker + "：" + e.text; }).join(String.fromCharCode(10));
      stats.brainCalls += 1;
      const r = await askBrain({ promptText: prompt, tier: dec.tier, decision: dec, evt: evt });
      usage = r && r.usage ? r.usage : null;
      if (usage) { const tok = Number(usage.totalTokens) || (Number(usage.inputTokens) + Number(usage.outputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens)); budget.record(tok, at); stats.tokens += tok; }
      if (!r || !r.ok) {
        observe({ kind: "brain_error", gid: batch.gid, uid: batch.uid, error: r ? r.error : "no result", tier: dec.tier });
        return { gid: batch.gid, action: "brain_error", error: r ? r.error : null };
      }
      text = r.text || "";
    } else {
      return { gid: batch.gid, action: "noop" };
    }

    const parsed = parseMeme(text || "");
    const segments = splitReply(parsed.text, dec.maxChars || 60, { maxSegments: rc.maxSegments });
    const sent = [];
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i]) continue;
      send(evt.gid, segments[i]);
      sent.push(segments[i]);
      stats.segments += 1;
      if (i < segments.length - 1 && sendGapMs > 0) await sleep(sendGapMs);
    }
    stats.replies += 1;
    lastBot.set(String(evt.gid), { lastBotText: sent.join(""), lastBotAt: at });
    observe({
      kind: "sent", gid: batch.gid, uid: batch.uid, speaker: evt.speaker, tier: dec.tier,
      mergedCount: batch.count, mood: parsed.mood || null, memePending: parsed.mood || null,
      segments: sent, usage: usage, cacheHitRate: r0(usage)
    });
    return { gid: batch.gid, action: "sent", tier: dec.tier, merged: batch.count, segments: sent, usage: usage, mood: parsed.mood || null };
  }

  function r0(usage) {
    if (!usage) return null;
    const denom = (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
    return denom > 0 ? Math.round(((Number(usage.cacheReadTokens) || 0) / denom) * 1000) / 1000 : 0;
  }

  function status() {
    return {
      mode: rc.observe === true ? "observe" : "live",
      stats: Object.assign({}, stats),
      pending: coalescer.size(),
      budget: budget.status(),
      brakes: brakes.info()
    };
  }

  return {
    onEvent: onEvent, tick: tick, status: status,
    coalescer: coalescer, budget: budget, brakes: brakes,
    observe: observe, stats: function () { return Object.assign({}, stats); }
  };
}
