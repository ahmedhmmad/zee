/* Fleet console. Arabic UI, Latin numerals, Africa/Tripoli times. */

const $ = (id) => document.getElementById(id);

const state = {
  devices: [],
  locations: [],
  selectedId: null,
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

// Remembered per browser: an operator in a control room and one checking on a
// phone outdoors want opposite answers, and neither should have to re-choose.
const THEME_KEY = 'zee.mapTheme';
const mapTheme = () => localStorage.getItem(THEME_KEY) ?? 'dark';

function renderThemeButton() {
  const btn = $('map-theme');
  btn.hidden = !state.map?.supportsTheme;
  btn.textContent = mapTheme() === 'dark' ? '🌙 داكن' : '☀️ فاتح';
}

$('map-theme').addEventListener('click', () => {
  const next = mapTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  state.map?.setTheme(next);
  renderThemeButton();
});

async function initMap() {
  if (state.map) return;
  const { googleMapsApiKey } = await api('/api/config');
  const { createMap } = await import('/map.js');
  state.map = await createMap(
    document.getElementById('map'),
    googleMapsApiKey,
    selectDevice,
    mapTheme(),
  );
  console.info(`[map] using ${state.map.provider}`);
  // Raster tiles cannot be restyled, so the button only exists for Google.
  renderThemeButton();
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
  if (!state.map) return;
  for (const device of state.devices) {
    if (!hasLocation(device)) {
      state.map.removeMarker(device.device_id);
      continue;
    }
    state.map.setMarker(device.device_id, device.latitude, device.longitude, {
      title: device.name,
      heading: Number(device.heading_deg ?? 0),
      moving: isMoving(device),
      kind:
        connectionState(device) === 'offline'
          ? 'offline'
          : device.motor_locked === false
            ? 'unlocked'
            : 'locked',
    });
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
    // Only genuine loss of contact greys a vehicle out. A sleeping device
    // still shows its lock state, because that is what operators care about.
    li.classList.add(
      connectionState(d) === 'offline'
        ? 'is-offline'
        : d.motor_locked === false
          ? 'is-unlocked'
          : 'is-locked',
    );
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
  await Promise.all([
    loadCommands(d.device_id),
    loadEvents(d.device_id),
    loadArrivals(d.device_id),
    loadTrail(d.device_id),
  ]);
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
  state.map?.clearTrail?.();
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
  } catch {
    toast('تعذّر إرسال الأمر', 'bad');
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
        if (a.is_armed) {
          if (a.current_distance_m != null) {
            notes.push(
              Number(a.current_distance_m) <= a.radius_m
                ? 'المركبة داخل النطاق'
                : `المسافة الحالية ${formatDistance(a.current_distance_m)}`,
            );
          }
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
        await api(`/api/devices/${deviceId}/arrivals/${btn.dataset.disarm}`, { method: 'DELETE' });
        toast('تم إلغاء الفتح التلقائي', 'ok');
        loadArrivals(deviceId);
      });
    }
  } catch {
    list.innerHTML = '<li class="empty">تعذّر التحميل</li>';
  }
}

const formatDistance = (m) =>
  Number(m) >= 1000 ? `${(Number(m) / 1000).toFixed(1)} كم` : `${Math.round(Number(m))} م`;

/**
 * Draw the road the vehicle actually drove, from stored positions.
 *
 * This is the path that matters operationally: a straight line to the
 * destination says where the truck should end up, but the trail shows where it
 * has been - which is what reveals an unscheduled stop or a detour.
 */
async function loadTrail(deviceId) {
  if (!state.map?.setTrail) return;
  try {
    const points = await api(`/api/devices/${deviceId}/track?hours=12`);
    state.map.setTrail(points.map((p) => [p.latitude, p.longitude]));
  } catch {
    state.map.clearTrail?.();
  }
}

/**
 * Only armed destinations for the selected vehicle are drawn. Showing every
 * rule for every truck at once would bury the one the operator is watching.
 */
function drawDestinations(deviceId, arrivals) {
  if (!state.map?.setDestination) return;
  state.map.clearDestinations();

  const device = state.devices.find((d) => d.device_id === deviceId);
  const from = device && hasLocation(device) ? { lat: device.latitude, lon: device.longitude } : null;

  for (const a of arrivals.filter((x) => x.is_armed)) {
    state.map.setDestination(`arrival-${a.id}`, a.latitude, a.longitude, {
      radiusM: a.radius_m,
      label: a.name,
      from,
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

// --- Locations catalogue ----------------------------------------------------

async function loadLocations() {
  state.locations = await api('/api/locations').catch(() => []);

  const select = $('arrival-location');
  select.innerHTML = state.locations.length
    ? state.locations
        .map((l) => `<option value="${l.id}">${escapeHtml(l.name)} — ${LOCATION_KINDS[l.kind] ?? l.kind}</option>`)
        .join('')
    : '<option value="">لا توجد مواقع — أضفها من صفحة المواقع</option>';

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
      await api(`/api/locations/${btn.dataset.delLoc}`, { method: 'DELETE' });
      toast('تم حذف الموقع', 'ok');
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
