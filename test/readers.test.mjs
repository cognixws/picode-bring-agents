import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isHermes, readHermes, scanHermes, cronOf } from "../lib/hermes.mjs";
import { isOpenClaw, readOpenClaw, scanOpenClaw } from "../lib/openclaw.mjs";
import { parseJSON5, parseYAMLLite } from "../lib/formats.mjs";
import { markdownEntries, secretFile } from "../lib/util.mjs";
import { read, scan } from "../process.mjs";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "bring-agents-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const hermes = () => tree({
  "SOUL.md": "You are Iris. Be brief.",
  "install_id": "abc-123",
  "config.yaml": "model:\n  default: claude-sonnet-4  # main\n  provider: anthropic\nmcp_servers:\n  notion:\n    url: https://mcp.notion.com/mcp\n    headers:\n      Authorization: Bearer sk-live-should-not-travel\n  files:\n    command: npx\n    args: [\"-y\", \"files-mcp\"]\n",
  "memories/MEMORY.md": "Ships on Tuesdays.\n§\nThe repo is picode.",
  "memories/USER.md": "Prefers Portuguese.",
  "skills/.bundled_manifest": "plan:abc\n",
  "skills/software-development/plan/SKILL.md": "---\nname: plan\n---\nShipped.",
  "skills/notes/tidy/SKILL.md": "---\nname: tidy\ndescription: Tidy notes\n---\nTidy them.",
  "skills/notes/tidy/scripts/run.sh": "echo tidy",
  "skills/notes/tidy/.env": "TOKEN=x",
  "skills/notes/shipped/SKILL.md": "---\nname: shipped\nauthor: Hermes Agent\n---\nOld catalog.",
  "skills/.archive/old/SKILL.md": "---\nname: old\n---\nArchived.",
  "skills/.hub/lock.json": JSON.stringify({ installed: { "rss-feeds": {} } }),
  "skills/research/rss-feeds/SKILL.md": "---\nname: rss-feeds\n---\nHub.",
  "cron/jobs.json": JSON.stringify({ jobs: [
    { id: "j1", name: "Morning brief", prompt: "Summarise my inbox.", schedule: { kind: "cron", expr: "0 8 * * 1-5" } },
    { id: "j2", name: "Every 30m", prompt: "Check.", schedule: { kind: "interval", minutes: 30 } },
    { id: "j3", name: "Once", prompt: "Remind me.", schedule: { kind: "once", run_at: "2026-11-01T10:00:00" }, schedule_display: "once at 2026-11-01" },
    { id: "j4", name: "Script", script: "x.py", no_agent: true, schedule: { kind: "cron", expr: "* * * * *" } },
  ] }),
  "profiles/coder/SOUL.md": "You write code.",
  "profiles/coder/memories/MEMORY.md": "- Uses Go.\n- Tests first.",
  "profiles/cognix-agent-1/SOUL.md": "COGNIX[WS]'s own home.",
  "profiles/empty/cache/x": "",
  "auth.json": "{\"token\":\"secret\"}",
});

test("a Hermes home becomes one assistant per persona, with its memory, skills and tasks", () => {
  const dir = hermes();
  assert.equal(isHermes(dir), true);
  assert.deepEqual(scanHermes(dir), { assistants: 2, detail: "1 profile" });
  const b = readHermes(dir);
  assert.equal(b.format, 4);
  assert.equal(b.kind, "assistants");
  assert.equal(b.source.app, "hermes");
  assert.equal(b.source.ref, "install-abc-123");
  assert.deepEqual(b.assistants.map((a) => [a.key, a.name]), [["hermes", "Iris"], ["coder", "coder"]]);
  const [iris, coder] = b.assistants;
  assert.equal(iris.instructions, "You are Iris. Be brief.");
  assert.equal(iris.model, "claude-sonnet-4");
  assert.deepEqual(iris.notes.map((n) => [n.kind, n.text]), [["fact", "Ships on Tuesdays."], ["fact", "The repo is picode."], ["preference", "Prefers Portuguese."]]);
  assert.deepEqual(iris.skills, ["tidy"], "built-in, Hermes-authored, archived and hub skills stay");
  assert.deepEqual(b.skills.map((s) => s.name), ["tidy"]);
  assert.deepEqual(Object.keys(b.skills[0].files), ["scripts/run.sh"], "the .env beside it never travels");
  assert.deepEqual(iris.automations.map((a) => [a.name, a.schedule.cron]), [["Morning brief", "0 8 * * 1-5"], ["Every 30m", "*/30 * * * *"]]);
  assert.deepEqual(coder.notes.map((n) => n.text), ["Uses Go.", "Tests first."]);
  const notion = iris.connectors.find((c) => c.name === "notion");
  assert.deepEqual(notion.headers, { Authorization: "${AUTHORIZATION}" }, "a header value becomes a slot");
  assert.ok(!JSON.stringify(b).includes("sk-live"), "no secret value travels");
  assert.ok(!JSON.stringify(b).includes("COGNIX[WS]'s own home"), "COGNIX[WS]'s own homes are not the person's");
  const labels = b.leftOut.map((l) => l.label).join("\n");
  assert.match(labels, /Once: runs only once/);
  assert.match(labels, /Script: runs a script, not a message/);
  assert.match(labels, /^2 skills that come with Hermes$/m);
  assert.match(labels, /Skills Hub, to install again: rss-feeds/);
  assert.match(labels, /tidy\/\.env/);
});

