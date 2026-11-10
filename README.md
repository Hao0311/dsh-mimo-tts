# dsh-mimo-tts

小米 MiMo TTS（`mimo-v2.5-tts`，目前官方标为限时免费）在 DeepSeek Harness 里的两种用法：

1. **模型工具 `mimo_tts`**：模型把文字合成为本地音频文件（wav / mp3），返回路径。
2. **Web GUI 播报按钮**：每条已定稿助手回答的动作行（复制旁边）多一个 🔊 按钮，点一下就朗读这条回答；右侧 ▾ 里可以开「自动播报新回答」和选音色。

## 安装

```sh
dsh plugin --profile web add github:Hao0311/dsh-mimo-tts
```

> 不要用 `dsh plugin add dsh-mimo-tts` 直装：npm 上没有对应安装包（404），
> 且 `lengmodkx/dsh-mimo-tts` 与本插件**同包名**，两者不能同时安装。

本仓库/目录形态（开发时）：

```sh
dsh plugin --profile web add link:D:/Workspaces/DSH/plugins/dsh-mimo-tts
```

## 配置

需要一个小米 MiMo API Key，插件按以下顺序读取：

1. DSH 凭据服务里的 `XIAOMI_API_KEY`（设置页或 `~/.dsh/.credentials.yaml`）
2. 进程环境变量 `XIAOMI_API_KEY`
3. `$DSH_HOME/.credentials.yaml` 里的 `XIAOMI_API_KEY`

可选环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `MIMO_TTS_MODEL` | `mimo-v2.5-tts` | 模型 id（换成 voicedesign / voiceclone 可解锁自定义音色，但流式未开放） |
| `MIMO_TTS_BASE` | `https://api.xiaomimimo.com/v1` | OpenAI 兼容端点 |
| `DSH_MIMO_TTS_DIR` | `$DSH_HOME/tts` | 工具生成的音频落盘目录 |

## 两个入口分别做什么

### 工具 `mimo_tts`

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 待朗读文字，上限 4000 字 |
| `voice` | 否 | `mimo_default` / `冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / `Chloe` / `Milo` / `Dean` |
| `style` | 否 | 自然语言风格提示，例如「温柔、放慢语速」「新闻播报」 |
| `format` | 否 | `wav`（默认，可算时长）/ `mp3`（体积小） |

返回音频绝对路径、字节数、时长（wav 可算）等。

### 行内播报（Web GUI）

- 按钮位置：已定稿助手消息动作行，位于官方「复制」之后、「反馈 / 分支」之前，与「用量」同排。
- 点击：请求宿主 `/api/mimo-tts/speak`，拿回音频字节直接播放；再点停止。**API Key 不进浏览器**。
- ▾ 菜单：自动播报开关 + 音色选择，偏好存在浏览器 `localStorage`（`dsh-mimo-tts:prefs`）。
- 自动播报只对「开启之后新结束的回答」生效，不会在打开页面时朗读历史消息。

## 宿主路由（Host 侧）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/mimo-tts/speak` | POST | `{text, voice?, style?, format?}` → 音频字节（`audio/mpeg` 或 `audio/wav`） |
| `/api/mimo-tts/config` | GET | 可选音色、默认音色、字数上限、模型 id |

## 兼容性

- 依赖 Host 的 `connection.fetch` 注册路由，因此只在 Web profile 有意义；headless 下会因缺少 `connection` 服务而不加载。
- 浏览器侧依赖 `conversation.chat.assistant-actions` 这个 Slot（官方 `@deepseek-ai/dsh-client-ui-chat` 声明）。宿主升级若改掉该 Slot 名，按钮会消失但工具仍可用。
- 文字优先从 Chat 快照按 `messageId` 取；取不到时退化到 DOM 近似提取，因此老版本宿主也能用，但极少数布局下可能多/少读一段。

## 已知限制

- 非流式合成：长文本要等整段合成完才播放（官方流式接口存在，但工具形态下收益有限）。
- 只播放，不落盘到工作区；需要文件请用 `mimo_tts` 工具。
- 音频长度上限由模型与超时（120s）共同决定，超长文本请分段。

## 许可

MIT。


## 三种合成模型 + 侧边栏「语音设置」

插件支持 MiMo 的三个 TTS 模型，区别只在「音色从哪来」：

| 模型 | 音色来源 | 需要填 |
|---|---|---|
| `mimo-v2.5-tts` | 9 个内置音色 | 音色名（默认 `mimo_default` = 中国集群的「冰糖」） |
| `mimo-v2.5-tts-voicedesign` | 一段文字描述 | `voiceDesign`，例如「低沉、语速很慢的老年男声」 |
| `mimo-v2.5-tts-voiceclone` | mp3 / wav 样本 | `voiceSamplePath`，本机绝对路径，≤10MB |

侧边栏新增一个 **「语音设置」** 面板（图标在「插件市场 / 工具箱」那一列）：

- 选模型、选内置音色、填音色描述或样本路径
- 自动播报开关
- 试听：直接输入一段文字合成并播放，不用发消息
- 设置存在浏览器 `localStorage`（`dsh-mimo-tts:prefs`），换设备不跟随

回答动作行的 🔊 按钮和 ▾ 快速菜单都会用这里的设置；▾ 里也能快速切内置音色。

### 计费

MiMo TTS 目前官方标为**限时免费**（三个模型同一个计费口径），免费期结束后按平台账单计费。沿用已配置的 `XIAOMI_API_KEY`（与 MiMo 大模型共用同一个 key），无需另外申请。
## 2026-11-06 变更：移除动作行播报按钮

主窗口回答动作行的 🔊 按钮**已移除**（用户不喜欢）。播报相关能力全部收进侧边栏「语音设置」：

- 自动播报开关（只对新结束的回答生效）
- 试听
- 三种模型与音色设置

`mimo_tts` 模型工具不受影响，仍然可用。