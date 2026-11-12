// Visualization helper for the IISM admission autofill.
//
// Opens a VISIBLE Chrome window, fills every field that does not depend on a live
// booking batch (course, level, state, all personal/identification fields), lists
// the schedules the site currently offers, saves a screenshot to
// `prefill-preview.png`, and leaves the window open so you can watch/inspect the
// result. It never submits and never touches payment.
//
// Run:  node visualize.mjs

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

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function normalize(value) {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function absoluteFile(value) {
  return value ? path.resolve(ROOT, value) : "";
}

async function setFile(page, selector, value, required = false) {
  const file = absoluteFile(value);
  if (!file) return required ? `${selector}: no path configured` : null;
  if (!fs.existsSync(file)) return `${selector}: file not found (${file})`;
  try {
    await page.locator(selector).setInputFiles(file);
    return null;
  } catch (error) {
    return `${selector}: ${error.message}`;
  }
}

// Attaches every configured document to its file input, exactly like the real run.
async function attachDocuments(page, docs = {}) {
  const problems = [];
  const jobs = [
    ["#FupBirthCertificate", docs.birth_proof, true],
    ["#FupDomicileAttachProof", docs.domicile_proof, false],
    ["#FupEducationQualification", docs.education_proof, true],
    ["#FupAnyAdventureCoursePhoto", docs.skiing_certificate, false],
    ["#FupCurrentEmployment", docs.employment_proof, false],
    ["#FupPhototOfApplicant", docs.applicant_photo, true],
    ["#FupSignatureOfAppicant", docs.applicant_signature, true],
    ["#FupParentGuardianSignature", docs.guardian_signature, false]
  ];
  let attached = 0;
  for (const [selector, value, required] of jobs) {
    const issue = await setFile(page, selector, value, required);
    if (issue) problems.push(issue);
    else if (value) attached += 1;
  }
  return { attached, problems };
}

async function listOptions(page, selector) {
  return page.locator(selector).locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, label: (node.textContent ?? "").trim() }))
  );
}

async function optionValue(page, selector, requested) {
  const options = await listOptions(page, selector);
  let match = options.find((option) => normalize(option.label) === normalize(requested));
  if (!match) {
    const needle = normalize(requested);
    const partial = options.filter(
      (option) => option.value !== "0" && normalize(option.label).includes(needle)
    );
    if (partial.length === 1) match = partial[0];
  }
  if (!match) {
    const choices = options.filter((option) => option.value !== "0").map((option) => option.label);
    throw new Error(`Cannot find "${requested}" in ${selector}. Available: ${choices.join(" | ") || "none"}`);
  }
  return match.value;
}

async function selectWithPostback(page, selector, requested) {
  const value = await optionValue(page, selector, requested);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined),
    page.locator(selector).selectOption(value)
  ]);
}

