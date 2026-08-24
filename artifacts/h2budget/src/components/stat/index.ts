// What remains of the pre-overhaul "BH stat-card kit". The ring/pill/sparkline/
// fill/why primitives it used to export were displayed only by the dev gallery
// at /dev/components and rendered by no real screen; they went in D1 along with
// the gallery and the good/warning/danger colour vocabulary they carried, which
// the navy+orange palette law replaced.
//
// SectionHeader survives because `pages/amex.tsx` renders it. New work should
// reach for `src/ui.tsx` (cards, Stat, chips, table tokens) rather than growing
// this barrel back.
export { SectionHeader } from "./section-header";
