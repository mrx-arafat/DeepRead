import { ArrowLeftRight, ChevronDown, LogOut, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";
import { Link } from "wouter";
import type { Session } from "../../shared/types.ts";
import { Avatar } from "./Avatar.tsx";
import { useSession } from "./session.tsx";

/**
 * Who is reading, in the corner of the library, and what that reader can do about it: pick someone else, or open the
 * admin page. A disclosure like the book menu's: its items follow the button in tab order, and Escape, a click elsewhere
 * or tabbing away folds them back in. The stylesheet lays it over the page's top margin.
 */
export function ProfileMenu({ session }: { session: Session }) {
  const { signOut, startChoosing } = useSession();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { profile } = session;

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    trigger.current?.focus();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    // Safari does not focus a button when it is pressed, so a null target is a press inside the panel, not Tab leaving.
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false);
  }

  async function leave() {
    setLeaving(true);
    setError(null);
    try {
      // Shows the profiles, and this page goes with it.
      await signOut();
    } catch (err) {
      setError(err instanceof Error ? err.message : "You could not be signed out. Please try again.");
      setLeaving(false);
    }
  }

  return (
    <div className="profile-menu" ref={root} onKeyDown={handleKeyDown} onBlur={handleBlur}>
      <button
        ref={trigger}
        type="button"
        className="profile-menu-button"
        aria-label={`${profile.name}, profile menu`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Avatar profile={profile} size={32} />
        <span className="profile-menu-name">{profile.name}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="profile-menu-panel" id={panelId}>
          {/* Looks at the profiles but stays signed in: choosing oneself again asks for nothing. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              startChoosing();
            }}
          >
            <ArrowLeftRight size={18} aria-hidden /> Switch profile
          </button>
          <button type="button" disabled={leaving} onClick={() => void leave()}>
            <LogOut size={18} aria-hidden /> Sign out
          </button>
          {session.admin && (
            <Link href="/admin" onClick={() => setOpen(false)}>
              <ShieldCheck size={18} aria-hidden /> Admin
            </Link>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
