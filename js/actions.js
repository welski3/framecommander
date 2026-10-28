/* Frame Commander — post-processing actions on finished outputs, driven by the
   manifest's "actions" array. First action: Upscale (RTX Video Super Resolution).

   The runner is generic and file-input shaped: download the entry's video →
   upload it to RunningHub → createTask on the action's workflow ID with the
   `input` node field (+ optional `normalize` overrides) → poll → a new output
   entry tagged `upscaled`. A future action that fits that shape is just a new
   entry in api/manifest.json + its API JSON in api/ — no core changes.

   app.js is the orchestrator: it calls init/buttonsFor and hands over a
   `window.FC` bridge (alerts, settings, output entries, tracked runs).
   Load order: rh-api.js, h3-optimizer.js, actions.js, app.js.
   An action is live only when its manifest entry carries a numeric workflowId
   (there is no per-user ID in Settings any more). Currently none: "actions": []. */
'use strict';

window.FCActions = (() => {
  let actions = [];   // manifest action defs

  const h = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  };

  function init(actionDefs) {
    actions = Array.isArray(actionDefs) ? actionDefs : [];
  }

  const workflowIdOf = (a) => String(a.workflowId || '');
  const workflowIdOk = (a) => /^\d+$/.test(workflowIdOf(a));

  /* ---------------- Output entries: the action buttons ----------------
     Shown for entries that have a video and are not themselves the product of
     an action (no chained 2x→4x upscales by accident — each click spends coins). */
  function buttonsFor(entry) {
    if (!entry || !entry.video || entry.upscaled) return [];
    return actions.filter((a) => a.button && a.input && workflowIdOk(a)).map((a) => h('button', {
      class: 'output-upscale', type: 'button', 'data-src': entry.id, 'data-action': a.id,
      title: a.description || a.label || a.id,
      onclick: () => runAction(a, entry),
    }, a.button));
  }

  /* one live upscale per source video: disable its buttons while the task runs */
  function refreshButtons() {
    for (const b of document.querySelectorAll('.output-upscale[data-src]')) {
      b.disabled = FC.isSourceBusy(b.dataset.src);
    }
  }

  /* ---------------- The generic pipeline ---------------- */
  async function runAction(action, entry) {
    const s = FC.settings;
    if (!s.apiKey) {
      FC.showAlert('warning', h('strong', {}, 'No API key. '), 'Open ⚙ Settings and paste your RunningHub API key.');
      return;
    }
    if (!workflowIdOk(action)) {
      FC.showAlert('warning', h('strong', {}, 'No ' + (action.label || action.id) + ' workflow ID. '),
        'This action has no numeric workflowId in api/manifest.json.');
      return;
    }
    if (!entry.video) return;
    if (FC.isSourceBusy(entry.id)) {
      FC.statusLine('This video is already upscaling — wait for that task to finish.', false);
      return;
    }
    // disable this video's Upscale buttons right away — the upload alone can take a while
    for (const b of document.querySelectorAll('.output-upscale[data-src="' + CSS.escape(entry.id) + '"]')) b.disabled = true;
    FC.clearAlerts();
    let stage = 'downloading the video';
    try {
      // 1. pull the finished video back from RunningHub's CDN (CORS permitting)
      const res = await fetch(entry.video);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching the video from RunningHub.`);
      const blob = await res.blob();
      const base = decodeURIComponent((entry.video.split('?')[0].split('/').pop() || 'video'));
      const file = new File([blob], /\.mp4$/i.test(base) ? base : base + '.mp4', { type: blob.type || 'video/mp4' });

      // 2. upload it as an input file
      stage = 'uploading the video';
      FC.statusLine('Upscaling — uploading the video to RunningHub…');
      const fileName = await RH.uploadFile(s.apiKey, s.base, file);

      // 3. create the task: the input node field + fixed normalize overrides
      stage = 'submitting the task';
      const ni = [{ nodeId: action.input.nodeId, fieldName: action.input.fieldName, fieldValue: fileName }];
      for (const [nodeId, fields] of Object.entries(action.normalize || {})) {
        for (const [fieldName, fieldValue] of Object.entries(fields)) {
          ni.push({ nodeId, fieldName, fieldValue });
        }
      }
      const coinBefore = RH.account(s.apiKey, s.base).catch(() => null);
      const taskId = await RH.createTask(
        { apiKey: s.apiKey, base: s.base, workflowId: workflowIdOf(action), nodeInfoList: ni },
        { onQueueMaxed: (n) => FC.statusLine(`Queue maxed (421) — retrying in 30s (attempt ${n}/3). Rejected submits spend no credits.`) },
      );

      // 4. tracked like any run: sidebar row (UPSCALING badge) + the same
      //    "Generating preview…" placeholder a normal generation gets
      FC.statusLine('', false);
      FC.startTrackedRun({
        taskId, seed: null, label: 'UPSCALING',
        rawPrompt: null, usedPrompt: '',
        steps: null, resolution: null,
        snapshot: entry.snapshot || null,   // Regenerate on the upscaled entry replays the SOURCE run
        upscaled: { action: action.id, fromId: entry.id },
        coinBefore: await coinBefore,
        startedAt: Date.now(), watchStart: Date.now(),
        queuedSince: null, errStreak: 0, finished: false,
        poll: null, badgeEl: null, elapsedEl: null, rowEl: null, msgEl: null, btnEl: null,
      });
    } catch (err) {
      FC.showAlert('error',
        h('strong', {}, `Upscale failed while ${stage}. `),
        (err && err.message) || String(err));
      FC.statusLine('', false);
      refreshButtons();   // no task in flight any more — re-enable the buttons
    }
  }

  /* retry a failed action run from its failure alert: the source entry is
     looked up in the persisted output list; if it has expired away, say so */
  function runActionForEntry(actionId, entryId) {
    const a = actions.find((x) => x.id === actionId);
    const entry = FC.findEntry ? FC.findEntry(entryId) : null;
    if (!a || !entry || !entry.video) {
      FC.showAlert('warning', h('strong', {}, 'The source video is gone. '),
        'Its output expired on RunningHub — regenerate it first, then upscale the new one.');
      return;
    }
    runAction(a, entry);
  }

  return { init, buttonsFor, refreshButtons, runActionForEntry };
})();
