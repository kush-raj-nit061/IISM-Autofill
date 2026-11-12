// IISM Gulmarg admission-form autofiller — content script.
//
// The site is ASP.NET WebForms: changing certain dropdowns (course, state,
// schedule) and the date-of-birth field triggers a full-page postback/reload.
// A content script's JS context is destroyed on every reload, so this script is
// written to be RESUMABLE: on each page load it inspects what is already filled
// and performs only the next outstanding action. The whole fill therefore walks
// itself forward across the series of postbacks until everything is done.
//
// Browser security note: file <input> values CANNOT be set by any extension, so
// the document upload fields are only highlighted for the user to attach manually.

(() => {
  "use strict";

  // Maps a stored document key to the form's file-input selector, in the order
  // they appear on the page.
  const DOC_FIELDS = [
    { key: "birth_proof", selector: "#FupBirthCertificate" },
    { key: "domicile_proof", selector: "#FupDomicileAttachProof" },
    { key: "education_proof", selector: "#FupEducationQualification" },
    { key: "skiing_certificate", selector: "#FupAnyAdventureCoursePhoto" },
    { key: "employment_proof", selector: "#FupCurrentEmployment" },
    { key: "applicant_photo", selector: "#FupPhototOfApplicant" },
    { key: "applicant_signature", selector: "#FupSignatureOfAppicant" },
    { key: "guardian_signature", selector: "#FupParentGuardianSignature" }
  ];

  function norm(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function toast(message, isError) {
    let box = document.getElementById("iism-autofill-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "iism-autofill-toast";
      Object.assign(box.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: "2147483647",
        maxWidth: "320px",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "13px/1.4 system-ui, sans-serif",
        color: "#fff",
        boxShadow: "0 4px 14px rgba(0,0,0,.25)"
      });
      document.body.appendChild(box);
    }
    box.style.background = isError ? "#b00020" : "#1565c0";
    box.textContent = message;
  }

  // Find the best matching <option> for a requested value.
  function matchOption(select, requested) {
    const opts = Array.from(select.options);
    const want = norm(requested);
    // Exact label or value match first.
    let m = opts.find((o) => norm(o.textContent) === want || norm(o.value) === want);
    if (m) return m;
    // Unique/first substring match, ignoring placeholder options.
    const real = opts.filter((o) => o.value && o.value !== "0" && norm(o.textContent) !== "select");
    const subs = real.filter((o) => norm(o.textContent).includes(want));
    return subs[0] || null;
  }

  function firstRealOption(select) {
    return Array.from(select.options).find(
      (o) => o.value && o.value !== "0" && norm(o.textContent) !== "select"
    ) || null;
  }

  // Choose a schedule/batch: first preferred match, else the first available batch.
  function pickSchedule(select, profile) {
    const real = Array.from(select.options).filter(
      (o) => o.value && o.value !== "0" && norm(o.textContent) !== "select"
    );
    const prefs = Array.isArray(profile.preferred_schedules) ? profile.preferred_schedules : [];
    for (const pref of prefs) {
      const hit = real.find((o) => norm(o.textContent).includes(norm(pref)));
      if (hit) return hit;
    }
    return real[0] || null;
  }

  // Set a <select> value and fire change (triggers the ASP.NET postback if any).
  function setSelect(select, option) {
    if (!option || select.value === option.value) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setText(el, value) {
    if (!el) return;
    el.value = value == null ? "" : String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillTextFields(profile) {
    const map = {
      "#txtName": profile.name,
      "#txtFatherName": profile.father_name,
      "#txtNationality": profile.nationality,
      "#txtDomicile": profile.domicile,
      "#txtHouseNoApartment": profile.house_no_apartment,
      "#txtStreetVillageColony": profile.street_village_colony,
      "#txtDistrictCity": profile.district_city,
      "#txtPincode": profile.pincode,
      "#txtMobileNo": profile.mobile,
      "#txtEmailId": profile.email,
      "#txtBloodGroup": profile.blood_group,
      "#txtMedicalCategory": profile.medical_category,
      "#txtHeight": profile.height,
      "#txtWeight": profile.weight,
      "#txtWaist": profile.waist,
      "#txtShoeSize": profile.shoe_size,
      "#txtEmergencyContactName": profile.emergency_contact_name,
      "#txtEmergencyContactPhone": profile.emergency_contact_phone
    };
    for (const [selector, value] of Object.entries(map)) {
      const el = document.querySelector(selector);
      if (el) setText(el, value);
    }
    const edu = document.querySelector("#ddlEduationQualification");
    if (edu) {
      const opt = matchOption(edu, profile.education_qualification);
      if (opt) setSelect(edu, opt);
    }
    const diet = document.querySelector("#ddlVegetarianOrNon");
    if (diet) {
      const opt = matchOption(diet, profile.diet);
      if (opt) setSelect(diet, opt);
    }
  }

  // Rebuild a File from a stored data URL.
  function dataUrlToFile(dataUrl, filename) {
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(0, comma);
    const b64 = dataUrl.slice(comma + 1);
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }

  // Inject a saved file into a form file-input via DataTransfer. This is allowed
  // because the file was chosen by the user earlier (in the popup), not fabricated.
  function setFileInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.files.length === 1;
  }

  // Attach every stored document; outline any upload box that has no saved file.
  function attachDocuments(documents) {
    let attached = 0;
    let missing = 0;
    for (const { key, selector } of DOC_FIELDS) {
      const input = document.querySelector(selector);
      if (!input) continue;
      const doc = documents && documents[key];
      if (doc && doc.dataUrl) {
        try {
          if (setFileInput(input, dataUrlToFile(doc.dataUrl, doc.name || key))) {
            input.style.outline = "3px solid #2e7d32";
            input.style.outlineOffset = "2px";
            attached += 1;
            continue;
          }
        } catch (_err) {
          // fall through to highlight as missing
        }
      }
      input.style.outline = "3px solid #ff6d00";
      input.style.outlineOffset = "2px";
      missing += 1;
    }
    return { attached, missing };
  }

  // Perform the next outstanding step. Returns true when fully filled.
  function runStep(profile, documents) {
    const course = document.querySelector("#ddlCourse");
    if (!course) return false; // not the form yet

    // 1) Course (postback).
    const courseOpt = matchOption(course, profile.course);
    if (!courseOpt) {
      toast(`Course "${profile.course}" not found in the list. Pick it manually.`, true);
      return false;
    }
    if (setSelect(course, courseOpt)) return false; // reload incoming

    // 2) Course level (no postback).
    const level = document.querySelector("#ddlCourseLevel");
    if (level) {
      const levelOpt = matchOption(level, profile.course_level) || firstRealOption(level);
      setSelect(level, levelOpt);
    }

    // 3) State (postback).
    const state = document.querySelector("#ddlState");
    if (state) {
      const stateOpt = matchOption(state, profile.state);
      if (setSelect(state, stateOpt)) return false; // reload incoming
    }

    // 4) Schedule / batch (postback — also updates seats & fee).
    const schedule = document.querySelector("#ddlScheduleCourse");
    if (schedule) {
      const schedOpt = pickSchedule(schedule, profile);
      if (!schedOpt) {
        toast("No bookable batch is available yet for this course.", true);
        return false;
      }
      if (setSelect(schedule, schedOpt)) return false; // reload incoming
    }

    // 5) Text fields + education + diet (no postback).
    fillTextFields(profile);

    // 6) Date of birth LAST (postback that needs a schedule already selected).
    const dob = document.querySelector("#txtDateOfBirth");
    if (dob && profile.date_of_birth && norm(dob.value) !== norm(profile.date_of_birth)) {
      setText(dob, profile.date_of_birth);
      return false; // reload incoming
    }

    // 7) Done — declaration + document attachment.
    if (profile.agree_to_declaration) {
      const agree = document.querySelector("#chkIAgree");
      if (agree && !agree.checked) {
        agree.click();
      }
    }
    const docResult = attachDocuments(documents);
    const seats = document.querySelector("#txtAvailableSeat");
    const fee = document.querySelector("#txtCourseFee");
    const extra = seats ? ` Seats: ${seats.value || "?"}, fee: ${fee ? fee.value : "?"}.` : "";
    const docMsg = docResult.missing
      ? `${docResult.attached} document(s) attached, ${docResult.missing} still needed (orange boxes).`
      : `${docResult.attached} document(s) attached.`;
    toast(`Form filled.${extra} ${docMsg} Review, submit & pay online.`, docResult.missing > 0);
    return true;
  }

  function start() {
    chrome.storage.local.get(["active", "profile", "documents"], ({ active, profile, documents }) => {
      if (!active || !profile) return;
      try {
        const done = runStep(profile, documents || {});
        if (done) chrome.storage.local.set({ active: false });
      } catch (err) {
        toast("Autofill error: " + (err && err.message ? err.message : err), true);
      }
    });
  }

  // Let the popup kick off a fill without needing a reload.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "iism-start") {
      start();
      sendResponse({ ok: true });
    }
    return true;
  });

  // Auto-resume on every (post-back) page load.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
