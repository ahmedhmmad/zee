/* Fleet console. Arabic UI, Latin numerals, Africa/Tripoli times. */

const $ = (id) => document.getElementById(id);

// Declared here rather than beside the history page: applyTheme() touches it,
// and a `let` further down would be in the temporal dead zone.
let historyMap = null;

const state = {
  devices: [],
  locations: [],
  selectedId: null,
  map: null,
  // Cached from /api/config so the basemap can be rebuilt on switch without
  // refetching it.
  googleMapsApiKey: '',
  arcgisApiKey: '',
  arcgisVersion: '',
  // Whether valve sub-lock unlocking is switched on at all. Off means the
  // controls are hidden — the API refuses regardless, so this only spares an
  // operator a button that cannot work.
  subLockUnlockEnabled: false,
  // Who is logged in, and whether they may open locks. Same principle: the
  // routes decide, this only keeps a useless button off the screen.
  username: null,
  mayUnlock: false,
  // Keep the selected vehicle centred as it drives. Without this the marker
  // wanders out of a static viewport and a moving truck looks stationary.
  follow: true,
};

// --- Formatting -------------------------------------------------------------

// ar-LY with latn numerals: Arabic month and weekday names, Western digits,
// which is what operators expect for technical fleet data.
const timeFmt = new Intl.DateTimeFormat('ar-LY-u-nu-latn', {
  timeZone: 'Africa/Tripoli',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat('ar-LY-u-nu-latn', {
  timeZone: 'Africa/Tripoli',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** All protocol timestamps are UTC; conversion happens only here. */
const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : '—');
const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');

function fmtAgo(iso) {
  if (!iso) return 'لا يوجد';
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (seconds < 60) return 'الآن';
  if (seconds < 3600) return `منذ ${Math.floor(seconds / 60)} دقيقة`;
  if (seconds < 86400) return `منذ ${Math.floor(seconds / 3600)} ساعة`;
  return `منذ ${Math.floor(seconds / 86400)} يوم`;
}

/** Anything that leaves the lock open, as opposed to closing it. */
const isOpening = (e) =>
  e.unlock_allowed && e.event_source_name !== 'auto_locked' && e.event_source_name !== 'rope_pulled_out';

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} دقيقة`;
  return `${Math.floor(m / 60)} ساعة و${m % 60} دقيقة`;
}

// Below walking pace the reported heading is whatever the GPS last drifted
// to, not a direction of travel, so treat the vehicle as stationary.
const MOVING_KPH = 3;

const COMPASS = ['شمال', 'شمال شرق', 'شرق', 'جنوب شرق', 'جنوب', 'جنوب غرب', 'غرب', 'شمال غرب'];

const isMoving = (d) => Number(d.speed_kph ?? 0) >= MOVING_KPH;

/**
 * The map marker is meaningfully behind reality.
 *
 * Positions arrive in bursts when a moving vehicle keeps losing its TCP
 * session, so the device can be in contact while its last position is minutes
 * old. Two minutes is roughly four times the configured reporting interval -
 * beyond that, something is queuing.
 */
const POSITION_LAG_MS = 2 * 60 * 1000;

function positionIsLagging(d) {
  if (!d.last_position_at) return false;
  return Date.now() - new Date(d.last_position_at) > POSITION_LAG_MS;
}

function headingLabel(d) {
  if (!isMoving(d)) return 'متوقفة';
  const deg = ((Number(d.heading_deg ?? 0) % 360) + 360) % 360;
  return `${COMPASS[Math.round(deg / 45) % 8]} · ${Math.round(deg)}°`;
}

const LOCATION_KINDS = {
  depot: 'مستودع',
  station: 'محطة وقود',
  customer: 'عميل',
  yard: 'ساحة',
  other: 'أخرى',
};

const EVENT_NAMES = {
  rfid_authorized: 'بطاقة RFID مصرّح بها',
  rfid_illegal: 'بطاقة RFID غير مصرّح بها',
  vehicle_id_card_bind: 'ربط بطاقة المركبة',
  remote_static_password: 'فتح عن بُعد (كلمة مرور ثابتة)',
  auto_locked: 'إقفال تلقائي',
  remote_dynamic_password: 'فتح عن بُعد (كلمة مرور متغيّرة)',
  bluetooth_unlock: 'فتح عبر البلوتوث',
  rope_pulled_out: 'سحب حبل القفل',
  unknown: 'غير معروف',
};

/*
 * The status of a command is what happened in the EXCHANGE with the device —
 * not whether the lock moved. That is the evidence line below, and the two are
 * kept visibly apart on purpose: "تم التأكيد من الجهاز" used to be read as
 * "the valve opened", which it never meant.
 *
 * Every status in the schema's CHECK constraint must appear here, or the
 * fallback shows an operator a raw English code.
 */
const COMMAND_STATUS = {
  queued: ['في الانتظار', 'pending'],
  approved: ['معتمَد', 'pending'],
  sent: ['أُرسل — بانتظار رد الجهاز', 'pending'],
  confirmed: ['قبِله الجهاز', 'ok'],
  failed: ['فشل', 'bad'],
  // Not a milder failure and not a slower success: the command may have
  // executed. Saying so is the entire point of the state.
  uncertain: ['غير معروف — لم يرد الجهاز', 'uncertain'],
  expired: ['انتهت صلاحيته', 'bad'],
  rejected: ['مرفوض', 'bad'],
  pending_approval: ['بانتظار الموافقة', 'pending'],
  draft: ['مسودة', 'pending'],
};

/** Why a command failed. Only device_rejected says anything about the password. */
const FAILURE_CAUSE = {
  device_rejected: 'رفضه الجهاز',
  transport: 'فشل الإرسال عبر الشبكة',
  no_response: 'لا يوجد رد من الجهاز',
  cancelled: 'أُلغي',
  unclassified: 'سبب غير مسجَّل',
};

const EVIDENCE_KIND = {
  lock_event: 'سجل القفل من الجهاز',
  peripheral_report: 'تقرير القفل الفرعي',
};

/**
 * The movement line for a command that can actually move a valve.
 *
 * Absence of evidence is shown as absence of evidence — never as "لم يُفتح".
 * The platform does not know, and on a tanker full of petrol the difference
 * between "it did not open" and "we cannot tell whether it opened" is the
 * whole safety argument.
 */
function evidenceLine(c) {
  if (!c.is_physical) return '';
  if (c.physically_evidenced_at) {
    const kind = EVIDENCE_KIND[c.physical_evidence_kind] ?? c.physical_evidence_kind ?? '';
    return `<div class="evidence yes">✔ تحرَّك القفل فعلياً — ${escapeHtml(kind)} · ${fmtDateTime(c.physically_evidenced_at)}</div>`;
  }
  // Nothing to evidence yet on a command that has not gone out.
  if (['draft', 'pending_approval', 'approved', 'queued'].includes(c.status)) return '';
  return '<div class="evidence no">لا يوجد إثبات على تحرّك القفل</div>';
}

const WAKE_REASONS = {
  device_restart: 'إعادة تشغيل',
  rtc_timer: 'مؤقّت دوري',
  vibration: 'اهتزاز',
  back_cover_opened: 'فتح الغطاء الخلفي',
  lock_rope_changed: 'تغيّر حبل القفل',
  charging: 'الشحن',
  rfid_card: 'تمرير بطاقة',
  lora: 'شبكة LoRa',
  vip_sms: 'رسالة من رقم معتمد',
  non_vip_sms: 'رسالة نصية',
  bluetooth: 'بلوتوث',
};

const ALARM_NAMES = {
  ropeCutAlarm: 'قطع حبل القفل',
  illegalCardAlarm: 'بطاقة غير مصرّح بها',
  longUnlockAlarm: 'فتح لمدة طويلة',
  wrongPasswordAlarm: 'كلمة مرور خاطئة متكررة',
  lowBatteryAlarm: 'بطارية منخفضة',
  backCoverOpenedAlarm: 'فتح الغطاء الخلفي',
  motorStuckAlarm: 'تعطّل المحرك',
  vibrationAlarm: 'اهتزاز',
  enterFenceAlarm: 'دخول المنطقة الجغرافية',
  exitFenceAlarm: 'مغادرة المنطقة الجغرافية',
};

// --- API --------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      // Only declare a JSON body when there is one. Sending the header with an
      // empty body - as every DELETE did - makes Fastify try to parse nothing
      // as JSON and answer 400.
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401) {
    // Send the operator back to the login screen rather than leaving a stale,
    // empty UI that looks functional but has no data behind it.
    showLogin();
    const { reason } = await res.json().catch(() => ({}));
    $('login-error').textContent =
      reason === 'cookie_rejected'
        ? 'انتهت صلاحية الجلسة، الرجاء تسجيل الدخول مرة أخرى'
        : 'الرجاء تسجيل الدخول';
    $('login-error').hidden = false;
    throw new Error('unauthorised');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'error');
  return res.json();
}

// --- Auth -------------------------------------------------------------------

function showLogin() {
  // Dismiss any open overlay too: a modal left up would cover the login form.
  $('unlock-modal').hidden = true;
  $('detail').hidden = true;
  $('login').hidden = false;
  $('app').hidden = true;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('username').value.trim(),
        password: $('password').value,
      }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Say which wall they hit. "Wrong password" for a rate limit sends an
      // operator round in circles changing something that was already right.
      $('login-error').textContent =
        body.error === 'too_many_attempts'
          ? 'محاولات كثيرة خلال وقت قصير. انتظر بضع دقائق ثم أعد المحاولة.'
          : 'اسم المستخدم أو كلمة المرور غير صحيحة';
      $('login-error').hidden = false;
      return;
    }

    $('password').value = '';
    state.mayUnlock = body.mayUnlock === true;
    start();
  } catch {
    $('login-error').textContent = 'تعذّر الاتصال بالخادم';
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// --- Map --------------------------------------------------------------------

// Remembered per browser: an operator in a control room and one checking on a
// phone outdoors want opposite answers, and neither should have to re-choose.
const THEME_KEY = 'zee.mapTheme';
const mapTheme = () => localStorage.getItem(THEME_KEY) ?? 'dark';

/**
 * One switch for the whole console, map included.
 *
 * It used to restyle only the map, which left a light basemap glaring out of a
 * dark interface. Two separate dark/light buttons would be worse - so the
 * theme is a single choice, applied to the document and handed to the map.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  state.map?.setTheme(theme);
  historyMap?.setTheme(theme);
  renderThemeButton();
}

function renderThemeButton() {
  const btn = $('map-theme');
  // Always available: it themes the interface even when the basemap cannot be
  // restyled (raster tiles have their colours baked into the images).
  btn.hidden = false;
  btn.textContent = mapTheme() === 'dark' ? '🌙 داكن' : '☀️ فاتح';
  btn.title = 'تبديل مظهر المنظومة والخريطة بين الداكن والفاتح';
}

$('map-theme').addEventListener('click', () => {
  const next = mapTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// Applied before the map exists, so the interface never flashes the wrong
// palette while Google's library downloads.
document.documentElement.dataset.theme = mapTheme();

/**
 * Which basemap the operator chose, remembered across visits.
 *
 * Stored locally rather than server-side: it is a display preference, and
 * different people at different screens reasonably want different answers.
 * Defaults to Google when a key exists, since its Libyan street data is the
 * reason it was chosen - falling back to imagery only if that key stops working.
 */
function chosenBasemap(hasGoogleKey, hasArcgisKey = false) {
  const saved = localStorage.getItem('zee.basemap');
  // A saved choice whose key has since been removed would leave the operator
  // staring at a blank panel, so fall through to imagery instead.
  if (saved === 'google' && !hasGoogleKey) return hasArcgisKey ? 'arcgis' : 'esri';
  if (saved === 'arcgis' && !hasArcgisKey) return 'esri';
  if (saved) return saved;
  // Esri by default. The client standardises on it, so that is what should be
  // on screen when the console is opened cold - Google stays available in the
  // picker but is no longer what anyone lands on. The licensed ArcGIS basemap
  // takes precedence over the free imagery whenever a key is configured.
  return hasArcgisKey ? 'arcgis' : 'esri';
}

async function initMap() {
  if (state.map) return;
  const { googleMapsApiKey, arcgisApiKey, arcgisVersion, subLockUnlockEnabled } =
    await api('/api/config');
  state.googleMapsApiKey = googleMapsApiKey;
  state.arcgisApiKey = arcgisApiKey;
  state.arcgisVersion = arcgisVersion;
  state.subLockUnlockEnabled = subLockUnlockEnabled === true;

  // The arrival rule's sub-lock option only exists where the capability does.
  // Offering a tick box the server will refuse produces a rule the operator
  // thinks covers the valves and does not.
  const subLockLine = $('arrival-sublocks-line');
  if (subLockLine) subLockLine.hidden = !state.subLockUnlockEnabled;
  const { createMap } = await import('/map.js');
  state.map = await createMap(
    document.getElementById('map'),
    googleMapsApiKey,
    selectDevice,
    mapTheme(),
    chosenBasemap(googleMapsApiKey, arcgisApiKey),
    { apiKey: arcgisApiKey, version: arcgisVersion },
  );
  console.info(`[map] using ${state.map.provider}`);
  // Raster tiles cannot be restyled, so the button only exists for Google.
  renderThemeButton();
  renderBasemapPicker();
}

/**
 * Basemap picker.
 *
 * Rebuilding the map is the simplest correct way to switch: Google and
 * MapLibre are different libraries with different DOM, so there is nothing to
 * mutate in place. The selected vehicle is reapplied afterwards so the switch
 * does not silently lose what the operator was looking at.
 */
async function renderBasemapPicker() {
  const { availableBasemaps } = await import('/map.js');
  const options = availableBasemaps(
    Boolean(state.googleMapsApiKey),
    Boolean(state.arcgisApiKey),
  );
  let host = document.getElementById('basemap-picker');
  if (!host) {
    host = document.createElement('div');
    host.id = 'basemap-picker';
    host.className = 'basemap-picker';
    document.getElementById('map').parentElement.appendChild(host);
  }
  host.innerHTML = '';
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.label;
    b.className = opt.id === state.map.provider ? 'active' : '';
    b.addEventListener('click', () => switchBasemap(opt.id));
    host.appendChild(b);
  }
}

async function switchBasemap(provider) {
  if (!state.map || state.map.provider === provider) return;
  localStorage.setItem('zee.basemap', provider);

  const previous = state.selectedId;
  const container = document.getElementById('map');

  // Stop the marker animation before the map goes away, rather than leaving a
  // frame to fire against a half-rebuilt console.
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }

  container.innerHTML = '';
  state.map = null;

  const { createMap } = await import('/map.js');
  state.map = await createMap(
    container,
    state.googleMapsApiKey,
    selectDevice,
    mapTheme(),
    provider,
    { apiKey: state.arcgisApiKey, version: state.arcgisVersion },
  );
  console.info(`[map] switched to ${state.map.provider}`);
  renderThemeButton();
  renderBasemapPicker();
  syncMarkers();
  if (previous) selectDevice(previous);
}

/**
 * A device that has never had a GPS fix reports 0,0 — which is a real point in
 * the Gulf of Guinea. Plotting it would put a Tripoli truck in the Atlantic,
 * so treat that as "no location" rather than a coordinate.
 */
function hasLocation(d) {
  return (
    d.latitude != null &&
    d.longitude != null &&
    !(Math.abs(d.latitude) < 0.0001 && Math.abs(d.longitude) < 0.0001)
  );
}

/*
 * Marker animation.
 *
 * Positions arrive as discrete fixes, so a marker that simply jumps looks
 * broken even when the data is perfect. Sliding between two KNOWN fixes reads
 * as continuous motion and invents nothing: both endpoints are real
 * measurements, and the vehicle genuinely was at each of them.
 *
 * Note what this deliberately does NOT do: project the marker forward past the
 * last fix. Extrapolation would keep a truck gliding convincingly along a road
 * it may have turned off, and on a system that decides whether a tanker is at
 * an authorised site, a confident guess is worse than an honest pause. When
 * fixes stop, the marker stops - and fades to say so.
 */
const anim = new Map(); // deviceId -> { fromLat, fromLon, toLat, toLon, start, dur, lastFix }
let animFrame = null;

const easeOut = (t) => 1 - (1 - t) * (1 - t);

function pointNow(a, now) {
  if (!a.dur) return [a.toLat, a.toLon];
  const t = Math.min((now - a.start) / a.dur, 1);
  const k = easeOut(t);
  return [a.fromLat + (a.toLat - a.fromLat) * k, a.fromLon + (a.toLon - a.fromLon) * k];
}

function runAnimation() {
  // Cleared first, never last. Anything thrown below used to leave a stale
  // frame id here, and syncMarkers' `if (!animFrame)` then never scheduled
  // another frame - so one error silently froze every marker for the rest of
  // the session, while the rest of the console carried on working.
  animFrame = null;

  // Switching basemap nulls state.map and rebuilds it across an await. A frame
  // queued before that lands in the gap with nothing to draw on; the
  // syncMarkers() call after the rebuild starts the loop again.
  const map = state.map;
  if (!map) return;

  const now = performance.now();
  let active = false;

  for (const [id, a] of anim) {
    // Placed directly by syncMarkers — off screen, or a jump too big to tween.
    // Redrawing it every frame was most of the loop's cost at fleet scale.
    if (!a.dur) continue;

    if (now - a.start >= a.dur) {
      // One last draw to land it exactly, then leave it alone. The entry stays
      // so the next fix knows where this marker came from.
      if (!a.settled) {
        map.setMarker(id, a.toLat, a.toLon, a.opts);
        a.settled = true;
      }
      continue;
    }

    active = true;
    const [lat, lon] = pointNow(a, now);
    map.setMarker(id, lat, lon, a.opts);
  }

  if (active) animFrame = requestAnimationFrame(runAnimation);
}

/**
 * How much to trust what is on screen.
 *
 * A sleeping truck is silent by design - that is not staleness and must not be
 * dressed up as a fault. An awake one that has gone quiet is a different
 * matter: at a five-second interval, a minute of silence means something is
 * wrong and the marker should stop looking authoritative.
 */
function markerFreshness(d) {
  if (connectionState(d) === 'sleeping') return 'ok';
  const age = d.last_position_at ? (Date.now() - new Date(d.last_position_at)) / 1000 : Infinity;
  if (age <= 60) return 'ok';
  if (age <= 900) return 'aging';
  return 'stale';
}

/**
 * Is this position somewhere the operator can currently see?
 *
 * Read once per sync rather than per marker, and generously: a marker just off
 * the edge may slide into view during its own animation, so the box is padded
 * by a tenth of its own size. When the map cannot say, everything counts as
 * visible — degrading to the old behaviour is the safe direction.
 */
function viewportBox() {
  const b = state.map?.getBounds?.();
  if (!b) return null;
  const padLat = (b.north - b.south) * 0.1;
  const padLon = (b.east - b.west) * 0.1;
  return {
    south: b.south - padLat,
    north: b.north + padLat,
    west: b.west - padLon,
    east: b.east + padLon,
  };
}

function inBox(box, lat, lon) {
  if (!box) return true;
  return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
}

function syncMarkers() {
  if (!state.map) return;
  const box = viewportBox();
  for (const device of state.devices) {
    if (!hasLocation(device)) {
      state.map.removeMarker(device.device_id);
      anim.delete(device.device_id);
      continue;
    }
    const opts = {
      title: device.name,
      // Plate first: it is short, unique, and what a dispatcher says on the
      // radio. The full name stays on hover and in the panel.
      label: device.plate_number || device.name,
      freshness: markerFreshness(device),
      heading: Number(device.heading_deg ?? 0),
      moving: isMoving(device),
      kind:
        connectionState(device) === 'offline'
          ? 'offline'
          : device.motor_locked === false
            ? 'unlocked'
            : 'locked',
    };

    const id = device.device_id;
    const prev = anim.get(id);
    const now = performance.now();
    const [curLat, curLon] = prev ? pointNow(prev, now) : [device.latitude, device.longitude];
    const moved = metresBetween([curLat, curLon], [device.latitude, device.longitude]);

    // Time between this fix and the last one we drew, which is how long the
    // slide should take for motion to look continuous rather than rushed.
    const fixMs =
      prev?.lastFix && device.last_position_at
        ? new Date(device.last_position_at) - new Date(prev.lastFix)
        : 0;

    // A jump too large to be one reporting interval of driving is a coverage
    // gap, not movement we watched. Gliding across it would draw a route the
    // truck never took, so place it directly instead.
    const isGap = moved > 800;
    // Animation is only worth paying for where somebody can see it. At 3,000
    // devices the animation loop is the frame budget, and almost all of it is
    // spent tweening markers outside the viewport. Off-screen trucks are placed
    // directly — their position is just as correct, it simply arrives without
    // the slide.
    const onScreen = inBox(box, device.latitude, device.longitude);
    const dur = isGap || moved < 1 || !onScreen ? 0 : Math.min(Math.max(fixMs || 2000, 800), 6000);

    anim.set(id, {
      fromLat: curLat,
      fromLon: curLon,
      toLat: device.latitude,
      toLon: device.longitude,
      start: now,
      dur,
      opts,
      lastFix: device.last_position_at,
    });

    if (!dur) state.map.setMarker(id, device.latitude, device.longitude, opts);
  }

  if (!animFrame) animFrame = requestAnimationFrame(runAnimation);
}

// --- Rendering --------------------------------------------------------------

/*
 * Rendered rows, by device id, so an update can patch one row instead of
 * rebuilding the list.
 *
 * `innerHTML = ''` followed by 3,000 createElement calls ran on every pushed
 * message. At the fleet's ~36 messages a second that is a full teardown and
 * rebuild of the whole list thirty-six times a second, plus 3,000 discarded
 * click listeners each time — the console stopped being interactive long
 * before the server did.
 */
const deviceRows = new Map(); // deviceId -> { li, html, cls }

/** One listener for the whole list, reading the id off the row. */
$('device-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-device-id]');
  if (li) selectDevice(li.dataset.deviceId);
});

function deviceRowHtml(d) {
  return `
      <div class="row">
        <span class="name">${escapeHtml(d.name)}</span>
        ${lockPill(d)}
      </div>
      <div class="row">
        <span class="muted">${escapeHtml(d.plate_number ?? d.device_id)}</span>
        <span class="muted">${batteryLabel(d)} · ${fmtAgo(d.last_position_at ?? d.last_seen_at)}${positionIsLagging(d) ? ' ⏳' : ''}</span>
      </div>`;
}

function deviceRowClass(d) {
  // Only genuine loss of contact greys a vehicle out. A sleeping device
  // still shows its lock state, because that is what operators care about.
  const kind =
    connectionState(d) === 'offline'
      ? 'is-offline'
      : d.motor_locked === false
        ? 'is-unlocked'
        : 'is-locked';
  return `device-item ${kind}${d.device_id === state.selectedId ? ' selected' : ''}`;
}

function renderDeviceList() {
  const query = $('search').value.trim().toLowerCase();
  const list = $('device-list');
  const visible = state.devices.filter(
    (d) =>
      !query ||
      d.name.toLowerCase().includes(query) ||
      (d.plate_number ?? '').toLowerCase().includes(query),
  );

  $('device-count').textContent = `${visible.length} مركبة`;

  if (visible.length === 0) {
    for (const { li } of deviceRows.values()) li.remove();
    deviceRows.clear();
    list.innerHTML = '<li class="muted">لا توجد مركبات مطابقة</li>';
    return;
  }

  // The empty-state <li> carries no device id, so it is swept here rather than
  // being left behind above the real rows.
  for (const li of list.querySelectorAll('li:not([data-device-id])')) li.remove();

  const wanted = new Set(visible.map((d) => d.device_id));
  for (const [id, row] of deviceRows) {
    if (!wanted.has(id)) {
      row.li.remove();
      deviceRows.delete(id);
    }
  }

  // Rebuilt only where something actually changed. A fleet where one truck
  // moved touches one row.
  let previous = null;
  for (const d of visible) {
    let row = deviceRows.get(d.device_id);
    if (!row) {
      const li = document.createElement('li');
      li.dataset.deviceId = d.device_id;
      row = { li, html: null, cls: null };
      deviceRows.set(d.device_id, row);
    }

    const html = deviceRowHtml(d);
    if (html !== row.html) {
      row.li.innerHTML = html;
      row.html = html;
    }
    const cls = deviceRowClass(d);
    if (cls !== row.cls) {
      row.li.className = cls;
      row.cls = cls;
    }

    // Keep the DOM in the same order as `visible` without moving rows that are
    // already in place: a node re-inserted where it already is still costs a
    // reflow, and at 3,000 rows that is the whole saving.
    const shouldFollow = previous ? previous.nextElementSibling : list.firstElementChild;
    if (shouldFollow !== row.li) {
      list.insertBefore(row.li, previous ? previous.nextElementSibling : list.firstElementChild);
    }
    previous = row.li;
  }
}

/**
 * These devices sleep almost all the time — they wake for ten minutes, report,
 * and drop the socket. So "no socket" is the normal resting state, not a
 * fault, and saying "disconnected" for it trains operators to ignore the word.
 *
 * The RTC wake interval is 30 minutes by default, so anything heard from
 * inside 45 minutes is behaving normally. Beyond that it is genuinely out of
 * contact and worth someone's attention.
 */
const SLEEP_GRACE_MS = 45 * 60 * 1000;

function connectionState(d) {
  if (d.is_connected) return 'connected';
  if (!d.last_seen_at) return 'offline';
  return Date.now() - new Date(d.last_seen_at) < SLEEP_GRACE_MS ? 'sleeping' : 'offline';
}

/**
 * An "unlocked" reading decays; a "locked" one does not.
 *
 * The device auto-locks roughly a minute after an unlock (P83) and is usually
 * asleep by then, so it never reports the change. A stale "open" therefore
 * probably means "closed by now" - whereas a lock cannot open itself, so a
 * stale "closed" stays trustworthy.
 */
const UNLOCK_STALE_MS = 3 * 60 * 1000;

function isUnlockReadingStale(d) {
  if (d.motor_locked !== false || d.is_connected) return false;
  if (!d.last_position_at) return true;
  return Date.now() - new Date(d.last_position_at) > UNLOCK_STALE_MS;
}

function lockPill(d) {
  const state = connectionState(d);
  if (state === 'offline') return '<span class="pill pill-warn">لا اتصال</span>';

  const lock = isUnlockReadingStale(d)
    ? '<span class="pill pill-warn" title="قد يكون الجهاز أُقفل تلقائياً بعد ذلك">مفتوح؟</span>'
    : d.motor_locked === false
      ? '<span class="pill pill-danger">مفتوح</span>'
      : '<span class="pill pill-ok">مقفل</span>';

  return state === 'sleeping' ? `${lock} <span class="pill pill-muted">نائم</span>` : lock;
}

/**
 * Charging and level are independent: a device can report 35% while charging.
 * Older units (PCB < 2.7.1) send 0xFF instead of a level while charging, in
 * which case battery_percent is null and only the state is known.
 */
function batteryLabel(d) {
  if (d.battery_percent == null) return d.charging ? 'قيد الشحن' : '—';
  return d.charging ? `${d.battery_percent}% (شحن)` : `${d.battery_percent}%`;
}

/** GSM signal is 0-31; 99 means the device saw no network at all. */
function signalLabel(d) {
  const v = d.gsm_signal;
  if (v == null) return 'لا توجد إشارة';
  const bars = v >= 20 ? 'ممتازة' : v >= 14 ? 'جيدة' : v >= 8 ? 'ضعيفة' : 'ضعيفة جداً';
  return `${v}/31 · ${bars}`;
}

// MCC 606 is Libya. MNC 00 Libyana, 01 Al-Madar, 02 Al-Jeel, 03 LibyaPhone.
const CARRIERS = { '606-0': 'ليبيانا', '606-1': 'المدار الجديد', '606-2': 'الجيل الجديد', '606-3': 'ليبيا فون' };

function carrierLabel(d) {
  if (d.mcc == null) return '—';
  return CARRIERS[`${d.mcc}-${d.mnc}`] ?? `MCC ${d.mcc} / MNC ${d.mnc}`;
}

async function renderDetail() {
  const d = state.devices.find((x) => x.device_id === state.selectedId);
  const panel = $('detail');
  if (!d) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  $('d-name').textContent = d.name;
  $('d-plate').textContent = `${d.plate_number ?? '—'} · ${d.device_id}`;
  $('d-lock').innerHTML = lockPill(d);
  // Say why the reading is uncertain, rather than leaving a bare question mark.
  $('d-lock-note').textContent = isUnlockReadingStale(d)
    ? 'آخر حالة معروفة عند الفتح — يُرجَّح أن الجهاز أُقفل تلقائياً بعدها. سيتم التحديث عند استيقاظه.'
    : '';
  $('d-lock-note').hidden = !isUnlockReadingStale(d);
  $('d-battery').textContent = batteryLabel(d);
  $('d-speed').textContent = d.speed_kph != null ? `${Number(d.speed_kph).toFixed(0)} كم/س` : '—';
  $('d-signal').textContent = signalLabel(d);
  $('d-heading').textContent = headingLabel(d);
  $('d-sats').textContent = d.satellites ?? '—';
  $('d-rope').textContent = d.rope_inserted == null ? '—' : d.rope_inserted ? 'مُدخَل' : 'مسحوب';
  // The odometer is a lifetime counter, useful for servicing but useless for
  // "what did this truck do today" — so the per-period figures lead.
  //
  // An odometer reset inside the period makes the span meaningless — one reset
  // reads as about 99,994 km. Say the figure cannot be trusted rather than
  // printing it: this feeds a Ministry report, and a confident wrong number is
  // worse than an admitted gap.
  const km = (v) =>
    d.mileage_has_anomaly ? 'غير موثوق (تغيّر العدّاد)' : v == null ? '—' : `${Math.round(Number(v))} كم`;
  $('d-dist-today').textContent = km(d.today_km);
  $('d-dist-week').textContent = km(d.week_km);
  $('d-mileage').textContent = d.mileage_km != null ? `${d.mileage_km} كم` : '—';
  $('d-carrier').textContent = carrierLabel(d);
  // Lock events arrive 2-5 minutes late, cached in device flash, so this can
  // legitimately lag the live status above. Show the delay rather than hide it.
  $('d-last-event').textContent = d.last_event_at
    ? `${EVENT_NAMES[d.last_event_source] ?? d.last_event_source} · ${fmtDateTime(d.last_event_at)}` +
      (d.last_event_command_id ? ' · بأمر من المنظومة' : '')
    : 'لا يوجد';
  $('d-devid').textContent = d.device_id;
  $('d-model').textContent = d.model ?? '—';
  $('d-imei').textContent = d.imei ?? '—';
  $('d-firmware').textContent = d.firmware_version ?? 'غير معروف — أرسل الأمر P01';
  // Contact and position are different facts. The sub-lock beats every 35
  // seconds, so last_seen_at says "now" while the position can be minutes
  // old - which is exactly when someone stares at a stationary marker
  // wondering why the truck is not moving.
  $('d-seen').textContent = `${fmtAgo(d.last_seen_at)} (${fmtTime(d.last_seen_at)})`;
  $('d-posage').textContent = d.last_position_at
    ? `${fmtAgo(d.last_position_at)} (${fmtTime(d.last_position_at)})`
    : 'لا يوجد';
  $('d-posage').className = positionIsLagging(d) ? 'lagging' : '';
  $('d-wake').textContent = WAKE_REASONS[d.wake_source] ?? '—';

  // Say "no fix" plainly rather than drawing a confident dot in the wrong place.
  $('d-pos').textContent = !hasLocation(d)
    ? 'لا يوجد تحديد GPS بعد — الجهاز داخل مبنى'
    : `${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}${d.positioned ? '' : ' (موقع قديم)'}`;

  const alarms = Object.keys(d.active_alarms ?? {}).filter((k) => d.active_alarms[k]);
  const alarmBox = $('d-alarms');
  alarmBox.hidden = alarms.length === 0;
  alarmBox.innerHTML = alarms.length
    ? `<strong>تنبيهات نشطة:</strong><br>${alarms.map((a) => ALARM_NAMES[a] ?? a).join('، ')}`
    : '';

  // A view-only account gets the button greyed out with the reason on it,
  // rather than a button that looks live and returns 403. The route refuses
  // either way; this is so nobody has to find that out by pressing it.
  const unlockBtn = $('unlock-btn');
  unlockBtn.disabled = !state.mayUnlock;
  unlockBtn.title = state.mayUnlock ? '' : 'هذا الحساب مخوَّل بالمتابعة فقط';

  await Promise.all([loadCommands(d.device_id), loadEvents(d.device_id), loadArrivals(d.device_id), loadSubLocks(d.device_id)]);
}

async function loadCommands(deviceId) {
  const list = $('command-list');
  try {
    const commands = await api(`/api/devices/${deviceId}/commands`);
    if (!commands.length) {
      list.innerHTML = '<li class="empty">لا توجد أوامر</li>';
      return;
    }
    list.innerHTML = commands
      .slice(0, 8)
      .map((c) => {
        const [label, cls] = COMMAND_STATUS[c.status] ?? [`حالة غير معروفة (${escapeHtml(c.status)})`, 'bad'];
        // Cancellable only while it is still waiting to be delivered. Once
        // sent, the frame is on the wire and offering a cancel would be
        // promising something the platform cannot do. 'uncertain' is not
        // cancellable for the same reason, and more so: it may have executed.
        const cancellable = ['queued', 'approved', 'draft', 'pending_approval'].includes(c.status);
        const cause = c.status === 'failed' && c.failure_cause
          ? `<div class="muted">${escapeHtml(FAILURE_CAUSE[c.failure_cause] ?? c.failure_cause)}</div>`
          : '';
        return `<li class="${cls}">
          <div class="cmd-head">
            <strong>${label}</strong>
            ${cancellable ? `<button class="btn btn-ghost btn-xs" data-cancel-cmd="${c.id}">إلغاء</button>` : ''}
          </div>
          ${evidenceLine(c)}
          ${cause}
          <div class="muted">${escapeHtml(c.reason ?? '')}</div>
          <div class="when">${fmtDateTime(c.requested_at)} · ${escapeHtml(c.requested_by ?? '')}</div>
        </li>`;
      })
      .join('');

    list.querySelectorAll('[data-cancel-cmd]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(`/api/devices/${deviceId}/commands/${btn.dataset.cancelCmd}`, { method: 'DELETE' });
          toast('تم إلغاء الأمر', 'ok');
        } catch (err) {
          // 409 means the gateway claimed it while the operator was deciding.
          // Say so plainly rather than reporting a generic failure: the lock
          // may be about to open and that changes what they do next.
          toast(
            String(err?.message ?? '').includes('not_cancellable')
              ? 'تعذّر الإلغاء — تم إرسال الأمر للجهاز بالفعل'
              : 'تعذّر الإلغاء — حاول مرة أخرى',
            'bad',
          );
        }
        await loadCommands(deviceId);
      });
    });
  } catch {
    list.innerHTML = '<li class="empty">تعذّر التحميل</li>';
  }
}

async function loadEvents(deviceId) {
  const list = $('event-list');
  try {
    const events = await api(`/api/devices/${deviceId}/events`);
    if (!events.length) {
      list.innerHTML = '<li class="empty">لا توجد أحداث</li>';
      return;
    }
    // Events arrive newest-first. Walk forward to find, for each unlock, the
    // next locking event after it - so the log can say how long the tanker was
    // actually open, which is the number that matters in an investigation.
    const sealedAfter = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!isOpening(e)) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (events[j].event_source_name === 'auto_locked') {
          sealedAfter.set(e.id, (new Date(events[j].reported_at) - new Date(e.reported_at)) / 1000);
          break;
        }
      }
    }

    list.innerHTML = events
      .slice(0, 20)
      .map((e) => {
        const refused = e.refused_outside_fence;
        const neutral = e.event_source_name === 'auto_locked';
        const cls = neutral ? '' : refused || !e.unlock_allowed ? 'bad' : 'ok';

        const notes = [];
        if (e.command_id && e.requested_by) {
          notes.push(`بأمر من ${e.requested_by}`);
          if (e.reason) notes.push(`السبب: ${e.reason}`);
        }
        if (refused) notes.push('رُفض خارج المنطقة المسموحة');
        if (e.wrong_password_count > 0) notes.push(`محاولات خاطئة: ${e.wrong_password_count}`);
        if (e.rfid_card) notes.push(`البطاقة ${e.rfid_card}`);

        const open = sealedAfter.get(e.id);
        if (open != null) notes.push(`ظل مفتوحاً ${formatDuration(open)}`);

        // Flash-cached reports arrive minutes late; say so where it is large,
        // otherwise the log looks like it is lagging for no reason.
        const lag = (new Date(e.received_at) - new Date(e.reported_at)) / 1000;
        const lagNote = lag > 90 ? ` · وصل بعد ${formatDuration(lag)}` : '';

        return `<li class="${cls}">
          <div><strong>${EVENT_NAMES[e.event_source_name] ?? e.event_source_name}</strong></div>
          ${notes.length ? `<div class="muted">${notes.map(escapeHtml).join(' · ')}</div>` : ''}
          <div class="when">${fmtDateTime(e.reported_at)}${lagNote}</div>
        </li>`;
      })
      .join('');
  } catch {
    list.innerHTML = '<li class="empty">تعذّر التحميل</li>';
  }
}

function selectDevice(deviceId) {
  state.selectedId = deviceId;
  const d = state.devices.find((x) => x.device_id === deviceId);
  if (d && hasLocation(d)) state.map.flyTo(d.latitude, d.longitude);
  renderDeviceList();
  renderDetail();
}

$('detail-close').addEventListener('click', () => {
  state.map?.clearDestinations?.();
  state.map?.clearRoute?.();
  state.selectedId = null;
  $('detail').hidden = true;
  renderDeviceList();
});

$('search').addEventListener('input', renderDeviceList);

// --- Unlock -----------------------------------------------------------------

$('unlock-btn').addEventListener('click', () => {
  const d = state.devices.find((x) => x.device_id === state.selectedId);
  if (!d) {
    toast('لم يتم اختيار مركبة', 'bad');
    return;
  }
  $('unlock-device').textContent = `${d.name} (${d.plate_number ?? d.device_id})`;
  $('unlock-reason').value = '';
  // Pin the target to the modal itself. Reading it back from shared state at
  // submit time is how a null device id reached the server.
  $('unlock-modal').dataset.deviceId = d.device_id;
  $('unlock-modal').hidden = false;
  $('unlock-reason').focus();
});

$('unlock-cancel').addEventListener('click', () => ($('unlock-modal').hidden = true));

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deviceId = $('unlock-modal').dataset.deviceId;
  const reason = $('unlock-reason').value.trim();
  $('unlock-modal').hidden = true;

  if (!deviceId || !/^\d{10}$/.test(deviceId)) {
    toast('لم يتم اختيار مركبة صالحة', 'bad');
    return;
  }

  try {
    const result = await api(`/api/devices/${deviceId}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ reason, ttlMinutes: Number($('unlock-ttl').value) }),
    });
    // Deliberately not "unlocked": the command is queued, and a sleeping
    // device may take minutes to receive it.
    toast(
      result.deviceOnline
        ? 'تم إرسال الأمر — بانتظار تأكيد الجهاز'
        : 'الجهاز غير متصل حالياً — سيُرسل الأمر عند اتصاله',
      'ok',
    );
    loadCommands(deviceId);
  } catch (err) {
    // The device rejected the stored password more than once. Repeating it
    // would fail identically and walk into the device's own alarm at five
    // consecutive failures, so say what actually needs doing.
    toast(
      String(err.message) === 'repeated_password_failures'
        ? 'الجهاز رفض كلمة المرور المحفوظة أكثر من مرة — صحّح كلمة المرور قبل المحاولة ثانيةً'
        : 'تعذّر إرسال الأمر',
      'bad',
    );
  }
});

