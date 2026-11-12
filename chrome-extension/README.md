# IISM Gulmarg Form Autofiller — Chrome extension

A one-click autofiller for the IISM Gulmarg admission form, as a browser
extension. It fills every dropdown (handling the ASP.NET page reloads between
them), all text fields, the date of birth, and ticks the declaration.

> This is a convenience filler for filling the form by hand on the day. For the
> unattended "refresh-until-seats-open and auto-submit" job, keep using the
> Node script (`autofill.mjs`) — a background extension can't reliably win a
> 10–15 second scramble the way the dedicated poller can.

## What it can and can't do

- ✅ Course / level / state / schedule dropdowns (survives the postback reloads)
- ✅ All text fields + date of birth (filled after a batch is selected, so the
  age/fee calculation sticks)
- ✅ Ticks the "I Agree" declaration (optional)
- ✅ **Documents are auto-attached** — load each file once in the popup and the
  extension injects them into the upload boxes after the dropdowns settle.
  (Boxes with a saved file turn green; any still-missing box turns orange.)
- ⚠️ It does **not** click Submit — you review and submit.

### Why the documents work here but not by "typing" a path

Browsers forbid JavaScript from fabricating a file path for an upload box. This
extension doesn't do that: you pick each file yourself in the popup (a real user
gesture), it's stored locally, and then it's placed into the form via a
`DataTransfer` object — which the browser allows.

## Install (Load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `chrome-extension/` folder.
4. Pin the "IISM Gulmarg Form Autofiller" extension to the toolbar.

## Use

1. Open the admission form:
   `https://admission.iismgulmarg.in/admission_form.aspx?mobile=8890498744`
2. Click the extension icon. It opens as a **side panel** docked to the right,
   which **stays open while the form reloads** between steps. Your details are
   pre-filled — edit anything, then click **Save**. Under **Documents**, pick
   each file once (they stay saved).
3. Click **Fill form**. The page will reload a few times as each dropdown posts
   back; the side panel stays put and a toast in the top-right reports progress.
4. Check the attached documents (green boxes), double-check everything, then
   submit.

The profile is stored locally in the browser (`chrome.storage.local`); nothing
is sent anywhere.

> Current live labels (checked 9 Nov 2026): course `Snow Skiing Courses at
> Gulmarg`, level `Basic SSC`. Batches ("schedule") are not published yet —
> re-check with `node ../autofill.mjs --discover` once they appear.
