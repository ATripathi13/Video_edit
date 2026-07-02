// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: CONFIGURATION LAYER
// All constants — no editorial logic.
// ═══════════════════════════════════════════════════════════════════════════════

const REFRESH_THRESHOLD = 45.0;   // continuous camera hold limit (seconds)
const REFRESH_DURATION = 6.0;    // duration of a visual refresh cut (seconds)
const REACTION_DURATION = 4.0;    // duration of a listener reaction cut (seconds)
const REACTION_COOLDOWN = 12.0;   // minimum gap between reaction cuts (seconds)
const MIN_SHOT_DURATION = 4.0;    // minimum clip before cutting away (seconds)
const RAPID_TURN_MAX = 5.0;    // max seconds/turn to count as rapid dialogue
const MERGE_GAP = 1.0;    // gap tolerance for interval merging (seconds)
//const EDITORIAL_BLOCK = 15.0;   // max segment split size (seconds)
const SHORT_CLIP_EXTENSION = 0.5;    // extend short clips by this amount each side
const MIN_CLIP_DURATION = 2.5;    // minimum clip duration for any cut (seconds)
const MAX_CLIP_DURATION = 45.0;   // segments longer than this → WIDE
const MIN_SEG_SECS = 0.5;    // minimum segment duration after trim (seconds)
const MIN_EMPTY_DURATION = 1.5;    // minimum exclusion interval duration (seconds)
const INTERRUPTION_DURATION = 4.0;    // interruption detection threshold (seconds)
const MAX_MERGED_SHOT_DURATION = 25.0;  // max duration when merging adjacent clips
const WIDE_BUDGET_RATIO = 0.25;   // WIDE camera target: 15% of total duration
const HOST_MEDIUM_BUDGET_RATIO = 0.25;  // HOST_MEDIUM cap: 25% of host screen time
const MONOLOGUE_REACTION_THRESHOLD = 12.0; // seconds before reaction becomes eligible
const PAUSE_THRESHOLD = 2.0;    // gap threshold for pause reset (seconds)
const DEEP_ENGAGEMENT_THRESHOLD = 30.0; // long monologue threshold (seconds)


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: INPUT INTERFACES (Must Not Change)
// Consumes exactly these existing variables from upstream nodes.
// ═══════════════════════════════════════════════════════════════════════════════

const FPS = $node["Prepare File Info"].json.fps || 24;
let segments = $node["Editing Worker: Context"].json.segments || [];

// ── Calibration data from vision worker ─────────────────────────────────────
const calibration = $node["Read Face Timestamps1"] ? $node["Read Face Timestamps1"].json : {};
const cameraRoles = calibration.camera_roles || {};
const cameraInv = calibration.camera_inventory || {};
const hostSpeaker = String(calibration.host_speaker || "");
const guestSpeaker = String(calibration.guest_speaker || "");
const wideCameras = calibration.wide_cameras || [];
const cameraFaceIntervals = calibration.camera_face_intervals || {};
const cameraOffsets = calibration.camera_offsets || {};
// Aliases for compatibility
const camera_inventory = cameraInv;
const camera_roles = cameraRoles;
const camera_face_intervals = cameraFaceIntervals;

// ── Physical adjustment events from Vision Worker ───────────────────────────
const physicalEvents = calibration.physical_adjustments || [];
// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: VISION PROCESSING
// Camera role lookup, inventory, offsets, coverage checks, interval merging,
// invalid camera filtering, low/standing/no-person detection.
// ═══════════════════════════════════════════════════════════════════════════════

// Build role -> best-camera lookup (highest visibility_score wins if duplicates)
const cameraByRole = {};
Object.entries(cameraRoles).forEach(([camId, role]) => {
  const newScore = ((cameraInv[camId] || {}).visibility_score) || 0;
  const prevScore = cameraByRole[role]
    ? ((cameraInv[cameraByRole[role]] || {}).visibility_score || 0)
    : -1;
  if (!cameraByRole[role] || newScore > prevScore) cameraByRole[role] = camId;
});

console.log("===== CAMERA ROLES FROM VISION =====");
console.log(cameraRoles);
console.log("===== CAMERA BY ROLE =====");
console.log(cameraByRole);
console.log("===== CAMERA INVENTORY =====");
console.log(cameraInv);

// ── hasFaceDuring: checks if a camera has face presence during [start, end] ──
function hasFaceDuring(camera, start, end) {
  const noFace = camera.no_face_intervals || [];
  for (const iv of noFace) {
    const overlap = Math.min(end, iv.end) - Math.max(start, iv.start);
    if (overlap > 0.75) return false;
  }
  return true;
}

// ── isCloseupCoverageAvailable: both host+guest closeups have faces ──────────
function isCloseupCoverageAvailable(start, end, faceIntervals) {
  const hostCam = cameraByRole["HOST_CLOSEUP"];
  const guestCam = cameraByRole["GUEST_CLOSEUP"];
  if (!hostCam || !guestCam) return false;
  const host = faceIntervals[hostCam];
  const guest = faceIntervals[guestCam];
  if (!host || !guest) return false;
  return hasFaceDuring(host, start, end) && hasFaceDuring(guest, start, end);
}

// ── isCameraAvailableAtTime: checks if a specific camera has face at time ────
function isCameraAvailableAtTime(camId, timeStart, timeEnd) {
  if (!camId) return false;
  const data = cameraFaceIntervals[camId];
  if (!data) return true; // no face data → assume available
  const offset = cameraOffsets[camId] || 0;
  // Convert transcript time to camera time
  const camStart = timeStart + offset;
  const camEnd = timeEnd + offset;
  return hasFaceDuring(data, camStart, camEnd);
}

