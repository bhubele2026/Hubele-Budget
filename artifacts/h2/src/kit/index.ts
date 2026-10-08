// The kit. Small on purpose: reuse these, never a second set.
export { ACTION_TITLE_MAX, ActionCard } from "./ActionCard";
export { CategoryChip } from "./CategoryChip";
export { Button, buttonClass, type ButtonVariant, type ButtonSize } from "./Button";
export { Disclosure } from "./Disclosure";
export { Dock } from "./Dock";
export { DESTINATIONS, isActive, type Destination } from "./destinations";
export { Figure, type FigureSize, type FigureTone } from "./Figure";
export { FreshnessBadge, type BankFreshness } from "./FreshnessBadge";
export { LedgerRow } from "./LedgerRow";
export { Masthead } from "./Masthead";
export { Meter, meterStatus, meterWords, TIGHT_AT, type MeterStatus } from "./Meter";
export { Note, RefreshNote, type NoteKind } from "./Note";
export { Section } from "./Section";
export { SectionIndex } from "./SectionIndex";
export { Segmented, type SegmentedOption } from "./Segmented";
export { SkeletonFigure, SkeletonLine, SkeletonMeter } from "./Skeleton";
export { StatusWord, type StatusTone } from "./StatusWord";
export { TrailItem } from "./TrailItem";
// ⚠️ `Toast` is NOT re-exported either: only the Activity screens mount it.
// ⚠️ `Sheet` is NOT re-exported here: it carries Radix Dialog, and nothing on
// the open path may pull that in. Import it from "@/kit/Sheet" inside a lazy
// screen.
