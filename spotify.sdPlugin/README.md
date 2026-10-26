# spotify.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Todos os controles do Spotify num plugin só (uma única categoria **Spotify** na lista de actions):

| Action | Tipo | O que faz |
|---|---|---|
| **Now Playing** | Keypad | Mostra a capa do álbum em reprodução, com animação de play/pause e transição entre faixas. Clique alterna play/pause (ou abre o Spotify, se estiver fechado). Capa colorida = tocando; preto e branco reduzida = pausado |
| **Volume / Mute** | Knob | Rotação ajusta o volume do Spotify em passos de 5%; pressionar alterna mute (o volume anterior é restaurado) |
| **Seek (±5s)** | Knob | Rotação avança/retrocede 5 segundos na faixa atual |
| **Shuffle** | Keypad | Liga/desliga o modo aleatório. Ícone cinza = desligado, verde = ligado; resincroniza a cada 15 s |
| **Queue** | Keypad | Traz o Spotify para a frente, envia **Alt+Shift+Q** e devolve o foco à janela anterior (substitui o antigo F19 do AutoHotkey). Se o Spotify estiver só na bandeja, nada acontece |

Volume, seek, shuffle e play/pause usam a **Spotify Web API** (OAuth) e exigem conta **Premium**. Todas as actions compartilham o mesmo token de acesso.

### Requisitos

- Node.js instalado, para executar `npm run build`
- Conta Spotify Premium
- Credenciais de um app no Spotify Developer Dashboard (Client ID, Client Secret e Refresh Token) — ver abaixo

### Configuração das credenciais Spotify

Os valores ficam em `plugin/config.js`, que **não é versionado** (está no `.gitignore`) — cada instalação gera os seus.

**1. Criar um app no Spotify Developer Dashboard**

1. Acesse https://developer.spotify.com/dashboard e autentique-se
2. Clique em "Create app"
3. Em "Redirect URI", adicione: `http://127.0.0.1:8888/callback`
4. Marque a API "Web API"
5. Salve e copie o **Client ID** e o **Client Secret** (em "Settings")

**2. Obter o Refresh Token**

A partir de `spotify.sdPlugin/plugin/`, execute:

```powershell
node spotify_auth.js SEU_CLIENT_ID SEU_CLIENT_SECRET
```

O script abre o navegador para autorização. Ao concluir, o terminal imprime o `REFRESH_TOKEN` — copie esse valor.

**3. Criar o config.js**

