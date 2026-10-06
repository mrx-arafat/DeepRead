import type { Library } from "./library.ts";
import type { SignedIn } from "./sessions.ts";

/** What app.ts settles for each request before a route runs, read by the routes as `c.var`. */
export type AppEnv = {
  Variables: {
    /** The books of whoever is reading: the one library, or the signed-in profile's own (the viewed one's while the admin views as someone). */
    library: Library;
    /** Who is signed in. Always null without profiles. */
    session: SignedIn | null;
  };
};
