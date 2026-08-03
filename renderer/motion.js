// motion.js — the motion-detection engine (no DOM; unit-testable in Node).
//
// One implementation, shared by Live View and every background-capture entry via
// a per-stream MotionDetector (see createMotionDetector). The renderer supplies
// downsampled grayscale frames (see sampleCanvas in renderer.js) and drives the
// detector one sample at a time with feedMotion(). Pipeline per sample:
//   1. Subtract an adaptive background, cancelling any whole-frame brightness
//      shift (auto-exposure, a passing cloud) so only local change remains.
//   2. Threshold each cell by a per-cell delta that SCALES WITH SENSITIVITY.
//   3. Erode — drop changed cells without enough changed neighbours (kills
//      isolated speckle and thin burned-in clock/label digits).
//   4. Take the largest *connected* blob and gate it four ways:
//        • size    — big enough for the sensitivity (a real region, not specks);
//        • area    — NOT scene-wide (a >60% blob is a lighting/exposure event);
//        • fill    — solid, i.e. it fills most of its bounding box (a real object
//                    is compact; MPEG1 flicker on textured concrete/brick is a
//                    ragged smear with a big box but few cells inside it);
//        • persist — stays in ~the same place for ≥ MOTION_CONFIRM_FRAMES samples,
//                    checked continuously for as long as the event runs (a real
//                    object drifts smoothly frame to frame; unrelated noise blobs
//                    land in a different spot each time, which both prevents
//                    them from ever confirming AND ends any event they interrupt,
//                    so they can't "top up" an already-confirmed event either).
//   5. Then capture, and rate-limit to one frame per MOTION_CAPTURE_GAP_MS until
//      the motion stops.
// The background heals fast everywhere except under the current change, whose
// cells adapt very slowly — so a mover stays detected for the whole event, the
// bg never drifts onto it (no "ghost" trip when it leaves), and a false trip is
// absorbed within a frame or two. This is the fix for the phantom captures: the
// earlier version had no area/fill/persistence gates and froze the bg on every
// changed cell, so spatially-correlated compression flicker formed big ragged
// blobs and re-fired on a dead-static scene every few seconds, box wandering.

const SAMPLE_W = 32, SAMPLE_H = 24, SAMPLE_N = SAMPLE_W * SAMPLE_H;
const MOTION_INTERVAL_MS = 500;      // how often we sample while in motion mode
const MOTION_CONFIRM_FRAMES = 2;     // consecutive positive samples before capturing (kills transient flicker)
const MOTION_CAPTURE_GAP_MS = 3000;  // min gap between saved frames within one sustained event
const MOTION_EROSION_NEIGHBORS = 3;  // default erosion; high sensitivity uses 2 (see motionParams)
const MOTION_MIN_BLOB = 4;           // absolute floor on blob size (high sens can use the lower area target)
const MOTION_MAX_AREA_FRAC = 0.6;    // above this, the change is scene-wide → a lighting/exposure event, NOT an object
const MOTION_MIN_FILL = 0.42;        // base fill gate at sensitivity 0; scales down at higher sens (see motionParams)
const BG_ALPHA_BG = 0.10;            // background cells track lighting drift / heal false trips quickly
const BG_ALPHA_FG = 0.02;            // cells under a continued event adapt slowly: keeps a mover visible
                                     // and stops the bg from drifting onto it (no ghost trip when it leaves)
const BG_ALPHA_CANDIDATE = 0.04;     // first isMotion hit: slower than BG so small movers survive to confirm,
                                     // faster than FG so single-frame MPEG noise doesn't freeze the bg
const MOTION_PERSIST_DIST = 0.3;     // a change must stay within this normalised distance frame-to-frame to count as sustained
const MOTION_STILL_DIST = 0.05;      // centre drift below this (normalised) counts as "not moving"
const MOTION_STILL_FRAMES = 12;      // ~6s stuck box while inEvent → kill as noise (people pause shorter)
const BLANK_STDDEV = 5;              // below this downsampled std-dev a frame is treated as blank

// Sensitivity is a single human-facing 0–100 dial (HIGHER = more sensitive =
// more captures). 50 is the recommended sweet spot for a typical scene.
const SENSITIVITY_MIN = 0, SENSITIVITY_MAX = 100;
const RECOMMENDED_SENSITIVITY = 50;
const OBJECT_SIZE_MIN = 0, OBJECT_SIZE_MAX = 100;
const RECOMMENDED_OBJECT_SIZE = 50;

