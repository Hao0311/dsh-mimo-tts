/**
 * dsh-mimo-tts 浏览器半边：在已定稿助手消息的动作行里加一个「播报」按钮。
 *
 * 位置：`conversation.chat.assistant-actions`（官方复制按钮之后、反馈/分支之前），
 * 与官方复制、反馈、用量同排。
 *
 * 行为：
 *   - 点击喇叭：把该条回答的文字 POST 到 `/api/mimo-tts/speak`，拿回音频字节直接播放；
 *     再点一次停止。密钥始终留在 Host。
 *   - 点击 ▾：菜单里可切换「自动播报」（每条新回答结束自动读）与音色；偏好存 localStorage。
 *
 * 文字来源：优先走 `useChat` 快照（按 messageId 找 finalNode.blocks 的文本块）；
 * 拿不到时退化为从动作行往上找前一个含文字的兄弟节点，保证老版本宿主也能用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mimo-tts',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 字典命名空间。 */
    const NS = 'mimo-tts';
    const PREFS_KEY = 'dsh-mimo-tts:prefs';
    const API = '/api/mimo-tts';
    const BOOT_AT = Date.now();
    const AUTO_WARMUP_MS = 2500;

    const zh = {
      speak: '播报这条回答',
      stop: '停止播报',
      loading: '正在合成语音…',
      failed: '播报失败',
      menu: '播报设置',
      auto: '自动播报新回答',
      voice: '音色',
      autoOn: '自动播报已开启',
      autoOff: '自动播报已关闭',
      panel: '语音设置',
      pageTitle: '语音设置（小米 MiMo TTS）',
      pageSubtitle: '选择合成模型、音色与自动播报；设置保存在本浏览器。',
      modelLabel: '合成模型',
      modelBuiltin: '内置音色（mimo-v2.5-tts）',
      modelBuiltinDesc: '从 9 个内置音色里选一个，最稳。',
      modelDesign: '文字生成音色（mimo-v2.5-tts-voicedesign）',
      modelDesignDesc: '用一段文字描述想要的声音，例如「低沉、语速很慢的老年男声」。',
      modelClone: '样本克隆音色（mimo-v2.5-tts-voiceclone）',
      modelCloneDesc: '给一段 mp3 / wav 样本（≤10MB），按样本音色合成。',
      designLabel: '音色描述',
      designPlaceholder: '例：年轻女声，语气温柔，语速偏慢，带一点笑意。',
      designHint: '1-4 句即可，越具体越准；不要写混响、EQ 这类后期术语。',
      sampleLabel: '样本文件路径',
      samplePlaceholder: '例：D:\\voices\\sample.mp3',
      sampleHint: '支持 mp3 / wav，本机绝对路径；文件只在合成时读取，不会上传其它内容。',
      autoRow: '自动播报新回答',
      testLabel: '试听',
      testTextLabel: '试听文本',
      testPlaceholder: '输入要朗读的文字',
      testButton: '试听',
      testStop: '停止',
      saved: '已保存',
      freeNote: '沿用已配置的 XIAOMI_API_KEY（与 MiMo 大模型共用），无需另外申请；MiMo TTS 目前限时免费。',
      menuMore: '更多设置见侧边栏「语音设置」',
    };
    const en = {
      speak: 'Read this answer aloud',
      stop: 'Stop reading',
      loading: 'Synthesizing speech…',
      failed: 'Speech failed',
      menu: 'Playback settings',
      auto: 'Auto-read new answers',
      voice: 'Voice',
      autoOn: 'Auto-read on',
      autoOff: 'Auto-read off',
      panel: 'Speech',
      pageTitle: 'Speech (Xiaomi MiMo TTS)',
      pageSubtitle: 'Pick the synthesis model, voice and auto-read behaviour. Settings stay in this browser.',
      modelLabel: 'Synthesis model',
      modelBuiltin: 'Built-in voices (mimo-v2.5-tts)',
      modelBuiltinDesc: 'Pick one of the nine built-in voices; the most predictable option.',
      modelDesign: 'Voice from description (mimo-v2.5-tts-voicedesign)',
      modelDesignDesc: 'Describe the voice you want, e.g. "low, slow, elderly male narrator".',
      modelClone: 'Voice clone (mimo-v2.5-tts-voiceclone)',
      modelCloneDesc: 'Point at an mp3 / wav sample (max 10MB) and synthesize in that voice.',
      designLabel: 'Voice description',
      designPlaceholder: 'e.g. Young female voice, gentle, slightly slow, a hint of a smile.',
      designHint: 'One to four sentences; no reverb / EQ / post-processing terms.',
      sampleLabel: 'Sample file path',
      samplePlaceholder: 'e.g. D:\\voices\\sample.mp3',
      sampleHint: 'mp3 or wav, absolute local path; read only when synthesizing.',
      autoRow: 'Auto-read new answers',
      testLabel: 'Preview',
      testTextLabel: 'Preview text',
      testPlaceholder: 'Text to read aloud',
      testButton: 'Preview',
      testStop: 'Stop',
      saved: 'Saved',
      freeNote: 'Reuses the configured XIAOMI_API_KEY (same key as the MiMo models); MiMo TTS is free for a limited time.',
      menuMore: 'More settings: sidebar → Speech',
    };

    function readPrefs() {
      try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
        return {
          auto: raw?.auto === true,
          voice: typeof raw?.voice === 'string' && raw.voice ? raw.voice : 'mimo_default',
          model: typeof raw?.model === 'string' && raw.model ? raw.model : 'mimo-v2.5-tts',
          voiceDesign: typeof raw?.voiceDesign === 'string' ? raw.voiceDesign : '',
          voiceSamplePath: typeof raw?.voiceSamplePath === 'string' ? raw.voiceSamplePath : '',
        };
      } catch {
        return { auto: false, voice: 'mimo_default', model: 'mimo-v2.5-tts', voiceDesign: '', voiceSamplePath: '' };
      }
    }

    /** 合成请求体：把当前偏好翻译成宿主 /speak 认识的字段。 */
    function requestBody(text, prefs) {
      const model = typeof prefs?.model === 'string' && prefs.model ? prefs.model : 'mimo-v2.5-tts';
      const body = { text, format: 'mp3', model };
      if (model === 'mimo-v2.5-tts-voicedesign') {
        body.voiceDesign = String(prefs?.voiceDesign ?? '').trim();
      } else if (model === 'mimo-v2.5-tts-voiceclone') {
        body.voiceSamplePath = String(prefs?.voiceSamplePath ?? '').trim();
      } else {
        body.voice = typeof prefs?.voice === 'string' && prefs.voice ? prefs.voice : 'mimo_default';
      }
      return body;
    }

    function writePrefs(prefs) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* 隐私模式下忽略 */
      }
    }

    /* ------------------------------------------------------------ 播放状态 */

    const player = {
      /** 当前正在播的消息 id，null 表示空闲。 */
      messageId: null,
      audio: null,
      url: null,
      listeners: new Set(),
      emit() {
        for (const fn of player.listeners) {
          try {
            fn();
          } catch {
            /* 忽略 */
          }
        }
      },
    };

    function stopPlayback() {
      if (player.audio) {
        try {
          player.audio.pause();
        } catch {
          /* 忽略 */
        }
        player.audio = null;
      }
      if (player.url) {
        try {
          URL.revokeObjectURL(player.url);
        } catch {
          /* 忽略 */
        }
        player.url = null;
      }
      player.messageId = null;
      player.emit();
    }

    function subscribe(fn) {
      player.listeners.add(fn);
      return () => player.listeners.delete(fn);
    }

    /** 把文字发到宿主合成并播放；options 是 readPrefs() 的偏好对象。 */
    async function speakText(text, options, messageId) {
      const trimmed = String(text ?? '').trim();
      if (!trimmed) throw new Error(zh.failed);
      const body = requestBody(trimmed, options);
      if (body.model === 'mimo-v2.5-tts-voicedesign' && !body.voiceDesign) {
        throw new Error('语音设置里还没有填「音色描述」');
      }
      if (body.model === 'mimo-v2.5-tts-voiceclone' && !body.voiceSamplePath) {
        throw new Error('语音设置里还没有填「样本文件路径」');
      }
      stopPlayback();
      player.messageId = messageId;
      player.emit();
      let res;
      try {
        res = await fetch(`${API}/speak`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        stopPlayback();
        throw new Error(`${zh.failed}: ${error?.message ?? error}`);
      }
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          /* 忽略 */
        }
        stopPlayback();
        throw new Error(`${zh.failed}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      player.url = url;
      player.audio = audio;
      audio.onended = () => {
        if (player.audio === audio) stopPlayback();
      };
      audio.onerror = () => {
        if (player.audio === audio) stopPlayback();
      };
      try {
        await audio.play();
      } catch (error) {
        stopPlayback();
        throw new Error(`${zh.failed}: ${error?.message ?? error}`);
      }
    }

    /* ---------------------------------------------------------- 文字提取 */

    /** 从 assistant 块的文本拼出朗读内容。 */
    function blocksText(blocks) {
      if (!Array.isArray(blocks)) return '';
      const parts = [];
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      return parts.join('\n').trim();
    }

    /** 通过 Chat 快照按 messageId 找这条助手消息的文本。 */
    function textFromSnapshot(useChat, messageId) {
      if (typeof useChat !== 'function') return '';
      try {
        return (
          useChat((snapshot) => {
            try {
              for (const key of snapshot.order) {
                const node = snapshot.nodes.get(key);
                if (!node || node.kind !== 'assistant' || !node.data) continue;
                const finalNode = node.data.finalNode;
                if (!finalNode || finalNode.messageId !== messageId) continue;
                return blocksText(node.data.blocks);
              }
            } catch {
              /* 忽略 */
            }
            return '';
          }) ?? ''
        );
      } catch {
        return '';
      }
    }

    /** 当前会话最后一条已定稿助手消息的 messageId（动作行按钮已移除后，自动播报靠它判断）。 */
    function latestAssistantMessageId(useChat) {
      if (typeof useChat !== 'function') return undefined;
      try {
        return useChat((snapshot) => {
          try {
            for (let i = snapshot.order.length - 1; i >= 0; i -= 1) {
              const node = snapshot.nodes.get(snapshot.order[i]);
              const finalNode = node?.data?.finalNode;
              if (finalNode?.messageId) return finalNode.messageId;
            }
          } catch {
            /* 忽略 */
          }
          return undefined;
        });
      } catch {
        return undefined;
      }
    }

    /** DOM 兜底：从动作行往上找最近的前置文本节点。 */
    function textFromDom(el) {
      try {
        if (!el) return '';
        const row = el.closest('[data-turn-tail]');
        if (!row) return '';
        let sibling = row.previousElementSibling;
        while (sibling) {
          const text = (sibling.innerText ?? '').trim();
          if (text) return text;
          sibling = sibling.previousElementSibling;
        }
        let parent = row.parentElement;
        for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
          let prev = parent.previousElementSibling;
          while (prev) {
            const text = (prev.innerText ?? '').trim();
            if (text) return text;
            prev = prev.previousElementSibling;
          }
        }
      } catch {
        /* 忽略 */
      }
      return '';
    }

    /* -------------------------------------------------------------- 图标 */

    function SpeakerIcon(props) {
      const size = props?.size ?? 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.2 6.1h1.9L8 3.6c.5-.4 1.2-.1 1.2.5v7.8c0 .6-.7.9-1.2.5L5.1 9.9H3.2a.8.8 0 0 1-.8-.8V6.9c0-.4.4-.8.8-.8Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M11.3 5.4a3.7 3.7 0 0 1 0 5.2',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M12.9 3.8a5.9 5.9 0 0 1 0 8.4',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
        }),
      );
    }

    function StopIcon(props) {
      const size = props?.size ?? 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: '4.2', y: '4.2', width: '7.6', height: '7.6', rx: '1.2', fill: 'currentColor' }),
      );
    }

    function CaretIcon(props) {
      const size = props?.size ?? 12;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 4.8 6 7.8l3-3', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    /* ------------------------------------------------------------ 设置菜单 */

    function SettingsMenu(props) {
      const { anchor, prefs, voices, onChange, onClose, t } = props;
      const ref = React.useRef(null);
      React.useEffect(() => {
        const onDoc = (event) => {
          if (ref.current && !ref.current.contains(event.target)) onClose();
        };
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDoc, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [onClose]);
      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        borderRadius: '6px',
        whiteSpace: 'nowrap',
      };
      const voiceRow = {
        ...rowStyle,
        cursor: 'pointer',
        justifyContent: 'space-between',
      };
      return h(
        'div',
        {
          ref,
          style: {
            position: 'fixed',
            left: `${anchor.x}px`,
            top: `${anchor.y}px`,
            minWidth: '190px',
            maxHeight: '320px',
            overflowY: 'auto',
            padding: '6px',
            borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
            background: 'var(--dsw-alias-bg-elevated, #2a2a2a)',
            boxShadow: '0 8px 24px rgba(0,0,0,.28)',
            zIndex: 10000,
          },
        },
        h(
          'div',
          {
            style: rowStyle,
            onClick: () => onChange({ ...prefs, auto: !prefs.auto }),
          },
          h('span', { style: { flex: '1' } }, t('auto')),
          h('span', { style: { opacity: prefs.auto ? 1 : 0.35 } }, prefs.auto ? '✓' : '○'),
        ),
        h('div', {
          style: { height: '1px', margin: '4px 8px', background: 'var(--dsw-alias-border-secondary, rgba(127,127,127,.25))' },
        }),
        h('div', { style: { ...rowStyle, cursor: 'default', opacity: 0.7, paddingBottom: '2px' } }, t('voice')),
        ...(Array.isArray(voices) ? voices : []).map((voice) =>
          h(
            'div',
            {
              key: voice,
              style: voiceRow,
              onClick: () => onChange({ ...prefs, voice }),
            },
            h('span', null, voice),
            h('span', { style: { opacity: prefs.voice === voice ? 1 : 0.25 } }, '✓'),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------- 侧边栏面板 */

    /** 侧边栏与「更多」菜单里用的图标。 */
    function PanelIcon(props) {
      const size = props?.size ?? 18;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.2 6.1h1.9L8 3.6c.5-.4 1.2-.1 1.2.5v7.8c0 .6-.7.9-1.2.5L5.1 9.9H3.2a.8.8 0 0 1-.8-.8V6.9c0-.4.4-.8.8-.8Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M11.3 5.4a3.7 3.7 0 0 1 0 5.2',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
        }),
      );
    }

    const VOICE_FALLBACK = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
    const PANEL_ID = 'mimo-tts';

    function createSettingsPage() {
      return function SpeechSettingsPage(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
        const [prefs, setPrefs] = React.useState(readPrefs);
        const [voices, setVoices] = React.useState(VOICE_FALLBACK);
        const [testText, setTestText] = React.useState('你好，这是小米 MiMo 语音合成的试听。');
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        const [playing, setPlaying] = React.useState(player.messageId === '__preview__');

        React.useEffect(() => subscribe(() => setPlaying(player.messageId === '__preview__')), []);

        React.useEffect(() => {
          let alive = true;
          fetch(`${API}/config`, { credentials: 'same-origin', cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (alive && data && Array.isArray(data.voices) && data.voices.length) setVoices(data.voices);
            })
            .catch(() => {});
          return () => {
            alive = false;
          };
        }, []);

        const update = (patch) => {
          const next = { ...prefs, ...patch };
          setPrefs(next);
          writePrefs(next);
        };

        const preview = async () => {
          if (playing) {
            stopPlayback();
            return;
          }
          setError('');
          setBusy(true);
          try {
            await speakText(testText, prefs, '__preview__');
          } catch (cause) {
            setError(String(cause?.message ?? cause));
          } finally {
            setBusy(false);
          }
        };

        const card = {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'var(--dsw-alias-bg-layer-1)',
          padding: '14px 16px',
          marginBottom: '14px',
        };
        const sectionTitle = {
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--dsw-alias-label-primary)',
          marginBottom: '8px',
        };
        const hint = { fontSize: '11px', lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)', marginTop: '4px' };
        const inputStyle = {
          width: '100%',
          boxSizing: 'border-box',
          minHeight: '30px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          padding: '5px 8px',
          fontSize: '12px',
          fontFamily: 'inherit',
        };
        const radioRow = (title, desc, checked, onClick) =>
          h(
            'div',
            {
              onClick,
              style: {
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
                padding: '8px 10px',
                marginBottom: '6px',
                borderRadius: '8px',
                cursor: 'pointer',
                border: `1px solid ${checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
                background: checked ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              },
            },
            h('span', {
              style: {
                width: '14px',
                height: '14px',
                marginTop: '2px',
                borderRadius: '999px',
                flex: 'none',
                border: `2px solid ${checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
                boxSizing: 'border-box',
              },
            }),
            h(
              'div',
              null,
              h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)' } }, title),
              h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } }, desc),
            ),
          );
        const button = (label, onClick, primary) =>
          h(
            'button',
            {
              type: 'button',
              onClick,
              disabled: busy && primary,
              style: {
                height: '28px',
                padding: '0 12px',
                borderRadius: '6px',
                border: primary ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2)',
                background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            label,
          );

        return h(
          'div',
          { style: { height: '100%', overflowY: 'auto', padding: '22px 26px 40px' } },
          h(
            'div',
            { style: { maxWidth: '760px' } },
            h('div', { style: { fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('pageTitle')),
            h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '4px', marginBottom: '16px' } }, t('pageSubtitle')),

            h('div', { style: card },
              h('div', { style: sectionTitle }, t('modelLabel')),
              radioRow(t('modelBuiltin'), t('modelBuiltinDesc'), prefs.model === 'mimo-v2.5-tts', () => update({ model: 'mimo-v2.5-tts' })),
              radioRow(t('modelDesign'), t('modelDesignDesc'), prefs.model === 'mimo-v2.5-tts-voicedesign', () => update({ model: 'mimo-v2.5-tts-voicedesign' })),
              radioRow(t('modelClone'), t('modelCloneDesc'), prefs.model === 'mimo-v2.5-tts-voiceclone', () => update({ model: 'mimo-v2.5-tts-voiceclone' })),
            ),

            prefs.model === 'mimo-v2.5-tts'
              ? h('div', { style: card },
                  h('div', { style: sectionTitle }, t('voice')),
                  h(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px' } },
                    ...voices.map((voice) =>
                      h(
                        'button',
                        {
                          key: voice,
                          type: 'button',
                          onClick: () => update({ voice }),
                          style: {
                            height: '30px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer',
                            border: `1px solid ${prefs.voice === voice ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
                            background: prefs.voice === voice ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                            color: 'var(--dsw-alias-label-primary)',
                          },
                        },
                        voice,
                      ),
                    ),
                  ),
                )
              : null,

            prefs.model === 'mimo-v2.5-tts-voicedesign'
              ? h('div', { style: card },
                  h('div', { style: sectionTitle }, t('designLabel')),
                  h('textarea', {
                    value: prefs.voiceDesign,
                    placeholder: t('designPlaceholder'),
                    onChange: (event) => update({ voiceDesign: event.target.value }),
                    style: { ...inputStyle, minHeight: '76px', resize: 'vertical', lineHeight: '18px' },
                  }),
                  h('div', { style: hint }, t('designHint')),
                )
              : null,

            prefs.model === 'mimo-v2.5-tts-voiceclone'
              ? h('div', { style: card },
                  h('div', { style: sectionTitle }, t('sampleLabel')),
                  h('input', {
                    value: prefs.voiceSamplePath,
                    placeholder: t('samplePlaceholder'),
                    onChange: (event) => update({ voiceSamplePath: event.target.value }),
                    style: inputStyle,
                  }),
                  h('div', { style: hint }, t('sampleHint')),
                )
              : null,

            h('div', { style: card },
              h('div', { style: sectionTitle }, t('autoRow')),
              radioRow(t('autoOn'), t('freeNote'), prefs.auto === true, () => update({ auto: true })),
              radioRow(t('autoOff'), '', prefs.auto !== true, () => update({ auto: false })),
            ),

            h('div', { style: card },
              h('div', { style: sectionTitle }, t('testLabel')),
              h('textarea', {
                value: testText,
                placeholder: t('testPlaceholder'),
                onChange: (event) => setTestText(event.target.value),
                style: { ...inputStyle, minHeight: '56px', resize: 'vertical', lineHeight: '18px' },
              }),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } },
                button(playing ? t('testStop') : busy ? t('loading') : t('testButton'), preview, true),
                error ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
              ),
            ),

            h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('freeNote')),
          ),
        );
      };
    }

    /* -------------------------------------------------------- 动作行按钮 */

    function createAction() {
      return function MimoTtsAction(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
        const messageId = props.messageId;
        const buttonRef = React.useRef(null);
        const [prefs, setPrefs] = React.useState(readPrefs);
        const [voices, setVoices] = React.useState(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']);
        const [busy, setBusy] = React.useState(false);
        const [playing, setPlaying] = React.useState(() => player.messageId === messageId);
        const [menuAnchor, setMenuAnchor] = React.useState(null);
        const [error, setError] = React.useState('');
        // 在渲染期取一次消息文本（useChat 只能在渲染期调用），点击/自动播报时复用。
        const snapshotText = textFromSnapshot(props.useChat, messageId);
        const latestMessageId = latestAssistantMessageId(props.useChat);

        React.useEffect(() => subscribe(() => setPlaying(player.messageId === messageId)), [messageId]);

        React.useEffect(() => {
          let alive = true;
          fetch(`${API}/config`, { credentials: 'same-origin', cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (alive && data && Array.isArray(data.voices) && data.voices.length) setVoices(data.voices);
            })
            .catch(() => {});
          return () => {
            alive = false;
          };
        }, []);

        const resolveText = React.useCallback(() => {
          if (snapshotText) return snapshotText;
          return textFromDom(buttonRef.current);
        }, [snapshotText]);

        const toggle = React.useCallback(async () => {
          setError('');
          if (player.messageId === messageId) {
            stopPlayback();
            return;
          }
          const text = resolveText();
          if (!text) {
            setError(t('failed'));
            return;
          }
          setBusy(true);
          try {
            await speakText(text, prefs, messageId);
          } catch (err) {
            setError(String(err?.message ?? err));
          } finally {
            setBusy(false);
          }
        }, [messageId, prefs.voice, resolveText, t]);

        const openMenu = React.useCallback(() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (!rect) return;
          setMenuAnchor({ x: Math.max(8, Math.min(window.innerWidth - 210, rect.left - 150)), y: rect.bottom + 6 });
        }, []);

        // 自动播报：动作行按钮已移除，触发条件改为「本条就是最后一条已定稿回答」；页面刚打开时不动。
        React.useEffect(() => {
          if (!prefs.auto) return undefined;
          if (Date.now() - BOOT_AT < AUTO_WARMUP_MS) return undefined;
          if (latestMessageId === undefined || latestMessageId !== messageId) return undefined;
          let cancelled = false;
          const timer = window.setTimeout(async () => {
            if (cancelled || player.messageId !== null) return;
            const text = resolveText();
            if (!text) return;
            try {
              await speakText(text, prefs, messageId);
            } catch {
              /* 自动播报失败保持安静 */
            }
          }, 400);
          return () => {
            cancelled = true;
            window.clearTimeout(timer);
          };
          // 只在挂载时判断一次
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        const label = playing ? t('stop') : busy ? t('loading') : t('speak');
        const buttonStyle = {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          padding: '0 1px',
          margin: '0',
          height: '20px',
          width: '20px',
          color: 'inherit',
          opacity: busy ? 0.5 : 0.72,
          cursor: 'pointer',
          borderRadius: '4px',
        };

        return null;
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mimo-tts: dictionaries');
          }
        } catch {
          /* 忽略：无 locale 服务时按钮仍可用 */
        }
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
        const tr = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] ?? key;
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.assistant-actions',
              id: 'mimo-tts',
              order: 5,
              locale: NS,
              label: () => '播报',
            },
            createAction(),
          ),
        );
        // 侧边栏入口（与插件市场/工具箱同列的图标）+ 对应的主面板页面。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              locale: NS,
              label: () => tr('panel'),
            },
            PanelIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            createSettingsPage(),
          ),
        );
      },
    };
  },
});
