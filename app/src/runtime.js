import { createCoalescer, pickAnchor } from "./coalesce.js";
import { splitReply } from "./split.js";
import { createBudget } from "./budget.js";
import { createBrakes } from "./brakes.js";
import { createDefaultCommands } from "./commands.js";
import { createMemeLibrary, shouldAttachMeme } from "./meme.js";
import { localReply } from "./localreply.js";
import { depthPolicy, buildTaskText } from "./brain.js";
import { parseMeme } from "./audit.js";
import { injectSummary } from "./search.js";
import { createTracker } from "./feedback.js";
import { createLabelQueue } from "./label.js";

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
  const searchSvc = d.search || null;
  const memes = d.memes || createMemeLibrary({});
  const sendImage = d.sendImage || null;
  const repliesSinceMeme = new Map();      // gid -> 距上次配图过了几次回复（「少」档要拉开间隔）
  const now = d.now || function () { return Date.now(); };
  const rng = d.rng || Math.random;
  const log = d.log || function () {};
  const sleep = d.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const sendGapMs = d.sendGapMs != null ? d.sendGapMs : 400;

  const evtDefaults = d.evtDefaults || {};      // botNames / nicknames / interests 等，来自人设配置
  const lastBot = new Map();                    // gid -> { lastBotText, lastBotAt }，供「连续性」特征用
  // N8（修订）：成员表初始为空，首次收到该成员消息时再加 —— 不再启动时全量拉群成员
  const members = new Map();                    // gid -> Map(uid -> { speaker, role, firstSeen, lastSeen, count })
  // N8（修订）：上下文窗口放在 prompt 最后，前面只放本轮任务与资料，避免前置变量打散缓存
  const history = new Map();                    // gid -> [{ speaker, text, at }]  最多 contextWindow 条
  // N9（修订）：观察只在新群初期，攒满 observeUntilMessages 条后进半自动，semiAutoDays 天后全自动
  const stages = new Map();                     // gid -> { stage, observed, semiUntil, since }
  // P3：反馈归因（按被回复人是否继续跟我聊）+ 人工标注队列
  const tracker = d.tracker || createTracker({ windowMs: rc.feedbackWindowMs != null ? rc.feedbackWindowMs : 90000 });
  const labels = d.labels || (store ? createLabelQueue({ store: store, minSamples: rc.labelMinSamples || 30 }) : null);
  const coalescer = createCoalescer({ windowMs: rc.coalesceWindowMs, maxBatch: rc.coalesceMaxBatch });
  const budget = d.budget || createBudget({ limits: rc.budget, now: now });
  const brakes = d.brakes || createBrakes({ config: cfg, now: now });
  // 指令注册表要拿到真的 brakes / budget，所以必须在这两行之后建
  const commands = d.commands || createDefaultCommands({ brakes: brakes, budget: budget, now: now, stopMinutes: rc.stopMinutes || 60 });

  const stats = { events: 0, ignored: 0, observed: 0, replies: 0, segments: 0, brainCalls: 0, tokens: 0, searchTokens: 0, searches: 0, searchCacheHits: 0, stopped: 0, adminCmds: 0, feedbackResolved: 0, refits: 0, labelCandidates: 0, memesSent: 0, memesMissed: 0, memesSuppressed: 0, proactiveTried: 0, proactiveSpoken: 0, proactiveBlocked: 0 };
  let busy = false;

  function observe(rec) {
    stats.observed += 1;
    if (store && store.addObservation) { try { store.addObservation(rec); } catch (e) {} }
  }

  function adminConfig() { return cfg.admin || {}; }

  function settle(records, atMs) {
    const list = records || [];
    for (const rec of list) {
      stats.feedbackResolved += 1;
      let r = null;
      try { r = bot.observe(rec); } catch (e) { r = null; }
      if (r && r.refit) {
        stats.refits += 1;
        let reflow = null;
        if (labels) {
          const cur = bot.getBounds ? bot.getBounds() : null;
          reflow = labels.reflowIfReady(cur, atMs);
          if (reflow.ready && reflow.changed && bot.setBounds) bot.setBounds(reflow.bounds);
        }
        observe({
          kind: "refit", gid: rec.gid,
          bounds: bot.getBounds ? bot.getBounds() : null,
          rounds: r.profile && r.profile.rounds, flipRate: r.flipRate, missedRate: r.missedRate,
          reflow: reflow ? { ready: !!reflow.ready, n: reflow.n, changed: !!reflow.changed } : null
        });
      }
    }
    return list.length;
  }

  // N15：情绪标记 → 去 dsh-meme 图库取图，按「关/少/中」与档位节制
  async function attachMeme(gid, mood, tier) {
    const key = String(gid);
    const since = repliesSinceMeme.get(key);
    const gate = shouldAttachMeme(tier, mood, {
      freq: rc.memeFreq || "少",
      sinceLastMeme: since == null ? 999 : since,
      replyGapReplies: rc.memeGapReplies != null ? rc.memeGapReplies : 3
    });
    function bump() { const n = repliesSinceMeme.get(key); repliesSinceMeme.set(key, n == null ? 1 : n + 1); }
    bump();
    if (!mood) return null;
    if (!gate.attach) { stats.memesSuppressed += 1; observe({ kind: "meme_suppressed", gid: key, mood: mood, reason: gate.reason }); return null; }
    if (!memes || !memes.ready || !sendImage) { stats.memesMissed += 1; return null; }
    const hit = memes.find(mood);
    if (!hit) { stats.memesMissed += 1; observe({ kind: "meme_miss", gid: key, mood: mood }); return null; }
    sendImage(key, hit.path);
    stats.memesSent += 1;
    repliesSinceMeme.set(key, 0);
    return { tag: hit.tag, file: hit.file, score: hit.score, mood: mood, reason: gate.reason };
  }

  function groupInterests(gid) {
    if (!store || typeof store.loadProfile !== "function") return [];
    const p = store.loadProfile(gid);
    return (p && p.interests) || [];
  }

  // N16：没被点名、但话题撞上兴趣时，在全自动阶段插一句短的。
  // 注意：本地 low 档是「不进大脑」的短句池，但主动搭话没有可回应的对象，短句池说不出内容，
  // 所以这里仍然走一次大脑，只是把档位策略设成 low（≤20 字）。这条偏差记在 设计节点.md §17。
  async function tryProactive(evtLike, batch, atMs) {
    if (rc.proactive && rc.proactive.enabled === false) return null;
    if (stageOf(batch.gid, atMs).stage !== STAGE_FULL) return null;
    if (!budget.allowProactive()) { stats.proactiveBlocked += 1; return null; }
    if (!askBrain || !bot.considerProactive) return null;
    const interests = groupInterests(batch.gid).concat(evtDefaults.interests || []);
    const p = bot.considerProactive(evtLike, { action: "ignore" }, { interests: interests });
    if (!p || !p.speak) return null;
    stats.proactiveTried += 1;
    const NL = String.fromCharCode(10);
    const policy = depthPolicy("low", { contextWindow: rc.contextWindow });
    const ctx = contextBlock(batch.gid);
    const prompt = "【本轮任务】" + NL
      + "场景：没人在叫你，但话题撞上了你感兴趣的东西（" + (p.reason || "") + "）。" + NL
      + "字数上限：" + (p.maxChars || 20) + NL
      + "直接输出你要插进群里的那一句短话，不要解释，不要问号收尾。" + NL + NL + ctx;
    const r = await askBrain({ promptText: prompt, tier: "low", proactive: true, evt: evtLike });
    if (!r || !r.ok || !r.text) { observe({ kind: "proactive_error", gid: batch.gid, error: r ? r.error : null }); return null; }
    const clean = parseMeme(r.text).text;
    const segs = splitReply(clean, p.maxChars || 20, { maxSegments: 1 }).filter(Boolean);
    if (!segs.length) return null;
    for (const s of segs) send(batch.gid, s);
    stats.proactiveSpoken += 1;
    stats.replies += 1;
    observe({ kind: "proactive_sent", gid: batch.gid, reason: p.reason, keywords: p.keywords, text: segs.join("") });
    return { segments: segs, reason: p.reason };
  }

  // N8：群档案排在「本轮任务」之后、上下文之前 —— 它每 refN 次才变一次
  function profileBlock(gid) {
    if (!store || typeof store.loadProfile !== "function" || !bot.profilePrompt) return "";
    const prof = store.loadProfile(gid);
    if (!prof || !(prof.rounds > 0)) return "";
    return bot.profilePrompt(gid);
  }

  const STAGE_OBSERVE = "observe", STAGE_SEMI = "semi", STAGE_FULL = "full";
  const OBSERVE_UNTIL_MESSAGES = rc.observeUntilMessages != null ? rc.observeUntilMessages : 80;   // N9
  const SEMI_AUTO_DAYS = rc.semiAutoDays != null ? rc.semiAutoDays : 3;                            // N9

  function stageOf(gid, nowMs) {
    if (rc.observe === true) return { stage: STAGE_OBSERVE, observed: 0, forced: true };   // 强制观察
    if (rc.observe === false) return { stage: STAGE_FULL, observed: 0, forced: true };     // 强制实际发送
    if (rc.stageMode === "live") return { stage: STAGE_FULL, observed: 0, forced: true };
    if (rc.stageMode === "observe") return { stage: STAGE_OBSERVE, observed: 0, forced: true };
    const key = String(gid);
    let s = stages.get(key);
    if (!s) { s = { stage: STAGE_OBSERVE, observed: 0, semiUntil: null, since: nowMs }; stages.set(key, s); }
    if (s.stage === STAGE_OBSERVE && s.observed >= OBSERVE_UNTIL_MESSAGES) { s.stage = STAGE_SEMI; s.semiUntil = nowMs + SEMI_AUTO_DAYS * 86400000; s.advancedAt = nowMs; }
    if (s.stage === STAGE_SEMI && s.semiUntil && nowMs >= s.semiUntil) { s.stage = STAGE_FULL; s.advancedAt = nowMs; }
    return s;
  }

  function rememberMembers(batch) {
    const key = String(batch.gid);
    let m = members.get(key);
    if (!m) { m = new Map(); members.set(key, m); }
    for (const e of batch.evts) {
      const cur = m.get(String(e.uid));
      if (!cur) m.set(String(e.uid), { speaker: e.speaker, role: e.role || "", firstSeen: e.now, lastSeen: e.now, count: 1 });
      else { cur.speaker = e.speaker || cur.speaker; cur.role = e.role || cur.role; cur.lastSeen = e.now; cur.count += 1; }
    }
    return m;
  }

  function pushHistory(batch) {
    const key = String(batch.gid);
    const arr = history.get(key) || [];
    for (const e of batch.evts) arr.push({ speaker: e.speaker, text: e.text, at: e.now });
    const cap = Math.max(0, rc.contextWindow != null ? rc.contextWindow : 10);
    while (cap && arr.length > cap) arr.shift();
    history.set(key, arr);
    return arr;
  }

  // 上下文块 —— 按 N8 修订，它永远排在 prompt 的最后
  function contextBlock(gid) {
    const arr = history.get(String(gid)) || [];
    if (!arr.length) return "";
    return "【群里的上下文（越靠下越新）】" + String.fromCharCode(10)
      + arr.map(function (e) { return (e.speaker ? e.speaker + "：" : "") + e.text; }).join(String.fromCharCode(10));
  }

  async function onEvent(evt) {
    stats.events += 1;
    // P3：这条消息同时是「上一条回复」的判决书 —— 先结算
    settle(tracker.resolve(evt), evt.now);
    const st = brakes.state(evt.gid, evt.now);
    if (st.stopped) {
      // 「群内指令暂停」必须能被指令解开，否则一停就再也开不回来。
      // STOP 文件与配置暂停仍然是最高优先，什么指令都进不来。
      const parsed = commands.parse(evt.text);
      const spec = parsed ? commands.find(parsed.name) : null;
      const canUnstick = st.reason === "群内指令暂停" && !!spec;
      if (!canUnstick) {
        stats.stopped += 1;
        observe({ kind: "stopped", gid: evt.gid, reason: st.reason });
        return { action: "stopped", reason: st.reason };
      }
    }

    // N17：指令走注册表 —— 权限判定与二次确认都在 commands.js 里
    const cRes = commands.dispatch(evt, { config: adminConfig(), budget: budget, brakes: brakes, store: store });
    if (cRes.handled) {
      stats.adminCmds += 1;
      if (cRes.reply) send(evt.gid, cRes.reply);
      observe({ kind: "command", gid: evt.gid, uid: evt.uid, name: cRes.name, ok: !!cRes.ok, action: cRes.action });
      return { action: cRes.action, ok: !!cRes.ok, name: cRes.name, minutes: cRes.minutes, budget: cRes.budget, needsConfirm: !!cRes.needsConfirm };
    }

    coalescer.push(evt);
    return { action: "pending", pending: coalescer.size() };
  }

  async function tick(t) {
    const at = t == null ? now() : t;
    if (busy) return { skipped: "busy" };
    settle(tracker.sweep(at), at);          // 窗口内没人接 → no_one_replied
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
    // learn:false —— 逐条判定时已经学过一遍，合并判定不能再学（修 IDF 学两次）
    const mergedDec = Object.assign({}, await bot.handleEvent(mergedEvt, { learn: false }), { evt: mergedEvt });
    const anchor = pickAnchor(decisions);
    const dec = mergedDec;
    const evt = (anchor && anchor.evt) || mergedEvt;
    const hard = !!(mergedEvt.atBot || mergedEvt.replyToBot);
    // N8 修订：成员表与上下文窗口在这里更新（成员表初始为空，首见即加）
    rememberMembers(batch);
    pushHistory(batch);                     // N8：无论观察还是发送，窗口都要推进
    const stageState = stageOf(batch.gid, at);
    stageState.observed += batch.count;
    // N21：观察期把所有判定（**含判否的**）都记成待标注样本。
    // 只记判「要回」的样本是拿不到漏接率的 —— 漏接恰恰藏在判否那些里。
    if (stageState.stage === STAGE_OBSERVE && labels) {
      labels.recordCandidate({
        kind: "review", gid: batch.gid, uid: batch.uid, speaker: evt.speaker, text: evt.text,
        messageId: evt.messageId, localVerdict: dec.verdict, localAction: dec.action,
        priority: dec.action === "ignore" ? "low" : "high",
        pSay: dec.pSay, U: dec.U, tier: dec.tier, bucket: dec.bucket, reason: dec.reason
      });
      stats.labelCandidates += 1;
    }
    if (dec.action === "ignore") {
      stats.ignored += 1;
      observe({ kind: "merged_ignore", gid: batch.gid, uid: batch.uid, mergedCount: batch.count, verdict: dec.verdict, pSay: dec.pSay });
      const pro = await tryProactive(mergedEvt, batch, at);
      return { gid: batch.gid, action: "ignore", merged: batch.count, verdict: dec.verdict, proactive: pro };
    }

    if (!budget.allowReply(hard)) {
      observe({ kind: "budget_block", gid: batch.gid, uid: batch.uid, hard: hard, budget: budget.status() });
      return { gid: batch.gid, action: "budget_block", budget: budget.status() };
    }

    // N9 修订：观察只在新群初期（攒满 OBSERVE_UNTIL_MESSAGES 条），之后半自动、再全自动
    if (stageState.stage === STAGE_OBSERVE) {
      observe({ kind: "observe_only", gid: batch.gid, uid: batch.uid, tier: dec.tier, action: dec.action, mergedCount: batch.count, observed: stageState.observed, until: OBSERVE_UNTIL_MESSAGES });
      return { gid: batch.gid, action: "observe_only", stage: STAGE_OBSERVE, observed: stageState.observed, until: OBSERVE_UNTIL_MESSAGES, tier: dec.tier, merged: batch.count };
    }
    if (stageState.stage === STAGE_SEMI && !hard) {
      observe({ kind: "semi_skip", gid: batch.gid, uid: batch.uid, tier: dec.tier, action: dec.action, mergedCount: batch.count, stage: STAGE_SEMI });
      return { gid: batch.gid, action: "semi_skip", stage: STAGE_SEMI, merged: batch.count };
    }

    let text = "";
    let usage = null;
    let searchInfo = null;
    if (dec.action === "local_short") {
      text = localReply(dec, { rng: rng });
    } else if (dec.action === "brain") {
      if (!askBrain) return { gid: batch.gid, action: "brain_unavailable" };
      const policy = depthPolicy(dec.tier, { contextWindow: rc.contextWindow });
      let taskText = buildTaskText(dec.tier, policy, dec.keywords);
      // N12：需要搜索时先搜一次，把摘要作为消息体注入（不进系统提示词，前缀缓存不受影响）
      if (dec.search > 0 && searchSvc) {
        const sr = await searchSvc.run({ gid: evt.gid, keywords: dec.keywords || [], mode: rc.searchMode, ctx: { evt: evt, decision: dec } });
        searchInfo = { ok: !!sr.ok, backend: sr.backend || null, cached: !!sr.cached, ms: sr.ms || 0, error: sr.error || null, chars: (sr.summary || "").length };
        if (sr.ok && sr.summary) taskText = injectSummary(taskText, sr.summary);
        if (sr.usage) { const st2 = Number(sr.usage.totalTokens) || 0; budget.record(st2, at); stats.tokens += st2; stats.searchTokens += st2; }
        stats.searches += 1;
        if (sr.cached) stats.searchCacheHits += 1;
      }
      // N8 修订：主体顺序 = 本轮任务 → 搜到的资料 → 上下文窗口（最后）。
      // 前面只放「本轮任务」这种小而易变的东西，人设仍在 system prompt，缓存前缀不受影响。
      const blocks = [taskText];
      const pb = profileBlock(evt.gid);
      if (pb) blocks.push(pb);
      const ctxBlock = contextBlock(evt.gid);
      if (ctxBlock) blocks.push(ctxBlock);
      const prompt = blocks.filter(Boolean).join(String.fromCharCode(10, 10));
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
    const memeInfo = await attachMeme(evt.gid, parsed.mood, dec.tier);
    stats.replies += 1;
    if (bot.proactive && bot.proactive.markBotReply) bot.proactive.markBotReply(at, evt.gid);
    lastBot.set(String(evt.gid), { lastBotText: sent.join(""), lastBotAt: at });
    // P3：登记一条待定反馈，等这个群的下一条消息来判它是正还是负
    tracker.noteReply({
      gid: evt.gid, uid: evt.uid, arm: dec.arm, bucket: dec.bucket, tokens: dec.keywords || [],
      at: at, tier: dec.tier, segments: sent.length, botNames: (evtDefaults.botNames || []).slice(),
      inTokens: usage ? Number(usage.inputTokens) || 0 : 0, outTokens: usage ? Number(usage.outputTokens) || 0 : 0
    });
    observe({
      kind: "sent", gid: batch.gid, uid: batch.uid, speaker: evt.speaker, tier: dec.tier,
      mergedCount: batch.count, mood: parsed.mood || null, memePending: parsed.mood || null,
      segments: sent, usage: usage, cacheHitRate: r0(usage), search: searchInfo, meme: memeInfo
    });
    return { gid: batch.gid, action: "sent", tier: dec.tier, merged: batch.count, segments: sent, usage: usage, mood: parsed.mood || null, search: searchInfo, meme: memeInfo };
  }

  function r0(usage) {
    if (!usage) return null;
    const denom = (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
    return denom > 0 ? Math.round(((Number(usage.cacheReadTokens) || 0) / denom) * 1000) / 1000 : 0;
  }

  function status() {
    return {
      mode: rc.observe === true ? "observe" : rc.observe === false ? "live" : (rc.stageMode || "auto"),
      stats: Object.assign({}, stats),
      pending: coalescer.size(),
      budget: budget.status(),
      brakes: brakes.info()
    };
  }

  return {
    onEvent: onEvent, tick: tick, status: status,
    coalescer: coalescer, budget: budget, brakes: brakes,
    members: function (gid) { const m = members.get(String(gid)); return m ? Object.fromEntries(m) : {}; },
    history: function (gid) { return (history.get(String(gid)) || []).slice(); },
    stage: function (gid) { return Object.assign({}, stageOf(gid, now())); },
    tracker: tracker, labels: labels,
    pendingFeedback: function () { return tracker.pendingCount(); },
    labelStatus: function () { return labels ? labels.status() : null; },
    observe: observe, stats: function () { return Object.assign({}, stats); }
  };
}