function clampSensitivity(s) {
  s = Math.round(Number(s));
  if (!Number.isFinite(s)) return RECOMMENDED_SENSITIVITY;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, s));
}

function clampObjectSize(s) {
  s = Math.round(Number(s));
  if (!Number.isFinite(s)) return RECOMMENDED_OBJECT_SIZE;
  return Math.min(OBJECT_SIZE_MAX, Math.max(OBJECT_SIZE_MIN, s));
}

// Map sensitivity + object-size dials to detection thresholds.
// Sensitivity owns contrast (pixelDelta), fill, and erosion — higher = catch
// subtler change. Object size owns minBlob — higher = require a larger moving
// region (ignore distant/small movers). Recommended: both at 50 → delta ≈ 24,
// minBlob ≈ 21 (~2.7% of the frame).
function motionParams(sensitivity, objectSize) {
  const s = clampSensitivity(sensitivity) / 100;
  const o = clampObjectSize(objectSize) / 100;
  const pixelDelta = Math.round(38 - 28 * s);            // 38 (0) → 24 (50) → 10 (100)
  // objectSize 0 = smallest movers (~0.5%), 50 ≈ 2.7%, 100 = large only (~5.5%)
  const minAreaFrac = 0.005 + 0.05 * o;
  const minBlob = Math.max(MOTION_MIN_BLOB, Math.ceil(minAreaFrac * SAMPLE_N));
  const erosionNeighbors = s >= 0.7 ? 2 : MOTION_EROSION_NEIGHBORS; // high sens keeps thin silhouettes
  const minFill = MOTION_MIN_FILL - 0.12 * s;            // 0.42 (0) → 0.36 (50) → 0.30 (100)
  return { pixelDelta, minBlob, erosionNeighbors, minFill };
}

// A frame is "blank" when its downsampled brightness is near-uniform — the
// stream hasn't painted real video yet, reconnected, or glitched (the grey/
// white 1–3 KB frames). Only pure/near-flat frames qualify: a real scene —
// even a low-contrast night one — spreads well past this, so genuine footage
// is never dropped.
function frameIsBlank(sample) {
  if (!sample) return true;
  let sum = 0;
  for (let i = 0; i < sample.length; i++) sum += sample[i];
  const mean = sum / sample.length;
  let varSum = 0;
  for (let i = 0; i < sample.length; i++) { const d = sample[i] - mean; varSum += d * d; }
  return Math.sqrt(varSum / sample.length) < BLANK_STDDEV;
}

// Largest 4-connected blob of set cells in `mask`, with its grid bounding box.
function largestBlob(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  const stack = [];
  let best = { size: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    stack.length = 0; stack.push(s); seen[s] = 1;
    let size = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p / w) | 0;
      size++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (px > 0     && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (py > 0     && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (size > best.size) best = { size, x0, y0, x1, y1 };
  }
  return best;
}

// Compare `cur` against background `ref` for one frame. Returns the eroded change
// `mask`, the largest connected blob's cell `size`, its `fill` (fraction of its
// own bounding box that is actually set — solid object ≈ 1, ragged noise ≈ small),
// and the normalised {x,y,w,h} box (0–1) for the on-frame highlight. The caller
// applies the size / area / fill gates; this function only measures.
// `erosionNeighbors` defaults to MOTION_EROSION_NEIGHBORS; high sensitivity
// passes 2 so thin distant silhouettes survive.
function analyzeFrame(cur, ref, pixelDelta, erosionNeighbors) {
  const n = cur.length, w = SAMPLE_W, h = SAMPLE_H;
  const need = erosionNeighbors != null ? erosionNeighbors : MOTION_EROSION_NEIGHBORS;
  // cancel any whole-frame brightness shift (auto-exposure / passing cloud)
  let sum = 0;
  for (let i = 0; i < n; i++) sum += cur[i] - ref[i];
  const bias = sum / n;
  // raw changed-cell mask
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Math.abs((cur[i] - ref[i]) - bias) > pixelDelta) raw[i] = 1;
  // erode — keep only changed cells with enough changed neighbours (kills speckle)
  const mask = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!raw[i]) continue;
      let nb = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && raw[ny * w + nx]) nb++;
        }
      }
      if (nb >= need) mask[i] = 1;
    }
  }
  const blob = largestBlob(mask, w, h);
  if (blob.size === 0) return { mask, size: 0, fill: 0, box: null };
  const bw = blob.x1 - blob.x0 + 1, bh = blob.y1 - blob.y0 + 1;
  return {
    mask,
    size: blob.size,
    fill: blob.size / (bw * bh),
    box: {
      x: +(blob.x0 / w).toFixed(4),
      y: +(blob.y0 / h).toFixed(4),
      w: +(bw / w).toFixed(4),
      h: +(bh / h).toFixed(4),
    },
  };
}

