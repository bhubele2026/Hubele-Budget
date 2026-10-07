import { useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Figure } from "@/kit/Figure";
import { FreshnessBadge } from "@/kit/FreshnessBadge";
import { Meter, meterStatus } from "@/kit/Meter";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { StatusWord } from "@/kit/StatusWord";
import { contrastRatio, formatRatio } from "@/styles/contrast";
import {
  CATEGORICAL,
  INKS,
  PALETTE,
  PAPERS,
  RAMP,
  TEXT_ACCENTS,
  TYPE_SCALE,
  WASHES,
  type ColorToken,
} from "@/styles/tokens";

/**
 * ⭐ /design — the system on one page, for the owner's early veto.
 *
 * Every swatch prints its hex and its MEASURED contrast (the same function the
 * contrast test runs), every type step is set in its own size, and each kit
 * component is shown in its states. All sample figures are made up.
 */

// A fixed "now" so the sample freshness lines read the same for everyone.
const SAMPLE_NOW = new Date("2026-10-07T14:00:00Z");
// Literal class names, so Tailwind's scanner sees every one of them.
const BG: Record<(typeof PAPERS)[number], string> = {
  "paper-0": "bg-paper-0",
  "paper-1": "bg-paper-1",
  "paper-2": "bg-paper-2",
};
const TYPE_CLASS: Record<(typeof TYPE_SCALE)[number]["name"], string> = {
  "figure-xl": "type-figure-xl",
  figure: "type-figure",
  "figure-sm": "type-figure-sm",
  headline: "type-headline",
  section: "type-section",
  body: "type-body",
  label: "type-label",
  caption: "type-caption",
};

function Swatch({ token, against }: { token: ColorToken; against?: readonly ColorToken[] }) {
  const hex = PALETTE[token];
  return (
    <li className="flex items-start gap-3" data-testid={`swatch-${token}`}>
      <span aria-hidden className="size-10 shrink-0 rounded-1 border border-rule" style={{ backgroundColor: hex }} />
      <span className="flex min-w-0 flex-col">
        <span className="type-label text-ink">{token}</span>
        <span className="type-figure-sm text-ink-2">{hex}</span>
        {against?.map((bg) => (
          <span key={bg} className="type-caption text-ink-2">
            <span className="tnum">{formatRatio(contrastRatio(hex, PALETTE[bg]))}</span> on {bg}
          </span>
        ))}
      </span>
    </li>
  );
}

function SwatchGrid({ tokens, against }: { tokens: readonly ColorToken[]; against?: readonly ColorToken[] }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {tokens.map((t) => (
        <Swatch key={t} token={t} against={against} />
      ))}
    </ul>
  );
}

