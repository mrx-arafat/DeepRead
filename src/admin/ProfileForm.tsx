import { Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { AVATAR_PRESETS } from "../../shared/types.ts";
import type { AdminProfile, AvatarPreset } from "../../shared/types.ts";
import { Avatar } from "../profiles/Avatar.tsx";
import { AvatarPicker } from "./AvatarPicker.tsx";
import { MAX_CODE_CHARS, MIN_CODE_CHARS, PHOTO_TYPES, codeProblemFor, photoProblem, reason } from "./profileText.ts";

// The same limit the server enforces, so the form never lets the admin type what would be refused.
const MAX_NAME_CHARS = 40;
const MAX_BADGE_CHARS = 20;

/** What the form hands over on Save. An empty code means "keep the current one" when editing. */
export type ProfileInput = {
  name: string;
  code: string;
  preset: AvatarPreset;
  /** Empty for none (the admin's is then "Admin"). */
  badge: string;
  photo: File | null;
  removePhoto: boolean;
};

type Props = {
  /** The profile being edited; null while a new one is added. */
  profile: AdminProfile | null;
  saving: boolean;
  onSave: (input: ProfileInput) => Promise<void>;
  onClose: () => void;
};

export function ProfileForm({ profile, saving, onSave, onClose }: Props) {
  const nameId = useId();
  const nameErrorId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const codeErrorId = useId();
  const badgeId = useId();
  const badgeHintId = useId();
  const photoHintId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(profile?.name ?? "");
  const [code, setCode] = useState("");
  const [badge, setBadge] = useState(profile?.badge ?? "");
  const [preset, setPreset] = useState<AvatarPreset>(profile?.avatar.preset ?? AVATAR_PRESETS[0]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Nothing is called wrong before the first Save: a new profile's empty fields are not mistakes yet.
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The admin's code is ADMIN_PASSKEY in .env, which the server will not change from here.
  const codeIsPasskey = profile?.admin === true;
  const hasPhoto = profile !== null && profile.avatar.photo !== null;
  const nameProblem = name.trim() === "" ? "The name cannot be empty. Type a name for this profile." : null;
  const codeProblem = codeIsPasskey || (profile !== null && code === "") ? null : codeProblemFor(code, profile === null);
  const showCodeProblem = tried && codeProblem !== null;

  useEffect(() => {
    nameInput.current?.focus();
    nameInput.current?.setSelectionRange(0, 0);
  }, []);

  // A preview of the chosen photo, released when another is chosen or the form closes.
  useEffect(() => {
    if (!photo) {
      setPhotoUrl(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so that choosing the same file again, after fixing it, still counts as a change.
    event.target.value = "";
    if (!file) return;
    const problem = photoProblem(file);
    setPhotoError(problem);
    if (problem) return;
    setPhoto(file);
    setRemovePhoto(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setTried(true);
    if (nameProblem) {
      nameInput.current?.focus();
      return;
    }
    if (codeProblem) {
      codeInput.current?.focus();
      return;
    }
    const trimmed = name.trim();
    const unchanged = profile && trimmed === profile.name && code === "" && preset === profile.avatar.preset;
    if (unchanged && badge.trim() === (profile.badge ?? "") && !photo && !removePhoto) {
      onClose();
      return;
    }
    setError(null);
    setPhotoError(null);
    try {
      await onSave({ name: trimmed, code, preset, badge: badge.trim(), photo, removePhoto });
      onClose();
    } catch (err) {
      setError(reason(err, "Your changes could not be saved. Please try again."));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // Escape also ends an input-method composition (Bangla typing); that must not close the form.
    if (event.key === "Escape" && !saving && !event.nativeEvent.isComposing) onClose();
  }

  return (
    <form
      className="shelf-edit"
      aria-label={profile ? `Edit ${profile.name}` : "Add a profile"}
      // The browser's own "fill out this field" bubble would stand in for the sentence shown under the field.
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={handleKeyDown}
    >
      <div className="shelf-field">
        <label htmlFor={nameId}>Name</label>
        <input
          ref={nameInput}
          id={nameId}
          value={name}
          maxLength={MAX_NAME_CHARS}
          aria-required
          aria-invalid={tried && nameProblem !== null}
          aria-describedby={tried && nameProblem ? nameErrorId : undefined}
          readOnly={saving}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        {tried && nameProblem && (
          <p id={nameErrorId} className="inline-error" role="alert">
            {nameProblem}
          </p>
        )}
      </div>

      {codeIsPasskey ? (
        <div className="shelf-field">
          <span className="admin-label">Code</span>
          <p className="admin-hint">
            The admin&apos;s code is ADMIN_PASSKEY in the .env file. To change it, edit .env and restart DeepRead.
          </p>
        </div>
      ) : (
        <div className="shelf-field">
          <label htmlFor={codeId}>
            Code {profile && <span className="shelf-optional">(optional)</span>}
          </label>
          <input
            ref={codeInput}
            id={codeId}
            type="password"
            value={code}
            aria-required={profile === null}
            aria-invalid={showCodeProblem}
            aria-describedby={showCodeProblem ? `${codeHintId} ${codeErrorId}` : codeHintId}
            readOnly={saving}
            autoComplete="new-password"
            onChange={(event) => setCode(event.target.value)}
          />
          <p id={codeHintId} className="admin-hint">
            {profile
              ? "Leave empty to keep the current code. A new code signs this profile out everywhere."
              : `${MIN_CODE_CHARS} to ${MAX_CODE_CHARS} characters. This is what they type to open their profile.`}
          </p>
          {showCodeProblem && (
            <p id={codeErrorId} className="inline-error" role="alert">
              {codeProblem}
            </p>
          )}
        </div>
      )}

      <div className="shelf-field">
        <label htmlFor={badgeId}>
          Badge <span className="shelf-optional">(optional)</span>
        </label>
        <input
          id={badgeId}
          value={badge}
          maxLength={MAX_BADGE_CHARS}
          aria-describedby={badgeHintId}
          readOnly={saving}
          autoComplete="off"
          onChange={(event) => setBadge(event.target.value)}
        />
        <p id={badgeHintId} className="admin-hint">
          {profile?.admin
            ? 'A small label beside the name on the profile list. Leave empty to show "Admin".'
            : "A small label beside the name on the profile list, such as Editor or Kid. Leave empty for none."}
        </p>
      </div>

      <fieldset className="admin-picture" disabled={saving}>
        <legend>Picture</legend>
        <AvatarPicker value={preset} onChange={setPreset} />
        {profile && (
          <div className="admin-photo">
            {photoUrl ? (
              <img className="admin-photo-thumb" src={photoUrl} alt="" />
            ) : (
              hasPhoto && !removePhoto && <Avatar profile={profile} size={56} />
            )}
            <div className="admin-photo-body">
              <input
                ref={fileInput}
                type="file"
                accept={PHOTO_TYPES.join(",")}
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden
                onChange={choosePhoto}
              />
              <button
                type="button"
                className="quiet-button"
                aria-describedby={photoHintId}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={16} aria-hidden /> {hasPhoto || photo ? "Replace photo" : "Upload a photo"}
              </button>
              <p id={photoHintId} className="admin-hint">
                {photo
                  ? `${photo.name} is saved when you press Save.`
                  : "A PNG, JPEG or WebP, up to 5 MB. A photo shows instead of the picture above."}
              </p>
              {photoError && (
                <p className="inline-error" role="alert">
                  {photoError}
                </p>
              )}
              {hasPhoto && !photo && (
                <label className="admin-check">
                  <input type="checkbox" checked={removePhoto} onChange={(event) => setRemovePhoto(event.target.checked)} />
                  Remove photo
                </label>
              )}
            </div>
          </div>
        )}
      </fieldset>

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="shelf-edit-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? "Saving..." : profile ? "Save" : "Add profile"}
        </button>
        <button type="button" className="quiet-button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
