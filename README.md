# plugins-streamdeck

*[Português](#português) | [English](#english)*

---

## Português

Plugins para dispositivos StreamDock (compatível com HotSpot StreamDock / Rise Mode). Cada pasta `*.sdPlugin` neste repositório é um plugin independente.

### spotify-nowplaying.sdPlugin

Mostra a capa do álbum tocando no Spotify diretamente no botão, com animação de play/pause e transição entre faixas.

#### Configurar as credenciais do Spotify

O plugin precisa de um Client ID, Client Secret e Refresh Token do Spotify pra funcionar. Esses valores ficam em `plugin/config.js`, que **não é versionado** (está no `.gitignore`) — cada pessoa que rodar o plugin precisa gerar os seus próprios.

**1. Criar um app no Spotify Developer Dashboard**

1. Acesse https://developer.spotify.com/dashboard e faça login
2. Clique em "Create app"
3. Em "Redirect URI" adicione: `http://127.0.0.1:8888/callback`
4. Marque a API "Web API"
5. Salve e copie o **Client ID** e o **Client Secret** (em "Settings")

**2. Obter o Refresh Token**

Dentro de `spotify-nowplaying.sdPlugin/plugin/`, rode:

```powershell
node spotify_auth.js SEU_CLIENT_ID SEU_CLIENT_SECRET
```

Isso abre o navegador pra você autorizar o app na sua conta Spotify. Depois de autorizar, o terminal mostra o `REFRESH_TOKEN` obtido — copie esse valor.

**3. Criar o config.js**

Copie o template e preencha com os valores obtidos acima:

```powershell
cd spotify-nowplaying.sdPlugin\plugin
copy config.example.js config.js
```

Edite `config.js`:

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'seu client id',
    SPOTIFY_CLIENT_SECRET: 'seu client secret',
    SPOTIFY_REFRESH_TOKEN: 'seu refresh token',
    SPOTIFY_EXE: 'C:\\Caminho\\Para\\Spotify.exe' // caminho do executável do Spotify na sua máquina
};
```

#### Build e instalação

O build compila o plugin num único bundle (via [`ncc`](https://github.com/vercel/ncc)) e copia automaticamente para a pasta de plugins do StreamDock (`%APPDATA%\HotSpot\StreamDock\plugins\`).

```powershell
cd spotify-nowplaying.sdPlugin\plugin
npm install
npm run build
```

**Importante: feche o Rise Mode Controller / StreamDock completamente antes de rodar o build.** Se o app estiver aberto, o processo de deploy trava tentando substituir arquivos em uso (`EBUSY`), o que pode deixar a pasta instalada incompleta (plugin aparece com ícone de interrogação no dispositivo). Depois do build, abra o app novamente.

Para confirmar que nenhum processo ficou pendurado antes de buildar:

```powershell
tasklist | findstr /i "Rise"
```

Se não retornar nada, pode buildar com segurança.

---

## English

Plugins for StreamDock devices (compatible with HotSpot StreamDock / Rise Mode). Each `*.sdPlugin` folder in this repository is an independent plugin.

### spotify-nowplaying.sdPlugin

Displays the currently playing Spotify album art directly on the button, with play/pause animation and a transition effect between tracks.

#### Setting up your Spotify credentials

The plugin needs a Spotify Client ID, Client Secret, and Refresh Token to work. These values live in `plugin/config.js`, which is **not version-controlled** (it's in `.gitignore`) — anyone running the plugin needs to generate their own.

**1. Create an app in the Spotify Developer Dashboard**

1. Go to https://developer.spotify.com/dashboard and log in
2. Click "Create app"
3. Under "Redirect URI" add: `http://127.0.0.1:8888/callback`
4. Check the "Web API" checkbox
5. Save, then copy the **Client ID** and **Client Secret** (under "Settings")

**2. Get the Refresh Token**

Inside `spotify-nowplaying.sdPlugin/plugin/`, run:

```powershell
node spotify_auth.js YOUR_CLIENT_ID YOUR_CLIENT_SECRET
```

This opens your browser so you can authorize the app on your Spotify account. After authorizing, the terminal prints the `REFRESH_TOKEN` — copy that value.

**3. Create config.js**

Copy the template and fill it in with the values obtained above:

```powershell
cd spotify-nowplaying.sdPlugin\plugin
copy config.example.js config.js
```

Edit `config.js`:

```js
module.exports = {
    SPOTIFY_CLIENT_ID: 'your client id',
    SPOTIFY_CLIENT_SECRET: 'your client secret',
    SPOTIFY_REFRESH_TOKEN: 'your refresh token',
    SPOTIFY_EXE: 'C:\\Path\\To\\Spotify.exe' // path to Spotify's executable on your machine
};
```

#### Build and install

The build compiles the plugin into a single bundle (via [`ncc`](https://github.com/vercel/ncc)) and automatically copies it to the StreamDock plugins folder (`%APPDATA%\HotSpot\StreamDock\plugins\`).

```powershell
cd spotify-nowplaying.sdPlugin\plugin
npm install
npm run build
```

**Important: fully close Rise Mode Controller / StreamDock before running the build.** If the app is open, the deploy step will fail trying to overwrite files in use (`EBUSY`), which can leave the installed plugin folder incomplete (the plugin shows up with a question-mark icon on the device). Reopen the app after the build finishes.

To confirm no process is still hanging around before building:

```powershell
tasklist | findstr /i "Rise"
```

If nothing is returned, it's safe to build.
