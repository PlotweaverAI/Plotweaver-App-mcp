# Troubleshooting

Fixes for the problems people hit most when connecting the PlotWeaver MCP.

  <details>
<summary><strong>The assistant doesn't use PlotWeaver</strong></summary>

Check that the connector is switched on for this chat (in Claude: **+ > Connectors**). Then mention it by name: "Use PlotWeaver to read this in Hausa."

</details>

  <details>
<summary><strong>The sign-in page says 'Unverified app'</strong></summary>

That is expected for desktop tools such as Claude Code, Cursor and VS Code, which sign in through your own computer. Approve it only if you started the sign-in yourself just now. Claude and ChatGPT are always named.

</details>

  <details>
<summary><strong>401 or 'invalid key'</strong></summary>

The key is wrong, deleted or rotated. In header-based setups, check the header name is exactly `X-API-Key` and that your environment variable is visible to the app (open it from a terminal to be sure). With sign-in, remove the connector and add it again.

</details>

  <details>
<summary><strong>402: billing or payment</strong></summary>

Your account needs an active plan or credit, or a payment failed. Open **Billing** in the [dashboard](https://app.plotweaver.app).

</details>

  <details>
<summary><strong>429: too many requests</strong></summary>

Your plan's requests per minute, or this month's allowance, is used up, or a voice engine is momentarily full. The assistant will be told when to retry. See [Limits](https://plotweaver.mintlify.app/reference/rate-limits).

</details>

  <details>
<summary><strong>Cursor shows no tools</strong></summary>

Cursor may not see environment variables from your shell profile when opened from a launcher. Open it from a terminal with `cursor .`, or put the key directly in `~/.cursor/mcp.json`. Check **Cursor Settings > MCP** for a green dot, and the MCP logs for errors.

</details>

  <details>
<summary><strong>The assistant can't send my file</strong></summary>

Some assistants' networks block uploads. Ask for a recording link instead ("give me a PlotWeaver upload page") and upload the file yourself, or share a Google Drive or Dropbox link.

</details>

  <details>
<summary><strong>A download link has expired</strong></summary>

Links last 24 hours. Ask "give me a fresh link to that audio": `get_audio` makes a new one for anything made in the last 7 days.

</details>

  <details>
<summary><strong>A Yoruba word sounds wrong</strong></summary>

Give the text with full tone marks, for example `Ẹ káàbọ̀`, not `E kaabo`. If it is still wrong, send the text, language and voice to [info@plotweaver.app](mailto:info@plotweaver.app).

</details>

  <details>
<summary><strong>Translation into French, Swahili or another language is refused</strong></summary>

Translation covers English, Yoruba, Hausa, Igbo and Nigerian Pidgin. Speech covers 86 languages, so you can still voice text you have written in Swahili, Twi, Zulu and the rest.

</details>

Still stuck? Write to [info@plotweaver.app](mailto:info@plotweaver.app) with the app you use, the time, and what you asked.
