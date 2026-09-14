// Image production queue runner.
//
// REQUIRES: GEMINI_API_KEY in .env at the repo root (e.g. GEMINI_API_KEY=your-key).
// .env is gitignored - never commit it.
//
// For every row in image-production-queue.csv with status "Queued", this generates an
// image with Gemini (gemini-3.1-flash-image), saves it as {folder}/{file_name}.png at
// exactly width x height, and writes status / output_dimensions / error_note back to
// the CSV after each row. Rows with any other status are left untouched, so to make a
// new asset, add a row with status "Queued" and re-run.
//
// Windows only: PNG conversion and crop/resize use scripts/resize.ps1 (System.Drawing).
//
// Usage (from the repo root):
//   node scripts/generate-images.mjs --dry-run      Show what would be generated. No API calls.
//   node scripts/generate-images.mjs                Generate. Spends API credits.
//   node scripts/generate-images.mjs --csv <file>   Use a different queue file.
//
// CSV columns: id, prompt, width, height, aspect_ratio, file_name, folder, style_reference,
// status, drive_url, error_note, output_dimensions. style_reference is an optional repo-relative
// PNG/JPEG sent to the model as a reference image. aspect_ratio is informational; the request
// uses the supported ratio closest to width:height, then center-crops to the exact size.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const RESIZE_PS1 = path.join(SCRIPTS_DIR, 'resize.ps1');
// Unprocessed API output and responses, for debugging. Kept outside the repo.
const RAW_DIR = path.join(os.tmpdir(), 'image-production-queue-raw');
const MODEL = 'gemini-3.1-flash-image';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const PRICE_PER_TOKEN = 60 / 1e6; // gemini-3.1-flash-image image output, USD

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const csvFlag = args.indexOf('--csv');
if (csvFlag !== -1 && !args[csvFlag + 1]) {
  console.error('--csv needs a file path');
  process.exit(1);
}
const CSV_PATH = csvFlag !== -1 ? path.resolve(args[csvFlag + 1]) : path.join(REPO, 'image-production-queue.csv');

const REQUIRED_COLUMNS = ['id', 'prompt', 'width', 'height', 'file_name', 'folder', 'status'];
const OUTPUT_COLUMNS = ['status', 'error_note', 'output_dimensions'];

// gemini-3.1-flash-image output sizes at 1K; the 512 size is half, 2K is double.
const RATIOS_1K = {
  '1:1': [1024, 1024], '1:4': [512, 2048], '1:8': [384, 3072], '2:3': [848, 1264], '3:2': [1264, 848],
  '3:4': [896, 1200], '4:1': [2048, 512], '4:3': [1200, 896], '4:5': [928, 1152], '5:4': [1152, 928],
  '8:1': [3072, 384], '9:16': [768, 1376], '16:9': [1376, 768], '21:9': [1584, 672],
};
const SIZES = [
  { name: '512', scale: 0.5, tokens: 747 },
  { name: '1K', scale: 1, tokens: 1120 },
  { name: '2K', scale: 2, tokens: 1680 },
];

// --- CSV -------------------------------------------------------------------

function parseCsv(text) {
  const records = [];
  let record = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); records.push(record);
      record = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records.filter(r => !(r.length === 1 && r[0] === ''));
}

function csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serializeCsv(columns, rows) {
  return [columns.join(','), ...rows.map(r => columns.map(c => csvField(r[c])).join(','))].join('\n') + '\n';
}

function loadQueue() {
  const text = fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, '');
  const [header, ...records] = parseCsv(text);
  if (!header) throw new Error(`${CSV_PATH} is empty`);
  const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c));
  if (missing.length) throw new Error(`${CSV_PATH} is missing columns: ${missing.join(', ')}`);
  const columns = [...header, ...OUTPUT_COLUMNS.filter(c => !header.includes(c))];
  const rows = records.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
  const unchanged = serializeCsv(columns, rows) === text.replace(/\r\n/g, '\n');
  return { columns, rows, unchanged };
}

// --- Helpers ---------------------------------------------------------------

