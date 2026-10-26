# discord.sdPlugin

*[Português](#português) | [English](#english)*

---

## Português

Controles de voz do Discord num plugin só (uma única categoria **Discord** na lista de actions). Substituem os antigos atalhos F20–F23 do `comandos.ahk`.

| Action | Atalho enviado | Antigo |
|---|---|---|
| **Mute** | Ctrl+Shift+M | F20 |
| **Deafen** | Ctrl+Shift+D | F21 |
| **Camera** | Ctrl+Shift+V, depois Enter | F22 |
| **Hang Up** | Ctrl+Shift+E | F23 |

Ao pressionar, o plugin traz a janela do **Discord** para a frente, envia o atalho e devolve o foco à janela que você estava usando. Se o Discord estiver minimizado na bandeja (sem janela visível), nada acontece.

Os atalhos precisam estar configurados no Discord (Configurações → Atalhos) com essas combinações.

### Como funciona

O plugin mantém um processo PowerShell auxiliar sempre aberto (que usa `user32.dll` para trocar o foco e enviar as teclas), então o clique é rápido — só a primeira vez após abrir o app paga o custo de iniciar o PowerShell. Não há configuração nem dependência do AutoHotkey.

Todas as actions compartilham o mesmo auxiliar e se registram pelo UUID (`plugin.registerAction`), porque os UUIDs herdados de quando eram plugins separados terminam todos em `action1`.

### Build e instalação

```powershell
cd discord.sdPlugin\plugin
npm install
npm run build
```

Feche o Rise Mode Controller / StreamDock completamente antes de executar o build — caso contrário, o deploy falha com `EBUSY`. Reabra o app em seguida.

---

## English

Discord voice controls in a single plugin (one **Discord** category in the action list). They replace the old F20–F23 hotkeys from `comandos.ahk`.

| Action | Hotkey sent | Old |
|---|---|---|
| **Mute** | Ctrl+Shift+M | F20 |
| **Deafen** | Ctrl+Shift+D | F21 |
| **Camera** | Ctrl+Shift+V, then Enter | F22 |
| **Hang Up** | Ctrl+Shift+E | F23 |

When pressed, the plugin brings the **Discord** window to the foreground, sends the hotkey, and returns focus to the window you were using. If Discord is minimized to the tray (no visible window), nothing happens.

The hotkeys must be configured in Discord (Settings → Keybinds) with these combinations.

### How it works

The plugin keeps a helper PowerShell process running (using `user32.dll` to switch focus and send keystrokes), so a press is fast — only the first press after the app opens pays PowerShell's startup cost. No configuration, no AutoHotkey dependency.

All actions share the same helper and register by UUID (`plugin.registerAction`), because the UUIDs inherited from when these were separate plugins all end in `action1`.

### Build and install

```powershell
cd discord.sdPlugin\plugin
npm install
npm run build
```

Fully close Rise Mode Controller / StreamDock before running the build — otherwise the deploy step fails with `EBUSY`. Reopen the app afterward.
