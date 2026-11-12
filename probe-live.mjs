// One-off dry run against the ACTUAL site, before the course goes live.
//
// The course dropdown is empty until 10:00, so we cannot touch course / level /
// schedule / DOB / documents yet. But the personal-detail TEXT fields exist on the
// real page right now, so this script fills just those so you can SEE the real form
// populate. Nothing is submitted. The browser stays open for you to inspect.
//
//   node probe-live.mjs
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

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

async function main() {
  console.log("Opening the ACTUAL IISM site (dry run — nothing will be submitted)...");
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage();
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Report whether the course list is live yet.
  const courses = await page
    .locator("#ddlCourse option")
    .allTextContents()
    .catch(() => []);
  const live = courses.filter((c) => c && !/select/i.test(c));
  console.log(
    live.length
      ? `Course dropdown IS live: ${live.join(" | ")}`
      : "Course dropdown is still EMPTY (intake not open yet) — filling personal fields only."
  );

  // Fill each visible text field one at a time so you can watch it happen.
  let filled = 0;
  let missing = 0;
  for (const [selector, value] of Object.entries(textFields)) {
    const el = page.locator(selector);
    if ((await el.count()) === 0) {
      console.log(`  (skip) ${selector} not present on the page`);
      missing += 1;
      continue;
    }
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      await el.fill(value == null ? "" : String(value), { timeout: 4000 });
      console.log(`  filled ${selector} -> ${value}`);
      filled += 1;
      await page.waitForTimeout(250); // visible pacing
    } catch (err) {
      console.log(`  (could not fill) ${selector}: ${err.message.split("\n")[0]}`);
      missing += 1;
    }
  }

  // Try the document uploads too, so we can see which file inputs the real page
  // accepts right now (including the parent/guardian signature).
  const docs = config.documents || {};
  const docMap = {
    "#FupBirthCertificate": docs.birth_proof,
    "#FupDomicileAttachProof": docs.domicile_proof,
    "#FupEducationQualification": docs.education_proof,
    "#FupAnyAdventureCoursePhoto": docs.skiing_certificate,
    "#FupCurrentEmployment": docs.employment_proof,
    "#FupPhototOfApplicant": docs.applicant_photo,
    "#FupSignatureOfAppicant": docs.applicant_signature,
    "#FupParentGuardianSignature": docs.guardian_signature
  };
  console.log("\nTrying document uploads on the real page:");
  let attached = 0;
  for (const [selector, value] of Object.entries(docMap)) {
    if (!value) {
      console.log(`  (none configured) ${selector}`);
      continue;
    }
    const file = path.resolve(ROOT, value);
    if (!fs.existsSync(file)) {
      console.log(`  (missing file) ${selector} -> ${value}`);
      continue;
    }
    const el = page.locator(selector);
    if ((await el.count()) === 0) {
      console.log(`  (input NOT on page) ${selector}`);
      continue;
    }
    try {
      await el.setInputFiles(file, { timeout: 4000 });
      const name = await el.evaluate((n) => (n.files && n.files[0] ? n.files[0].name : ""));
      console.log(`  attached ${selector} -> ${value}${name ? ` (file: ${name})` : ""}`);
      attached += 1;
      await page.waitForTimeout(200);
    } catch (err) {
      console.log(`  (could not attach) ${selector}: ${err.message.split("\n")[0]}`);
    }
  }
  console.log(`Attached ${attached} document(s).`);

  console.log(`\nDone. Filled ${filled} field(s); ${missing} not fillable yet.`);
  console.log("The browser is left open so you can inspect the real form. Press Ctrl+C here to close it.");

  // Keep the process (and browser) alive until the user stops it.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`\nProbe stopped: ${err.message}`);
  process.exitCode = 1;
});
