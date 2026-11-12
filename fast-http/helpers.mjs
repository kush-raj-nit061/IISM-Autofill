// Minimal HTML-form + cookie helpers for the pure-HTTP session replay.
// No external dependencies — just Node's built-in fetch, FormData and Blob.
import { readFile } from "node:fs/promises";
import path from "node:path";

// ---- cookie jar -----------------------------------------------------------
// ASP.NET relies on a session cookie (ASP.NET_SessionId) that must travel with
// every request in the postback chain, so we persist Set-Cookie between hops.
export function createJar() {
  const jar = new Map();
  return {
    store(response) {
      const cookies = response.headers.getSetCookie?.() ?? [];
      for (const raw of cookies) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
  };
}

// ---- tiny HTML parsing (regex, good enough for this fixed WebForms page) ---
export function getAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i")) ||
    tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? decodeHtml(m[1]) : null;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Every <input> that the browser would POST back (hidden + text + checked
// checkbox). Buttons are intentionally excluded; we add btnSubmit ourselves.
export function parseInputs(html) {
  const state = {};
  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of inputs) {
    const name = getAttr(tag, "name");
    if (!name) continue;
    const type = (getAttr(tag, "type") || "text").toLowerCase();
    if (["submit", "button", "image", "reset"].includes(type)) continue;
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(tag)) state[name] = getAttr(tag, "value") || "on";
      continue;
    }
    state[name] = getAttr(tag, "value") ?? "";
  }
  return state;
}

// All <option>s of a named <select>.
export function parseSelect(html, selectName) {
  const block = html.match(
    new RegExp(`<select\\b[^>]*name\\s*=\\s*["']${selectName}["'][^>]*>([\\s\\S]*?)</select>`, "i")
  );
  if (!block) return [];
  const options = block[1].match(/<option\b[^>]*>[\s\S]*?<\/option>/gi) ?? [];
  return options.map((opt) => {
    const value = getAttr(opt, "value") ?? "";
    const label = opt.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    return { value, label };
  });
}

// Current value of a single named input (e.g. txtAvailableSeat, txtCourseFee).
export function inputValue(html, name) {
  const tag = (html.match(/<input\b[^>]*>/gi) ?? []).find((t) => getAttr(t, "name") === name);
  return tag ? getAttr(tag, "value") ?? "" : "";
}

export function normalize(value) {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// Fuzzy-pick an option value by its visible label.
export function matchOption(options, requested, { firstAvailable = false } = {}) {
  const real = options.filter((o) => o.value && o.value !== "0");
  if (firstAvailable && normalize(requested) === "first_available") return real[0]?.value ?? null;
  const needle = normalize(requested);
  let hit = real.find((o) => normalize(o.label) === needle);
  if (!hit) hit = real.find((o) => normalize(o.label).includes(needle) || needle.includes(normalize(o.label)));
  return hit?.value ?? null;
}

const MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif"
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export async function fileBlob(absolutePath) {
  const buf = await readFile(absolutePath);
  return new Blob([buf], { type: mimeFor(absolutePath) });
}
