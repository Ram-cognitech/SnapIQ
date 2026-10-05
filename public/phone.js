// The phone: pair once, then photograph pages and send the document.
//
// The order of work matters and is the same as in clean.js: the page is found
// and straightened at the photograph's own resolution, and only then shrunk to
// what 300 DPI needs. Shrinking first would resample the image twice and soften
// the small text that was the reason for scanning it.
//
// Drawing the photo through a canvas is also what strips the camera's metadata,
// so the location it was taken at never leaves the phone.

import { cleanPage, detectPage, orderCorners, refineCorners, MAX_LONG_EDGE } from './clean.js';
import { detectCorners, warmUp } from './detect.js';
import { buildPdf } from './pdf.js';
import { sha256Hex, uuid } from './digest.js';

const DECODE_LONG_EDGE = 4000;    // ~12 MP: enough that a cropped page still reaches 300 DPI
const QUALITY = 0.85;
const HANDLE_GRAB = 28;           // how close a thumb has to be, in CSS pixels
const MIN_CONFIDENCE = 0.5;       // below this the model is guessing, and says so

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let deviceKey = null;
try { deviceKey = localStorage.getItem('snapiq.device'); } catch { /* private window */ }
const channelId = params.get('c') || null;

let scanId = null;
let pages = [];            // { jpeg, width, height } for the PDF
let shot = null;           // { image, corners } awaiting confirmation
let dragging = -1;
let tone = 'normal';       // remembered between pages: the light rarely changes
let preview = null;        // the cleaned page, small, for looking at

const PREVIEW_EDGE = 900;  // big enough to judge, small enough to redo instantly

// --- talking to the API ---------------------------------------------------

const api = async (path, { method = 'GET', body, token = deviceKey } = {}) => {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { /* no body */ }
  return { status: response.status, body: parsed };
};


const say = (text, kind = 'ok') => {
  const note = $('note');
  note.textContent = text;
  note.className = `note ${kind}`;
};
const clearSay = () => $('note').classList.add('hidden');

// --- pairing, once --------------------------------------------------------

async function pair(claimToken) {
  const label = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone'
    : /Android/.test(navigator.userAgent) ? 'Android phone' : 'a phone';
  const { status, body } = await api('/v1/devices/claim', {
    method: 'POST', token: null, body: { claim_token: claimToken, label },
  });
  if (status === 201) {
    deviceKey = body.device_key;
    try { localStorage.setItem('snapiq.device', deviceKey); } catch { /* this visit only */ }
    stripClaimFromUrl();
    say('This phone is linked. You only do this once.');
    return;
  }
  say(status === 410
    ? 'That code has already been used. Ask your computer for a new one.'
    : 'That code did not work. Ask your computer for a new one.', 'bad');
}

// The token in the address is single use and now spent; leaving it in the bar
// means it ends up in history and in anything that reads the URL.
const stripClaimFromUrl = () =>
  history.replaceState(null, '', channelId ? `/phone?c=${encodeURIComponent(channelId)}` : '/phone');

// --- taking the photograph ------------------------------------------------

async function toImageData(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, DECODE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return context.getImageData(0, 0, width, height);
}

async function took(file) {
  if (!file) return;
  screen('busy');
  $('busy-text').textContent = 'Looking for the page…';
  try {
    const image = await toImageData(file);
    shot = { image, corners: frameOf(image), detected: false, canvas: null };

    const found = await findPage(image);
    // No page found is a real answer: the whole frame is offered instead of a
    // confident wrong crop, and the corners can be dragged.
    shot.corners = found ?? frameOf(image);
    shot.detected = Boolean(found);

    drawCrop();
    screen('crop');
    say(shot.detected ? 'Drag a corner if the edges are wrong.' : 'No page found — drag the corners to its edges.',
      shot.detected ? 'ok' : 'bad');
  } catch (error) {
    screen('ready');
    say(error.message || 'That photo could not be read.', 'bad');
  }
}

const frameOf = (image) => [
  [0, 0], [image.width - 1, 0], [image.width - 1, image.height - 1], [0, image.height - 1],
];

