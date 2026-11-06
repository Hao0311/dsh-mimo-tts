/**
 * dsh-mimo-tts — 把小米 MiMo TTS（免费）封装成模型工具，并给 Web GUI 提供播报路由。
 *
 * 两条入口：
 *   1. 模型工具 `mimo_tts`：文字 → POST https://api.xiaomimimo.com/v1/chat/completions
 *      （OpenAI 兼容，model = mimo-v2.5-tts，assistant 消息放待朗读文本）→ base64 音频 → 落盘。
 *   2. Web 路由 `/api/mimo-tts/speak`：同一套合成逻辑，但直接把音频字节回给浏览器，
 *      供消息动作行里的「播报」按钮播放（密钥始终留在 Host，不出现在页面里）。
 *      `/api/mimo-tts/config` 返回可选音色与上限。
 *
 * 凭据：优先 ctx.credentials 的 `XIAOMI_API_KEY`（Web 设置页/`.credentials.yaml` 里那份），
 * 其次进程环境变量，最后直接读 `$DSH_HOME/.credentials.yaml`，与既有 tts.py 的取法一致。
 *
 * 不依赖任何 Harness 包（只用 node: 内置模块 + ctx 服务），避免工作区插件解析不到
 * @deepseek-ai/* 的问题；工具定义直接按 ToolDefinition 结构手写（register 接受 JSON Schema）。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TOOL_NAME = 'mimo_tts';
const MODEL = process.env.MIMO_TTS_MODEL ?? 'mimo-v2.5-tts';
const API_BASE = (process.env.MIMO_TTS_BASE ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
const DEFAULT_VOICE = 'mimo_default';
const VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
const MAX_CHARS = 4000;
/** 三个 TTS 模型：内置音色 / 文字描述生成音色 / 音频样本克隆。 */
const MODELS = ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone'];
/** 音色克隆样本上限（官方限制 10MB）。 */
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const ROUTE_PREFIX = '/api/mimo-tts';

/** apply() 时记下的宿主 ctx，路由 handler 在闭包里用它取凭据。 */
let hostCtx = null;

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
}

function outputDir() {
  return process.env.DSH_MIMO_TTS_DIR && process.env.DSH_MIMO_TTS_DIR.trim()
    ? process.env.DSH_MIMO_TTS_DIR.trim()
    : join(dshHome(), 'tts');
}

/** 取 MiMo API Key：credentials 服务 → 环境变量 → .credentials.yaml。 */
async function resolveApiKey(ctx) {
  try {
    const hit = await ctx.credentials.resolve('XIAOMI_API_KEY');
    if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
  } catch {
    /* 落到后面的兜底 */
  }
  const fromEnv = process.env.XIAOMI_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const raw = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
    const m = /^\s*XIAOMI_API_KEY:\s*(\S+)\s*$/m.exec(raw);
    if (m) return m[1];
  } catch {
    /* 继续抛下面的错 */
  }
  throw new Error('mimo_tts: 找不到 XIAOMI_API_KEY（请在设置页配置，或写入 ~/.dsh/.credentials.yaml）');
}

/** 从 WAV 头算时长（秒）；非 WAV 或解析失败返回 undefined。 */
function wavDurationSec(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!sampleRate || !channels || !bits || !dataLen) return undefined;
  return Number((dataLen / (sampleRate * channels * (bits / 8))).toFixed(2));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    '-' +
    randomBytes(3).toString('hex')
  );
}

/**
 * 把本地音频样本读成 `data:audio/...;base64,...`（voiceclone 模型用）。
 * @param {string} path - 样本文件路径（mp3 / wav）。
 * @returns {Promise<string>}
 */