function loadKey() {
  const envPath = path.join(REPO, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  throw new Error('GEMINI_API_KEY not found. Add GEMINI_API_KEY=... to .env at the repo root.');
}

function ratioValue(r) {
  const [a, b] = r.split(':').map(Number);
  return a / b;
}

function closestRatio(w, h) {
  const target = Math.log(w / h);
  return Object.keys(RATIOS_1K).reduce((best, r) =>
    Math.abs(Math.log(ratioValue(r)) - target) < Math.abs(Math.log(ratioValue(best)) - target) ? r : best);
}

// Validates a row and works out the request: closest ratio, smallest size covering the target.
function plan(row) {
  const w = Number(row.width), h = Number(row.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`width/height must be positive whole numbers (got "${row.width}" x "${row.height}")`);
  }
  if (!row.prompt.trim()) throw new Error('prompt is empty');
  if (!row.file_name.trim()) throw new Error('file_name is empty');
  const destDir = path.resolve(REPO, row.folder);
  if (!row.folder.trim() || !destDir.startsWith(REPO + path.sep)) {
    throw new Error(`folder must be a path inside the repo (got "${row.folder}")`);
  }
  const ref = row.style_reference?.trim();
  if (ref && !fs.existsSync(path.join(REPO, ref))) throw new Error(`style_reference not found: ${ref}`);

  const ratio = closestRatio(w, h);
  const [bw, bh] = RATIOS_1K[ratio];
  const size = SIZES.find(s => bw * s.scale >= w && bh * s.scale >= h) ?? SIZES[SIZES.length - 1];
  return {
    w, h, ratio, size, ref,
    expected: `${bw * size.scale}x${bh * size.scale}`,
    destPath: path.join(destDir, `${row.file_name.trim()}.png`),
  };
}

function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function resize(src, dst, w, h) {
  return execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RESIZE_PS1, src, dst, String(w), String(h)],
    { encoding: 'utf8' }).trim();
}

function oneLine(s, max = 300) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Last image block from model_output steps (what the SDK's output_image returns).
function extractImage(json) {
  let image = null;
  const texts = [];
  for (const step of json?.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content ?? []) {
      if (block.type === 'image' && block.data) image = block;
      else if (block.type === 'text' && block.text) texts.push(block.text);
    }
  }
  return { image, texts };
}

// Response with base64 payloads elided, for debugging.
function redact(json) {
  return JSON.parse(JSON.stringify(json, (k, v) =>
    (k === 'data' && typeof v === 'string' && v.length > 200 ? `<${v.length} base64 chars>` : v)));
}

// --- Generation ------------------------------------------------------------

