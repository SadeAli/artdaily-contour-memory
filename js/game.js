/* ============================================================
   game.js — Contour Memory: a smooth blob appears centered for a
   timed exposure (shrinking countdown ring), then hides; the
   player redraws its contour from memory with any strokes, any
   place on the sheet. Three figures per round, each shown shorter
   and shaped trickier. Scoring is translation-invariant pure
   geometry: centroid- and scale-aligned symmetric chamfer keeps
   shape and size separate, size costing only a gentle explicit
   penalty — the pure functions sit at the top
   so they are unit-testable without a canvas. One honest "peek
   −15" per figure reshows the shape for 400ms.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'contour-memory';
  var FIGURES_PER_ROUND = 3;
  var MIN_POINTS = 20;      /* "done ✓" unlocks at this many samples */
  var PEEK_MS = 400;
  var PEEK_COST = 15;
  var REVEAL_MS = 2600;
  var SAMPLES_PER_SEG = 18; /* spline density (also the ground truth) */
  var MAX_SCORE_PTS = 400;  /* player samples are decimated to this */

  /* Difficulty ramps within the round: more control points, deeper
     concavities, shorter exposure. */
  var FIGURE_SPECS = [
    { points: 6,  rLo: 0.78, rHi: 1.00, exposure: 2000 },
    { points: 8,  rLo: 0.62, rHi: 1.00, exposure: 1200 },
    { points: 10, rLo: 0.42, rHi: 1.00, exposure: 700 }
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

  function translated(pts, dx, dy) {
    var out = [], i;
    for (i = 0; i < pts.length; i++) out.push({ x: pts[i].x + dx, y: pts[i].y + dy });
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
     sampling density. */
  function chamferStrokes(strokes, truePts) {
    var pPts = decimate(flatten(strokes), MAX_SCORE_PTS);
    if (!pPts.length || truePts.length < 2) return Infinity;
    var sumA = 0, sumB = 0, i;
    for (i = 0; i < pPts.length; i++) sumA += distToClosedPath(pPts[i], truePts);
    for (i = 0; i < truePts.length; i++) sumB += distToStrokes(truePts[i], strokes);
    return Math.max(sumA / pPts.length, sumB / truePts.length);
  }

  /* Chamfer of 11% of the figure's bounding diagonal scores zero. */
  function shapeScore(dNorm) { return 100 * clamp01(1 - dNorm / 0.11); }

  /* Size errors within ±~20% are free, then up to −10: drawing it
     half-size is a memory failure too, but a gentle one. */
  function sizePenalty(sizeRatio) {
    if (sizeRatio <= 0) return 10;
    return 10 * clamp01((Math.abs(Math.log(sizeRatio)) - 0.18) / 0.5);
  }

  /* Full per-figure pipeline: align the player's centroid onto the
     true contour's and scale their drawing to the true bounding
     diagonal (shape is judged as shape — size is judged separately,
     and gently, by sizePenalty), chamfer normalized by the true
     diagonal, then shape − size − peek, clamped to 0–100. */
  function scoreFigure(strokes, truePts, peekCost) {
    var pts = flatten(strokes);
    if (!pts.length || truePts.length < 2) return { score: 0, shape: 0, sizeRatio: 0 };
    var trueDiag = boundingDiag(truePts);
    if (trueDiag === 0) return { score: 0, shape: 0, sizeRatio: 0 };
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
    var dNorm = chamferStrokes(norm, truePts) / trueDiag;
    var shape = shapeScore(dNorm);
    var score = Math.max(0, Math.min(100, shape - sizePenalty(ratio) - peekCost));
    return { score: score, shape: shape, sizeRatio: ratio };
  }

  function meanScore(list) {
    if (!list.length) return 0;
    var sum = 0, i;
    for (i = 0; i < list.length; i++) sum += list[i];
    return sum / list.length;
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
  var btnClear = document.getElementById('btnClear');
  var btnPeek = document.getElementById('btnPeek');

  ArtDaily.init({ slug: SLUG });

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
  var phase = 'idle'; /* idle | show | draw | reveal | done */
  var strokes = [], curStroke = null, activePointer = null;
  var peekUsed = false, peeking = false, peekTimer = null;
  var showStart = 0, ringFrac = 1, rafId = 0;
  var reveal = null, revealTimer = null, revealAt = 0;

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function figLabel() { return 'figure ' + (figIdx + 1) + ' of ' + FIGURES_PER_ROUND; }

  function pointCount() {
    var n = curStroke ? curStroke.length : 0, i;
    for (i = 0; i < strokes.length; i++) n += strokes[i].length;
    return n;
  }

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
      exposure: spec.exposure
    };
  }

  function syncButtons() {
    var drawPhase = playing && phase === 'draw';
    btnDone.disabled = !drawPhase || pointCount() < MIN_POINTS;
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
    /* a round whose last figure is scored but still on its reveal has
       not reported yet — flush it so a finished round is never lost */
    if (playing && scores.length === FIGURES_PER_ROUND) finishRound();
    round += 1;
    figIdx = 0;
    scores = [];
    playing = true;
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    startFigure();
  }

  function startFigure() {
    strokes = [];
    curStroke = null;
    activePointer = null;
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
      hint.textContent = figLabel() + ' — gone! redraw its contour from memory, anywhere.';
      syncButtons();
      draw();
      return;
    }
    ringFrac = 1 - elapsed / figure.exposure;
    draw();
    rafId = requestAnimationFrame(tickShow);
  }

  function finishFigure() {
    clearTimeout(peekTimer);
    peeking = false;
    /* commit any stroke still in progress (e.g. keyboard "done ✓") */
    activePointer = null;
    if (curStroke && curStroke.length >= 3) strokes.push(curStroke);
    curStroke = null;
    phase = 'reveal';
    revealAt = performance.now();
    var pts = flatten(strokes);
    var res = scoreFigure(strokes, figure.pts, peekUsed ? PEEK_COST : 0);
    scores.push(res.score);
    var pc = centroid(pts), tc = centroid(figure.pts);
    reveal = {
      score: Math.round(res.score),
      dx: pc.x - tc.x,
      dy: pc.y - tc.y,
      cx: pc.x,
      cy: pc.y,
      shapeOff: Math.round(100 - res.shape),
      sizeRatio: res.sizeRatio
    };
    hint.textContent = figLabel() + ' — shape ' + reveal.shapeOff + '% off, size ratio ' +
      reveal.sizeRatio.toFixed(2) + 'x' + (peekUsed ? ', peek −' + PEEK_COST : '') + '. tap to continue.';
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

  function finishRound() {
    playing = false;
    phase = 'done'; /* the last reveal stays on the sheet to study */
    var res = ArtDaily.report(meanScore(scores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — press "new round" to go again.';
    syncButtons();
    draw();
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
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
      /* …and the truth re-drawn at THEIR centroid, in accent */
      if (reveal) {
        drawClosed(translated(figure.pts, reveal.dx, reveal.dy), c.accent, 2.5, 0.95);
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

  canvas.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    if (phase === 'idle') { newRound(); return; } /* first screen: tap to start */
    if (phase === 'reveal') {
      /* tap to skip the reveal — but swallow taps in the first 350ms
         so a stray touch right after "done ✓" never eats the feedback */
      if (performance.now() - revealAt > 350) nextFigure();
      return;
    }
    if (phase !== 'draw' || peeking || activePointer !== null) return;
    activePointer = ev.pointerId;
    curStroke = [pointerPos(ev)];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (activePointer === null || ev.pointerId !== activePointer || !curStroke) return;
    ev.preventDefault();
    curStroke.push(pointerPos(ev));
    draw();
  });

  function endStroke(ev) {
    if (activePointer === null || ev.pointerId !== activePointer) return;
    activePointer = null;
    /* strokes under 3 samples are accidental taps — dropped, no penalty */
    if (curStroke && curStroke.length >= 3) strokes.push(curStroke);
    curStroke = null;
    if (phase === 'draw') {
      hint.textContent = figLabel() + (pointCount() >= MIN_POINTS ?
        ' — press "done ✓" when it looks right, or keep refining.' :
        ' — keep going: a full contour, not a tap.');
    }
    syncButtons();
    draw();
  }
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);

  canvas.addEventListener('pointercancel', function (ev) {
    /* interrupted stroke (system gesture etc.) — keep the ink, no penalty */
    endStroke(ev);
  });

  /* ---- stage controls ---- */
  btnDone.addEventListener('click', function () {
    if (phase !== 'draw' || pointCount() < MIN_POINTS) return;
    finishFigure();
  });

  btnClear.addEventListener('click', function () {
    if (phase !== 'draw') return;
    strokes = [];
    curStroke = null;
    activePointer = null;
    hint.textContent = figLabel() + ' — cleared. redraw from memory (the figure stays hidden).';
    syncButtons();
    draw();
  });

  btnPeek.addEventListener('click', function () {
    if (phase !== 'draw' || peekUsed || peeking) return;
    /* commit any in-progress stroke: no drawing while the truth shows */
    if (activePointer !== null) {
      activePointer = null;
      if (curStroke && curStroke.length >= 3) strokes.push(curStroke);
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
    }, PEEK_MS);
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
  hint.textContent = 'a blob flashes, then hides — you redraw its contour from memory, any strokes, anywhere. tap the sheet to start.';
  syncButtons();
  draw();
})();
