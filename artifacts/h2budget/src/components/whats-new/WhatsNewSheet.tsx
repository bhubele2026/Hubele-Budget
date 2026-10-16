import { useRef } from "react";
import { formatDay, readLines, type WhatsNewReaderLine, type WhatsNewUpdate } from "@workspace/avalanche-core/whatsNew";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { btn } from "@/ui";
import { cn } from "@/lib/utils";

/**
 * ⭐ (WN) THE WHAT'S NEW SHEET.
 *
 * MUST-READ (anything unread): every unread note in full, and ONE way out —
 * "I've read this" ("I've read these" for several). No X; Escape and a click
 * outside do nothing (owner, 2026-10-15). The button takes the focus without
 * scrolling, so Enter answers it and the newest note stays in view.
 * HISTORY (opened from "What's new" with nothing unread): the latest note in
 * full, then "Earlier"; a normal dialog — X, Escape, a click outside, Close.
 * Opened from the link while something is unread, it is must-read with
 * "Earlier" below.
 *
 * The OWNER sees under each note "Read by <name> on <day>" / "Not read yet";
 * a member never does. That line keeps its height while it loads, so nothing
 * jumps. Motion is the dialog's own (`.anim-modal`) plus `.stagger`, both off
 * under reduced motion.
 */

/** The owner's read lines per note id: undefined = loading (space kept), null = unavailable (hidden). */
export type ReadReport = Map<string, WhatsNewReaderLine[]> | null | undefined;

export interface WhatsNewSheetProps {
  /** Every note H2 ships, newest first. */
  updates: readonly WhatsNewUpdate[];
  /** The notes still in front of this person (must-read when non-empty). */
  unread: readonly WhatsNewUpdate[];
  /** Opened from the link (history) rather than by the greeting. */
  fromLink: boolean;
  /** Owner: the read lines are drawn. */
  owner: boolean;
  report?: ReadReport;
  onRead: () => void;
  onClose: () => void;
}

function OwnerLines({ id, report }: { id: string; report: ReadReport }) {
  if (report === null) return null;
  if (report === undefined) {
    return <p aria-hidden className="mt-1 h-4 w-40 rounded-control skeleton" data-testid="whats-new-readby-loading" />;
  }
  const lines = readLines(report.get(id) ?? []);
  if (lines.length === 0) return null;
  return (
    <ul className="mt-1 flex list-none flex-col gap-0.5 p-0" data-testid="whats-new-readby">
      {lines.map((l) => (
        <li key={l} className={cn("text-label font-medium", l.startsWith("Read by") ? "text-brand-navy" : "text-neutral-600")}>
          {l}
        </li>
      ))}
    </ul>
  );
}

function NewChip() {
  return (
    <span className="ml-2 rounded-full bg-brand-orange px-1.5 py-px align-middle text-micro font-semibold text-brand-navy" data-testid="whats-new-new">
      New
    </span>
  );
}

export default function WhatsNewSheet(props: WhatsNewSheetProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const unreadIds = new Set(props.unread.map((u) => u.id));
  const mustRead = props.unread.length > 0;
  const full = mustRead ? props.unread : props.updates.slice(0, 1);
  const fullIds = new Set(full.map((u) => u.id));
  // The greeting shows only what is new; the link also lists the rest.
  const earlier = mustRead && !props.fromLink ? [] : props.updates.filter((u) => !fullIds.has(u.id));
  const buttonText = mustRead ? (props.unread.length > 1 ? "I've read these" : "I've read this") : "Close";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mustRead) props.onClose();
      }}
    >
      <DialogContent
        hideClose={mustRead}
        aria-describedby={undefined}
        data-testid="whats-new-sheet"
        data-must-read={mustRead ? "true" : "false"}
        className="flex max-h-[85dvh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(e) => {
          if (mustRead) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (mustRead) e.preventDefault();
        }}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          btnRef.current?.focus({ preventScroll: true });
        }}
      >
        {/* Focusable so a keyboard can scroll a long note (Tab: the notes, then the button). */}
        <div
          tabIndex={0}
          role="region"
          aria-label="What's new notes"
          className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy/40 sm:px-6 sm:pt-6"
        >
          <p className="text-micro font-semibold uppercase tracking-wide text-neutral-600">What's new</p>
          {full.map((u, i) => {
            const Title = i === 0 ? DialogTitle : "h2";
            return (
              <section key={u.id} data-whats-new-update={u.id} className={cn(i > 0 && "mt-5 border-t border-brand-line pt-5")}>
                <Title className={cn("mt-1 text-title font-semibold leading-snug tracking-tight text-brand-navy")}>{u.headline}</Title>
                <p className="mt-1 text-label text-neutral-600">
                  {formatDay(u.id)}
                  {unreadIds.has(u.id) ? <NewChip /> : null}
                </p>
                {props.owner ? <OwnerLines id={u.id} report={props.report} /> : null}
                <ul className="stagger mt-3 flex list-none flex-col gap-3 p-0">
                  {u.items.map((item) => (
                    <li key={item.title}>
                      <p className="text-body font-semibold text-brand-navy">{item.title}</p>
                      <p className="mt-0.5 text-body leading-relaxed text-neutral-700">{item.body}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {earlier.length > 0 ? (
            <section className="mt-5 border-t border-brand-line pt-4" data-testid="whats-new-earlier">
              <h3 className="text-micro font-semibold uppercase tracking-wide text-neutral-600">Earlier</h3>
              <div className="mt-2 flex flex-col gap-4">
                {earlier.map((u) => (
                  <div key={u.id} data-whats-new-update={u.id}>
                    <p className="text-body font-semibold text-brand-navy">
                      {u.headline}
                      {unreadIds.has(u.id) ? <NewChip /> : null}
                    </p>
                    <p className="text-label text-neutral-600">{formatDay(u.id)}</p>
                    {props.owner ? <OwnerLines id={u.id} report={props.report} /> : null}
                    <ul className="mt-1 flex list-none flex-col gap-1 p-0">
                      {u.items.map((item) => (
                        <li key={item.title} className="text-label leading-relaxed text-neutral-700">
                          <span className="font-semibold text-brand-navy">{item.title}.</span> {item.body}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <div className="shrink-0 border-t border-brand-line bg-white px-5 py-4 sm:px-6">
          <button
            ref={btnRef}
            type="button"
            className={cn(btn, "w-full py-2.5")}
            data-testid="whats-new-button"
            data-kind={mustRead ? "read" : "close"}
            onClick={() => (mustRead ? props.onRead() : props.onClose())}
          >
            {buttonText}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
