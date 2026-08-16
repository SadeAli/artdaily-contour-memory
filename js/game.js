/* ============================================================
   game.js — Contour Memory: a smooth blob appears centered for a
   timed exposure (shrinking countdown ring), then hides; the
   player redraws its contour from memory with any strokes, any
   place on the sheet. Three figures per round, each shown shorter
   and shaped trickier. Scoring is translation-invariant pure
   geometry: centroid- and scale-aligned symmetric chamfer keeps
   shape and size separate, size costing only a gentle explicit
   penalty — the pure functions sit at the top
   so they are unit-testable without a canvas. The chamfer that
   scores zero has a pixel floor and a per-mode hand allowance
   (ArtDaily.ease), so a phone sheet is not a stricter drill than a
   desktop one. One honest "peek −8" per figure reshows the shape
   for 0.6s (0.9s behind a fingertip); "undo" drops a stray stroke
   without wiping the attempt.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'contour-memory';
  var FIGURES_PER_ROUND = 3;
  /* "done ✓" unlocks on drawn INK, never on a sample count: a fast
     confident sweep from a pen tablet can finish a whole contour in
     eight pointermove events, and counting samples left that player
     staring at a greyed button under a finished drawing. */
  var MIN_INK_PX = 40;
  var MIN_STROKE_PX = 5;    /* shorter than this = an accidental tap */
  var PEEK_COST = 8;
  var REVEAL_MS = 2600;
  var SAMPLES_PER_SEG = 18; /* spline density (also the ground truth) */
  var MAX_SCORE_PTS = 400;  /* player samples are decimated to this */

  /* Tolerance, in three honest parts (see shapeZeroPx):
       relative — 11% of the figure's own diagonal, the memory standard;
       floor    — but never a tighter window than this many px, so a
                  330px phone sheet is not a stricter drill than a 690px
                  desktop one for exactly the same blob;
       slop     — plus the wobble the hardware contributes and the drill
                  is not trying to measure. Both px terms go through
                  ArtDaily.ease, so a mouse or a fingertip gets the room
                  a nib does not need. */
  var SHAPE_FALLOFF = 0.11;
  var SHAPE_FLOOR_PX = 16;
  var HAND_SLOP_PX = 6;

  /* Difficulty ramps within the round: more control points, deeper
     concavities, shorter exposure. Figure 1 is deliberately easy — a
     first-timer's first result has to read as a result. */
  var FIGURE_SPECS = [
    { points: 6,  rLo: 0.78, rHi: 1.00, exposure: 2800 },
    { points: 8,  rLo: 0.62, rHi: 1.00, exposure: 1800 },
    { points: 10, rLo: 0.55, rHi: 1.00, exposure: 1100 }
  ];

  /* ============================================================
     Pure scoring — arrays of {x,y} in, 0–100 out. No canvas, no
     DOM, no state: every function here is unit-testable as-is.
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function centroid(pts) {
    var sx = 0, sy = 0, i;
    for (i = 0; i < pts.length; i++) { sx += pts[i].x; sy += pts[i].y; }
    return { x: sx / pts.length, y: sy / pts.length };
  }

  function boundingDiag(pts) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    return Math.hypot(maxX - minX, maxY - minY);
  }

  function polyLength(pts) {
    var L = 0, i;
    for (i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
  }

  function inkLength(strokes, extra) {
    var L = 0, i;
    for (i = 0; i < strokes.length; i++) L += polyLength(strokes[i]);
    if (extra) L += polyLength(extra);
    return L;
  }

  function translated(pts, dx, dy) {
    var out = [], i;
    for (i = 0; i < pts.length; i++) out.push({ x: pts[i].x + dx, y: pts[i].y + dy });
    return out;
  }

  /* Scale a point set about (cx, cy) — the exact inverse of the size
     normalization scoreFigure() applies, so the reveal can show the truth
     at the size the score actually compared it against. */
  function scaledAbout(pts, cx, cy, k) {
    var f = (isFinite(k) && k > 0) ? k : 1, out = [], i;
    for (i = 0; i < pts.length; i++) {
      out.push({ x: cx + (pts[i].x - cx) * f, y: cy + (pts[i].y - cy) * f });
    }
    return out;
  }

  /* Even-stride downsample so chamfer cost stays bounded. */
  function decimate(pts, maxN) {
    if (pts.length <= maxN) return pts;
    var out = [], step = pts.length / maxN, i;
    for (i = 0; i < maxN; i++) out.push(pts[Math.floor(i * step)]);
    return out;
  }

  function flatten(strokes) {
    var out = [], s, i;
    for (s = 0; s < strokes.length; s++) {
      for (i = 0; i < strokes[s].length; i++) out.push(strokes[s][i]);
    }
    return out;
  }

  function distSqToSegment(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y;
    var wx = p.x - a.x, wy = p.y - a.y;
    var len = vx * vx + vy * vy;
    var t = len === 0 ? 0 : clamp01((wx * vx + wy * vy) / len);
    var dx = wx - t * vx, dy = wy - t * vy;
    return dx * dx + dy * dy;
  }

  function distToClosedPath(p, path) {
    var best = Infinity, i, n = path.length, d;
    for (i = 0; i < n; i++) {
      d = distSqToSegment(p, path[i], path[(i + 1) % n]);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  function distToStrokes(p, strokes) {
    var best = Infinity, s, i, d, dx, dy, st;
    for (s = 0; s < strokes.length; s++) {
      st = strokes[s];
      if (st.length === 1) {
        dx = p.x - st[0].x; dy = p.y - st[0].y;
        d = dx * dx + dy * dy;
        if (d < best) best = d;
        continue;
      }
      for (i = 0; i + 1 < st.length; i++) {
        d = distSqToSegment(p, st[i], st[i + 1]);
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }

  /* Symmetric chamfer between the player's strokes and the closed
     truth: mean nearest distance each way, combined by taking the
     WORSE direction. Averaging the two half-forgives area-filling
     scribbles (ink blanketing the figure zeroes the truth→ink term
     and scores ~50 with zero shape memory); the max keeps both
     cheeses — scribble-everywhere and one-lazy-arc — near zero
     while honest traces, whose errors are symmetric, score the
     same. Nearest is measured point→opposite *path* (segments, not
     samples) so a perfect trace really scores a perfect 0 at any
     sampling density.

     The per-sample truth→ink distances are kept as well as the mean:
     they are what lets the reveal point AT the part of the outline the
     memory dropped, instead of only pricing it. */
  function chamferParts(strokes, truePts) {
    var pPts = decimate(flatten(strokes), MAX_SCORE_PTS);
    if (!pPts.length || truePts.length < 2) return { worst: Infinity, perTruth: [] };
    var sumA = 0, sumB = 0, i, d, per = [];
    for (i = 0; i < pPts.length; i++) sumA += distToClosedPath(pPts[i], truePts);
    for (i = 0; i < truePts.length; i++) {
      d = distToStrokes(truePts[i], strokes);
      per.push(d);
      sumB += d;
    }
    return { worst: Math.max(sumA / pPts.length, sumB / truePts.length), perTruth: per };
  }

  function chamferStrokes(strokes, truePts) {
    return chamferParts(strokes, truePts).worst;
  }

  /* Which quarter of the outline drifted furthest, named the way a
     person looks at a drawing rather than in radians. Angles are taken
     about the figure's own centre in screen space (y grows down), so
     −90° is the top. */
  var SIDE_NAMES = ['the right side', 'the bottom', 'the left side', 'the top'];

  function worstSide(truePts, perTruth) {
    var n = Math.min(truePts ? truePts.length : 0, perTruth ? perTruth.length : 0);
    if (!n) return null;
    var c = centroid(truePts), sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0], i, a, q, m, best = -1, bi = 0;
    for (i = 0; i < n; i++) {
      if (!isFinite(perTruth[i])) continue;
      a = Math.atan2(truePts[i].y - c.y, truePts[i].x - c.x);
      q = Math.floor((((a + Math.PI / 4) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4;
      sum[q] += perTruth[i];
      cnt[q] += 1;
    }
    for (i = 0; i < 4; i++) {
      m = cnt[i] ? sum[i] / cnt[i] : 0;
      if (m > best) { best = m; bi = i; }
    }
    return { side: SIDE_NAMES[bi], mean: best >= 0 ? best : 0 };
  }

  /* Contiguous index runs of the CLOSED outline that ended up further
     from the player's ink than the whole scoring window — the stretches
     memory genuinely lost. A run crossing the seam is joined up rather
     than reported twice; runs under 3 samples are noise. */
  function missRuns(perTruth, zeroPx) {
    var n = perTruth ? perTruth.length : 0, runs = [], i, start = -1;
    if (!n || !(zeroPx > 0)) return runs;
    for (i = 0; i < n; i++) {
      if (perTruth[i] > zeroPx) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        runs.push([start, i - 1]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, n - 1]);
    if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === n - 1) {
      runs[0][0] = runs[runs.length - 1][0] - n;
      runs.pop();
    }
    var out = [];
    for (i = 0; i < runs.length; i++) if (runs[i][1] - runs[i][0] >= 2) out.push(runs[i]);
    return out;
  }

  /* The chamfer (in px, measured in the truth's own frame) at which the
     shape score reaches zero. floorPx and slopPx arrive already eased
     for the player's hardware. */
  function shapeZeroPx(trueDiag, floorPx, slopPx) {
    var f = typeof floorPx === 'number' && isFinite(floorPx) ? floorPx : 0;
    var s = typeof slopPx === 'number' && isFinite(slopPx) ? slopPx : 0;
    return Math.max(SHAPE_FALLOFF * trueDiag, f) + s;
  }

  function shapeScore(chamferPx, zeroPx) {
    if (!(zeroPx > 0) || !isFinite(chamferPx)) return 0;
    return 100 * clamp01(1 - chamferPx / zeroPx);
  }

  /* Size errors within ±~20% are free, then up to −10: drawing it
     half-size is a memory failure too, but a gentle one. */
  function sizePenalty(sizeRatio) {
    /* NaN fails every comparison below and would sail straight through
       clamp01 as NaN, poisoning the whole figure score. Today nothing
       reaches here with NaN only because boundingDiag happens to skip
       non-finite points — that is an accident of another function, not
       a guarantee this one may lean on. */
    if (!isFinite(sizeRatio) || sizeRatio <= 0) return 10;
    return 10 * clamp01((Math.abs(Math.log(sizeRatio)) - 0.18) / 0.5);
  }

  /* Full per-figure pipeline: align the player's centroid onto the
     true contour's and scale their drawing to the true bounding
     diagonal (shape is judged as shape — size is judged separately,
     and gently, by sizePenalty), chamfer measured against shapeZeroPx,
     then shape − size − peek, clamped to 0–100. */
  function scoreFigure(strokes, truePts, peekCost, floorPx, slopPx) {
    var pts = flatten(strokes);
    if (!pts.length || truePts.length < 2) return { score: 0, shape: 0, sizeRatio: 0, side: null, missRuns: [] };
    var trueDiag = boundingDiag(truePts);
    if (!isFinite(trueDiag) || trueDiag === 0) return { score: 0, shape: 0, sizeRatio: 0, side: null, missRuns: [] };
    var playerDiag = boundingDiag(pts);
    var ratio = playerDiag / trueDiag;
    var tc = centroid(truePts), pc = centroid(pts);
    var f = playerDiag === 0 ? 1 : trueDiag / playerDiag;
    var norm = [], s, i, st, ns;
    for (s = 0; s < strokes.length; s++) {
      st = strokes[s];
      ns = [];
      for (i = 0; i < st.length; i++) {
        ns.push({ x: tc.x + (st[i].x - pc.x) * f, y: tc.y + (st[i].y - pc.y) * f });
      }
      norm.push(ns);
    }
    var zero = shapeZeroPx(trueDiag, floorPx, slopPx);
    var parts = chamferParts(norm, truePts);
    var shape = shapeScore(parts.worst, zero);
    /* Clamped AND checked. shapeScore and sizePenalty each guarantee a
       finite number on their own, but peekCost arrives from the caller and
       Math.min/Math.max propagate NaN silently — an unguarded NaN here is
       the worst possible failure, because report() files it as a 0 with
       nothing on the sheet saying the drill broke. Every sibling drill
       ends its scorer this way; this one did not. */
    var score = Math.max(0, Math.min(100, shape - sizePenalty(ratio) - (isFinite(peekCost) ? peekCost : 0)));
    if (!isFinite(score)) score = 0;
    /* perTruth is measured in the TRUTH's frame (the player's drawing
       normalized onto it), which is the frame the score was computed in
       — and it is indexed by truePts, so the reveal can use the same
       indices against the contour it draws in the player's own frame. */
    return {
      score: score, shape: shape, sizeRatio: ratio,
      side: worstSide(truePts, parts.perTruth),
      missRuns: missRuns(parts.perTruth, zero)
    };
  }

  function meanScore(list) {
    if (!list.length) return 0;
    var sum = 0, i;
    for (i = 0; i < list.length; i++) sum += list[i];
    return sum / list.length;
  }

  /* A figure that reads well is one of these; a HABIT is three of them.
     Each figure said its own piece and then the round closed on "press
     new round" — so a player who shrinks every shape they remember was
     told "you drew it smaller than it was" three separate times and never
     once told it was the same mistake three times. One line, naming the
     pattern across the round, built from the same per-figure numbers the
     three verdicts were built from so the two can never disagree. */
  var CLEAN_SHAPE = 88;   /* the same bar placeWords() uses */
  var SIZE_SMALL = 0.8;   /* …and the same bounds sizeWords() uses */
  var SIZE_BIG = 1.25;

  function roundCoach(records) {
    var n = records ? records.length : 0;
    if (!n) return 'nothing scored this round.';
    var sides = {}, small = 0, big = 0, clean = 0, i, r, k, topSide = null, topN = 0;
    for (i = 0; i < n; i++) {
      r = records[i];
      if (!r) continue;
      if (isFinite(r.ratio) && r.ratio > 0) {
        if (r.ratio < SIZE_SMALL) small += 1;
        else if (r.ratio > SIZE_BIG) big += 1;
      }
      if (isFinite(r.shape) && r.shape >= CLEAN_SHAPE) { clean += 1; continue; }
      /* own-property tested rather than `sides[name] || 0`: a side name
         that collides with something on Object.prototype ("constructor")
         reads back as a function, and `fn + 1` is a string that loses
         every later comparison — the run would vanish instead of being
         counted. SIDE_NAMES cannot collide today; a counter must not
         depend on that staying true. */
      if (r.side) {
        sides[r.side] = (Object.prototype.hasOwnProperty.call(sides, r.side) ? sides[r.side] : 0) + 1;
      }
    }
    for (k in sides) {
      if (Object.prototype.hasOwnProperty.call(sides, k) && sides[k] > topN) { topN = sides[k]; topSide = k; }
    }
    if (clean === n) {
      return 'every outline landed close, and they got trickier as the round went on — that is the whole ramp.';
    }
    if (topN >= 2 && topSide) {
      return 'your memory dropped ' + topSide + ' on ' + topN + ' of the ' + n +
        ' figures — look there last, so it is the freshest thing you carry.';
    }
    if (small * 2 >= n) {
      return 'you drew them smaller than they were — memory shrinks a shape; take up the room it really had.';
    }
    if (big * 2 >= n) {
      return 'you drew them bigger than they were — the shape is right, the scale is drifting.';
    }
    /* FIGURE_SPECS shortens the look AND deepens the shape each figure, so
       "not the clock" would have been a plain lie about the ramp */
    return 'no one habit stood out — each figure gets a shorter look than the last, so carry the whole shape, not one edge.';
  }

  /* Closed Catmull-Rom through the control points — pure geometry,
     shared by the renderer and the ground truth. */
  function catmullRomClosed(ctrl, perSeg) {
    var out = [], n = ctrl.length, i, k, t, t2, t3, p0, p1, p2, p3;
    for (i = 0; i < n; i++) {
      p0 = ctrl[(i - 1 + n) % n];
      p1 = ctrl[i];
      p2 = ctrl[(i + 1) % n];
      p3 = ctrl[(i + 2) % n];
      for (k = 0; k < perSeg; k++) {
        t = k / perSeg; t2 = t * t; t3 = t2 * t;
        out.push({
          x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    return out;
  }

  /* ============================================================
     Canvas / DOM from here down.
     ============================================================ */
  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnDone = document.getElementById('btnDone');
  var btnUndo = document.getElementById('btnUndo');
  var btnClear = document.getElementById('btnClear');
  var btnPeek = document.getElementById('btnPeek');

  ArtDaily.init({ slug: SLUG });

  /* ---- per-hardware tolerance (the drill says which mode it eased
          for in the HUD, so the record stays honest) ---- */
  function floorPx() { return ArtDaily.ease(SHAPE_FLOOR_PX); }
  function slopPx() { return ArtDaily.ease(HAND_SLOP_PX); }

  /* A peek behind your own fingertip needs longer than a peek behind a
     mouse cursor — same price either way. */
  function peekMs() { return ArtDaily.inputMode() === 'mouse' ? 600 : 900; }

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function hexToRgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* Sunny watercolor on the paper card is ~2:1 — fine for washes,
     not for meaning-bearing canvas marks (ring, reveal contour).
     In light theme mix the accent toward ink, same trick the shared
     CSS uses for the HUD numbers; dark theme keeps the pure accent. */
  function accentInk(accent, ink) {
    if (document.documentElement.dataset.theme === 'dark') return accent;
    var a = hexToRgb(accent), b = hexToRgb(ink);
    if (!a || !b) return accent;
    var w = 0.6;
    return 'rgb(' + Math.round(a[0] * w + b[0] * (1 - w)) + ',' +
      Math.round(a[1] * w + b[1] * (1 - w)) + ',' +
      Math.round(a[2] * w + b[2] * (1 - w)) + ')';
  }

  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--sunny').trim();
    return {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accentInk(accent, ink),
      accentRaw: accent,
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- round state ---- */
  var round = 0, figIdx = 0, figure = null, scores = [], playing = false;
  /* one {shape, side, ratio} per scored figure — what the round-end
     coaching is built from (see roundCoach) */
  var records = [];
  var phase = 'idle'; /* idle | show | draw | reveal | done */
  var strokes = [], curStroke = null, activePointer = null, activeType = '';
  var peekUsed = false, peeking = false, peekTimer = null;
  var showStart = 0, ringFrac = 1, rafId = 0;
  var reveal = null, revealTimer = null, revealAt = 0;
  /* the round's reported result, banked the moment the last figure is
     scored — finishRound() is presentation only (see finishFigure) */
  var roundResult = null;

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function figLabel() { return 'figure ' + (figIdx + 1) + ' of ' + FIGURES_PER_ROUND; }

  function inkPx() { return inkLength(strokes, curStroke); }

  /* Radial control points around the canvas centre → smooth blob
     spanning ~45% of the sheet. */
  function makeFigure(idx) {
    var spec = FIGURE_SPECS[idx];
    var cx = W / 2, cy = H / 2;
    var R = Math.min(W, H) * 0.225;
    var step = Math.PI * 2 / spec.points;
    var ctrl = [], i;
    for (i = 0; i < spec.points; i++) {
      ctrl.push({
        x: cx + Math.cos(i * step + rand(-0.22, 0.22) * step) * R * rand(spec.rLo, spec.rHi),
        y: cy + Math.sin(i * step + rand(-0.22, 0.22) * step) * R * rand(spec.rLo, spec.rHi)
      });
    }
    return {
      pts: catmullRomClosed(ctrl, SAMPLES_PER_SEG),
      center: { x: cx, y: cy },
      ringR: R + 24,
      /* a 92px blob on a phone is not the same memory task as a 190px
         one on a desktop — small sheets get a longer look */
      exposure: Math.round(spec.exposure * Math.max(1, Math.min(1.6, 690 / Math.max(1, W))))
    };
  }

  function syncButtons() {
    var drawPhase = playing && phase === 'draw';
    btnDone.disabled = !drawPhase || inkPx() < MIN_INK_PX;
    btnUndo.disabled = !drawPhase || strokes.length === 0;
    btnClear.disabled = !drawPhase || (strokes.length === 0 && !curStroke);
    btnPeek.disabled = !drawPhase || peekUsed || peeking;
  }

  function stopTimers() {
    clearTimeout(revealTimer);
    clearTimeout(peekTimer);
    cancelAnimationFrame(rafId);
    peeking = false;
  }

  function newRound() {
    stopTimers();
    /* a round whose last figure is scored but still on its reveal was
       already banked at that score — close it out on screen before reset */
    if (playing && scores.length === FIGURES_PER_ROUND) finishRound();
    round += 1;
    figIdx = 0;
    scores = [];
    records = [];
    roundResult = null;
    playing = true;
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    startFigure();
  }

  function startFigure() {
    strokes = [];
    curStroke = null;
    activePointer = null;
    activeType = '';
    peekUsed = false;
    peeking = false;
    reveal = null;
    figure = makeFigure(figIdx);
    phase = 'show';
    ringFrac = 1;
    showStart = performance.now();
    hint.textContent = figLabel() + ' — memorize it before the ring runs out…';
    syncButtons();
    draw();
    rafId = requestAnimationFrame(tickShow);
  }

  function tickShow(now) {
    if (phase !== 'show') return;
    var elapsed = now - showStart;
    if (elapsed >= figure.exposure) {
      phase = 'draw';
      hint.textContent = figLabel() + ' — gone! redraw its outline from memory: any number of strokes, anywhere on the sheet.';
      syncButtons();
      draw();
      return;
    }
    ringFrac = 1 - elapsed / figure.exposure;
    draw();
    rafId = requestAnimationFrame(tickShow);
  }

  /* "shape 23% off" priced the miss without ever placing it. Name the
     quarter of the outline that drifted furthest, but only when the
     shape was actually off — telling someone who scored 96 that their
     left side was marginally the worst is noise, not coaching. */
  function placeWords(res) {
    if (!res || !res.side || res.shape >= CLEAN_SHAPE) return '';
    return ' (worst on ' + res.side.side + ')';
  }

  /* "size ratio 0.71x" told a beginner nothing — say it in words. The
     bounds are the shared ones roundCoach counts with, so a round that
     closes on "you drew them smaller" can only follow figures that each
     said so too. */
  function sizeWords(ratio) {
    if (!isFinite(ratio) || ratio <= 0) return 'size unclear';
    if (ratio < SIZE_SMALL) return 'you drew it smaller than it was';
    if (ratio > SIZE_BIG) return 'you drew it bigger than it was';
    return 'size about right';
  }

  function finishFigure() {
    clearTimeout(peekTimer);
    peeking = false;
    /* commit any stroke still in progress (e.g. keyboard "done ✓") */
    activePointer = null;
    activeType = '';
    if (curStroke && polyLength(curStroke) >= MIN_STROKE_PX) strokes.push(curStroke);
    curStroke = null;
    phase = 'reveal';
    revealAt = performance.now();
    var pts = flatten(strokes);
    var res = scoreFigure(strokes, figure.pts, peekUsed ? PEEK_COST : 0, floorPx(), slopPx());
    scores.push(res.score);
    records.push({ shape: res.shape, side: res.side ? res.side.side : null, ratio: res.sizeRatio });
    if (scores.length === FIGURES_PER_ROUND) {
      /* The round is complete NOW — report before the reveal plays out, so
         "new round" (or the embed player closing) during that last 2.6s
         reveal can never swallow three played figures. finishRound() is
         presentation only; this is the single report site. */
      roundResult = ArtDaily.report(meanScore(scores));
      hudScore.textContent = String(roundResult.score);
      hudBest.textContent = roundResult.best === null ? '–' : String(roundResult.best);
    }
    var pc = centroid(pts), tc = centroid(figure.pts);
    reveal = {
      score: Math.round(res.score),
      dx: pc.x - tc.x,
      dy: pc.y - tc.y,
      cx: pc.x,
      cy: pc.y,
      /* the score judged shape with your size normalized away, so the
         contour it judged is the truth at YOUR size — drawn at the truth's
         own size it reads as "your shape was miles out" beside a good
         number. The faint ghost still shows where and how big it really
         was, and the sentence below still names the size verdict. */
      scale: res.sizeRatio,
      shapeOff: Math.round(100 - res.shape),
      sizeRatio: res.sizeRatio,
      missRuns: res.missRuns || []
    };
    hint.textContent = figLabel() + ' — shape ' + reveal.shapeOff + '% off' + placeWords(res) + ', ' +
      sizeWords(reveal.sizeRatio) + (peekUsed ? ', peek −' + PEEK_COST : '') + '. tap to continue.';
    syncButtons();
    draw();
    revealTimer = setTimeout(nextFigure, REVEAL_MS);
  }

  function nextFigure() {
    clearTimeout(revealTimer);
    if (phase !== 'reveal') return;
    figIdx += 1;
    if (figIdx < FIGURES_PER_ROUND) { startFigure(); return; }
    finishRound();
  }

  /* Presentation only: finishFigure() already reported the round the
     instant the third figure was scored, so every completed round reaches
     ArtDaily.report exactly once — even if this never runs. */
  function finishRound() {
    playing = false;
    phase = 'done'; /* the last reveal stays on the sheet to study */
    var res = roundResult;
    /* the round's lesson, not just its exit: three separate verdicts add
       up to one habit worth naming */
    hint.textContent = 'round done — ' + roundCoach(records) + ' press "new round" to go again.';
    syncButtons();
    draw();
    if (res) {
      hudScore.textContent = String(res.score);
      hudBest.textContent = res.best === null ? '–' : String(res.best);
      showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
    }
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function drawClosed(pts, strokeStyle, width, alpha) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawPolyline(pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function drawStrokes(c, alpha, color) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color || c.ink;
    ctx.lineWidth = 2.5;
    for (var i = 0; i < strokes.length; i++) drawPolyline(strokes[i]);
    if (curStroke) drawPolyline(curStroke);
    ctx.restore();
  }

  /* The countdown is the one time-critical mark on the sheet, so it is
     painted at full strength: accentInk on the paper card is 3.9:1
     (AA for graphics) at alpha 1, but only 3.1:1 at 0.85. */
  function drawRing(c) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(figure.center.x, figure.center.y, figure.ringR, -Math.PI / 2, -Math.PI / 2 + ringFrac * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* Fat overlay on the missed stretches of the revealed contour. A run
     may start at a negative index because the outline is a closed loop
     and a miss can straddle the seam — walk it modulo the sample count,
     or that miss would be drawn as a chord straight across the figure. */
  function drawMissRuns(c, pts, runs) {
    var n = pts.length, r, i, k, p;
    if (!n) return;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 6;
    for (r = 0; r < runs.length; r++) {
      ctx.beginPath();
      for (i = runs[r][0]; i <= runs[r][1]; i++) {
        k = ((i % n) + n) % n;
        p = pts[k];
        if (i === runs[r][0]) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Ink text on an accent-tinted chip — AA in both themes (raw
     sunny text on the light card is ~2:1). */
  function drawSticker(c, label, x, y) {
    ctx.font = '900 16px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    var tx = Math.max(26, Math.min(W - 26, x));
    var ty = Math.max(24, Math.min(H - 12, y));
    var w = ctx.measureText(label).width + 16;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = c.card;
    ctx.fillRect(tx - w / 2, ty - 15, w, 22);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = c.accentRaw;
    ctx.fillRect(tx - w / 2, ty - 15, w, 22);
    ctx.restore();
    ctx.fillStyle = c.ink;
    ctx.fillText(label, tx, ty + 1);
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (!figure) return;

    if (phase === 'idle') {
      /* first screen: a dashed sample blob teaches what will flash.
         Dashed and thin keeps it visually quiet without dropping it
         below AA — muted at full alpha is 5.2:1 on the paper card. */
      ctx.save();
      ctx.setLineDash([6, 8]);
      drawClosed(figure.pts, c.muted, 2, 1);
      ctx.restore();
      drawSticker(c, 'tap to start', W / 2, H / 2);
      return;
    }

    if (phase === 'show' || peeking) {
      drawClosed(figure.pts, c.ink, 2.5, 1);
      if (phase === 'show') drawRing(c);
      /* peek: their work stays visible but subordinate — muted rather
         than faded ink, so it reads as the second voice (5.2:1) instead
         of a 2:1 ghost the player has to squint at to compare. */
      else drawStrokes(c, 1, c.muted);
      return;
    }

    if (phase === 'reveal' || phase === 'done') {
      /* ghost of the truth where it originally sat… */
      drawClosed(figure.pts, c.muted, 2, 0.22);
      /* …their strokes in ink… */
      drawStrokes(c, 1);
      /* …and the truth re-drawn at THEIR centroid and THEIR size, in
         accent: that is the shape the score compared, laid over the ink */
      if (reveal) {
        var shown = scaledAbout(translated(figure.pts, reveal.dx, reveal.dy), reveal.cx, reveal.cy, reveal.scale);
        drawClosed(shown, c.accent, 2.5, 0.95);
        /* the stretches your ink never came near, drawn fat on the very
           contour the score compared: thin = you remembered it, thick =
           you did not. The hint names the quarter it happened in. */
        if (reveal.missRuns && reveal.missRuns.length) drawMissRuns(c, shown, reveal.missRuns);
        drawSticker(c, String(reveal.score), reveal.cx, reveal.cy);
      }
      return;
    }

    /* draw phase: just the player's ink */
    drawStrokes(c, 1);
  }

  /* ---- input: free strokes, pointerId-guarded ---- */
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /* A 120Hz nib emits far more motion than the page is told about;
     coalesced samples keep a fast sweep's real shape instead of the
     browser's dispatch rate. */
  function pushSamples(ev, arr) {
    var list = null;
    try { list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null; } catch (e) { list = null; }
    if (list && list.length) {
      for (var i = 0; i < list.length; i++) arr.push(pointerPos(list[i]));
      return;
    }
    arr.push(pointerPos(ev));
  }

  /* Palm rejection. pointerId guarding only ever rejected the SECOND
     contact — on a tablet the palm lands first, so the nib was the one
     being ignored. A pen now takes the stroke off a touch that already
     started, and touches are ignored for a beat after any pen. */
  var penAt = -Infinity, PEN_GUARD_MS = 900;
  function claimAllowed(ev) {
    if (ev.pointerType === 'pen') { penAt = performance.now(); return true; }
    if (ev.pointerType === 'touch' && performance.now() - penAt < PEN_GUARD_MS) return false;
    return true;
  }

  canvas.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    if (phase === 'idle') { newRound(); return; } /* first screen: tap to start */
    if (phase === 'reveal') {
      /* tap to skip the reveal — but swallow taps in the first 350ms
         so a stray touch right after "done ✓" never eats the feedback */
      if (performance.now() - revealAt > 350) nextFigure();
      return;
    }
    if (phase !== 'draw' || peeking) return;
    if (!claimAllowed(ev)) return;
    if (activePointer !== null) {
      /* only a pen may take over, and it throws the palm's drift away */
      if (ev.pointerType !== 'pen' || activeType === 'pen') return;
      curStroke = null;
    }
    activePointer = ev.pointerId;
    activeType = ev.pointerType || '';
    curStroke = [pointerPos(ev)];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (activePointer === null || ev.pointerId !== activePointer || !curStroke) return;
    ev.preventDefault();
    pushSamples(ev, curStroke);
    draw();
  });

  function endStroke(ev) {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    activePointer = null;
    activeType = '';
    /* a dab shorter than MIN_STROKE_PX is an accidental tap — dropped,
       no penalty. Length, not sample count: a fast pen dab can be two
       samples and still be a real mark. */
    if (curStroke && polyLength(curStroke) >= MIN_STROKE_PX) strokes.push(curStroke);
    curStroke = null;
    if (phase === 'draw') {
      hint.textContent = figLabel() + (inkPx() >= MIN_INK_PX ?
        ' — press "done ✓" when it looks right, or keep refining. lifting is free.' :
        ' — keep going: a whole outline, not a tap. lift as often as you like.');
    }
    syncButtons();
    draw();
  }
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);

  /* interrupted stroke (system gesture etc.) — keep the ink, no penalty */
  canvas.addEventListener('pointercancel', endStroke);
  window.addEventListener('pointercancel', endStroke);
  /* iOS can drop the capture with NO pointerup and NO pointercancel. Without
     this the stroke never ends: activePointer stays set, every later press is
     refused by the pen-takeover guard, and the redraw cannot be finished at
     all. lostpointercapture always fires on the capturing element, and after a
     normal pointerup it is a no-op (activePointer is already null). */
  canvas.addEventListener('lostpointercapture', endStroke);

  /* ---- stage controls ---- */
  btnDone.addEventListener('click', function () {
    if (phase !== 'draw' || inkPx() < MIN_INK_PX) return;
    finishFigure();
  });

  /* One stray mark used to poison the score three ways at once (it grows
     the bounding diagonal, shrinks the scale normalization and moves the
     size ratio) and the only escape was wiping the whole attempt. */
  btnUndo.addEventListener('click', function () {
    if (phase !== 'draw' || !strokes.length) return;
    strokes.pop();
    hint.textContent = figLabel() + ' — last stroke removed.';
    syncButtons();
    draw();
  });

  btnClear.addEventListener('click', function () {
    if (phase !== 'draw') return;
    strokes = [];
    curStroke = null;
    activePointer = null;
    activeType = '';
    hint.textContent = figLabel() + ' — cleared. redraw from memory (the figure stays hidden).';
    syncButtons();
    draw();
  });

  btnPeek.addEventListener('click', function () {
    if (phase !== 'draw' || peekUsed || peeking) return;
    /* commit any in-progress stroke: no drawing while the truth shows */
    if (activePointer !== null) {
      activePointer = null;
      activeType = '';
      if (curStroke && polyLength(curStroke) >= MIN_STROKE_PX) strokes.push(curStroke);
      curStroke = null;
    }
    peekUsed = true;
    peeking = true;
    hint.textContent = figLabel() + ' — peek! that costs ' + PEEK_COST + ' on this figure.';
    syncButtons();
    draw();
    peekTimer = setTimeout(function () {
      peeking = false;
      if (phase === 'draw') hint.textContent = figLabel() + ' — back to memory. finish your redraw.';
      syncButtons();
      draw();
    }, peekMs());
  });

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);

  /* Hardware swapped mid-session (a laptop player plugs in a tablet, an
     iPad player picks up the pencil): the SDK repaints its own HUD chip,
     we just re-read the eased tolerance on the next score. */
  ArtDaily.onInput(function () { syncButtons(); draw(); });

  /* On resize everything scales uniformly (height tracks width), so
     the memorized figure and the ink stay fair — never regenerated. */
  function scalePts(pts, f) {
    for (var i = 0; i < pts.length; i++) { pts[i].x *= f; pts[i].y *= f; }
  }
  window.addEventListener('resize', function () {
    var oldW = W;
    fitCanvas();
    var f = oldW > 0 ? W / oldW : 1;
    if (f !== 1) {
      if (figure) {
        scalePts(figure.pts, f);
        figure.center.x *= f;
        figure.center.y *= f;
        figure.ringR *= f;
      }
      for (var s = 0; s < strokes.length; s++) scalePts(strokes[s], f);
      if (curStroke) scalePts(curStroke, f);
      if (reveal) {
        reveal.dx *= f; reveal.dy *= f;
        reveal.cx *= f; reveal.cy *= f;
      }
    }
    draw();
  });

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- boot: an idle "tap to start" screen, never an auto-started
     exposure the player misses while the page (or the embed dialog)
     is still settling. The first screen teaches the whole verb. ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  figure = makeFigure(0); /* dashed sample blob for the start screen */
  hint.textContent = 'a blob flashes, then hides — you redraw its outline (its contour) from memory: any number of strokes, anywhere on the sheet, lifting as often as you like. tap the sheet to start.';
  syncButtons();
  draw();
})();
