// =============================================================================
// EXPERIMENTAL — pure-HTTP session replay for the IISM admission form.
//
// Instead of driving a real Chrome window (see ../autofill.mjs), this script
// talks to the server directly with fetch, replaying the exact ASP.NET postback
// chain a browser would perform:
//
//   1. GET  the form                       -> fresh __VIEWSTATE / __EVENTVALIDATION
//   2. POST ddlCourse   (auto-postback)    -> populates level + schedule, new tokens
//   3. set  ddlCourseLevel (NOT a postback)
//   4. POST ddlState    (auto-postback)    -> new tokens
//   5. POST ddlScheduleCourse (auto-postback) -> seats, fee, allocation id, age rules
//   6. POST txtDateOfBirth    (auto-postback) -> age validated against schedule
//   7. POST (multipart) all fields + 8 files + btnSubmit=Submit  <-- the booking
//
// Why a browser is normally used: __VIEWSTATE, __EVENTVALIDATION and the
// hdfCapacitySheetAllocationId are per-session and regenerated on every hop, so
// a static payload is impossible. This script regenerates them live each run.
//
// SAFETY: the final booking POST (step 7) only fires when you pass --go AND
// config.submit is true. Without --go it stops right before submitting and
// prints the fully-assembled payload so you can verify it first.
//
// This is a secondary / experimental path. For the real booking day the proven
// browser flow (../autofill.mjs) remains the recommended primary.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createJar, parseInputs, parseSelect, inputValue, matchOption, fileBlob, mimeFor
} from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const CONFIG_PATH = process.env.IISM_CONFIG
  ? path.resolve(process.env.IISM_CONFIG)
  : path.join(PROJECT, "config.json");
const GO = process.argv.includes("--go"); // required to actually submit

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const jar = createJar();
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const stamp = () => new Date().toLocaleTimeString();
const projectFile = (rel) => (rel ? path.resolve(PROJECT, rel) : "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Transient "not ready yet" conditions (intake not open, no seats, submit not
// accepted, network blip). These are retried. A plain Error is treated as fatal
// (e.g. a config typo or missing document) and stops the loop immediately.
class RetryableError extends Error {}


// ---- low-level request helpers -------------------------------------------
async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Cookie: jar.header(), Accept: "text/html" },
    redirect: "manual"
  });
  jar.store(res);
  return res;
}

// A full ASP.NET postback: urlencoded body, __EVENTTARGET set to the control.
async function postback(url, state, eventTarget) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) body.append(k, v ?? "");
  body.set("__EVENTTARGET", eventTarget);
  body.set("__EVENTARGUMENT", "");
  body.set("__LASTFOCUS", "");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Cookie: jar.header(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html"
    },
    body: body.toString(),
    redirect: "manual"
  });
  jar.store(res);
  return res.text();
}

// Merge the freshly-rendered hidden tokens with the values we are choosing.
// parsed = inputs scraped from the latest HTML (fresh __VIEWSTATE etc.)
// overlay = the course/level/state/schedule/text/checkbox values we control.
function mergeState(parsed, overlay) {
  return { ...parsed, ...overlay };
}

