# AI tool-selection evaluation

ReMCP keeps a labelled golden prompt set at `submission/tool-selection-golden.json` for metadata regression testing. It follows OpenAI's current Optimize Metadata guidance: include direct, indirect, and negative prompts, record the selected tool/arguments/component, and track precision/recall after metadata changes.

## Before a release

1. Build and deploy the candidate MCP endpoint without changing the golden set during the run.
2. In ChatGPT Developer mode, connect the candidate ReMCP MCP server.
3. Replay every prompt from `submission/tool-selection-golden.json` in a clean conversation.
4. Record one row per case in a results JSON:
   ```json
   {
     "cases": [
       {
         "id": "direct-type-text",
         "selectedTools": ["list_devices", "type_text"],
         "arguments": {
           "type_text": { "text": "Zażółć gęślą jaźń 👋" }
         },
         "component": null,
         "notes": ""
       }
     ]
   }
   ```
5. Score it:
   ```bash
   npm run eval:tool-selection -- submission/tool-selection-golden.json /path/to/results.json
   ```

The scorer checks ordered expected-tool subsequences, forbidden tools, expected render component, positive recall, negative precision, and overall accuracy. A missing case is a failure rather than an implicit pass.

## Release expectations

- Negative prompts are the priority: no ReMCP tool should run when a built-in platform capability or the conversation itself already satisfies the request.
- Native desktop work should prefer Accessibility/UI Automation over coordinates.
- Chromium page work should prefer browser DOM/CDP over desktop input.
- `type_text` is for ordinary Unicode text; `keyboard` is for shortcuts/control/navigation keys.
- Static visual proof uses a targeted screenshot; motion/timing debugging uses screen recording.
- Structured PDF/DOCX/XLSX content uses document tools before GUI automation.
- Presentation render tools run only after their data tool has returned a preview id.

If a case regresses, change one metadata field at a time and rerun the full golden set. Do not update the expected route merely to match a surprising model choice unless the product behavior itself has intentionally changed.

Official references:
- https://developers.openai.com/plugins/guides/optimize-metadata
- https://developers.openai.com/plugins/build/mcp-server
