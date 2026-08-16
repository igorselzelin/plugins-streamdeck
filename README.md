# plugins-streamdeck

*[Português](#português) | [English](#english)*

---

## Português

Plugins para o **Rise Mode Vision 01 Sound**, um dispositivo compatível com o SDK do **HotSpot StreamDock** (clone da arquitetura Elgato Stream Deck). Cada capacidade é implementada como um plugin independente, transformando o dispositivo num controle dedicado de Spotify.

### Arquitetura

Cada pasta `*.sdPlugin` é um plugin autocontido: `manifest.json` declara suas actions e é executado como um processo Node.js separado (`plugin/index.js`), comunicando com o host via WebSocket. O build empacota cada plugin num bundle único (via [`ncc`](https://github.com/vercel/ncc)) e o publica em `%APPDATA%\HotSpot\StreamDock\plugins\`.

### Plugins

| Plugin | Descrição |
|---|---|
| [`spotify-nowplaying.sdPlugin`](spotify-nowplaying.sdPlugin/README.md) | Exibe a capa do álbum em reprodução no botão, com animação de play/pause e transição entre faixas |
| [`spotify-volume.sdPlugin`](spotify-volume.sdPlugin/README.md) | Controle de volume via knob: rotação ajusta o volume, pressionar alterna mute |
| [`spotify-seek.sdPlugin`](spotify-seek.sdPlugin/README.md) | Navegação temporal via knob: rotação avança/retrocede 5 segundos na faixa atual |

Requisitos, configuração de credenciais e instruções de build ficam documentados no README de cada plugin.

### Licença

Distribuído sob a licença [MIT](LICENSE).

---

## English

Plugins for the **Rise Mode Vision 01 Sound**, a device compatible with the **HotSpot StreamDock** SDK (a clone of the Elgato Stream Deck architecture). Each capability is implemented as an independent plugin, turning the device into a dedicated Spotify control surface.

### Architecture

Each `*.sdPlugin` folder is a self-contained plugin: `manifest.json` declares its actions and runs as a separate Node.js process (`plugin/index.js`), communicating with the host over WebSocket. The build step bundles each plugin into a single file (via [`ncc`](https://github.com/vercel/ncc)) and deploys it to `%APPDATA%\HotSpot\StreamDock\plugins\`.

### Plugins

| Plugin | Description |
|---|---|
| [`spotify-nowplaying.sdPlugin`](spotify-nowplaying.sdPlugin/README.md) | Displays the currently playing album art on the button, with play/pause animation and a transition between tracks |
| [`spotify-volume.sdPlugin`](spotify-volume.sdPlugin/README.md) | Knob-based volume control: rotate to adjust volume, press to toggle mute |
| [`spotify-seek.sdPlugin`](spotify-seek.sdPlugin/README.md) | Knob-based seeking: rotate to move ±5 seconds within the current track |

Requirements, credential setup, and build instructions are documented in each plugin's own README.

### License

Distributed under the [MIT](LICENSE) license.
