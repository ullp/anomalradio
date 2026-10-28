/**
 * Audio probing and (optional) loudness normalisation, via ffmpeg/ffprobe.
 *
 * ffprobe is a documented prerequisite of `npm run import`; the server itself never shells out, so
 * a missing ffmpeg cannot take the station down.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

/** `true` when ffprobe is on PATH. */
export async function ffprobeAvailable() {
  try {
    await execFileAsync('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the technical metadata of an audio file.
 * @returns {{ durationMs, bitrate, sampleRate, channels, codec, tags }}
 */
export async function probe(file) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,bit_rate,size:format_tags=title,artist,album,album_artist,date,genre,TBPM,TKEY,composer,track,disc,isrc:stream=codec_name,sample_rate,channels,bit_rate',
      '-of',
      'json',
      file,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout);
  const format = parsed.format ?? {};
  const tags = format.tags ?? {};
  const stream = (parsed.streams ?? [])[0] ?? {};

  return {
    durationMs: Math.round((Number(format.duration) || 0) * 1000),
    bitrate: num(format.bit_rate) ?? num(stream.bit_rate),
    sampleRate: num(stream.sample_rate),
    channels: num(stream.channels),
    codec: stream.codec_name ?? null,
    tags,
  };
}

/**
 * Write a loudness-normalised copy for the radio (EBU R128, −14 LUFS).
 * Kept separate from the master so what customers download stays untouched.
 */
export async function normaliseToLufs(sourcePath, targetPath, { lufs = -14, truePeak = -1 } = {}) {
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    sourcePath,
    '-af',
    `loudnorm=I=${lufs}:TP=${truePeak}:LRA=11`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    targetPath,
  ]);
  return targetPath;
}

/**
 * Write a short, deliberately degraded excerpt — the per-track preview (M4).
 *
 * This is the one piece of audio that is meant to be *heard by strangers*: it is what a share card
 * plays, and what tells a visitor whether they want the track. So it is a different artifact from
 * the master, not a slice of it: 96 kbps mono (about a tenth of the data), a fade at the end so it
 * is audibly a preview, and never the whole track.
 */
export async function makePreview(
  sourcePath,
  targetPath,
  { seconds = 30, bitrate = '96k', channels = 1, startRatio = 0.25, durationMs = null } = {},
) {
  const startSeconds = durationMs ? Math.max(0, (durationMs / 1000) * startRatio) : 0;
  const fade = Math.max(0, seconds - 2);

  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    // Seek before -i: fast, and accurate enough for a preview.
    '-ss',
    startSeconds.toFixed(2),
    '-i',
    sourcePath,
    '-t',
    String(seconds),
    '-ac',
    String(channels),
    '-c:a',
    'libmp3lame',
    '-b:a',
    bitrate,
    '-af',
    `afade=t=out:st=${fade}:d=2`,
    targetPath,
  ]);
  return targetPath;
}

/** Duration of a file in milliseconds, used to sanity-check what we stored. */
export async function durationMsOf(file) {
  const { durationMs } = await probe(file);
  return durationMs;
}
