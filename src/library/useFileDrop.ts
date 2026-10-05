import { useEffect, useEffectEvent, useState } from "react";

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

/** Lets a file be dropped anywhere on the page. `dragging` is true while one is over it; `onFile` gets the first one dropped. */
export function useFileDrop(onFile: (file: File | undefined) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const received = useEffectEvent(onFile);

  useEffect(() => {
    // A drag enters and leaves every element it passes over, so only when every one it entered has been left is it off the page.
    let inside = 0;
    const enter = (event: DragEvent) => {
      if (carriesFiles(event)) inside += 1;
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser opens the file in the tab instead of handing it to the page.
      event.preventDefault();
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      inside = Math.max(0, inside - 1);
      if (inside === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      inside = 0;
      setDragging(false);
      received(event.dataTransfer?.files[0]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return dragging;
}
