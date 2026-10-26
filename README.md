# plugins-streamdeck

*[Português](#português) | [English](#english)*

---

## Português

Plugins para o **Rise Mode Vision 01 Sound**, um dispositivo compatível com o SDK do **HotSpot StreamDock** (clone da arquitetura Elgato Stream Deck). Transformam o dispositivo num painel de controle de **Spotify**, **Discord** e **Claude Code**: capa do álbum, volume, seek, shuffle, mute/deafen/câmera, cotas de uso do plano Claude e um mascote animado.

### Plugins

Cada serviço é um único plugin com várias actions, então aparece como uma só categoria na lista do StreamDock.

| Plugin | Actions |
|---|---|
| [`spotify.sdPlugin`](spotify.sdPlugin/README.md) | **Now Playing** (capa do álbum com animação de play/pause e transição entre faixas), **Volume / Mute** (knob), **Seek ±5s** (knob), **Shuffle** (ícone verde quando ativo) e **Queue** (atalho Alt+Shift+Q) |
| [`discord.sdPlugin`](discord.sdPlugin/README.md) | **Mute**, **Deafen**, **Camera** e **Hang Up** — traz o Discord para a frente, envia o atalho e devolve o foco à janela anterior |
| [`claude-usage.sdPlugin`](claude-usage.sdPlugin/README.md) | **Claude Session (5h)** e **Claude Weekly**: anel de progresso do uso real do plano Pro/Max, atualizado em tempo real; clique alterna entre % usado e tempo até o reset |
| [`clawd.sdPlugin`](clawd.sdPlugin/manifest.json) | Clawd, o mascote pixelado do Claude Code: anda entre os botões onde for colocado e reage ao estado do Claude Code (ocioso, trabalhando etc.); clique para cumprimentá-lo |

### De onde vêm os dados

| Plugin | Fonte | Observações |
|---|---|---|
| Spotify | **Spotify Web API** (OAuth: Client ID, Client Secret, Refresh Token) | Exige conta **Premium** para os comandos de reprodução. Credenciais em `plugin/config.js` (não versionado). Todas as actions compartilham o mesmo token. Queue é a exceção: simula um atalho de teclado |
| Discord | Atalhos de teclado simulados | Os atalhos precisam estar configurados no Discord. Se o app estiver só na bandeja, nada acontece |
| Claude Usage | Endpoint OAuth de uso do próprio Claude Code (`/api/oauth/usage`), com fallback para `claude -p "/usage"` | Atualização em tempo real: observa `~/.claude/projects` e rebusca ~1,5 s após qualquer atividade, mais um poll de segurança de 30 s |
| Clawd | Estado local do Claude Code | Sem API externa |

### Migração do AutoHotkey

O antigo `comandos.ahk` (teclas F18–F23) foi substituído por botões, sem AutoHotkey rodando:

| Antigo | Agora |
|---|---|
| F18 | Spotify → **Shuffle** (via Web API, sem simular tecla) |
| F19 | Spotify → **Queue** (Alt+Shift+Q) |
| F20 | Discord → **Mute** (Ctrl+Shift+M) |
| F21 | Discord → **Deafen** (Ctrl+Shift+D) |
| F22 | Discord → **Camera** (Ctrl+Shift+V, depois Enter) |
| F23 | Discord → **Hang Up** (Ctrl+Shift+E) |

Para os botões de atalho, um processo PowerShell auxiliar fica aberto (usa `user32.dll` para trocar o foco e enviar as teclas), então só o primeiro clique após abrir o app é mais lento.

### Arquitetura

Cada pasta `*.sdPlugin` é um plugin autocontido: `manifest.json` declara suas actions e o plugin roda como **um processo Node.js** (`plugin/index.js`), comunicando com o host via WebSocket. O build empacota tudo num bundle único (via [`ncc`](https://github.com/vercel/ncc)) e o publica em `%APPDATA%\HotSpot\StreamDock\plugins\`.

- **Várias actions por plugin.** `spotify` e `discord` hospedam todas as suas actions no mesmo processo. Cada recurso fica em `plugin/features/` (Spotify) ou numa tabela em `plugin/index.js` (Discord) e se registra com `plugin.registerAction(uuid, new Actions({...}))`.
- **Despacho por UUID completo.** O código base do SDK roteava eventos pelo último trecho do UUID (`...action1`). Como vários UUIDs terminam em `action1`, o `plugin/utils/plugin.js` desses plugins consulta primeiro o UUID completo. Os UUIDs antigos foram mantidos, então botões já posicionados continuam funcionando.
- **Autenticação compartilhada (Spotify).** `plugin/spotifyApi.js` guarda as funções HTTP e um único token de acesso, renovado uma vez para todas as actions.

#### Adicionar uma action

1. Declare-a em `manifest.json` (UUID único, ícone, `Controllers`, `PropertyInspectorPath`) e crie `propertyInspector/<nome>/index.html`.
2. Crie `plugin/features/<nome>.js` (ou uma entrada na tabela do Discord) e chame `plugin.registerAction('<uuid>', new Actions({...}))`.
3. No Spotify, adicione o `require` correspondente em `plugin/index.js`.
4. Rode o build.

### Build

Em cada plugin:

```powershell
cd <plugin>.sdPlugin\plugin
npm install
npm run build
```

Feche o Rise Mode Controller / StreamDock completamente antes do build, senão o deploy falha com `EBUSY` e o plugin aparece com ícone de interrogação. Requisitos, credenciais e detalhes ficam no README de cada plugin.

### Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Plugin com ícone de interrogação | Build feito com o app aberto (`EBUSY`). Feche o app, rode o build de novo e reabra |
| Botão vazio depois de atualizar | Arraste a action de novo da lista (categoria **Spotify** ou **Discord**) |
| Botão de atalho não faz nada | O app (Discord/Spotify) está só na bandeja, sem janela visível, ou o atalho não está configurado nele |
| Volume ou seek não respondem ao knob | O formato do evento `dialRotate` não é documentado; veja o payload bruto em `plugin/log/*.log` e ajuste `rotationSign()` |
| Qualquer erro | Log em `plugin/log/*.log`, dentro da pasta instalada do plugin |

### Licença

Distribuído sob a licença [MIT](LICENSE).

---

## English

Plugins for the **Rise Mode Vision 01 Sound**, a device compatible with the **HotSpot StreamDock** SDK (a clone of the Elgato Stream Deck architecture). They turn the device into a control panel for **Spotify**, **Discord**, and **Claude Code**: album art, volume, seek, shuffle, mute/deafen/camera, Claude plan usage quotas, and an animated mascot.

### Plugins

Each service is a single plugin with several actions, so it shows up as one category in the StreamDock list.

| Plugin | Actions |
|---|---|
| [`spotify.sdPlugin`](spotify.sdPlugin/README.md) | **Now Playing** (album art with play/pause animation and a transition between tracks), **Volume / Mute** (knob), **Seek ±5s** (knob), **Shuffle** (green icon when on) and **Queue** (Alt+Shift+Q hotkey) |
| [`discord.sdPlugin`](discord.sdPlugin/README.md) | **Mute**, **Deafen**, **Camera** and **Hang Up** — brings Discord to the front, sends the hotkey, and returns focus to the previous window |
| [`claude-usage.sdPlugin`](claude-usage.sdPlugin/README.md) | **Claude Session (5h)** and **Claude Weekly**: progress ring for real Pro/Max plan usage, updated in real time; click toggles between % used and time until reset |
| [`clawd.sdPlugin`](clawd.sdPlugin/manifest.json) | Clawd, the pixel-art Claude Code mascot: walks across whichever buttons he is placed on and reacts to Claude Code's state (idle, working, etc.); click to say hi |

### Where the data comes from

| Plugin | Source | Notes |
|---|---|---|
| Spotify | **Spotify Web API** (OAuth: Client ID, Client Secret, Refresh Token) | Needs a **Premium** account for playback commands. Credentials in `plugin/config.js` (untracked). All actions share one token. Queue is the exception: it simulates a keyboard hotkey |
| Discord | Simulated keyboard hotkeys | The hotkeys must be configured in Discord. If the app is only in the tray, nothing happens |
| Claude Usage | Claude Code's own OAuth usage endpoint (`/api/oauth/usage`), falling back to `claude -p "/usage"` | Real-time: watches `~/.claude/projects` and re-fetches ~1.5 s after any activity, plus a 30 s safety-net poll |
| Clawd | Local Claude Code state | No external API |

### AutoHotkey migration

The old `comandos.ahk` (F18–F23 keys) was replaced by buttons, with no AutoHotkey running:

| Old | Now |
|---|---|
| F18 | Spotify → **Shuffle** (via Web API, no simulated keys) |
| F19 | Spotify → **Queue** (Alt+Shift+Q) |
| F20 | Discord → **Mute** (Ctrl+Shift+M) |
| F21 | Discord → **Deafen** (Ctrl+Shift+D) |
| F22 | Discord → **Camera** (Ctrl+Shift+V, then Enter) |
| F23 | Discord → **Hang Up** (Ctrl+Shift+E) |

For the hotkey buttons, a helper PowerShell process stays open (using `user32.dll` to switch focus and send keystrokes), so only the first press after the app opens is slower.

### Architecture

Each `*.sdPlugin` folder is a self-contained plugin: `manifest.json` declares its actions and the plugin runs as **one Node.js process** (`plugin/index.js`), communicating with the host over WebSocket. The build bundles everything into a single file (via [`ncc`](https://github.com/vercel/ncc)) and deploys it to `%APPDATA%\HotSpot\StreamDock\plugins\`.

- **Several actions per plugin.** `spotify` and `discord` host all their actions in the same process. Each feature lives in `plugin/features/` (Spotify) or in a table in `plugin/index.js` (Discord) and registers itself with `plugin.registerAction(uuid, new Actions({...}))`.
- **Dispatch by full UUID.** The SDK's base code routed events by the last segment of the UUID (`...action1`). Since several UUIDs end in `action1`, these plugins' `plugin/utils/plugin.js` look up the full UUID first. The old UUIDs were kept, so buttons already placed keep working.
- **Shared authentication (Spotify).** `plugin/spotifyApi.js` holds the HTTP helpers and a single access token, refreshed once for all actions.

#### Adding an action

1. Declare it in `manifest.json` (unique UUID, icon, `Controllers`, `PropertyInspectorPath`) and create `propertyInspector/<name>/index.html`.
2. Create `plugin/features/<name>.js` (or an entry in Discord's table) and call `plugin.registerAction('<uuid>', new Actions({...}))`.
3. For Spotify, add the matching `require` in `plugin/index.js`.
4. Run the build.

### Build

In each plugin:

```powershell
cd <plugin>.sdPlugin\plugin
npm install
npm run build
```

Fully close Rise Mode Controller / StreamDock before building, otherwise the deploy step fails with `EBUSY` and the plugin shows a question-mark icon. Requirements, credentials, and details are in each plugin's own README.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Plugin shows a question-mark icon | Built while the app was open (`EBUSY`). Close the app, rebuild, and reopen |
| Empty button after an update | Drag the action again from the list (**Spotify** or **Discord** category) |
| A hotkey button does nothing | The app (Discord/Spotify) is only in the tray with no visible window, or the hotkey isn't configured in it |
| Volume or seek ignore the knob | The `dialRotate` event format isn't documented; check the raw payload in `plugin/log/*.log` and adjust `rotationSign()` |
| Any other error | Log in `plugin/log/*.log`, inside the plugin's installed folder |

### License

Distributed under the [MIT](LICENSE) license.
