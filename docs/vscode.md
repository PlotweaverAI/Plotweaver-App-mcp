# Connect VS Code

Add PlotWeaver to GitHub Copilot's agent mode in VS Code.

PlotWeaver works in VS Code's agent mode, with the PlotWeaver player and voice gallery shown right in the chat.

### API key (recommended)

Create `.vscode/mcp.json` in your workspace (or run **MCP: Open User Configuration** from the Command Palette for every workspace):

`.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "plotweaver-key",
      "description": "PlotWeaver API key",
      "password": true
    }
  ],
  "servers": {
    "plotweaver": {
      "type": "http",
      "url": "https://mcp.plotweaver.app/mcp",
      "headers": {
        "X-API-Key": "${input:plotweaver-key}"
      }
    }
  }
}
```

VS Code asks for the key the first time the server starts and stores it securely, so the file is safe to commit.

### Sign in with PlotWeaver

`.vscode/mcp.json`:

```json
{
  "servers": {
    "plotweaver": {
      "type": "http",
      "url": "https://mcp.plotweaver.app/mcp"
    }
  }
}
```

VS Code opens your browser for the PlotWeaver sign-in the first time the server starts.

Select **Start** above the server in `mcp.json`, then open the Chat view, choose **Agent** mode, and check that the PlotWeaver tools are listed under the tools button.

## Try it

> Show me Igbo voices.

> Turn `docs/release-notes.md` into a Nigerian English audio summary with Joseph's voice.

> Transcribe `samples/customer-call.wav` and list what the customer asked for.
