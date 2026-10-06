import type { ReactNode } from "react";
import type { AvatarPreset } from "../../shared/types.ts";

// Every picture is flat shapes on a full square of colour, with no ids or text, so many can sit on one page and the
// profile name beside each one is the only label it needs.
const ART: Record<AvatarPreset, ReactNode> = {
  "smile-blue": (
    <>
      <rect width="100" height="100" fill="#3f7fd6" />
      <circle cx="50" cy="52" r="31" fill="#fff3d1" />
      <circle cx="40" cy="46" r="3.6" fill="#1b2a49" />
      <circle cx="60" cy="46" r="3.6" fill="#1b2a49" />
      <circle cx="31" cy="57" r="4.5" fill="#ffb7a3" />
      <circle cx="69" cy="57" r="4.5" fill="#ffb7a3" />
      <path d="M39 59 Q50 70 61 59" fill="none" stroke="#1b2a49" strokeWidth="3.5" strokeLinecap="round" />
    </>
  ),
  "smile-amber": (
    <>
      <rect width="100" height="100" fill="#f1a23a" />
      <circle cx="50" cy="50" r="32" fill="#fff6dc" />
      <path d="M34 47 Q39 39 44 47" fill="none" stroke="#5b3512" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M56 47 Q61 39 66 47" fill="none" stroke="#5b3512" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M35 57 Q50 79 65 57 Z" fill="#5b3512" strokeLinejoin="round" stroke="#5b3512" strokeWidth="2" />
      <path d="M43 68 Q50 62 57 68 Q50 74 43 68 Z" fill="#f08a7a" />
    </>
  ),
  "shades-teal": (
    <>
      <rect width="100" height="100" fill="#1b9a8c" />
      <circle cx="50" cy="52" r="31" fill="#ffe2bf" />
      <rect x="27" y="41" width="20" height="14" rx="6" fill="#14303a" />
      <rect x="53" y="41" width="20" height="14" rx="6" fill="#14303a" />
      <path d="M47 46 H53 M27 44 L22 42 M73 44 L78 42" fill="none" stroke="#14303a" strokeWidth="3" strokeLinecap="round" />
      <path d="M31 46 L35 43 M57 46 L61 43" fill="none" stroke="#ffffff" strokeOpacity="0.4" strokeWidth="2" strokeLinecap="round" />
      <path d="M40 64 Q52 72 62 62" fill="none" stroke="#14303a" strokeWidth="3.5" strokeLinecap="round" />
    </>
  ),
  "cat-rose": (
    <>
      <rect width="100" height="100" fill="#e4577a" />
      <polygon points="24,44 27,16 47,30" fill="#fff0e6" />
      <polygon points="76,44 73,16 53,30" fill="#fff0e6" />
      <polygon points="29,36 30,24 40,31" fill="#f7a8bb" />
      <polygon points="71,36 70,24 60,31" fill="#f7a8bb" />
      <circle cx="50" cy="56" r="29" fill="#fff0e6" />
      <ellipse cx="39" cy="53" rx="3.5" ry="4.6" fill="#3a1f2b" />
      <ellipse cx="61" cy="53" rx="3.5" ry="4.6" fill="#3a1f2b" />
      <polygon points="46,61 54,61 50,66" fill="#d9456a" strokeLinejoin="round" stroke="#d9456a" strokeWidth="1.5" />
      <path d="M43 70 Q46.5 74 50 70 Q53.5 74 57 70" fill="none" stroke="#3a1f2b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 62 L15 58 M30 67 L15 70 M70 62 L85 58 M70 67 L85 70" fill="none" stroke="#3a1f2b" strokeOpacity="0.65" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  "owl-violet": (
    <>
      <rect width="100" height="100" fill="#7a5cd1" />
      <polygon points="25,34 27,12 44,24" fill="#c9a56b" />
      <polygon points="75,34 73,12 56,24" fill="#c9a56b" />
      <ellipse cx="50" cy="57" rx="30" ry="34" fill="#c9a56b" />
      <ellipse cx="50" cy="71" rx="17" ry="18" fill="#ecd9b0" />
      <path d="M43 66 Q46 69 49 66 M51 66 Q54 69 57 66 M43 76 Q46 79 49 76 M51 76 Q54 79 57 76" fill="none" stroke="#c9a56b" strokeWidth="2" strokeLinecap="round" />
      <circle cx="37" cy="46" r="12" fill="#ffffff" stroke="#3b2a78" strokeWidth="3" />
      <circle cx="63" cy="46" r="12" fill="#ffffff" stroke="#3b2a78" strokeWidth="3" />
      <circle cx="38.5" cy="47" r="5" fill="#2a1d5c" />
      <circle cx="61.5" cy="47" r="5" fill="#2a1d5c" />
      <polygon points="45,53 55,53 50,62" fill="#f5a524" strokeLinejoin="round" stroke="#f5a524" strokeWidth="2" />
    </>
  ),
  "robot-mint": (
    <>
      <rect width="100" height="100" fill="#4fc3a1" />
      <path d="M50 27 V15" fill="none" stroke="#24425a" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="50" cy="12" r="5" fill="#ff6b5b" />
      <rect x="13" y="44" width="8" height="18" rx="3" fill="#24425a" />
      <rect x="79" y="44" width="8" height="18" rx="3" fill="#24425a" />
      <rect x="20" y="27" width="60" height="54" rx="13" fill="#e9f1f5" stroke="#24425a" strokeWidth="3.5" />
      <circle cx="37" cy="50" r="7.5" fill="#24425a" />
      <circle cx="63" cy="50" r="7.5" fill="#24425a" />
      <circle cx="39.5" cy="47.5" r="2.4" fill="#ffffff" />
      <circle cx="65.5" cy="47.5" r="2.4" fill="#ffffff" />
      <path d="M38 68 H62" fill="none" stroke="#24425a" strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  "star-coral": (
    <>
      <rect width="100" height="100" fill="#f26a4f" />
      <polygon
        points="50,19 58.8,40.9 82.3,42.5 64.3,57.6 70,80.5 50,68 30,80.5 35.7,57.6 17.7,42.5 41.2,40.9"
        fill="#ffe27a"
        stroke="#ffe27a"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <circle cx="43" cy="54" r="2.6" fill="#7a2a18" />
      <circle cx="57" cy="54" r="2.6" fill="#7a2a18" />
      <path d="M44 61 Q50 66 56 61" fill="none" stroke="#7a2a18" strokeWidth="2.8" strokeLinecap="round" />
      <circle cx="16" cy="18" r="3" fill="#ffe9d6" />
      <circle cx="87" cy="23" r="2.2" fill="#ffe9d6" />
      <circle cx="84" cy="84" r="3" fill="#ffe9d6" />
    </>
  ),
  "moon-navy": (
    <>
      <rect width="100" height="100" fill="#26346b" />
      <path d="M68 24 A28.6 28.6 0 1 0 68 76 A26 26 0 0 1 68 24 Z" fill="#ffe9a8" />
      <path d="M80 22 L82.2 27.8 L88 30 L82.2 32.2 L80 38 L77.8 32.2 L72 30 L77.8 27.8 Z" fill="#ffe9a8" />
      <circle cx="86" cy="56" r="2.2" fill="#ffe9a8" />
      <circle cx="78" cy="80" r="1.8" fill="#ffe9a8" />
      <circle cx="14" cy="20" r="1.8" fill="#ffe9a8" />
    </>
  ),
};

/** The built-in picture for a preset, drawn to fill whatever square it is put in. Decorative: the name beside it labels it. */
export function PresetArt({ preset }: { preset: AvatarPreset }) {
  return (
    <svg className="avatar-art" viewBox="0 0 100 100" width="100%" height="100%" aria-hidden focusable="false">
      {ART[preset]}
    </svg>
  );
}