// ── P12: Deep Reaction Camera Validation ────────────────────────────────────
function isCameraValidReaction(camId, timeStart, timeEnd) {
  if (!camId) return false;
  const data = cameraFaceIntervals[camId];
  if (!data) return true;
  const offset = cameraOffsets[camId] || 0;
  const camStart = timeStart + offset;
  const camEnd = timeEnd + offset;

  // Check no_face_intervals
  const noFace = data.no_face_intervals || [];
  for (const iv of noFace) {
    const overlap = Math.min(camEnd, iv.end) - Math.max(camStart, iv.start);
    if (overlap > 0.5) return false; // Not visible
  }

  // Check standing
  const standing = data.standing_person_intervals || [];
  for (const iv of standing) {
    const overlap = Math.min(camEnd, iv.end) - Math.max(camStart, iv.start);
    if (overlap > 0.5) return false; // Standing
  }

  // Check low person
  const low = data.low_person_intervals || [];
  for (const iv of low) {
    const overlap = Math.min(camEnd, iv.end) - Math.max(camStart, iv.start);
    if (overlap > 0.5) return false; // Empty or low person
  }

  return true;
}

function isSpeakerVisibleInCamera(roleName, speaker, options = {}) {

  if (options.isReaction) return true;
  if (options.isRefresh) return true;

  if (speaker === hostSpeaker) {
    return (
      roleName === "HOST_CLOSEUP" || roleName === "HOST_MEDIUM" || roleName === "WIDE"
    );
  }

  if (speaker === guestSpeaker) {
    return (
      roleName === "GUEST_CLOSEUP" || roleName === "GUEST_MEDIUM" || roleName === "WIDE"
    );
  }

  return true;
}

// ── computeWideLowPersonIntervals: wide cams with <2 faces or standing ───────
function computeWideLowPersonIntervals(faceIntervals, offsets) {
  const allIntervals = [];
  for (const [camId, data] of Object.entries(faceIntervals)) {
    if (!wideCameras.includes(camId)) continue; // only wide cameras
    const offset = offsets[camId] || 0;
    const lowPerson = data.low_person_intervals || [];
    const standingPerson = data.standing_person_intervals || [];
    const invalidIntervals = [...lowPerson, ...standingPerson];
    for (const iv of invalidIntervals) {
      const tStart = Math.max(0, iv.start - offset);
      const tEnd = Math.max(0, iv.end - offset);
      const closeupsValid = isCloseupCoverageAvailable(tStart, tEnd, faceIntervals);
      if (!closeupsValid) {
        allIntervals.push({ start: tStart, end: tEnd });
      }
    }
  }
  if (allIntervals.length === 0) return [];
  allIntervals.sort((a, b) => a.start - b.start);
  const merged = [{ start: allIntervals[0].start, end: allIntervals[0].end }];
  for (let i = 1; i < allIntervals.length; i++) {
    const iv = allIntervals[i];
    const last = merged[merged.length - 1];
    if (iv.start <= last.end + MERGE_GAP) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged.filter(iv => (iv.end - iv.start) >= MIN_EMPTY_DURATION);
}

const lowPersonIntervals = computeWideLowPersonIntervals(cameraFaceIntervals, cameraOffsets);
let allExcludeIntervals = [...lowPersonIntervals];

console.log('[LOW_PERSON] ' + lowPersonIntervals.length + ' interval(s) to exclude (wide camera < 2 persons): ' +
  lowPersonIntervals.map(iv => iv.start.toFixed(1) + 's-' + iv.end.toFixed(1) + 's (' + (iv.end - iv.start).toFixed(1) + 's)').join(', '));

// Re-sort and merge the combined exclusion list to eliminate overlaps
if (allExcludeIntervals.length > 1) {
  allExcludeIntervals.sort((a, b) => a.start - b.start);
  const merged2 = [{ start: allExcludeIntervals[0].start, end: allExcludeIntervals[0].end }];
  for (let i = 1; i < allExcludeIntervals.length; i++) {
    const iv = allExcludeIntervals[i];
    const last = merged2[merged2.length - 1];
    if (iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged2.push({ start: iv.start, end: iv.end });
  }
  allExcludeIntervals = merged2.filter(iv => (iv.end - iv.start) >= MIN_EMPTY_DURATION);
}

console.log('[EXCLUDE_TOTAL] ' + allExcludeIntervals.length + ' combined interval(s) to remove from output (no-person + low-person): ' +
  allExcludeIntervals.map(iv => iv.start.toFixed(1) + 's-' + iv.end.toFixed(1) + 's').join(', '));

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: TRANSCRIPT PROCESSING
// Segment trimming, splitting, exclusion handling, duration normalization.
// ═══════════════════════════════════════════════════════════════════════════════

function overlaps(segStart, segEnd, ivStart, ivEnd) {
  return segStart < ivEnd && segEnd > ivStart;
}

if (allExcludeIntervals.length > 0) {
  const filtered = [];
  for (const seg of segments) {
    let parts = [{ start: seg.start, end: seg.end }];
    for (const iv of allExcludeIntervals) {
      const next = [];
      for (const p of parts) {
        if (!overlaps(p.start, p.end, iv.start, iv.end)) {
          next.push(p);
        } else if (p.start >= iv.start && p.end <= iv.end) {
          // drop
        } else if (p.start < iv.start && p.end > iv.end) {
          if (iv.start - p.start >= MIN_SEG_SECS) next.push({ start: p.start, end: iv.start });
          if (p.end - iv.end >= MIN_SEG_SECS) next.push({ start: iv.end, end: p.end });
        } else if (p.start < iv.start) {
          if (iv.start - p.start >= MIN_SEG_SECS) next.push({ start: p.start, end: iv.start });
        } else {
          if (p.end - iv.end >= MIN_SEG_SECS) next.push({ start: iv.end, end: p.end });
        }
      }
      parts = next;
    }
    for (const p of parts) {
      filtered.push(Object.assign({}, seg, { start: p.start, end: p.end, duration: p.end - p.start }));
    }
  }
  segments = filtered;
}

function normalizeSegments(segs) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.duration === undefined || s.duration === null) {
      s.duration = s.end - s.start;
    }
  }
  return segs;
}
segments = normalizeSegments(segments);

