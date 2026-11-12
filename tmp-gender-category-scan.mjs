import { chromium } from "playwright-core";

const url = "https://admission.iismgulmarg.in/admission_form.aspx?mobile=8890498744";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const data = await page.evaluate(() => {
  const selects = Array.from(document.querySelectorAll("select")).map((s) => ({
    id: s.id,
    name: s.name,
    options: Array.from(s.options).slice(0, 30).map((o) => ({ value: o.value, label: (o.textContent || "").trim() }))
  }));

  const radios = Array.from(document.querySelectorAll('input[type="radio"]')).map((r) => {
    const label = r.labels && r.labels[0] ? r.labels[0].textContent.trim() : "";
    return { id: r.id, name: r.name, value: r.value, label };
  });

  const checks = Array.from(document.querySelectorAll('input[type="checkbox"]')).map((c) => {
    const label = c.labels && c.labels[0] ? c.labels[0].textContent.trim() : "";
    return { id: c.id, name: c.name, value: c.value, label };
  });

  const interesting = [];
  const all = [...selects.flatMap((s) => s.options.map((o) => `${s.id}::${o.label}`)),
               ...radios.map((r) => `${r.id || r.name}::${r.label || r.value}`),
               ...checks.map((c) => `${c.id || c.name}::${c.label || c.value}`)];
  for (const line of all) {
    if (/female|male|gender|obc|ncl|category|caste|sc|st|general|ews/i.test(line)) interesting.push(line);
  }

  return { selects, radios, checks, interesting };
});

console.log("INTERESTING:");
for (const i of data.interesting) console.log(i);

console.log("\nSELECT IDS:");
for (const s of data.selects) console.log(s.id || s.name || "(no-id)");

await browser.close();