// --- Sub-locks --------------------------------------------------------------

const SUB_TYPES = {
  jt709_sub_lock: 'قفل فرعي JT709',
  jt126_temp_humidity: 'مستشعر حرارة JT126',
  jt802_valve_lock: 'قفل صمام JT802',
  unknown: 'جهاز غير معروف',
};

async function loadSubLocks(deviceId) {
  const list = $('sublock-list');
  try {
    const subs = await api(`/api/devices/${deviceId}/sublocks`);
    if (!subs.length) {
      list.innerHTML =
        '<li class="empty">لا توجد أقفال فرعية معروفة — اضغط "تحديث القائمة" لسؤال الجهاز</li>';
      return;
    }
    // Read before the map: `state` is shadowed inside it by the lock-state
    // pill below.
    const unlockEnabled = state.subLockUnlockEnabled;

    list.innerHTML = subs
      .map((s) => {
        // Bound but never heard from: the master lists it, yet it has sent
        // nothing. Normal for a freshly fitted lock with no LoRa heartbeat.
        const neverReported = !s.last_seen_at;
        const unbound = !s.bound_confirmed_at && !neverReported;

        const state = neverReported
          ? '<span class="pill pill-warn">مرتبط — لم يُرسل بعد</span>'
          : unbound
            ? '<span class="pill pill-muted">لم يعد مرتبطاً</span>'
            : s.comms_lost_alarm
          ? '<span class="pill pill-danger">انقطع الاتصال بالقفل</span>'
          : s.locked === true
            ? '<span class="pill pill-ok">مقفل</span>'
            : s.locked === false
              ? '<span class="pill pill-danger">مفتوح</span>'
              : '<span class="pill pill-muted">—</span>';

        const bits = [];
        if (neverReported) {
          bits.push('اضغط زر الإيقاظ على القفل ليُرسل حالته لأول مرة');
        }
        if (s.battery_percent != null) bits.push(`البطارية ${s.battery_percent}%`);
        if (s.voltage != null) bits.push(`${Number(s.voltage).toFixed(2)} فولت`);
        if (s.rssi != null) bits.push(`إشارة ${s.rssi} dBm`);
        if (s.rope_pulled_out === true) bits.push('الحبل مسحوب');
        if (s.back_cover_open === true) bits.push('الغطاء مفتوح');
        if (s.charging === true) bits.push('قيد الشحن');
        if (s.low_voltage_alarm) bits.push('بطارية منخفضة');
        if (s.lock_cycles != null) bits.push(`${s.lock_cycles} دورة فتح/إقفال`);
        if (s.temperature_c != null) bits.push(`${s.temperature_c}°م`);
        if (s.humidity_percent != null) bits.push(`رطوبة ${s.humidity_percent}%`);

        const alarming = s.comms_lost_alarm || s.back_cover_open === true || s.locked === false;

        // Valve locks can be opened; temperature sensors obviously cannot.
        // And only while sub-lock unlocking is switched on: there is currently
        // no way to confirm a valve actually opened, so the capability is off.
        const unlockable =
          unlockEnabled &&
          (s.device_type === 'jt709_sub_lock' || s.device_type === 'jt802_valve_lock');

        return `<li class="${alarming ? 'bad' : ''}">
          <div class="row">
            <strong class="ltr-inline">${escapeHtml(s.peripheral_id)}</strong>
            ${state}
          </div>
          <div class="muted">${SUB_TYPES[s.device_type] ?? s.device_type} · ${bits.map(escapeHtml).join(' · ')}</div>
          <div class="when">${fmtAgo(s.last_seen_at)}</div>
          ${
            unlockable
              ? `<button class="btn btn-ghost btn-xs sublock-unlock" data-sub="${escapeHtml(s.peripheral_id)}">فتح هذا القفل</button>`
              : ''
          }
        </li>`;
      })
      .join('');

    for (const btn of list.querySelectorAll('.sublock-unlock')) {
      btn.addEventListener('click', () => openSubLockDialog(deviceId, btn.dataset.sub));
    }
  } catch {
    list.innerHTML = '<li class="empty">تعذّر التحميل</li>';
  }
}

