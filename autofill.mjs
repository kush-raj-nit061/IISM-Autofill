import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.IISM_CONFIG
  ? path.resolve(process.env.IISM_CONFIG)
  : path.join(ROOT, "config.json");
const CHECK_ONLY = process.argv.includes("--check");
const DISCOVER = process.argv.includes("--discover");
const SEATS_ONLY = process.argv.includes("--seats");
const RACE = process.argv.includes("--race");
const ALLOWED_DOC_EXTENSIONS = new Set([".pdf", ".gif", ".jpg", ".jpeg", ".png"]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function absoluteFile(value) {
  return value ? path.resolve(ROOT, value) : "";
}

function checkFile(label, value, { required = false, imageOnly = false, maxBytes = 1_048_576 } = {}) {
  if (!value) {
    if (required) throw new Error(`${label} is required.`);
    return;
  }
  const file = absoluteFile(value);
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`);
  const extension = path.extname(file).toLowerCase();
  const allowed = imageOnly ? ALLOWED_IMAGE_EXTENSIONS : ALLOWED_DOC_EXTENSIONS;
  if (!allowed.has(extension)) throw new Error(`${label} has an unsupported extension: ${extension}`);
  if (stat.size > maxBytes) {
    throw new Error(`${label} is ${(stat.size / 1024).toFixed(0)} KB; the limit is ${Math.round(maxBytes / 1024)} KB.`);
  }
}

function validate(config) {
  const required = [
    ["url", config.url], ["course", config.course], ["course_level", config.course_level],
    ["schedule", config.schedule], ["state", config.state], ["name", config.name],
    ["father_name", config.father_name], ["nationality", config.nationality],
    ["date_of_birth", config.date_of_birth], ["house_no_apartment", config.house_no_apartment],
    ["street_village_colony", config.street_village_colony], ["district_city", config.district_city],
    ["pincode", config.pincode], ["mobile", config.mobile], ["email", config.email],
    ["education_qualification", config.education_qualification], ["diet", config.diet],
    ["blood_group", config.blood_group], ["emergency_contact_name", config.emergency_contact_name],
    ["emergency_contact_phone", config.emergency_contact_phone]
  ];
  const missing = required.filter(([, value]) => !String(value ?? "").trim()).map(([name]) => name);
  if (missing.length) throw new Error(`Fill these config.json fields: ${missing.join(", ")}`);
  if (!/^https:\/\/admission\.iismgulmarg\.in\/admission_form\.aspx\?/i.test(config.url)) {
    throw new Error("url must be the official HTTPS IISM admission_form.aspx address.");
  }
  if (!/^(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(19|20)\d{2}$/.test(config.date_of_birth)) {
    throw new Error("date_of_birth must use dd/MM/yyyy, for example 31/12/2000.");
  }
  if (!/^\d{6}$/.test(String(config.pincode))) throw new Error("pincode must contain exactly 6 digits.");
  if (!/^\d{10}$/.test(String(config.mobile))) throw new Error("mobile must contain exactly 10 digits.");
  if (!/^\d{10}$/.test(String(config.emergency_contact_phone))) {
    throw new Error("emergency_contact_phone must contain exactly 10 digits.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) throw new Error("email is not valid.");
  if (!config.agree_to_declaration) throw new Error("agree_to_declaration must be true to fill the form.");

  const docs = config.documents ?? {};
  checkFile("birth_proof", docs.birth_proof, { required: true });
  checkFile("domicile_proof", docs.domicile_proof);
  checkFile("education_proof", docs.education_proof, { required: true });
  checkFile("skiing_certificate", docs.skiing_certificate);
  checkFile("employment_proof", docs.employment_proof);
  checkFile("applicant_photo", docs.applicant_photo, { required: true, imageOnly: true });
  checkFile("applicant_signature", docs.applicant_signature, { required: true, imageOnly: true, maxBytes: 512_000 });
  // Only required for applicants under 18; optional otherwise.
  checkFile("guardian_signature", docs.guardian_signature, { imageOnly: true, maxBytes: 512_000 });
}

function normalize(value) {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// Navigation timeout used by every postback wait. Bumped from config at startup so
// it can be raised on a slow/overloaded server (e.g. the 10:00 open rush).
let NAV_TIMEOUT_MS = 20_000;

// Throttle for logging the live course list when our target isn't matched yet.
let lastCourseLog = 0;

// A transient error where the PAGE IS STILL ALIVE but a postback/navigation tore
// down the JS execution context mid-read. These are safe to retry in place; they do
// NOT mean the tab crashed.
function isNavRace(message) {
  return /execution context was destroyed|because of a navigation|navigating and changing|frame was detached/i.test(
    message ?? ""
  );
}

// Runs an action, retrying a few times if it hits a navigation-race error. Waits for
// the page to settle between tries. Any non-nav-race error is rethrown immediately.
async function withNavRetry(page, action, tries = 4) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isNavRace(error.message)) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function listOptions(page, selector) {
  return withNavRetry(page, async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    return page.locator(selector).locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({ value: node.value, label: (node.textContent ?? "").trim() }))
    );
  });
}

async function optionValue(page, selector, requested, { firstAvailable = false, fuzzy = false } = {}) {
  // Dependent dropdowns (#ddlCourseLevel, #ddlState, #ddlScheduleCourse) are filled by
  // an ASP.NET postback that can lag badly under load, so the <select> is briefly empty.
  // Re-read it until real options appear instead of instantly failing on an empty list.
  const deadline = Date.now() + Math.min(NAV_TIMEOUT_MS, 15_000);
  let options = await listOptions(page, selector);
  while (!options.some((option) => option.value !== "0") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    options = await listOptions(page, selector);
  }
  let match;
  if (firstAvailable && normalize(requested) === "first_available") {
    match = options.find((option) => option.value !== "0");
  } else {
    match = options.find((option) => normalize(option.label) === normalize(requested));
    if (!match && fuzzy) {
      const needle = normalize(requested);
      const partial = options.filter(
        (option) =>
          option.value !== "0" &&
          (normalize(option.label).includes(needle) || needle.includes(normalize(option.label)))
      );
      if (partial.length === 1) match = partial[0];
    }
  }
  if (!match) {
    const choices = options.filter((option) => option.value !== "0").map((option) => option.label);
    throw new Error(`Cannot find "${requested}" in ${selector}. Available: ${choices.join(" | ") || "none"}`);
  }
  return match.value;
}

async function selectWithPostback(page, selector, requested, options = {}) {
  const value = await optionValue(page, selector, requested, options);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }),
    page.locator(selector).selectOption(value)
  ]);
}

// The DOB field fires an onchange postback that computes age/fee from the selected
// schedule. If no schedule is selected the server clears the value, so this must be
// called AFTER a schedule is chosen. Sets the value with the navigation wait already
// armed and verifies it stuck, retrying a couple of times.
async function fillDateOfBirth(page, date) {
  const field = page.locator("#txtDateOfBirth");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
      field.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, date)
    ]);
    const current = (await field.inputValue().catch(() => "")).trim();
    if (current === date) return;
  }
  throw new Error(
    "Could not set the date of birth (the site keeps clearing it). A course schedule must be selected first."
  );
}

async function setOptionalFile(page, selector, value) {
  if (value) await page.locator(selector).setInputFiles(absoluteFile(value));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stamp() {
  return new Date().toLocaleTimeString();
}

function parseSeatCount(value) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : NaN;
}

async function logDropdown(page, selector, title) {
  const options = (await listOptions(page, selector)).filter((option) => option.value !== "0");
  console.log(`${title}: ${options.map((option) => option.label).join(" | ") || "none"}`);
}

// Fills everything that survives an ASP.NET postback (viewstate-backed fields).
// Schedule, document uploads, the declaration and submit are handled later so the
// final, time-critical step is as short as possible. File inputs are intentionally
// left until the very end because any postback clears them.
async function openAndPrefill(page, config) {
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await selectWithPostback(page, "#ddlCourse", config.course, { fuzzy: true });

  const levelValue = await optionValue(page, "#ddlCourseLevel", config.course_level, { fuzzy: true });
  await page.locator("#ddlCourseLevel").selectOption(levelValue);
  await selectWithPostback(page, "#ddlState", config.state, { fuzzy: true });

  await fillPersonalDetails(page, config);
}

// The text fields plus the two non-postback dropdowns (education, diet). These are
// ASP.NET viewstate-backed, so they normally survive the course/state/schedule/DOB
// postbacks. This helper only writes a field when its current value differs, so it
// is safe to call again as a cheap "re-fill anything a postback cleared" guard right
// before the documents are attached and the form is submitted.
//
// Speed: every text field and both selects are set in ONE page.evaluate round-trip
// (plus two option lookups) instead of one network hop per field, so it adds only a
// few milliseconds to the time-critical path after a seat is found.
async function fillPersonalDetails(page, config) {
  const textFields = {
    "#txtName": config.name,
    "#txtFatherName": config.father_name,
    "#txtNationality": config.nationality,
    "#txtDomicile": config.domicile,
    "#txtHouseNoApartment": config.house_no_apartment,
    "#txtStreetVillageColony": config.street_village_colony,
    "#txtDistrictCity": config.district_city,
    "#txtPincode": String(config.pincode),
    "#txtMobileNo": String(config.mobile),
    "#txtEmailId": config.email,
    "#txtBloodGroup": config.blood_group,
    "#txtMedicalCategory": config.medical_category,
    "#txtHeight": config.height,
    "#txtWeight": config.weight,
    "#txtWaist": config.waist,
    "#txtShoeSize": config.shoe_size,
    "#txtEmergencyContactName": config.emergency_contact_name,
    "#txtEmergencyContactPhone": String(config.emergency_contact_phone)
  };
  const eduValue = await optionValue(page, "#ddlEduationQualification", config.education_qualification, { fuzzy: true });
  const dietValue = await optionValue(page, "#ddlVegetarianOrNon", config.diet, { fuzzy: true });
  await page.evaluate(({ fields, edu, diet }) => {
    const setText = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return;
      const want = value == null ? "" : String(value);
      if (el.value === want) return; // already correct — leave it (it survived)
      el.value = want;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    for (const [selector, value] of Object.entries(fields)) setText(selector, value);
    const setSelect = (selector, value) => {
      const el = document.querySelector(selector);
      if (el && el.value !== value) {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    setSelect("#ddlEduationQualification", edu);
    setSelect("#ddlVegetarianOrNon", diet);
  }, { fields: textFields, edu: eduValue, diet: dietValue });
}

// Builds the order in which schedules (batches) should be attempted: the preferred
// ones first (in the order listed), then every remaining batch in site order so the
// 1st batch is naturally favoured.
function orderedScheduleCandidates(options, config) {
  const available = options.filter((option) => option.value !== "0");
  const prefs = Array.isArray(config.preferred_schedules) ? config.preferred_schedules : [];
  const ordered = [];
  for (const pref of prefs) {
    const match = available.find(
      (option) => !ordered.includes(option) && normalize(option.label).includes(normalize(pref))
    );
    if (match) ordered.push(match);
  }
  if (config.accept_any_schedule !== false) {
    for (const option of available) if (!ordered.includes(option)) ordered.push(option);
  }
  return ordered;
}

// Selects the preferred batches in turn and returns the first one that reports
// available seats. Returns null when none of them has a free seat yet.
async function chooseScheduleWithSeats(page, config) {
  // Wait for the schedule dropdown to be populated by the course/level postback.
  const deadline = Date.now() + Math.min(NAV_TIMEOUT_MS, 15_000);
  let options = await listOptions(page, "#ddlScheduleCourse");
  while (!options.some((option) => option.value !== "0") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    options = await listOptions(page, "#ddlScheduleCourse");
  }
  const candidates = orderedScheduleCandidates(options, config);
  for (const candidate of candidates) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
      page.locator("#ddlScheduleCourse").selectOption(candidate.value)
    ]);
    const seatsRaw = (await page.locator("#txtAvailableSeat").inputValue()).trim();
    const feeRaw = (await page.locator("#txtCourseFee").inputValue()).trim();
    const seats = parseSeatCount(seatsRaw);
    if (Number.isFinite(seats) && seats > 0) {
      return { label: candidate.label, seats, fee: feeRaw };
    }
  }
  return null;
}

// Reads the live seat count (and fee) for every schedule/batch currently offered for
// the configured course + level. For each batch it selects it (which fires the
// ASP.NET postback that recalculates seats/fee), then reads #txtAvailableSeat and
// #txtCourseFee. Returns an array of { label, seats, seatsRaw, fee } rows.
async function readSeatBoard(page) {
  const options = (await listOptions(page, "#ddlScheduleCourse")).filter((option) => option.value !== "0");
  const rows = [];
  for (const option of options) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined),
      page.locator("#ddlScheduleCourse").selectOption(option.value)
    ]);
    let seatsRaw = "";
    let fee = "";
    try {
      seatsRaw = (await page.locator("#txtAvailableSeat").inputValue()).trim();
      fee = (await page.locator("#txtCourseFee").inputValue()).trim();
    } catch {
      /* field missing on this postback; leave blank */
    }
    rows.push({ label: option.label, seatsRaw, seats: parseSeatCount(seatsRaw), fee });
  }
  return rows;
}

// Pretty-prints the seat board as an aligned table on the terminal.
function printSeatBoard(config, rows) {
  const stampText = new Date().toLocaleString();
  const header = `Seat availability — ${stampText}`;
  console.log(`\n${"=".repeat(header.length)}`);
  console.log(header);
  console.log(`Course: ${config.course} / ${config.course_level}`);
  console.log("=".repeat(header.length));
  if (!rows.length) {
    console.log("No schedules are currently offered (the intake window may not be open yet).\n");
    return;
  }
  const labelWidth = Math.max(8, ...rows.map((row) => row.label.length));
  const seatWidth = Math.max(5, ...rows.map((row) => String(row.seatsRaw || "-").length));
  const pad = (text, width) => String(text).padEnd(width);
  console.log(`${pad("#", 3)}${pad("Schedule", labelWidth + 2)}${pad("Seats", seatWidth + 2)}Fee`);
  console.log("-".repeat(3 + labelWidth + 2 + seatWidth + 2 + 12));
  rows.forEach((row, index) => {
    const seatText = Number.isFinite(row.seats)
      ? (row.seats > 0 ? `${row.seats}` : "FULL")
      : (row.seatsRaw || "-");
    const marker = Number.isFinite(row.seats) && row.seats > 0 ? " ◄ open" : "";
    console.log(
      `${pad(index + 1, 3)}${pad(row.label, labelWidth + 2)}${pad(seatText, seatWidth + 2)}${row.fee || "-"}${marker}`
    );
  });
  const open = rows.filter((row) => Number.isFinite(row.seats) && row.seats > 0).length;
  console.log(`\n${open} of ${rows.length} batch(es) have open seats.\n`);
}

// Live seat monitor (--seats): opens the form, selects the configured course + level,
// then repeatedly prints the seat count for every batch on the terminal. Read-only —
// it never fills personal details, attaches documents or submits anything.
async function runSeatMonitor(config) {
  const poll = config.poll ?? {};
  // Use a calm refresh for watching (full reload + a postback per batch each cycle),
  // independent of the aggressive poll.interval_ms used for the booking race.
  const intervalMs = Number(poll.watch_interval_ms ?? 3000);
  // Start watching early — 15 minutes before the booking window by default, so you
  // can see seats filling up ahead of time. Override with poll.watch_lead_seconds.
  const watchLead = Number(poll.watch_lead_seconds ?? 15 * 60);
  await waitUntilStart(poll, { leadSeconds: watchLead, label: "Seat watching" });
  console.log(
    `Live seat monitor for "${config.course}" / "${config.course_level}". ` +
      `Refreshing every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`
  );
  console.log(
    "Before the window opens the batches are empty; each refresh reloads the live " +
      "page, so the moment they appear (around 10:00) they start showing here automatically."
  );

  const browser = await launchBrowser(config);
  try {
    const { page } = await createSession(browser, config);
    while (true) {
      try {
        await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

        // Stage 1 — is any course listed yet?
        const courses = (await listOptions(page, "#ddlCourse")).filter((option) => option.value !== "0");
        if (!courses.length) {
          console.log(`[${stamp()}] Waiting: no courses listed yet (intake not open). Re-checking in ${Math.round(intervalMs / 1000)}s...`);
          await sleep(intervalMs);
          continue;
        }

        // Stage 2 — is OUR course among them yet? (It can appear a moment after others.)
        const needle = normalize(config.course);
        const courseMatch = courses.find(
          (option) => normalize(option.label) === needle || normalize(option.label).includes(needle) || needle.includes(normalize(option.label))
        );
        if (!courseMatch) {
          console.log(
            `[${stamp()}] Waiting: "${config.course}" not listed yet. ` +
              `Currently available: ${courses.map((option) => option.label).join(" | ")}`
          );
          await sleep(intervalMs);
          continue;
        }

        // Stage 3 — select the course (fires the postback that fills level + schedule),
        // then apply the level. Both must be set before the schedule batches resolve.
        await selectWithPostback(page, "#ddlCourse", config.course, { fuzzy: true });
        const levelValue = await optionValue(page, "#ddlCourseLevel", config.course_level, { fuzzy: true });
        await page.locator("#ddlCourseLevel").selectOption(levelValue);

        // Stage 4 — read every batch's live seats. Empty = course/level set but the
        // schedule list hasn't been published yet.
        const rows = await readSeatBoard(page);
        if (!rows.length) {
          console.log(
            `[${stamp()}] Course "${config.course}" / "${config.course_level}" selected, ` +
              `but no schedule batches are published yet. Re-checking...`
          );
          await sleep(intervalMs);
          continue;
        }
        printSeatBoard(config, rows);
      } catch (error) {
        console.log(`[${stamp()}] Could not read seats this cycle (${error.message}). Retrying...`);
      }
      await sleep(intervalMs);
    }
  } finally {
    await browser.close();
  }
}

async function attachDocuments(page, docs) {
  await page.locator("#FupBirthCertificate").setInputFiles(absoluteFile(docs.birth_proof));
  await setOptionalFile(page, "#FupDomicileAttachProof", docs.domicile_proof);
  await page.locator("#FupEducationQualification").setInputFiles(absoluteFile(docs.education_proof));
  await setOptionalFile(page, "#FupAnyAdventureCoursePhoto", docs.skiing_certificate);
  await setOptionalFile(page, "#FupCurrentEmployment", docs.employment_proof);
  await page.locator("#FupPhototOfApplicant").setInputFiles(absoluteFile(docs.applicant_photo));
  await page.locator("#FupSignatureOfAppicant").setInputFiles(absoluteFile(docs.applicant_signature));
  await setOptionalFile(page, "#FupParentGuardianSignature", docs.guardian_signature);
}

// Safety net for when the fully-filled form is left open for you to review or adjust
// (for example you manually pick/change the Schedule because its exact label differs
// on the day). Any manual change to Course/State/Schedule/DOB fires an ASP.NET
// postback that reloads the page and the browser wipes the file inputs. This listener
// re-fills the viewstate fields, re-shows the DOB and re-attaches the documents after
// every such reload, so nothing is lost. It is only armed when the browser is handed
// to you — it never runs during the fast auto-submit path. All actions here are
// postback-free, so it cannot loop.
function armReattachGuard(page, config) {
  let busy = false;
  page.on("load", async () => {
    if (busy) return;
    if (!/admission_form\.aspx/i.test(page.url())) return; // left the form (e.g. payment)
    busy = true;
    try {
      await fillPersonalDetails(page, config);
      const dob = page.locator("#txtDateOfBirth");
      if ((await dob.count()) > 0 && config.date_of_birth) {
        await dob.evaluate((el, value) => {
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, config.date_of_birth).catch(() => undefined);
      }
      await attachDocuments(page, config.documents);
      console.log(`[${stamp()}] Manual change detected — re-filled fields and re-attached documents.`);
    } catch {
      /* page mid-navigation; the next load will retry */
    } finally {
      busy = false;
    }
  });
  console.log(
    `[${stamp()}] Safety net armed: if you change Course/State/Schedule/DOB by hand, the documents re-attach automatically.`
  );
}

async function submitForm(page) {
  await page.locator("#chkIAgree").check();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined),
    page.locator("#btnSubmit").click()
  ]);
}

// Looks for a captcha or other human-only challenge on the current page. Returns a
// short description when one is visible, otherwise null. It never tries to solve
// anything — captchas are meant to be solved by a person.
async function detectChallenge(page) {
  const probes = [
    ["iframe[src*='recaptcha' i]", "reCAPTCHA"],
    ["[class*='g-recaptcha' i]", "reCAPTCHA"],
    ["iframe[src*='hcaptcha' i]", "hCaptcha"],
    ["[class*='h-captcha' i]", "hCaptcha"],
    ["iframe[title*='captcha' i]", "captcha"],
    ["img[src*='captcha' i]", "image captcha"],
    ["[id*='captcha' i]", "captcha field"],
    ["[name*='captcha' i]", "captcha field"]
  ];
  for (const [selector, kind] of probes) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return kind;
      }
    } catch {
      /* selector not present on this page */
    }
  }
  return null;
}

// The site now takes an online payment after the form is submitted. This checks
// whether the current page is that payment step — either it has navigated to a
// known payment gateway/URL, or a pay/checkout control is visible on the page.
// Returns a short label when a payment step is detected, otherwise null. It never
// interacts with the payment page; paying is a human-only step.
async function detectPayment(page) {
  const url = page.url();
  if (/(^|[^a-z])(pay|payment|checkout|razorpay|payu|ccavenue|billdesk|paytm|instamojo|cashfree|phonepe|upi|netbanking|gateway|txn|transaction)([^a-z]|$)/i.test(url)) {
    return "online payment";
  }
  const probes = [
    "iframe[src*='razorpay' i]",
    "iframe[src*='payu' i]",
    "iframe[src*='ccavenue' i]",
    "iframe[src*='billdesk' i]",
    "iframe[src*='cashfree' i]",
    "iframe[src*='paytm' i]",
    "iframe[src*='phonepe' i]",
    "[id*='payment' i]",
    "[class*='payment' i]",
    "button:has-text('Pay Now')",
    "a:has-text('Pay Now')",
    "input[value*='Pay' i]",
    "button:has-text('Proceed to Pay')"
  ];
  for (const selector of probes) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        return "online payment";
      }
    } catch {
      /* selector not present on this page */
    }
  }
  return null;
}

// Stops all automation at the online-payment step and hands the open browser to the
// user. It NEVER fills or submits any payment details — card / UPI / net-banking must
// be completed by a person. Beeps, explains, and saves a screenshot for reference.
async function awaitManualPayment(config, page) {
  process.stdout.write("\u0007");
  console.log("\n================ PAYMENT STEP ================");
  console.log("The form was submitted and the site has moved to ONLINE PAYMENT.");
  console.log(`Current page: ${page.url()}`);
  console.log("Stopping here — please complete the payment yourself in the open Chrome window.");
  console.log("I will not enter any card / UPI / bank details.");
  console.log("=============================================\n");
  await page.screenshot({ path: path.join(ROOT, "payment-step.png"), fullPage: true }).catch(() => undefined);
}

// Hands control to the person: beeps, explains what to do, saves a screenshot, and
// then waits (watching the URL) until the form is submitted or a time limit passes.
async function awaitHumanCompletion(config, page, kind) {
  process.stdout.write("\u0007");
  console.log("\n================ ACTION NEEDED ================");
  console.log(`A ${kind} / manual step was detected after filling the form.`);
  console.log("Everything else is already filled in the open Chrome window.");
  console.log(`Please solve the ${kind} and click Submit there. I'll detect the result automatically.`);
  console.log("===============================================\n");
  await page.screenshot({ path: path.join(ROOT, "captcha-or-consent.png"), fullPage: true }).catch(() => undefined);

  const waitMs = Number(config.manual_step_timeout_ms ?? 5 * 60_000);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!/admission_form\.aspx/i.test(page.url())) {
      console.log(`[${stamp()}] Submission detected. Page moved to: ${page.url()}.`);
      await page.screenshot({ path: path.join(ROOT, "submission-result.png"), fullPage: true }).catch(() => undefined);
      return true;
    }
    await sleep(500);
  }
  console.log(`[${stamp()}] Did not detect a successful submit within the wait window; please finish manually.`);
  return false;
}