export default function DesignPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <div className="flex flex-col" data-testid="design-page">
      <header className="mb-8 flex flex-col gap-2">
        <h1 className="type-headline text-ink">Paper &amp; rule</h1>
        <p className="type-body text-ink-2">The H2 design system, on one page, for review.</p>
      </header>

      <Section label="Paper and rules" foot="Paper is the ground. Rules separate; nothing floats.">
        <SwatchGrid tokens={[...PAPERS, "rule", "rule-strong"]} />
      </Section>

      <Section label="Ink" foot="Every ink clears 4.5:1 on every paper.">
        <SwatchGrid tokens={INKS} against={PAPERS} />
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PAPERS.map((p) => (
            <div key={p} className={`flex flex-col gap-1 rounded-1 border border-rule p-3 ${BG[p]}`}>
              <span className="type-caption text-ink-3">{p}</span>
              <span className="type-body text-ink">Ink for words.</span>
              <span className="type-body text-ink-2">Ink-2 for support.</span>
              <span className="type-body text-ink-3">Ink-3 for captions.</span>
            </div>
          ))}
        </div>
      </Section>

      <Section label="Accents" foot="Moss is the accent. Clay asks for attention.">
        <SwatchGrid tokens={TEXT_ACCENTS} against={["paper-0"]} />
      </Section>

      <Section label="Washes" foot="Quiet grounds for a status. Never the only signal.">
        <SwatchGrid tokens={WASHES} />
      </Section>

      <Section label="Sequential ramp" foot="Index by rank, never by series.">
        <div className="flex h-10 overflow-hidden rounded-1 border border-rule">
          {RAMP.map((t) => (
            <span key={t} className="flex-1" style={{ backgroundColor: PALETTE[t] }} title={`${t} ${PALETTE[t]}`} />
          ))}
        </div>
        <ul className="mt-2 grid grid-cols-3 gap-x-4 sm:grid-cols-6">
          {RAMP.map((t) => (
            <li key={t} className="type-caption text-ink-2">
              {t} <span className="tnum">{PALETTE[t]}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section label="Categories" foot="Eight at most; the rest roll into cat-other.">
        <SwatchGrid tokens={[...CATEGORICAL, "cat-other"]} />
      </Section>

      <Section label="Type" foot="Public Sans for words, Source Serif 4 for heads, IBM Plex Mono for money.">
        <ul className="flex flex-col gap-5">
          {TYPE_SCALE.map((t) => (
            <li key={t.name} className="flex flex-col gap-1" data-testid={`type-${t.name}`}>
              <span className={`${TYPE_CLASS[t.name]} text-ink`}>
                {t.family === "mono" ? "$12,480" : t.name === "section" ? "This week" : "The household's money"}
              </span>
              <span className="type-caption text-ink-2">
                {t.name} · <span className="tnum">{t.size}/{t.line}</span>
                {"phone" in t ? (
                  <>
                    {" "}
                    (<span className="tnum">{t.phone[0]}/{t.phone[1]}</span> on phones)
                  </>
                ) : null}{" "}
                · {t.family} {t.weight} · {t.note}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section label="Figures" foot="No amount shows a dash, never $0. Cold shows a shape.">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <Figure size="md" label="Spent so far" amount={412.5} state="loaded" sub="as of Oct 7 · bank sync" />
          <Figure size="sm" label="Not received" amount={null} state="failed" />
          <Figure size="md" label="Still loading" amount={null} state="cold" />
        </div>
      </Section>

      <Section label="Meters" foot="Status is always a word. Tight also hatches.">
        <div className="flex flex-col gap-6">
          <Meter label="On plan" spent={210} limit={600} status={meterStatus(210, 600)} />
          <Meter label="Tight" spent={540} limit={600} status={meterStatus(540, 600)} />
          <Meter label="Over" spent={655} limit={600} status={meterStatus(655, 600)} />
          <Meter label="No limit" spent={120} limit={null} status="on" />
        </div>
      </Section>

      <Section label="Status words">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <StatusWord tone="on">On plan</StatusWord>
          <StatusWord tone="tight">Tight</StatusWord>
          <StatusWord tone="over">Over by $55</StatusWord>
          <StatusWord tone="fresh">Synced 12 minutes ago</StatusWord>
          <StatusWord tone="stale">Out of date</StatusWord>
          <StatusWord tone="neutral">Updating</StatusWord>
        </div>
      </Section>

      <Section label="Freshness">
        <div className="flex flex-col gap-3">
          <FreshnessBadge
            now={SAMPLE_NOW}
            bank={{ source: "plaid", asOfDate: "2026-10-07T13:48:00Z", lastContactAt: null, stale: false, staleReason: null }}
          />
          <FreshnessBadge
            now={SAMPLE_NOW}
            bank={{ source: "plaid", asOfDate: "2026-10-04T13:00:00Z", lastContactAt: null, stale: true, staleReason: "refresh_failed" }}
          />
          <FreshnessBadge
            now={SAMPLE_NOW}
            bank={{ source: "manual", asOfDate: "2026-09-28T13:00:00Z", lastContactAt: null, stale: true, staleReason: "manual_old" }}
          />
        </div>
      </Section>

      <Section label="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Save</Button>
          <Button>Cancel</Button>
          <Button variant="danger">Remove</Button>
          <Button variant="link">Open review</Button>
          <Button variant="primary" size="sm" icon={Bell}>
            Remind me
          </Button>
          <Button size="sm" disabled>
            Not yet
          </Button>
        </div>
      </Section>

      <Section label="Notes">
        <div className="flex flex-col gap-3">
          <Note kind="empty">Nothing is waiting on you.</Note>
          <Note kind="stale">The bank balance may be out of date.</Note>
          <Note kind="error" onRetry={() => {}}>
            Couldn't load these numbers.
          </Note>
        </div>
      </Section>

      <Section label="Sheet and disclosure" foot="The sheet rises on a phone and slides in on a desktop.">
        <div className="flex flex-col gap-4">
          <Sheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            title="Electric bill"
            description="A sample sheet."
            trigger={<Button className="self-start">Open a sheet</Button>}
          >
            <div className="flex flex-col gap-4">
              <Figure size="md" label="Due Oct 12" amount={142.18} state="loaded" />
              <p className="type-body text-ink-2">Escape closes it and puts focus back on the button.</p>
            </div>
          </Sheet>
          <Disclosure summary="How is this figure made?">
            The server computes it; this screen only reads it.
          </Disclosure>
        </div>
      </Section>

      <Section label="Motion">
        <ul className="flex flex-col gap-1 type-body text-ink-2">
          <li>
            <span className="tnum">120 ms</span> fast, <span className="tnum">220 ms</span> base, one ease-out.
          </li>
          <li>Only the sheet, the meter fill and the focus ring move.</li>
          <li>Reduced motion sets both dials to zero.</li>
        </ul>
      </Section>

    </div>
  );
}
