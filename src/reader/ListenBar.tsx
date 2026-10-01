import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { setPrefs } from "../prefs.ts";
import type { Listen } from "./useListen.ts";

const RATES = [0.8, 1, 1.2, 1.5];

/** Player controls, pinned to the bottom of the window while listening. */
export function ListenBar({ listen, rate }: { listen: Listen; rate: number }) {
  return (
    <div className="listen-bar" role="region" aria-label="Read aloud">
      {listen.error && <p className="inline-error">{listen.error}</p>}
      <div className="listen-controls">
        <button type="button" className="icon-button" aria-label="Previous sentence" onClick={listen.previous}>
          <SkipBack size={18} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-button listen-play"
          aria-label={listen.playing ? "Pause" : "Play"}
          onClick={listen.toggle}
        >
          {listen.playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
        </button>
        <button type="button" className="icon-button" aria-label="Next sentence" onClick={listen.next}>
          <SkipForward size={18} aria-hidden />
        </button>
        <label className="listen-rate">
          <span className="visually-hidden">Speed</span>
          <select value={rate} onChange={(event) => setPrefs({ rate: Number(event.target.value) })}>
            {RATES.map((value) => (
              <option key={value} value={value}>
                {value}x
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="icon-button" aria-label="Stop listening" onClick={listen.stop}>
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
