# Contour Memory — Art Daily drill

A smooth blob flashes on the sheet, then hides; you redraw its outline
(its contour) from memory, with any number of strokes, anywhere, lifting
as often as you like. Three figures per round — each exposed shorter
(2.8s → 1.1s, stretched further on small sheets) and shaped trickier
(6 → 10 control points, deeper concavities). One "peek −8" per figure
reshows it (0.6s with a mouse, 0.9s behind a fingertip) at exactly that
price. "undo" drops the last stroke; "clear" wipes them all.

Scoring is translation-invariant pure geometry: your strokes are
centroid- and scale-aligned to the true contour, a symmetric chamfer
distance scores the shape, and drawing far off-scale costs a gentle
extra. The chamfer at which the shape score hits zero is
`max(0.11 × true diagonal, floor) + slop`, where both pixel terms run
through `ArtDaily.ease()` — so a phone sheet is not a stricter drill
than a desktop one, and a mouse or a fingertip is not scored against a
nib's precision. The HUD says which mode it eased for; scores are only
ever compared with your own. After every figure the true contour is
redrawn over your strokes so you see what drifted. Part of
[artdaily.sadeali.com](https://artdaily.sadeali.com/) — zero build, no
trackers; `js/artdaily-sdk.js` is vendored, never edited.
