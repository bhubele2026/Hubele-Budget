import { createContext, useContext } from "react";
import { BELOW_FOLD, type BelowFoldKey } from "./belowFoldSizes";

/**
 * With no bank linked, every lazy panel is a sentence, and a 29rem forecast box
 * around "needs a bank balance" is a page of empty cards. The page knows it
 * from the eager accounts read, before the lazy chunk arrives, so BOTH the
 * skeleton and the real panel drop the fixed minimum height together and stay
 * the same size by construction.
 */
export const CompactFold = createContext(false);

export function useFoldMinH(key: BelowFoldKey): string {
  return useContext(CompactFold) ? "" : BELOW_FOLD[key].minH;
}
