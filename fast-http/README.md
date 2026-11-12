# fast-http — experimental pure-HTTP booking (no browser)

This is a **secondary, experimental** path. For the real booking day the proven
browser flow in [`../autofill.mjs`](../autofill.mjs) remains the recommended
primary. Use this only to test and understand the raw request flow.

## What it does

It talks to the IISM admission server directly with `fetch` (no Chrome), replaying
the exact ASP.NET postback chain a browser performs, regenerating the live
`__VIEWSTATE` / `__EVENTVALIDATION` / `hdfCapacitySheetAllocationId` tokens on each
hop (a static payload is impossible — those change every request):

1. `GET` the form → fresh tokens
2. `POST` `ddlCourse` (auto-postback) → populates level + schedule
3. set `ddlCourseLevel` (not a postback)
4. `POST` `ddlState` (auto-postback)
5. `POST` `ddlScheduleCourse` (auto-postback) → seats, fee, allocation id, age rules
6. `POST` `txtDateOfBirth` (auto-postback) → age checked against the schedule
7. `POST` (multipart) all fields + 8 files + `btnSubmit=Submit` ← the booking

It reads the **same** `../config.json` as the main tool, so your data and documents
stay in one place.

## Usage

```bash
# Safe: runs the whole chain but STOPS before the final booking POST and prints
# the assembled payload for you to verify.
node submit.mjs

# Actually submits. Requires BOTH the --go flag AND config.submit = true.
node submit.mjs --go
```

Requirements: Node 20+ (uses built-in `fetch`, `FormData`, `Blob`, and
`headers.getSetCookie()`). No `npm install` needed.

## Safety

- The final booking POST only fires with `--go` **and** `config.submit: true`.
- It aborts before submitting if the chosen schedule reports 0 seats.
- It **never** enters payment details. On success the server redirects to the
  online-payment page; the script prints that URL for you to pay yourself.

## Caveats (read before trusting it on booking day)

- ASP.NET + AjaxControlToolkit postbacks are fiddly to reproduce by hand. A single
  mismatched token makes the submit fail — with no second chance at 10:00:00.
- The dropdowns are empty until the intake window opens, so a dry run before then
  will stop at "Course not listed yet".
- Prefer running the browser-based `../autofill.mjs` for the actual booking; treat
  this as a faster experimental alternative you have personally verified first.