/**
 * Unlocking a valve lock always needs somebody at the truck.
 *
 * The sub-lock sleeps at ~60uA to last three years on a battery that cannot be
 * recharged, so it does not listen continuously. The platform authorises and
 * the master holds the command; the driver presses the wake button and the
 * lock collects it. The dialog says this, because an operator who expects a
 * remote unlock to just happen will conclude the system is broken.
 */
$('sublock-refresh').addEventListener('click', async () => {
  const deviceId = state.selectedId;
  if (!deviceId) return;
  try {
    await api(`/api/devices/${deviceId}/sublocks/refresh`, { method: 'POST' });
    toast('طُلبت قائمة الأقفال من الجهاز — ستظهر عند استجابته', 'ok');
  } catch {
    toast('تعذّر طلب القائمة', 'bad');
  }
});

function openSubLockDialog(deviceId, subId) {
  $('sub-unlock-id').textContent = subId;
  $('sub-unlock-reason').value = '';
  $('sub-unlock-modal').dataset.deviceId = deviceId;
  $('sub-unlock-modal').dataset.subId = subId;
  $('sub-unlock-modal').hidden = false;
  $('sub-unlock-reason').focus();
}

$('sub-unlock-cancel').addEventListener('click', () => ($('sub-unlock-modal').hidden = true));

