import type { ReactNode } from "react";
import type { HandoffLink as Link } from "./handoff.ts";

type Props = {
  link: Link;
  className?: string;
  children: ReactNode;
  /** Pressed: the chat is opening, and `copied` says whether the prompt reached the clipboard. */
  onSent: (link: Link, copied: Promise<boolean>) => void;
};

/**
 * The press that hands a deep dive to an outside chat: a real link with the prompt in it, opened in a new tab so DeepRead
 * and the reader's place stay. The prompt is copied in the same press, in case the chat opens empty. Copy only is a button.
 */
export function HandoffLink({ link, className, children, onSent }: Props) {
  const send = () => {
    // Inside the press itself: the clipboard takes a write only from a user gesture.
    const write = navigator.clipboard?.writeText(link.prompt);
    onSent(link, write ? write.then(() => true, () => false) : Promise.resolve(false));
  };
  if (link.href === null) {
    return (
      <button type="button" className={className} onClick={send}>
        {children}
      </button>
    );
  }
  return (
    <a className={className} href={link.href} target="_blank" rel="noopener" onClick={send}>
      {children}
    </a>
  );
}
