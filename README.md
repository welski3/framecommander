# FrameCommander 🎬

**An open-source WebUI for MiniMax H3 video generation, powered by ComfyUI workflows hosted on RunningHub.**

FrameCommander provides a convenient browser interface for generating AI videos without manually operating a ComfyUI node graph. It connects to RunningHub using **your own RunningHub API key**, and by default uses the **already-published workflow ID configured by this project**. You do **not** need to import a workflow, create a new workflow ID, or change code to get started with the WebUI.

> **Where generation happens:** Netlify serves the WebUI; RunningHub runs the ComfyUI workflow and bills your RunningHub account for generation. Netlify does not run ComfyUI or MiniMax H3.

## Features

- Browser-based MiniMax H3 video generation with image/keyframe and reference-video modes where supported
- Prompt, duration, resolution, aspect ratio, and advanced options exposed by the included workflow configuration
- Upload media, submit jobs, check status, cancel tasks, and retrieve outputs through the RunningHub API
- Optional LLM/Gemini-related prompt optimization features, if configured and supported
- Static WebUI deployable to Netlify Drop or runnable locally
- Published ComfyUI API-format JSON included for inspection and advanced customization

## How FrameCommander works

```text
FrameCommander WebUI (Netlify or local server)
             |
      Your RunningHub API key
             |
RunningHub API + preconfigured published workflow ID
             |
 ComfyUI workflow running on RunningHub
             |
         Generated video
```

## Quick start — deploy your own FrameCommander WebUI

**This is the normal setup. You do not need to import the ComfyUI workflow or replace the workflow ID.**

### Step 1 — Download the WebUI