async function readVoiceSample(path) {
  const file = String(path ?? '').trim();
  if (!file) throw new Error('mimo_tts: voiceclone 模型需要「音色样本路径」（voiceSamplePath）');
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`mimo_tts: 音色样本不存在：${file}`);
  }
  if (!info.isFile()) throw new Error(`mimo_tts: 音色样本不是文件：${file}`);
  if (info.size > MAX_SAMPLE_BYTES) throw new Error('mimo_tts: 音色样本超过 10MB 上限');
  const lower = file.toLowerCase();
  const type = lower.endsWith('.wav') ? 'audio/wav' : lower.endsWith('.mp3') ? 'audio/mpeg' : '';
  if (!type) throw new Error('mimo_tts: 音色样本只支持 mp3 / wav');
  const bytes = await readFile(file);
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/**
 * 共用合成逻辑：一次非流式请求，返回音频字节与元信息。
 * @param {{ text: string, model?: string, voice?: string, style?: string, format?: 'wav' | 'mp3', voiceDesign?: string, voiceSamplePath?: string }} request
 * @returns {Promise<{ bytes: Buffer, format: 'wav' | 'mp3', voice: string, model: string, textLength: number, durationSec?: number }>}
 */
async function synthesize(ctx, request) {
  const text = String(request?.text ?? '').trim();
  if (!text) throw new Error('mimo_tts: text 不能为空');
  if (text.length > MAX_CHARS) throw new Error(`mimo_tts: 文本过长（${text.length} 字，上限 ${MAX_CHARS}）`);
  const model = MODELS.includes(request?.model) ? request.model : MODEL;
  const format = request?.format === 'mp3' ? 'mp3' : 'wav';
  const style =
    typeof request?.style === 'string' && request.style.trim()
      ? request.style.trim()
      : '请用自然、清晰、亲切的语气朗读下面这段文字。';

  const audio = { format };
  const messages = [];
  let voiceLabel = '';
  if (model === 'mimo-v2.5-tts-voicedesign') {
    const design = String(request?.voiceDesign ?? '').trim();
    if (!design) throw new Error('mimo_tts: voicedesign 模型需要「音色描述」（voiceDesign）');
    messages.push({ role: 'user', content: design });
    voiceLabel = '自定义（文字描述）';
  } else if (model === 'mimo-v2.5-tts-voiceclone') {
    audio.voice = await readVoiceSample(request?.voiceSamplePath);
    messages.push({ role: 'user', content: typeof request?.style === 'string' ? request.style : '' });
    voiceLabel = '克隆样本';
  } else {
    audio.voice = VOICES.includes(request?.voice) ? request.voice : DEFAULT_VOICE;
    messages.push({ role: 'user', content: style });
    voiceLabel = audio.voice;
  }
  messages.push({ role: 'assistant', content: text });

  const key = await resolveApiKey(ctx);
  const body = { model, messages, audio, stream: false };

  const timeout = AbortSignal.timeout(120000);
  let res;
  try {
    res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout,
    });
  } catch (error) {
    throw new Error(`mimo_tts: 请求 MiMo TTS 失败（${API_BASE}）：${error?.message ?? String(error)}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* 忽略 */
    }
    throw new Error(`mimo_tts: MiMo TTS HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  let json;
  try {
    json = await res.json();
  } catch (error) {
    throw new Error(`mimo_tts: MiMo TTS 返回的不是 JSON：${error?.message ?? String(error)}`);
  }
  const b64 = json?.choices?.[0]?.message?.audio?.data;
  if (typeof b64 !== 'string' || b64.length === 0) {
    const preview = JSON.stringify(json).slice(0, 400);
    throw new Error(`mimo_tts: MiMo TTS 响应里没有音频数据：${preview}`);
  }
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw new Error('mimo_tts: MiMo TTS 返回的音频为空');
  const durationSec = format === 'wav' ? wavDurationSec(bytes) : undefined;
  return {
    bytes,
    format,
    voice: voiceLabel,
    model,
    textLength: text.length,
    ...(durationSec === undefined ? {} : { durationSec }),
  };
}

/** 按 ToolDefinition 手写的工具定义（register() 接受 JSON Schema 参数）。 */
function buildTool(ctx) {
  return {
    name: TOOL_NAME,
    description:
      '用小米 MiMo TTS（免费）把文字合成为语音文件，返回本地音频路径。适合把回复、提示音、旁白读出来；' +
      `默认音色 ${DEFAULT_VOICE}，默认 wav，可用 voice/style/format 调整。文本上限 ${MAX_CHARS} 字。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: '要朗读的文字（必填）',
        },
        voice: {
          type: 'string',
          enum: VOICES,
          description: `音色，默认 ${DEFAULT_VOICE}；内置：${VOICES.join('、')}`,
        },
        style: {
          type: 'string',
          description: '朗读风格/语气提示，例如「温柔、放慢语速」「新闻播报」；留空用自然亲切的默认语气',
        },
        format: {
          type: 'string',
          enum: ['wav', 'mp3'],
          description: '音频格式，默认 wav（wav 便于直接查看时长；mp3 体积更小）',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '生成的音频文件绝对路径' },
          bytes: { type: 'number', description: '文件字节数' },
          format: { type: 'string', enum: ['wav', 'mp3'] },
          voice: { type: 'string' },
          model: { type: 'string' },
          textLength: { type: 'number', description: '合成文本字数' },
          durationSec: { type: 'number', description: '音频时长（秒，仅 wav 可计算）' },
        },
        required: ['path', 'bytes', 'format', 'voice', 'model', 'textLength'],
      },
      render(_args, value) {
        const dur = typeof value.durationSec === 'number' ? `，约 ${value.durationSec} 秒` : '';
        return [
          {
            type: 'text',
            text: `已生成语音：${value.path}（${value.format}，${(value.bytes / 1024).toFixed(1)} KB${dur}，音色 ${value.voice}）`,
          },
        ];
      },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const text = String(args?.text ?? '').trim();
      const signal = exec?.signal;
      const out = await synthesize(ctx, { text, voice: args?.voice, style: args?.style, format: args?.format });
      if (signal?.aborted) throw new Error('mimo_tts: 已取消');
      const dir = outputDir();
      await mkdir(dir, { recursive: true });
      const path = join(dir, `mimo-tts-${stamp()}.${out.format}`);
      await writeFile(path, out.bytes);
      return {
        path,
        bytes: out.bytes.length,
        format: out.format,
        voice: out.voice,
        model: out.model,
        textLength: out.textLength,
        ...(out.durationSec === undefined ? {} : { durationSec: out.durationSec }),
      };
    },
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** POST /api/mimo-tts/speak —— 行内播报按钮用，直接回音频字节。 */
async function handleSpeak(request) {
  if (!hostCtx) return json(503, { ok: false, error: 'host context not ready' });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: 'invalid-json' });
  }
  try {
    const out = await synthesize(hostCtx, {
      text: payload?.text,
      model: payload?.model,
      voice: payload?.voice,
      style: payload?.style,
      format: payload?.format,
      voiceDesign: payload?.voiceDesign,
      voiceSamplePath: payload?.voiceSamplePath,
    });
    const headers = {
      'content-type': out.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      'content-length': String(out.bytes.length),
      'cache-control': 'no-store',
      'x-mimo-voice': out.voice,
      'x-mimo-model': out.model,
    };
    if (out.durationSec !== undefined) headers['x-mimo-duration'] = String(out.durationSec);
    return new Response(out.bytes, { status: 200, headers });
  } catch (error) {
    return json(502, { ok: false, error: String(error?.message ?? error) });
  }
}

/** GET /api/mimo-tts/config —— 可选音色、默认值与上限。 */
function handleConfig() {
  return json(200, {
    ok: true,
    voices: VOICES,
    models: MODELS,
    defaultVoice: DEFAULT_VOICE,
    defaultModel: MODEL,
    maxChars: MAX_CHARS,
    model: MODEL,
  });
}

/**
 * @param {import('@cordisjs/core').Context} ctx
 */
export function apply(ctx) {
  hostCtx = ctx;
  ctx.tools.register(buildTool(ctx));
  const fetcher = ctx.connection?.fetch;
  if (!fetcher || typeof fetcher.register !== 'function') return;
  ctx.effect(
    () => fetcher.register({ path: `${ROUTE_PREFIX}/speak`, methods: ['POST'], requestBody: 'buffered', fetch: handleSpeak }),
    'dsh-mimo-tts: speak route',
  );
  ctx.effect(
    () => fetcher.register({ path: `${ROUTE_PREFIX}/config`, methods: ['GET'], requestBody: 'buffered', fetch: () => handleConfig() }),
    'dsh-mimo-tts: config route',
  );
}

export { synthesize, readVoiceSample, VOICES, MODELS, DEFAULT_VOICE, MAX_CHARS, ROUTE_PREFIX };
export const name = 'mimo-tts';
export const inject = ['tools', 'credentials', 'connection'];
