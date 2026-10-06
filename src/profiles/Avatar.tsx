import { useState } from "react";
import type { CSSProperties } from "react";
import type { PublicProfile } from "../../shared/types.ts";
import { PresetArt } from "./avatars.tsx";

// Anyone who draws a picture imports from here, whether it is a profile's or a built-in one in a list to choose from.
export { PresetArt };

/**
 * A profile's picture: its uploaded photo while it has one, else its built-in picture. The picture is decorative (the
 * name is always written beside it). `size` is a starting size in px; a page that needs the picture to grow or shrink
 * sizes the box around it in CSS, and the picture follows.
 */
export function Avatar({ profile, size }: { profile: Pick<PublicProfile, "id" | "name" | "avatar">; size: number }) {
  const { id, avatar } = profile;
  // The photo that failed to load, not just "a failure": a new upload has a new address and gets its own try.
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const photo = avatar.photo !== null && avatar.photo !== failedPhoto ? avatar.photo : null;

  return (
    <span className="avatar" style={{ "--avatar-size": `${size}px` } as CSSProperties}>
      {photo !== null ? (
        <img
          className="avatar-photo"
          src={`/api/profiles/${encodeURIComponent(id)}/avatar?v=${encodeURIComponent(photo)}`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedPhoto(photo)}
        />
      ) : (
        <PresetArt preset={avatar.preset} />
      )}
    </span>
  );
}
