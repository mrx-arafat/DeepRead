import { ArrowDown, ArrowUp, AudioWaveform, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import type { Ref } from "react";
import { RATES, setPrefs } from "../prefs.ts";
import type { Listen } from "./useListen.ts";

/** Player controls, pinned to the bottom of the window while listening. */
export function ListenBar({
  listen,
  rate,
  playRef,
  onStop,
}: {
  listen: Listen;
  rate: number;
  playRef: Ref<HTMLButtonElement>;
  onStop: () => void;
}) {
  return (
    <div className="listen-bar" role="region" aria-label="Read aloud">
      {/* Above the controls and out of their flow, so a message never moves the button the reader reaches for. */}
      {(listen.error || listen.away || listen.waiting) && (
        <div className="listen-status">
          {listen.error && (
            <p className="listen-note listen-error" role="alert">
              {listen.error}
            </p>
          )}
          {listen.waiting === "opening" && <p className="listen-note">Opening the next chapter...</p>}
          {listen.waiting === "failed" && (
            <p className="listen-note">
              The next chapter did not open. Reading goes on when it does.{" "}
              <button type="button" className="link-button" onClick={listen.retry}>
                Try again
              </button>
            </p>
          )}
          {listen.away && (
            <button type="button" className="listen-back" onClick={listen.showSentence}>
              {listen.away === "above" ? <ArrowUp size={16} aria-hidden /> : <ArrowDown size={16} aria-hidden />}
              Back to the sentence being read
            </button>
          )}
        </div>
      )}
      <div className="listen-controls">
        {/* Icons alone, to fit a phone; the titles name them for a mouse reader, the labels for a screen reader. */}
        <button type="button" className="icon-button" aria-label="Previous sentence" title="Previous sentence" onClick={listen.previous}>
          <SkipBack size={18} aria-hidden />
        </button>
        <button
          ref={playRef}
          type="button"
          className="icon-button listen-play"
          aria-label={listen.playing ? "Pause" : "Play"}
          title={listen.playing ? "Pause" : "Play"}
          onClick={listen.toggle}
        >
          {listen.playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
        </button>
        <button type="button" className="icon-button" aria-label="Next sentence" title="Next sentence" onClick={listen.next}>
          <SkipForward size={18} aria-hidden />
        </button>
        <label className="listen-rate">
          <span className="visually-hidden">Speed</span>
          <select value={rate} title="Reading speed" onChange={(event) => setPrefs({ rate: Number(event.target.value) })}>
            {RATES.map((value) => (
              <option key={value} value={value}>
                {value}x
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="icon-button" aria-label="Voice settings" title="Voice settings" popoverTarget="reading-voice">
          <AudioWaveform size={18} aria-hidden />
        </button>
        <button type="button" className="icon-button" aria-label="Stop listening" title="Stop listening" onClick={onStop}>
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