if (!segments || segments.length === 0) {
  console.log('[EDITORIAL] Empty transcript — returning empty clips.');
  return [{ json: { clips: [] } }];
}

function getPhysicalEvents(start, end) {
  return physicalEvents
    .filter(e => e.start >= start && e.start < end)
    .sort((a, b) => a.start - b.start);
}

const wordTimeline = [];

for (const seg of segments) {
  if (!seg.words) continue;
  for (const w of seg.words) {
    wordTimeline.push({
      word: w.word,
      start: w.start,
      end: w.end,
      speaker: seg.speaker,
      confidence: w.confidence ?? 1.0,
      punctuation: /[.,!?;:]$/.test(w.word)
    });
  }
}

const safeCutPoints = [];
for (let i = 0; i < wordTimeline.length; i++) {
  const current = wordTimeline[i];
  const next = wordTimeline[i + 1];
  const pauseAfter = next ? next.start - current.end : 999;
  let score = 0;
  if (/[.!?]$/.test(current.word))
    score += 100;
  if (/[,;:]$/.test(current.word))
    score += 60;
  if (pauseAfter > 0.30)
    score += 80;
  if (pauseAfter > 0.60)
    score += 100;
  safeCutPoints.push({
    time: current.end, score, speaker: current.speaker
  });
}
if (wordTimeline.length === 0) {

  console.warn(
    "[SAFE CUT] No word timestamps detected."
  );

}
// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: EDITORIAL ANALYSIS
// Produces EditorialBlock objects. No camera decisions here.
// ═══════════════════════════════════════════════════════════════════════════════

function buildEditorialBlocks(segs) {
  const blocks = [];
  let consecutiveSpeakerTime = 0;
  let rapidTurnCount = 0;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const speaker = String(seg.speaker || "");
    const start = seg.start;
    const end = seg.end;
    const duration = seg.duration || (end - start);

    if (duration <= 0) continue;

    const prevSeg = i > 0 ? segs[i - 1] : null;
    const prevSpeaker = prevSeg ? String(prevSeg.speaker || "") : null;

    const gap = prevSeg ? (start - prevSeg.end) : 999;
    const isPause = gap > PAUSE_THRESHOLD;

    // P7: Monologue - continuous speaking tracked, reset by speaker change OR pause
    if (speaker === prevSpeaker && !isPause) {
      consecutiveSpeakerTime += duration;
    } else {
      consecutiveSpeakerTime = duration;
    }

    const isInterruption = prevSeg && speaker !== prevSpeaker && start < prevSeg.end;

    // P9: Rapid Dialogue requires 4+ consecutive turns each < 5 seconds
    if (speaker !== prevSpeaker && prevSeg) {
      if ((prevSeg.duration || (prevSeg.end - prevSeg.start)) <= RAPID_TURN_MAX
        && duration <= RAPID_TURN_MAX) {
        rapidTurnCount++;
      } else {
        rapidTurnCount = 0;
      }
    } else if (isPause) {
      rapidTurnCount = 0;
    }
    const isRapidDialogue = rapidTurnCount >= 4;

    const isLongMonologue = consecutiveSpeakerTime >= DEEP_ENGAGEMENT_THRESHOLD;

    const reactionEligible = consecutiveSpeakerTime >= MONOLOGUE_REACTION_THRESHOLD
      && !isRapidDialogue;

    let excluded = false;
    for (const iv of allExcludeIntervals) {
      if (start >= iv.start && end <= iv.end) {
        excluded = true;
        break;
      }
    }

    blocks.push({
      speaker,
      start,
      end,
      duration,
      isInterruption,
      isPause,
      isRapidDialogue,
      isLongMonologue,
      reactionEligible,
      excluded,
      segmentIndex: i,
      _seg: seg
    });
  }

  return blocks;
}
// segments = mergeSpeakerSegments(segments);
const editorialBlocks = buildEditorialBlocks(segments);
console.log('[EDITORIAL] Built ' + editorialBlocks.length + ' editorial blocks.');


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: CAMERA SELECTION (Scoring System)
// P4, P3, P5, P6, P10, P11, P17. NO state mutation, NO budget changes.
// ═══════════════════════════════════════════════════════════════════════════════

const totalDuration = segments.reduce((s, seg) => s + (seg.duration || (seg.end - seg.start)), 0);
const hostTotalDuration = segments
  .filter(s => String(s.speaker) === hostSpeaker)
  .reduce((s, seg) => s + (seg.duration || (seg.end - seg.start)), 0);

const wideBudgetSecs = totalDuration * WIDE_BUDGET_RATIO;
const hostMediumBudget = hostTotalDuration * HOST_MEDIUM_BUDGET_RATIO;
const protectedWords = new Set([
  "not",
  "don't",
  "never",
  "must",
  "because",
  "however",
  "important"
]);
/**
 * P4: scoring-based camera selection.
 */