async function discover(page, config) {
  console.log("Opening the IISM form to list the exact dropdown labels...");
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await logDropdown(page, "#ddlCourse", "Courses");
  try {
    await selectWithPostback(page, "#ddlCourse", config.course, { fuzzy: true });
    await logDropdown(page, "#ddlCourseLevel", `Levels for "${config.course}"`);
    const levelValue = await optionValue(page, "#ddlCourseLevel", config.course_level, { fuzzy: true });
    await page.locator("#ddlCourseLevel").selectOption(levelValue);
    await logDropdown(page, "#ddlScheduleCourse", `Schedules for "${config.course}" / "${config.course_level}"`);
  } catch (error) {
    console.log(`Could not drill into the course/level you configured: ${error.message}`);
  }
  console.log("Copy the exact labels above into config.json (course, course_level, preferred_schedules).");
}

async function waitUntilStart(poll, { leadSeconds = null, label = "Probing" } = {}) {
  if (!poll.start_time) return;
  const start = new Date(poll.start_time).getTime();
  if (!Number.isFinite(start)) {
    console.log(`Ignoring invalid poll.start_time: ${poll.start_time}`);
    return;
  }
  const lead = Number(leadSeconds ?? poll.lead_seconds ?? 20) * 1000;
  const begin = start - lead;
  let remaining = begin - Date.now();
  if (remaining <= 0) return;
  console.log(
    `Booking opens ${new Date(start).toLocaleString()}. ${label} will start ` +
      `at ${new Date(begin).toLocaleString()} (${Math.round(remaining / 1000)}s from now).`
  );
  const chunk = 30_000;
  while (remaining > 0) {
    await sleep(Math.min(chunk, remaining));
    remaining = begin - Date.now();
    if (remaining > 0) console.log(`  ...${Math.round(remaining / 1000)}s until ${label.toLowerCase()} starts.`);
  }
}

