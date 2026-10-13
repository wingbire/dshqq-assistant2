export const AUDIT_MODEL = "external-audit-model";

export function auditStub(text, ctx) {
  const t = String(text || "");
  const botNames = ((ctx && ctx.botNames) || []).concat((ctx && ctx.nicknames) || []);
  let hitBot = false;
  for (const n of botNames) if (n && t.includes(n)) hitBot = true;
  const toOther = /他说|她说|群里有人/.test(t) || /问你呢/.test(t);
  const askMe = /你能|你会|帮我|教教我/.test(t) || t.includes("你");
  let verdict = "unsure";
  if (hitBot || (/你/.test(t) && askMe && !toOther)) verdict = "yes";
  else if (toOther) verdict = "no";
  return {
    verdict: verdict, model: AUDIT_MODEL,
    tokens: { in: 40 + t.length, out: 12 }
  };
}

export async function audit(text, ctx) {
  return auditStub(text, ctx);
}

export const MEME_LIB = [
  { name: "猫猫无语", kw: ["无语", "服了", "麻了", "离谱"] },
  { name: "猫猫得意", kw: ["得意", "拿下", "赢了", "成功"] },
  { name: "猫猫震惊", kw: ["震惊", "真的假的", "卧槽", "龟龟"] },
  { name: "猫猫求饶", kw: ["抱歉", "我错了", "对不起", "别打我"] },
  { name: "猫猫开心", kw: ["开心", "好耶", "哈哈", "太好了"] },
  { name: "猫猫叹气", kw: ["叹气", "累了", "不想", "算了"] }
];

export function parseMeme(text) {
  const s = String(text || "");
  const OPEN = "[表情:";
  const i = s.indexOf(OPEN);
  if (i < 0) return { text: s.trim(), mood: null };
  const j = s.indexOf("]", i);
  if (j < 0) return { text: s.trim(), mood: null };
  const mood = s.slice(i + OPEN.length, j).trim();
  const body = (s.slice(0, i) + s.slice(j + 1)).trim();
  return { text: body, mood: mood || null };
}

export function findMeme(mood) {
  if (!mood) return null;
  const m = String(mood);
  for (const entry of MEME_LIB) {
    for (const kw of entry.kw) if (m.includes(kw) || m.includes(entry.name)) return entry;
  }
  return null;
}

export function shouldAttachMeme(tier, mood) {
  if (tier === "high") return false;
  if (!mood) return false;
  return true;
}
