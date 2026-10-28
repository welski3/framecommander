/* RunningHub OpenAPI client (browser).
   Endpoints match the RunningHub task API:
     POST /task/openapi/create   { apiKey, workflowId, nodeInfoList } -> { code, data: { taskId } }
     POST /task/openapi/status   { apiKey, taskId }                  -> data is a BARE STRING task status
     POST /task/openapi/outputs  { apiKey, taskId }                  -> data: [{ nodeId, fileType, fileUrl, taskCostTime }]
     POST /task/openapi/upload   multipart (apiKey, fileType=input, file) -> data.fileName
     POST /task/openapi/cancel   { apiKey, taskId }                  -> cancels a queued/running task
   Notes baked in:
     - a 421 (TASK_QUEUE_MAXED) reject spends no credits and is safe to retry -> retried here with a 30s backoff
     - a 433 means a widget value failed raw-enum validation on RunningHub's side
*/
'use strict';

window.RH = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function post(base, path, payload) {
    let res;
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      const err = rhError(0, `Network error calling ${path} — check the base URL (${base}) and your connection.`);
      err.network = true;      // transient by definition: worth retrying
      throw err;
    }
    if (res.status === 401) throw rhError(401, 'Unauthorized — the API key was rejected. Re-copy it from the RunningHub dashboard.');
    if (!res.ok) {
      const err = rhError(res.status, `HTTP ${res.status} from ${path}`);
      err.httpStatus = res.status;
      throw err;
    }
    let out;
    try { out = await res.json(); } catch (e) { throw rhError(0, `${path} returned non-JSON (wrong base URL?)`); }
    return out;
  }

  function rhError(code, msg) {
    const err = new Error(msg);
    err.code = code;
    return err;
  }

  function explain(out) {
    const code = out && out.code, msg = (out && out.msg) || '';
    if (code === 421) return 'Queue maxed (421) — RunningHub concurrency cap. Rejected whole, no credits spent; retry in 30s+.';
    if (code === 433) {
      let details = '';
      try {
        const parsed = JSON.parse(msg);
        const errs = [];
        for (const [nid, node] of Object.entries(parsed.node_errors || {})) {
          for (const e of node.errors || []) {
            errs.push(`node ${nid} · ${e.extra_info?.input_name || '?'}: ${e.details}`);
          }
        }
        if (errs.length) details = errs.join('  |  ');
      } catch (e) { /* msg wasn't JSON */ }
      return `Rejected (433 — raw-enum validation): ${details || msg}. A field value must match the template's raw value exactly — add it under "normalize" in api/manifest.json.`;
    }
    return `Rejected (code ${code}): ${msg}`;
  }

  async function uploadFile(apiKey, base, file) {
    const fd = new FormData();
    fd.append('apiKey', apiKey);
    fd.append('fileType', 'input');
    fd.append('file', file, file.name);
    const res = await fetch(base + '/task/openapi/upload', { method: 'POST', body: fd });
    const out = await res.json().catch(() => null);
    if (!out || out.code !== 0) throw rhError(out ? out.code : 0, `Upload failed for ${file.name}: ${(out && out.msg) || 'no response'}`);
    return out.data.fileName;
  }

  async function createTask({ apiKey, base, workflowId, nodeInfoList, workflow }, hooks = {}) {
    const payload = { apiKey, workflowId, nodeInfoList };
    if (workflow) payload.workflow = workflow;
    for (let attempt = 0; ; attempt++) {
      const out = await post(base, '/task/openapi/create', payload);
      if (out.code === 0) return out.data.taskId;
      if (out.code === 421 && attempt < 3) {
        if (hooks.onQueueMaxed) hooks.onQueueMaxed(attempt + 1);
        await sleep(30000);
        continue;
      }
      throw rhError(out.code, explain(out));
    }
  }

  async function status(apiKey, base, taskId) {
    const out = await post(base, '/task/openapi/status', { apiKey, taskId });
    /* An error code here is an API failure, NOT a task status. Returning out.msg would
       make the poller treat e.g. "TASK_QUEUE_MAXED" as a status and wait on it forever. */
    if (out.code !== 0) throw rhError(out.code, explain(out));
    const d = out.data;
    if (typeof d === 'string') return d;
    return (d && d.taskStatus) || 'UNKNOWN';
  }

  async function outputs(apiKey, base, taskId) {
    const out = await post(base, '/task/openapi/outputs', { apiKey, taskId });
    if (out.code !== 0) throw rhError(out.code, explain(out));
    return out.data || [];
  }

  /* Full task record (batch endpoint) — the only API that carries a FAILURE's
     failReason (exception text, node name). Used purely to explain failures;
     callers must tolerate this failing (unknown base URL, endpoint removed…). */
  async function taskInfo(apiKey, base, taskId) {
    const out = await post(base, '/task/openapi/tasks', { apiKey, taskIds: [taskId] });
    if (out.code !== 0) throw rhError(out.code, explain(out));
    return Array.isArray(out.data) ? (out.data.find((t) => t && t.taskId === taskId) || out.data[0] || null) : null;
  }

  /* Account balance snapshot — used to compute RH Coin consumption as a
     before/after delta. Returns raw data; throws if the endpoint is unavailable. */
  async function account(apiKey, base) {
    const out = await post(base, '/uc/openapi/accountStatus', { apiKey, apikey: apiKey });   // docs spell it "apikey"
    if (out.code !== 0) throw rhError(out.code, explain(out));
    return out.data;
  }

  /* Cancel a queued or running task on RunningHub (stops it spending coins). */
  async function cancel(apiKey, base, taskId) {
    const out = await post(base, '/task/openapi/cancel', { apiKey, taskId });
    if (out.code !== 0) throw rhError(out.code, explain(out));
    return out.data;
  }

  return { uploadFile, createTask, status, outputs, taskInfo, account, cancel };
})();
