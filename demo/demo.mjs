// Visual walkthrough of how the IISM autofiller works, driven against the LOCAL
// mock form in demo/mock-form.html (no real website is touched). It opens a visible
// Chrome in slow motion, narrates each step, highlights the element being acted on,
// and follows the exact postback-safe ordering the real tool uses:
//   course -> level -> state -> text fields -> schedule -> DOB -> RE-FILL guard ->
//   documents (last) -> declaration -> submit -> online-payment handoff.
//
// Run:  node demo/demo.mjs

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORM_URL = "file://" + path.join(ROOT, "demo", "mock-form.html");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// --fast removes the teaching slow-motion so you can see the tool's real speed.
const FAST = process.argv.includes("--fast");
const HL_MS = FAST ? 0 : 350;
const SLOWMO = FAST ? 0 : 450;
function note(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

// Draw an on-page banner so the viewer can read what is happening inside Chrome.
async function banner(page, text) {
  await page.evaluate((t) => {
    let b = document.getElementById("demo-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "demo-banner";
      Object.assign(b.style, {
        position: "fixed", top: "0", left: "0", right: "0", zIndex: "999999",
        background: "#0b7a3b", color: "#fff", font: "600 14px/1.5 system-ui, sans-serif",
        padding: "10px 16px", boxShadow: "0 2px 10px rgba(0,0,0,.3)"
      });
      document.body.appendChild(b);
    }
    b.textContent = "▶ " + t;
  }, text).catch(() => undefined);
}

async function highlight(page, selector) {
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await page.evaluate((sel) => {
    document.querySelectorAll("[data-demo-hl]").forEach((el) => {
      el.style.outline = ""; el.removeAttribute("data-demo-hl");
    });
    const el = document.querySelector(sel);
    if (el) { el.style.outline = "3px solid #ff6d00"; el.style.outlineOffset = "2px"; el.setAttribute("data-demo-hl", "1"); }
  }, selector).catch(() => undefined);
  if (HL_MS) await sleep(HL_MS);
}

function pickByText(options, wanted) {
  const want = String(wanted ?? "").trim().toLowerCase();
  const real = options.filter((o) => o.value !== "0");
  return (
    real.find((o) => o.label.toLowerCase() === want) ||
    real.find((o) => o.label.toLowerCase().includes(want)) ||
    real.find((o) => want.includes(o.label.toLowerCase())) ||
    real[0]
  );
}

async function options(page, selector) {
  return page.locator(selector).locator("option").evaluateAll((ns) =>
    ns.map((n) => ({ value: n.value, label: (n.textContent || "").trim() }))
  );
}

async function selectLike(page, selector, wanted) {
  await highlight(page, selector);
  const opt = pickByText(await options(page, selector), wanted);
  await page.locator(selector).selectOption(opt.value);
  if (!FAST) await sleep(250);
  return opt.label;
}

async function typeField(page, selector, value) {
  await highlight(page, selector);
  await page.locator(selector).fill(String(value ?? ""));
}

function absFile(value) {
  return value ? path.resolve(ROOT, value) : "";
}

async function run() {
  const browser = await chromium.launch({ channel: "chrome", headless: false, slowMo: SLOWMO });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  page.on("dialog", (d) => d.accept().catch(() => undefined));

  console.log(`=== DEMO: how the IISM autofiller works (local mock, nothing real)${FAST ? " — FAST MODE" : ""} ===`);
  const tStart = Date.now();
  await page.goto(FORM_URL, { waitUntil: "domcontentloaded" });

  note(1, "Open the form and select the Course (a postback on the real site).");
  await banner(page, "Step 1 — select Course");
  console.log("  Course -> " + await selectLike(page, "#ddlCourse", config.course));

  note(2, "Select Course Level and State.");
  await banner(page, "Step 2 — Course Level + State");
  console.log("  Level -> " + await selectLike(page, "#ddlCourseLevel", config.course_level));
  console.log("  State -> " + await selectLike(page, "#ddlState", config.state));

  note(3, "Fill every text field + education + diet. These survive postbacks (viewstate).");
  await banner(page, "Step 3 — fill personal details");
  const text = {
    "#txtName": config.name, "#txtFatherName": config.father_name, "#txtNationality": config.nationality,
    "#txtDomicile": config.domicile, "#txtHouseNoApartment": config.house_no_apartment,
    "#txtStreetVillageColony": config.street_village_colony, "#txtDistrictCity": config.district_city,
    "#txtPincode": config.pincode, "#txtMobileNo": config.mobile, "#txtEmailId": config.email,
    "#txtBloodGroup": config.blood_group, "#txtMedicalCategory": config.medical_category,
    "#txtHeight": config.height, "#txtWeight": config.weight, "#txtWaist": config.waist,
    "#txtShoeSize": config.shoe_size, "#txtEmergencyContactName": config.emergency_contact_name,
    "#txtEmergencyContactPhone": config.emergency_contact_phone
  };
  for (const [sel, val] of Object.entries(text)) await typeField(page, sel, val);
  await selectLike(page, "#ddlEduationQualification", config.education_qualification);
  await selectLike(page, "#ddlVegetarianOrNon", config.diet);

  note(4, "Select the Schedule. On the real site this is a POSTBACK that loads seats/fee");
  console.log("     and wipes file inputs + DOB — which is exactly why we do it BEFORE documents.");
  await banner(page, "Step 4 — select Schedule (postback: seats load, files/DOB wiped)");
  const sched = pickByText(await options(page, "#ddlScheduleCourse"),
    (config.preferred_schedules || [])[0] || "first");
  await highlight(page, "#ddlScheduleCourse");
  // From here on is the time-critical tail that races the vanishing seats.
  const tTail = Date.now();
  await page.locator("#ddlScheduleCourse").selectOption(sched.value);
  if (!FAST) await sleep(600);
  const seats = await page.locator("#txtAvailableSeat").inputValue();
  const fee = await page.locator("#txtCourseFee").inputValue();
  console.log(`  Schedule -> ${sched.label} | seats ${seats}, fee ${fee}`);

  note(5, "Set Date of Birth AFTER a schedule is chosen, so the site keeps it.");
  await banner(page, "Step 5 — Date of Birth (now it sticks)");
  await highlight(page, "#txtDateOfBirth");
  await page.locator("#txtDateOfBirth").fill(config.date_of_birth);
  await page.locator("#txtDateOfBirth").dispatchEvent("change");
  if (!FAST) await sleep(500);

  note(6, "RE-FILL GUARD: verify the viewstate fields survived the postbacks; restore any blank.");
  await banner(page, "Step 6 — verify fields survived (re-fill guard)");
  let restored = 0;
  for (const [sel, val] of Object.entries(text)) {
    const cur = (await page.locator(sel).inputValue().catch(() => "")).trim();
    if (cur !== String(val ?? "").trim()) { await page.locator(sel).fill(String(val ?? "")); restored += 1; }
  }
  console.log(`  Verified ${Object.keys(text).length} fields; restored ${restored} (0 = all survived).`);

  note(7, "Attach documents LAST — files are the only thing a reload truly wipes.");
  await banner(page, "Step 7 — attach documents last");
  const docs = config.documents || {};
  const docMap = {
    "#FupBirthCertificate": docs.birth_proof, "#FupDomicileAttachProof": docs.domicile_proof,
    "#FupEducationQualification": docs.education_proof, "#FupAnyAdventureCoursePhoto": docs.skiing_certificate,
    "#FupCurrentEmployment": docs.employment_proof, "#FupPhototOfApplicant": docs.applicant_photo,
    "#FupSignatureOfAppicant": docs.applicant_signature, "#FupParentGuardianSignature": docs.guardian_signature
  };
  let attached = 0;
  for (const [sel, val] of Object.entries(docMap)) {
    const file = absFile(val);
    if (file && fs.existsSync(file)) { await highlight(page, sel); await page.locator(sel).setInputFiles(file); attached += 1; }
  }
  console.log(`  Attached ${attached} document(s).`);

  note(8, "Tick the declaration, then click Submit.");
  await banner(page, "Step 8 — declaration + Submit");
  await highlight(page, "#chkIAgree");
  await page.locator("#chkIAgree").check();
  await highlight(page, "#btnSubmit");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => undefined),
    page.locator("#btnSubmit").click()
  ]);
  const tailMs = Date.now() - tTail;
  if (!FAST) await sleep(600);

  note(9, "Post-submit the site goes to ONLINE PAYMENT. The tool detects it and STOPS for you.");
  const url = page.url();
  const isPayment = /payment|razorpay|pay/i.test(url) || (await page.locator("#payment, #payNow").count()) > 0;
  await banner(page, isPayment ? "Step 9 — PAYMENT STEP: handed to you (no auto-pay)" : "Step 9 — submitted");
  console.log(isPayment
    ? `  Payment page detected (${url}). Automation stops here — you pay manually.`
    : `  Page moved to ${url}.`);

  console.log(`\nTiming: time-critical tail (schedule -> submit) = ${tailMs} ms; whole walkthrough = ${Date.now() - tStart} ms.`);
  if (!FAST) console.log("(This run included teaching slow-motion. Re-run with  node demo/demo.mjs --fast  for real speed.)");
  console.log("\n=== End of walkthrough. Nothing real was submitted or paid. ===");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter to close the demo browser... ");
  rl.close();
  await browser.close();
}

run().catch((e) => { console.error("Demo stopped:", e.message); process.exitCode = 1; });
