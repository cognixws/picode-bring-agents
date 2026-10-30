// Bring agents: COGNIX[WS] asks this process, through its assistantImporter
// door, what it finds on this computer (GET /scan) and to read one folder
// into a format 4 manifest (POST /read). It only reads the other apps'
// files; COGNIX[WS] checks, redacts and previews the answer before anything
// is saved. Calls without COGNIX[WS]'s secret are refused.
import { createServer } from "node:http";
import { join } from "node:path";
import { sameSecret, isDir, listDirs } from "./lib/util.mjs";
import { hermesHomes, isHermes, scanHermes, readHermes } from "./lib/hermes.mjs";
import { openclawHomes, isOpenClaw, scanOpenClaw, readOpenClaw } from "./lib/openclaw.mjs";

const port = Number(process.env.PICODE_EXT_PORT || 0);
const secret = process.env.PICODE_EXT_PROXY_SECRET || "";

export const READERS = [
  { source: "openclaw", title: "OpenClaw", homes: openclawHomes, is: isOpenClaw, scan: scanOpenClaw, read: readOpenClaw },
  { source: "hermes", title: "Hermes Agent", homes: hermesHomes, is: isHermes, scan: scanHermes, read: readHermes },
];

export function scan(readers = READERS) {
  const found = [];
  for (const r of readers) {
    for (const dir of r.homes()) {
      if (!isDir(dir) || !r.is(dir)) continue;
      const s = r.scan(dir);
      if (!s.assistants) continue;
      found.push({ source: r.source, path: dir, title: r.title, assistants: s.assistants, detail: s.detail || "" });
    }
  }
  return { found };
}

// findRoot: the folder itself, or, for an unpacked archive, the one folder
// it holds (a zip of ~/.hermes unpacks to .hermes/).
function candidates(dir) {
  const out = [dir];
  const inside = listDirs(dir).filter((n) => n !== "__MACOSX");
  if (inside.length === 1) out.push(join(dir, inside[0]));
  for (const n of [".hermes", ".openclaw"]) if (inside.length > 1 && inside.includes(n)) out.push(join(dir, n));
  return out;
}

// read answers [status, body]: 200 with a manifest, 422 when no reader
// knows the folder, 400 for a bad request.
export function read({ source = "", path = "" } = {}, readers = READERS) {
  if (typeof path !== "string" || !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return [400, { error: "path must be absolute" }];
  if (!isDir(path)) return [422, { error: "not a folder" }];
  const pool = source ? readers.filter((r) => r.source === source) : readers;
  for (const dir of candidates(path)) {
    for (const r of pool) {
      if (r.is(dir)) {
        const bundle = r.read(dir);
        if (!bundle.assistants.length) return [422, { error: "no assistant in this folder" }];
        return [200, bundle];
      }
    }
  }
  return [422, { error: "not a folder of " + (pool.map((r) => r.title).join(" or ") || "a known app") }];
}

function send(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 64 * 1024) { reject(new Error("body is too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("body is not JSON")); }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  if (!sameSecret(req.headers["x-picode-proxy-secret"], secret)) return send(res, 401, { error: "This call did not come through COGNIX[WS]." });
  const url = new URL(req.url || "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/scan") return send(res, 200, scan());
    if (req.method === "POST" && url.pathname === "/read") {
      const [status, body] = read(await readBody(req));
      return send(res, status, body);
    }
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err && err.message || err) });
  }
}

if (port) {
  createServer((req, res) => { handle(req, res); }).listen(port, "127.0.0.1");
}