test("Hermes intervals become a cron only when they divide the hour or the day", () => {
  assert.equal(cronOf({ kind: "interval", minutes: 15 }), "*/15 * * * *");
  assert.equal(cronOf({ kind: "interval", minutes: 60 }), "0 * * * *");
  assert.equal(cronOf({ kind: "interval", minutes: 360 }), "0 */6 * * *");
  assert.equal(cronOf({ kind: "interval", minutes: 1440 }), "0 0 * * *");
  assert.equal(cronOf({ kind: "interval", minutes: 45 }), "");
  assert.equal(cronOf({ kind: "once", run_at: "x" }), "");
});

const openclaw = () => tree({
  "openclaw.json": `{
    // JSON5, as OpenClaw writes it
    agents: {
      defaults: { model: { primary: 'anthropic/claude-sonnet-4' }, },
      entries: {
        main: { },
        alerts: { name: "Alerts", model: "openai/gpt-5", skills: ['shared-one'] },
        ghost: { workspace: "~/.openclaw/workspace-missing" },
      },
    },
    mcp: { servers: { github: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "ghp_should_not_travel" } }, off: { url: "https://x", enabled: false } } },
  }`,
  "skills/shared-one/SKILL.md": "---\nname: shared-one\n---\nShared.",
  "skills/shared-two/SKILL.md": "---\nname: shared-two\n---\nAlso shared.",
  "workspace/SOUL.md": "Calm and precise.",
  "workspace/AGENTS.md": "Check the calendar first.",
  "workspace/IDENTITY.md": "- **Name:** Clawd\n- **Emoji:** 🦞",
  "workspace/MEMORY.md": "# Memory\n\n- The office is in Recife.\n- Standup at 9.",
  "workspace/USER.md": "- Likes short replies.",
  "workspace/memory/2026-10-29.md": "- Talked about the deploy.",
  "workspace/skills/deploy/SKILL.md": "---\nname: deploy\n---\nShip it.",
  "workspace-alerts/SOUL.md": "You watch the alerts.",
  "workspace-alerts/skills/page/SKILL.md": "---\nname: page\n---\nPage someone.",
  "cron/jobs.json": JSON.stringify({ jobs: [
    { id: "daily", name: "Daily digest", agentId: "alerts", schedule: { kind: "cron", expr: "0 18 * * *", tz: "America/Recife" }, payload: { kind: "agentTurn", message: "Send the digest." } },
    { id: "loop", name: "Every 30s", schedule: { kind: "every", everyMs: 30000 }, payload: { message: "Ping." } },
  ] }),
  "credentials/oauth.json": "{}",
});

test("an OpenClaw state folder becomes one assistant per agent with a workspace", () => {
  const dir = openclaw();
  assert.equal(isOpenClaw(dir), true);
  assert.equal(isHermes(dir), false);
  assert.deepEqual(scanOpenClaw(dir), { assistants: 2, detail: "" });
  const b = readOpenClaw(dir);
  assert.equal(b.source.app, "openclaw");
  assert.equal(b.source.ref, "default");
  assert.deepEqual(b.assistants.map((a) => [a.key, a.name]), [["main", "Clawd"], ["alerts", "Alerts"]]);
  const [main, alerts] = b.assistants;
  assert.equal(main.instructions, "Calm and precise.\n\n## Operating instructions\n\nCheck the calendar first.");
  assert.equal(main.model, "anthropic/claude-sonnet-4");
  assert.equal(alerts.model, "openai/gpt-5");
  assert.deepEqual(main.notes.map((n) => n.text), ["The office is in Recife.", "Standup at 9.", "Likes short replies."]);
  assert.deepEqual(main.skills, ["shared-one", "shared-two", "deploy"]);
  assert.deepEqual(alerts.skills, ["shared-one", "page"], "the agent's allowlist filters shared skills");
  assert.deepEqual(alerts.automations.map((a) => [a.name, a.schedule]), [["Daily digest", { cron: "0 18 * * *", timezone: "America/Recife" }]]);
  assert.deepEqual(main.connectors.map((c) => c.name), ["github"], "a disabled server stays");
  assert.deepEqual(main.connectors[0].env, { GITHUB_TOKEN: "${GITHUB_TOKEN}" });
  assert.ok(!JSON.stringify(b).includes("ghp_should"), "no secret value travels");
  const labels = b.leftOut.map((l) => l.label).join("\n");
  assert.match(labels, /Agent ghost: its workspace folder was not found/);
  assert.match(labels, /^Clawd: 1 daily memory log$/m);
  assert.match(labels, /Every 30s: repeats in a way automations here cannot/);
});