$('sub-unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const modal = $('sub-unlock-modal');
  const { deviceId, subId } = modal.dataset;
  const reason = $('sub-unlock-reason').value.trim();
  modal.hidden = true;

  try {
    await api(`/api/devices/${deviceId}/sublocks/${subId}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ reason, windowMinutes: 5 }),
    });
    toast('أُرسل الأمر — اضغط زر الإيقاظ على القفل الفرعي خلال 5 دقائق', 'ok');
    loadCommands(deviceId);
  } catch {
    toast('تعذّر إرسال أمر فتح القفل الفرعي', 'bad');
  }
});

/**
 * Draw where the vehicle has actually been.
 *
 * A single dot answers "where is it"; the route answers "where has it been and
 * how did it get there", which is the question an operator is usually really
 * asking - and the only way to notice a truck that took an unexpected detour.
 */
async function loadTrack(deviceId) {
  try {
    const points = await api(`/api/devices/${deviceId}/track?hours=6`);
    state.map?.setTrack(points);
  } catch {
    state.map?.setTrack([]);
  }
}

// Clear the route when no vehicle is selected, so it cannot be mistaken for
// the track of whichever vehicle is selected next.
// --- Tracking settings page -------------------------------------------------

const SETTING_LABELS = {
  query_tracking: 'وضع التتبع',
  query_intervals: 'فترات الإرسال',
  query_motion: 'حساسية الحركة',
  query_cornering: 'تقرير المنعطفات',
  query_drift: 'تثبيت الموقع',
  query_gnss_power: 'توفير طاقة GPS',
  query_autolock: 'الإقفال التلقائي',
  query_channels: 'قنوات الفتح المسموحة',
  query_cards: 'بطاقات RFID المصرّح بها',
  query_firmware: 'إصدار البرنامج',
  query_bound_peripherals: 'الأقفال الفرعية المرتبطة',
  query_password: 'كلمة مرور الفتح',
};

/**
 * Turn a raw device response into a sentence.
 *
 * The device answers in bare comma-separated values - "30,30", "63,15",
 * "1,1,1,1,1" - which mean nothing to an operator, and which even I have to
 * look up in the protocol manual each time. Each decoder below is the manual's
 * definition, written once, in the language the person reading it speaks.
 */
const SETTING_DECODERS = {
  // P04: awake reporting interval (seconds), RTC wake interval (minutes)
  query_intervals: (v) => {
    const [awake, sleep] = v.split(',').map(Number);
    if (!Number.isFinite(awake)) return null;
    return `يُرسل موقعه كل ${awake} ثانية أثناء العمل، ويستيقظ كل ${sleep} دقيقة أثناء النوم`;
  },
  // P54: 1 = continuous tracking, 0 = sleep normally
  query_tracking: (v) =>
    v.split(',').pop() === '1'
      ? 'تتبع مستمر — لا ينام الجهاز (استهلاك بطارية مرتفع)'
      : 'الوضع العادي — ينام الجهاز بين التقارير',
  // P37: motion threshold in mg; second value is a customised-firmware field
  query_motion: (v) => {
    const mg = Number(v.split(',')[0]);
    if (!Number.isFinite(mg)) return null;
    if (mg === 0) return 'كشف الحركة مُعطّل — لن يستيقظ الجهاز بالاهتزاز';
    const how = mg <= 100 ? 'عالية جداً' : mg <= 200 ? 'عالية' : mg <= 1000 ? 'متوسطة' : 'منخفضة';
    return `حساسية ${how} (${mg} مِلّي جي) — كلما قلّ الرقم استيقظ الجهاز باهتزاز أخف`;
  },
  // P59: sms, gprs, rfid, serial, bluetooth
  query_channels: (v) => {
    const names = ['رسائل SMS', 'المنظومة (شبكة البيانات)', 'بطاقة RFID', 'المنفذ السلكي', 'البلوتوث'];
    const flags = v.split(',').map((x) => x === '1');
    if (flags.length < 5) return null;
    const on = names.filter((_, i) => flags[i]);
    const off = names.filter((_, i) => !flags[i]);
    return `مسموح: ${on.join('، ') || 'لا شيء'}${off.length ? ` · ممنوع: ${off.join('، ')}` : ''}`;
  },
  // P83: auto-lock delay in minutes
  query_autolock: (v) => {
    const m = Number(v.split(',').pop());
    return Number.isFinite(m) ? `يُقفل تلقائياً بعد ${m} دقيقة إن لم يُسحب الحبل` : null;
  },
  // P63 / P97: simple on-off switches
  query_drift: (v) =>
    v.split(',').pop() === '1'
      ? 'مفعّل — لا يتغيّر الموقع المعروض إلا عند تحرّك المركبة فعلياً'
      : 'مُعطّل — قد يتذبذب الموقع قليلاً أثناء التوقف',
  query_gnss_power: (v) =>
    v.split(',').pop() === '1'
      ? 'مفعّل — يُطفئ الـ GPS بين التقارير لتوفير البطارية'
      : 'مُعطّل — يبقى الـ GPS يعمل باستمرار',
  // P99: enabled, sampling seconds, turn angle
  query_cornering: (v) => {
    const [on, secs, angle] = v.split(',');
    return on === '1'
      ? `مفعّل — يُرسل نقطة إضافية عند انعطاف يتجاوز ${angle}° (كل ${secs} ثانية)`
      : 'مُعطّل — المسار على الخريطة أقل نعومة عند المنعطفات';
  },
  // P41 response: group, count, then the card numbers
  query_cards: (v) => {
    const parts = v.split(',');
    const cards = parts.slice(2).filter(Boolean);
    return cards.length ? `${cards.length} بطاقة: ${cards.join('، ')}` : 'لا توجد بطاقات مسجّلة';
  },
  query_bound_peripherals: (v) => {
    const ids = v.split(',').slice(1).filter(Boolean);
    return ids.length ? `${ids.length} قفل فرعي: ${ids.join('، ')}` : 'لا توجد أقفال فرعية مرتبطة';
  },
  query_firmware: (v) => v.split(',')[0] ?? v,
};

$('open-tracking').addEventListener('click', () => {
  $('tracking-page').hidden = false;
  // Reuse the vehicle list already loaded for the map.
  $('trk-device').innerHTML = state.devices
    .map((d) => `<option value="${d.device_id}">${escapeHtml(d.name)} — ${escapeHtml(d.plate_number ?? d.device_id)}</option>`)
    .join('');
  if (state.selectedId) $('trk-device').value = state.selectedId;
  loadCurrentSettings();
});

$('close-tracking').addEventListener('click', () => ($('tracking-page').hidden = true));
$('trk-device').addEventListener('change', loadCurrentSettings);

/**
 * Show what the DEVICE says it is set to, not what we last sent it.
 *
 * The platform only knows what it has asked for. A device configured by
 * someone else, or one that quietly refused a command, would disagree with our
 * assumptions and nothing else would reveal it.
 */
async function loadCurrentSettings() {
  const deviceId = $('trk-device').value;
  const list = $('trk-current');
  if (!deviceId) return;

  try {
    const rows = await api(`/api/devices/${deviceId}/settings`);
    const answered = rows.filter((r) => r.response);
    if (!answered.length) {
      list.innerHTML =
        '<li class="empty">لم تُقرأ إعدادات الجهاز بعد — اضغط "قراءة الإعدادات الحالية"</li>';
      return;
    }
    list.innerHTML = answered
      .map(
        (r) => {
          // Fall back to the raw value if a decoder is missing or the device
          // answered something unexpected — never hide what it actually said.
          let plain = null;
          try {
            plain = SETTING_DECODERS[r.command_type]?.(r.response) ?? null;
          } catch {
            plain = null;
          }
          return `<li>
          <div class="row">
            <strong>${SETTING_LABELS[r.command_type] ?? r.command_type}</strong>
            ${plain ? '' : `<span class="ltr-inline muted">${escapeHtml(r.response)}</span>`}
          </div>
          ${plain ? `<div>${escapeHtml(plain)}</div>` : ''}
          <div class="when">
            ${fmtDateTime(r.confirmed_at ?? r.sent_at)}
            ${plain ? `· <span class="ltr-inline">${escapeHtml(r.response)}</span>` : ''}
          </div>
        </li>`;
        },
      )
      .join('');
  } catch {
    list.innerHTML = '<li class="empty">تعذّر التحميل</li>';
  }
}

$('trk-read').addEventListener('click', async () => {
  const deviceId = $('trk-device').value;
  if (!deviceId) return;
  try {
    await api(`/api/devices/${deviceId}/settings/read`, { method: 'POST' });
    toast('تم إرسال طلب القراءة — ستظهر النتائج عند استيقاظ الجهاز', 'ok');
  } catch {
    toast('تعذّر إرسال طلب القراءة', 'bad');
  }
});

$('tracking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deviceId = $('trk-device').value;
  if (!deviceId) {
    toast('اختر مركبة أولاً', 'bad');
    return;
  }

  try {
    const { queued } = await api(`/api/devices/${deviceId}/settings`, {
      method: 'POST',
      body: JSON.stringify({
        tracking: $('trk-mode').value === 'tracking',
        wakeMinutes: Number($('trk-wake').value),
        awakeSeconds: Number($('trk-awake').value),
        sleepMinutes: Number($('trk-sleep').value),
        motionThreshold: Number($('trk-motion').value),
        cornering: $('trk-cornering').checked,
        corneringAngle: Number($('trk-angle').value),
        corneringSampleSeconds: 1,
        staticDrift: $('trk-drift').checked,
        gnssPowerSaving: $('trk-gnss').checked,
        autoLockMinutes: Number($('trk-autolock').value),
        longUnlockMinutes: Number($('trk-longunlock').value),
        lowBatteryPercent: Number($('trk-battery').value),
      }),
    });
    toast(`تم إرسال ${queued} أمراً — ستُطبَّق عند اتصال الجهاز`, 'ok');
    if (state.selectedId === deviceId) loadCommands(deviceId);
  } catch {
    toast('تعذّر إرسال الإعدادات', 'bad');
  }
});

// --- Arrival unlocks --------------------------------------------------------

/**
 * Accept whatever an operator pastes: "32.85255, 13.07818" from Google Maps,
 * space-separated, or with stray parentheses. Getting this wrong sends a
 * tanker's unlock point somewhere else entirely, so be liberal in parsing and
 * strict in validating.
 */
function parseCoords(text) {
  const nums = String(text)
    .replace(/[()]/g, ' ')
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  if (nums.length !== 2) return null;
  const [latitude, longitude] = nums;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

async function loadArrivals(deviceId) {
  const list = $('arrival-list');
  try {
    const arrivals = await api(`/api/devices/${deviceId}/arrivals`);
    drawDestinations(deviceId, arrivals);
    const armed = arrivals.filter((a) => a.is_armed);
    const recent = arrivals.filter((a) => !a.is_armed).slice(0, 3);

    if (!armed.length && !recent.length) {
      list.innerHTML = '<li class="empty">لا توجد نقاط فتح تلقائي</li>';
      return;
    }

    list.innerHTML = [...armed, ...recent]
      .map((a) => {
        const notes = [`نطاق ${a.radius_m} م`, `السبب: ${a.reason}`];
        if (a.include_sublocks) notes.push('يشمل أقفال الصمامات');
        if (a.is_armed) {
          // Null means the vehicle has no usable fix, not that it is nearby.
          // Saying so is far better than an invented distance.
          notes.push(
            a.current_distance_m == null
              ? 'لا يوجد موقع GPS للمركبة بعد — لن يعمل الفتح التلقائي حتى تحدد موقعها'
              : Number(a.current_distance_m) <= a.radius_m
                ? 'المركبة داخل النطاق'
                : `المسافة الحالية ${formatDistance(a.current_distance_m)}`,
          );
          notes.push(`ينتهي ${fmtDateTime(a.expires_at)}`);
        } else if (a.triggered_at) {
          notes.push(`نُفِّذ ${fmtDateTime(a.triggered_at)} على بُعد ${a.triggered_distance_m} م`);
        } else {
          notes.push('أُلغي');
        }

        return `<li class="${a.is_armed ? 'pending' : a.triggered_at ? 'ok' : ''}">
          <div class="row">
            <strong>${escapeHtml(a.name)}</strong>
            ${a.is_armed ? `<button class="btn btn-ghost btn-xs" data-disarm="${a.id}">إلغاء</button>` : ''}
          </div>
          <div class="muted">${notes.map(escapeHtml).join(' · ')}</div>
        </li>`;
      })
      .join('');

    for (const btn of list.querySelectorAll('[data-disarm]')) {
      btn.addEventListener('click', async () => {
        // Surface failures to the operator. Cancelling an automatic unlock is
        // exactly the action that must not fail quietly.
        try {
          await api(`/api/devices/${deviceId}/arrivals/${btn.dataset.disarm}`, { method: 'DELETE' });
          toast('تم إلغاء الفتح التلقائي', 'ok');
        } catch {
          toast('تعذّر الإلغاء — حاول مرة أخرى', 'bad');
        }
        loadArrivals(deviceId);
      });
    }
  } catch {
    list.innerHTML = '<li class="empty">تعذّر التحميل</li>';
  }
}

const formatDistance = (m) =>
  Number(m) >= 1000 ? `${(Number(m) / 1000).toFixed(1)} كم` : `${Math.round(Number(m))} م`;

/** Metres between two coordinates. Flat-earth approximation, fine at this scale. */
function metresBetween([lat1, lon1], [lat2, lon2]) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Drop fixes that have barely moved.
 *
 * A parked vehicle still reports every 60 seconds and each fix wanders 10-20m,
 * so ten minutes stationary draws a scribble that looks like erratic driving.
 * Collapsing anything within 25m of the last kept point removes the scribble
 * without losing the shape of the journey - and without hiding the stop, since
 * the gap in the line still shows it.
 */
function dropStationaryDrift(points, minMetres = 25) {
  const kept = [];
  for (const p of points) {
    if (!kept.length || metresBetween(kept[kept.length - 1], p) >= minMetres) kept.push(p);
  }
  // Always keep the final fix, so the trail ends where the vehicle actually is.
  const last = points[points.length - 1];
  if (last && kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

/**
 * Only armed destinations for the selected vehicle are drawn. Showing every
 * rule for every truck at once would bury the one the operator is watching.
 *
 * The blue line is a real driving route from Google Directions. Routes are
 * billed per request and a refresh arrives with every position report, so the
 * computed path is cached and only re-requested once the vehicle has moved
 * well away from where the last one was calculated.
 */
const routeCache = new Map(); // arrivalId -> { lat, lon, path }

async function drawDestinations(deviceId, arrivals) {
  if (!state.map?.setDestination) return;
  state.map.clearDestinations();
  state.map.clearRoute?.();

  const device = state.devices.find((d) => d.device_id === deviceId);
  const from = device && hasLocation(device) ? { lat: device.latitude, lon: device.longitude } : null;

  for (const a of arrivals.filter((x) => x.is_armed)) {
    let routed = false;

    if (from && state.map.fetchRoute) {
      const cached = routeCache.get(a.id);
      let path =
        cached && metresBetween([cached.lat, cached.lon], [from.lat, from.lon]) < 500
          ? cached.path
          : null;
      if (!path) {
        path = await state.map.fetchRoute(from, { lat: a.latitude, lon: a.longitude });
        if (path) routeCache.set(a.id, { lat: from.lat, lon: from.lon, path });
      }
      if (path) {
        state.map.setRoutePath(path);
        routed = true;
      }
    }

    // The dashed straight line is only the fallback when no road route exists.
    state.map.setDestination(`arrival-${a.id}`, a.latitude, a.longitude, {
      radiusM: a.radius_m,
      label: a.name,
      from: routed ? null : from,
    });
  }
}

$('arrival-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deviceId = state.selectedId;
  const locationId = Number($('arrival-location').value);
  if (!deviceId || !locationId) {
    toast('اختر موقعاً أولاً', 'bad');
    return;
  }

  const radius = $('arrival-radius').value;
  try {
    // Only the location id goes over the wire; the server reads the
    // coordinates from the catalogue, so a tampered request cannot move the
    // unlock point.
    await api(`/api/devices/${deviceId}/arrivals`, {
      method: 'POST',
      body: JSON.stringify({
        locationId,
        radiusM: radius ? Number(radius) : undefined,
        expiresInHours: Number($('arrival-expiry').value),
        // A hidden checkbox can still be checked from an earlier session, so
        // the flag gates the value rather than the control.
        includeSubLocks: state.subLockUnlockEnabled && $('arrival-sublocks').checked,
        reason: $('arrival-reason').value.trim(),
      }),
    });
    $('arrival-reason').value = '';
    toast('تم تفعيل الفتح التلقائي عند الوصول', 'ok');
    loadArrivals(deviceId);
  } catch {
    toast('تعذّر تفعيل الفتح التلقائي', 'bad');
  }
});


// --- Devices administration -------------------------------------------------

/** Latest password-read result per device, keyed by id. */
function passwordReadNote(read) {
  if (!read) return '';
  if (read.status === 'confirmed' && read.response) {
    return `<span class="pill pill-ok">كلمة المرور: <span class="ltr-inline">${escapeHtml(read.response)}</span></span>
            <span class="muted">قُرئت ${fmtDateTime(read.confirmed_at)}</span>`;
  }
  if (read.status === 'failed' || read.status === 'expired') {
    return `<span class="pill pill-warn">تعذّرت قراءة كلمة المرور</span>`;
  }
  // queued or sent: the device has not answered yet.
  return `<span class="pill pill-muted">بانتظار رد الجهاز على طلب كلمة المرور…</span>`;
}

async function loadDevicesPage() {
  const [devices, unknown, reads] = await Promise.all([
    api('/api/devices').catch(() => []),
    api('/api/unknown-devices').catch(() => []),
    api('/api/password-reads').catch(() => []),
  ]);
  const readsById = new Map(reads.map((r) => [r.device_id, r]));

  // Locks that reached the gateway but are not registered. Approving one from
  // here means the id never has to be read off a label and retyped.
  const section = $('unknown-section');
  section.hidden = unknown.length === 0;
  $('unknown-list').innerHTML = unknown
    .map(
      (u) => `<li>
        <div class="row">
          <strong class="ltr-inline">${escapeHtml(u.device_id)}</strong>
          <button class="btn btn-primary btn-xs" data-approve="${escapeHtml(u.device_id)}">اعتماد</button>
        </div>
        <div class="muted">
          ${u.attempts} محاولة · آخرها ${fmtDateTime(u.last_seen)}
          ${u.remote_ip ? ` · <span class="ltr-inline">${escapeHtml(u.remote_ip)}</span>` : ''}
        </div>
      </li>`,
    )
    .join('');

  $('devices-list').innerHTML = devices.length
    ? devices
        .map((d) => {
          const weak = d.static_password_is_default;
          return `<li>
            <div class="row">
              <strong>${escapeHtml(d.name)}</strong>
              <span>
                <button class="btn btn-ghost btn-xs" data-commission="${d.device_id}">تهيئة</button>
                <button class="btn btn-ghost btn-xs" data-readpw="${d.device_id}">قراءة كلمة المرور</button>
                <button class="btn btn-ghost btn-xs" data-setpw="${d.device_id}">تغيير كلمة المرور</button>
              </span>
            </div>
            <div class="muted">
              <span class="ltr-inline">${d.device_id}</span> · ${escapeHtml(d.plate_number ?? '—')} ·
              ${d.model ?? '—'}${d.firmware_version ? ` · <span class="ltr-inline">${escapeHtml(d.firmware_version.split('_').slice(0, 2).join('_'))}</span>` : ''}
              ${weak ? ' · <span class="pill pill-warn">كلمة مرور افتراضية</span>' : ''}
            </div>
            ${
              readsById.has(d.device_id)
                ? `<div class="dev-pw">${passwordReadNote(readsById.get(d.device_id))}</div>`
                : ''
            }
          </li>`;
        })
        .join('')
    : '<li class="empty">لا توجد أجهزة</li>';

  for (const btn of $('unknown-list').querySelectorAll('[data-approve]')) {
    btn.addEventListener('click', () => {
      $('dev-id').value = btn.dataset.approve;
      $('dev-name').focus();
    });
  }
  for (const btn of $('devices-list').querySelectorAll('[data-commission]')) {
    btn.addEventListener('click', async () => {
      const { queued } = await api(`/api/devices/${btn.dataset.commission}/commission`, { method: 'POST' });
      toast(`تم جدولة ${queued} أوامر تهيئة — ستُنفَّذ عند استيقاظ الجهاز`, 'ok');
    });
  }
  for (const btn of $('devices-list').querySelectorAll('[data-readpw]')) {
    btn.addEventListener('click', async () => {
      await api(`/api/devices/${btn.dataset.readpw}/read-password`, { method: 'POST' });
      toast('تم إرسال طلب القراءة — ستظهر كلمة المرور هنا عند رد الجهاز', 'ok');
      // Show the pending state straight away, then let the poller replace it
      // with the answer rather than sending the operator to another screen.
      loadDevicesPage();
    });
  }
  for (const btn of $('devices-list').querySelectorAll('[data-setpw]')) {
    btn.addEventListener('click', () => {
      $('password-modal').dataset.deviceId = btn.dataset.setpw;
      $('pw-new').value = '';
      $('password-modal').hidden = false;
      $('pw-new').focus();
    });
  }
}

/**
 * A password read only completes when the device next wakes, which can be
 * half an hour. Poll while the page is open so the answer lands where it was
 * asked for, instead of the operator having to go and look for it later.
 */
let devicesPoll = null;

$('open-devices').addEventListener('click', () => {
  $('devices-page').hidden = false;
  loadDevicesPage();
  clearInterval(devicesPoll);
  devicesPoll = setInterval(() => loadDevicesPage().catch(() => {}), 15000);
});
$('close-devices').addEventListener('click', () => {
  $('devices-page').hidden = true;
  clearInterval(devicesPoll);
  devicesPoll = null;
});

$('device-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/devices', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: $('dev-id').value.trim(),
        name: $('dev-name').value.trim(),
        plateNumber: $('dev-plate').value.trim(),
        model: $('dev-model').value,
      }),
    });
    $('dev-id').value = '';
    $('dev-name').value = '';
    $('dev-plate').value = '';
    toast('تمت إضافة الجهاز — سيظهر عند اتصاله', 'ok');
    loadDevicesPage();
    refresh();
  } catch (err) {
    const messages = {
      device_exists: 'الجهاز مسجّل بالفعل',
      invalid_device_id: 'رقم الجهاز يجب أن يكون 10 أرقام',
      name_required: 'أدخل اسم المركبة',
    };
    toast(messages[String(err.message)] ?? 'تعذّرت الإضافة', 'bad');
  }
});

$('pw-cancel').addEventListener('click', () => ($('password-modal').hidden = true));

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deviceId = $('password-modal').dataset.deviceId;
  $('password-modal').hidden = true;
  try {
    const result = await api(`/api/devices/${deviceId}/password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: $('pw-new').value.trim() }),
    });
    // Deliberately not "changed": the device has to accept it first.
    toast(
      result.weakPassword
        ? 'أُرسل أمر التغيير — تنبيه: كلمة المرور سهلة التخمين'
        : 'أُرسل أمر التغيير — تُعتمد الكلمة الجديدة بعد تأكيد الجهاز',
      result.weakPassword ? 'bad' : 'ok',
    );
  } catch (err) {
    const messages = {
      password_must_be_6_chars: 'كلمة المرور يجب أن تكون 6 خانات',
    };
    toast(messages[String(err.message)] ?? 'تعذّر تغيير كلمة المرور', 'bad');
  }
});

