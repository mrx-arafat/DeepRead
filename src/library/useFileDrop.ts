import { useEffect, useEffectEvent, useState } from "react";

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

/** Receives page-wide file drops while enabled. */
export function useFileDrop(onFiles: (files: FileList) => void, enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false);
  const received = useEffectEvent(onFiles);

  useEffect(() => {
    if (!enabled) setDragging(false);
    // A drag enters and leaves every element it passes over, so only when every one it entered has been left is it off the page.
    let inside = 0;
    const enter = (event: DragEvent) => {
      if (carriesFiles(event)) inside += 1;
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser opens the file in the tab instead of handing it to the page.
      event.preventDefault();
      if (enabled) setDragging(true);
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
      const files = event.dataTransfer?.files;
      if (enabled && files?.length) received(files);
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
  }, [enabled]);

  return dragging;
}