test("OpenClaw's newer job database is named, not read", () => {
  const dir = tree({ "openclaw.json": "{}", "workspace/SOUL.md": "Hi.", "workspace/AGENTS.md": "Rules.", "state/openclaw.sqlite": "SQLite format 3" });
  const b = readOpenClaw(dir);
  assert.deepEqual(b.assistants.map((a) => a.key), ["main"]);
  assert.match(b.leftOut.map((l) => l.label).join("\n"), /kept in OpenClaw's database/);
});

test("read answers a manifest for a folder it knows, the one folder inside an archive, and 422 otherwise", () => {
  const h = hermes();
  assert.equal(read({ path: h })[0], 200);
  assert.equal(read({ source: "openclaw", path: h })[0], 422, "a source narrows the readers");
  const archive = tree({ ".hermes/SOUL.md": "Unpacked.", ".hermes/config.yaml": "model: x\n", ".hermes/memories/MEMORY.md": "A." });
  const [status, b] = read({ path: archive });
  assert.equal(status, 200);
  assert.equal(b.assistants[0].instructions, "Unpacked.");
  assert.equal(read({ path: tree({ "notes.txt": "x" }) })[0], 422);
  assert.equal(read({ path: "relative" })[0], 400);
  assert.equal(read({ path: "/no/such/folder" })[0], 422);
});

test("scan lists each home a reader knows, with its count", () => {
  const h = hermes();
  const o = openclaw();
  const readers = [
    { source: "hermes", title: "Hermes Agent", homes: () => [h, "/no/such"], is: isHermes, scan: scanHermes },
    { source: "openclaw", title: "OpenClaw", homes: () => [o, h], is: isOpenClaw, scan: scanOpenClaw },
  ];
  assert.deepEqual(scan(readers).found, [
    { source: "hermes", path: h, title: "Hermes Agent", assistants: 2, detail: "1 profile" },
    { source: "openclaw", path: o, title: "OpenClaw", assistants: 2, detail: "" },
  ]);
});

test("the small config readers read what the readers use", () => {
  assert.deepEqual(parseJSON5("{a: 'x', // c\n b: [1, 2,], /* d */ 'c-d': {e: true,},}"), { a: "x", b: [1, 2], "c-d": { e: true } });
  assert.deepEqual(parseJSON5('{url: "https://a.b/c", s: "it\'s"}'), { url: "https://a.b/c", s: "it's" });
  const y = parseYAMLLite("model:\n  default: m1 # note\nlist:\n  - a\n  - b\nservers:\n  one:\n    url: 'https://x#y'\n    args: [\"-y\", z]\n");
  assert.equal(y.model.default, "m1");
  assert.deepEqual(y.list, ["a", "b"]);
  assert.equal(y.servers.one.url, "https://x#y");
  assert.deepEqual(y.servers.one.args, ["-y", "z"]);
});

test("a persona file names its assistant", async () => {
  const { personaName } = await import("../lib/util.mjs");
  assert.equal(personaName("You are Iris, a calm research assistant."), "Iris");
  assert.equal(personaName("I'm Bit and I review Go."), "Bit");
  assert.equal(personaName("Your name is Nova."), "Nova");
  assert.equal(personaName("You are a helpful assistant."), "");
  assert.equal(personaName("You are The best."), "");
});

test("memory files split into entries; secret files are named", () => {
  assert.deepEqual(markdownEntries("# Notes\n\n- one\n  continued\n- two\n\nA paragraph\nthat wraps.\n"), ["one continued", "two", "A paragraph that wraps."]);
  for (const f of [".env", "auth.json", "id_rsa", "x/token.txt", ".ssh/config", "creds/password.json"]) assert.equal(secretFile(f), true, f);
  for (const f of ["SKILL.md", "scripts/run.sh", "tokens.md"]) assert.equal(secretFile(f), false, f);
});