// --- Locations catalogue ----------------------------------------------------

async function loadLocations() {
  state.locations = await api('/api/locations').catch(() => []);

  // Keep the operator's choice across a reload of the list, so adding a
  // location from the other page does not silently reset the selection.
  const select = $('arrival-location');
  const previous = select.value;
  select.innerHTML = state.locations.length
    ? state.locations
        .map((l) => `<option value="${l.id}">${escapeHtml(l.name)} — ${LOCATION_KINDS[l.kind] ?? l.kind}</option>`)
        .join('')
    : '<option value="">لا توجد مواقع — أضفها من صفحة المواقع</option>';
  if (previous && state.locations.some((l) => String(l.id) === previous)) select.value = previous;

  const list = $('locations-list');
  if (!state.locations.length) {
    list.innerHTML = '<li class="empty">لا توجد مواقع بعد</li>';
    return;
  }
  list.innerHTML = state.locations
    .map(
      (l) => `<li>
        <div class="row">
          <strong>${escapeHtml(l.name)}</strong>
          <button class="btn btn-ghost btn-xs" data-del-loc="${l.id}">حذف</button>
        </div>
        <div class="muted">
          ${LOCATION_KINDS[l.kind] ?? l.kind} · نطاق ${l.radius_m} م ·
          <span class="ltr-inline">${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}</span>
          ${l.address ? ` · ${escapeHtml(l.address)}` : ''}
        </div>
      </li>`,
    )
    .join('');

  for (const btn of list.querySelectorAll('[data-del-loc]')) {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/locations/${btn.dataset.delLoc}`, { method: 'DELETE' });
        toast('تم حذف الموقع', 'ok');
      } catch {
        toast('تعذّر حذف الموقع', 'bad');
      }
      loadLocations();
    });
  }
}

$('open-locations').addEventListener('click', () => {
  $('locations-page').hidden = false;
  loadLocations();
});
$('close-locations').addEventListener('click', () => ($('locations-page').hidden = true));

$('location-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const coords = parseCoords($('loc-coords').value);
  if (!coords) {
    toast('الإحداثيات غير صالحة — مثال: 32.85255, 13.07818', 'bad');
    return;
  }
  try {
    await api('/api/locations', {
      method: 'POST',
      body: JSON.stringify({
        name: $('loc-name').value.trim(),
        kind: $('loc-kind').value,
        latitude: coords.latitude,
        longitude: coords.longitude,
        radiusM: Number($('loc-radius').value),
        address: $('loc-address').value.trim(),
      }),
    });
    $('loc-name').value = '';
    $('loc-coords').value = '';
    $('loc-address').value = '';
    toast('تمت إضافة الموقع', 'ok');
    loadLocations();
  } catch (err) {
    toast(String(err.message) === 'name_taken' ? 'الاسم مستخدم بالفعل' : 'تعذّرت إضافة الموقع', 'bad');
  }
});

// --- Trip history page ------------------------------------------------------


async function openHistory() {
  $('history-page').hidden = false;

  const sel = $('hist-device');
  sel.innerHTML = state.devices
    .map((d) => `<option value="${d.device_id}">${escapeHtml(d.name)}</option>`)
    .join('');
  if (state.selectedId) sel.value = state.selectedId;

  // Its own map instance: past travel is a review activity, and drawing it on
  // the live map buried the present under the past.
  if (!historyMap) {
    const { googleMapsApiKey, arcgisApiKey, arcgisVersion } = await api('/api/config');
    const { createMap } = await import('/map.js');
    // Follows the same basemap the operator chose on the live map, so the
    // history view does not silently show a different world.
    historyMap = await createMap(
      $('history-map'),
      googleMapsApiKey,
      () => {},
      mapTheme(),
      chosenBasemap(googleMapsApiKey, arcgisApiKey),
      { apiKey: arcgisApiKey, version: arcgisVersion },
    );
  }
  loadHistory();
}

/** Trailing window, or an explicit from/to when "فترة محددة" is chosen. */
function historyRange() {
  const raw = $('hist-range').value;
  if (raw !== 'custom') return { query: `hours=${Number(raw)}`, label: rangeLabel(Number(raw)) };

  // datetime-local gives a wall-clock string with no zone; the browser reads
  // it in the operator's own zone, which is what they meant by typing it.
  const from = $('hist-from').value ? new Date($('hist-from').value) : null;
  const to = $('hist-to').value ? new Date($('hist-to').value) : null;
  if (!from && !to) return { query: 'hours=12', label: rangeLabel(12) };

  const params = new URLSearchParams();
  if (from) params.set('from', from.toISOString());
  if (to) params.set('to', to.toISOString());
  return {
    query: params.toString(),
    label: `${from ? fmtDateTime(from.toISOString()) : '…'} — ${to ? fmtDateTime(to.toISOString()) : 'الآن'}`,
  };
}

function rangeLabel(hours) {
  if (hours < 24) return `آخر ${hours} ساعة`;
  if (hours % 24 === 0) return `آخر ${hours / 24} يوم`;
  return `آخر ${hours} ساعة`;
}

$('hist-range').addEventListener('change', () => {
  $('hist-custom').hidden = $('hist-range').value !== 'custom';
});

async function loadHistory() {
  if (!historyMap) return;
  const deviceId = $('hist-device').value;
  const mode = $('hist-mode').value;
  if (!deviceId) return;

  const range = historyRange();
  const points = await api(`/api/devices/${deviceId}/track?${range.query}`).catch(() => []);

  // "Towards a destination" has a precise meaning here: the window between an
  // arrival rule being armed and it firing (or expiring). Movement inside
  // those windows is a delivery; everything else is the driver's own business
  // and is only shown when the operator explicitly asks for everything.
  let segments;
  let summary;
  if (mode === 'all') {
    const path = dropStationaryDrift(points.map((p) => [p.latitude, p.longitude]));
    segments = path.length > 1 ? [path] : [];
    summary = path.length ? `كل التحركات — ${points.length} نقطة · ${range.label}` : '';
  } else {
    const arrivals = await api(`/api/devices/${deviceId}/arrivals`).catch(() => []);
    const windows = arrivals.map((a) => [
      new Date(a.created_at),
      new Date(a.triggered_at ?? a.expires_at),
    ]);
    segments = windows
      .map(([start, end]) =>
        dropStationaryDrift(
          points
            .filter((p) => {
              const t = new Date(p.reported_at);
              return t >= start && t <= end;
            })
            .map((p) => [p.latitude, p.longitude]),
        ),
      )
      .filter((seg) => seg.length > 1);
    summary = segments.length
      ? `${segments.length} رحلة توصيل · ${range.label}`
      : 'لا توجد رحلات توصيل في هذه الفترة — اختر «كل التحركات» لعرض المسار كاملاً';
  }

  historyMap.setTrail(segments);

  const lastSegment = segments[segments.length - 1];
  const last = lastSegment?.[lastSegment.length - 1];
  if (last) {
    historyMap.setMarker(deviceId, last[0], last[1], { title: '', kind: 'locked', moving: false });
    historyMap.flyTo(last[0], last[1], 12);
  } else {
    historyMap.removeMarker(deviceId);
  }
  $('history-summary').textContent = summary || 'لا توجد بيانات مسار في هذه الفترة';

  // Lock activity for the same window, so the review reads as one story:
  // where it drove, and what the lock did along the way.
  const since = Date.now() - hours * 3600 * 1000;
  const events = (await api(`/api/devices/${deviceId}/events`).catch(() => [])).filter(
    (e) => new Date(e.reported_at) >= since,
  );
  $('history-events').innerHTML = events.length
    ? events
        .map((e) => {
          const notes = [];
          if (e.requested_by) notes.push(`بأمر من ${e.requested_by}`);
          if (e.rfid_card) notes.push(`البطاقة ${e.rfid_card}`);
          return `<li class="${e.unlock_allowed ? 'ok' : ''}">
            <div>${EVENT_NAMES[e.event_source_name] ?? e.event_source_name}</div>
            ${notes.length ? `<div class="muted">${notes.map(escapeHtml).join(' · ')}</div>` : ''}
            <div class="when">${fmtDateTime(e.reported_at)}</div>
          </li>`;
        })
        .join('')
    : '<li class="empty">لا توجد أحداث في هذه الفترة</li>';
}

$('open-history').addEventListener('click', openHistory);
$('close-history').addEventListener('click', () => ($('history-page').hidden = true));
$('hist-device').addEventListener('change', loadHistory);
$('hist-range').addEventListener('change', loadHistory);
$('hist-mode').addEventListener('change', loadHistory);
for (const id of ['hist-from', 'hist-to']) $(id).addEventListener('change', loadHistory);

let toastTimer;
function toast(message, kind) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

// --- Live updates -----------------------------------------------------------

/*
 * Reconnection is deliberately quiet.
 *
 * A dropped socket is usually a passing hiccup - a phone switching cell, a
 * laptop waking, a proxy timing out - and it recovers within a second or two.
 * Shouting "disconnected" at that is both wrong and corrosive: an operator who
 * sees the warning constantly stops believing it, and then misses the one time
 * it matters.
 *
 * So: silent for the first few attempts, a quiet note after that, and a real
 * warning only once it is genuinely broken. The data on screen is never
 * cleared - stale data with an honest timestamp beats an empty panel.
 */
const RECONNECT_SILENT_MS = 8000;
const RECONNECT_ALARM_MS = 60000;

let wsAttempt = 0;
let wsDownSince = null;
let wsStatusTimer = null;

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);

  ws.addEventListener('open', () => {
    wsAttempt = 0;
    wsDownSince = null;
    clearInterval(wsStatusTimer);
    setStatus('مباشر', 'pill-ok');
    // Catch up on anything missed while the socket was down.
    void refresh();
  });

  ws.addEventListener('message', (e) => applyUpdate(e.data));

  ws.addEventListener('close', () => {
    if (wsDownSince === null) {
      wsDownSince = Date.now();
      // Re-evaluate on a timer as well as on each attempt, so the wording
      // escalates even during a long backoff wait.
      wsStatusTimer = setInterval(renderConnectionStatus, 2000);
    }
    renderConnectionStatus();

    // Exponential backoff, capped: a server that is down should not be hit
    // every second by every open browser.
    const delay = Math.min(1000 * 2 ** wsAttempt++, 15000);
    setTimeout(connectWebSocket, delay);
  });

  ws.addEventListener('error', () => ws.close());
}

function renderConnectionStatus() {
  if (wsDownSince === null) return;
  const down = Date.now() - wsDownSince;
  if (down < RECONNECT_SILENT_MS) return; // brief blip: say nothing at all
  if (down < RECONNECT_ALARM_MS) setStatus('يعيد الاتصال…', 'pill-muted');
  else setStatus('انقطع الاتصال بالخادم', 'pill-danger');
}

/**
 * Apply one pushed change, or a batch of them.
 *
 * The server sends the changed vehicle's row with the notification, so the
 * common case patches entries instead of refetching the fleet. Two shapes are
 * accepted: the original `{ deviceId, device }` and a batch
 * `{ devices: [...] }`, so a server that batches its flushes and a console that
 * has not been reloaded yet keep working with each other.
 *
 * A vehicle not already in the list is ADDED, not refetched. Falling through to
 * a full-fleet `/api/devices` on an unknown id was a feedback loop that fired
 * hardest exactly when the database was already struggling — every open console
 * refetching all 3,000 rows on every flush.
 */
function applyUpdate(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return void refresh();
  }

  const incoming = Array.isArray(msg?.devices)
    ? msg.devices
    : msg?.deviceId && msg.device
      ? [msg.device]
      : null;

  // A bare nudge with no payload at all is still honoured: a malformed or
  // partial message must never leave the console silently out of date.
  if (!incoming) return void refresh();

  const byId = new Map(state.devices.map((d, i) => [d.device_id, i]));
  let touchedSelected = false;

  for (const device of incoming) {
    if (!device?.device_id) continue;
    const i = byId.get(device.device_id);
    if (i === undefined) {
      byId.set(device.device_id, state.devices.length);
      state.devices.push(device);
    } else {
      state.devices[i] = device;
    }
    if (state.selectedId === device.device_id) touchedSelected = true;
  }

  renderDeviceList();
  syncMarkers();
  followSelected();
  if (touchedSelected) renderDetail();
}

function setStatus(text, cls) {
  const el = $('conn-status');
  el.textContent = text;
  el.className = `pill ${cls}`;
}

async function refresh() {
  state.devices = await api('/api/devices');
  renderDeviceList();
  syncMarkers();
  followSelected();
  if (state.selectedId) renderDetail();
}

/**
 * Keep the selected vehicle in view.
 *
 * At 9 km/h a truck moves 75 m between reports - a few dozen pixels at street
 * zoom. It is genuinely moving, but against a fixed viewport it reads as
 * stationary, and eventually it simply leaves the screen.
 */
function followSelected() {
  if (!state.follow || !state.selectedId || !state.map) return;
  const d = state.devices.find((x) => x.device_id === state.selectedId);
  if (d && hasLocation(d)) state.map.panTo(d.latitude, d.longitude);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// --- Boot -------------------------------------------------------------------

async function start() {
  $('login').hidden = true;
  $('app').hidden = false;
  await initMap();
  try {
    await refresh();
  } catch {
    // api() has already redirected to login; don't open a live socket or
    // start timers against a session we know is dead.
    return;
  }
  connectWebSocket();
  // The arrival form's location dropdown is filled from this. Loading it only
  // when the locations page opened meant the dropdown sat empty until you
  // happened to visit that page.
  loadLocations().catch(() => {});
  // Timestamps are relative ("2 minutes ago"), so re-render even when idle.
  setInterval(renderDeviceList, 30000);
}

(async () => {
  try {
    const { authenticated, mayUnlock, username } = await fetch('/api/session').then((r) => r.json());
    if (authenticated) {
      // Carried so the console can hide controls this account cannot use. The
      // routes enforce it regardless — a hidden button is a courtesy, not a
      // permission check.
      state.mayUnlock = mayUnlock === true;
      state.username = username ?? null;
      return start();
    }
  } catch {
    // Network or server unavailable — fall through to the login screen rather
    // than leaving the page in whatever state the markup happened to start in.
  }
  showLogin();
})();
