// Popup logic: edit the profile, persist it, and trigger a fill on the open form.

const DEFAULT_PROFILE = {
  course: "Snow Skiing Courses at Gulmarg",
  course_level: "Basic SSC",
  preferred_schedules: ["20 dec", "03 jan", "17 jan", "31 jan", "14 feb", "28 feb"],
  state: "bihar",
  name: "Kush Raj",
  father_name: "Badri Prasad",
  nationality: "Indian",
  date_of_birth: "05/12/2004",
  domicile: "Daudnagar, Bihar",
  house_no_apartment: "Golcha Ice Factory, Daudnagar",
  street_village_colony: "nearby prerna classes",
  district_city: "Aurangabad",
  pincode: "824113",
  mobile: "8890498744",
  email: "kushpvt1@gmail.com",
  education_qualification: "Graduation",
  diet: "non-vegetarian",
  blood_group: "O+",
  medical_category: "fit",
  height: "165cm",
  weight: "60kg",
  waist: "32",
  shoe_size: "8",
  emergency_contact_name: "lav kumar",
  emergency_contact_phone: "8890498744",
  agree_to_declaration: true
};

const TEXT_FIELDS = [
  "course", "course_level", "state", "name", "father_name", "nationality",
  "date_of_birth", "domicile", "house_no_apartment", "street_village_colony",
  "district_city", "pincode", "mobile", "email", "education_qualification",
  "diet", "blood_group", "medical_category", "height", "weight", "waist",
  "shoe_size", "emergency_contact_name", "emergency_contact_phone"
];

// Document slots: storage key -> label shown in the popup.
const DOC_SLOTS = [
  ["birth_proof", "Birth / age proof"],
  ["domicile_proof", "Domicile / address proof"],
  ["education_proof", "Education proof"],
  ["skiing_certificate", "Skiing / adventure certificate (optional)"],
  ["employment_proof", "Employment proof (optional)"],
  ["applicant_photo", "Applicant photo"],
  ["applicant_signature", "Applicant signature"],
  ["guardian_signature", "Parent / guardian signature"]
];

const MAX_DOC_BYTES = 1_048_576;

const $ = (id) => document.getElementById(id);

function setStatus(message, isWarn) {
  const el = $("status");
  el.textContent = message;
  el.className = isWarn ? "warn" : "";
}

function applyProfile(profile) {
  for (const key of TEXT_FIELDS) {
    if ($(key)) $(key).value = profile[key] ?? "";
  }
  $("preferred_schedules").value = Array.isArray(profile.preferred_schedules)
    ? profile.preferred_schedules.join(", ")
    : "";
  $("agree_to_declaration").checked = profile.agree_to_declaration !== false;
}

function readProfile() {
  const profile = {};
  for (const key of TEXT_FIELDS) {
    profile[key] = $(key).value.trim();
  }
  profile.preferred_schedules = $("preferred_schedules").value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  profile.agree_to_declaration = $("agree_to_declaration").checked;
  return profile;
}

function saveProfile() {
  const profile = readProfile();
  return new Promise((resolve) => {
    chrome.storage.local.set({ profile }, () => resolve(profile));
  });
}

// --- Documents --------------------------------------------------------------

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getDocuments() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["documents"], ({ documents }) => resolve(documents || {}));
  });
}

async function renderDocs() {
  const documents = await getDocuments();
  const host = $("docs");
  host.innerHTML = "";
  for (const [key, label] of DOC_SLOTS) {
    const saved = documents[key];
    const wrap = document.createElement("div");
    wrap.style.margin = "6px 0";

    const lab = document.createElement("label");
    lab.textContent = label + (saved ? ` — saved: ${saved.name}` : "");
    lab.style.color = saved ? "#2e7d32" : "#1a1a1a";
    wrap.appendChild(lab);

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.jpeg,.png";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > MAX_DOC_BYTES) {
        setStatus(`${label}: file is ${(file.size / 1024).toFixed(0)} KB; limit is 1024 KB.`, true);
        input.value = "";
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      const docs = await getDocuments();
      docs[key] = { name: file.name, dataUrl };
      chrome.storage.local.set({ documents: docs }, () => {
        setStatus(`Saved ${file.name}.`);
        renderDocs();
      });
    });
    wrap.appendChild(input);
    host.appendChild(wrap);
  }
}

async function onFill() {
  const profile = await saveProfile();
  if (!profile.course) {
    setStatus("Enter a course first.", true);
    return;
  }
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const allFormTabs = await chrome.tabs.query({ url: ["https://admission.iismgulmarg.in/admission_form.aspx*"] });
  const activeTab = activeTabs[0];
  const activeIsForm = !!activeTab && /admission\.iismgulmarg\.in\/admission_form\.aspx/i.test(activeTab.url || "");
  const targets = activeIsForm
    ? [activeTab]
    : allFormTabs.filter((t) => !!t.id);

  if (!targets.length) {
    setStatus("Open the IISM admission_form.aspx page in a browser tab first.", true);
    return;
  }

  await new Promise((resolve) => chrome.storage.local.set({ active: true }, resolve));

  let messaged = 0;
  for (const tab of targets) {
    chrome.tabs.sendMessage(tab.id, { type: "iism-start" }, () => {
      if (!chrome.runtime.lastError) messaged += 1;
    });
  }

  setTimeout(() => {
    if (messaged > 0) {
      setStatus("Filling — let the page finish reloading between steps.", false);
    } else {
      setStatus("Start signal queued. If nothing happens in 2s, reload the form tab once.", false);
    }
  }, 250);
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["profile"], ({ profile }) => {
    applyProfile(profile && Object.keys(profile).length ? profile : DEFAULT_PROFILE);
  });
  renderDocs();
  $("save").addEventListener("click", async () => {
    await saveProfile();
    setStatus("Saved.");
  });
  $("fill").addEventListener("click", onFill);
});
