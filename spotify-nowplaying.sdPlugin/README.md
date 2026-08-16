# spotify-nowplaying.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Exibe a capa do álbum em reprodução no Spotify diretamente no botão, com animação de play/pause e transição entre faixas. Action do tipo **Keypad/Information** (botão com tela) — não é exposta como opção para Knob.

- Clique no botão: alterna play/pause (ou abre o Spotify, caso esteja fechado)
- Capa colorida indica reprodução ativa; capa em preto e branco, reduzida, indica pausa

### Requisitos

- Node.js instalado, para executar `npm run build`
- Conta Spotify Premium (necessária para os comandos de play/pause via Web API)
- Credenciais de um app no Spotify Developer Dashboard (Client ID, Client Secret e Refresh Token) — ver seção abaixo

Os plugins [`spotify-volume.sdPlugin`](../spotify-volume.sdPlugin/README.md) e [`spotify-seek.sdPlugin`](../spotify-seek.sdPlugin/README.md) reutilizam as mesmas credenciais geradas aqui; não é necessário repetir o fluxo de autorização para cada um.

### Configuração das credenciais Spotify

O plugin requer um Client ID, Client Secret e Refresh Token do Spotify. Esses valores residem em `plugin/config.js`, que **não é versionado** (está listado em `.gitignore`) — cada instalação precisa gerar os seus próprios.

**1. Criar um app no Spotify Developer Dashboard**

1. Acesse https://developer.spotify.com/dashboard e autentique-se
2. Clique em "Create app"
3. Em "Redirect URI", adicione: `http://127.0.0.1:8888/callback`
4. Marque a API "Web API"
5. Salve e copie o **Client ID** e o **Client Secret** (em "Settings")

**2. Obter o Refresh Token**

A partir de `spotify-nowplaying.sdPlugin/plugin/`, execute:

```powershell
node spotify_auth.js SEU_CLIENT_ID SEU_CLIENT_SECRET
```

O script abre o navegador para autorização na conta Spotify. Ao concluir, o terminal imprime o `REFRESH_TOKEN` obtido — copie esse valor.

**3. Criar o config.js**

Copie o template e preencha com os valores obtidos:

```powershell
cd spotify-nowplaying.sdPlugin\plugin
copy config.example.js config.js
```

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'seu client id',
    SPOTIFY_CLIENT_SECRET: 'seu client secret',
    SPOTIFY_REFRESH_TOKEN: 'seu refresh token',
    SPOTIFY_EXE: 'C:\\Caminho\\Para\\Spotify.exe' // caminho do executável do Spotify na máquina local
};
```

### Build e instalação

O build compila o plugin em um bundle único (via [`ncc`](https://github.com/vercel/ncc)) e o copia automaticamente para a pasta de plugins do StreamDock (`%APPDATA%\HotSpot\StreamDock\plugins\`).

```powershell
cd spotify-nowplaying.sdPlugin\plugin
npm install
npm run build
```

**Importante:** feche o Rise Mode Controller / StreamDock completamente antes de executar o build. Com o app aberto, o passo de deploy falha ao tentar substituir arquivos em uso (`EBUSY`), o que pode deixar a instalação incompleta e o plugin exibindo um ícone de interrogação no dispositivo. Reabra o app após o build.

Para confirmar que nenhum processo permaneceu ativo antes de buildar:

```powershell
tasklist | findstr /i "Rise"
```

Ausência de retorno confirma que é seguro prosseguir.

---

## English

Displays the currently playing Spotify album art directly on the button, with play/pause animation and a transition effect between tracks. A **Keypad/Information** action (screen button) — it is not exposed as a Knob option.

- Click the button: toggles play/pause (or launches Spotify, if it isn't running)
- Colored artwork indicates active playback; reduced, black-and-white artwork indicates a paused state

### Requirements

- Node.js installed, to run `npm run build`
- A Spotify Premium account (required for play/pause commands via the Web API)
- Credentials for an app registered in the Spotify Developer Dashboard (Client ID, Client Secret, and Refresh Token) — see below

The [`spotify-volume.sdPlugin`](../spotify-volume.sdPlugin/README.md) and [`spotify-seek.sdPlugin`](../spotify-seek.sdPlugin/README.md) plugins reuse the same credentials generated here; the authorization flow does not need to be repeated for each one.

### Configuring Spotify credentials

The plugin requires a Spotify Client ID, Client Secret, and Refresh Token. These values live in `plugin/config.js`, which is **not version-controlled** (it is listed in `.gitignore`) — each installation must generate its own.

**1. Create an app in the Spotify Developer Dashboard**

1. Go to https://developer.spotify.com/dashboard and log in
2. Click "Create app"
3. Under "Redirect URI", add: `http://127.0.0.1:8888/callback`
4. Check the "Web API" checkbox
5. Save, then copy the **Client ID** and **Client Secret** (under "Settings")

**2. Obtain the Refresh Token**

From `spotify-nowplaying.sdPlugin/plugin/`, run:

```powershell
node spotify_auth.js YOUR_CLIENT_ID YOUR_CLIENT_SECRET
```

The script opens a browser window for authorization against the Spotify account. Once complete, the terminal prints the resulting `REFRESH_TOKEN` — copy that value.

**3. Create config.js**

Copy the template and populate it with the values obtained above:

```powershell
cd spotify-nowplaying.sdPlugin\plugin
copy config.example.js config.js
```

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'your client id',
    SPOTIFY_CLIENT_SECRET: 'your client secret',
    SPOTIFY_REFRESH_TOKEN: 'your refresh token',
    SPOTIFY_EXE: 'C:\\Path\\To\\Spotify.exe' // path to Spotify's executable on the local machine
};
```

### Build and install

The build step compiles the plugin into a single bundle (via [`ncc`](https://github.com/vercel/ncc)) and copies it automatically to the StreamDock plugins directory (`%APPDATA%\HotSpot\StreamDock\plugins\`).

```powershell
cd spotify-nowplaying.sdPlugin\plugin
npm install
npm run build
```

**Important:** fully close Rise Mode Controller / StreamDock before running the build. With the app open, the deploy step fails while attempting to overwrite files in use (`EBUSY`), which can leave the installation incomplete and the plugin showing a question-mark icon on the device. Reopen the app once the build finishes.

To confirm no process is still running before building:

```powershell
tasklist | findstr /i "Rise"
```

No output confirms it is safe to proceed.
