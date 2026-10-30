// Shared reading helpers. Everything here only reads: no file of the other
// app is ever written, moved or locked.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const MAX_TEXT = 4 << 20; // what COGNIX[WS] takes per text file
export const MAX_SKILL = 16 << 20; // per skill folder
const MAX_SKILL_FILES = 200;

export function sameSecret(got, expect) {
  if (!expect) return false;
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expect));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// readText answers a regular file's UTF-8 text, or "" (missing, too large,
// a link, binary).
export function readText(p, max = MAX_TEXT) {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > max) return "";
    const buf = readFileSync(p);
    const text = buf.toString("utf8");
    if (text.includes("\u0000") || Buffer.byteLength(text) !== buf.length) return "";
    return text;
  } catch { return ""; }
}

export function listDirs(p) {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

export function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 12);
}

// key is a bundle key: lowercase letters, digits and hyphens.
export function key(text, fallback = "item") {
  const k = String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return k || fallback;
}

// secretFile mirrors the core's list: a reader never opens these.
const SECRET_NAMES = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.netrc|\.npmrc|\.pypirc|credentials(\..*)?|.*\.kdbx)$/i;
const SECRET_WORDS = /(token|oauth|secret|credential|password|cookie|private[^/]*key)/i;
export function secretFile(rel) {
  const parts = String(rel).split(/[\\/]/);
  const base = parts[parts.length - 1].toLowerCase();
  if (SECRET_NAMES.test(base)) return true;
  if (base.startsWith("auth") && base.endsWith(".json")) return true;
  if (!base.endsWith(".md") && SECRET_WORDS.test(base)) return true;
  return parts.slice(0, -1).some((d) => /^(\.ssh|\.gnupg|\.aws|credentials|secrets)$/i.test(d));
}

// frontmatterName answers the `name:` of a SKILL.md's frontmatter.
export function frontmatterName(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md || "");
  if (!m) return "";
  const n = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(m[1]);
  return n ? n[1].trim() : "";
}

// readSkill reads one skill folder: its SKILL.md and its other text files,
// leaving out secret-named, binary and oversized ones.
export function readSkill(dir, leftOut) {
  const markdown = readText(join(dir, "SKILL.md"));
  if (!markdown) return null;
  const name = frontmatterName(markdown) || dir.split(sep).pop();
  const files = {};
  let total = Buffer.byteLength(markdown);
  let count = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (e.name === "node_modules" || e.name === ".git" || e.name === "__pycache__" || e.name === ".venv") continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || rel === "SKILL.md") continue;
      if (secretFile(rel)) { leftOut.push({ kind: "secret", label: name + "/" + rel }); continue; }
      const text = readText(p);
      if (!text) continue; // binary or too large: the skill still comes
      total += Buffer.byteLength(text);
      if (++count > MAX_SKILL_FILES || total > MAX_SKILL) { leftOut.push({ kind: "file", label: name + "/" + rel }); continue; }
      files[rel] = text;
    }
  };
  walk(dir);
  return { name, markdown, files };
}

// markdownEntries splits a memory file into short entries: list items, or
// paragraphs when there is no list. Headings and empty lines are dropped.
export function markdownEntries(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const items = [];
  let cur = null;
  let para = [];
  const flushPara = () => { const t = para.join(" ").trim(); if (t) items.push(t); para = []; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (cur) items.push(cur.trim());
      cur = bullet[1];
      continue;
    }
    if (/^\s*#/.test(line) || /^\s*(---|===)\s*$/.test(line)) { flushPara(); if (cur) { items.push(cur.trim()); cur = null; } continue; }
    if (!line.trim()) { flushPara(); if (cur) { items.push(cur.trim()); cur = null; } continue; }
    if (cur && /^\s{2,}/.test(raw)) { cur += " " + line.trim(); continue; }
    if (cur) { items.push(cur.trim()); cur = null; }
    para.push(line.trim());
  }
  flushPara();
  if (cur) items.push(cur.trim());
  return items.filter((t) => t.length > 1);
}

export function exists(p) { return existsSync(p); }

// personaName reads the name a persona file gives itself ("You are Iris,",
// "I am Bit", "Your name is Nova"), or "".
export function personaName(text) {
  const m = /\b(?:You are|You're|I am|I'm|Your name is|My name is)\s+(?:called\s+)?([A-Z][\p{L}\p{N}'-]{1,39})/u.exec(String(text || ""));
  if (!m || ["A", "An", "The", "Not", "Here", "Now"].includes(m[1])) return "";
  return m[1];
}

// count words a number with its noun.
export function count(n, one, many = one + "s") {
  return n + " " + (n === 1 ? one : many);
}
