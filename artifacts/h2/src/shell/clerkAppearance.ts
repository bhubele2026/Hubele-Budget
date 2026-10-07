/**
 * Clerk's sign-in, sign-up and account widgets, dressed in the H2 tokens.
 *
 * Every colour points at a CSS variable from styles/index.css, so the front
 * door moves with the palette. `cssLayerName: "clerk"` puts Clerk's own styles
 * in the `clerk` layer, beneath our utilities, so a class here always wins.
 *
 * ⚠️ The primary button's label is set by class as well as by variable:
 * Clerk derives readable label colours in JS and cannot parse a `var(…)`, so
 * `colorPrimaryForeground` alone may be ignored (the classic app shipped an
 * ink-on-navy "Continue" at 1.2:1 that way). Paper on moss is 7.1:1.
 */
export const clerkAppearance = {
  cssLayerName: "clerk",
  options: {
    logoPlacement: "none" as const,
  },
  variables: {
    colorPrimary: "var(--color-moss)",
    colorPrimaryForeground: "var(--color-paper-0)",
    colorForeground: "var(--color-ink)",
    colorMutedForeground: "var(--color-ink-2)",
    colorMuted: "var(--color-paper-1)",
    colorDanger: "var(--color-clay)",
    colorSuccess: "var(--color-moss)",
    colorWarning: "var(--color-ochre)",
    colorBackground: "var(--color-paper-0)",
    colorInput: "var(--color-paper-0)",
    colorInputForeground: "var(--color-ink)",
    colorNeutral: "var(--color-ink)",
    colorBorder: "var(--color-rule)",
    colorRing: "var(--color-moss)",
    colorShadow: "transparent",
    fontFamily: "var(--font-sans)",
    fontFamilyButtons: "var(--font-sans)",
    borderRadius: "4px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "!shadow-none border border-rule rounded-3 w-[420px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !rounded-none bg-paper-0",
    footer: "!shadow-none !border-0 !rounded-none bg-paper-1",
    formButtonPrimary: "!text-paper-0 !shadow-none",
    headerTitle: "type-headline text-ink",
    headerSubtitle: "type-body text-ink-2",
    socialButtonsBlockButton: "!shadow-none border border-rule-strong",
    formFieldInput: "!shadow-none",
    footerActionLink: "text-moss",
    userButtonPopoverCard: "!shadow-none border border-rule rounded-2",
  },
};