```powershell
cd spotify.sdPlugin\plugin
copy config.example.js config.js
```

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'seu client id',
    SPOTIFY_CLIENT_SECRET: 'seu client secret',
    SPOTIFY_REFRESH_TOKEN: 'seu refresh token',
    SPOTIFY_EXE: 'C:\\Caminho\\Para\\Spotify.exe' // usado pelo Now Playing para abrir o Spotify
};
```

### Build e instalação

O build compila o plugin num bundle único (via [`ncc`](https://github.com/vercel/ncc)) e o copia para `%APPDATA%\HotSpot\StreamDock\plugins\`.

```powershell
cd spotify.sdPlugin\plugin
npm install
npm run build
```

**Importante:** feche o Rise Mode Controller / StreamDock completamente antes do build. Com o app aberto, o deploy falha ao substituir arquivos em uso (`EBUSY`), o que pode deixar a instalação incompleta e o plugin com ícone de interrogação. Reabra o app depois.

```powershell
tasklist | findstr /i "Rise"
```

Ausência de retorno confirma que é seguro prosseguir.

### Nota técnica (knobs)

O formato exato do payload do evento `dialRotate` não é documentado publicamente para este SDK. A implementação assume a convenção da Elgato (`payload.ticks`, positivo = sentido horário), com alguns nomes de campo alternativos como fallback. Se volume ou seek não responderem como esperado à rotação, o payload bruto é registrado em `plugin/log/*.log` — ajuste `rotationSign()` em `plugin/features/volume.js` e `plugin/features/seek.js`.

### Estrutura

Um único processo hospeda todas as actions. Cada recurso fica em `plugin/features/` e registra seus handlers pelo UUID da action (`plugin.registerAction`) — necessário porque vários UUIDs terminam em `action1`. A autenticação compartilhada fica em `plugin/spotifyApi.js`.

---

## English

All the Spotify controls in a single plugin (one **Spotify** category in the action list):

| Action | Type | What it does |
|---|---|---|
| **Now Playing** | Keypad | Shows the current album art, with play/pause animation and a transition between tracks. Click toggles play/pause (or launches Spotify if it is closed). Colored art = playing; reduced black-and-white art = paused |
| **Volume / Mute** | Knob | Rotate to change Spotify's volume in 5% steps; press to toggle mute (the previous level is restored) |
| **Seek (±5s)** | Knob | Rotate to move ±5 seconds within the current track |
| **Shuffle** | Keypad | Toggles shuffle. Gray icon = off, green = on; re-syncs every 15 s |
| **Queue** | Keypad | Brings Spotify to the front, sends **Alt+Shift+Q**, and returns focus to the previous window (replaces the old AutoHotkey F19). If Spotify is only in the tray, nothing happens |

Volume, seek, shuffle and play/pause use the **Spotify Web API** (OAuth) and require a **Premium** account. All actions share the same access token.

### Requirements

- Node.js installed, to run `npm run build`
- A Spotify Premium account
- Credentials for an app registered in the Spotify Developer Dashboard (Client ID, Client Secret, Refresh Token) — see below

### Configuring Spotify credentials

The values live in `plugin/config.js`, which is **not version-controlled** (listed in `.gitignore`) — each installation generates its own.

**1. Create an app in the Spotify Developer Dashboard**

1. Go to https://developer.spotify.com/dashboard and log in
2. Click "Create app"
3. Under "Redirect URI", add: `http://127.0.0.1:8888/callback`
4. Check the "Web API" checkbox
5. Save, then copy the **Client ID** and **Client Secret** (under "Settings")

**2. Obtain the Refresh Token**

From `spotify.sdPlugin/plugin/`, run:

```powershell
node spotify_auth.js YOUR_CLIENT_ID YOUR_CLIENT_SECRET
```

The script opens a browser window for authorization. Once complete, the terminal prints the `REFRESH_TOKEN` — copy that value.

**3. Create config.js**

```powershell
cd spotify.sdPlugin\plugin
copy config.example.js config.js
```

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'your client id',
    SPOTIFY_CLIENT_SECRET: 'your client secret',
    SPOTIFY_REFRESH_TOKEN: 'your refresh token',
    SPOTIFY_EXE: 'C:\\Path\\To\\Spotify.exe' // used by Now Playing to launch Spotify
};
```

### Build and install

The build compiles the plugin into a single bundle (via [`ncc`](https://github.com/vercel/ncc)) and copies it to `%APPDATA%\HotSpot\StreamDock\plugins\`.

```powershell
cd spotify.sdPlugin\plugin
npm install
npm run build
```

**Important:** fully close Rise Mode Controller / StreamDock before building. With the app open, the deploy step fails while overwriting files in use (`EBUSY`), which can leave the install incomplete and the plugin showing a question-mark icon. Reopen the app afterward.

```powershell
tasklist | findstr /i "Rise"
```

No output confirms it is safe to proceed.

### Technical note (knobs)

The exact payload shape of the `dialRotate` event is not publicly documented for this SDK. The implementation assumes the Elgato convention (`payload.ticks`, positive = clockwise), with a few alternate field names as fallback. If volume or seek don't respond as expected to rotation, the raw payload is logged to `plugin/log/*.log` — adjust `rotationSign()` in `plugin/features/volume.js` and `plugin/features/seek.js`.

### Layout

A single process hosts all the actions. Each feature lives in `plugin/features/` and registers its handlers by action UUID (`plugin.registerAction`) — needed because several UUIDs end in `action1`. Shared authentication lives in `plugin/spotifyApi.js`.