async function callApi(key, input, ratio, sizeName) {
  const body = {
    model: MODEL,
    input,
    // The API only accepts image/jpeg here; output is converted to PNG locally.
    response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: ratio, image_size: sizeName },
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function processRow(key, row) {
  const p = plan(row);
  const input = [{ type: 'text', text: row.prompt }];
  if (p.ref) {
    const ext = path.extname(p.ref).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : null;
    if (!mime) throw new Error(`style_reference must be PNG or JPEG: ${p.ref}`);
    input.push({ type: 'image', mime_type: mime, data: fs.readFileSync(path.join(REPO, p.ref)).toString('base64') });
  }

  console.log(`  POST ${MODEL} aspect_ratio=${p.ratio} image_size=${p.size.name}${p.ref ? ` +ref ${p.ref}` : ''}`);
  const result = await callApi(key, input, p.ratio, p.size.name);
  const base = `${row.id}-${row.file_name.trim()}`;
  if (result.json) fs.writeFileSync(path.join(RAW_DIR, `${base}.response.json`), JSON.stringify(redact(result.json), null, 2));
  if (result.status !== 200) {
    throw new Error(`HTTP ${result.status}: ${oneLine(result.json?.error?.message ?? result.text)}`);
  }

  const { image, texts } = extractImage(result.json);
  if (!image) {
    const why = [result.json?.status && `status=${result.json.status}`, texts.length && `model said: ${texts.join(' ')}`]
      .filter(Boolean).join('; ');
    throw new Error(`No image in response${why ? ` (${oneLine(why, 250)})` : ''}`);
  }

  const bytes = Buffer.from(image.data, 'base64');
  const rawExt = image.mime_type === 'image/png' ? 'png' : image.mime_type === 'image/jpeg' ? 'jpg' : 'bin';
  const rawPath = path.join(RAW_DIR, `${base}.raw.${rawExt}`);
  fs.writeFileSync(rawPath, bytes);
  fs.mkdirSync(path.dirname(p.destPath), { recursive: true });

  const rawSize = pngSize(bytes);
  const notes = [];
  let generated;
  if (rawSize && rawSize[0] === p.w && rawSize[1] === p.h) {
    fs.writeFileSync(p.destPath, bytes);
    generated = `${rawSize[0]}x${rawSize[1]}`;
  } else {
    const info = resize(rawPath, p.destPath, p.w, p.h);
    const src = info.match(/source=(\d+x\d+)/)?.[1] ?? '?';
    const crop = info.match(/crop=(\d+x\d+)/)?.[1] ?? '?';
    generated = src;
    if (!rawSize) notes.push(`API returned ${image.mime_type}, converted to PNG`);
    if (crop !== src) notes.push(`center-cropped to ${crop} then resized`);
    else if (src !== `${p.w}x${p.h}`) notes.push('resized');
  }

  const finalSize = pngSize(fs.readFileSync(p.destPath));
  if (!finalSize) throw new Error('Saved file is not a valid PNG');
  const final = `${finalSize[0]}x${finalSize[1]}`;
  row.output_dimensions = final === generated && notes.length === 0
    ? final
    : `${final} (generated ${generated} at ${p.ratio}/${p.size.name}; ${notes.join('; ')})`;
  return { destPath: p.destPath, cost: p.size.tokens * PRICE_PER_TOKEN };
}

async function main() {
  const { columns, rows, unchanged } = loadQueue();
  const queued = rows.filter(r => r.status.trim() === 'Queued');
  console.log(`${path.relative(REPO, CSV_PATH) || CSV_PATH}: ${rows.length} rows, ${queued.length} queued`);
  if (!queued.length) return;

  if (DRY) {
    let total = 0;
    for (const row of queued) {
      try {
        const p = plan(row);
        total += p.size.tokens * PRICE_PER_TOKEN;
        console.log(`${row.id}  ${path.relative(REPO, p.destPath)}  target ${p.w}x${p.h}  -> request ${p.ratio} @ ${p.size.name} (${p.expected})  ~$${(p.size.tokens * PRICE_PER_TOKEN).toFixed(3)}${p.ref ? `  ref=${p.ref}` : ''}`);
      } catch (err) {
        console.log(`${row.id}  WOULD FAIL: ${err.message}`);
      }
    }
    console.log(`Estimated cost: ~$${total.toFixed(3)}`);
    try { loadKey(); console.log('GEMINI_API_KEY: found'); } catch (err) { console.log(err.message); }
    if (!unchanged) console.log('Note: a live run will rewrite the CSV in normalized form (quoting, line endings, or added columns).');
    return;
  }

  const key = loadKey();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const save = () => fs.writeFileSync(CSV_PATH, serializeCsv(columns, rows));
  let total = 0;
  for (const row of queued) {
    console.log(`\n[${row.id}] ${row.file_name}`);
    try {
      const { destPath, cost } = await processRow(key, row);
      row.status = 'Completed';
      row.error_note = '';
      total += cost;
      console.log(`  Completed -> ${path.relative(REPO, destPath)} (${row.output_dimensions}) ~$${cost.toFixed(3)}`);
    } catch (err) {
      row.status = 'Failed';
      row.error_note = oneLine(err.name === 'TimeoutError' ? 'Request timed out after 180s' : err.message);
      console.log(`  Failed: ${row.error_note}`);
    }
    save();
  }
  console.log(`\nEstimated spend: ~$${total.toFixed(3)}. Raw API output: ${RAW_DIR}`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
