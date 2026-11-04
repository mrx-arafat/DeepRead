import { ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ToggleEvent } from "react";
import { menuOpensAbove } from "../library/BookMenu.tsx";
import { HANDOFF_TARGET_IDS, HANDOFF_TARGETS, type HandoffLink as Link, type HandoffTarget } from "./handoff.ts";
import { HandoffLink } from "./HandoffLink.tsx";
import { HandoffMark } from "./HandoffMark.tsx";

type Props = {
  link: Link;
  /** On the selection bar it reads "Ask ChatGPT"; on an answer card, "Go deeper with ChatGPT". */
  where: "bar" | "card";
  /** The reader picked another chat from the menu: it is remembered and the control names it from now on. */
  onChoose: (target: HandoffTarget) => void;
  onSent: (link: Link, copied: Promise<boolean>) => void;
};

const ITEM = '[role="menuitemradio"]';

/**
 * Open in ChatGPT as one split control: the main part hands the passage to the chat the reader chose last and opens it at
 * once; the chevron lists every chat, the chosen one marked. The menu is a native popover, so it lies over the page in
 * the top layer, clear of the card's own clipping, under the control or above it near the foot of the window, like the
 * shelf menu. Arrow keys move through it, Escape closes it, and a press elsewhere closes it too.
 */
export function HandoffControl({ link, where, onChoose, onSent }: Props) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { name } = HANDOFF_TARGETS[link.target];
  const copyOnly = link.target === "copy";

  useLayoutEffect(() => {
    if (!open) return;
    const panel = menu.current;
    const anchor = root.current;
    if (!panel || !anchor) return;
    const place = () => {
      const at = anchor.getBoundingClientRect();
      const above = menuOpensAbove(at.top, at.bottom, panel.offsetHeight, window.innerHeight);
      // Its right edge on the control's, and never past either side of the window.
      const left = Math.max(12, Math.min(at.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 12));
      panel.style.left = `${left}px`;
      panel.style.top = `${above ? at.top - panel.offsetHeight - 4 : at.bottom + 4}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>(ITEM) ?? [])];
  const showing = () => menu.current?.matches(":popover-open") ?? false;
  const show = () => {
    if (!showing()) menu.current?.showPopover();
  };
  const hide = () => {
    if (showing()) menu.current?.hidePopover();
  };

  function toggled(event: ToggleEvent<HTMLDivElement>) {
    const isOpen = event.newState === "open";
    setOpen(isOpen);
    if (isOpen) (items().find((item) => item.getAttribute("aria-checked") === "true") ?? items()[0])?.focus({ preventScroll: true });
    // Closed from outside (Escape, a press elsewhere) with focus left nowhere: it goes back to the chevron.
    else if (!document.activeElement || document.activeElement === document.body) chevron.current?.focus({ preventScroll: true });
  }

  function choose(target: HandoffTarget) {
    hide();
    onChoose(target);
    // The main part now names the new chat: focus goes there, so the next press opens it.
    root.current?.querySelector<HTMLElement>(".handoff-main")?.focus({ preventScroll: true });
  }

  function onChevronKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    show();
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    // The bar's own Left and Right handling must not run under the menu.
    event.stopPropagation();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown" || event.key === "ArrowRight") go(at + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      hide();
      chevron.current?.focus({ preventScroll: true });
    }
  }

  /** Tabbing out of the menu folds it, like the shelf menu; a press inside it (no related target) does not. */
  function blurred(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget && !menu.current?.contains(event.relatedTarget)) hide();
  }

  return (
    <div ref={root} className="handoff" data-where={where}>
      <HandoffLink link={link} className="handoff-main" onSent={onSent}>
        {where === "card" && !copyOnly && <span className="handoff-lead">Go deeper with</span>}
        <HandoffMark target={link.target} size={where === "bar" ? 16 : 15} />
        <span>{copyOnly ? "Copy prompt" : where === "bar" ? `Ask ${name}` : name}</span>
        {where === "bar" && !copyOnly && <ArrowUpRight size={14} aria-hidden />}
      </HandoffLink>
      <button
        ref={chevron}
        type="button"
        className="handoff-more"
        aria-label="Other chats"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onChevronKey}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      <div ref={menu} id={menuId} className="popover handoff-menu" popover="auto" role="menu" aria-label="Where deep dives open" onToggle={toggled} onKeyDown={onMenuKey} onBlur={blurred}>
        {HANDOFF_TARGET_IDS.map((target) => {
          const chosen = target === link.target;
          const item = HANDOFF_TARGETS[target];
          return (
            <button key={target} type="button" role="menuitemradio" aria-checked={chosen} tabIndex={-1} onClick={() => choose(target)}>
              <HandoffMark target={target} size={18} />
              <span className="handoff-item">
                {item.name}
                {target !== "copy" && !item.open && <small>Copies the prompt, then opens it</small>}
              </span>
              {chosen && <Check size={16} aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
