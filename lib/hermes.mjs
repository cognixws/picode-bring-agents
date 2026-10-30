// Hermes Agent reader. Layout measured on a real install (2026-10-30) and
// in Hermes' own source: a home (~/.hermes, or $HERMES_HOME) holds SOUL.md
// (the persona), memories/MEMORY.md and USER.md (entries split by "§"),
// skills/<category>/<skill>/SKILL.md (the ones Hermes ships are named in
// skills/.bundled_manifest), cron/jobs.json ({"jobs": [...]}) and
// config.yaml (model.default, mcp_servers). Each profiles/<name>/ is a home
// of its own: one more assistant.
import { homedir } from "node:os";
import { join } from "node:path";
import { isDir, isFile, readText, listDirs, readSkill, markdownEntries, key, shortHash } from "./util.mjs";
import { parseYAMLLite } from "./formats.mjs";

export const SOURCE = "hermes";

export function hermesHomes(env = process.env) {
  const out = [];
  if (env.HERMES_HOME) out.push(env.HERMES_HOME);
  out.push(join(homedir(), ".hermes"));
  return [...new Set(out)];
}

// A home has a persona, a memory folder or Hermes' config beside its skills.
export function isHermes(dir) {
  if (isFile(join(dir, "openclaw.json"))) return false;
  if (isFile(join(dir, "SOUL.md")) && (isFile(join(dir, "config.yaml")) || isDir(join(dir, "memories")) || isDir(join(dir, "profiles")))) return true;
  return isFile(join(dir, "config.yaml")) && isDir(join(dir, "memories")) && isDir(join(dir, "skills"));
}

// The homes inside: the root, then each profile with a persona. Profiles
// COGNIX[WS] made for its own agents (cognix-*) are its own, not the person's.
function homes(dir) {
  const out = [];
  if (isFile(join(dir, "SOUL.md")) || isFile(join(dir, "memories", "MEMORY.md"))) out.push({ dir, key: "hermes", name: "Hermes" });
  for (const p of listDirs(join(dir, "profiles"))) {
    if (p.startsWith("cognix-")) continue;
    const pd = join(dir, "profiles", p);
    if (isFile(join(pd, "SOUL.md"))) out.push({ dir: pd, key: key(p, "profile"), name: p });
  }
  return out;
}

export function scanHermes(dir) {
  const hs = homes(dir);
  const profiles = hs.filter((h) => h.dir !== dir).length;
  return { assistants: hs.length, detail: profiles ? profiles + " profile" + (profiles === 1 ? "" : "s") : "" };
}

function config(dir) {
  try { return parseYAMLLite(readText(join(dir, "config.yaml"))) || {}; } catch { return {}; }
}

function memoryEntries(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  if (t.includes("§")) return t.split(/\n?§\n?/).map((x) => x.trim()).filter(Boolean);
  return markdownEntries(t);
}

// Hermes' own rule (tools/skill_usage.py): a skill is the person's when it
// is neither built in (.bundled_manifest, plus the curator's suppressed
// built-ins) nor installed from the Skills Hub (.hub/lock.json). Hub skills
// can be installed again there, so they are named, not copied.
function builtInSkills(dir) {
  const names = new Set();
  for (const line of readText(join(dir, "skills", ".bundled_manifest")).split("\n")) {
    const n = line.split(":")[0].trim();
    if (n) names.add(n);
  }
  for (const n of readText(join(dir, "skills", ".curator_suppressed")).split(/[\n,]/)) if (n.trim()) names.add(n.trim());
  // The manifest can lag the catalog (measured 2026-10-30: 29 shipped skills
  // missing from it). When Hermes' own code sits in the home, as the
  // installer puts it, every skill it ships counts as built in too.
  for (const tree of ["skills", "optional-skills"]) {
    for (const s of skillDirs(join(dir, "hermes-agent", tree))) names.add(s.folder);
  }
  return names;
}

function hubSkills(dir) {
  try {
    const lock = JSON.parse(readText(join(dir, "skills", ".hub", "lock.json")) || "{}");
    return new Set(Object.keys((lock && lock.installed) || {}));
  } catch { return new Set(); }
}

// skillDirs: every folder with a SKILL.md under skills/, at most three
// levels deep, skipping hidden folders (archive, hub caches).
function skillDirs(root) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const n of listDirs(d)) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      if (isFile(join(p, "SKILL.md"))) out.push({ dir: p, folder: n });
      else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// cronOf turns a Hermes schedule into a five-field cron, or "".