// The model first, the brightness detector second, and the edges fitted to
// whichever answered.
//
// The brightness detector cannot separate a page from another page touching
// it, and a hard shadow puts much of the sheet below its threshold, so on a
// real desk it usually declines. The model copes with both. Neither is trusted
// blindly: the corners are put onto the page's own edges afterwards, and the
// person can still drag them.
async function findPage(image) {
  $('busy-text').textContent = 'Looking for the page…';
  try {
    const model = await detectCorners(sourceCanvas(), image);
    if (model && model.mean >= MIN_CONFIDENCE) {
      // The quarter turn is taken from the model and the half turn ignored: it
      // locates corners, it cannot read, so it does not know up from down.
      const ordered = orderCorners(model.corners);
      const shift = model.turns % 2 ? model.turns % 4 : 0;
      const turned = shift ? [...ordered.slice(shift), ...ordered.slice(0, shift)] : ordered;
      return refineCorners(image, turned);
    }
  } catch {
    // Any trouble at all and we carry on without it.
  }
  const found = detectPage(image);
  return found ? refineCorners(image, found) : null;
}

// --- the crop you can correct ---------------------------------------------

// The photograph on a canvas, made once and kept.
//
// It was being rebuilt on every pointer event, which pushed twelve megapixels
// through putImageData for each pixel of finger movement and made dragging a
// corner crawl. Nothing about the photo changes while it is being cropped.
// A plain canvas rather than an OffscreenCanvas: this has to work on an older
// iPhone, and once is not hot enough to need the faster one.
function sourceCanvas() {
  if (shot.canvas) return shot.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = shot.image.width;
  canvas.height = shot.image.height;
  canvas.getContext('2d').putImageData(shot.image, 0, 0);
  shot.canvas = canvas;
  return canvas;
}

// A magnified view of what is under the finger, drawn away from it.
//
// Placing a corner by touch is otherwise guesswork: the fingertip covers the
// exact spot being aimed at. The loupe goes to whichever side of the picture
// the finger is not on, so it never ends up under the hand either.
function showLoupe(corner) {
  const loupe = $('loupe');
  const size = loupe.width;                 // the drawing buffer, 320
  const zoom = 4;
  const span = size / zoom;                 // how much of the photo is shown

  const context = loupe.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size, size);
  context.drawImage(
    sourceCanvas(),
    corner[0] - span / 2, corner[1] - span / 2, span, span,
    0, 0, size, size
  );

  // Crosshair, so the exact point is visible rather than implied.
  context.strokeStyle = '#3b5bdb';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(size / 2, size / 2 - 26);
  context.lineTo(size / 2, size / 2 + 26);
  context.moveTo(size / 2 - 26, size / 2);
  context.lineTo(size / 2 + 26, size / 2);
  context.stroke();
  context.beginPath();
  context.arc(size / 2, size / 2, 9, 0, Math.PI * 2);
  context.stroke();

  // Opposite side to the finger, horizontally and vertically.
  const onLeft = corner[0] / shot.image.width < 0.5;
  const onTop = corner[1] / shot.image.height < 0.5;
  loupe.style.left = onLeft ? 'auto' : '10px';
  loupe.style.right = onLeft ? '10px' : 'auto';
  loupe.style.top = onTop ? 'auto' : '10px';
  loupe.style.bottom = onTop ? '10px' : 'auto';
  loupe.classList.remove('hidden');
}

const hideLoupe = () => $('loupe').classList.add('hidden');

function drawCrop() {
  const canvas = $('crop-canvas');
  const { image, corners } = shot;
  const room = Math.min(window.innerWidth - 32, 460);
  const scale = room / image.width;
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);

  const context = canvas.getContext('2d');
  context.drawImage(sourceCanvas(), 0, 0, canvas.width, canvas.height);

  const at = ([x, y]) => [x * scale, y * scale];

  // Everything outside the page, dimmed, so the crop reads at a glance.
  context.save();
  context.beginPath();
  context.rect(0, 0, canvas.width, canvas.height);
  context.moveTo(...at(corners[0]));
  for (const corner of corners.slice(1)) context.lineTo(...at(corner));
  context.closePath();
  context.fillStyle = 'rgba(10,12,16,.55)';
  context.fill('evenodd');
  context.restore();

  context.beginPath();
  context.moveTo(...at(corners[0]));
  for (const corner of corners.slice(1)) context.lineTo(...at(corner));
  context.closePath();
  context.strokeStyle = '#8aa2ff';
  context.lineWidth = 2;
  context.stroke();

  for (const corner of corners) {
    const [x, y] = at(corner);
    context.beginPath();
    context.arc(x, y, 11, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();
    context.strokeStyle = '#3b5bdb';
    context.lineWidth = 3;
    context.stroke();
  }
  canvas.dataset.scale = String(scale);
}

