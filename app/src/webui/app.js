/* DSH-QQ 群小助手 · 配置端前端（零依赖，原生 JS） */
(function () {
  "use strict";

  var COLORS = ["#2f7ff0", "#12a37a", "#d9922b", "#e2564f", "#8b5cf6", "#0aa2c0", "#c9a227", "#7c8ea3"];

  var S = {
    table: null, values: null, runtime: null, defaults: null,
    dirty: false, page: "status",
    gid: null, groups: [], onebot: null, status: null, labels: null, memes: null
  };

  var PAGES = [
    { id: "status", name: "状态", icon: "◎" },
    { id: "persona", name: "人设", icon: "☺", group: "人设" },
    { id: "tune", name: "调整", icon: "⚙" },
    { id: "napcat", name: "接入", icon: "⇄", group: "接入" },
    { id: "profile", name: "群档案", icon: "▤" },
    { id: "labels", name: "标注", icon: "✎" },
    { id: "memes", name: "图库", icon: "▣" }
  ];

  /* 「调整」页：把判定 / 主动与节流 / 运行时三组按逻辑重新分类 */
  var TUNE_CARDS = [
    { name: "开口与深度", desc: "决定「说不说」的开口线，和「说多深」的三档线；权重是六因子公式里的 w1~w4", keys: [
      "gates.utilitySpeakAt", "gates.utilityTerseAt", "gates.utilityDetailedAt", "gates.depthChars", "gates.utilityLambda", "gates.weights"] },
    { name: "灰区与上下文", desc: "灰色地带的下界与上界（自适应），以及每次送进大脑的群消息条数", keys: [
      "gates.greyLo", "gates.greyHi", "runtime.contextWindow"] },
    { name: "开口阶段", desc: "新群先只观察不发言，攒够条数转半自动，再转全自动", keys: [
      "runtime.stageMode", "runtime.observeUntilMessages", "runtime.semiAutoDays"] },
    { name: "节流与合并", desc: "同一个人连着发几条算一轮、回复最多拆几条、主动搭话多频", keys: [
      "runtime.coalesceWindowMs", "runtime.coalesceMaxBatch", "runtime.maxSegments", "autojoin.rate", "autojoin.minGapSec"] },
    { name: "预算与熔断", desc: "每天最多花多少 token；超 80% 关主动，超 100% 只回被点名的", keys: [
      "runtime.budget.dailyTokens", "runtime.budget.groupHourlyLimit"] },
    { name: "搜索", desc: "要不要在认真回答前先搜一次", keys: [
      "runtime.search.mode"] },
    { name: "识图", desc: "收到图片时额外调一次多模态模型，把描述拼进上下文", keys: [
      "runtime.vision.enabled", "runtime.vision.mode", "runtime.vision.endpoint", "runtime.vision.apiKey", "runtime.vision.model"] },
    { name: "语音", desc: "用 Windows 自带 SAPI 把文字念成 wav，走 OneBot 的 record 段发出", keys: [
      "runtime.voice.enabled", "runtime.voice.voice", "runtime.voice.maxChars"] },
    { name: "表情包", desc: "配图频率（详细回答一律不配图）", keys: [
      "persona.memeFreq"] },
    { name: "权限与配置端", desc: "谁能发指令，以及配置端自己跑在哪", keys: [
      "admin.whitelist", "runtime.webui.enabled", "runtime.webui.port", "runtime.napcatWebui"] }
  ];

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function getPath(o, d) {
    var cur = o, parts = String(d).split(".");
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(o, d, v) {
    var parts = String(d).split("."), cur = o;
    for (var i = 0; i < parts.length - 1; i++) { if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = v;
    return o;
  }
  function api(p, body) {
    return fetch(p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
      .then(function (r) { return r.json(); });
  }
  function toast(msg, bad) {
    var el = $("#toast");
    el.textContent = msg;
    el.style.borderLeftColor = bad ? "var(--bad)" : "var(--accent)";
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }
  function markDirty() { S.dirty = true; $("#save-btn").disabled = false; $("#save-btn").textContent = "保存 *"; }
  function hhmmss(t) { var d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2); }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
    return String(n);
  }
  function shortText(t, max) {
    var s = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  /* ---------- 字段渲染 ---------- */
  function fieldByKey(key) {
    var groups = (S.table && S.table.分组) || [];
    for (var i = 0; i < groups.length; i++) for (var j = 0; j < (groups[i].字段 || []).length; j++) {
      if (groups[i].字段[j].键 === key) return groups[i].字段[j];
    }
    return null;
  }

  function fieldRow(f) {
    var key = f.键, type = f.类型, value = getPath(S.values, key);
    var hint = f.说明 ? '<div class="hint">' + esc(f.说明) + '</div>' : '';
    var ctrl = "";
    if (type === "string[]") {
      var arr = Array.isArray(value) ? value : [];
      ctrl = '<div class="chips" data-chips="' + key + '">' + arr.map(function (t) {
        return '<span class="chip">' + esc(t) + '<b data-del="' + key + '" data-val="' + esc(t) + '">×</b></span>';
      }).join("") + '<input type="text" data-add="' + key + '" placeholder="+ 回车添加" style="min-width:130px;width:130px"></div>';
    } else if (type === "enum" || type === "bool") {
      var opts = f.取值 || (type === "bool" ? ["true", "false"] : []);
      var lbl = type === "bool" ? { "true": "开", "false": "关" } : null;
      ctrl = '<div class="seg" data-seg="' + key + '">' + opts.map(function (o) {
        return '<button data-val="' + esc(o) + '" class="' + (String(value) === String(o) ? "on" : "") + '">' + esc(lbl ? lbl[o] : o) + '</button>';
      }).join("") + '</div>';
    } else if (type === "secret") {
      ctrl = '<input type="password" data-key="' + key + '" value="" placeholder="' + (value ? "已配置（留空不改）" : "尚未配置") + '" autocomplete="new-password">';
    } else if (type === "int" || type === "number") {
      var rng = f.范围 || null;
      if (rng) {
        var step = type === "int" ? (rng[1] - rng[0] > 100000 ? 100000 : 1) : (rng[1] - rng[0] <= 2 ? 0.01 : 0.05);
        ctrl = '<input type="range" data-range="' + key + '" min="' + rng[0] + '" max="' + rng[1] + '" step="' + step + '" value="' + value + '">' +
          '<span class="val" data-val-for="' + key + '">' + value + '</span>';
      } else {
        ctrl = '<input type="number" data-key="' + key + '" value="' + value + '">';
      }
    } else if (type === "int[3]" || type === "number[4]") {
      var n = type === "int[3]" ? 3 : 4;
      var vals = Array.isArray(value) ? value.slice() : [];
      while (vals.length < n) vals.push(0);
      var names = type === "int[3]" ? ["短评", "总结", "详细"] : ["w1 p_say", "w2 语义", "w3 连续性", "w4 需求"];
      ctrl = '<div style="display:flex;gap:12px;flex-wrap:wrap">' + vals.map(function (v, i) {
        return '<div style="text-align:center"><input type="range" style="width:96px" data-arr="' + key + '" data-idx="' + i + '" min="0" max="' + (type === "int[3]" ? 400 : 1) +
          '" step="' + (type === "int[3]" ? 5 : 0.05) + '" value="' + v + '"><div style="font-size:11px;color:var(--dim)">' + names[i] + '</div>' +
          '<div class="val" data-arr-for="' + key + '-' + i + '">' + v + '</div></div>';
      }).join("") + '</div>';
    } else if (type === "text") {
      ctrl = '<textarea data-key="' + key + '" rows="4" placeholder="留空 = 用字段自动拼装">' + esc(value == null ? "" : value) + '</textarea>';
    } else {
      ctrl = '<input type="text" data-key="' + key + '" value="' + esc(value == null ? "" : value) + '">';
    }
    return '<div class="field"><div class="label">' + esc(f.标签 || key) + '</div>' + hint + '<div class="ctrl">' + ctrl + '</div></div>';
  }

  function renderGroupFields(groupName) {
    var g = ((S.table && S.table.分组) || []).filter(function (x) { return x.名 === groupName; })[0];
    if (!g) return '<div class="muted">没有这一组</div>';
    return (g.字段 || []).map(fieldRow).join("");
  }

  function renderTune() {
    var used = {};
    var cards = TUNE_CARDS.map(function (c) {
      var rows = "";
      for (var i = 0; i < c.keys.length; i++) {
        var f = fieldByKey(c.keys[i]);
        if (!f) continue;
        used[c.keys[i]] = true;
        rows += fieldRow(f);
      }
      if (!rows) return "";
      return '<details class="card" open><summary>' + esc(c.name) +
        '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">' + c.keys.length + ' 项</span></summary>' +
        '<div class="body"><div class="hint" style="margin:-4px 0 2px">' + esc(c.desc) + '</div>' + rows + '</div></details>';
    }).join("");
    // 三张表里没被分类收进去的，兜底放「其它」
    // 兜底：这三张表里没被分类收进去的，放「其它」。
    // 人设与接入有自己的页面，这里不重复放（只有 persona.memeFreq 被「表情包」卡收走了）。
    var left = "";
    ["判定", "主动与节流", "运行时"].forEach(function (gn) {
      var g = ((S.table && S.table.分组) || []).filter(function (x) { return x.名 === gn; })[0];
      if (!g) return;
      (g.字段 || []).forEach(function (f) { if (!used[f.键]) left += fieldRow(f); });
    });
    if (left) cards += '<details class="card"><summary>其它' + '</summary><div class="body">' + left + '</div></details>';
    return cards;
  }

  /* ---------- 状态页 ---------- */
  function stageText(st) {
    if (!st) return "未知";
    if (st.forced) return st.stage === "observe" ? "强制观察" : "强制实际发送";
    var m = { observe: "观察中", semi: "半自动", full: "全自动" };
    var t = m[st.stage] || st.stage;
    if (st.stage === "observe") t += "（已收 " + (st.observed || 0) + " 条）";
    return t;
  }

  function statusHtml() {
    var st = S.status;
    if (!st) return '<div class="card"><div class="body"><div class="muted">加载中…</div></div></div>';
    var c = st.cost || {}, b = st.budget || {}, ob = S.onebot || {};
    var gs = st.group || {};
    var budgetMax = 20000000;
    var limit = b.limit != null ? b.limit : 5000000;

    // 群选择 + 快捷按钮
    var opts = '<option value="">全部群</option>' + S.groups.map(function (g) {
      var name = g.group_name ? (g.group_name + "（" + g.group_id + "）") : ("群 " + g.group_id);
      return '<option value="' + esc(g.group_id) + '"' + (String(S.gid) === String(g.group_id) ? " selected" : "") + '>' + esc(name) + '</option>';
    }).join("");
    var enabled = S.gid ? (st.brakes && !(st.brakes.groups && st.brakes.groups[String(S.gid)]) && !st.brakes.stopFile && !st.brakes.configPaused) : null;

    var bar = '<div class="card"><div class="head"><span>控制台</span>' +
      '<span class="muted" style="font-size:12px">' + esc(ob.state === "open" ? "OneBot 已连接" : "OneBot " + (ob.state || "未知")) + '</span></div><div class="body">' +
      '<div class="ctl-row">' +
      '<button class="btn-sm" id="btn-refresh">刷新</button>' +
      '<button class="btn-sm good" id="btn-enable"' + (S.gid ? "" : " disabled") + '>启用本群</button>' +
      '<button class="btn-sm bad" id="btn-disable"' + (S.gid ? "" : " disabled") + '>停用本群</button>' +
      '<button class="btn-sm bad" id="btn-global-stop">全局停用</button>' +
      '<button class="btn-sm good" id="btn-global-resume">恢复全局</button>' +
      '<button class="btn-sm" id="btn-napcat">NapCat 配置</button>' +
      '</div>' +
      (S.gid ? '<div class="hint" style="margin-top:8px">本群当前：<b>' + (enabled ? "服务中" : "已停用") + '</b>　开口阶段：<b>' + esc(stageText(st.stage)) + '</b></div>' : '<div class="hint" style="margin-top:8px">当前显示<b>全部群</b>的汇总；选一个群可以单独看它的消息与判定过程</div>') +
      '</div></div>';

    // 成本卡片（预算卡片带调节杆）
    var cost = '<div class="grid">' +
      '<div class="stat"><div class="k">今日用量（token 单位）</div><div class="v">' + fmtTokens(c.units) + '</div>' +
        '<div class="s">预算 ' + fmtTokens(limit) + '　已用 ' + Math.round((b.ratio || 0) * 100) + '%　' + esc(b.mode || "normal") + '</div></div>' +
      '<div class="stat"><div class="k">缓存命中率</div><div class="v">' + (c.cacheHitRate == null ? "—" : Math.round(c.cacheHitRate * 100) + "%") + '</div>' +
        '<div class="s">人设常驻 personaPrefix 吃到的前缀命中</div></div>' +
      '<div class="stat"><div class="k">今日回复</div><div class="v">' + (c.replies || 0) + '</div>' +
        '<div class="s">收 ' + (c.messages || 0) + " 条　搜 " + (c.searches || 0) + " 次　配图 " + (c.memes || 0) + " 张</div></div>" +
      '<div class="stat"><div class="k">平均每条回复</div><div class="v">' + fmtTokens(c.avgUnitsPerReply) + '</div>' +
        '<div class="s">输入 ' + fmtTokens(c.inTokens) + "　输出 " + fmtTokens(c.outTokens) + '</div></div>' +
      '</div>';

    var budgetCard = '<div class="card"><div class="head">日预算调节' +
      '<span class="muted" style="font-size:12px">管理员随手调，立即生效</span></div><div class="body">' +
      '<div class="ctl-row"><input type="range" id="budget-range" min="0" max="' + budgetMax + '" step="100000" value="' + limit + '" style="width:320px">' +
      '<span class="val" id="budget-val" style="min-width:96px">' + fmtTokens(limit) + '</span>' +
      '<button class="btn-sm good" id="btn-budget">应用</button>' +
      '<span class="hint" style="margin:0">超 80% 关主动，超 100% 只回被点名的</span></div>' +
      '</div></div>';

    // 消息 + 判定过程
    var rows = (st.messages || []).map(function (m) {
      var v = m.verdict || "?";
      var cls = v === "yes" ? "yes" : v === "no" ? "no" : "grey";
      var reason = Array.isArray(m.reason) ? m.reason.join("；") : "";
      return '<tr><td style="white-space:nowrap">' + hhmmss(m.at) + '</td>' +
        '<td style="white-space:nowrap">' + esc(m.speaker || m.uid || "") + '</td>' +
        '<td>' + esc(shortText(m.text, 70)) + (m.hasImage ? ' <span class="tag">图×' + (m.images || 1) + '</span>' : '') + '</td>' +
        '<td><span class="tag ' + cls + '">' + esc(v) + '</span></td>' +
        '<td>' + esc(m.action || "-") + '</td>' +
        '<td>' + (m.pSay == null ? "-" : Number(m.pSay).toFixed(2)) + '</td>' +
        '<td>' + esc(m.tier || "-") + '</td>' +
        '<td class="muted" style="max-width:280px">' + esc(shortText(reason, 60)) + '</td></tr>';
    }).join("");
    var msgCard = '<div class="card"><div class="head">收到的消息与判定过程' +
      '<span class="muted" style="font-size:12px">最近 ' + (st.messages || []).length + ' 条（内存缓冲，重启即清）</span></div><div class="body">' +
      '<table><thead><tr><th>时间</th><th>谁</th><th>消息</th><th>判定</th><th>动作</th><th>p_say</th><th>档位</th><th>依据</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" class="muted">还没有收到消息</td></tr>') + '</tbody></table></div></div>';

    var groupCard = S.gid ? ('<div class="card"><div class="head">本群累计（本次运行）</div><div class="body">' +
      '<div class="grid">' +
      '<div class="stat"><div class="k">收到消息</div><div class="v">' + (gs.messages || 0) + '</div><div class="s">含合并</div></div>' +
      '<div class="stat"><div class="k">发出回复</div><div class="v">' + (gs.replies || 0) + '</div><div class="s">进大脑 ' + (gs.brainCalls || 0) + ' 次</div></div>' +
      '<div class="stat"><div class="k">本群用量</div><div class="v">' + fmtTokens(gs.tokens) + '</div><div class="s">搜索 ' + (gs.searches || 0) + '　配图 ' + (gs.memes || 0) + '</div></div>' +
      '<div class="stat"><div class="k">最近活动</div><div class="v" style="font-size:18px">' + (gs.lastAt ? hhmmss(gs.lastAt) : "—") + '</div><div class="s">本群最后一条</div></div>' +
      '</div></div></div>') : "";

    // 分组用量
    var per = (c.perGroup || []).filter(function (x) { return x.units > 0; });
    var perCard = per.length ? ('<div class="card"><div class="head">今日各群用量</div><div class="body"><table><thead><tr><th>群</th><th>用量</th><th>回复</th><th>消息</th></tr></thead><tbody>' +
      per.map(function (x) {
        return '<tr><td>' + esc(x.gid) + '</td><td>' + fmtTokens(x.units) + '</td><td>' + x.replies + '</td><td>' + x.messages + '</td></tr>';
      }).join("") + '</tbody></table></div></div>') : "";

    return bar + cost + budgetCard + groupCard + msgCard + perCard;
  }

  /* ---------- 标注 / 图库 ---------- */
  function pageLabels() {
    return api("/api/labels?limit=60").then(function (d) {
      S.labels = d;
      var st = d.stats || {};
      var rows = (d.pending || []).map(function (r) {
        return '<tr><td style="max-width:340px">' + esc(r.text || "") + '</td>' +
          '<td><span class="tag ' + esc(r.localVerdict) + '">' + esc(r.localVerdict || "") + '</span></td>' +
          '<td>' + esc(r.localAction || "") + '</td>' +
          '<td>' + (r.pSay == null ? "" : Number(r.pSay).toFixed(3)) + '</td>' +
          '<td style="white-space:nowrap"><button class="btn-sm good" data-label="' + esc(r.id) + '" data-human="该回">该回</button> ' +
          '<button class="btn-sm bad" data-label="' + esc(r.id) + '" data-human="不该回">不该回</button></td></tr>';
      }).join("");
      return '<div class="grid">' +
        card("待标注", (d.pending || []).length, "满 30 条自动回流标定") +
        card("已标注", (d.labeled || []).length, "") +
        card("一致率", Math.round((st.agreement || 0) * 100) + "%", "") +
        card("漏接率", Math.round((st.missedRate || 0) * 100) + "%", "该回却被判否") +
        '</div>' +
        '<div class="card"><div class="head">待标注队列</div><div class="body"><table><thead><tr><th>消息</th><th>本地判定</th><th>动作</th><th>p_say</th><th>标注</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="muted">队列是空的 —— 新群观察期会自动攒</td></tr>') + '</tbody></table></div></div>';
    });
  }

  function pageMemes() {
    return api("/api/memes").then(function (d) {
      S.memes = d;
      if (!d.ready) return '<div class="card"><div class="body"><div class="muted">没找到 dsh-meme 图库。</div></div></div>';
      var tags = (d.tags || []).map(function (t) { return '<button class="btn-sm" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; }).join(" ");
      var items = (d.items || []).map(function (it) {
        return '<div class="meme"><img loading="lazy" src="' + it.url + '" alt="' + esc(it.caption) + '"><div class="cap"><b>' + esc(it.tag) + '</b><br>' + esc(it.caption || it.file) + '</div></div>';
      }).join("");
      return '<div class="card"><div class="head">图库<span class="muted" style="font-size:12px">' + esc(d.pack || "") + '</span></div><div class="body">' +
        '<div>' + tags + '</div><div class="gallery">' + items + '</div></div></div>';
    });
  }

  /* 人设页：全局人设（进系统提示词）+ 本群专属人设（只进这个群的消息体） */
  function pagePersona() {
    var head = '<details class="card" open><summary>全局人设' +
      '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">进大脑系统提示词</span></summary><div class="body">' +
      '<div class="hint" style="margin:-2px 0 6px">这一整段会写进大脑 profile 的 <code>personaPrefix</code>（排在所有工具说明之前，吃满前缀缓存）。**留空**则用下面的字段自动拼装。</div>' +
      renderGroupFields("人设") +
      '</div></details>';
    var groupCardHtml = '<details class="card" open><summary>群聊专属人设' +
      '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">只对这个群生效</span></summary><div class="body" id="group-persona-body">' +
      '<div class="muted">加载中…</div></div></details>';
    if (!S.gid) {
      return Promise.resolve(head + '<div class="card"><div class="body"><div class="muted">想写「某个群专属的人设」？先在右上角选一个群。</div>' +
        '<div class="hint" style="margin-top:6px">说明：全局人设走系统提示词（可缓存）；每群专属人设只能走消息体 —— 否则每个群都要一份 profile，一改就打散缓存。</div></div></div>');
    }
    return api("/api/profile?gid=" + encodeURIComponent(S.gid)).then(function (d) {
      var pt = (d.profile && d.profile.personaText) || "";
      return head + '<details class="card" open><summary>群聊专属人设' +
        '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">群 ' + esc(S.gid) + ' 只对这个群生效</span></summary><div class="body">' +
        '<textarea id="persona-group" rows="5" placeholder="在这个群里额外要遵守的（语气/称呼/忌讳），留空则不额外加">' + esc(pt) + '</textarea>' +
        '<div class="ctl-row"><button class="btn-sm good" id="btn-save-group-persona">保存本群人设</button>' +
        '<span class="hint" style="margin:0">保存后立刻生效：它会作为【本群专属人设】拼进这个群每一轮的消息体</span></div>' +
        '</div></details>';
    });
  }

  /* 群档案页：管理员可以直接改提炼结果 */
  function linesOf(v) {
    return String(v || "").split(/[\n,，、;；]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function pageProfile() {
    if (!S.gid) return Promise.resolve('<div class="card"><div class="body"><div class="muted">先在右上角选一个群，才能看它的群档案。</div></div></div>');
    return api("/api/profile?gid=" + encodeURIComponent(S.gid)).then(function (d) {
      var p = d.profile || {};
      if (!d.profile) {
        return '<div class="card"><div class="body"><div class="muted">群 ' + esc(S.gid) + ' 还没有群档案。</div>' +
          '<div class="hint" style="margin-top:6px">群档案由大脑每 20 次回复（refN）自动重炼一次；你也可以直接在这里手写一份。</div>' +
          '<div class="ctl-row" style="margin-top:10px"><button class="btn-sm good" id="btn-create-profile">现在就建一份</button></div></div></div>';
      }
      var meta = '<div class="hint" style="margin:-2px 0 8px">重炼 ' + (p.rounds || 0) + ' 轮　最后更新 ' + esc(p.updatedAt || "—") + '　' + esc(p.updatedBy === "admin" ? "（管理员手改过）" : "（大脑自动提炼）") + '</div>';
      return '<div class="card"><div class="head">群 ' + esc(S.gid) + ' 的群档案' +
        '<span class="muted" style="font-size:12px">保存后立刻生效</span></div><div class="body">' + meta +
        '<div class="field"><div class="label">常聊、容易接话的话题</div><div class="hint">一行一个（也可用逗号/顿号分隔）</div>' +
          '<div class="ctrl"><textarea id="pf-interests" rows="4" style="width:420px">' + esc((p.interests || []).join("\n")) + '</textarea></div></div>' +
        '<div class="field"><div class="label">容易冷场或反感的话题</div><div class="hint">一行一个</div>' +
          '<div class="ctrl"><textarea id="pf-dislikes" rows="3" style="width:420px">' + esc((p.dislikes || []).join("\n")) + '</textarea></div></div>' +
        '<div class="field"><div class="label">说话习惯</div><div class="ctrl"><input type="text" id="pf-habits" value="' + esc(p.habits || "") + '"></div></div>' +
        '<div class="field"><div class="label">其它注意</div><div class="ctrl"><input type="text" id="pf-notes" value="' + esc(p.notes || "") + '"></div></div>' +
        '<div class="field"><div class="label">本群节奏</div><div class="ctrl"><input type="text" id="pf-pace" value="' + esc(p.pace || "") + '"></div></div>' +
        '<div class="field"><div class="label">活跃时段</div><div class="ctrl"><input type="text" id="pf-active" value="' + esc(p.activeHours || "") + '"></div></div>' +
        '<div class="ctl-row"><button class="btn-sm good" id="btn-save-profile">保存群档案</button>' +
        '<button class="btn-sm bad" id="btn-clear-profile">清空（让大脑重新提炼）</button></div>' +
        '</div></div>' +
        '<details class="card"><summary>这一份档案实际拼进 prompt 的样子</summary><div class="body"><pre class="pre">' + esc(d.prompt || "（空）") + '</pre></div></details>';
    });
  }

  function card(k, v, s) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="s">' + esc(s || "") + '</div></div>';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    renderGroupSelect();
    $("#nav").innerHTML = PAGES.map(function (p) {
      return '<a href="#" data-page="' + esc(p.id) + '" class="' + (S.page === p.id ? "active" : "") + '">' +
        '<span style="width:16px;text-align:center;opacity:.85">' + p.icon + '</span>' + esc(p.name) + '</a>';
    }).join("");
    var meta = PAGES.filter(function (p) { return p.id === S.page; })[0] || PAGES[0];
    $("#page-title").textContent = meta.name;
    var job;
    if (S.page === "status") job = api("/api/status" + (S.gid ? "?gid=" + encodeURIComponent(S.gid) : "")).then(function (st) { S.status = st; return statusHtml(); });
    else if (S.page === "tune") job = Promise.resolve(renderTune());
    else if (S.page === "persona") job = pagePersona();
    else if (S.page === "profile") job = pageProfile();
    else if (S.page === "labels") job = pageLabels();
    else if (S.page === "memes") job = pageMemes();
    else job = Promise.resolve(renderGroupFields(meta.group));
    job.then(function (html) { $("#page").innerHTML = html; }).catch(function (e) {
      $("#page").innerHTML = '<div class="card"><div class="body">加载失败：' + esc(e.message) + '</div></div>';
    });
  }

  function badges() {
    var out = [];
    var ob = S.onebot || {};
    var st = S.status || {};
    var stText = { idle: "未连接", connecting: "连接中", open: "已连接", closed: "已断开", reconnecting: "重连中", error: "连接出错", stopped: "已停止", unknown: "未知" };
    var stCls = ob.state === "open" ? "ok" : (ob.state === "error" || ob.state === "closed" ? "bad" : "warn");
    out.push('<span class="pill ' + stCls + '">OneBot ' + esc(stText[ob.state] || ob.state || "未知") + '</span>');
    if (ob.state === "open") {
      out.push('<span class="pill">登录 ' + esc(ob.nickname || "?") + '(' + esc(ob.selfId || "?") + ')</span>');
      out.push('<span class="pill ' + (ob.version ? "ok" : "warn") + '">' + esc(ob.version || "NapCat 版本未知") + '</span>');
      out.push('<span class="pill ' + (ob.online ? "ok" : "warn") + '">' + (ob.online ? "在线" : "离线") + '</span>');
    }
    var modeText = st.mode === "observe" ? "观察模式" : st.mode === "auto" ? "自动分阶段" : st.mode === "live" ? "实际发送" : "—";
    out.push('<span class="pill ' + (st.mode === "live" ? "ok" : "warn") + '">' + modeText + '</span>');
    if (st.budget) out.push('<span class="pill">今日 ' + fmtTokens(st.budget.used) + ' / ' + fmtTokens(st.budget.limit) + '</span>');
    out.push('<span class="pill" id="pill-napcat" style="cursor:pointer" title="打开 NapCat 配置页">NapCat 配置 ↗</span>');
    return out.join("");
  }

  function refreshTop() {
    return Promise.all([
      api("/api/onebot").catch(function () { return {}; }),
      api("/api/status" + (S.gid ? "?gid=" + encodeURIComponent(S.gid) : "")).catch(function () { return {}; })
    ]).then(function (r) {
      S.onebot = r[0] || {};
      if (r[1] && r[1].ok) S.status = r[1];
      renderGroupSelect();
      $("#badges").innerHTML = badges();
      $("#brand-sub").textContent = S.onebot.state === "open" ? ("已连接 · 运行 " + Math.round((S.status.uptimeMs || 0) / 1000) + "s") : ("OneBot " + (S.onebot.state || "未连接"));
      $("#live-dot").classList.toggle("on", S.onebot.state === "open");
    });
  }

  function loadGroups() {
    return api("/api/groups").then(function (d) { S.groups = (d && d.groups) || []; return S.groups; });
  }

  function renderGroupSelect() {
    var sel = $("#group-select");
    if (!sel) return;
    sel.innerHTML = '<option value="">全部群</option>' + S.groups.map(function (g) {
      var name = g.group_name ? (g.group_name + "（" + g.group_id + "）") : ("群 " + g.group_id);
      return '<option value="' + esc(g.group_id) + '"' + (String(S.gid) === String(g.group_id) ? " selected" : "") + '>' + esc(name) + '</option>';
    }).join("");
  }

  function openNapcat() {
    var url = getPath(S.values, "runtime.napcatWebui") || "http://127.0.0.1:6099";
    window.open(url, "_blank");
  }

  function doAction(body, okMsg) {
    return api("/api/action", body).then(function (r) {
      toast(r.ok ? (okMsg || "已执行") : ("失败：" + (r.error || "")), !r.ok);
      return loadGroups().then(refreshTop).then(function () { if (S.page === "status") render(); });
    });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    document.addEventListener("click", function (e) {
      var nav = e.target.closest("[data-page]");
      if (nav) { e.preventDefault(); S.page = nav.getAttribute("data-page"); render(); return; }

      if (e.target.closest("#pill-napcat") || e.target.closest("#btn-napcat")) { openNapcat(); return; }
      if (e.target.closest("#btn-refresh")) { loadGroups().then(refreshTop).then(function () { render(); }); toast("已刷新"); return; }
      if (e.target.closest("#btn-enable")) { if (!S.gid) return toast("先选一个群", true); return doAction({ action: "groupEnable", gid: S.gid }, "本群已启用"); }
      if (e.target.closest("#btn-disable")) { if (!S.gid) return toast("先选一个群", true); return doAction({ action: "groupDisable", gid: S.gid }, "本群已停用"); }
      if (e.target.closest("#btn-global-stop")) return doAction({ action: "globalStop" }, "已全局停用（配置里 paused=true）");
      if (e.target.closest("#btn-global-resume")) return doAction({ action: "globalResume" }, "已恢复");
      if (e.target.closest("#btn-budget")) {
        var rng = $("#budget-range");
        return doAction({ action: "setBudget", value: Number(rng.value) }, "日预算已改为 " + fmtTokens(rng.value));
      }

      if (e.target.closest("#btn-save-profile") || e.target.closest("#btn-create-profile")) {
        if (!S.gid) return toast("先选一个群", true);
        var body = {
          gid: S.gid,
          interests: linesOf($("#pf-interests") ? $("#pf-interests").value : ""),
          dislikes: linesOf($("#pf-dislikes") ? $("#pf-dislikes").value : ""),
          habits: ($("#pf-habits") || {}).value || "",
          notes: ($("#pf-notes") || {}).value || "",
          pace: ($("#pf-pace") || {}).value || "",
          activeHours: ($("#pf-active") || {}).value || ""
        };
        return api("/api/profile", body).then(function (r) {
          toast(r.ok ? "群档案已保存 —— 下一轮生效" : ("失败：" + (r.error || "")), !r.ok);
          render();
        });
      }
      if (e.target.closest("#btn-clear-profile")) {
        if (!S.gid) return toast("先选一个群", true);
        return fetch("/api/profile?gid=" + encodeURIComponent(S.gid), { method: "DELETE" })
          .then(function (r) { return r.json(); })
          .then(function (r) { toast(r.ok ? "已清空，下次重炼会重新长出来" : "清空失败", !r.ok); render(); });
      }
      if (e.target.closest("#btn-save-group-persona")) {
        if (!S.gid) return toast("先选一个群", true);
        var ta = $("#persona-group");
        return api("/api/profile", { gid: S.gid, personaText: ta ? ta.value : "" }).then(function (r) {
          toast(r.ok ? "本群专属人设已保存 —— 立刻生效" : ("失败：" + (r.error || "")), !r.ok);
        });
      }

      var seg = e.target.closest(".seg button");
      if (seg) {
        var box = seg.parentElement, key = box.getAttribute("data-seg");
        setPath(S.values, key, seg.getAttribute("data-val"));
        Array.prototype.forEach.call(box.children, function (b) { b.classList.remove("on"); });
        seg.classList.add("on"); markDirty(); return;
      }
      var del = e.target.closest("[data-del]");
      if (del) {
        var dk = del.getAttribute("data-del"), dv = del.getAttribute("data-val");
        setPath(S.values, dk, (getPath(S.values, dk) || []).filter(function (x) { return x !== dv; }));
        markDirty(); render(); return;
      }
      var lab = e.target.closest("[data-label]");
      if (lab) {
        api("/api/labels", { id: lab.getAttribute("data-label"), human: lab.getAttribute("data-human") }).then(function (r) {
          toast(r.ok ? "已标注" : "标注失败", !r.ok); render();
        });
        return;
      }
      var tg = e.target.closest("[data-tag]");
      if (tg) {
        api("/api/memes?tag=" + encodeURIComponent(tg.getAttribute("data-tag"))).then(function (d) {
          var items = (d.items || []).map(function (it) {
            return '<div class="meme"><img loading="lazy" src="' + it.url + '"><div class="cap"><b>' + esc(it.tag) + '</b><br>' + esc(it.caption || it.file) + '</div></div>';
          }).join("");
          $("#page").querySelector(".gallery").innerHTML = items;
        });
        return;
      }
    });

    document.addEventListener("change", function (e) {
      if (e.target && e.target.id === "group-select") {
        S.gid = e.target.value || null;
        try { localStorage.setItem("dshqq-gid", S.gid || ""); } catch (err) {}
        render();
      }
    });

    document.addEventListener("input", function (e) {
      var t = e.target;
      if (t.id === "budget-range") { $("#budget-val").textContent = fmtTokens(t.value); return; }
      if (t.matches("[data-range]")) {
        var k = t.getAttribute("data-range");
        var v = t.step.indexOf(".") >= 0 ? parseFloat(t.value) : parseInt(t.value, 10);
        setPath(S.values, k, v);
        var out = document.querySelector('[data-val-for="' + k + '"]');
        if (out) out.textContent = v;
        markDirty();
      } else if (t.matches("[data-arr]")) {
        var ak = t.getAttribute("data-arr"), idx = parseInt(t.getAttribute("data-idx"), 10);
        var arr = (getPath(S.values, ak) || []).slice();
        arr[idx] = t.step.indexOf(".") >= 0 ? parseFloat(t.value) : parseInt(t.value, 10);
        setPath(S.values, ak, arr);
        var o2 = document.querySelector('[data-arr-for="' + ak + '-' + idx + '"]');
        if (o2) o2.textContent = arr[idx];
        markDirty();
      } else if (t.matches("[data-key]")) {
        setPath(S.values, t.getAttribute("data-key"), t.value); markDirty();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.matches("[data-add]")) {
        var k = e.target.getAttribute("data-add"), v = e.target.value.trim();
        if (!v) return;
        var arr = (getPath(S.values, k) || []).slice(); arr.push(v); setPath(S.values, k, arr);
        markDirty(); render();
      }
    });

    $("#save-btn").addEventListener("click", function () {
      api("/api/config", { patch: S.values }).then(function (r) {
        if (r.ok) {
          S.values = r.values; S.dirty = false;
          $("#save-btn").disabled = true; $("#save-btn").textContent = "保存";
          toast("已保存 —— 判定/人设类改动即时生效，接入类需重启程序");
        } else { toast("保存失败：" + (r.error || ""), true); }
      });
    });
    $("#theme-btn").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
      try { localStorage.setItem("dshqq-theme", cur === "dark" ? "light" : "dark"); } catch (e) {}
    });
  }

  function boot() {
    try {
      var saved = localStorage.getItem("dshqq-theme");
      document.documentElement.setAttribute("data-theme", saved === "dark" ? "dark" : "light");
      var g = localStorage.getItem("dshqq-gid");
      if (g) S.gid = g;
    } catch (e) {}
    bind();
    api("/api/config").then(function (c) {
      S.table = c.table; S.values = c.values; S.runtime = c.runtime; S.defaults = c.defaults;
      return loadGroups();
    }).then(refreshTop).then(render);
    setInterval(function () {
      refreshTop().then(function () { if (S.page === "status") render(); });
    }, 5000);
    setInterval(loadGroups, 30000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
