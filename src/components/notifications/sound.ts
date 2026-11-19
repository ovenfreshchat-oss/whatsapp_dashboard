/** Two short, synthesized chimes (no audio assets to ship or license). One AudioContext per tab. */

type ToneStep = { frequency: number; durationMs: number };
const MESSAGE_TONES: ToneStep[] = [{ frequency: 880, durationMs: 90 }, { frequency: 1175, durationMs: 110 }];
const CAMPAIGN_TONES: ToneStep[] = [{ frequency: 523, durationMs: 120 }, { frequency: 659, durationMs: 160 }];

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** True once audio can actually play. Chrome/Safari suspend a freshly-created context until a user gesture. */
export function isSoundUnlocked(): boolean {
  return getContext()?.state === "running";
}

/** Call from inside a real click handler. Resuming here is what the autoplay policy requires. */
export async function unlockSound(): Promise<boolean> {
  const audio = getContext();
  if (!audio) return false;
  try {
    if (audio.state !== "running") await audio.resume();
  } catch {
    // Some browsers reject resume() outside a trusted gesture; the caller's click still counts next time.
  }
  return audio.state === "running";
}

function playTones(steps: ToneStep[], volume: number): void {
  const audio = getContext();
  if (!audio || audio.state !== "running") return;
  const gainCeiling = Math.max(0, Math.min(1, volume)) * 0.25;
  let start = audio.currentTime;
  for (const step of steps) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(step.frequency, start);
    const end = start + step.durationMs / 1000;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(gainCeiling, start + 0.012);
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
    start = end + 0.03;
  }
}

export function playMessageSound(volume: number): void {
  playTones(MESSAGE_TONES, volume);
}

export function playCampaignSound(volume: number): void {
  playTones(CAMPAIGN_TONES, volume);
}
