import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadFieldTable, defaultsFromTable, deepMerge, redactConfig, runtimeConfig, saveConfig, getPath, setPath } from "./config.js";
import { createLabelQueue, agreementStats, foldLabels, pendingOf, labeledOf } from "./label.js";

// N25 决策：有设计感的配置端 —— 本地 HTTP 服务，只听 127.0.0.1，无登录。
// 前端是零依赖的原生 HTML/CSS/JS（不分发 node_modules 也能跑）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, "webui");
export const DEFAULT_PORT = 8799;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon"
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
function readBody(req, limit) {
  return new Promise(function (resolve) {
    let data = "";
    req.on("data", function (c) { data += c; if (data.length > (limit || 2e6)) req.destroy(); });
    req.on("end", function () { resolve(data); });
    req.on("error", function () { resolve(""); });
  });
}

// 从观察日志里算出图表要的数据
export function summarizeObservations(rows) {
  const verdicts = {}, tiers = {}, actions = {}, hours = new Array(24).fill(0);
  let tokens = 0, cacheRead = 0, cacheInput = 0, brains = 0, replies = 0, memes = 0, proactives = 0;
  for (const r of (rows || [])) {
    if (!r) continue;
    if (r.kind === "decision" || r.kind === "observe_only") {
      if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
      if (r.tier) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
      if (r.action) actions[r.action] = (actions[r.action] || 0) + 1;
      const h = new Date(r.at || Date.now()).getHours();
      hours[h] += 1;
    }
    if (r.kind === "sent") {
      replies += 1;
      if (r.meme) memes += 1;
      const u = r.usage || {};
      tokens += (u.inputTokens || 0) + 2 * (u.outputTokens || 0);
      cacheRead += u.cacheReadTokens || 0;
      cacheInput += (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    }
    if (r.kind === "proactive_sent") proactives += 1;
  }
  return {
    verdicts: verdicts, tiers: tiers, actions: actions, hours: hours,
    tokens: tokens, replies: replies, memes: memes, proactives: proactives,
    cacheHitRate: cacheInput > 0 ? Math.round((cacheRead / cacheInput) * 1000) / 1000 : null,
    rows: (rows || []).length
  };
}

export function createWebUi(deps) {
  const d = deps || {};
  let cfg = d.config || {};
  const table = d.table || loadFieldTable();
  const store = d.store || null;
  const memes = d.memes || null;
  const runtime = d.runtime || null;
  const configFile = d.configFile;
  const labels = d.labels || (store ? createLabelQueue({ store: store }) : null);
  const startedAt = Date.now();

  function currentConfig() { return cfg; }

  function statusPayload() {
    const rt = runtime ? runtime.status() : null;
    const obs = store ? store.readJsonl(store.paths.observe) : [];
    return {
      ok: true,
      uptimeMs: Date.now() - startedAt,
      mode: rt ? rt.mode : null,
      stats: rt ? rt.stats : null,
      pending: rt ? rt.pending : null,
      budget: rt ? rt.budget : { mode: "normal", used: 0, limit: 0, ratio: 0 },
      brakes: rt ? rt.brakes : null,
      labels: labels ? labels.status() : null,
      memes: memes && memes.ready ? { rows: memes.rows.length, tags: memes.tags().length, pack: path.basename(memes.packDir || "") } : null,
      chart: summarizeObservations(obs.slice(-2000)),
      gray: runtime && runtime.bot && runtime.bot.getBounds ? runtime.bot.getBounds() : null
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, table: table, values: redactConfig(cfg, table), runtime: runtimeConfig(cfg), defaults: defaultsFromTable(table) });
    }
    if (p === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      let patch = null;
      try { patch = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      const next = deepMerge(cfg, (patch && patch.patch) || patch || {});
      cfg = next;
      if (configFile) { try { saveConfig(cfg, configFile); } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); } }
      return sendJson(res, 200, { ok: true, values: redactConfig(cfg, table), runtime: runtimeConfig(cfg) });
    }
    if (p === "/api/status") return sendJson(res, 200, statusPayload());
    if (p === "/api/labels" && req.method === "GET") {
      if (!labels) return sendJson(res, 200, { ok: true, pending: [], stats: agreementStats([]) });
      const limit = Number(url.searchParams.get("limit")) || 100;
      const all = labels.rows();
      return sendJson(res, 200, {
        ok: true, pending: pendingOf(all).slice(-limit).reverse(),
        labeled: labeledOf(all).slice(-limit).reverse(),
        stats: agreementStats(all)
      });
    }
    if (p === "/api/labels" && req.method === "POST") {
      const body = await readBody(req);
      let b = null;
      try { b = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败" }); }
      if (!labels || !b || !b.id) return sendJson(res, 400, { ok: false, error: "缺少 id" });
      labels.label(b.id, b.human, b.labeler);
      return sendJson(res, 200, { ok: true, stats: labels.status() });
    }
    if (p === "/api/observe") {
      if (!store) return sendJson(res, 200, { ok: true, rows: [] });
      const limit = Number(url.searchParams.get("limit")) || 100;
      return sendJson(res, 200, { ok: true, rows: store.readJsonl(store.paths.observe).slice(-limit).reverse() });
    }
    if (p === "/api/memes") {
      if (!memes || !memes.ready) return sendJson(res, 200, { ok: true, ready: false, items: [] });
      const tag = url.searchParams.get("tag");
      const rows = (tag ? memes.byTag(tag) : memes.rows).slice(0, 60);
      return sendJson(res, 200, {
        ok: true, ready: true, pack: memes.packDir, tags: memes.tags(),
        items: rows.map(function (r) { return { tag: r.tag, file: r.file_name, caption: r.caption, keywords: r.keywords, url: "/meme/" + encodeURIComponent(r.tag) + "/" + encodeURIComponent(r.file_name) }; })
      });
    }
    // 图库图片直出（只允许包内文件，防目录穿越）
    if (p.startsWith("/meme/")) {
      if (!memes || !memes.ready) return sendText(res, 404, "no meme library");
      const parts = decodeURIComponent(p.slice("/meme/".length)).split("/");
      if (parts.length !== 2) return sendText(res, 400, "bad path");
      const row = memes.rows.filter(function (r) { return r.tag === parts[0] && r.file_name === parts[1]; })[0];
      if (!row) return sendText(res, 404, "not found");
      const rootAbs = path.resolve(memes.packDir);
      const fileAbs = path.resolve(row.path);
      if (!fileAbs.startsWith(rootAbs)) return sendText(res, 403, "forbidden");
      try {
        const buf = fs.readFileSync(fileAbs);
        res.writeHead(200, { "Content-Type": MIME[path.extname(fileAbs).toLowerCase()] || "application/octet-stream", "Cache-Control": "max-age=60" });
        return res.end(buf);
      } catch (e) { return sendText(res, 404, "read failed"); }
    }
    if (p === "/api/health") return sendJson(res, 200, { ok: true });

    // 静态文件
    let rel = p === "/" ? "/index.html" : p;
    const abs = path.resolve(PUBLIC_DIR, "." + rel);
    if (!abs.startsWith(path.resolve(PUBLIC_DIR))) return sendText(res, 403, "forbidden");
    try {
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      return res.end(buf);
    } catch (e) { return sendText(res, 404, "not found: " + rel); }
  }

  const server = http.createServer(function (req, res) {
    handle(req, res).catch(function (e) { try { sendJson(res, 500, { ok: false, error: String(e && e.message) }); } catch (err) {} });
  });

  return {
    server: server,
    listen: function (port, host) {
      return new Promise(function (resolve) {
        // 注意用 == null 判断：port=0 表示让系统随便挑一个空闲端口
        server.listen(port == null ? DEFAULT_PORT : port, host || "127.0.0.1", function () { resolve({ port: server.address().port, url: "http://127.0.0.1:" + server.address().port }); });
      });
    },
    close: function () { return new Promise(function (r) { server.close(function () { r(true); }); }); },
    getConfig: currentConfig,
    setConfig: function (c) { cfg = c; return cfg; },
    status: statusPayload
  };
}
