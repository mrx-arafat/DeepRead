import { ArrowLeft, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import type { AdminProfile, AiStatus, ProfileUpdate, Session } from "../../shared/types.ts";
import { api } from "../api.ts";
import { useSession } from "../profiles/session.tsx";
import { AdminApiModel } from "./AdminApiModel.tsx";
import { AiRequestsInbox } from "./AiRequestsInbox.tsx";
import { useAiRequests } from "./useAiRequests.ts";
import { AdminShares } from "./AdminShares.tsx";
import { AiAccessDialog } from "./AiAccessDialog.tsx";
import { ProfileDialog } from "./ProfileDialog.tsx";
import type { ProfileInput } from "./ProfileForm.tsx";
import { reason } from "./profileText.ts";
import { ProfileRow } from "./ProfileRow.tsx";

/** The one thing that is open: the form to add a profile or edit one, or a row asking to confirm its removal. */
type Active = { kind: "add" } | { kind: "edit"; id: string } | { kind: "ai"; id: string } | { kind: "delete"; id: string; error: string | null };

/** What `pending` holds while a profile is being added, or while the admin returns from reading as someone. */
const ADDING = "adding";
const RETURNING = "returning";
/** What `pending` holds while a profile is being signed out everywhere: apart from its id, which an edit or a removal uses. */
const signingOutKey = (id: string) => `sign-out:${id}`;

/** The admin's page: every profile with what it holds, and the means to add, change, remove or read as one. */
export function AdminDashboard({ session }: { session: Session }) {
  const [, navigate] = useLocation();
  const { setSession, retry } = useSession();
  const [profiles, setProfiles] = useState<AdminProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Why a profile could not be signed out everywhere, shown on its own row.
  const [signOutError, setSignOutError] = useState<{ id: string; message: string } | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  // The id of the profile whose request is running, or ADDING, RETURNING or a signingOutKey. Everything else waits for it.
  const [pending, setPending] = useState<string | null>(null);
  // Said aloud once a change is done, as the list changing under a screen reader's cursor says nothing by itself.
  const [announcement, setAnnouncement] = useState("");
  // Set once a removed row's focus needs a new home: the Add button, which is disabled until the removal has settled.
  const [focusAdd, setFocusAdd] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // What this server can answer with, as the admin sees it: fetched when the page opens, when the key or model changes, and
  // when the AI dialog opens, so it is current.
  const [helpers, setHelpers] = useState<AiStatus | null>(null);
  // What readers have asked for. Looked at again every few seconds, so a request made after this page opened still shows.
  const { requests, refresh: refreshRequests } = useAiRequests(15_000);

  function loadHelpers() {
    api
      .aiStatus()
      .then(setHelpers)
      .catch(() => {});
  }
  useEffect(loadHelpers, []);

  // A request that came in while the page was open puts its name on the profile's row at once, without loading the list again.
  useEffect(() => {
    setProfiles(
      (all) =>
        all?.map((profile) => {
          const asked = requests.filter((request) => request.profile.id === profile.id).map((request) => request.helper);
          return asked.join() === profile.aiRequested.join() ? profile : { ...profile, aiRequested: asked };
        }) ?? null,
    );
  }, [requests]);

  // The tab says how many are waiting, for the admin who is on another one.
  useEffect(() => {
    // After AdminPage has set its own title, which it does once the page has mounted.
    const timer = window.setTimeout(() => {
      document.title = `${requests.length > 0 ? `(${requests.length}) ` : ""}Admin - DeepRead`;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [requests.length]);

  /** A profile as it is now (after a helper was given or taken back, or a request turned down): the row shows it, and the requests are looked at again. */
  function profileChanged(updated: AdminProfile) {
    setProfiles((all) => all?.map((one) => (one.id === updated.id ? updated : one)) ?? null);
    void refreshRequests();
  }

  useEffect(() => {
    // `current` drops the answer of a request the admin has already replaced by pressing "Try again".
    let current = true;
    setLoadError(null);
    api
      .adminProfiles()
      .then((list) => current && setProfiles(list))
      .catch((err: Error) => current && setLoadError(err.message));
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!focusAdd || pending !== null) return;
    addButton.current?.focus();
    setFocusAdd(false);
  }, [focusAdd, pending]);

  const editing = active?.kind === "edit" ? profiles?.find((profile) => profile.id === active.id) : undefined;
  const givingAi = active?.kind === "ai" ? profiles?.find((profile) => profile.id === active.id) : undefined;

  async function openAi(profile: AdminProfile): Promise<void> {
    setError(null);
    try {
      setHelpers(await api.aiStatus());
      setActive({ kind: "ai", id: profile.id });
    } catch (err) {
      setError(reason(err, "The AI helpers could not be looked up. Please try again."));
    }
  }

  /** The session holds a copy of the profile being read as, which a change or a removal here has just made old. */
  function refreshSessionIfShown(id: string) {
    if (id === session.profile.id || id === session.impersonatedBy?.id) retry();
  }

  /** Rejects with the server's message, which the form shows and keeps itself open for. */
  async function save(profile: AdminProfile | null, input: ProfileInput): Promise<void> {
    setPending(profile?.id ?? ADDING);
    try {
      if (profile === null) {
        await api.createProfile({ name: input.name, code: input.code, preset: input.preset, ...(input.badge && { badge: input.badge }) });
      } else {
        // The photo first: sending it again after a failure changes nothing, while a new code signs the profile out everywhere.
        if (input.photo) await api.uploadProfilePhoto(profile.id, input.photo);
        else if (input.removePhoto) await api.removeProfilePhoto(profile.id);
        const update: ProfileUpdate = {};
        if (input.name !== profile.name) update.name = input.name;
        if (input.code !== "") update.code = input.code;
        if (input.preset !== profile.avatar.preset) update.preset = input.preset;
        if (input.badge !== (profile.badge ?? "")) update.badge = input.badge;
        if (Object.keys(update).length > 0) await api.updateProfile(profile.id, update);
        refreshSessionIfShown(profile.id);
      }
      setAnnouncement(profile === null ? `Added ${input.name}.` : `Saved ${input.name}.`);
      setAttempt((n) => n + 1);
    } finally {
      setPending(null);
    }
  }

  async function remove(profile: AdminProfile): Promise<void> {
    setActive({ kind: "delete", id: profile.id, error: null });
    setPending(profile.id);
    try {
      await api.deleteProfile(profile.id);
      setProfiles((all) => all?.filter((one) => one.id !== profile.id) ?? null);
      setActive(null);
      setAnnouncement(`Deleted ${profile.name}.`);
      // The row the admin was on is gone, and focus would fall to the page: hand it to the one button that is always here.
      setFocusAdd(true);
      refreshSessionIfShown(profile.id);
    } catch (err) {
      setActive({ kind: "delete", id: profile.id, error: reason(err, `${profile.name} could not be deleted. Please try again.`) });
    } finally {
      setPending(null);
    }
  }

  async function signOutEverywhere(profile: AdminProfile): Promise<void> {
    setSignOutError(null);
    setPending(signingOutKey(profile.id));
    try {
      await api.signOutProfile(profile.id);
      setAnnouncement(`${profile.name} is signed out on every device.`);
      refreshSessionIfShown(profile.id);
    } catch (err) {
      setSignOutError({ id: profile.id, message: reason(err, `${profile.name} could not be signed out. Please try again.`) });
    } finally {
      setPending(null);
    }
  }

  async function readAs(profile: AdminProfile): Promise<void> {
    setError(null);
    setPending(profile.id);
    try {
      setSession(await api.impersonate(profile.id));
      navigate("/");
    } catch (err) {
      setError(reason(err, `${profile.name}'s library could not be opened. Please try again.`));
    } finally {
      setPending(null);
    }
  }

  async function stopReading(): Promise<void> {
    setError(null);
    setPending(RETURNING);
    try {
      setSession(await api.stopImpersonating());
    } catch (err) {
      setError(reason(err, "Could not switch back to the admin. Please try again."));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const onlyAdmin = profiles !== null && profiles.every((profile) => profile.admin);
  return (
    <main className="admin">
      <header className="admin-head">
        <div className="admin-title">
          <Link href="/" className="admin-home" aria-label="Back to the library" title="Back to the library">
            <ArrowLeft size={20} aria-hidden />
          </Link>
          <h1>Profiles</h1>
        </div>
        <button ref={addButton} type="button" className="button" disabled={busy} onClick={() => setActive({ kind: "add" })}>
          <UserPlus size={18} aria-hidden /> Add a profile
        </button>
      </header>

      {session.impersonatedBy && (
        <div className="admin-viewing">
          <p>
            You are reading as <strong>{session.profile.name}</strong>. Anything you change in their library is changed for them.
          </p>
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void stopReading()}>
            {pending === RETURNING ? "Switching..." : `Back to ${session.impersonatedBy.name}`}
          </button>
        </div>
      )}

      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      {error && (
        <p className="inline-error admin-error" role="alert">
          {error}
        </p>
      )}

      {loadError && (
        <div className="library-retry">
          <p className="inline-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="quiet-button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      <AiRequestsInbox
        requests={requests}
        ready={Object.fromEntries(helpers?.providers.map((one) => [one.id, one.installed]) ?? [])}
        onChanged={profileChanged}
        onAnnounce={setAnnouncement}
      />

      {profiles === null && !loadError && <p className="admin-quiet">Loading profiles...</p>}

      {profiles && (
        <>
          <ul className="admin-list" aria-label="Profiles">
            {profiles.map((profile) => {
              const mine = active?.kind === "delete" && active.id === profile.id ? active : null;
              return (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  mode={mine ? "delete" : "view"}
                  busy={busy}
                  removing={pending === profile.id}
                  signingOut={pending === signingOutKey(profile.id)}
                  deleteError={mine?.error ?? null}
                  signOutError={signOutError?.id === profile.id ? signOutError.message : null}
                  onRead={() => void readAs(profile)}
                  onEdit={() => setActive({ kind: "edit", id: profile.id })}
                  onAi={() => void openAi(profile)}
                  onSignOut={() => void signOutEverywhere(profile)}
                  onAskDelete={() => setActive({ kind: "delete", id: profile.id, error: null })}
                  onKeep={() => setActive(null)}
                  onDelete={() => void remove(profile)}
                />
              );
            })}
          </ul>
          {onlyAdmin && (
            <p className="admin-empty">
              Only the admin has a profile so far. Add one for each person who reads here, and they pick it on the “Who&apos;s
              reading?” page.
            </p>
          )}
          {!onlyAdmin && <AdminShares changed={profiles} />}
          <AdminApiModel profiles={profiles} onProfileChanged={profileChanged} onChanged={loadHelpers} />
        </>
      )}

      {active?.kind === "add" && (
        <ProfileDialog profile={null} saving={pending === ADDING} onSave={(input) => save(null, input)} onClose={() => setActive(null)} />
      )}
      {givingAi && helpers && (
        <AiAccessDialog
          profile={givingAi}
          helpers={helpers}
          onChange={profileChanged}
          onClose={() => setActive(null)}
        />
      )}
      {editing && (
        <ProfileDialog
          profile={editing}
          saving={pending === editing.id}
          onSave={(input) => save(editing, input)}
          onClose={() => setActive(null)}
        />
      )}
    </main>
  );
}