async function attemptBooking() {
  const url = config.url;
  console.log(`[${stamp()}] GET form...`);
  let html = await (await get(url)).text();
  let parsed = parseInputs(html);

  // ---- resolve the dropdown option VALUES from their labels --------------
  const courseOpts = parseSelect(html, "ddlCourse");
  const courseValue = matchOption(courseOpts, config.course);
  if (!courseValue) {
    throw new RetryableError(
      `Course "${config.course}" not listed yet (intake not open). Available: ` +
        (courseOpts.filter((o) => o.value !== "0").map((o) => o.label).join(" | ") || "none")
    );
  }

  // The overlay carries everything we choose; it survives across postbacks.
  const overlay = {
    ddlCourse: courseValue,
    txtName: config.name,
    txtFatherName: config.father_name,
    txtNationality: config.nationality,
    txtDomicile: config.domicile ?? "",
    txtHouseNoApartment: config.house_no_apartment,
    txtStreetVillageColony: config.street_village_colony,
    txtDistrictCity: config.district_city,
    txtPincode: String(config.pincode),
    txtMobileNo: String(config.mobile),
    txtEmailId: config.email,
    txtBloodGroup: config.blood_group,
    txtMedicalCategory: config.medical_category ?? "",
    txtHeight: config.height ?? "",
    txtWeight: config.weight ?? "",
    txtWaist: config.waist ?? "",
    txtShoeSize: config.shoe_size ?? "",
    txtEmergencyContactName: config.emergency_contact_name,
    txtEmergencyContactPhone: String(config.emergency_contact_phone)
  };

  // 2) Course postback -> populates level + schedule dropdowns.
  console.log(`[${stamp()}] POST ddlCourse (${courseValue})...`);
  html = await postback(url, mergeState(parsed, overlay), "ddlCourse");
  parsed = parseInputs(html);

  // 3) Level (NOT an auto-postback) — just set it in the overlay.
  const levelValue = matchOption(parseSelect(html, "ddlCourseLevel"), config.course_level);
  if (!levelValue) throw new Error(`Course level "${config.course_level}" not found.`);
  overlay.ddlCourseLevel = levelValue;

  // 4) State postback.
  const stateValue = matchOption(parseSelect(html, "ddlState"), config.state);
  if (!stateValue) throw new Error(`State "${config.state}" not found.`);
  overlay.ddlState = stateValue;
  console.log(`[${stamp()}] POST ddlState (${stateValue})...`);
  html = await postback(url, mergeState(parsed, overlay), "ddlState");
  parsed = parseInputs(html);

  // Academic + diet selects (not auto-postback).
  const eduValue = matchOption(parseSelect(html, "ddlEduationQualification"), config.education_qualification);
  const dietValue = matchOption(parseSelect(html, "ddlVegetarianOrNon"), config.diet);
  if (!eduValue) throw new Error(`Education qualification "${config.education_qualification}" not found.`);
  if (!dietValue) throw new Error(`Diet "${config.diet}" not found.`);
  overlay.ddlEduationQualification = eduValue;
  overlay.ddlVegetarianOrNon = dietValue;

  // 5) Schedule postback — mints hdfCapacitySheetAllocationId, seats and fee.
  const schedOpts = parseSelect(html, "ddlScheduleCourse");
  const schedValue = pickSchedule(schedOpts);
  if (!schedValue) {
    throw new RetryableError(
      "No bookable schedule yet. Options: " +
        (schedOpts.filter((o) => o.value !== "0").map((o) => o.label).join(" | ") || "none")
    );
  }
  overlay.ddlScheduleCourse = schedValue;
  console.log(`[${stamp()}] POST ddlScheduleCourse (${schedValue})...`);
  html = await postback(url, mergeState(parsed, overlay), "ddlScheduleCourse");
  parsed = parseInputs(html);

  const seats = inputValue(html, "txtAvailableSeat");
  const fee = inputValue(html, "txtCourseFee");
  console.log(`[${stamp()}] Schedule reports seats="${seats}", fee="${fee}".`);
  const seatCount = Number((seats.match(/\d+/) ?? [NaN])[0]);
  if (!(seatCount > 0)) {
    throw new RetryableError(`Selected schedule reports ${seats || 0} seats — waiting for an opening.`);
  }

  // 6) Date-of-birth postback (validated against the schedule's age window).
  overlay.txtDateOfBirth = config.date_of_birth;
  console.log(`[${stamp()}] POST txtDateOfBirth (${config.date_of_birth})...`);
  html = await postback(url, mergeState(parsed, overlay), "txtDateOfBirth");
  parsed = parseInputs(html);

  // Declaration checkbox.
  overlay.chkIAgree = "on";

  // 7) Final multipart booking POST.
  const finalState = mergeState(parsed, overlay);
  finalState.__EVENTTARGET = "";
  finalState.__EVENTARGUMENT = "";
  finalState.btnSubmit = "Submit";

  const fd = new FormData();
  for (const [k, v] of Object.entries(finalState)) fd.append(k, v ?? "");
  await appendFiles(fd);

  if (!GO || !config.submit) {
    console.log(
      `\n[${stamp()}] DRY RUN — not submitting ` +
        `(${!config.submit ? "config.submit is false" : "pass --go to send"}).`
    );
    summarize(finalState);
    return { done: true, dryRun: true };
  }

  console.log(`[${stamp()}] Submitting booking POST (multipart, ${countFiles()} files)...`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": UA, Cookie: jar.header(), Accept: "text/html" },
    body: fd,
    redirect: "manual"
  });
  jar.store(res);
  const location = res.headers.get("location");

  // Success #1: a redirect — the booking was accepted and online payment follows.
  if (res.status >= 300 && res.status < 400 && location) {
    const payUrl = new URL(location, url).href;
    console.log(`[${stamp()}] Server responded ${res.status} -> ${payUrl}.`);
    console.log("Booking accepted. An ONLINE PAYMENT page follows.");
    console.log(`Open this URL in your browser to pay: ${payUrl}`);
    console.log("This tool never enters any payment details — complete the payment yourself.");
    return { done: true, submitted: true, payUrl };
  }

  const bodyText = await res.text();
  const stillOnForm = /name=["']btnSubmit["']/i.test(bodyText) || /name=["']ddlScheduleCourse["']/i.test(bodyText);

  // Success #2: a 200 that is NOT the form again (confirmation page). Treat as done
  // so we never re-submit and risk a double booking.
  if (res.status >= 200 && res.status < 300 && !stillOnForm) {
    const out = path.join(HERE, "last-response.html");
    fs.writeFileSync(out, bodyText);
    console.log(`[${stamp()}] Server responded 200 with a non-form page — booking likely accepted.`);
    console.log(`Saved the response to ${out}. If it is a payment/confirmation page, continue there.`);
    return { done: true, submitted: true };
  }

  // Otherwise the form came back (validation message / token refresh / overload).
  // Retry the whole chain from a fresh GET.
  const out = path.join(HERE, "last-response.html");
  fs.writeFileSync(out, bodyText);
  throw new RetryableError(
    `Submit not accepted (status ${res.status}, form re-rendered). Saved ${path.basename(out)}; retrying from a fresh session.`
  );
}

