import { useId } from "react";
import { AVATAR_PRESETS } from "../../shared/types.ts";
import type { AvatarPreset } from "../../shared/types.ts";
import { PresetArt } from "../profiles/Avatar.tsx";

/** What a screen reader says for each picture. A picture added to AVATAR_PRESETS without a name here fails to compile. */
const NAMES: Record<AvatarPreset, string> = {
  "smile-blue": "Blue smile",
  "smile-amber": "Amber smile",
  "shades-teal": "Teal sunglasses",
  "cat-rose": "Rose cat",
  "owl-violet": "Violet owl",
  "robot-mint": "Mint robot",
  "star-coral": "Coral star",
  "moon-navy": "Navy moon",
};

type Props = {
  value: AvatarPreset;
  onChange: (preset: AvatarPreset) => void;
};

/**
 * The built-in pictures as one group of radio buttons, so the arrow keys move between them and Tab leaves the group.
 * The buttons are the browser's own, hidden behind their tile: the tile shows which one is chosen and where focus is.
 */
export function AvatarPicker({ value, onChange }: Props) {
  const group = useId();
  return (
    <div className="admin-tiles">
      {AVATAR_PRESETS.map((preset) => (
        <label key={preset} className="admin-tile">
          <input
            type="radio"
            className="visually-hidden"
            name={group}
            value={preset}
            checked={value === preset}
            onChange={() => onChange(preset)}
          />
          <span className="admin-tile-art" aria-hidden>
            <PresetArt preset={preset} />
          </span>
          <span className="visually-hidden">{NAMES[preset]}</span>
        </label>
      ))}
    </div>
  );
}