function snapToSafeCut(desiredTime, speaker, windowBefore = 1.5, windowAfter = 2.0) {
  const candidates = safeCutPoints.filter(p => {
    return (
      p.speaker == speaker && p.time >= desiredTime - windowBefore && p.time <= desiredTime + windowAfter
    );
  });
  if (!candidates.length) return desiredTime;
  candidates.sort((a, b) => {
    const sa = a.score - Math.abs(a.time - desiredTime);
    const sb = b.score - Math.abs(b.time - desiredTime);
    return sb - sa;
  });
  const word = wordTimeline.find(
    w => w.end === candidates[0].time
  );

  if (
    word &&
    protectedWords.has(
      word.word.toLowerCase()
    )
  ) {

    return desiredTime;

  }
  return candidates[0].time;
}

function avoidMidWordCut(time) {
  for (const w of wordTimeline) {
    if (time > w.start && time < w.end) {
      return w.end;
    }
  }
  return time;
}

function scoreCandidates(speaker, state, start, end, options = {}) {
  const candidates = [];

  // Define candidate roles and their base weights
  const roles = [
    { name: "HOST_CLOSEUP", shotType: "host-closeup", baseHost: 100, baseGuest: 30 },
    { name: "HOST_MEDIUM", shotType: "host-medium", baseHost: 80, baseGuest: 25 },
    { name: "GUEST_CLOSEUP", shotType: "guest-closeup", baseHost: 30, baseGuest: 100 },
    { name: "GUEST_MEDIUM", shotType: "guest-medium", baseHost: 25, baseGuest: 80 },
    { name: "WIDE", shotType: "wide", baseHost: 40, baseGuest: 40 }
  ];

  for (const r of roles) {
    const camId = cameraByRole[r.name];
    if (!camId) continue;

    let score = (speaker === hostSpeaker) ? r.baseHost : r.baseGuest;
    let reason = "scored-selection";

    // P12/Availability checks
    const available = options.isReaction
      ? isCameraValidReaction(camId, start, end)
      : isCameraAvailableAtTime(camId, start, end);
    if (
      !isSpeakerVisibleInCamera(
        r.name,
        speaker,
        options
      )
    ) {
      score = -9999;
      reason = "speaker-not-visible";
    }
    if (!available) {
      score = -9999;
      reason = "camera-unavailable";
    }

    // P5: Wide budget limit check
    if (r.name === "WIDE" && state.wideBudgetRemaining <= 0 && !options.isMandatoryRefresh) {
      score = -9999;
      reason = "wide-budget-exhausted";
    }

    // P6: Host Medium budget check
    if (r.name === "HOST_MEDIUM" && state.hostMediumBudgetRemaining <= 0) {
      score = -9999;
      reason = "host-medium-budget-exhausted";
    }

    // P3: Refresh must not reuse current camera
    if (options.isRefresh && camId === state.currentCamera) {
      score = -9999;
      reason = "refresh-cannot-reuse-current";
    }

    // P10: Pause variety bias (if requested, penalize current camera heavily)
    if (options.preferVariety && camId === state.currentCamera) {
      score -= 50;
    }

    // P13: Camera variety tracking (penalize recent cameras)
    if (state.recentCameras && state.recentCameras.length > 0) {
      const occurrences = state.recentCameras.filter(c => c === camId).length;
      score -= (occurrences * 10);
    }
    if (
      state.lastSpecialCut &&
      !options.isReaction &&
      !options.isRefresh
    ) {

      if (speaker === hostSpeaker) {

        if (r.name === "HOST_CLOSEUP")
          score += 200;

        if (r.name === "HOST_MEDIUM")
          score += 120;

      }
      else {

        if (r.name === "GUEST_CLOSEUP")
          score += 200;

        if (r.name === "GUEST_MEDIUM")
          score += 120;

      }
      // state.lastSpecialCut = null;
    }

    candidates.push({
      camera: camId,
      shotType: r.shotType,
      reason,
      score,
      roleName: r.name
    });
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);

  const winner = candidates[0] || null;

  if (winner)
    state.lastSpecialCut = null;

  return winner;
}

/**
 * P11: Fixed refresh priority orders.
 */
