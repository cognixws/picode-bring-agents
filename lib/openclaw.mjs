// OpenClaw reader. Layout from OpenClaw's own docs (package 2026.10.9:
// concepts/agent-workspace, concepts/multi-agent, automation/cron-jobs) and
// Hermes' OpenClaw migrator: the state folder (~/.openclaw, or
// ~/.openclaw-<profile>) holds openclaw.json (JSON5; agents.entries, or the
// older agents.list) and skills/ shared by every agent. Each agent has a
// workspace (workspace-<id>, or workspace for the default one) with SOUL.md,
// AGENTS.md, IDENTITY.md, USER.md, MEMORY.md, memory/<date>.md and skills/.
// MCP servers are under mcp.servers. Since 2026.9 scheduled jobs live in
// state/openclaw.sqlite; only the older cron/jobs.json is read here.
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { readdirSync } from "node:fs";
import { isDir, isFile, readText, listDirs, readSkill, markdownEntries, key, shortHash } from "./util.mjs";
import { parseJSON5 } from "./formats.mjs";

export const SOURCE = "openclaw";
const CONFIG_NAMES = ["openclaw.json", "clawdbot.json", "moltbot.json"];

export function openclawHomes(env = process.env) {
  const out = [];
  if (env.OPENCLAW_STATE_DIR) out.push(env.OPENCLAW_STATE_DIR);
  const home = homedir();
  let names = [];
  try { names = readdirSync(home); } catch { names = []; }
  for (const n of names.sort()) {
    if (n === ".openclaw" || n.startsWith(".openclaw-") || n === ".clawdbot" || n === ".moltbot") out.push(join(home, n));
  }
  return [...new Set(out)];
}

function configPath(dir) {
  for (const n of CONFIG_NAMES) if (isFile(join(dir, n))) return join(dir, n);
  return "";
}

export function isOpenClaw(dir) {
  if (configPath(dir)) return true;
  return ["workspace", "workspace-main"].some((w) => isFile(join(dir, w, "SOUL.md")) && isFile(join(dir, w, "AGENTS.md")));
}

function config(dir) {
  const p = configPath(dir);
  if (!p) return {};
  try { return parseJSON5(readText(p)) || {}; } catch { return {}; }
}

// roster: [{id, name, workspace, model, skills}] from agents.entries, the
// older agents.list, or the one default agent.
function roster(cfg) {
  const agents = (cfg && cfg.agents) || {};
  if (agents.entries && typeof agents.entries === "object" && Object.keys(agents.entries).length) {
    return Object.entries(agents.entries).map(([id, e]) => ({ id, ...(e && typeof e === "object" ? e : {}) }));
  }
  if (Array.isArray(agents.list) && agents.list.length) return agents.list.filter((e) => e && e.id).map((e) => ({ ...e }));
  return [{ id: "main" }];
}

// resolve maps a configured path into this folder when it pointed inside
// the state folder (so an archive of it still reads), else to the home.
function resolve(dir, p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const m = /^~?\/?(?:.*\/)?\.(?:openclaw|clawdbot|moltbot)[^/]*\/(.+)$/.exec(s);
  if (m && isDir(join(dir, m[1]))) return join(dir, m[1]);
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? s : join(dir, s);
}

function workspaceOf(dir, cfg, agent, sole) {
  const defaults = (cfg.agents && cfg.agents.defaults) || {};
  const tries = [];
  if (agent.workspace) tries.push(resolve(dir, agent.workspace));
  if (sole || agent.id === "main" || agent.default) {
    if (defaults.workspace) tries.push(resolve(dir, defaults.workspace));
    tries.push(join(dir, "workspace"), join(dir, "workspace-main"), join(dir, "workspace.default"));
  }
  if (defaults.workspace) tries.push(join(resolve(dir, defaults.workspace), agent.id));
  tries.push(join(dir, "workspace-" + agent.id));
  return tries.find((p) => p && isDir(p)) || "";
}

function modelName(m) {
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof m.primary === "string") return m.primary;
  return "";
}

function identityName(text) {
  const m = /^\s*(?:[-*]\s*)?(?:\*\*)?name(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n*]+)/im.exec(text || "");
  return m ? m[1].trim() : "";
}

function connectors(cfg, reconnect, who) {
  const servers = (cfg.mcp && cfg.mcp.servers) || {};
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || s.enabled === false) continue;
    const c = { name };
    if (typeof s.url === "string") c.url = s.url;
    if (typeof s.command === "string") c.command = s.command;
    if (Array.isArray(s.args)) c.args = s.args.map(String);
    for (const part of ["env", "headers"]) {
      if (s[part] && typeof s[part] === "object") {
        c[part] = Object.fromEntries(Object.keys(s[part]).map((k) => [k, "${" + k.toUpperCase().replace(/[^A-Z0-9_]/g, "_") + "}"]));
      }
    }
    if (c.env || c.headers) reconnect.push({ kind: "connector", label: name, assistants: who });
    out.push(c);
  }
  return out;
}

