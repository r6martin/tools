"use strict";

const DATA_URL = "https://n8n.tritonai.ucsd.edu/webhook/media-lab-availability";
const POLL_SECONDS = 300;          // fallback poll interval
const SNAPSHOT_EVERY_SECONDS = 600; // n8n rebuilds the snapshot every 10 min
const SNAPSHOT_GRACE_SECONDS = 60;  // give the run time to finish
const MAX_BACKOFF_SECONDS = 900;   // cap retry delay after repeated failures
const FETCH_TIMEOUT_MS = 15000;
const STALE_AFTER_MINUTES = 25;    // > 2 missed n8n runs
const BANDS = new Set(["green", "yellow", "orange", "red"]);

let lastData = null;
let lastOkAt = null;
let failures = 0;
let timer = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function band(v) { return BANDS.has(v) ? v : "red"; }
function pct(v) { return Math.min(100, Math.max(0, num(v))); }

function tileHTML(t, labels, windowEndShort) {
  const raw = String(labels.lookahead_label || "")
    .replace("{free}", num(t.lookahead_free))
    .replace("{total}", num(t.total))
    .replace("{window_end_short}", windowEndShort);
  const m = esc(raw).match(/^([0-9/]+) (.*)$/);
  const label = m ? `<b>${m[1]}</b> ${m[2]}` : esc(raw);
  return `
  <div class="tile ${band(t.band)}">
    <div class="type">${esc(t.type)}</div>
    <div class="count">${num(t.available)}<span> / ${num(t.total)} ${esc(labels.unit_word || "")}</span></div>
    <div class="lookahead-label">${label}</div>
    <div class="lookahead">
      <div class="fill ${band(t.strip_band)}" style="width: ${pct(t.lookahead_pct)}%"
           aria-label="${esc(raw)}" title="${esc(raw)}"></div>
    </div>
  </div>`;
}

function isValid(D) {
  return D && typeof D === "object" && D.labels && typeof D.labels === "object" &&
         Array.isArray(D.types);
}

function render(D) {
  const L = D.labels;
  const setText = (id, v) => { document.getElementById(id).textContent = v == null ? "" : String(v); };
  document.title = String(L.title || "MTL Camera Availability");
  setText("title", L.title);
  setText("subtitle", L.subtitle);
  const badge = document.getElementById("off-hours-badge");
  if (badge) badge.style.display = D.offHours ? "inline-block" : "none";
  setText("lg-green", L.legend_green);
  setText("lg-yellow", L.legend_yellow);
  setText("lg-orange", L.legend_orange);
  setText("lg-red", L.legend_red);

  const windowEndShort = esc(D.window_end_short || "");
  const sections = [
    {key: "video", title: L.video_heading},
    {key: "photo", title: L.photo_heading},
    {key: "photo_analog", title: L.analog_photo_heading},
    {key: "video_analog", title: L.analog_video_heading},
  ];
  const host = document.getElementById("sections");
  host.textContent = "";
  for (const s of sections) {
    const list = D.types.filter(t => t && t.group === s.key)
      .sort((a, b) => (num(b.checkouts) - num(a.checkouts)) || (num(a.pct) - num(b.pct)) ||
                       String(a.type).localeCompare(String(b.type)));
    if (!list.length) continue;
    const sec = document.createElement("section");
    sec.innerHTML = "<h2>" + esc(s.title || "") + '</h2><div class="grid">' +
                    list.map(t => tileHTML(t, L, windowEndShort)).join("") + "</div>";
    host.appendChild(sec);
  }
  setText("foot", L.foot);
}

// Age of the snapshot itself (needs ISO `generated_at` in the feed); falls
// back to the time of the last successful fetch when the field is absent.
function snapshotTime(D) {
  const t = D && D.generated_at ? Date.parse(D.generated_at) : NaN;
  return Number.isFinite(t) ? t : null;
}

function updateBanner(errorMessage) {
  const el = document.getElementById("banner");
  let msg = "";
  const gen = snapshotTime(lastData);
  const ageMin = gen ? (Date.now() - gen) / 60000 : null;
  if (errorMessage && !lastData) {
    msg = "Live feed unavailable (" + errorMessage + "). Retrying…";
  } else if (errorMessage) {
    const when = new Date(gen || lastOkAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
    msg = "Can't reach the live feed right now. Showing data from " + when + ". Retrying…";
  } else if (ageMin !== null && ageMin > STALE_AFTER_MINUTES) {
    msg = "Data may be out of date: last updated " + Math.round(ageMin) +
          " minutes ago. Check with the front desk before coming in.";
  }
  el.textContent = msg;
  el.classList.toggle("show", Boolean(msg));
}

// Every page poll is one n8n webhook execution, so fetch once per new
// snapshot (just after it is due) instead of on a fixed short interval.
function nextPollSeconds(D) {
  const gen = snapshotTime(D);
  if (!gen) return POLL_SECONDS;
  const due = (gen - Date.now()) / 1000 + SNAPSHOT_EVERY_SECONDS + SNAPSHOT_GRACE_SECONDS;
  return due < 30 ? POLL_SECONDS : Math.min(SNAPSHOT_EVERY_SECONDS, due);
}

function schedule(seconds) {
  clearTimeout(timer);
  timer = setTimeout(refresh, seconds * 1000);
}

async function refresh() {
  if (document.hidden) return;   // resumes on visibilitychange
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DATA_URL, {cache: "no-store", signal: ctrl.signal,
                                       credentials: "omit", referrerPolicy: "no-referrer"});
    if (!res.ok) throw new Error("HTTP " + res.status);
    const D = await res.json();
    if (!isValid(D)) throw new Error("unexpected data");
    lastData = D;
    lastOkAt = Date.now();
    failures = 0;
    render(D);
    updateBanner(null);
    schedule(nextPollSeconds(D));
  } catch (err) {
    failures += 1;
    updateBanner(err.name === "AbortError" ? "timed out" : err.message);
    schedule(Math.min(MAX_BACKOFF_SECONDS, POLL_SECONDS * 2 ** (failures - 1)));
  } finally {
    clearTimeout(killer);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(timer); return; }
  if (!lastOkAt) { refresh(); return; }
  const elapsed = (Date.now() - lastOkAt) / 1000;
  const gen = snapshotTime(lastData);
  let wait;
  if (gen) {
    const due = (gen - Date.now()) / 1000 + SNAPSHOT_EVERY_SECONDS + SNAPSHOT_GRACE_SECONDS;
    wait = due > 0 ? Math.min(due, SNAPSHOT_EVERY_SECONDS) : Math.max(0, 60 - elapsed);
  } else {
    wait = POLL_SECONDS - elapsed;
  }
  if (wait <= 0) refresh();
  else { updateBanner(null); schedule(wait); }
});

refresh();
