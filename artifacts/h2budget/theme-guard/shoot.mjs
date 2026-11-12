// Whole-page stills of every guard page, headless. Used for the light
// before/after proof and for looking at dark.
//   node theme-guard/shoot.mjs <baseUrl> <outDir> <light|dark> [id,id…]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { PAGES, NOW, TZ, APPEARANCE_KEY, visit, growToFit } from "./pages.mjs";

const [base, out, mode = "light", only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
let bad = 0;
for (const size of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
  for (const p of PAGES) {
    if (only && !only.split(",").includes(p.id)) continue;
    const ctx = await browser.newContext({
      viewport: { width: size.w, height: size.h }, timezoneId: TZ, reducedMotion: "reduce", colorScheme: "light",
      extraHTTPHeaders: { "x-guard-appearance": mode },
    });
    await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [APPEARANCE_KEY, mode]);
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(NOW));
    page.on("pageerror", (e) => { bad++; console.log(`[pageerror] ${p.id}: ${String(e).slice(0, 200)}`); });
    const miss = await visit(page, base, p);
    if (miss) { bad++; console.log(`!! ${size.w} ${p.id}: ${miss}`); }
    await growToFit(page, size.w, size.h);
    await page.screenshot({ path: `${out}/${size.w}-${p.id}.png` });
    await ctx.close();
  }
}
await browser.close();
console.log(bad ? `${bad} problems` : "all pages came up");
process.exit(bad ? 1 : 0);