export function cronOf(schedule) {
  const s = schedule || {};
  if (s.kind === "cron" && typeof s.expr === "string") return s.expr.trim();
  if (s.kind === "interval") {
    const m = Number(s.minutes) || 0;
    if (m > 0 && m < 60 && 60 % m === 0) return m === 1 ? "* * * * *" : "*/" + m + " * * * *";
    if (m >= 60 && m % 60 === 0 && 24 % (m / 60) === 0) return m === 1440 ? "0 0 * * *" : m === 60 ? "0 * * * *" : "0 */" + m / 60 + " * * *";
  }
  return "";
}

function connectorsOf(cfg, reconnect, who) {
  const servers = cfg && typeof cfg.mcp_servers === "object" && cfg.mcp_servers ? cfg.mcp_servers : {};
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object") continue;
    const c = { name };
    if (typeof s.url === "string") c.url = s.url;
    if (typeof s.command === "string") c.command = s.command;
    if (Array.isArray(s.args)) c.args = s.args.map(String);
    // Values never travel: each one becomes a slot to fill here.
    for (const part of ["env", "headers"]) {
      if (s[part] && typeof s[part] === "object") {
        c[part] = Object.fromEntries(Object.keys(s[part]).map((k) => [k, "${" + k.toUpperCase().replace(/[^A-Z0-9_]/g, "_") + "}"]));
      }
    }
    if (c.env || c.headers) reconnect.push({ kind: "connector", label: name, assistants: [who] });
    out.push(c);
  }
  return out;
}

export function readHermes(dir) {
  const leftOut = [];
  const toReconnect = [];
  const skills = new Map();
  const assistants = [];
  for (const h of homes(dir)) {
    const cfg = config(h.dir);
    const model = typeof cfg.model === "string" ? cfg.model : cfg.model && typeof cfg.model.default === "string" ? cfg.model.default : "";
    const a = { key: h.key, name: h.name, instructions: readText(join(h.dir, "SOUL.md")).trim(), skills: [], notes: [], automations: [], connectors: [] };
    if (model) a.model = model;
    for (const [file, kind] of [["MEMORY.md", "fact"], ["USER.md", "preference"]]) {
      for (const text of memoryEntries(readText(join(h.dir, "memories", file)))) a.notes.push({ key: shortHash(file + text), kind, text });
    }
    const builtIn = builtInSkills(h.dir);
    const hub = hubSkills(h.dir);
    let shipped = 0;
    const fromHub = [];
    for (const s of skillDirs(join(h.dir, "skills"))) {
      if (builtIn.has(s.folder)) { shipped++; continue; }
      if (hub.has(s.folder)) { fromHub.push(s.folder); continue; }
      // Older catalogs left shipped skills behind with Hermes as their author.
      if (/^author:\s*["']?Hermes Agent\b/m.test(readText(join(s.dir, "SKILL.md")).split(/\n---/)[0])) { shipped++; continue; }
      const sk = readSkill(s.dir, leftOut);
      if (!sk) continue;
      const had = skills.get(sk.name);
      if (had && had.markdown !== sk.markdown) { leftOut.push({ kind: "skill", label: sk.name + " (" + h.name + "): another skill has this name" }); continue; }
      if (!had) skills.set(sk.name, sk);
      if (!a.skills.includes(sk.name)) a.skills.push(sk.name);
    }
    if (shipped) leftOut.push({ kind: "skill", label: shipped + " skills that come with Hermes (" + h.name + ")" });
    if (fromHub.length) leftOut.push({ kind: "skill", label: "From the Skills Hub, to install again: " + fromHub.slice(0, 12).join(", ") + (fromHub.length > 12 ? "…" : "") });
    let jobs = [];
    try { jobs = JSON.parse(readText(join(h.dir, "cron", "jobs.json")) || "{}").jobs || []; } catch { jobs = []; }
    for (const j of Array.isArray(jobs) ? jobs : []) {
      const name = String(j.name || j.id || "Task");
      if (j.script || j.no_agent || !j.prompt) { leftOut.push({ kind: "routine", label: name + ": runs a script, not a prompt" }); continue; }
      const cron = cronOf(j.schedule);
      if (!cron) { leftOut.push({ kind: "routine", label: name + ": " + (j.schedule_display || "its schedule") + " is not a repeating cron" }); continue; }
      a.automations.push({ key: key(j.id || name, "task"), name, prompt: String(j.prompt), schedule: { cron } });
    }
    a.connectors = connectorsOf(cfg, toReconnect, h.key);
    assistants.push(a);
  }
  const install = readText(join(dir, "install_id")).trim();
  return {
    format: 4, kind: "assistants",
    source: { app: SOURCE, ref: install ? "install-" + key(install).slice(0, 24) : "default", name: "Hermes Agent" },
    assistants,
    skills: [...skills.values()],
    leftOut,
    toReconnect,
  };
}
