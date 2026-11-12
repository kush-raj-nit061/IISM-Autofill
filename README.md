# IISM admission autofill

This local tool opens the official IISM Gulmarg admission form in Google Chrome, selects the dependent course fields, fills the personal details, attaches the configured documents, and checks the declaration.

It does **not** submit by default. That leaves the final legal declaration and application submission under your control. To submit automatically, set `"submit": true` in `config.json`; the tool still refuses when the site reports zero available seats.

## One-time setup

1. Edit `config.json` and replace every blank value with your information. Dates must use `dd/MM/yyyy`.
2. Create a `documents` folder and put your files there using the names in `config.json`, or change the paths.
3. Required files on the current form are birth proof, education proof, applicant photo, applicant signature, and parent/guardian signature. The website currently marks the guardian signature as required even for adults.
4. Documents must be PDF/GIF/JPG/JPEG/PNG and at most 1 MB. Signatures must be JPG/JPEG/PNG and at most 500 KB.
5. Install the local browser dependency once:

   ```bash
   npm install
   ```

## Run

Check the data and document paths without opening a browser:

```bash
npm run check
```

Fill the form:

```bash
npm start
```

The browser remains open for review. The private `config.json`, `documents` folder, and temporary browser files are excluded from Git.

## Auto-submit mode (for a fast booking window)

When seats are released at a fixed time and vanish within seconds, use the polling auto-submit mode. It opens the form, keeps refreshing, and the instant a preferred batch reports free seats it attaches the documents and submits.

Enable it in `config.json`:

```json
"submit": true,
"course_level": "Basic",
"preferred_schedules": ["20 dec", "03 jan", "17 jan", "31 jan", "14 feb", "28 feb"],
"accept_any_schedule": true,
"poll": {
  "enabled": true,
  "start_time": "2026-11-12T10:00:00+05:30",
  "lead_seconds": 20,
  "interval_ms": 800,
  "max_minutes": 20
}
```

- `preferred_schedules` are tried in order (loose, case-insensitive substring match on the batch label), so the 1st batch is favoured. With `accept_any_schedule: true`, any other open batch is taken if none of the preferred ones has seats.
- `start_time` makes the tool wait (then start probing `lead_seconds` early). Remove it to start immediately.
- `submit: true` submits automatically when seats are found. Keep `submit: false` for a safe dry run that fills everything and stops without submitting.
- A screenshot of the result is saved to `submission-result.png`.

Run it:

```bash
npm start
```

## Confirm the exact labels on the day

The Snow Skiing course, its levels, and the batch dates are only published when booking opens; before then the site may only list other courses. Just before the window, list the real labels and copy them into `config.json`:

```bash
node autofill.mjs --discover
```

The tool also matches close labels automatically (for example `Snow Skiing` matches `Snow Skiing Courses`), but confirming the exact text with `--discover` is the safest option.

## Course availability

The site values change when IISM publishes new batches. Set `schedule` to an exact visible schedule, or use `"first_available"` to select the first schedule the site offers. The tool validates every requested dropdown value and stops with the choices reported by the site when a value is unavailable.
