import { Check, ChevronDown, Moon, Sun, Sunset } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { setPrefs, usePrefs } from "../prefs.ts";

const themes = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "sepia", label: "Sepia", Icon: Sunset },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

/** A compact, keyboard-accessible disclosure for the library's color theme. */
export function AppearanceMenu(): ReactElement {
  const { theme } = usePrefs();
  const root = useRef<HTMLDetailsElement>(null);
  const Icon = themes.find(option => option.value === theme)?.Icon ?? Sun;

  useEffect(() => {
    function closeOutside(event: PointerEvent): void {
      if (root.current && !root.current.contains(event.target as Node)) root.current.open = false;
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return (
    <details className="library-appearance" ref={root}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={event => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}>
      <summary title="Appearance"><Icon size={18} aria-hidden /><span className="visually-hidden">Appearance</span><ChevronDown size={14} aria-hidden /></summary>
      <fieldset className="dashboard-theme">
        <legend className="visually-hidden">Color theme</legend>
        {themes.map(({ value, label, Icon: ThemeIcon }) => (
          <label key={value}>
            <input type="radio" name="dashboard-theme" value={value} checked={theme === value} onChange={() => setPrefs({ theme: value })} />
            <ThemeIcon size={17} aria-hidden /><span>{label}</span>
            {theme === value && <Check size={16} aria-hidden />}
          </label>
        ))}
      </fieldset>
    </details>
  );
}
