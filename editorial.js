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
const INTERRUPTION_DURATION = 3.0;
let secsSinceLastReaction = 999;
const REACTION_COOLDOWN = 12.0;
const MAX_MERGED_SHOT_DURATION = 20.0;
// ── Global no-person detection (UNION) ──────────────────────────────────────
// Rule: if ANY camera has no person detected in an interval, that interval is
// excluded from the output globally (across all cameras).
// Camera face timestamps are in camera-file time.
// Transcript segments use transcript time (t=0 = first spoken word).
// Conversion:  transcript_time = camera_time - camera_offset
// A 3-second minimum threshold avoids removing brief detection gaps.
const MIN_EMPTY_DURATION = 1.5;

// Build role -> best-camera lookup (highest visibility_score wins if duplicates)
const cameraByRole = {};
Object.entries(cameraRoles).forEach(([camId, role]) => {
  const newScore = ((cameraInv[camId] || {}).visibility_score) || 0;
  const prevScore = cameraByRole[role] ? ((cameraInv[cameraByRole[role]] || {}).visibility_score || 0) : -1;
  if (!cameraByRole[role] || newScore > prevScore) cameraByRole[role] = camId;
});


const MERGE_GAP = 1.0;
// ── Wide-camera low-person detection (< 2 faces) ────────────────────────────
// Rule: if a WIDE camera detects fewer than 2 persons during an interval,
// that interval is excluded globally (someone left the frame).
function computeWideLowPersonIntervals(cameraFaceIntervals, cameraOffsets) {
  const allIntervals = [];
  for (const [camId, data] of Object.entries(cameraFaceIntervals)) {
    if (!wideCameras.includes(camId)) continue;  // only wide cameras
    const offset = cameraOffsets[camId] || 0;
    const lowPerson = data.low_person_intervals || [];
    const standingPerson = data.standing_person_intervals || [];
    const invalidIntervals = [
      ...lowPerson,
      ...standingPerson
    ];
    for (const iv of invalidIntervals) {
      const tStart = Math.max(0, iv.start - offset);
      const tEnd = Math.max(0, iv.end - offset);
      const closeupsValid =
        isCloseupCoverageAvailable(
          tStart,
          tEnd,
          cameraFaceIntervals
        );
      if (!closeupsValid) {
        allIntervals.push({
          start: tStart,
          end: tEnd
        });
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
      merged.push({
        start: iv.start,
        end: iv.end
      });
    }
  }

  return merged.filter(
    iv => (iv.end - iv.start) >= MIN_EMPTY_DURATION
  );
}

const lowPersonIntervals = computeWideLowPersonIntervals(cameraFaceIntervals, cameraOffsets);
let allExcludeIntervals = [...lowPersonIntervals];
console.log('[LOW_PERSON] ' + lowPersonIntervals.length + ' interval(s) to exclude (wide camera < 2 persons): ' +
  lowPersonIntervals.map(iv => iv.start.toFixed(1) + 's-' + iv.end.toFixed(1) + 's (' + (iv.end - iv.start).toFixed(1) + 's)').join(', '));

// Start master exclusion list: merge no-face + low-person intervals

function isCloseupCoverageAvailable(start, end, cameraFaceIntervals) {

  const hostCam = cameraByRole["HOST_CLOSEUP"];
  const guestCam = cameraByRole["GUEST_CLOSEUP"];

  if (!hostCam || !guestCam)
    return false;

  const host = cameraFaceIntervals[hostCam];
  const guest = cameraFaceIntervals[guestCam];

  if (!host || !guest)
    return false;

  return (
    hasFaceDuring(host, start, end) &&
    hasFaceDuring(guest, start, end)
  );

}

function hasFaceDuring(camera, start, end) {
  const noFace = camera.no_face_intervals || [];
  for (const iv of noFace) {
    const overlap =
      Math.min(end, iv.end) - Math.max(start, iv.start);

    if (overlap > 0.75) return false;
  }
  return true;

}

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

// Helper: does [a,b) overlap [c,d)?
function overlaps(segStart, segEnd, ivStart, ivEnd) {
  return segStart < ivEnd && segEnd > ivStart;
}

// Filter/trim segments: remove or trim any portion that falls in an exclusion interval.
// A segment fully inside an exclusion interval is dropped.
// A segment that partially overlaps is trimmed (may produce 2 sub-segments if split).
const MIN_SEG_SECS = 0.5;
const EDITORIAL_BLOCK = 15.0;

function splitLongSegments(segments) {
  const out = [];
  for (const seg of segments) {
    let start = seg.start;
    while (start < seg.end) {
      const end = Math.min(
        start + EDITORIAL_BLOCK,
        seg.end
      );
      out.push({
        ...seg,
        start,
        end,
        duration: end - start
      });
      start = end;
    }
  }
  return out;
}
if (allExcludeIntervals.length > 0) {
  const filtered = [];
  for (const seg of segments) {
    let parts = [{ start: seg.start, end: seg.end }];
    for (const iv of allExcludeIntervals) {
      const next = [];
      for (const p of parts) {
        if (!overlaps(p.start, p.end, iv.start, iv.end)) {
          next.push(p);  // no overlap — keep
        } else if (p.start >= iv.start && p.end <= iv.end) {
          // fully inside exclusion interval — drop
        } else if (p.start < iv.start && p.end > iv.end) {
          // exclusion splits this part into two
          if (iv.start - p.start >= MIN_SEG_SECS) next.push({ start: p.start, end: iv.start });
          if (p.end - iv.end >= MIN_SEG_SECS) next.push({ start: iv.end, end: p.end });
        } else if (p.start < iv.start) {
          // overlap at tail — trim end
          if (iv.start - p.start >= MIN_SEG_SECS) next.push({ start: p.start, end: iv.start });
        } else {
          // overlap at head — trim start
          if (p.end - iv.end >= MIN_SEG_SECS) next.push({ start: iv.end, end: p.end });
        }
      }
      parts = next;
    }
    for (const p of parts) {
      filtered.push(Object.assign({}, seg, { start: p.start, end: p.end, duration: p.end - p.start }));
    }
  }
  console.log('[EXCLUDE_FILTER] Segments: ' + segments.length + ' → ' + filtered.length +
    ' after exclusion filter (no-person), removed/trimmed: ' + (segments.length - filtered.length));
  segments = splitLongSegments(filtered);
}


// ── Budget trackers ──────────────────────────────────────────────────────────
const totalDuration = segments.reduce((s, seg) => s + (seg.duration || (seg.end - seg.start)), 0);
const hostTotalDuration = segments
  .filter(s => String(s.speaker) === hostSpeaker)
  .reduce((s, seg) => s + (seg.duration || (seg.end - seg.start)), 0);

const wideBudgetSecs = totalDuration * 0.15;   // WIDE: target 15% (10-20% range)
const hostMediumBudget = hostTotalDuration * 0.05;   // HOST_MEDIUM: max 5% of host screen time
let wideUsed = 0;
let hostMediumUsed = 0;

// ── Cinematic state ──────────────────────────────────────────────────────────
const MIN_SHOT_DURATION = 3.0;   // minimum clip before cutting away
const REFRESH_THRESHOLD = 45.0;  // seconds without WIDE before forced reset
const REFRESH_DURATION = 3.0;   // duration of a visual refresh WIDE cut
const REACTION_DURATION = 4.0;   // duration of a listener reaction cut
const RAPID_TURN_MAX = 5.0;   // max seconds/turn to count as rapid dialogue

// Clip sizing rules
const MIN_CLIP_DURATION = 2.5;   // minimum clip duration for any cut (secs)
const MAX_CLIP_DURATION = 45.0;  // segments longer than this should be presented as WIDE
const SHORT_CLIP_EXTENSION = 0.5; // extend short clips by this amount on each side (secs)
// max seconds/turn to count as rapid dialogue

let secsSinceLastCameraChange = 0;
let guestMonologueSecs = 0;
let lastSpeaker = null;
let lastCamera = null;
let rapidCount = 0;
let inRapidDialogue = false;

const finalClips = [];

// Helper: push clip (merges consecutive same-camera clips, except special injections).
// source_start / source_end carry the segment timestamps and are used by the
// XML worker ONLY to derive duration — never for source frame positioning.
// The XML worker computes: in = timeline_start + offset, out = timeline_end + offset.

function pushClip(cam, seg, shotType, reason, overrideDur) {
  // Compute source range (allow short-clip extension where safe)
  let source_start = seg.start;
  let source_end = seg.end;
  const baseDur = overrideDur !== undefined ? overrideDur : (seg.duration || (seg.end - seg.start));

  // If clip is shorter than minimum and not explicitly overridden, extend both sides
  if (overrideDur === undefined && baseDur < MIN_CLIP_DURATION) {
    source_start = Math.max(0, source_start - SHORT_CLIP_EXTENSION);
    source_end = source_end + SHORT_CLIP_EXTENSION;
  }

  const dur = overrideDur !== undefined ? overrideDur : (source_end - source_start);
  const frames = Math.round(dur * FPS);
  if (frames <= 0) return;
  const last = finalClips.length > 0 ? finalClips[finalClips.length - 1] : null;
  if (
    last &&
    last.camera === cam &&
    last.editorial_reason === reason &&
    reason !== "reaction-listener-nod" &&
    reason !== "maximum-camera-hold" &&
    reason !== "interruption" &&
    reason !== "pause-reset"
  ) {
    const gap = source_start - last.source_end;
    const mergedDuration = source_end - last.source_start;
    if (gap <= 0.5 && mergedDuration <= MAX_MERGED_SHOT_DURATION) {
      last.source_end = source_end;
      last.duration_frames = Math.round(
        mergedDuration * FPS
      );
      return;
    }
  }
  finalClips.push({
    camera: cam, source_start: source_start, source_end: source_end,
    duration_frames: frames, shot_type: shotType, editorial_reason: reason, timeline_offset: 0
  });
}
//───────────────────────────────────────────────────────
for (let idx = 0; idx < segments.length; idx++) {
  let seg = { ...segments[idx] };
  const spk = String(seg.speaker);
  const dur = seg.duration || (seg.end - seg.start);
  const isHost = (spk === hostSpeaker && hostSpeaker !== "");
  const isGuest = (spk === guestSpeaker && guestSpeaker !== "");
  const speakerChanged = (spk !== lastSpeaker);

  // ── RULE 4: BACK-AND-FORTH ────────────────────────────────────────────────
  // Rapid dialogue: >= 2 consecutive alternating turns each shorter than RAPID_TURN_MAX
  const isRapidTurn = dur < RAPID_TURN_MAX && speakerChanged;
  if (isRapidTurn) { rapidCount++; if (rapidCount >= 2) inRapidDialogue = true; }
  else if (speakerChanged) { rapidCount = 0; inRapidDialogue = false; }

  if (inRapidDialogue && cameraByRole["WIDE"] && wideUsed + dur <= wideBudgetSecs) {
    pushClip(cameraByRole["WIDE"], seg, "WIDE", "back-and-forth - Slow Ken Burns Pan");
    wideUsed += dur; secsSinceLastCameraChange = 0; lastSpeaker = spk; lastCamera = cameraByRole["WIDE"]; continue;
  }

  // ── RULE 3: MAXIMUM CAMERA HOLD (45 s) ─────────────────────────────────────

  secsSinceLastCameraChange += dur;
  secsSinceLastReaction += dur;

  if (!seg.justRefreshed && secsSinceLastCameraChange >= REFRESH_THRESHOLD) {
    let refreshCamera = null;
    let refreshShotType = null;
    // If current shot is WIDE, switch to the active speaker
    if (lastCamera === cameraByRole["WIDE"]) {
      if (isHost) {
        refreshCamera = cameraByRole["HOST_CLOSEUP"];
        refreshShotType = "HOST_CLOSEUP";
      } else if (isGuest) {
        if (
          guestMonologueSecs > 15 &&
          cameraByRole["GUEST_MEDIUM"]
        ) {
          refreshCamera = cameraByRole["GUEST_MEDIUM"];
          refreshShotType = "GUEST_MEDIUM";
        } else {
          refreshCamera = cameraByRole["GUEST_CLOSEUP"];
          refreshShotType = "GUEST_CLOSEUP";
        }
      }
    }
    // Otherwise switch to WIDE
    else {
      if (
        cameraByRole["WIDE"] &&
        wideUsed + REFRESH_DURATION <= wideBudgetSecs
      ) {
        refreshCamera = cameraByRole["WIDE"];
        refreshShotType = "WIDE";
      }
    }
    if (refreshCamera) {

      // If the segment is too short, don't split it.
      if (dur <= REFRESH_DURATION) {

        pushClip(
          refreshCamera,
          seg,
          refreshShotType,
          "maximum-camera-hold",
          dur
        );

        if (refreshCamera === cameraByRole["WIDE"]) {
          wideUsed += dur;
        }

        secsSinceLastCameraChange = 0;
        lastCamera = refreshCamera;

        continue;
      }
      if (seg.refreshProcessed) {
        delete seg.refreshProcessed;
      }
      // Insert the refresh clip first
      pushClip(
        refreshCamera,
        {
          ...seg,
          start: seg.start,
          end: seg.start + REFRESH_DURATION,
          duration: REFRESH_DURATION
        },
        refreshShotType,
        "maximum-camera-hold",
        REFRESH_DURATION
      );

      if (refreshCamera === cameraByRole["WIDE"]) {
        wideUsed += REFRESH_DURATION;
      }

      secsSinceLastCameraChange = 0;
      lastCamera = refreshCamera;

      // Continue editing only the remaining dialogue
      // Continue editing only the remaining dialogue
      seg = {
        ...seg,
        start: seg.start + REFRESH_DURATION,
        end: seg.end
      };

      seg.duration = seg.end - seg.start;

      if (seg.duration <= 0) {
        lastSpeaker = spk;
        continue;
      }

      // Put the remaining dialogue back into the queue
      segments.splice(
        idx + 1,
        0,
        {
          ...seg,
          refreshProcessed: true
        }
      );

      // Current iteration is finished.
      // The refresh clip is the editorial decision for this moment.
      lastSpeaker = spk;
      continue;

    }
  } delete seg.justRefreshed;
  const currentDuration = seg.duration || (seg.end - seg.start);
  // ── RULE 1 + interruption/pause WIDE ─────────────────────────────────────
  let chosenCam = null; let shotType = null; let reason = "hero-continued";

  const prevSeg = idx > 0 ? segments[idx - 1] : null;
  const isInterruption = prevSeg && (seg.start - prevSeg.end) < 0.5 && String(prevSeg.speaker) !== spk;
  const isLongPause = prevSeg && (seg.start - prevSeg.end) > 5.0;

  if (
    (isInterruption || isLongPause) &&
    cameraByRole["WIDE"] &&
    wideUsed + INTERRUPTION_DURATION <= wideBudgetSecs
  ) {
    // Short WIDE transition
    pushClip(
      cameraByRole["WIDE"],
      {
        ...seg,
        end: Math.min(
          seg.start + INTERRUPTION_DURATION,
          seg.end
        ),
        duration: Math.min(
          INTERRUPTION_DURATION,
          seg.end - seg.start
        )
      },
      "WIDE", isInterruption ? "interruption" : "pause-reset",
      Math.min(
        INTERRUPTION_DURATION,
        seg.end - seg.start
      )
    );
    wideUsed += Math.min(
      INTERRUPTION_DURATION,
      seg.end - seg.start
    );
    secsSinceLastCameraChange = 0; lastCamera = cameraByRole["WIDE"];
    // Continue editing the remaining dialogue
    if (seg.end - seg.start > INTERRUPTION_DURATION) {
      segments.splice(
        idx + 1,
        0,
        {
          ...seg,
          start: seg.start + INTERRUPTION_DURATION,
          duration:
            seg.end -
            (seg.start + INTERRUPTION_DURATION)
        }
      );
    }
    lastSpeaker = spk;
    continue;
  }

  // HOST_MEDIUM deep-engagement cut (guest speaking > 8 s after a host turn, budget <= 5%)
  if (!chosenCam && isGuest && cameraByRole["HOST_MEDIUM"]
    && currentDuration > 8 && lastSpeaker === hostSpeaker
    && hostMediumUsed + currentDuration <= hostMediumBudget) {
    chosenCam = cameraByRole["HOST_MEDIUM"]; shotType = "HOST_MEDIUM";
    reason = "deep-engagement"; hostMediumUsed += currentDuration;
  }

  // SPEAKER RULE: primary hero camera
  if (!chosenCam) {
    if (isHost) {

      if (cameraByRole["HOST_CLOSEUP"]) {

        chosenCam = cameraByRole["HOST_CLOSEUP"];
        shotType = "HOST_CLOSEUP";
        reason = "hero-empathy";

      } else if (cameraByRole["HOST_MEDIUM"]) {

        chosenCam = cameraByRole["HOST_MEDIUM"];
        shotType = "HOST_MEDIUM";
        reason = "host-medium-substitute";

      } else if (cameraByRole["WIDE"]) {

        chosenCam = cameraByRole["WIDE"];
        shotType = "WIDE";
        reason = "host-wide-substitute";

      }

      guestMonologueSecs = 0;
    } else if (isGuest) {

      guestMonologueSecs += currentDuration;

      const useVariety =
        guestMonologueSecs > 15 &&
        cameraByRole["GUEST_MEDIUM"] &&
        (Math.floor(guestMonologueSecs / 12) % 2 === 1);

      if (useVariety) {

        chosenCam = cameraByRole["GUEST_MEDIUM"];
        shotType = "GUEST_MEDIUM";
        reason = "hero-variety-monologue";

      } else if (cameraByRole["GUEST_CLOSEUP"]) {

        chosenCam = cameraByRole["GUEST_CLOSEUP"];
        shotType = "GUEST_CLOSEUP";
        reason = "hero-storytelling";

      } else if (cameraByRole["GUEST_MEDIUM"]) {

        chosenCam = cameraByRole["GUEST_MEDIUM"];
        shotType = "GUEST_MEDIUM";
        reason = "guest-medium-substitute";

      } else if (cameraByRole["WIDE"]) {

        chosenCam = cameraByRole["WIDE"];
        shotType = "WIDE";
        reason = "guest-wide-substitute";
      }
    }
    // Fallback: first non-WIDE/non-EMPTY camera in detected roles
    if (!chosenCam) {

      console.warn(
        `[EDITOR] No suitable camera found for speaker '${spk}'`
      );

      if (lastCamera) {

        chosenCam = lastCamera;
        shotType = finalClips.length
          ? finalClips[finalClips.length - 1].shot_type
          : "MEDIUM";

        reason = "reuse-last-camera";

      } else if (cameraByRole["WIDE"]) {

        chosenCam = cameraByRole["WIDE"];
        shotType = "WIDE";
        reason = "wide-last-resort";

      } else {

        continue;
      }
    }
  }

  if (!chosenCam) { lastSpeaker = spk; return; }

  // ── LONG SEGMENT VARIETY RULE ───────────────────────────────────────────────
  //
  // Long transcript segments should NOT force a continuous WIDE shot.
  // Instead, keep the current editorial camera and simply mark the
  // segment as eligible for natural camera variation.
  //
  // Camera changes will be handled by:
  //
  // - Maximum Camera Hold (45 s)
  // - Speaker changes
  // - Reaction shots
  // - Interruptions
  // - Pause resets
  //
  // Therefore this rule intentionally does nothing.

  if (currentDuration > MAX_CLIP_DURATION) {
    reason = reason + "-long-segment";
  }

  // Pacing guard: don't cut away if previous clip is shorter than MIN_SHOT_DURATION
  if (lastCamera && chosenCam !== lastCamera && finalClips.length > 0) {
    const lastDur = finalClips[finalClips.length - 1].source_end
      - finalClips[finalClips.length - 1].source_start;
    if (lastDur < MIN_SHOT_DURATION) {
      chosenCam = lastCamera;
      shotType = finalClips[finalClips.length - 1].shot_type;
      reason = "pacing-avoid-jumpcut";
    }
  }

  const previousCamera = lastCamera;

  pushClip(chosenCam, seg, shotType, reason);

  if (previousCamera !== chosenCam) {
    secsSinceLastCameraChange = 0;
  }

  lastSpeaker = spk;
  lastCamera = chosenCam;

  // ── RULE 2: REACTION RULE - append 4 s listener cut after long segments ───
  if (currentDuration > 8 && secsSinceLastReaction >= REACTION_COOLDOWN) {
    let reactionCam = null; let reactionRole = null;
    if (isGuest && cameraByRole["HOST_CLOSEUP"]) {
      reactionCam = cameraByRole["HOST_CLOSEUP"]; reactionRole = "HOST_CLOSEUP";
    } else if (isHost) {
      if (cameraByRole["CAM_GUEST_THIRD"]) { reactionCam = cameraByRole["CAM_GUEST_THIRD"]; reactionRole = "CAM_GUEST_THIRD"; }
      else if (cameraByRole["GUEST_CLOSEUP"]) { reactionCam = cameraByRole["GUEST_CLOSEUP"]; reactionRole = "GUEST_CLOSEUP"; }
    }
    if (reactionCam) {
      pushClip(
        reactionCam,
        {
          ...seg,
          start: Math.max(
            0,
            seg.end - REACTION_DURATION
          ),
          end: seg.end,
          duration: REACTION_DURATION
        },
        reactionRole,
        "reaction-listener-nod",
        REACTION_DURATION
      );

      if (reactionCam === cameraByRole["WIDE"]) {
        wideUsed += REACTION_DURATION;
      }

      secsSinceLastCameraChange = 0;
      secsSinceLastReaction = 0;
    }
  }
};

// Accumulate timeline offsets
let cursor = 0;
finalClips.forEach(clip => { clip.timeline_offset = cursor; cursor += clip.duration_frames; });

return [{ json: { clips: finalClips.filter(c => c.duration_frames > 0) } }];