function launchBrowser(config) {
  return chromium.launch({ channel: "chrome", headless: Boolean(config.headless) });
}

// Builds a fresh browser context + page with the dialog handler, timeouts and
// (optionally) heavy-resource blocking applied. Used on first run and whenever the
// session has to be rebuilt after a crash or server overload.
async function createSession(browser, config) {
  const context = await browser.newContext();
  await configureContext(context, config);
  const page = await context.newPage();
  preparePage(page, config);
  return { context, page };
}

// Applies optional heavy-resource blocking to a context.
async function configureContext(context, config) {
  if (config.poll?.block_images) {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });
  }
}

// Applies timeouts + the auto-accepting dialog handler to a page/tab.
function preparePage(page, config) {
  const navTimeout = Number(config.poll?.nav_timeout_ms ?? 30_000);
  page.setDefaultNavigationTimeout(navTimeout);
  page.setDefaultTimeout(navTimeout);
  page.on("dialog", async (dialog) => {
    console.error(`Website message: ${dialog.message()}`);
    try {
      await dialog.accept();
    } catch {
      try {
        await dialog.dismiss();
      } catch {
        /* dialog already handled */
      }
    }
  });
}

function isRecoverableCrash(message) {
  return /close|crash|disconnect|target|detached|destroyed/i.test(message ?? "");
}