const pointerAt = (event) => {
  const canvas = $('crop-canvas');
  const box = canvas.getBoundingClientRect();
  const scale = Number(canvas.dataset.scale);
  return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale, scale };
};

function grab(event) {
  if (!shot) return;
  // Always, not only when a handle is caught: a touch that misses still
  // starts a selection otherwise.
  event.preventDefault();
  const { x, y, scale } = pointerAt(event);
  let nearest = -1;
  let best = Infinity;
  shot.corners.forEach(([cx, cy], index) => {
    const distance = Math.hypot(cx - x, cy - y) * scale;
    if (distance < best) { best = distance; nearest = index; }
  });
  if (best <= HANDLE_GRAB) {
    dragging = nearest;
    $('crop-canvas').setPointerCapture?.(event.pointerId);
    showLoupe(shot.corners[nearest]);
    event.preventDefault();
  }
}

function drag(event) {
  if (dragging < 0 || !shot) return;
  const { x, y } = pointerAt(event);
  shot.corners[dragging] = [
    Math.max(0, Math.min(shot.image.width - 1, Math.round(x))),
    Math.max(0, Math.min(shot.image.height - 1, Math.round(y))),
  ];
  drawCrop();
  showLoupe(shot.corners[dragging]);
  event.preventDefault();
}

const release = () => { dragging = -1; hideLoupe(); };

// --- cleaning and sending -------------------------------------------------

const cropCorners = () => (shot.detected || moved() ? shot.corners : null);

// Straighten and clean a small copy, which is quick enough to redo every time
// the tone is changed. The full-size version is only made once, on send.
async function showPreview() {
  if (!shot) return;
  screen('busy');
  $('busy-text').textContent = 'Straightening and cleaning…';
  await new Promise((resolve) => setTimeout(resolve, 16));

  try {
    preview = cleanPage(shot.image, cropCorners(), { maxEdge: PREVIEW_EDGE, tone });
    drawPreview();
    markTone();
    screen('review');
    clearSay();
  } catch (error) {
    screen('crop');
    say(error.message || 'That page could not be cleaned.', 'bad');
  }
}

function drawPreview() {
  const canvas = $('review-canvas');
  canvas.width = preview.width;
  canvas.height = preview.height;
  canvas.getContext('2d').putImageData(new ImageData(preview.data, preview.width, preview.height), 0, 0);
}

const markTone = () => {
  for (const name of ['soft', 'normal', 'bright', 'text']) {
    $(`tone-${name}`).classList.toggle('chosen', name === tone);
  }
};

async function retone(which) {
  tone = which;
  markTone();
  // Small enough that this is near-instant, so it feels like a control rather
  // than a round trip.
  preview = cleanPage(shot.image, cropCorners(), { maxEdge: PREVIEW_EDGE, tone });
  drawPreview();
}

async function sendThisPage() {
  if (!shot) return;
  screen('busy');
  $('busy-text').textContent = 'Cleaning at full size…';
  await new Promise((resolve) => setTimeout(resolve, 16));

  try {
    const cleaned = cleanPage(shot.image, cropCorners(), { maxEdge: MAX_LONG_EDGE, tone });
    const blob = await encode(cleaned);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    $('busy-text').textContent = 'Sending…';
    await upload(bytes);

    pages.push({ jpeg: bytes, width: cleaned.width, height: cleaned.height });
    addThumb(blob);
    shot = null;
    preview = null;
    screen('ready');
    say(pages.length === 1 ? 'Page sent. It is on your computer.' : `${pages.length} pages sent.`);
    $('take-label').textContent = 'Add another page';
    $('done').classList.remove('hidden');
    $('hint').textContent = 'Add more pages, or press Done to finish the document.';
  } catch (error) {
    screen('review');
    say(error.message || 'That did not work. Try again.', 'bad');
  }
}

// Did the person move the corners away from the whole frame? If so, use them
// even though nothing was detected automatically.
function moved() {
  const frame = frameOf(shot.image);
  return shot.corners.some((corner, i) => corner[0] !== frame[i][0] || corner[1] !== frame[i][1]);
}

async function encode({ data, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the page could not be encoded'))),
      'image/jpeg',
      QUALITY
    );
  });
}

