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

/** Duration of a file in milliseconds, used to sanity-check what we stored. */
export async function durationMsOf(file) {
  const { durationMs } = await probe(file);
  return durationMs;
}
