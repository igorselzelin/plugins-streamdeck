# plugins-streamdeck

*[Português](#português) | [English](#english)*

---

## Português

Plugins para o **Rise Mode Vision 01 Sound**, um dispositivo compatível com o SDK do **HotSpot StreamDock** (clone da arquitetura Elgato Stream Deck). Cada capacidade é implementada como um plugin independente: controle completo do Spotify (capa, volume, seek) e integração com o Claude Code (cotas de uso e um mascote animado).

### Arquitetura

Cada pasta `*.sdPlugin` é um plugin autocontido: `manifest.json` declara suas actions e é executado como um processo Node.js separado (`plugin/index.js`), comunicando com o host via WebSocket. O build empacota cada plugin num bundle único (via [`ncc`](https://github.com/vercel/ncc)) e o publica em `%APPDATA%\HotSpot\StreamDock\plugins\`.

### Plugins

#### Spotify

Os três plugins falam com a **Spotify Web API** (OAuth com Client ID, Client Secret e Refresh Token) e exigem conta **Premium** para os comandos de reprodução. As credenciais são geradas uma única vez, no `spotify-nowplaying`, e reutilizadas pelos demais (cada plugin tem seu próprio `plugin/config.js`, não versionado).

| Plugin | Descrição |
|---|---|
| [`spotify-nowplaying.sdPlugin`](spotify-nowplaying.sdPlugin/README.md) | Exibe a capa do álbum em reprodução no botão, com animação de play/pause e transição entre faixas; clique alterna play/pause |
| [`spotify-volume.sdPlugin`](spotify-volume.sdPlugin/README.md) | Controle de volume via knob: rotação ajusta o volume (passos de 5%), pressionar alterna mute |
| [`spotify-seek.sdPlugin`](spotify-seek.sdPlugin/README.md) | Navegação temporal via knob: rotação avança/retrocede 5 segundos na faixa atual |

#### Claude Code

Não dependem de API externa: leem dados locais e o próprio CLI `claude`.

| Plugin | Descrição |
|---|---|
| [`claude-usage.sdPlugin`](claude-usage.sdPlugin/README.md) | Duas actions (**Claude Session (5h)** e **Claude Weekly**) com anel de progresso do uso real do plano Pro/Max, obtido via `claude -p "/usage"`; clique alterna entre % usado e tempo até o reset |
| [`clawd.sdPlugin`](clawd.sdPlugin/manifest.json) | Clawd, o mascote pixelado do Claude Code: animado, anda entre os botões onde for colocado e reage ao estado do Claude Code (ocioso, trabalhando etc.); clique para cumprimentá-lo |

### Build

Em cada plugin:

```powershell
cd <plugin>.sdPlugin\plugin
npm install
npm run build
```

Feche o Rise Mode Controller / StreamDock completamente antes do build, senão o deploy falha com `EBUSY`. Requisitos, credenciais e detalhes ficam no README de cada plugin.

### Licença

Distribuído sob a licença [MIT](LICENSE).

---

## English

Plugins for the **Rise Mode Vision 01 Sound**, a device compatible with the **HotSpot StreamDock** SDK (a clone of the Elgato Stream Deck architecture). Each capability is implemented as an independent plugin: full Spotify control (album art, volume, seek) and Claude Code integration (usage quotas and an animated mascot).

### Architecture

Each `*.sdPlugin` folder is a self-contained plugin: `manifest.json` declares its actions and runs as a separate Node.js process (`plugin/index.js`), communicating with the host over WebSocket. The build step bundles each plugin into a single file (via [`ncc`](https://github.com/vercel/ncc)) and deploys it to `%APPDATA%\HotSpot\StreamDock\plugins\`.

### Plugins

#### Spotify

All three plugins talk to the **Spotify Web API** (OAuth with Client ID, Client Secret, and Refresh Token) and require a **Premium** account for playback commands. Credentials are generated once, in `spotify-nowplaying`, and reused by the others (each plugin has its own untracked `plugin/config.js`).

| Plugin | Description |
|---|---|
| [`spotify-nowplaying.sdPlugin`](spotify-nowplaying.sdPlugin/README.md) | Displays the currently playing album art on the button, with play/pause animation and a transition between tracks; click toggles play/pause |
| [`spotify-volume.sdPlugin`](spotify-volume.sdPlugin/README.md) | Knob-based volume control: rotate to adjust volume (5% steps), press to toggle mute |
| [`spotify-seek.sdPlugin`](spotify-seek.sdPlugin/README.md) | Knob-based seeking: rotate to move ±5 seconds within the current track |

#### Claude Code

No external API needed: they read local data and the `claude` CLI itself.

| Plugin | Description |
|---|---|
| [`claude-usage.sdPlugin`](claude-usage.sdPlugin/README.md) | Two actions (**Claude Session (5h)** and **Claude Weekly**) with a progress ring for real Pro/Max plan usage, fetched via `claude -p "/usage"`; click toggles between % used and time until reset |
| [`clawd.sdPlugin`](clawd.sdPlugin/manifest.json) | Clawd, the pixel-art Claude Code mascot: animated, walks across whichever buttons he's placed on, and reacts to Claude Code's state (idle, working, etc.); click to say hi |

### Build

In each plugin:

```powershell
cd <plugin>.sdPlugin\plugin
npm install
npm run build
```

Fully close Rise Mode Controller / StreamDock before building, otherwise the deploy step fails with `EBUSY`. Requirements, credentials, and details are in each plugin's own README.

### License

Distributed under the [MIT](LICENSE) license.