function pickSchedule(options) {
  const prefs = Array.isArray(config.preferred_schedules) ? config.preferred_schedules : [];
  for (const pref of prefs) {
    const v = matchOption(options, pref);
    if (v) return v;
  }
  if (config.accept_any_schedule !== false) {
    return options.find((o) => o.value && o.value !== "0")?.value ?? null;
  }
  return matchOption(options, config.schedule, { firstAvailable: true });
}

const DOC_TO_FIELD = {
  birth_proof: "FupBirthCertificate",
  domicile_proof: "FupDomicileAttachProof",
  education_proof: "FupEducationQualification",
  skiing_certificate: "FupAnyAdventureCoursePhoto",
  employment_proof: "FupCurrentEmployment",
  applicant_photo: "FupPhototOfApplicant",
  applicant_signature: "FupSignatureOfAppicant",
  guardian_signature: "FupParentGuardianSignature"
};

let fileCount = 0;
async function appendFiles(fd) {
  fileCount = 0;
  const docs = config.documents ?? {};
  for (const [key, field] of Object.entries(DOC_TO_FIELD)) {
    const rel = docs[key];
    if (rel) {
      const abs = projectFile(rel);
      if (!fs.existsSync(abs)) throw new Error(`Document not found: ${abs}`);
      fd.append(field, await fileBlob(abs), path.basename(abs));
      fileCount += 1;
    } else {
      // Mirror the browser: send an empty file part for untouched inputs.
      fd.append(field, new Blob([], { type: "application/octet-stream" }), "");
    }
  }
}
const countFiles = () => fileCount;

function summarize(state) {
  const show = Object.fromEntries(
    Object.entries(state).filter(([k]) => !/^__|_ClientState$|^vcer|^hdf/.test(k))
  );
  console.log("\nAssembled visible fields that would be POSTed:");
  console.log(JSON.stringify(show, null, 2));
  const files = Object.entries(config.documents ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${DOC_TO_FIELD[k]} <- ${v} (${mimeFor(v)})`);
  console.log("\nFile parts:");
  console.log(files.length ? files.map((f) => "  " + f).join("\n") : "  (none)");
  console.log(
    "\n(Plus the hidden __VIEWSTATE / __EVENTVALIDATION / hdf* / validator tokens, " +
      "captured live from the last page render.)"
  );
}

// Wait until (just before) the booking window opens, so you can start the script
// early and let it fire the moment the intake goes live.
async function waitUntilStart(poll) {
  if (!poll?.start_time) return;
  const start = new Date(poll.start_time).getTime();
  if (!Number.isFinite(start)) return;
  const lead = Number(poll.lead_seconds ?? 20) * 1000;
  const begin = start - lead;
  let remaining = begin - Date.now();
  if (remaining <= 0) return;
  console.log(
    `[${stamp()}] Window opens ${new Date(start).toLocaleString()}. ` +
      `Replaying will start at ${new Date(begin).toLocaleString()} (${Math.round(remaining / 1000)}s from now).`
  );
  while (remaining > 0) {
    await sleep(Math.min(30_000, remaining));
    remaining = begin - Date.now();
    if (remaining > 0) console.log(`[${stamp()}]   ...${Math.round(remaining / 1000)}s to go.`);
  }
}

// Retry loop: keep replaying the chain (fresh tokens every attempt) until the
// booking is accepted, a fatal config error occurs, or the deadline passes.
async function main() {
  const poll = config.poll ?? {};
  const intervalMs = Number(poll.interval_ms ?? 1000);
  const maxMinutes = Number(poll.max_minutes ?? 30);

  if (GO && config.submit) await waitUntilStart(poll);
  console.log(
    `fast-http ${GO && config.submit ? "LIVE (will submit)" : "DRY RUN (no submit)"} — ` +
      `retrying every ${Math.round(intervalMs / 1000 * 10) / 10}s for up to ${maxMinutes} min. Ctrl+C to stop.`
  );

  const deadline = Date.now() + maxMinutes * 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const result = await attemptBooking();
      if (result?.done) {
        if (result.submitted) console.log(`[${stamp()}] Done — booking submitted on attempt ${attempt}.`);
        return;
      }
    } catch (error) {
      if (error instanceof RetryableError) {
        console.log(`[${stamp()}] Attempt ${attempt}: ${error.message} Retrying...`);
      } else {
        console.error(`\n[${stamp()}] Fatal (not retrying): ${error.message}`);
        process.exitCode = 1;
        return;
      }
    }
    await sleep(intervalMs);
  }
  console.log(`[${stamp()}] Stopped after ${maxMinutes} min without a confirmed booking.`);
}

main().catch((error) => {
  console.error(`\nfast-http stopped: ${error.message}`);
  process.exitCode = 1;
});