// Background update. Pass a `mask` of cells to adapt at `maskAlpha` (defaults to
// BG_ALPHA_FG); all other cells heal at BG_ALPHA_BG. Pass null mask to heal the
// whole frame quickly. Callers use FG for continued events, BG_ALPHA_CANDIDATE
// for a first isMotion hit (so small movers survive confirm), and null otherwise.
function updateBackground(bg, cur, mask, maskAlpha) {
  const slow = maskAlpha != null ? maskAlpha : BG_ALPHA_FG;
  for (let i = 0; i < bg.length; i++) {
    const a = (mask && mask[i]) ? slow : BG_ALPHA_BG;
    bg[i] += (cur[i] - bg[i]) * a;
  }
}

// Per-stream detector state. `feedMotion` drives it one sample at a time.
function createMotionDetector() {
  return { bg: null, consec: 0, inEvent: false, lastCaptureAt: 0, lastBox: null, stillConsec: 0, eventAnchor: null };
}
function resetMotionDetector(det) {
  if (!det) return;
  det.bg = null; det.consec = 0; det.inEvent = false; det.lastCaptureAt = 0; det.lastBox = null;
  det.stillConsec = 0; det.eventAnchor = null;
}

// Normalised centre-to-centre distance between two boxes.
function boxCenterDist(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
  const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

// Do two normalised boxes describe change in ~the same place? True if they
// overlap, or their centres are within MOTION_PERSIST_DIST. A real object drifts
// smoothly (overlaps); wandering compression noise jumps across the frame (does
// not), so it never accumulates the consecutive count needed to confirm.
function boxesOverlap(a, b) {
  if (!a || !b) return false;
  if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
  const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
  const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
  return dx * dx + dy * dy <= MOTION_PERSIST_DIST * MOTION_PERSIST_DIST;
}

// Feed one grayscale sample. Returns { capture, box, state }: capture===true
// means THIS frame should be saved; `state` is for live calibration UI —
// 'idle' (nothing gated through), 'candidate' (a blob passed the gates but
// hasn't persisted long enough to confirm yet), or 'active' (a confirmed,
// ongoing event — whether or not this exact tick is the one that captures,
// since captures within an event are rate-limited). A sample counts as motion
// only when the largest change blob is (a) big enough for the sensitivity,
// (b) NOT scene-wide (that's a lighting/exposure event), and (c) solid, not a
// ragged noise smear. Motion must then persist MOTION_CONFIRM_FRAMES
// consecutive samples before the first capture, after which we save at most
// one frame per MOTION_CAPTURE_GAP_MS until it stops. Whenever the frame is
// not confirmed motion, the background heals fast so a false trip can't stick.
// A confirmed event whose blob centre stays nearly fixed for MOTION_STILL_FRAMES
// is treated as pinned noise (MPEG flicker / shadow), not a real mover: we end
// the event and absorb only those mask cells into the background so it can't
// capture forever from one stuck box without baking a paused person into bg.
function feedMotion(det, cur, sensitivity, now, objectSize) {
  if (!det || !cur) return { capture: false, box: null, state: 'idle' };
  if (!det.bg) { det.bg = cur.slice(); return { capture: false, box: null, state: 'idle' }; }

  const { pixelDelta, minBlob, erosionNeighbors, minFill } = motionParams(sensitivity, objectSize);
  const a = analyzeFrame(cur, det.bg, pixelDelta, erosionNeighbors);
  const areaFrac = a.size / SAMPLE_N;
  const isMotion = a.size >= minBlob
    && areaFrac <= MOTION_MAX_AREA_FRAC   // reject scene-wide lighting/exposure shifts
    && a.fill >= minFill;                 // reject ragged noise (fill loosens at high sens)

  // Spatial persistence: a blob only extends the current event if it's roughly
  // where the LAST sample's blob was (checked against state from before this
  // sample). This runs on EVERY sample, not just before the first confirmation —
  // otherwise, once an event is confirmed, any later blob anywhere would keep it
  // alive indefinitely, since only the size/area/fill gates above would still
  // apply. That gap is what let a confirmed-by-chance event get "topped up" by
  // unrelated noise at a different spot each time, producing captures with the
  // highlight box jumping around the frame.
  const continued = isMotion && det.lastBox && boxesOverlap(a.box, det.lastBox);

  // Stationary kill: once confirmed, a real mover drifts; pinned compression
  // noise / shadow flicker sits still. If the centre stays within
  // MOTION_STILL_DIST of the event anchor for MOTION_STILL_FRAMES samples,
  // absorb it into the background and go idle (no capture this tick).
  if (det.inEvent && continued && a.box) {
    if (!det.eventAnchor) det.eventAnchor = a.box;
    if (boxCenterDist(a.box, det.eventAnchor) < MOTION_STILL_DIST) {
      det.stillConsec++;
      if (det.stillConsec >= MOTION_STILL_FRAMES) {
        // Absorb only the pinned blob cells into the background — not a full
        // scene snap, which baked paused people into bg and left "No motion"
        // forever. Mask cells copy from cur so residual delta can't re-confirm
        // every few seconds; the rest of the frame fast-heals normally.
        if (a.mask) {
          for (let i = 0; i < det.bg.length; i++) {
            if (a.mask[i]) det.bg[i] = cur[i];
          }
        }
        updateBackground(det.bg, cur, null);
        det.consec = 0; det.inEvent = false; det.lastBox = null;
        det.stillConsec = 0; det.eventAnchor = null;
        return { capture: false, box: null, state: 'idle' };
      }
    } else {
      det.stillConsec = 0;
      det.eventAnchor = a.box; // object moved — re-anchor and keep the event
    }
  }

  // Background adapt: continued events use slow FG alpha; a first isMotion hit
  // uses candidate alpha so small movers aren't healed away before confirm;
  // everything else heals fast so noise can't stick.
  if (continued) updateBackground(det.bg, cur, a.mask, BG_ALPHA_FG);
  else if (isMotion) updateBackground(det.bg, cur, a.mask, BG_ALPHA_CANDIDATE);
  else updateBackground(det.bg, cur, null);

  if (!isMotion) {
    det.consec = 0; det.inEvent = false; det.lastBox = null;
    det.stillConsec = 0; det.eventAnchor = null;
    return { capture: false, box: null, state: 'idle' };
  }

  det.consec = continued ? det.consec + 1 : 1;
  det.lastBox = a.box;
  if (!continued) {
    // spatial break → must re-confirm before capturing again
    det.inEvent = false;
    det.stillConsec = 0;
    det.eventAnchor = null;
  }

  if (!det.inEvent && det.consec < MOTION_CONFIRM_FRAMES) return { capture: false, box: a.box, state: 'candidate' };
  // onset → capture right now, not whenever wall-clock time happens to reach a
  // gap measured from zero. Backdating lastCaptureAt makes the immediate "now -
  // lastCaptureAt >= GAP" check below true on this very sample, so a short real
  // event (confirms, then leaves before some arbitrary absolute-time mark) still
  // gets captured instead of silently missed.
  if (!det.inEvent) {
    det.inEvent = true;
    det.lastCaptureAt = now - MOTION_CAPTURE_GAP_MS;
    det.stillConsec = 0;
    det.eventAnchor = a.box;
  }
  if (now - det.lastCaptureAt < MOTION_CAPTURE_GAP_MS) return { capture: false, box: a.box, state: 'active' };
  det.lastCaptureAt = now;
  return { capture: true, box: a.box, state: 'active' };
}

// Export for Node tests; in the browser this file runs as a classic script and
// these become globals shared with renderer.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SAMPLE_W, SAMPLE_H, SAMPLE_N, MOTION_INTERVAL_MS, MOTION_CONFIRM_FRAMES,
    MOTION_CAPTURE_GAP_MS, SENSITIVITY_MIN, SENSITIVITY_MAX, RECOMMENDED_SENSITIVITY,
    OBJECT_SIZE_MIN, OBJECT_SIZE_MAX, RECOMMENDED_OBJECT_SIZE,
    clampSensitivity, clampObjectSize, motionParams, frameIsBlank, largestBlob, analyzeFrame,
    updateBackground, createMotionDetector, resetMotionDetector, feedMotion,
  };
}
