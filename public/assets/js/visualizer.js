/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · visualizer.js — Web Audio analysis of the live audio element.
   Two render modes, both driven by real audio data (never fake noise):
     'bars' → spectrum bars, mirrored, accent gradient
     'signal' → oscilloscope trace of the broadcast signal (idle = wave packet)
   Falls back to a calm idle animation when nothing plays or when the
   AudioContext is unavailable.
   ═══════════════════════════════════════════════════════════════════════ */

let audioContext = null;
let analyser = null;
let sourceNode = null;
let frequencyData = null;
let timeData = null;
let attachedElement = null;

export function attachAudio(audioElement) {
  if (attachedElement === audioElement) return true;
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtx) return false;
  try {
    audioContext ??= new AudioCtx();
    sourceNode = audioContext.createMediaElementSource(audioElement);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    sourceNode.connect(analyser);
    analyser.connect(audioContext.destination);
    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    attachedElement = audioElement;
    return true;
  } catch {
    // A media element can only be attached once per context — ignore and keep the plain element.
    return false;
  }
}

export function resumeAudioContext() {
  if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
}

/**
 * Mount a visualizer on a canvas. Returns a stop() function.
 * @param {HTMLCanvasElement} canvas
 * @param {'bars'|'signal'} mode
 */
export function mountVisualizer(canvas, mode = 'bars') {
  const ctx = canvas.getContext('2d');
  let frame = 0;
  let stopped = false;
  let phase = 0;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const accent = '#1b8ef5';
  const accent2 = '#00e0ff';

  function sizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return false;
    const bitmapWidth = Math.round(width * ratio);
    const bitmapHeight = Math.round(height * ratio);
    if (canvas.width === bitmapWidth && canvas.height === bitmapHeight) return true;
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return true;
  }

  // Keep the bitmap in step with the CSS box: grid columns settle *after* mount, and a
  // stale bitmap would silently clip everything we draw.
  const onResize = () => sizeCanvas();
  window.addEventListener('resize', onResize);
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          sizeCanvas();
          redraw();
        })
      : null;
  observer?.observe(canvas);
  sizeCanvas();

  // Draw one frame immediately: the element is never blank, and it still renders when
  // requestAnimationFrame is throttled (background tab, headless capture, reduced motion).
  redraw();

  function measureEnergy() {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(frequencyData);
    let sum = 0;
    for (let i = 0; i < frequencyData.length; i += 1) sum += frequencyData[i];
    return sum / frequencyData.length / 255;
  }

  /** Draw one frame with the current data. */
  function redraw() {
    const { width, height } = canvas.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const energy = measureEnergy();
    if (mode === 'bars') drawBars(width, height, energy);
    else drawSignal(width, height, energy);
  }

  function drawBars(width, height, energy) {
    const bars = 48;
    const gap = 3;
    const barWidth = Math.max(2, (width - (bars - 1) * gap) / bars);
    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, accent);
    gradient.addColorStop(1, accent2);

    for (let i = 0; i < bars; i += 1) {
      let value;
      if (frequencyData) {
        // Logarithmic bucket mapping so bass does not dominate the whole display.
        const start = Math.floor((i / bars) ** 1.7 * (frequencyData.length * 0.62));
        const end = Math.max(start + 1, Math.floor(((i + 1) / bars) ** 1.7 * (frequencyData.length * 0.62)));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += frequencyData[j];
        value = sum / (end - start) / 255;
      } else {
        // Idle: a slow travelling swell so the panel never looks dead.
        value = Math.max(
          0.03,
          0.1 + 0.09 * Math.sin(phase / 22 - i / 4.5) + 0.04 * Math.sin(phase / 7 + i / 2),
        );
      }
      const barHeight = Math.max(3, value * height * 0.92);
      const x = i * (barWidth + gap);
      ctx.fillStyle = gradient;
      ctx.globalAlpha = 0.35 + value * 0.65;
      ctx.beginPath();
      ctx.roundRect(x, height - barHeight, barWidth, barHeight, Math.min(barWidth / 2, 3));
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();

    // Loud passage: a thin leading edge so peaks read at a glance.
    if (energy > 0.02) {
      ctx.globalAlpha = Math.min(0.6, energy * 3);
      ctx.fillStyle = accent2;
      ctx.fillRect(0, 0, width, 1.5);
      ctx.globalAlpha = 1;
    }
  }

  function drawSignal(width, height, energy) {
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    if (analyser && energy > 0.004) analyser.getByteTimeDomainData(timeData);

    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.shadowColor = 'rgba(27,142,245,0.55)';
    ctx.shadowBlur = 12;
    ctx.beginPath();

    const points = 240;
    for (let i = 0; i < points; i += 1) {
      const x = (i / (points - 1)) * width;
      let amplitude;
      if (timeData && energy > 0.004) {
        const index = Math.floor((i / points) * (timeData.length * 0.5));
        amplitude = ((timeData[index] - 128) / 128) * height * 0.42;
      } else {
        // Idle: a damped wave packet travelling left → right, echoing the
        // broadcast waves in the logo mark.
        const t = ((i / points) * 3 + phase / 120) % 1;
        const envelope = Math.exp(-((t - 0.5) ** 2) / 0.004);
        amplitude = envelope * Math.sin(t * 90) * height * 0.55;
      }
      const y = mid - amplitude;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = energy > 0.02 ? accent2 : 'rgba(27,142,245,0.6)';
    ctx.beginPath();
    ctx.arc(width - 3, mid, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function frameLoop() {
    if (stopped) return;
    sizeCanvas(); // cheap guard: keeps the bitmap aligned with the CSS box
    redraw();
    phase += 1;
    frame = requestAnimationFrame(frameLoop);
  }

  if (reduceMotion) {
    // One static frame — no continuous animation for users who asked for less motion.
    redraw();
  } else {
    frame = requestAnimationFrame(frameLoop);
  }

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize', onResize);
  };
}