async function keepBrowserOpenIfRequested(config) {
  if (!config.keep_browser_open) return;
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  await input.question("Press Enter here when you want to close the browser... ");
  input.close();
}

async function runPoller(config) {
  const poll = config.poll ?? {};
  const intervalMs = Number(poll.interval_ms ?? 1000);
  const maxMinutes = Number(poll.max_minutes ?? 30);
  await waitUntilStart(poll);

  const deadline = Date.now() + maxMinutes * 60_000;
  const prefs = Array.isArray(config.preferred_schedules) ? config.preferred_schedules : [];
  console.log(
    `Polling for "${config.course}" / "${config.course_level}" seats. ` +
      `Preferred batches: ${prefs.join(" | ") || "site order"}. ` +
      `Auto-submit: ${config.submit ? "ON" : "OFF (dry run)"}. ` +
      `Giving up after ${maxMinutes} min.`
  );

  let browser = await launchBrowser(config);
  let session = await createSession(browser, config);
  let attempt = 0;
  let loggedSchedules = false;
  let submitStuck = 0;
  const maxSubmitStuck = Number(poll.max_submit_retries ?? 3);
  try {
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        if (!browser.isConnected()) {
          console.log(`[${stamp()}] Browser is not connected; relaunching...`);
          browser = await launchBrowser(config);
          session = await createSession(browser, config);
        }
        const page = session.page;
        await openAndPrefill(page, config);
        if (!loggedSchedules) {
          await logDropdown(page, "#ddlScheduleCourse", "Schedules currently offered");
          loggedSchedules = true;
        }
        const hit = await chooseScheduleWithSeats(page, config);
        if (hit) {
          console.log(`[${stamp()}] SEATS OPEN for "${hit.label}": ${hit.seats} seat(s), fee ${hit.fee}.`);
          await fillDateOfBirth(page, config.date_of_birth);
          // The schedule + DOB selections each fired a postback. Re-fill the
          // viewstate-backed fields in case any was cleared, then attach documents
          // LAST (file inputs are the only thing a reload truly wipes).
          await fillPersonalDetails(page, config);
          await attachDocuments(page, config.documents);
          if (!config.submit) {
            console.log(
              `[${stamp()}] Dry run (submit=false): form is fully filled for "${hit.label}". ` +
                `Review it and click Submit yourself, or set submit=true for automatic submission.`
            );
            armReattachGuard(page, config);
            await keepBrowserOpenIfRequested(config);
            return;
          }

          // A captcha may sit on the form itself; if so, let the person solve it.
          const preChallenge = await detectChallenge(page);
          if (preChallenge) {
            await awaitHumanCompletion(config, page, preChallenge);
            await keepBrowserOpenIfRequested(config);
            return;
          }

          console.log(`[${stamp()}] Submitting now...`);
          await submitForm(page);
          const url = page.url();
          await page.screenshot({ path: path.join(ROOT, "submission-result.png"), fullPage: true }).catch(() => undefined);

          // The site now charges online right after submitting. If a payment step
          // appeared (gateway redirect or a pay button), stop and let the user pay.
          const payment = await detectPayment(page);
          if (payment) {
            await awaitManualPayment(config, page);
            await keepBrowserOpenIfRequested(config);
            return;
          }
          if (!/admission_form\.aspx/i.test(url)) {
            console.log(`[${stamp()}] Submitted. Page moved to: ${url}. Screenshot saved to submission-result.png.`);
            console.log(`[${stamp()}] If an online payment page opens, please complete the payment yourself.`);
            await keepBrowserOpenIfRequested(config);
            return;
          }

          // Still on the form after clicking Submit. If a captcha/consent appeared,
          // or we keep getting bounced back, bring the human in instead of blindly
          // retrying and burning the attempt.
          submitStuck += 1;
          const inlinePayment = await detectPayment(page);
          if (inlinePayment) {
            await awaitManualPayment(config, page);
            await keepBrowserOpenIfRequested(config);
            return;
          }
          const postChallenge = await detectChallenge(page);
          if (postChallenge || submitStuck >= maxSubmitStuck) {
            const reason = postChallenge ?? "a manual step or repeated validation message";
            await awaitHumanCompletion(config, page, reason);
            await keepBrowserOpenIfRequested(config);
            return;
          }
          console.log(
            `[${stamp()}] Clicked Submit but still on the form (possible validation/overload message). ` +
              `Screenshot saved to submission-result.png. Retrying (${submitStuck}/${maxSubmitStuck})...`
          );
        } else {
          console.log(`[${stamp()}] No open seats yet (attempt ${attempt}). Refreshing...`);
        }
      } catch (error) {
        console.log(`[${stamp()}] Attempt ${attempt} could not complete (${error.message}). Retrying...`);
        if (isRecoverableCrash(error.message)) {
          console.log(`[${stamp()}] Rebuilding the browser session after a crash/overload...`);
          try {
            await session.context.close();
          } catch {
            /* context already gone */
          }
          try {
            if (!browser.isConnected()) browser = await launchBrowser(config);
            session = await createSession(browser, config);
          } catch (rebuildError) {
            console.log(`[${stamp()}] Could not rebuild the session yet (${rebuildError.message}); will retry.`);
          }
        }
      }
      await sleep(intervalMs);
    }
    console.log(`Stopped after ${maxMinutes} minute(s) without securing a seat.`);
    await keepBrowserOpenIfRequested(config);
  } finally {
    try {
      await browser.close();
    } catch {
      /* browser already closed */
    }
  }
}

