# UI redesign (design/)

A simpler, phone-first dashboard. The redesigned UI itself lives in `frontend/src`; this folder holds
the notes, screenshots and a no-API-key preview. No backend files were changed.

![Home](screenshots/home.jpg)
![GST tracker](screenshots/gst-tracker.jpg)
![A service, expanded](screenshots/service-expanded.jpg)
![Balance and expiry sheet](screenshots/balance-sheet.jpg)

## What changed

- **Home** is only the summary and the services. The summary says how bad it is ("All good" / "Needs attention" /
  "Something is down") with Healthy / Warnings / Down / Issues counts and the next expiry. Each service is one compact
  row, worst first; tap it for keys, 7-day history, "Check now" and "Balance & expiry".
- **Floating bottom bar**: Home | Issues | Expiry | GST (replaces the top tabs). Issues shows the open count.
- **Expiry** is a tap-to-edit list, soonest first. The balance form opens as a bottom sheet on phones.
- **Issues** are rows that expand to the timeline, with "Mark resolved" inside.
- **GST tracker** (new): a grid of **User name | Phone no | GST API hits**, with total hits, user count,
  search (name or phone), sort (tap a header) and a small bar per row.
- Page scroll bar hidden on phone widths; scrolling is unchanged.

## GST tracker: what the backend needs to provide

The GST tracker backend is not built yet. The screen expects:

```
GET /api/gst
{
  "users": [ { "id": "u1", "name": "Rakesh Soni", "phone": "9928688065", "hits": 42 } ],
  "updatedAt": "2026-10-01T09:30:00.000Z"      // optional
}
```

`hits` = how many times that user has called the GST verification API. Until the route exists the server
answers 404 and the screen shows "Not connected yet"; once it returns data the grid fills in on its own.
Other errors show "Couldn't load GST hits" with a Try again button.

## Known limits
- Checked in a browser against fake data only; not yet run in the Android WebView or against the real backend.
- The grid keeps its columns aligned with CSS `subgrid` (current Chrome / Android WebView); on older engines the
  phone-number column can shift slightly between rows.

## Preview without API keys
```bash
node design/preview/dev.js
```
Open http://localhost:4301 (Android-style phone frame; the plain dashboard is on http://localhost:4300).
The real backend is not started, so nothing here touches any API or key. `frontend/dist` is rebuilt when the
server starts; to rebuild while it runs: `node frontend/scripts/build.js`.
