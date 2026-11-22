// ================================================================ SOUND
// A short, soft two-note chime made in code (no sound file to download).
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  return audioCtx;
}
// iPhone only allows sound after a tap, and pauses ("interrupts") it whenever
// the app goes to the background. Wake it on every tap so it's ready in time.
function unlockAudio() {
  const ctx = getAudio();
  if (!ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  if (!ctx._unlocked) {
    // Playing a silent blip inside a tap is what fully unlocks sound on iOS.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    ctx._unlocked = true;
  }
}
document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("touchend", unlockAudio, { passive: true });

function scheduleChime(ctx) {
  const t = ctx.currentTime + 0.01;
  [[880, 0], [1318.5, 0.07]].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.25);
  });
}

function playTick() {
  try {
    const ctx = getAudio();
    if (!ctx) return;
    // Wait until sound is actually on before playing, or iPhone drops the notes.
    if (ctx.state === "running") scheduleChime(ctx);
    else ctx.resume().then(() => scheduleChime(ctx)).catch(() => {});
  } catch (e) { /* sound is a nice-to-have; never block a tick */ }
}


export { playTick, unlockAudio };