// Clicks the form's Reset button — a cheap ASP.NET postback that re-runs the
// server's Page_Load and so re-pulls the course list, WITHOUT a full page reload
// (keeps the warm session). Returns true when the configured course is now listed.
async function resetAndCheckCourse(page, config) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    page.locator("#btnReset").click({ timeout: NAV_TIMEOUT_MS })
  ]);
  const needle = normalize(config.course);
  const courses = (await listOptions(page, "#ddlCourse")).filter((option) => option.value !== "0");
  // Distinctive words from the configured course (drop generic/short filler words).
  const stop = new Set(["course", "courses", "the", "and", "for", "with", "at", "of", "in"]);
  const tokens = needle.split(" ").filter((word) => word.length > 3 && !stop.has(word));
  const matched = courses.some((option) => {
    const label = normalize(option.label);
    if (label === needle || label.includes(needle) || needle.includes(label)) return true;
    // Fuzzy fallback: the live label just needs to share almost all distinctive words
    // (handles singular/plural or reworded labels like "Snow Skiing Course - Gulmarg").
    const hits = tokens.filter((word) => label.includes(word)).length;
    return tokens.length > 0 && hits >= Math.max(1, tokens.length - 1);
  });
  if (!matched && courses.length && Date.now() - lastCourseLog > 8000) {
    lastCourseLog = Date.now();
    console.log(`[${stamp()}] available courses right now: ${courses.map((option) => option.label).join(" | ")}`);
  }
  return matched;
}