function selectRefreshCamera(speaker, state, block) {
  const candidates = [];
  const options = { isRefresh: true, isMandatoryRefresh: true };

  // Fixed lists of role names in priority order
  const priorities = (speaker === hostSpeaker)
    ? [
      "GUEST_CLOSEUP",
      "WIDE",
      "HOST_MEDIUM",
      "HOST_CLOSEUP"
    ]
    : [
      "HOST_CLOSEUP",
      "WIDE",
      "GUEST_MEDIUM",
      "GUEST_CLOSEUP"
    ];

  for (let idx = 0; idx < priorities.length; idx++) {
    const roleName = priorities[idx];
    const camId = cameraByRole[roleName];
    if (!camId) continue;

    // Filter out current camera (P3)
    if (speaker === hostSpeaker) {

      if (
        roleName === "HOST_CLOSEUP" ||
        roleName === "HOST_MEDIUM"
      )
        continue;

    } else {

      if (
        roleName === "GUEST_CLOSEUP" ||
        roleName === "GUEST_MEDIUM"
      )
        continue;

    }

    // Check availability
    if (!isCameraAvailableAtTime(camId, block.start, block.end)) continue;

    // Check Host Medium budget
    if (roleName === "HOST_MEDIUM" && state.hostMediumBudgetRemaining <= 0) continue;

    // Assign fixed descending scores
    const score = 100 - (idx * 20);
    const shotType = roleName.toLowerCase().replace('_', '-');

    candidates.push({
      camera: camId,
      shotType,
      reason: "maximum-camera-hold",
      score
    });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  // Last resort fallback (absolute backup including current camera)
  const fallbackCam = cameraByRole[speaker === hostSpeaker ? "HOST_CLOSEUP" : "GUEST_CLOSEUP"];
  if (fallbackCam) {
    return {
      camera: fallbackCam,
      shotType: speaker === hostSpeaker ? "host-closeup" : "guest-closeup",
      reason: "maximum-camera-hold-fallback",
      score: 1
    };
  }
  return null;
}

function selectReactionCamera(speaker, state, block) {
  const targetRole = (speaker === hostSpeaker) ? "GUEST_CLOSEUP" : "HOST_CLOSEUP";
  const camId = cameraByRole[targetRole];
  if (camId && isCameraValidReaction(camId, block.start, block.end)) {
    return {
      camera: camId,
      shotType: targetRole.toLowerCase().replace('_', '-'),
      reason: "reaction-listener-nod"
    };
  }
  return null;
}
// ------------------------------------------------------------------
// Select which camera should be used when returning to the speaker
// after a reaction / refresh / physical adjustment.
// ------------------------------------------------------------------
function getSpeakerReturnSelection(speaker, state, block) {

  const longHold = block.isLongMonologue || block.duration >= 20;

  if (speaker === hostSpeaker) {

    const role = longHold
      ? "HOST_MEDIUM"
      : "HOST_CLOSEUP";

    return {
      camera:
        cameraByRole[role] ||
        cameraByRole["HOST_CLOSEUP"],
      shotType:
        role === "HOST_MEDIUM"
          ? "host-medium"
          : "host-closeup",
      reason: "return-to-speaker"
    };
  }

  const role = longHold
    ? "GUEST_MEDIUM"
    : "GUEST_CLOSEUP";

  return {
    camera:
      cameraByRole[role] ||
      cameraByRole["GUEST_CLOSEUP"],
    shotType:
      role === "GUEST_MEDIUM"
        ? "guest-medium"
        : "guest-closeup",
    reason: "return-to-speaker"
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: CAMERA STATE MACHINE (Granular Operations)
// P1, P13, P16. Single source of truth.
// ═══════════════════════════════════════════════════════════════════════════════

const cameraState = {
  currentCamera: null,
  currentHold: 0,
  currentShotStartedAt: 0,
  lastSpeaker: null,
  lastCamera: null,
  lastReactionTime: -999,
  lastRefreshTime: -999,
  lastWideTime: -999,
  wideBudgetRemaining: wideBudgetSecs,
  hostMediumBudgetRemaining: hostMediumBudget,
  timelineCursor: 0,
  lastSpecialCut: null,
  recentCameras: [] // P13 variety tracker (last 5 cameras)
};

function beginShot(state, camera, speaker, time) {
  if (state.currentCamera !== camera) {
    state.lastCamera = state.currentCamera;
  }
  state.currentCamera = camera;
  state.currentHold = 0;
  if (camera === cameraByRole["WIDE"]) {
    state.lastWideTime = time;
  }
  state.currentShotStartedAt = time;
  state.lastSpeaker = speaker;
  state.timelineCursor = time;
  state.recentCameras.push(camera);
  if (state.recentCameras.length > 5) {
    state.recentCameras.shift();
  }
}

function extendShot(state, duration, time) {
  state.currentHold += duration;
  state.timelineCursor = time + duration;
}

function refreshShot(state, camera, speaker, time) {
  state.lastCamera = state.currentCamera;
  state.currentCamera = camera;
  state.currentHold = 0; // P1: Reset hold entirely
  state.currentShotStartedAt = time;
  state.lastSpeaker = speaker;
  state.timelineCursor = time;
  state.lastRefreshTime = time;
  state.lastSpecialCut = "refresh";

  state.recentCameras.push(camera);
  if (state.recentCameras.length > 5) {
    state.recentCameras.shift();
  }
}

function reactionShot(state, camera, speaker, time) {
  state.lastCamera = state.currentCamera;
  state.currentCamera = camera;
  state.currentHold = 0; // Reset hold for reaction cut
  state.currentShotStartedAt = time;
  state.timelineCursor = time;
  state.lastReactionTime = time;
  state.lastSpecialCut = "reaction";

  state.recentCameras.push(camera);
  if (state.recentCameras.length > 5) {
    state.recentCameras.shift();
  }
}

function finishShot(state) {
  // Bookkeeping if needed
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 & 9 & 10: UNIFIED SUB-CLIP PIPELINE
// P1, P2, P8 (Reaction Placement).
// ═══════════════════════════════════════════════════════════════════════════════

const finalClips = [];

/**
 * P2: The single unified entry point for pushing and transitioning.
 */
function getSpeechRelativeRange(
  block,
  cursor,
  duration
) {

  return {

    start:
      cursor,

    end:
      Math.min(
        cursor + duration,
        block.end
      )

  };

}
function emitSubClip(state, cam, start, end, shotType, reason, speaker, mode) {
  const duration = end - start;
  if (!cam)
    return;
  if (duration <= 0) return;

  // Call state machine ops
  if (mode === "reaction") {
    reactionShot(state, cam, speaker, start);
  } else if (mode === "refresh") {
    refreshShot(state, cam, speaker, start);
  } else {
    if (state.currentCamera !== cam) {
      beginShot(state, cam, speaker, start);
    } else {
      extendShot(state, duration, start);
    }
  }

  // Budget management
  const structuralShot = mode === "refresh" || reason === "pause-reset" || reason === "interruption";

  if (shotType === "wide" && !structuralShot) {
    state.wideBudgetRemaining -= duration;
    state.lastWideTime = end;
  }
  if (shotType === "host-medium") {
    state.hostMediumBudgetRemaining -= duration;
  }

  pushClip(cam, { start, end, duration }, shotType, reason, duration);
}

/**
 * P8: Text-aware Reaction Placement
 */
function findReactionSplitTime(block) {
  const text = block._seg && block._seg.text ? String(block._seg.text) : "";
  const duration = block.duration;

  // Default fallback (40%)
  let bestTimeRatio = 0.4;

  if (text.length > 0) {
    // If there is punctuation, try to split there
    const sentenceEndIdx = text.search(/[.!?]/);
    const commaIdx = text.search(/,/);

    if (sentenceEndIdx !== -1) {
      // Estimate time of sentence end based on character index ratio
      bestTimeRatio = (sentenceEndIdx + 1) / text.length;
    } else if (commaIdx !== -1) {
      bestTimeRatio = (commaIdx + 1) / text.length;
    }
  }

  // Keep it within reasonable bounds of the block duration
  let splitOffset = duration * bestTimeRatio;
  if (splitOffset < MIN_SHOT_DURATION) {
    splitOffset = MIN_SHOT_DURATION;
  }
  if (duration - splitOffset < MIN_SHOT_DURATION + REACTION_DURATION) {
    splitOffset = Math.max(MIN_SHOT_DURATION, duration - REACTION_DURATION - MIN_SHOT_DURATION);
  }
  return splitOffset;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: SPEAKER & CINEMATIC RULES
// P10. pause-reset variety.
// ═══════════════════════════════════════════════════════════════════════════════

function applyCinematicRules(state, block, baseSelection) {
  let selection = { ...baseSelection };

  // On speaker change, cut to the new speaker's camera
  if (block.speaker !== state.lastSpeaker && state.lastSpeaker !== null) {
    const newSel = scoreCandidates(block.speaker, state, block.start, block.end);
    if (newSel) {
      selection = newSel;
      selection.reason = "speaker-change";
    }
  }

  // During rapid back-and-forth, prefer WIDE to avoid whiplash cutting
  if (block.isRapidDialogue && block.duration >= 8 && state.wideBudgetRemaining > block.duration) {
    const w = cameraByRole["WIDE"];
    if (w && state.wideBudgetRemaining > block.duration) {
      selection = { camera: w, shotType: "wide", reason: "rapid-dialogue-wide" };
    }
  }

  // Long monologue
  if (block.isLongMonologue && !block.isRapidDialogue) {
    selection.reason = "deep-engagement";
  }

  // Interruption
  if (block.isInterruption) {
    const newSel = scoreCandidates(block.speaker, state, block.start, block.end);
    if (newSel) {
      selection = newSel;
      selection.reason = "interruption";
    }
  }

  // P10: Pause variety reset (prefer different camera)
  if (block.isPause) {
    const newSel = scoreCandidates(block.speaker, state, block.start, block.end, { preferVariety: true });
    if (newSel) {
      selection = newSel;
      selection.reason = "pause-reset";
    }
  }

  // Pacing guard
  if (state.currentCamera === selection.camera && state.currentHold < MIN_SHOT_DURATION) {
    selection.reason = selection.reason || "pacing-guard";
  }

  return selection;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12: pushClip()
// Validate, basic merge, frame calculations, append.
// ═══════════════════════════════════════════════════════════════════════════════

function pushClip(cam, seg, shotType, reason, overrideDur) {
  if (!cam)
    return;

  if (seg.end <= seg.start)
    return;
  const offset = cameraOffsets[cam] || 0;

  const source_start =
    Math.max(
      0,
      seg.start + offset
    );

  const source_end =
    Math.max(
      source_start,
      seg.end + offset
    );

  const dur = overrideDur !== undefined ? overrideDur : (source_end - source_start);
  const frames = Math.round(dur * FPS);
  if (frames <= 0) return;

  finalClips.push({
    camera: cam,
    source_start: source_start,
    source_end: source_end,
    duration_frames: frames,
    shot_type: shotType,
    editorial_reason: reason,
    timeline_offset: 0
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13: MAIN EDITORIAL LOOP (Unified pipeline runner)
// P2, hold manager, reaction manager, single iterative pass.
// ═══════════════════════════════════════════════════════════════════════════════

console.log('[EDITORIAL] Starting main editorial loop with ' + editorialBlocks.length + ' blocks.');

for (let bi = 0; bi < editorialBlocks.length; bi++) {
  const block = editorialBlocks[bi];
  if (block.excluded || block.duration <= 0) continue;

  let primarySelection = scoreCandidates(block.speaker, cameraState, block.start, block.end);
  if (!primarySelection) {
    console.log('[EDITORIAL] WARNING: No camera available for block at ' + block.start.toFixed(1) + 's');
    continue;
  }

  primarySelection = applyCinematicRules(cameraState, block, primarySelection);
  const physicalCuts = getPhysicalEvents(block.start, block.end);
  let physicalIndex = 0;
  // Determine if a reaction cut should insert
  let reactionInfo = null;
  const timeSinceLastReaction = block.start - cameraState.lastReactionTime;
  const nearRefresh = cameraState.currentHold >= REFRESH_THRESHOLD - 5;

  if (block.reactionEligible && timeSinceLastReaction >= REACTION_COOLDOWN && !block.isRapidDialogue && !nearRefresh) {
    reactionInfo = selectReactionCamera(block.speaker, cameraState, block);
  }

  let remaining = block.duration;
  let cursor = block.start;
  const blockEnd = block.end;
  // If a reaction is eligible, calculate the insertion split offset
  let reactionInsertOffset = -1;
  if (reactionInfo && remaining > MIN_SHOT_DURATION + REACTION_DURATION + MIN_SHOT_DURATION) {
    reactionInsertOffset = block.start + findReactionSplitTime(block);

    reactionInsertOffset = snapToSafeCut(reactionInsertOffset, block.speaker);
    reactionInsertOffset = avoidMidWordCut(reactionInsertOffset);
    reactionInsertOffset -= block.start;
  }

  while (remaining > 0) {
    let capacity = REFRESH_THRESHOLD - cameraState.currentHold;
    capacity = Math.max(0, capacity);
    // ---------------------------------------------------------------------
    // Physical Adjustment Cut (Highest Editorial Priority)
    // ---------------------------------------------------------------------

    if (physicalIndex < physicalCuts.length) {

      const evt = physicalCuts[physicalIndex];

      const offset = evt.start - cursor;

      if (offset >= MIN_SHOT_DURATION && offset < remaining) {

        let safeEventStart =
          snapToSafeCut(
            evt.start,
            block.speaker
          );

        safeEventStart =
          avoidMidWordCut(
            safeEventStart
          );

        emitSubClip(
          cameraState,
          primarySelection.camera,
          cursor,
          safeEventStart,
          primarySelection.shotType,
          primarySelection.reason,
          block.speaker,
          "normal"
        );

        cursor = safeEventStart;
        remaining = blockEnd - cursor;

        let cutCam = null;

        if (evt.editorial_action === "CUT_TO_LISTENER") {

          const listener = block.speaker === hostSpeaker ? cameraByRole["GUEST_CLOSEUP"] : cameraByRole["HOST_CLOSEUP"];
          cutCam = listener;

        } else {

          cutCam = cameraByRole["WIDE"] || primarySelection.camera;

        }

        const cutDuration = Math.min(3.0, evt.end - evt.start);

        const cutEnd = Math.min(cursor + cutDuration, blockEnd);
        const speechResume = cutEnd;
        emitSubClip(
          cameraState,
          cutCam,
          cursor,
          cutEnd,
          cutCam === cameraByRole["WIDE"]
            ? "wide"
            : "listener",
          "PHY_ADJ_CUT",
          block.speaker,
          "reaction"
        );

        cursor = avoidMidWordCut(speechResume);
        remaining = blockEnd - cursor;

        physicalIndex++;
        cameraState.currentHold = 0;

        primarySelection = getSpeakerReturnSelection(block.speaker, cameraState, block);

        beginShot(cameraState, primarySelection.camera, block.speaker, cutEnd);

        // Recalculate reaction timing after physical cut
        if (reactionInfo && remaining > MIN_SHOT_DURATION + REACTION_DURATION + MIN_SHOT_DURATION) {
          reactionInsertOffset =
            cursor +
            findReactionSplitTime({
              ...block,
              start: cursor,
              duration: remaining
            });

          reactionInsertOffset =
            snapToSafeCut(
              reactionInsertOffset,
              block.speaker
            );

          reactionInsertOffset =
            avoidMidWordCut(
              reactionInsertOffset
            );

          reactionInsertOffset -= cursor;
        }
        else {
          reactionInsertOffset = -1;
        }
        continue;
      }
    }

    // Check if we need to split for a reaction first
    if (reactionInsertOffset > 0 && remaining > reactionInsertOffset) {
      const splitTime = reactionInsertOffset;
      reactionInsertOffset = -1; // Fire once

      if (splitTime <= capacity) {
        // Step A: Emit speaker up to reaction point
        emitSubClip(cameraState, primarySelection.camera, cursor, cursor + splitTime, primarySelection.shotType, primarySelection.reason, block.speaker, "normal");
        cursor += splitTime;
        remaining -= splitTime;

        // Step B: Emit listener reaction cut (INTERRUPT)
        const reactDur = Math.min(remaining, Math.max(2.5, Math.min(REACTION_DURATION, block.duration * 0.08)));

        emitSubClip(cameraState, reactionInfo.camera, cursor, cursor + reactDur, reactionInfo.shotType, "reaction-listener-nod", block.speaker, "reaction");
        cursor += reactDur;
        remaining -= reactDur;

        // Reselect primary selection for remaining speaker duration (hold was reset by reaction cut)
        // const reselect = scoreCandidates(block.speaker, cameraState, cursor, blockEnd);
        // if (reselect) {
        //   primarySelection = applyCinematicRules(cameraState, block, reselect);
        // }
        // continue;
        // Force return to active speaker after reaction
        primarySelection = getSpeakerReturnSelection(block.speaker, cameraState, block);

        // Reset the hold timer for the new speaker shot
        beginShot(cameraState, primarySelection.camera, block.speaker, cursor);
        continue;
      }
    }

    // Process hold/refresh
    if (remaining <= capacity || capacity >= remaining - MIN_SHOT_DURATION) {
      emitSubClip(cameraState, primarySelection.camera, cursor, cursor + remaining, primarySelection.shotType, primarySelection.reason, block.speaker, "normal");
      break;
    }

    // Split at exactly the hold limit
    if (capacity > 0) {

      let refreshSplit = cursor + capacity;

      refreshSplit = snapToSafeCut(
        refreshSplit, block.speaker
      );

      refreshSplit = avoidMidWordCut(refreshSplit);

      capacity = Math.min(remaining, Math.max(MIN_SHOT_DURATION, refreshSplit - cursor));

      emitSubClip(
        cameraState,
        primarySelection.camera,
        cursor,
        cursor + capacity,
        primarySelection.shotType,
        primarySelection.reason,
        block.speaker,
        "normal"
      );

      cursor += capacity;
      remaining -= capacity;
    }

    // Insert mandatory refresh
    const refreshDur = Math.min(REFRESH_DURATION, remaining, blockEnd - cursor);
    const refreshBlock = { speaker: block.speaker, start: cursor, end: cursor + refreshDur, duration: refreshDur, isPause: block.isPause, isInterruption: block.isInterruption, isRapidDialogue: block.isRapidDialogue, isLongMonologue: block.isLongMonologue };
    cameraState.timelineCursor = cursor;
    const refreshSelection = selectRefreshCamera(block.speaker, cameraState, refreshBlock);

    if (refreshSelection) {
      const refreshRange = getSpeechRelativeRange(block, cursor, refreshDur);
      emitSubClip(cameraState, refreshSelection.camera, refreshRange.start, refreshRange.end, refreshSelection.shotType, "maximum-camera-hold", block.speaker, "refresh");
      // Camera changed.
      // Speech has NOT advanced.
      cursor = refreshRange.end;
      remaining = blockEnd - cursor;
      cameraState.currentHold = 0;

      primarySelection =
        getSpeakerReturnSelection(
          block.speaker,
          cameraState,
          block
        );

      beginShot(
        cameraState,
        primarySelection.camera,
        block.speaker,
        cursor
      );
    } else {
      // Fallback: just emit remaining duration if no refresh camera is possible
      emitSubClip(cameraState, primarySelection.camera, cursor, cursor + remaining, primarySelection.shotType, primarySelection.reason, block.speaker, "normal");
      break;
    }
  }
}

console.log('[EDITORIAL] Main loop complete. Generated ' + finalClips.length + ' raw clips.');


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14: TIMELINE BUILDER
// Strict merge logic (P15) and validation (P14).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * P15: Tightened merge logic.
 */
function finalMergePass(clips) {
  if (clips.length <= 1) return clips;
  const merged = [{ ...clips[0] }];

  for (let i = 1; i < clips.length; i++) {
    const curr = clips[i];
    const last = merged[merged.length - 1];

    const sameCamera = last.camera === curr.camera;
    const gap = curr.source_start - last.source_end;
    const mergedDur = curr.source_end - last.source_start;

    // Verify same speaker (shot type match closeup/medium vs closeup/medium),
    // same reason, and no special cuts (refresh, reaction, interruption, pause-reset)
    const canMerge = sameCamera
      && gap <= MERGE_GAP
      && gap >= 0
      && mergedDur <= MAX_MERGED_SHOT_DURATION
      && last.editorial_reason === curr.editorial_reason
      && last.shot_type === curr.shot_type
      && curr.editorial_reason !== "reaction-listener-nod"
      && curr.editorial_reason !== "maximum-camera-hold"
      && curr.editorial_reason !== "interruption"
      && curr.editorial_reason !== "pause-reset"
      && curr.editorial_reason !== "speaker-change"
      && curr.editorial_reason !== "PHY_ADJ_CUT";
    if (canMerge) {
      last.source_end = curr.source_end;
      last.duration_frames = Math.round((last.source_end - last.source_start) * FPS);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

function applyPacingGuard(clips) {
  if (clips.length <= 1) return clips;
  const result = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const duration = (clip.source_end - clip.source_start);

    if (duration < MIN_CLIP_DURATION && result.length > 0) {
      const prev = result[result.length - 1];
      prev.source_end = clip.source_end;
      prev.duration_frames = Math.round((prev.source_end - prev.source_start) * FPS);
    } else {
      result.push({ ...clip });
    }
  }
  return result;
}

function computeTimelineOffsets(clips) {
  let frameCursor = 0;

  for (const clip of clips) {

    const durationSeconds = clip.source_end - clip.source_start;
    const durationFrames = Math.max(
      1,
      Math.round(durationSeconds * FPS)
    );

    clip.duration_frames = durationFrames;
    clip.timeline_offset = frameCursor;

    frameCursor += durationFrames;
  }

  return clips;
}

/**
 * P14: Timeline Validation
 */
function validateTimeline(clips) {
  console.log('[TIMELINE] Running validation checks...');
  let continuous = true;
  let matchesFPS = true;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = clip.source_end - clip.source_start;
    const expectedFrames = Math.round(dur * FPS);

    // 1. Verify frame match
    if (Math.abs(dur - (clip.duration_frames / FPS)) > 0.001) {
      console.log(`[TIMELINE] WARNING: Clip ${i} duration/frame mismatch: dur=${dur.toFixed(3)}s, frames=${clip.duration_frames}`);
      matchesFPS = false;
    }
    // 2. Verify continuity
    if (i > 0) {
      const prev = clips[i - 1];
      const prevDur = prev.source_end - prev.source_start;
      const expectedOffset = prev.timeline_offset + prev.duration_frames;
      if (Math.abs(clip.timeline_offset - expectedOffset) > 0.001) {
        console.log(`[TIMELINE] WARNING: Gap/overlap in timeline_offset at index ${i}`);
        continuous = false;
      }
    }
  }
  console.log(`[TIMELINE] FPS match validation: ${matchesFPS ? 'PASSED' : 'FAILED'}`);
  console.log(`[TIMELINE] Continuity validation: ${continuous ? 'PASSED' : 'FAILED'}`);
}

let processedClips = finalMergePass(finalClips);
processedClips = applyPacingGuard(processedClips);
processedClips = computeTimelineOffsets(processedClips);

validateTimeline(processedClips);

console.log(
  '[TIMELINE] Final clip count: ' +
  processedClips.length
);

function validateSpeechCoverage() {

  const spoken = [];

  for (const seg of segments) {

    if (!seg.words) continue;

    for (const w of seg.words) {

      spoken.push(w);

    }

  }

  for (const word of spoken) {

    const covered =
      processedClips.some(c =>
        c.source_start <= word.start &&
        c.source_end >= word.end
      );

    if (!covered) {

      console.warn(
        "[WORD LOST]",
        word.word,
        word.start,
        word.end
      );

    }

  }

}

validateSpeechCoverage();
return [{
  json: {
    clips: processedClips.filter(
      c => c.duration_frames > 0
    )
  }
}];
