// ⭐ WHAT'S NEW — the notes behind the household's "What's new" sheet.
//
// Owner, 2026-10-15: "so my wife can actually see what's changing as I update".
// Modelled on the KFI dashboard's: a sheet greets each person until they press
// "I've read this"; Escape or a click outside does nothing while a note is
// unread; the press is recorded for the PERSON on the server
// (`whats_new_reads`, `routes/whatsNew.ts`), never in the browser; the owner
// sees "Read by <name> on <day>" or "Not read yet" under each note.
//
// The standing rules (CLAUDE.md §3, "What's new"):
//   - ⚠️ EVERY BIGGER VISIBLE CHANGE ADDS A NOTE HERE, IN THE SAME COMMIT. A new
//     feature or screen, or a real change in how a number is worked out, gets
//     one. Ties, labels, polish, speed and internal work get none, and so do
//     tools only the owner uses (proposed fixes). The feature itself gets none.
//   - Big things only, plain words, short. Written for the people who use H2.
//   - Never version numbers, package codes, system names, code words or cents.
//     The app is "H2", never "I".
//   - Newest first. The id is the day it shipped, `YYYY-MM-DD`; a second note
//     on the same day is `.2`, then `.3` … `.9` (".10" would sort before ".9").
//   - Never change or reuse a shipped id: it carries people's reads.
//   `artifacts/h2budget/src/lib/whatsNew.test.ts` holds the format and words.
//
// A subpath of its own (`@workspace/avalanche-core/whatsNew`), like `glossary`:
// the server reads the ids (what may be recorded, the owner's report) and the
// web reads the words. The web takes it only from the lazy sheet, so the notes
// never ride on the open path. No dependency but `./householdTime`.

import { addDaysISO, householdDateOf } from "./householdTime";

export interface WhatsNewItem {
  title: string;
  body: string;
}

export interface WhatsNewUpdate {
  /** The day it shipped, `YYYY-MM-DD` (or `YYYY-MM-DD.2` … `.9`). Also what "I've read this" records. */
  id: string;
  headline: string;
  items: WhatsNewItem[];
}

/** A note's id: the day it shipped, then `.2`–`.9` for a second note that day. */
export const WHATS_NEW_ID = /^\d{4}-\d{2}-\d{2}(\.[2-9])?$/;

/**
 * ⭐ THE CLICK STARTS HERE. From this note on, a note stays in front of each
 * person until they press "I've read this". Older notes (none yet) would be
 * history only. A new member starts the day after they join (`startFor`).
 */
export const READ_CLICK_FROM = "2026-10-16";

