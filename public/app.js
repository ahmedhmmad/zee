/* Fleet console. Arabic UI, Latin numerals, Africa/Tripoli times. */

const TRIPOLI = [13.1913, 32.8872]; // [lon, lat] for MapLibre
const $ = (id) => document.getElementById(id);

const state = {
  devices: [],
  selectedId: null,
  markers: new Map(),
  map: null,
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

const COMMAND_STATUS = {
  queued: ['في الانتظار', 'pending'],
  approved: ['معتمَد', 'pending'],
  sent: ['أُرسل — بانتظار تأكيد الجهاز', 'pending'],
  confirmed: ['تم التأكيد من الجهاز', 'ok'],
  failed: ['فشل', 'bad'],
  expired: ['انتهت صلاحيته', 'bad'],
  rejected: ['مرفوض', 'bad'],
  pending_approval: ['بانتظار الموافقة', 'pending'],
  draft: ['مسودة', 'pending'],
};

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
    headers: { 'Content-Type': 'application/json' },
    ...options,
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
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    start();
  } catch {
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// --- Map --------------------------------------------------------------------

/**
 * Raster fallback: OSM tiles proxied through our own origin, since OSM is not
 * reliably reachable from Libya. Labels are baked into the images in each
 * country's own language, which is why the vector basemap is preferred.
 */
function rasterStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [`${location.origin}/api/tiles/{z}/{x}/{y}.png`],
        tileSize: 256,
        attribution: '© OpenStreetMap',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  };
}

/**
 * Raster is the default. The vector basemap is kept behind ?vector=1 but is
 * NOT production-ready, for two reasons found on real hardware:
 *
 *  - Arabic renders as isolated, left-to-right letters. MapLibre needs the
 *    RTL text plugin for Arabic shaping and bidi, which is not wired up.
 *  - Tiles intermittently fail to parse ("Unimplemented type: 4") in Chrome
 *    even though the archive, byte ranges and decompression all verify
 *    correct when fetched directly.
 *
 * Raster labels each country in its own language, but the map is bounded to
 * Libya, so in practice everything on screen is Arabic anyway - which was the
 * actual requirement.
 */
async function resolveStyle() {
  if (!new URLSearchParams(location.search).has('vector')) return rasterStyle();

  try {
    const head = await fetch('/basemap/libya.pmtiles', { method: 'HEAD' });
    if (!head.ok) throw new Error('no basemap');

    const { buildStyle } = await import('/map-style.js');
    // Teach MapLibre to read pmtiles:// URLs as ranged reads of one file.
    maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
    return buildStyle(`${location.origin}/basemap/libya.pmtiles`, '/basemap/glyphs/{fontstack}/{range}.pbf');
  } catch {
    console.info('vector basemap unavailable, using raster tiles');
    return rasterStyle();
  }
}