function skillsIn(root, leftOut) {
  const out = [];
  for (const n of listDirs(root)) {
    if (n.startsWith(".")) continue;
    if (!isFile(join(root, n, "SKILL.md"))) continue;
    const sk = readSkill(join(root, n), leftOut);
    if (sk) out.push(sk);
  }
  return out;
}

// legacyJobs reads cron/jobs.json, which OpenClaw used before 2026.9.
function legacyJobs(dir) {
  try {
    const raw = JSON.parse(readText(join(dir, "cron", "jobs.json")) || "null");
    return Array.isArray(raw) ? raw : raw && Array.isArray(raw.jobs) ? raw.jobs : [];
  } catch { return []; }
}

export function scanOpenClaw(dir) {
  const cfg = config(dir);
  const agents = roster(cfg).filter((a, _i, all) => workspaceOf(dir, cfg, a, all.length === 1));
  return { assistants: agents.length, detail: "" };
}

export function readOpenClaw(dir) {
  const cfg = config(dir);
  const leftOut = [];
  const toReconnect = [];
  const skills = new Map();
  const add = (sk) => {
    const had = skills.get(sk.name);
    if (had && had.markdown !== sk.markdown) { leftOut.push({ kind: "skill", label: sk.name + ": another skill has this name" }); return false; }
    if (!had) skills.set(sk.name, sk);
    return true;
  };
  const shared = skillsIn(join(dir, "skills"), leftOut).filter(add).map((s) => s.name);
  const list = roster(cfg);
  const defaults = (cfg.agents && cfg.agents.defaults) || {};
  const assistants = [];
  for (const agent of list) {
    const ws = workspaceOf(dir, cfg, agent, list.length === 1);
    if (!ws) { leftOut.push({ kind: "other", label: "Agent " + agent.id + ": its workspace folder was not found" }); continue; }
    const soul = readText(join(ws, "SOUL.md")).trim();
    const ops = readText(join(ws, "AGENTS.md")).trim();
    const a = {
      key: key(agent.id, "agent"),
      name: String(agent.name || identityName(readText(join(ws, "IDENTITY.md"))) || agent.id),
      instructions: [soul, ops ? "## Operating instructions\n\n" + ops : ""].filter(Boolean).join("\n\n"),
      skills: [], notes: [], automations: [], connectors: [],
    };
    const model = modelName(agent.model) || modelName(defaults.model);
    if (model) a.model = model;
    for (const [file, kind] of [["MEMORY.md", "fact"], ["USER.md", "preference"]]) {
      for (const text of markdownEntries(readText(join(ws, file)))) a.notes.push({ key: shortHash(file + text), kind, text });
    }
    let daily = 0;
    try { daily = readdirSync(join(ws, "memory")).filter((n) => n.endsWith(".md")).length; } catch { daily = 0; }
    if (daily) leftOut.push({ kind: "other", label: a.name + ": " + daily + " daily memory logs (memory/)" });
    const allow = Array.isArray(agent.skills) ? new Set(agent.skills) : Array.isArray(defaults.skills) ? new Set(defaults.skills) : null;
    for (const name of shared) if (!allow || allow.has(name)) a.skills.push(name);
    for (const sk of skillsIn(join(ws, "skills"), leftOut)) if (add(sk) && !a.skills.includes(sk.name)) a.skills.push(sk.name);
    assistants.push(a);
  }
  const keys = assistants.map((a) => a.key);
  const conns = connectors(cfg, toReconnect, keys);
  for (const a of assistants) a.connectors = conns;
  const jobs = legacyJobs(dir);
  for (const j of jobs) {
    const name = String(j.name || j.id || "Task");
    const sched = j.schedule || {};
    const payload = j.payload || {};
    const prompt = payload.message || payload.text || j.message || "";
    const cron = sched.kind === "cron" ? String(sched.expr || "").trim() : typeof j.cron === "string" ? j.cron : "";
    const target = assistants.find((a) => a.key === key(j.agentId || "", "")) || assistants[0];
    if (!target || !prompt || !cron) { leftOut.push({ kind: "routine", label: name + ": not a repeating prompt on a cron" }); continue; }
    const schedule = { cron };
    if (sched.tz) schedule.timezone = String(sched.tz);
    target.automations.push({ key: key(j.id || name, "task"), name, prompt: String(prompt), schedule });
  }
  if (!jobs.length && isFile(join(dir, "state", "openclaw.sqlite"))) {
    leftOut.push({ kind: "routine", label: "Scheduled tasks kept in OpenClaw's database (state/openclaw.sqlite) are not read yet" });
  }
  const profile = /^\.openclaw-(.+)$/.exec(basename(dir));
  return {
    format: 4, kind: "assistants",
    source: { app: SOURCE, ref: profile ? "profile-" + key(profile[1]) : "default", name: "OpenClaw" },
    assistants,
    skills: [...skills.values()],
    leftOut,
    toReconnect,
  };
}