/** Newest first. */
export const WHATS_NEW: readonly WhatsNewUpdate[] = [
  {
    id: "2026-11-11.4",
    headline: "Light, dark, or automatic",
    items: [
      {
        title: "A dark look",
        body: "H2 now has a dark look: black, with the same navy bar on top. Every page and chart has it. The light look is the same as before.",
      },
      {
        title: "Four choices",
        body: "Tap the half circle in the top bar, next to Ask. Pick Auto, Light, Dark, or Time of day. On a phone it is at the bottom of the menu. It is also in Settings, under Household.",
      },
      {
        title: "Auto and Time of day",
        body: "Auto follows your phone or computer. Time of day is dark from 7 PM to 7 AM. Your pick is yours alone and follows you to every device.",
      },
    ],
  },
  {
    id: "2026-11-11.3",
    headline: "Home says less",
    items: [
      {
        title: "Bars for spending and debt",
        body: "Spent this week now has a thin bar and one line: what is left, or how far over. Debt paid has a bar too. Lowest is now named Lowest cash, 90 days.",
      },
      {
        title: "Paid, then the next payment",
        body: "Once this week is paid, the box is two short rows: Paid and Next payment. A row for more than one card says 2 cards. Tap it to see each one.",
      },
      {
        title: "A cleaner chart, and a clearer name",
        body: "The home chart is now the same clean line as the Forecast page, with the lowest point marked on it. More is now named Accounts, allowances and tools. Nothing went away.",
      },
    ],
  },
  {
    id: "2026-11-11.2",
    headline: "A cleaner Forecast chart",
    items: [
      {
        title: "One solid line",
        body: "The Forecast chart is now one solid line with a soft fill. Paydays are small marks along the bottom, and three labels stay on it: Today, the lowest point and the cushion.",
      },
      {
        title: "Point at any day",
        body: "Move across the chart, or drag on a phone, and a dot follows the line with that day's balance and money in and out. Tap a day to open it. \"Show bills\" brings every marker back.",
      },
    ],
  },
  {
    id: "2026-11-11",
    headline: "Home is four numbers",
    items: [
      {
        title: "What to pay, then four numbers",
        body: "The home page now opens with what to pay this week and four numbers: checking, the lowest point ahead, what is spent this week, and how much debt is paid. Tap a number to see more.",
      },
      {
        title: "Everything else is under More",
        body: "Nothing went away. The six boxes, each bank's last update, Can we afford something? and the morning text are under More, just below the four numbers.",
      },
    ],
  },
  {
    id: "2026-11-10.3",
    headline: "The Forecast reads in one line",
    items: [
      {
        title: "The answer first",
        body: "The top of the Forecast now says it in one line: checking today, the lowest point and its day, the next payday, and where the window ends. The other figures are under Details.",
      },
      {
        title: "The next 14 days",
        body: "Beside the chart, each day with money moving: what comes in, what goes out, and the balance after. Tap a day to see it in full. Show 30 days looks further.",
      },
      {
        title: "A calmer chart and shorter lists",
        body: "The chart marks paydays only; Show bills brings the bills back. The lists below fold under their count and total, with Unpaid items left open.",
      },
    ],
  },
  {
    id: "2026-11-10.2",
    headline: "Mark this week's debt payment as paid",
    items: [
      {
        title: "This week's payment, on the home page",
        body: "With weekly payments on, the home page shows how much goes to which debt this week, and when. Press We paid it once it is sent, and that debt's balance goes down.",
      },
      {
        title: "Undo if it was a mistake",
        body: "Undo puts the week and the balance back as they were. A card whose balance comes from the bank updates when the bank shows the payment. The Debt page has the same button.",
      },
    ],
  },
  {
    id: "2026-11-10",
    headline: "Debt payments can go out every week",
    items: [
      {
        title: "Weekly avalanche payments",
        body: "Switch the Debt page to Weekly and H2 plans one payment each Friday: the most that is safe that week, never taking checking below your cushion.",
      },
      {
        title: "More each time a debt is paid off",
        body: "When a debt is paid off, its minimum stops and that money joins the weekly payment. The Debt page lists the next 12 payments and your debt-free date.",
      },
    ],
  },
  {
    id: "2026-10-16.6",
    headline: "Report percentages that agree, and imports you can undo",
    items: [
      {
        title: "One percentage, everywhere",
        body: "The Spending tile and the Spending report now share one percentage: each category's share of everything spent in the period, with uncategorized spending shown as its own slice.",
      },
      {
        title: "Import previews first, then asks",
        body: "Uploading a workbook now shows what it would add and replace, bank rows included, and waits for you to confirm. Nothing changes until you say Replace.",
      },
      {
        title: "Import history with Restore",
        body: "Settings › Data lists each import. Restore puts your data back as it was, and tells you first if anything done since would be lost.",
      },
    ],
  },
  {
    id: "2026-10-16.5",
    headline: "Reports keep their period, and safer imports",
    items: [
      {
        title: "A report opens on the period you clicked",
        body: "Open a report from its tile and it shows the same days and total the tile did. The period stays through a reload and Back, and you can still switch to a week, month or year.",
      },
      {
        title: "Reports show Checking today the same way",
        body: "The balance on Reports is the same block as the dashboard: how it was worked out, whether rows are still pending, and Details.",
      },
      {
        title: "Imports stop before writing anything wrong",
        body: "A workbook with a bad amount or a missing sheet is refused with a plain reason, and nothing changes. Restoring an import now brings back everything it touched.",
      },
    ],
  },
  {
    id: "2026-10-16.4",
    headline: "Unclear bank rows, matching a skipped bill, honest failures",
    items: [
      {
        title: "Unclear rows say why",
        body: "A bank row the rules cannot place sits under Unclear on Banking with the bank's own words. When it looks like a bill you skipped, H2 names the bill and offers Match, with Undo.",
      },
      {
        title: "Pages say when they could not load",
        body: "Debts, reports, mapping rules and the forecast now say so and offer Try again instead of showing empty lists or zeros.",
      },
      {
        title: "Owed beside the payoff plan",
        body: "Each Amex card's Owed figure now sits beside the payoff plan's balance and says whether that balance came from the card or was typed in.",
      },
    ],
  },
  {
    id: "2026-10-16.3",
    headline: "The rows behind your balance, and clearer forecast rows",
    items: [
      {
        title: "Every row behind Checking today",
        body: "Details now lists each bank row the balance counts after the reading, says whether it is pending or posted, and links to it. While a row is pending, the figure is called an estimate.",
      },
      {
        title: "Spend rows show what the forecast takes",
        body: "A Weekly or Monthly Spend row now leads with the amount the forecast uses. The item's own amount sits in its Details as a template.",
      },
      {
        title: "A weekly plan, one tap away",
        body: "With no weekly plan, the dashboard says what the forecast assumes and offers Set weekly plan. Nothing is chosen for you.",
      },
      {
        title: "A cleaner forecast chart",
        body: "Labels no longer overlap, and markers show only for paydays, big bills and the day you pick.",
      },
    ],
  },
  {
    id: "2026-10-16.2",
    headline: "One checking balance and a clearer Forecast",
    items: [
      {
        title: "One checking balance, everywhere",
        body: "Every page shows the same Checking today figure and how it was worked out: the bank's last reading plus the rows since. Details shows the evidence behind it.",
      },
      {
        title: "The forecast says where it starts",
        body: "The chart names the day it opens on, what it opens and closes at, and the bank reading behind it. Overview and Forecast now share one view, and the lowest point uses the same words on every page.",
      },
      {
        title: "Weekly and Monthly Spend rows explain themselves",
        body: "Each row says what the forecast takes for it and why. When no weekly plan is set, the row says so and offers a way to set one.",
      },
      {
        title: "The Forecast page, rearranged",
        body: "The chart sits beside the selected day, so a shortfall opens right where you can read it. Items already settled fold away with a count.",
      },
    ],
  },
  {
    id: "2026-10-16",
    headline: "Clearer spending, bank checks and Amex",
    items: [
      {
        title: "Spending counts what we know",
        body: "This week's spending counts only charges that are clearly spending. A charge that may be a bill, a transfer or a loan payment shows apart as unconfirmed until one of you confirms it.",
      },
      {
        title: "Old pending charges stop counting",
        body: "A charge still pending more than a week after its date is a hold that never went through. It stays on the list, marked, but no longer counts toward spending or the plan.",
      },
      {
        title: "Does H2 match the bank?",
        body: "Banking and the dashboard say whether H2's balance matches the bank's. When they differ, Review difference shows what H2 counted and what it can't explain.",
      },
      {
        title: "A Banking page that tells the story",
        body: "Banking opens with the balance and how sure it is, then what wasn't in the plan: unplanned activity, amount differences and timing differences. Money in and money out show apart.",
      },
      {
        title: "One Amex summary for every card",
        body: "Amex opens with one summary: what each card owes, then purchases, payments and credits. Pick a card to see only that card. Each row opens its own Details.",
      },
    ],
  },
];

