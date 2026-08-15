# Contour Memory — Art Daily drill

A smooth blob flashes on the sheet, then hides; you redraw its contour
from memory, with any strokes, anywhere. Three figures per round — each
exposed shorter (2s → 0.7s) and shaped trickier (6 → 10 control points,
deeper concavities). One "peek −15" per figure reshows it for 400ms at
exactly that price.

Scoring is translation-invariant pure geometry: your strokes are
centroid- and scale-aligned to the true contour, a symmetric chamfer
distance (normalized by the figure's bounding diagonal) scores the
shape, and drawing far off-scale costs a gentle extra. After every
figure the true contour is redrawn over your strokes so you see what
drifted. Part of [artdaily.sadeali.com](https://artdaily.sadeali.com/) —
zero build, no trackers; `js/artdaily-sdk.js` is vendored, never edited.
