import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// N18 决策：语音走 TTS → NapCat 发 QQ 语音。
// TTS 用 Windows 自带的 SAPI（System.Speech），**零依赖、离线、不发任何东西出去**。
// 实测可用音色：Microsoft Huihui / Kangkang / Yaoyao（zh-CN）。
export const TTS_DEFAULTS = {
  enabled: false,
  voice: "Microsoft Huihui",
  rate: 0,                 // -10 ~ 10
  maxChars: 60,            // 太长就别念了
  timeoutMs: 20000
};

export function psQuote(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'"; }

// 生成一段 PowerShell 脚本：把文本念成一个 wav 文件
export function buildSapiScript(text, outFile, cfg) {
  const c = Object.assign({}, TTS_DEFAULTS, cfg || {});
  return [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    c.voice ? ("try { $s.SelectVoice(" + psQuote(c.voice) + ") } catch { }") : "",
    "$s.Rate = " + (Number(c.rate) || 0),
    "$s.SetOutputToWaveFile(" + psQuote(outFile) + ")",
    "$s.Speak(" + psQuote(text) + ")",
    "$s.Dispose()"
  ].filter(Boolean).join("; ");
}

export function createTts(opts) {
  const o = opts || {};
  const cfg = Object.assign({}, TTS_DEFAULTS, o.config || {});
  const outDir = o.outDir || null;
  const run = o.run || function (script, timeoutMs) {
    return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  };
  const stats = { calls: 0, ok: 0, fail: 0, lastError: null, lastBytes: 0 };

  function enabled() { return !!cfg.enabled; }

  function synthesize(text, opts2) {
    const t = String(text == null ? "" : text).trim();
    if (!enabled()) { stats.fail += 1; stats.lastError = "语音未启用"; return { ok: false, error: "语音未启用" }; }
    if (!t) return { ok: false, error: "没有文字" };
    if (t.length > cfg.maxChars) return { ok: false, error: "文字太长（" + t.length + " > " + cfg.maxChars + "）" };
    const dir = (opts2 && opts2.outDir) || outDir;
    if (!dir) return { ok: false, error: "没有配置输出目录" };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "voice-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".wav");
    stats.calls += 1;
    const script = buildSapiScript(t, file, cfg);
    let r = null;
    try { r = run(script, cfg.timeoutMs || TTS_DEFAULTS.timeoutMs); }
    catch (e) { stats.fail += 1; stats.lastError = String(e && e.message); return { ok: false, error: stats.lastError }; }
    const ok = !!(r && r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000);
    if (!ok) {
      stats.fail += 1;
      stats.lastError = String((r && (r.stderr || r.stdout)) || "TTS 失败").slice(0, 160);
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
      return { ok: false, error: stats.lastError, status: r && r.status };
    }
    const bytes = fs.statSync(file).size;
    stats.ok += 1; stats.lastBytes = bytes;
    return { ok: true, file: file, bytes: bytes, chars: t.length };
  }

  return { config: cfg, enabled: enabled, synthesize: synthesize, stats: function () { return Object.assign({}, stats); } };
}

// 从大脑输出里摘出 [语音: 文本] 标记
export function parseVoiceTag(text) {
  const s = String(text || "");
  const OPEN = "[语音:";
  const i = s.indexOf(OPEN);
  if (i < 0) return { text: s.trim(), voice: null };
  const j = s.indexOf("]", i);
  if (j < 0) return { text: s.trim(), voice: null };
  const spoken = s.slice(i + OPEN.length, j).trim();
  const body = (s.slice(0, i) + s.slice(j + 1)).trim();
  return { text: body, voice: spoken || null };
}
