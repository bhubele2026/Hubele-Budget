import { db } from "@workspace/db";

/** The pool or an open transaction — both read and write the same way. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

export const ENGINE_ACTOR = "system";
