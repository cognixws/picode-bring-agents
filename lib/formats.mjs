// Two small, tolerant config readers, so the extension needs no packages.
// They read what the readers use (names, models, server definitions) and
// give up quietly on anything else.

// parseJSON5 reads OpenClaw's openclaw.json: JSON with comments, trailing
// commas, unquoted keys and single-quoted strings.
export function parseJSON5(text) {
  const src = String(text || "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          if (n === "\n") { j += 2; continue; }
          s += n === "'" ? "'" : "\\" + n;
          j += 2;
          continue;
        }
        s += src[j] === '"' ? '\\"' : src[j] === "\n" ? "\\n" : src[j];
        j++;
      }
      out += '"' + s + '"';
      i = j + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      out += src[k] === ":" && !["true", "false", "null"].includes(word) ? JSON.stringify(word) : word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

// parseYAMLLite reads block mappings, scalars, `- item` lists and inline
// [a, b] lists: enough for Hermes' config.yaml keys the reader uses.
export function parseYAMLLite(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n")
    .map((raw) => ({ raw, indent: raw.search(/\S/), line: stripComment(raw).trimEnd() }))
    .filter((l) => l.indent >= 0 && l.line.trim() && !l.line.trim().startsWith("#") && l.line.trim() !== "---");
  let i = 0;
  function block(indent) {
    if (i < lines.length && lines[i].line.trim().startsWith("- ") && lines[i].indent >= indent) return list(lines[i].indent);
    const obj = {};
    while (i < lines.length && lines[i].indent >= indent) {
      const { line, indent: ind } = lines[i];
      if (ind > indent && Object.keys(obj).length === 0 && indent !== ind) indent = ind;
      if (ind !== indent) { i++; continue; }
      const m = /^\s*("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(line);
      i++;
      if (!m) continue;
      const k = unquote(m[1]);
      const v = m[2];
      if (v === undefined || v === "" || v === "|" || v === ">") {
        obj[k] = i < lines.length && lines[i].indent > ind ? block(lines[i].indent) : v === "|" || v === ">" ? "" : null;
      } else {
        obj[k] = scalar(v);
      }
    }
    return obj;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].line.trim().startsWith("- ")) {
      const item = lines[i].line.trim().slice(2);
      i++;
      if (/^[^:]+:\s/.test(item) || /^[^:]+:$/.test(item)) {
        lines.splice(i, 0, { raw: "", indent: indent + 2, line: " ".repeat(indent + 2) + item });
        arr.push(block(indent + 2));
      } else arr.push(scalar(item));
    }
    return arr;
  }
  return block(0);
}

function stripComment(s) {
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function scalar(v) {
  const t = String(v).trim();
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).split(",").map((x) => unquote(x)).filter(Boolean);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return unquote(t);
}
