/**
 * @license
 * Copyright 2025 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Video analyzer tool - downloads video, extracts key frames via FFmpeg,
 * fetches subtitles, generates structured summary.
 * Ported from Otto project: https://github.com/Felix201209/otto
 *
 * Security: All external commands use execFile (no shell), parameters passed
 * as arrays. URL and lang are validated before use. Temp files are isolated
 * per-execution via randomUUID and cleaned up in finally block.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { BaseTool, Icon, ToolResult, ToolCallConfirmationDetails, ToolLocation } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';

const execFileAsync = promisify(execFile);
const TEMP_DIR = join(homedir(), '.easycode', 'tmp', 'video');
const KB_DIR = join(homedir(), '.easycode', 'kb', 'videos');
const SCENE_THRESHOLD = 0.4;
const MAX_FRAMES = 30;

export interface VideoAnalyzerToolParams {
  url: string;
  save_to_kb?: boolean;
  lang?: string;
}

function isURL(s: string): boolean { return /^https?:\/\//.test(s); }
function isYouTube(u: string): boolean { return /youtube\.com|youtu\.be/.test(u); }
function platform(u: string): string {
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/zoom\.us|zoom\.com/.test(u)) return 'zoom';
  if (/loom\.com/.test(u)) return 'loom';
  return 'other';
}
function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function parseSub(content: string): string {
  return content.replace(/^WEBVTT.*$/m, '').replace(/^\d+$/gm, '')
    .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, '').replace(/<[^>]+>/g, '')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0).join(' ');
}

function validateLang(lang: string): boolean {
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(lang);
}

async function checkBinary(name: string): Promise<boolean> {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where' : 'which';
    await execFileAsync(cmd, [name], { timeout: 3000 });
    return true;
  } catch { return false; }
}

export class VideoAnalyzerTool extends BaseTool<VideoAnalyzerToolParams, ToolResult> {
  static readonly Name: string = 'analyze_video';

  constructor(private readonly config: Config) {
    super(VideoAnalyzerTool.Name, 'VideoAnalyzer',
      'Analyze a video from URL or local path. Downloads the video, extracts key frames ' +
      'via FFmpeg scene detection, fetches subtitles (YouTube official or Whisper), ' +
      'and generates a structured summary with key moments and action items. ' +
      'Optionally saves to the knowledge base for future recall.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          url: { type: Type.STRING, description: 'Video URL (http/https) or local file path' },
          save_to_kb: { type: Type.BOOLEAN, description: 'Save analysis to knowledge base. Default: false' },
          lang: { type: Type.STRING, description: 'Language hint for transcription (e.g. "zh", "en"). Default: "zh"' },
        },
        required: ['url'],
      },
    );
  }

  override validateToolParams(params: VideoAnalyzerToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, params, VideoAnalyzerTool.Name);
    if (e) return e;
    if (!params.url) return 'Error: url is required.';
    if (isURL(params.url)) {
      try { new URL(params.url); } catch { return 'Error: invalid URL.'; }
    } else {
      if (!existsSync(params.url)) return `Error: file not found: ${params.url}`;
    }
    if (params.lang && !validateLang(params.lang)) return 'Error: lang must be format like "zh" or "en-US".';
    return null;
  }

  override toolLocations(): ToolLocation[] { return []; }
  override getDescription(p: VideoAnalyzerToolParams): string {
    return `analyze_video: ${p.url.substring(0, 60)}`;
  }

  override async shouldConfirmExecute(p: VideoAnalyzerToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    return {
      type: 'exec',
      title: `[WARN] Analyze video: ${p.url.substring(0, 80)}`,
      command: `analyze_video(${isURL(p.url) ? platform(p.url) : 'local'})`,
      rootCommand: 'analyze_video',
      onConfirm: async () => {},
    };
  }

  async execute(params: VideoAnalyzerToolParams, signal: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(params);
    if (err) return { llmContent: err, returnDisplay: err };

    const { url, save_to_kb = false } = params;
    const lang = params.lang && validateLang(params.lang) ? params.lang : 'zh';

    // Check dependencies
    if (!await checkBinary('ffmpeg')) return { llmContent: 'Error: ffmpeg not found. Install: https://ffmpeg.org', returnDisplay: 'ffmpeg missing' };

    // Isolated temp directory per execution
    const sessionDir = join(TEMP_DIR, randomUUID());
    const videoPath = isURL(url) ? join(sessionDir, 'video.mp4') : url;
    let videoTitle = 'Unknown';
    let videoDuration = 0;

    try {
      ensureDir(sessionDir);

      if (isURL(url)) {
        const hasYtDlp = await checkBinary('yt-dlp');
        if (hasYtDlp && (isYouTube(url) || platform(url) !== 'other')) {
          // Download via yt-dlp (execFile, no shell, array params)
          await execFileAsync('yt-dlp', ['-f', 'best[ext=mp4]/best', '-o', videoPath, url], { timeout: 300000, signal });
        } else {
          // Download via curl (execFile, no shell)
          await execFileAsync('curl', ['-L', '-s', '-o', videoPath, url], { timeout: 300000, signal });
        }
        if (!existsSync(videoPath)) return { llmContent: 'Error: video download failed.', returnDisplay: 'Download failed' };

        if (hasYtDlp) {
          try {
            const { stdout: t } = await execFileAsync('yt-dlp', ['--get-title', url], { timeout: 30000 });
            videoTitle = t.trim() || 'Unknown';
          } catch {}
        }
      } else {
        videoTitle = url.split(/[\\/]/).pop() || 'Unknown';
      }

      // Get duration via ffprobe
      try {
        const { stdout: d } = await execFileAsync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeout: 10000 });
        videoDuration = parseFloat(d.trim()) || 0;
      } catch {}

      // Scene detection frame extraction
      const framesDir = join(sessionDir, 'frames');
      ensureDir(framesDir);
      const framePattern = join(framesDir, 'frame_%04d.jpg').replace(/\\/g, '/');
      try {
        await execFileAsync('ffmpeg', ['-i', videoPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})'`, '-vsync', 'vfr', '-q:v', '2', framePattern, '-y'], { timeout: 120000, signal });
      } catch {}
      let frames = existsSync(framesDir) ? readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort() : [];

      // Fallback: uniform sampling (only if duration > 0)
      if (frames.length < 3 && videoDuration > 0) {
        const count = 10;
        for (let i = 1; i <= count; i++) {
          if (signal.aborted) throw new Error('aborted');
          const t = (videoDuration / count * i).toFixed(1);
          const out = join(framesDir, `sample_${String(i).padStart(4, '0')}.jpg`);
          try { await execFileAsync('ffmpeg', ['-ss', t, '-i', videoPath, '-frames:v', '1', '-q:v', '2', out, '-y'], { timeout: 10000 }); } catch {}
        }
        frames = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      }
      if (frames.length > MAX_FRAMES) { const step = Math.ceil(frames.length / MAX_FRAMES); frames = frames.filter((_, i) => i % step === 0); }

      // Subtitles
      let subtitleText = '';
      let subtitleSource = 'none';
      if (isURL(url) && isYouTube(url)) {
        const hasYtDlp = await checkBinary('yt-dlp');
        if (hasYtDlp) {
          const subBase = join(sessionDir, 'subtitle');
          try {
            await execFileAsync('yt-dlp', ['--write-auto-sub', '--sub-lang', `${lang},en`, '--skip-download', '-o', subBase, url], { timeout: 60000 });
            const subFiles = readdirSync(sessionDir).filter(f => f.startsWith('subtitle') && (f.endsWith('.vtt') || f.endsWith('.srt')));
            if (subFiles.length > 0) { subtitleText = parseSub(readFileSync(join(sessionDir, subFiles[0]), 'utf-8')); subtitleSource = 'youtube_official'; }
          } catch {}
        }
      }
      if (!subtitleText) {
        const hasWhisper = await checkBinary('whisper');
        if (hasWhisper) {
          try {
            await execFileAsync('whisper', [videoPath, '--model', 'base', '--language', lang, '--output_format', 'txt', '--output_dir', sessionDir], { timeout: 600000, signal });
            const txtFiles = readdirSync(sessionDir).filter(f => f.endsWith('.txt'));
            if (txtFiles.length > 0) { subtitleText = readFileSync(join(sessionDir, txtFiles[0]), 'utf-8').trim(); subtitleSource = 'whisper'; }
          } catch {}
        }
      }

      // LLM Analysis (simplified - no Otto-specific deps)
      let analysisResult = '';
      const framePaths = frames.slice(0, MAX_FRAMES).map(f => join(framesDir, f));
      const subContext = subtitleText ? `\n\nSubtitles (${subtitleSource}):\n${subtitleText.substring(0, 4000)}` : '\n\n(No subtitles)';
      const prompt = `You are a video analysis assistant. Analyze the following video frames and subtitles.\n\nTitle: ${videoTitle}\nDuration: ${Math.round(videoDuration)}s\nFrames: ${framePaths.length}${subContext}\n\nOutput: 1. summary 2. topics 3. key_moments 4. action_items`;

      // Try using GeminiClient if available
      try {
        const client = this.config.getGeminiClient?.();
        if (client) {
          const parts: any[] = [{ text: prompt }];
          for (const fp of framePaths) {
            try { parts.push({ inlineData: { mimeType: 'image/jpeg', data: readFileSync(fp).toString('base64') } }); } catch {}
          }
          const resp = await client.generateContent({ contents: [{ parts }], abortSignal: signal });
          analysisResult = (resp?.text || '').trim();
        }
      } catch {}

      if (!analysisResult) {
        analysisResult = `Video "${videoTitle}" analysis complete.\nDuration: ${Math.round(videoDuration)}s\nFrames: ${frames.length}\nSubtitles: ${subtitleSource}\n${subtitleText ? 'Summary: ' + subtitleText.substring(0, 500) : ''}\n\n(Visual analysis model unavailable - basic summary only)`;
      }

      // Knowledge base
      let kbId = '';
      if (save_to_kb) {
        ensureDir(KB_DIR);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        kbId = `video_${ts}`;
        const kbPath = join(KB_DIR, `${kbId}.json`);
        const tmpPath = `${kbPath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify({ id: kbId, url, title: videoTitle, platform: isURL(url) ? platform(url) : 'local', analyzed_at: new Date().toISOString(), duration_sec: Math.round(videoDuration), summary: analysisResult, subtitle_source: subtitleSource, transcript: subtitleText, frame_count: frames.length }, null, 2));
        // Atomic write via rename
        try { require('fs').renameSync(tmpPath, kbPath); } catch { writeFileSync(kbPath, readFileSync(tmpPath, 'utf-8')); try { rmSync(tmpPath, { force: true }); } catch {} }
      }

      const output = `Video analysis complete\n\nTitle: ${videoTitle}\nSource: ${isURL(url) ? platform(url) : 'local file'}\nDuration: ${Math.round(videoDuration)}s\nKey frames: ${frames.length}\nSubtitles: ${subtitleSource}\n\nAnalysis:\n${analysisResult}${save_to_kb ? `\n\nSaved to KB (ID: ${kbId})` : ''}`;
      return { llmContent: output, returnDisplay: `Analyzed: ${videoTitle} (${Math.round(videoDuration)}s, ${frames.length} frames)` };
    } catch (error) {
      if (signal.aborted) return { llmContent: 'Video analysis aborted.', returnDisplay: 'Aborted' };
      const msg = error instanceof Error ? error.message : String(error);
      return { llmContent: `Error analyzing video "${url}": ${msg}`, returnDisplay: `Error: ${msg}` };
    } finally {
      // Always clean up temp files (keep KB files)
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  }
}
