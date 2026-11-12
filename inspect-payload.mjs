// Read-only: dumps the real submit payload structure of the IISM admission form.
// It loads the page, lists every field that would be POSTed (name, id, type, tag),
// the <form> action/method/enctype, and the hidden ASP.NET state fields. It NEVER
// fills, uploads or submits anything.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const info = await page.evaluate(() => {
    const form = document.querySelector("form");
    const fields = [...document.querySelectorAll("input, select, textarea")]
      .filter((el) => el.name || el.id)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || (el.tagName.toLowerCase() === "select" ? "select" : el.tagName.toLowerCase())).toLowerCase(),
        name: el.name || "",
        id: el.id || "",
        optionCount: el.tagName.toLowerCase() === "select" ? el.options.length : undefined
      }));
    return {
      action: form ? form.getAttribute("action") : null,
      method: form ? (form.getAttribute("method") || "get") : null,
      enctype: form ? (form.getAttribute("enctype") || "application/x-www-form-urlencoded") : null,
      fields
    };
  });

  const hidden = info.fields.filter((f) => f.type === "hidden");
  const files = info.fields.filter((f) => f.type === "file");
  const selects = info.fields.filter((f) => f.type === "select");
  const text = info.fields.filter((f) => !["hidden", "file", "select", "submit", "button", "image", "reset"].includes(f.type));
  const buttons = info.fields.filter((f) => ["submit", "button", "image"].includes(f.type));

  console.log("FORM:", JSON.stringify({ action: info.action, method: info.method, enctype: info.enctype }, null, 2));
  const show = (title, arr) => {
    console.log(`\n${title} (${arr.length}):`);
    for (const f of arr) {
      console.log(`  name="${f.name}"  id="${f.id}"  type=${f.type}${f.optionCount != null ? `  options=${f.optionCount}` : ""}`);
    }
  };
  show("HIDDEN / ASP.NET STATE", hidden);
  show("TEXT / DATA INPUTS", text);
  show("DROPDOWNS (select)", selects);
  show("FILE UPLOADS", files);
  show("BUTTONS", buttons);
  console.log(`\nTotal postable fields: ${info.fields.length}`);
} finally {
  await browser.close();
}
