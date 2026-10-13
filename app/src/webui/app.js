/* DSH-QQ 群小助手 · 配置端前端（零依赖，原生 JS） */
(function () {
  "use strict";

  var COLORS = ["#4c8dff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#eab308", "#64748b"];
  var S = { table: null, values: null, runtime: null, defaults: null, dirty: false, page: "status" };

  var PAGES = [
    { id: "status", name: "状态", icon: "◎" },
    { id: "group:人设", name: "人设", icon: "☺" },
    { id: "group:判定", name: "判定", icon: "⚖" },
    { id: "group:主动与节流", name: "主动与节流", icon: "◇" },
    { id: "group:运行时", name: "运行时", icon: "⚙" },
    { id: "group:接入", name: "接入", icon: "⇄" },
    { id: "labels", name: "标注", icon: "✎" },
    { id: "memes", name: "图库", icon: "▣" }
  ];

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function getPath(o, d) {
    var cur = o;
    var parts = String(d).split(".");
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(o, d, v) {
    var parts = String(d).split(".");
    var cur = o;
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
    el._t = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }
  function markDirty() {
    S.dirty = true;
    $("#save-btn").disabled = false;
    $("#save-btn").textContent = "保存 *";
  }

  /* ---------- 图表 ---------- */
  function donut(items, size) {
    var s = size || 158;
    var total = items.reduce(function (a, b) { return a + b[1]; }, 0);
    if (!total) return '<div class="muted" style="padding:20px 0">还没有数据 —— 观察期跑起来就有了</div>';
    var r = s / 2 - 14, c = 2 * Math.PI * r, acc = 0;
    var arcs = items.map(function (it, i) {
      var frac = it[1] / total, dash = (frac * c) + " " + (c - frac * c), off = -acc * c;
      acc += frac;
      return '<circle r="' + r + '" cx="' + (s / 2) + '" cy="' + (s / 2) + '" fill="none" stroke="' + COLORS[i % COLORS.length] +
        '" stroke-width="15" stroke-dasharray="' + dash + '" stroke-dashoffset="' + off + '" transform="rotate(-90 ' + (s / 2) + ' ' + (s / 2) + ')"></circle>';
    }).join("");
    var legend = items.map(function (it, i) {
      var pct = Math.round((it[1] / total) * 100);
      return '<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin:2px 0">' +
        '<i style="width:9px;height:9px;border-radius:3px;background:' + COLORS[i % COLORS.length] + ';display:inline-block"></i>' +
        esc(it[0]) + '<span class="muted" style="margin-left:auto">' + it[1] + ' · ' + pct + '%</span></div>';
    }).join("");
    return '<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">' +
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '">' + arcs +
      '<text x="' + (s / 2) + '" y="' + (s / 2 - 2) + '" text-anchor="middle" fill="var(--fg)" font-size="22" font-weight="600">' + total + '</text>' +
      '<text x="' + (s / 2) + '" y="' + (s / 2 + 16) + '" text-anchor="middle" fill="var(--dim)" font-size="11">条判定</text></svg>' +
      '<div style="flex:1;min-width:150px">' + legend + '</div></div>';
  }

  function hourBars(hours) {
    var max = Math.max.apply(null, hours.concat([1]));
    var bars = hours.map(function (v, h) {
      var hh = Math.max(2, Math.round((v / max) * 68));
      return '<div title="' + h + ' 点 · ' + v + ' 条" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px">' +
        '<i style="width:100%;max-width:14px;height:' + hh + 'px;background:linear-gradient(180deg,var(--accent),rgba(76,141,255,.35));border-radius:4px 4px 2px 2px;display:block"></i>' +
        (h % 6 === 0 ? '<span style="font-size:10px;color:var(--dim)">' + h + '</span>' : '<span style="font-size:10px">&nbsp;</span>') + '</div>';
    }).join("");
    return '<div style="display:flex;gap:3px;align-items:flex-end;height:92px">' + bars + '</div>';
  }

  function grayBar(b) {
    if (!b) return '<div class="muted">边界还没读出来</div>';
    var lo = Math.round(b.lo * 100), hi = Math.round(b.hi * 100);
    return '<div class="graybar">' +
      '<div class="band" style="left:' + lo + '%;width:' + Math.max(0, hi - lo) + '%"></div>' +
      '<div class="mk" style="left:' + lo + '%"></div>' +
      '<div class="mk" style="left:' + hi + '%"></div></div>' +
      '<div class="axis"><span>0 判否</span><span>灰区 ' + b.lo.toFixed(2) + ' ~ ' + b.hi.toFixed(2) + '</span><span>1 判是</span></div>' +
      '<div class="muted" style="font-size:12px;margin-top:6px">灰区在 0.30~0.85 之间按漏接率/灰区噪声每 20 次回复挪一步（N14）</div>';
  }

  /* ---------- 字段渲染 ---------- */
  function fieldRow(f, key, type, value) {
    var hint = f.说明 ? '<div class="hint">' + esc(f.说明) + '</div>' : '';
    var ctrl = "";

    if (type === "string[]") {
      var arr = Array.isArray(value) ? value : [];
      ctrl = '<div class="chips" data-chips="' + key + '">' + arr.map(function (t) {
        return '<span class="chip">' + esc(t) + '<b data-del="' + key + '" data-val="' + esc(t) + '">×</b></span>';
      }).join("") + '<input type="text" data-add="' + key + '" placeholder="+ 回车添加" style="min-width:130px;width:130px"></div>';
    } else if (type === "enum" || type === "bool") {
      var opts = f.取值 || (type === "bool" ? ["true", "false"] : []);
      var labels2 = type === "bool" ? { "true": "开", "false": "关" } : null;
      ctrl = '<div class="seg" data-seg="' + key + '">' + opts.map(function (o) {
        return '<button data-val="' + esc(o) + '" class="' + (String(value) === String(o) ? "on" : "") + '">' + esc(labels2 ? labels2[o] : o) + '</button>';
      }).join("") + '</div>';
    } else if (type === "secret") {
      ctrl = '<input type="password" data-key="' + key + '" value="" placeholder="' + (value ? "已配置（留空不改）" : "尚未配置") + '" autocomplete="new-password">';
    } else if (type === "int" || type === "number") {
      var rng = f.范围 || null;
      if (rng) {
        var step = type === "int" ? 1 : (rng[1] - rng[0] <= 2 ? 0.01 : 0.05);
        ctrl = '<input type="range" data-range="' + key + '" min="' + rng[0] + '" max="' + rng[1] + '" step="' + step + '" value="' + value + '">' +
          '<span class="val" data-val-for="' + key + '">' + value + '</span>';
      } else {
        ctrl = '<input type="number" data-key="' + key + '" value="' + value + '">';
      }
    } else if (type === "int[3]" || type === "number[4]") {
      var n = type === "int[3]" ? 3 : 4;
      var vals = Array.isArray(value) ? value.slice() : [];
      while (vals.length < n) vals.push(0);
      var labels = type === "int[3]" ? ["短评", "总结", "详细"] : ["w1 p_say", "w2 语义", "w3 连续性", "w4 需求"];
      ctrl = '<div style="display:flex;gap:12px;flex-wrap:wrap">' + vals.map(function (v, i) {
        return '<div style="text-align:center"><input type="range" style="width:96px" data-arr="' + key + '" data-idx="' + i + '" min="0" max="' + (type === "int[3]" ? 400 : 1) +
          '" step="' + (type === "int[3]" ? 5 : 0.05) + '" value="' + v + '"><div style="font-size:11px;color:var(--dim)">' + labels[i] + '</div>' +
          '<div class="val" data-arr-for="' + key + '-' + i + '">' + v + '</div></div>';
      }).join("") + '</div>';
    } else {
      ctrl = '<input type="text" data-key="' + key + '" value="' + esc(value == null ? "" : value) + '">';
    }
    return '<div class="field"><div class="label">' + esc(f.标签 || key) + '</div>' + hint + '<div class="ctrl">' + ctrl + '</div></div>';
  }

  function renderGroup(groupName) {
    var g = (S.table.分组 || []).filter(function (x) { return x.名 === groupName; })[0];
    if (!g) return '<div class="card"><div class="body"><div class="muted">没有这一组</div></div></div>';
    var rows = (g.字段 || []).map(function (f) {
      var value = getPath(S.values, f.键);
      return fieldRow(f, f.键, f.类型, value);
    }).join("");
    return '<details class="card" open><summary>' + esc(g.名) + '<span class="muted" style="font-weight:400;font-size:12px;margin-left:auto">' + (g.字段 || []).length + ' 项</span></summary>' +
      '<div class="body">' + rows + '</div></details>';
  }

  /* ---------- 各页 ---------- */
  function pageStatus() {
    return api("/api/status").then(function (st) {
      var c = st.chart || {};
      var vs = Object.keys(c.verdicts || {}).map(function (k) { return [k, c.verdicts[k]]; });
      var ts = Object.keys(c.tiers || {}).map(function (k) { return [k, c.tiers[k]]; });
      var budget = st.budget || {};
      var pct = Math.round((budget.ratio || 0) * 100);
      var bs = st.brakes || {};
      return '<div class="grid">' +
        card("已发出回复", c.replies || 0, "判定 " + (c.rows || 0) + " 行") +
        card("缓存命中率", c.cacheHitRate == null ? "—" : Math.round(c.cacheHitRate * 100) + "%", "前缀缓存（人设常驻）") +
        card("配图", c.memes || 0, "主动搭话 " + (c.proactives || 0) + " 次") +
        card("待标注", (st.labels && st.labels.pending) || 0, "已标注 " + ((st.labels && st.labels.labeled) || 0) + " 条") +
        '</div>' +
        '<div class="row">' +
        '<div class="card"><div class="head">判决分布<span class="muted" style="font-size:12px">说不说</span></div><div class="body">' + donut(vs) + '</div></div>' +
        '<div class="card"><div class="head">深度分档<span class="muted" style="font-size:12px">说多深</span></div><div class="body">' + donut(ts) + '</div></div>' +
        '</div>' +
        '<div class="card"><div class="head">24 小时消息量</div><div class="body">' + hourBars(c.hours || new Array(24).fill(0)) + '</div></div>' +
        '<div class="row">' +
        '<div class="card"><div class="head">灰区边界</div><div class="body">' + grayBar(st.gray) + '</div></div>' +
        '<div class="card"><div class="head">今日预算</div><div class="body">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>' + (budget.used || 0) + ' / ' + (budget.limit || 0) + ' token</span><span class="muted">' + (budget.mode || "normal") + '</span></div>' +
        '<div class="progress"><i style="width:' + Math.min(100, pct) + '%"></i></div>' +
        '<div class="muted" style="font-size:12px;margin-top:8px">超 80% 关主动，超 100% 只回被点名的</div></div></div>' +
        '</div>' +
        '<div class="card"><div class="head">刹车状态</div><div class="body">' +
        '<div>STOP 文件：' + (bs.stopFile ? '<span class="tag no">' + esc(bs.stopFile) + '</span>' : '<span class="tag yes">无</span>') + '</div>' +
        '<div>配置暂停：' + (bs.configPaused ? '<span class="tag no">已暂停</span>' : '<span class="tag yes">否</span>') + '</div>' +
        '<div>群内暂停：<code>' + esc(JSON.stringify(bs.groups || {})) + '</code></div>' +
        '</div></div>';
    });
  }

  function card(k, v, s) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div><div class="s">' + esc(s || "") + '</div></div>';
  }

  function pageLabels() {
    return api("/api/labels?limit=60").then(function (d) {
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
      if (!d.ready) return '<div class="card"><div class="body"><div class="muted">没找到 dsh-meme 图库。</div></div></div>';
      var tags = (d.tags || []).map(function (t) { return '<button class="btn-sm" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; }).join(" ");
      var items = (d.items || []).map(function (it) {
        return '<div class="meme"><img loading="lazy" src="' + it.url + '" alt="' + esc(it.caption) + '"><div class="cap"><b>' + esc(it.tag) + '</b><br>' + esc(it.caption || it.file) + '</div></div>';
      }).join("");
      return '<div class="card"><div class="head">图库<span class="muted" style="font-size:12px">' + esc(d.pack || "") + '</span></div><div class="body">' +
        '<div>' + tags + '</div><div class="gallery">' + items + '</div></div></div>';
    });
  }

  function pageGroup(name) {
    return Promise.resolve(renderGroup(name));
  }

  function render() {
    $("#nav").innerHTML = PAGES.map(function (p) {
      return '<a href="#" data-page="' + esc(p.id) + '" class="' + (S.page === p.id ? "active" : "") + '">' +
        '<span style="width:16px;text-align:center;opacity:.85">' + p.icon + '</span>' + esc(p.name) + '</a>';
    }).join("");
    var meta = PAGES.filter(function (p) { return p.id === S.page; })[0] || PAGES[0];
    $("#page-title").textContent = meta.name;
    var job = S.page === "status" ? pageStatus() : S.page === "labels" ? pageLabels() : S.page === "memes" ? pageMemes() : pageGroup(S.page.split(":")[1]);
    job.then(function (html) { $("#page").innerHTML = html; }).catch(function (e) { $("#page").innerHTML = '<div class="card"><div class="body">加载失败：' + esc(e.message) + '</div></div>'; });
  }

  /* ---------- 事件 ---------- */
  function bindEvents() {
    document.addEventListener("click", function (e) {
      var nav = e.target.closest("[data-page]");
      if (nav) { e.preventDefault(); S.page = nav.getAttribute("data-page"); render(); return; }
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
        var arr = (getPath(S.values, dk) || []).filter(function (x) { return x !== dv; });
        setPath(S.values, dk, arr); markDirty(); render(); return;
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

    document.addEventListener("input", function (e) {
      var t = e.target;
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
          toast("已保存 —— 重启小助手后生效（判定/人设类改动即时生效）");
        } else { toast("保存失败：" + (r.error || ""), true); }
      });
    });
    $("#theme-btn").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
      try { localStorage.setItem("dshqq-theme", cur === "dark" ? "light" : "dark"); } catch (e) {}
    });
  }

  function badges(st) {
    var out = [];
    var modeText = st.mode === "observe" ? "观察模式" : st.mode === "auto" ? "自动分阶段" : "实际发送";
    out.push('<span class="pill ' + (st.mode === "live" ? "ok" : "warn") + '">' + modeText + '</span>');
    if (st.budget) out.push('<span class="pill">预算 ' + (st.budget.used || 0) + ' / ' + (st.budget.limit || 0) + '</span>');
    if (st.memes) out.push('<span class="pill">图库 ' + st.memes.rows + ' 张</span>');
    return out.join("");
  }

  function boot() {
    try {
      var saved = localStorage.getItem("dshqq-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) {}
    bindEvents();
    api("/api/config").then(function (c) {
      S.table = c.table; S.values = c.values; S.runtime = c.runtime; S.defaults = c.defaults;
      render();
      return api("/api/status").then(function (st) {
        $("#badges").innerHTML = badges(st);
        $("#brand-sub").textContent = "运行中 · " + Math.round((st.uptimeMs || 0) / 1000) + "s";
        $("#live-dot").classList.add("on");
      });
    });
    setInterval(function () {
      api("/api/status").then(function (st) {
        $("#badges").innerHTML = badges(st);
        $("#brand-sub").textContent = "运行中 · " + Math.round((st.uptimeMs || 0) / 1000) + "s";
        $("#live-dot").classList.add("on");
        if (S.page === "status") render();
      }).catch(function () {
        $("#live-dot").classList.remove("on");
        $("#brand-sub").textContent = "连不上服务";
      });
    }, 5000);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