1. Open the [FrameCommander GitHub repository](https://github.com/welski3/framecommander).
2. Select **Code → Download ZIP**.
3. Extract the downloaded GitHub ZIP into a folder on your computer. Netlify's **Drag and Drop** publisher currently asks for the extracted project folder, not the ZIP archive.

### Step 2 — Host your copy using Netlify Drop

1. Open [Netlify Drop](https://app.netlify.com/drop).
2. Drag the **extracted project folder** (containing `index.html`, `css/`, `js/`, and `api/`) into Netlify Drop.
3. Open the new Netlify URL once the deployment completes.
4. Confirm that the FrameCommander interface loads.

**Important:** Netlify hosts the WebUI, not the AI model. Generation still takes place on RunningHub. Keep the ZIP contents and folder structure unchanged; the WebUI needs `api/manifest.json` and its workflow template at runtime. Do not put personal API keys in public files.

### Step 3 — Add your RunningHub API key

1. Sign into [RunningHub](https://www.runninghub.ai/).
2. Click your **profile picture** in the top-right corner, then click **Console**.
3. In the left sidebar, open the **API Keys** tab.
4. Choose **Consumer-Membership API Key** — **not** **Enterprise-Shared**.
5. Click the **Reset Text** button to generate a new API key. **Be aware that resetting may invalidate an existing key used elsewhere.** Copy the new key and keep it private.
6. Open your deployed FrameCommander website. In **Settings (⚙)**, paste your **Consumer-Membership API key** and save/apply the settings.
7. Leave the built-in workflow ID unchanged. **It already points to the project's published RunningHub workflow.**
8. Choose your video settings and start a test generation. RunningHub credits and access to the published workflow may be required.

**No workflow import is needed for the standard WebUI setup.** The published workflow ID is already configured in `api/manifest.json`.

### Step 4 — Optional LLM / Gemini API key

An LLM key is **optional**, and is **not required** for ordinary RunningHub video generation.

If you want to use FrameCommander's supported prompt-optimization features, open the relevant LLM/optimizer settings in the WebUI and configure your own provider key (for example Gemini), then test that feature. Third-party API quotas or fees may apply. Keep all keys private; never commit them to GitHub or add them to public JSON files.

### Step 5 — Generate a video

1. Select the MiniMax H3 workflow in FrameCommander.
2. Choose image/keyframe or reference mode as appropriate.
3. Add a prompt and the required image/video/audio references for your selected mode.
4. Select supported duration, resolution, and aspect ratio.
5. Start generation and monitor the RunningHub task status.
6. View or save the output when processing finishes.

**RunningHub charges for workload execution according to your account and its current pricing.**

## Optional — run the WebUI locally instead of on Netlify

This hosts only the **website interface**, not the ComfyUI AI engine.

1. Download and extract the repository ZIP.
2. Install [Node.js](https://nodejs.org/) if needed.
3. In the project folder run:

   ```bash
   node serve.js
   ```

4. Open `http://localhost:8765` (the server may select a nearby available port). On Windows you can instead double-click `start.bat`.
5. Add your personal RunningHub API key in Settings, exactly as described above.

Do not open `index.html` directly via `file://`: browser security rules can prevent the WebUI from loading its JSON configuration. Use Netlify or the local server.

## Optional — import and customize the visual ComfyUI workflow in RunningHub

**This section is optional.** The normal FrameCommander WebUI already connects to a published RunningHub workflow. Just deploy the WebUI and enter your personal Consumer-Membership RunningHub API key.

### Download the importable workflow

**[Download the Frame Commander FastH3 Omni SelfLift V1 visual workflow](Frame%20Commander%20FastH3%20Omni%20SelfLift%20V1.json)**

This is the **actual ComfyUI editor-format workflow**, containing its visual nodes and connections. It was created for the ComfyUI environment available in RunningHub.

To inspect, run, or modify it:

1. Download the linked `Frame Commander FastH3 Omni SelfLift V1.json` file from this repository (on GitHub, select **Download raw file**).
2. Sign into RunningHub and open a ComfyUI workspace where the required nodes and models are available.
3. Import the downloaded JSON into the visual ComfyUI editor.
4. Check for missing custom nodes, model files, or missing input media. Supply any required dependencies and change example media as necessary.
5. Run the workflow directly in RunningHub; make edits and save your customized workflow as desired.
6. If you want your modified workflow to power your own FrameCommander copy, publish it on RunningHub and follow the optional workflow ID instructions below.

**Do not import `api/minimax-h3-selflift.json` as the visual workflow.** That is an **API-format execution template** used by the WebUI, not the importable editor-format workflow. Likewise, `api/manifest.json` configures the WebUI rather than defining the visual ComfyUI graph.

**Environment and reproducibility:** This visual workflow is designed for RunningHub's ComfyUI environment. It uses specialized MiniMax H3 / SelfLift components and model weights, which are **not bundled** in this repository. It may also be possible to recreate the graph in another ComfyUI installation, but only after installing compatible custom nodes and model files. Availability outside RunningHub has not been independently verified. The application itself can run locally using `node serve.js`, but that does not run the AI engine locally.

## Optional — use your OWN RunningHub workflow ID in FrameCommander

**You do not need to do this for normal use.** FrameCommander currently has a **fixed, published workflow ID** built into `api/manifest.json`. The existing WebUI intentionally does **not** offer a per-user Workflow ID input in Settings.

If you edit and publish your own compatible RunningHub workflow, changing the ID is straightforward:

1. Get the workflow ID of **your published RunningHub workflow**.
2. In your downloaded FrameCommander folder, open `api/manifest.json` in any text editor.
3. Find the `minimax-h3` entry and its `workflowId` property. For example:

   ```json
   "workflowId": "2114664760238227458"
   ```

4. Replace **only the number between the quotes** with your own published workflow ID. Keep it as a **quoted string** and preserve the JSON syntax.
5. Save `api/manifest.json`.
6. Upload the updated **project folder** through Netlify Drop, or run it through `node serve.js` locally.
7. Refresh the WebUI and run a test generation.

**If your custom workflow has different node IDs or inputs:** changing `workflowId` alone may **not** be enough. This application also loads `api/minimax-h3-selflift.json` as a workflow template and uses `api/manifest.json` to map controls to node IDs and fields. Replace the template JSON and update the mappings as required to match your custom workflow. Keep these files consistent.

> To make Workflow ID changeable from the WebUI Settings instead, a code change would be needed. The current source intentionally ignores older per-user Workflow ID overrides and uses the manifest's ID.

## Project structure

```text
framecommander/
├── Frame Commander FastH3 Omni SelfLift V1.json  # Importable visual ComfyUI workflow\n├── index.html                     # Main WebUI
├── css/                           # Styles
├── js/                            # WebUI logic and RunningHub API client
├── api/
│   ├── manifest.json              # Published workflow ID and form/node mappings
│   └── minimax-h3-selflift.json   # MiniMax H3 ComfyUI API template
├── guides/                        # App help and guides
├── serve.js                       # Optional local Node.js web server
├── start.bat                      # Windows local server launcher
├── README.md                      # This guide
└── LICENSE                        # MIT license for the project code
```

The tree above highlights the **files relevant to MiniMax H3**; the repository may contain additional files that are not used by this guide.

## Troubleshooting

| Issue | What to check |
|---|---|
| WebUI doesn't load on Netlify | Extract the GitHub ZIP, then upload the project folder to Netlify Drop; the deployed site must contain `index.html`, `css/`, `js/`, and `api/`. |
| No RunningHub API key | Open Settings and enter your own RunningHub API key. |
| Unauthorized / API error | Verify your API key, account access, API endpoint, credits, and browser connectivity. |
| Published workflow isn't accessible | Confirm RunningHub access to the project's published workflow; if using your own workflow, edit `workflowId` in `api/manifest.json`. |
| ComfyUI workflow import fails | Use the root-level `Frame Commander FastH3 Omni SelfLift V1.json` visual workflow, not the API-format JSON in `api/`. Also check custom-node availability. |
| Custom workflow fails | Verify custom nodes, model files, input names, node IDs, template JSON, and manifest mappings. |
| Prompt optimizer fails | Gemini/LLM key and optional optimization settings are separate from the RunningHub API key. |
| Slow generation | RunningHub queue times, selected model settings, and account limits affect processing. |

## Video guide

**[Watch the FrameCommander setup tutorial on YouTube](https://youtu.be/DS-XPUw7zSQ)**

This unlisted video walks through setting up and using the FrameCommander WebUI with RunningHub.

## License and third-party dependencies

The FrameCommander application code is provided under the **MIT License**; see [LICENSE](LICENSE).

RunningHub, ComfyUI, MiniMax H3, Gemini, third-party custom nodes, model weights, and related tools remain subject to their own terms and licenses. The MIT License covers only code that the project author has the right to license. Users must follow applicable rules and obtain rights for their inputs and outputs.

## Open Source Higgsfield contest

FrameCommander is built around a ComfyUI workflow executed in RunningHub, with a separately deployable open-source WebUI. Its importable visual ComfyUI workflow, API-format execution template, and integration code are included for inspection and modification; RunningHub and the necessary external nodes/models remain dependencies.

**Repository:** https://github.com/welski3/framecommander