// Race mode (--race): the "many tabs + Reset to refresh" strategy. It opens
// `poll.tabs` tabs INSIDE A SINGLE browser window (one shared context) and has each
// one hammer the Reset button to refresh courses. Using one context (instead of one
// window per tab) means (a) it's a single window you can minimise, and (b) Playwright
// drives the background tabs without stealing focus or flipping the active tab, so
// you can keep using your computer. The first tab to see the course live fills +
// books on that tab. A booking lock ensures only ONE tab ever submits (no double
// booking); if the winning tab crashes or its submit bounces, the lock is released
// and another tab takes over.
async function runRacePoller(config) {
  const poll = config.poll ?? {};
  const tabs = Math.max(1, Number(poll.tabs ?? 8));
  const intervalMs = Number(poll.interval_ms ?? 800);
  const maxMinutes = Number(poll.max_minutes ?? 30);
  const navTimeout = Number(poll.nav_timeout_ms ?? 30_000);
  NAV_TIMEOUT_MS = navTimeout;
  await waitUntilStart(poll);
  console.log(
    `Race mode: ${tabs} tabs in ONE window, Reset-to-refresh for "${config.course}" / "${config.course_level}". ` +
      `Auto-submit: ${config.submit ? "ON" : "OFF (dry run)"}. Giving up after ${maxMinutes} min.`
  );
  console.log("Tip: you can minimise the browser window — the tabs run in the background and won't steal focus.");

  const browser = await launchBrowser(config);
  const context = await browser.newContext();
  await configureContext(context, config);
  const deadline = Date.now() + maxMinutes * 60_000;
  const shared = { finished: false, booking: false };

  const openTab = async () => {
    const page = await context.newPage();
    preparePage(page, config);
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => undefined);
    return page;
  };

  async function worker(index) {
    const tag = `tab ${index + 1}`;
    let page = await openTab();
    let attempt = 0;
    let lastBeat = 0;
    while (!shared.finished && Date.now() < deadline) {
      attempt += 1;
      try {
        if (!browser.isConnected()) break; // whole browser gone; give up this worker
        if (page.isClosed()) {
          page = await openTab();
          continue;
        }

        // Refresh the course list via Reset (the pro-tip move).
        const ready = await resetAndCheckCourse(page, config);
        if (!ready) {
          if (Date.now() - lastBeat > 10_000) {
            console.log(`[${stamp()}] ${tag}: probing (attempt ${attempt}) — course not live yet.`);
            lastBeat = Date.now();
          }
          await sleep(intervalMs);
          continue;
        }
        console.log(`[${stamp()}] ${tag}: course is LIVE — filling...`);

        // Fill the viewstate-backed parts and find a schedule with seats.
        await selectWithPostback(page, "#ddlCourse", config.course, { fuzzy: true });
        const levelValue = await optionValue(page, "#ddlCourseLevel", config.course_level, { fuzzy: true });
        await page.locator("#ddlCourseLevel").selectOption(levelValue);
        await selectWithPostback(page, "#ddlState", config.state, { fuzzy: true });
        await fillPersonalDetails(page, config);
        const hit = await chooseScheduleWithSeats(page, config);
        if (!hit) {
          console.log(`[${stamp()}] ${tag}: course live but no open seats yet. Resetting...`);
          await sleep(intervalMs);
          continue;
        }

        // Only one tab may enter the booking critical section at a time.
        if (shared.finished) return;
        if (shared.booking) {
          await sleep(200);
          continue;
        }
        shared.booking = true;
        try {
          console.log(`[${stamp()}] ${tag}: SEATS OPEN "${hit.label}" (${hit.seats}, fee ${hit.fee}). Booking on this tab.`);
          await fillDateOfBirth(page, config.date_of_birth);
          await fillPersonalDetails(page, config);
          await attachDocuments(page, config.documents);

          if (!config.submit) {
            console.log(`[${stamp()}] ${tag}: dry run (submit=false) — form filled, not submitting. Keeping THIS tab open.`);
            shared.finished = true;
            armReattachGuard(page, config);
            await keepBrowserOpenIfRequested(config);
            return;
          }

          const preChallenge = await detectChallenge(page);
          if (preChallenge) {
            shared.finished = true;
            await awaitHumanCompletion(config, page, preChallenge);
            await keepBrowserOpenIfRequested(config);
            return;
          }

          console.log(`[${stamp()}] ${tag}: submitting...`);
          await submitForm(page);
          await page.screenshot({ path: path.join(ROOT, "submission-result.png"), fullPage: true }).catch(() => undefined);

          const payment = await detectPayment(page);
          if (payment) {
            shared.finished = true;
            await awaitManualPayment(config, page);
            await keepBrowserOpenIfRequested(config);
            return;
          }
          if (!/admission_form\.aspx/i.test(page.url())) {
            shared.finished = true;
            console.log(`[${stamp()}] ${tag}: submitted. Page moved to: ${page.url()}.`);
            console.log(`[${stamp()}] If an online payment page opens, please complete the payment yourself.`);
            await keepBrowserOpenIfRequested(config);
            return;
          }

          // Submit bounced back to the form — release the lock so another tab tries.
          console.log(`[${stamp()}] ${tag}: submit bounced (validation/overload). Releasing to other tabs.`);
          shared.booking = false;
        } catch (bookError) {
          console.log(`[${stamp()}] ${tag}: booking failed (${bookError.message}). Handing to another tab.`);
          shared.booking = false;
        }
      } catch (error) {
        const firstLine = (error.message ?? "").split("\n")[0];
        if (isNavRace(error.message) && !page.isClosed()) {
          // Page is still alive; a postback just tore down the context under load.
          // Wait for it to settle and retry in place — do NOT rebuild the tab.
          await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
          console.log(`[${stamp()}] ${tag}: busy page (navigation) — retrying in place.`);
        } else {
          console.log(`[${stamp()}] ${tag}: attempt ${attempt} error (${firstLine}). Rebuilding this tab...`);
          if (isRecoverableCrash(error.message)) {
            try { await page.close(); } catch { /* already gone */ }
            try {
              if (!browser.isConnected()) break;
              page = await openTab();
            } catch { /* will retry */ }
          }
        }
      }
      await sleep(intervalMs);
    }
  }

  try {
    await Promise.all(Array.from({ length: tabs }, (_, index) => worker(index)));
    if (!shared.finished) console.log(`Stopped after ${maxMinutes} minute(s) without securing a seat across ${tabs} tabs.`);
  } finally {
    try {
      await browser.close();
    } catch {
      /* browser already closed */
    }
  }
}