async function upload(bytes) {
  const digest = await sha256Hex(bytes);

  if (!scanId) {
    const started = await api('/v1/scans', {
      method: 'POST',
      body: { channel_id: channelId, idempotency_key: uuid() },
    });
    if (started.status === 401) return unlink();
    if (started.status !== 201) throw new Error(started.body?.detail ?? 'could not start the document');
    scanId = started.body.scan_id;
  }

  const asked = await api(`/v1/scans/${scanId}/pages`, {
    method: 'POST',
    body: { bytes: bytes.length, content_type: 'image/jpeg', sha256: digest, idempotency_key: uuid() },
  });
  if (asked.status !== 201) throw new Error(asked.body?.detail ?? 'could not add the page');

  const put = await fetch(asked.body.upload_url, {
    method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: bytes,
  });
  if (!put.ok) throw new Error('the upload did not go through');

  const committed = await api(`/v1/scans/${scanId}/pages/${asked.body.page_id}/commit`, {
    method: 'POST', body: { sha256: digest },
  });
  if (committed.status !== 200) throw new Error(committed.body?.detail ?? 'the page did not arrive whole');
}

// --- finishing: the pages become one document -----------------------------

async function finish() {
  if (!scanId || !pages.length) return;
  screen('busy');
  $('busy-text').textContent = 'Building the document…';
  await new Promise((resolve) => setTimeout(resolve, 16));

  try {
    const pdf = buildPdf(pages);
    const digest = await sha256Hex(pdf);

    const asked = await api(`/v1/scans/${scanId}/document`, {
      method: 'POST',
      body: { bytes: pdf.length, sha256: digest, idempotency_key: uuid() },
    });
    if (asked.status !== 201) throw new Error(asked.body?.detail ?? 'could not send the document');

    const put = await fetch(asked.body.upload_url, {
      method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf,
    });
    if (!put.ok) throw new Error('the document did not go through');

    const committed = await api(`/v1/scans/${scanId}/document/commit`, { method: 'POST', body: { sha256: digest } });
    if (committed.status !== 200) throw new Error('the document did not arrive whole');

    const closed = await api(`/v1/scans/${scanId}/close`, { method: 'POST', body: {} });
    if (closed.status !== 200) throw new Error('could not finish the document');

    const count = closed.body.page_count;
    say(`Done — ${count} page${count === 1 ? '' : 's'} on your computer.`);
    reset();
  } catch (error) {
    screen('ready');
    say(error.message || 'Could not finish the document.', 'bad');
  }
}

function reset() {
  scanId = null;
  pages = [];
  shot = null;
  $('pages').replaceChildren();
  $('take-label').textContent = 'Take a photo';
  $('done').classList.add('hidden');
  $('hint').textContent = 'It will appear on your computer straight away.';
  screen('ready');
}

function addThumb(blob) {
  const img = document.createElement('img');
  img.src = URL.createObjectURL(blob);
  img.alt = '';
  $('pages').append(img);
}

function unlink() {
  deviceKey = null;
  try { localStorage.removeItem('snapiq.device'); } catch { /* nothing to remove */ }
  screen('unpaired');
  say('This phone was unlinked. Scan a new code from your computer.', 'bad');
}

// --- which screen ---------------------------------------------------------

function screen(which) {
  for (const name of ['unpaired', 'ready', 'crop', 'review', 'busy']) {
    $(name).classList.toggle('hidden', name !== which);
  }
}

// --- wiring ---------------------------------------------------------------

$('take').onclick = () => $('camera').click();
$('choose').onclick = () => $('gallery').click();
$('done').onclick = finish;
$('use-page').onclick = showPreview;
$('send-page').onclick = sendThisPage;
$('back-to-crop').onclick = () => { clearSay(); screen('crop'); };
for (const name of ['soft', 'normal', 'bright', 'text']) $(`tone-${name}`).onclick = () => retone(name);
$('retake').onclick = () => { shot = null; preview = null; hideLoupe(); clearSay(); screen('ready'); };
$('whole-photo').onclick = () => {
  shot.corners = frameOf(shot.image);
  shot.detected = false;
  drawCrop();
};

for (const id of ['camera', 'gallery']) {
  $(id).onchange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    took(file);
  };
}

const canvas = $('crop-canvas');
canvas.addEventListener('pointerdown', grab);
canvas.addEventListener('pointermove', drag);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

const claim = params.get('t');
if (claim && !deviceKey) await pair(claim);
else if (claim) stripClaimFromUrl();
screen(deviceKey ? 'ready' : 'unpaired');

// Start fetching the model now, so the wait does not land on the person who
// has just taken a photograph. Failure here is silent and harmless.
if (deviceKey) warmUp();