// Fills the text fields, education/diet, a preview date of birth and re-attaches
// every document. It deliberately does NOT touch Course/Level/State/Schedule so you
// can change those by hand. Because selecting those dropdowns triggers an ASP.NET
// postback that reloads the page and wipes the file inputs, this is registered to
// run again on every page load — so your documents reappear after each change.
async function applyPreviewFill(page, config) {
  const textFields = {
    "#txtName": config.name,
    "#txtFatherName": config.father_name,
    "#txtNationality": config.nationality,
    "#txtDomicile": config.domicile,
    "#txtHouseNoApartment": config.house_no_apartment,
    "#txtStreetVillageColony": config.street_village_colony,
    "#txtDistrictCity": config.district_city,
    "#txtPincode": String(config.pincode ?? ""),
    "#txtMobileNo": String(config.mobile ?? ""),
    "#txtEmailId": config.email,
    "#txtBloodGroup": config.blood_group,
    "#txtMedicalCategory": config.medical_category,
    "#txtHeight": config.height,
    "#txtWeight": config.weight,
    "#txtWaist": config.waist,
    "#txtShoeSize": config.shoe_size,
    "#txtEmergencyContactName": config.emergency_contact_name,
    "#txtEmergencyContactPhone": String(config.emergency_contact_phone ?? "")
  };
  for (const [selector, value] of Object.entries(textFields)) {
    await page.locator(selector).fill(String(value ?? "")).catch(() => undefined);
  }

  const eduValue = await optionValue(page, "#ddlEduationQualification", config.education_qualification).catch(() => null);
  if (eduValue) await page.locator("#ddlEduationQualification").selectOption(eduValue).catch(() => undefined);
  const dietValue = await optionValue(page, "#ddlVegetarianOrNon", config.diet).catch(() => null);
  if (dietValue) await page.locator("#ddlVegetarianOrNon").selectOption(dietValue).catch(() => undefined);

  // Date of birth, set WITHOUT firing change so it shows without a reload.
  const field = page.locator("#txtDateOfBirth");
  if ((await field.count()) > 0 && config.date_of_birth) {
    await field.evaluate((el, value) => {
      el.removeAttribute("readonly");
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, config.date_of_birth).catch(() => undefined);
  }

  const docResult = await attachDocuments(page, config.documents);
  return docResult;
}

async function run() {
  const config = readConfig();
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30_000);
  page.setDefaultTimeout(30_000);
  page.on("dialog", async (dialog) => {
    console.error(`Website message: ${dialog.message()}`);
    try {
      await dialog.accept();
    } catch {
      await dialog.dismiss().catch(() => undefined);
    }
  });

  console.log("Opening the IISM form in a visible Chrome window...");
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // The course/level/state dropdowns are empty whenever IISM has no live intake.
  // Fill them when possible, otherwise skip and still fill everything else so you
  // can preview your data on the real form.
  const courseOptions = (await listOptions(page, "#ddlCourse")).filter((option) => option.value !== "0");
  if (courseOptions.length === 0) {
    console.log("NOTE: the live site currently lists NO courses (intake not open right now).");
    console.log("      Course/Level/Schedule/State will be left blank; the rest is still filled.");
  } else {
    try {
      await selectWithPostback(page, "#ddlCourse", config.course);
      const levelValue = await optionValue(page, "#ddlCourseLevel", config.course_level);
      await page.locator("#ddlCourseLevel").selectOption(levelValue);
      await selectWithPostback(page, "#ddlState", config.state);
    } catch (error) {
      console.log(`NOTE: could not set course/level/state (${error.message}). Filling the rest anyway.`);
    }
  }

  const docResult = await applyPreviewFill(page, config);
  console.log(`Documents attached: ${docResult.attached}.`);
  if (docResult.problems.length) {
    console.log("Document issues:");
    for (const problem of docResult.problems) console.log(`  - ${problem}`);
  }

  // Re-apply the fill after every postback (e.g. when you change Course/State/
  // Schedule by hand) so the documents and fields are restored automatically.
  let reapplying = false;
  page.on("load", async () => {
    if (reapplying) return;
    if (!/admission_form\.aspx/i.test(page.url())) return; // left the form (e.g. payment)
    reapplying = true;
    try {
      const again = await applyPreviewFill(page, config);
      console.log(`[postback detected] Re-attached ${again.attached} document(s) and re-filled the fields.`);
    } catch {
      /* page mid-navigation; will catch the next load */
    } finally {
      reapplying = false;
    }
  });

  const schedules = (await listOptions(page, "#ddlScheduleCourse")).filter((option) => option.value !== "0");
  console.log(`Schedules currently offered: ${schedules.map((option) => option.label).join(" | ") || "none (booking not open yet)"}`);

  const shot = path.join(ROOT, "prefill-preview.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  console.log(`Screenshot saved to ${shot}`);
  console.log("The form is filled in the open Chrome window. Nothing was submitted; payment is untouched.");
  console.log("You can change Course/State/Schedule by hand — the documents re-attach automatically.");

  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  await input.question("Press Enter here to close the browser... ");
  input.close();
  await browser.close();
}

run().catch((error) => {
  console.error(`\nVisualization stopped: ${error.message}`);
  process.exitCode = 1;
});