const KNOWN = new Set(WHATS_NEW.map((u) => u.id));

/** A note H2 has shipped (the server records reads only for these). */
export function isKnownUpdateId(id: string): boolean {
  return KNOWN.has(id);
}

/**
 * What greets this person, and stays in front of them until they press
 * "I've read this": every note from `from` on that they have not read.
 */
export function unreadUpdates(
  updates: readonly WhatsNewUpdate[],
  read: ReadonlySet<string>,
  from: string,
): WhatsNewUpdate[] {
  return updates.filter((u) => u.id >= from && !read.has(u.id));
}

/**
 * Where a person's click starts: `READ_CLICK_FROM`, or the day AFTER they joined
 * the household when that is later — a new member is never handed the notes
 * from before they had H2, and a person made today (a fresh test user) is never
 * greeted by today's note. `joinedDay` is a household calendar day; null when
 * unknown.
 */
export function startFor(joinedDay: string | null): string {
  if (!joinedDay) return READ_CLICK_FROM;
  const next = addDaysISO(joinedDay.slice(0, 10), 1);
  return next > READ_CLICK_FROM ? next : READ_CLICK_FROM;
}

/** "Thursday, October 15" — a note's day. Pure calendar: the same in every timezone. */
export function formatDay(id: string): string {
  const y = Number(id.slice(0, 4));
  const m = Number(id.slice(5, 7));
  const d = Number(id.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The household's day of a read (an instant), as `formatDay` says it. */
export function formatReadDay(readAtIso: string): string {
  return formatDay(householdDateOf(new Date(readAtIso)));
}

export interface WhatsNewReaderLine {
  name: string;
  /** When they pressed "I've read this"; null = not yet. */
  readAt: string | null;
}

/**
 * The owner's lines under one note: "Read by Jen on Thursday, October 15", or
 * "Not read yet" — with the name when the household has more than one other
 * person ("Not read yet by Jen"). No one to read it: no line.
 */
export function readLines(readers: readonly WhatsNewReaderLine[]): string[] {
  return readers.map((r) => {
    if (r.readAt) return `Read by ${r.name} on ${formatReadDay(r.readAt)}`;
    return readers.length > 1 ? `Not read yet by ${r.name}` : "Not read yet";
  });
}
