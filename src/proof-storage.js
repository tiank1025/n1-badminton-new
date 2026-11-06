// proof-storage.js — optional Supabase Storage backend for payment proofs.
//
// When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured, proof images
// are uploaded to a Supabase Storage bucket and only a short `sbs:<path>`
// reference is stored in the registrations table (keeps the DB small). When
// storage is not configured — or an upload fails — the base64 data URL is
// stored in the database exactly as before, so the feature degrades
// gracefully and nothing breaks on setups without object storage.
//
// Legacy rows (data URLs in payment_proof) keep working unchanged; only
// values with the `sbs:` prefix are resolved through Storage.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'payment-proofs';

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

function isStorageRef(value) {
  return typeof value === 'string' && value.startsWith('sbs:');
}

const EXT_BY_MIME = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };
const MIME_BY_EXT = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

// Upload binary image data; returns `sbs:<path>` on success or null to tell
// the caller to fall back to storing the data URL in the database.
async function uploadProof(buffer, mimeType) {
  if (!isConfigured()) return null;
  const ext = EXT_BY_MIME[mimeType] || 'jpg';
  const objectPath = `proofs/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: buffer,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`Supabase Storage upload failed (${res.status}): ${detail.slice(0, 200)}`);
      return null;
    }
    return `sbs:${objectPath}`;
  } catch (e) {
    console.warn('Supabase Storage upload failed:', e.message);
    return null;
  }
}

// Resolve a `sbs:<path>` reference back into a data URL (the same shape the
// database path returns, so callers and the frontend need no changes).
async function fetchProofAsDataUrl(ref) {
  const objectPath = ref.slice(4);
  try {
    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 300 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!signRes.ok) {
      console.warn(`Supabase Storage sign failed (${signRes.status}) for ${objectPath}`);
      return null;
    }
    const { signedURL } = await signRes.json();
    const objRes = await fetch(`${SUPABASE_URL}/storage/v1${signedURL}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!objRes.ok) {
      console.warn(`Supabase Storage fetch failed (${objRes.status}) for ${objectPath}`);
      return null;
    }
    const buf = Buffer.from(await objRes.arrayBuffer());
    const ext = objectPath.split('.').pop().toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn(`Supabase Storage fetch failed for ${objectPath}:`, e.message);
    return null;
  }
}

module.exports = { isConfigured, isStorageRef, uploadProof, fetchProofAsDataUrl };