async function runOnce(page, config) {
  console.log("Opening the IISM form...");
  await openAndPrefill(page, config);
  await selectWithPostback(page, "#ddlScheduleCourse", config.schedule, { firstAvailable: true });
  await fillDateOfBirth(page, config.date_of_birth);
  // Re-fill after the schedule + DOB postbacks, then attach documents last.
  await fillPersonalDetails(page, config);
  await attachDocuments(page, config.documents);
  await page.locator("#chkIAgree").check();

  const seatsRaw = (await page.locator("#txtAvailableSeat").inputValue()).trim();
  const fee = (await page.locator("#txtCourseFee").inputValue()).trim();
  console.log(`Form filled. Available seats: ${seatsRaw}; course fee: ${fee}.`);

  if (config.submit) {
    if (!(parseSeatCount(seatsRaw) > 0)) {
      throw new Error("The selected schedule reports 0 available seats; refusing to submit.");
    }
    const challenge = await detectChallenge(page);
    if (challenge) {
      await awaitHumanCompletion(config, page, challenge);
      return;
    }
    console.log("Submitting because config.json has submit=true...");
    await submitForm(page);
    const payment = await detectPayment(page);
    if (payment) {
      await awaitManualPayment(config, page);
      return;
    }
    console.log(`Submission action completed. Current page: ${page.url()}`);
    console.log("If an online payment page opens, please complete the payment yourself.");
  } else {
    armReattachGuard(page, config);
    console.log("Review the open form and click Submit yourself, or set submit=true for automatic submission.");
  }
}

async function main() {
  const config = readConfig();
  validate(config);
  console.log("Configuration and documents are valid.");
  if (CHECK_ONLY) return;

  if (SEATS_ONLY) {
    await runSeatMonitor(config);
    return;
  }

  if (RACE) {
    await runRacePoller(config);
    return;
  }

  if (config.poll?.enabled && !DISCOVER) {
    await runPoller(config);
    return;
  }

  const browser = await launchBrowser(config);
  try {
    const { page } = await createSession(browser, config);
    if (DISCOVER) {
      await discover(page, config);
    } else {
      await runOnce(page, config);
    }
    await keepBrowserOpenIfRequested(config);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\nAutofill stopped: ${error.message}`);
  process.exitCode = 1;
});