async function initMap() {
  if (state.map) return;
  state.map = new maplibregl.Map({
    container: 'map',
    style: await resolveStyle(),
    center: TRIPOLI,
    zoom: 11,
    // OSM raster tiles label each country in its own language, so zooming out
    // over the Mediterranean brings in Greek, Italian and English. Operations
    // are in Libya, so constrain the view: at these bounds and zoom levels the
    // labels are Arabic. Bounds are generous enough to cover border crossings.
    maxBounds: [
      [7, 17],
      [28, 35],
    ],
    minZoom: 5,
    maxZoom: 18,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  // app.js is a module, so nothing here is reachable from the console. Expose
  // the map deliberately: diagnosing a blank basemap without it means guessing.
  window.__zeeMap = state.map;
  state.map.on('error', (e) => console.error('[map]', e?.error?.message ?? e));
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

function syncMarkers() {
  for (const device of state.devices) {
    if (!hasLocation(device)) {
      // Drop any marker left over from a previous fix.
      const stale = state.markers.get(device.device_id);
      if (stale) {
        stale.remove();
        state.markers.delete(device.device_id);
      }
      continue;
    }

    let marker = state.markers.get(device.device_id);
    if (!marker) {
      const el = document.createElement('div');
      el.className = 'truck-marker';
      el.textContent = '🚛';
      el.addEventListener('click', () => selectDevice(device.device_id));
      marker = new maplibregl.Marker({ element: el }).setLngLat([device.longitude, device.latitude]);
      marker.addTo(state.map);
      state.markers.set(device.device_id, marker);
    } else {
      marker.setLngLat([device.longitude, device.latitude]);
    }

    const el = marker.getElement();
    el.classList.toggle('unlocked', device.motor_locked === false);
    el.classList.toggle('offline', !device.is_connected);
    el.title = device.name;
  }
}

// --- Rendering --------------------------------------------------------------

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
  list.innerHTML = '';

  if (visible.length === 0) {
    list.innerHTML = '<li class="muted">لا توجد مركبات مطابقة</li>';
    return;
  }

  for (const d of visible) {
    const li = document.createElement('li');
    li.className = 'device-item';
    li.classList.add(!d.is_connected ? 'is-offline' : d.motor_locked === false ? 'is-unlocked' : 'is-locked');
    if (d.device_id === state.selectedId) li.classList.add('selected');

    li.innerHTML = `
      <div class="row">
        <span class="name">${escapeHtml(d.name)}</span>
        ${lockPill(d)}
      </div>
      <div class="row">
        <span class="muted">${escapeHtml(d.plate_number ?? d.device_id)}</span>
        <span class="muted">${batteryLabel(d)} · ${fmtAgo(d.last_seen_at)}</span>
      </div>`;
    li.addEventListener('click', () => selectDevice(d.device_id));
    list.appendChild(li);
  }
}

function lockPill(d) {
  if (!d.is_connected) return '<span class="pill pill-muted">غير متصل</span>';
  if (d.motor_locked === false) return '<span class="pill pill-danger">مفتوح</span>';
  return '<span class="pill pill-ok">مقفل</span>';
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
  $('d-battery').textContent = batteryLabel(d);
  $('d-speed').textContent = d.speed_kph != null ? `${Number(d.speed_kph).toFixed(0)} كم/س` : '—';
  $('d-signal').textContent = signalLabel(d);
  $('d-sats').textContent = d.satellites ?? '—';
  $('d-rope').textContent = d.rope_inserted == null ? '—' : d.rope_inserted ? 'مُدخَل' : 'مسحوب';
  $('d-mileage').textContent = d.mileage_km != null ? `${d.mileage_km} كم` : '—';
  $('d-carrier').textContent = carrierLabel(d);
  $('d-devid').textContent = d.device_id;
  $('d-model').textContent = d.model ?? '—';
  $('d-imei').textContent = d.imei ?? '—';
  $('d-firmware').textContent = d.firmware_version ?? 'غير معروف — أرسل الأمر P01';
  $('d-seen').textContent = `${fmtAgo(d.last_seen_at)} (${fmtTime(d.last_seen_at)})`;
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

  $('unlock-btn').disabled = false;
  await Promise.all([loadCommands(d.device_id), loadEvents(d.device_id)]);
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
        const [label, cls] = COMMAND_STATUS[c.status] ?? [c.status, ''];
        return `<li class="${cls}">
          <div><strong>${label}</strong></div>
          <div class="muted">${escapeHtml(c.reason ?? '')}</div>
          <div class="when">${fmtDateTime(c.requested_at)} · ${escapeHtml(c.requested_by ?? '')}</div>
        </li>`;
      })
      .join('');
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
    list.innerHTML = events
      .slice(0, 12)
      .map((e) => {
        const refused = e.refused_outside_fence;
        // An auto-lock is neither success nor failure, just a state change.
        const neutral = e.event_source_name === 'auto_locked';
        const cls = neutral ? '' : refused || !e.unlock_allowed ? 'bad' : 'ok';

        const notes = [];
        if (refused) notes.push('رُفض خارج المنطقة المسموحة');
        if (e.wrong_password_count > 0) notes.push(`محاولات خاطئة: ${e.wrong_password_count}`);
        // Which card opened it is the whole point of an audit trail.
        if (e.rfid_card) notes.push(`البطاقة ${e.rfid_card}`);
        if (e.command_id) notes.push('بأمر من المنظومة');

        return `<li class="${cls}">
          <div>${EVENT_NAMES[e.event_source_name] ?? e.event_source_name}</div>
          ${notes.length ? `<div class="muted">${notes.map(escapeHtml).join(' · ')}</div>` : ''}
          <div class="when">${fmtDateTime(e.reported_at)}</div>
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
  if (d && hasLocation(d)) {
    state.map.flyTo({ center: [d.longitude, d.latitude], zoom: 14, duration: 800 });
  }
  renderDeviceList();
  renderDetail();
}

$('detail-close').addEventListener('click', () => {
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
      body: JSON.stringify({ reason }),
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
  } catch {
    toast('تعذّر إرسال الأمر', 'bad');
  }
});

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

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);

  ws.addEventListener('open', () => setStatus('مباشر', 'pill-ok'));
  ws.addEventListener('message', () => refresh());
  ws.addEventListener('close', () => {
    setStatus('انقطع الاتصال — إعادة المحاولة…', 'pill-warn');
    setTimeout(connectWebSocket, 3000);
  });
  ws.addEventListener('error', () => ws.close());
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
  if (state.selectedId) renderDetail();
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
  // Timestamps are relative ("2 minutes ago"), so re-render even when idle.
  setInterval(renderDeviceList, 30000);
}

(async () => {
  try {
    const { authenticated } = await fetch('/api/session').then((r) => r.json());
    if (authenticated) return start();
  } catch {
    // Network or server unavailable — fall through to the login screen rather
    // than leaving the page in whatever state the markup happened to start in.
  }
  showLogin();
})();
