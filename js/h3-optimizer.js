/* MiniMax H3 prompt optimizer — runs in the BROWSER, not on the RunningHub worker.
   The guide text it sends is the official MiniMax H3 prompt-writing skill shipped
   verbatim in guides/ (base-en.txt + ref-en.txt), so the rewrite follows the same
   rules as the offline skill instead of the node pack's built-in optimizer. */
'use strict';

window.H3Optimizer = (() => {
  const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
  const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
  /* Images only — a video's own reference is MOTION, which a single still cannot carry, so a
     sampled frame would be a weak signal that still reads as a picture. 768px keeps a subject,
     wardrobe, environment and style legible while costing roughly half of a 1024px image. */
  const MAX_EDGE = 768;
  const JPEG_QUALITY = 0.8;

  let guideCache = null;

  /* plain fetch: the host revalidates (ETag), so an edited guide still arrives
     without re-downloading ~60 KB on every page load. The Singularity spec is
     only fetched the first time a run uses Settings → Advanced → Singularity V2. */
  let singularityCache = null;
  const getText = (path) => fetch(path).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${path}`);
    return r.text();
  });
  function loadGuides(singularity) {
    if (!guideCache) {
      guideCache = Promise.all([getText('./guides/base-en.txt'), getText('./guides/ref-en.txt')])
        .then(([base, ref]) => ({ base, ref }));
      guideCache.catch(() => { guideCache = null; });
    }
    if (singularity && !singularityCache) {
      singularityCache = getText('./guides/singularity-en.txt');
      singularityCache.catch(() => { singularityCache = null; });
    }
    return Promise.all([guideCache, singularity ? singularityCache : ''])
      .then(([g, s]) => ({ ...g, singularity: s }));
  }

  /* the skill's Workflow / Output Rules / Tips, verbatim in substance */
  const SKILL_RULES = `You rewrite a user's request into a single MiniMax H3 video-generation prompt, following the official MiniMax H3 prompt-writing guide included below.

Workflow
1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, follow the final prompt structure in the Video Prompt Writing Guide.
3. For full-reference mode, follow the six-section rewrite format in the Full-Reference guide.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

Output rules
- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
- Always match the total duration of the description to the requested video length.
- Keep reference labels consistent (e.g. <Picture 1>, <Video 1>, <Audio 1>) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.

Media evidence rule
- ONLY still reference images are ever attached to the message. No video frames and no audio are attached.
- Only describe attached images you were actually given. If nothing was attached, do not invent reference labels or claim to see anything.
- A @VideoN or @AudioN reference must be written from the text alone — never imply you watched or listened to it.
- @ImageN tags map to the attached images in the order listed; keep them as the guide's reference labels.

Silent self-check
- Before returning, verify WITHOUT commentary: the timeline you describe totals the requested target duration; every reference label you use (<Subject N>, <Picture N>, <Video N>, <Audio N>, @ImageN) maps to media actually declared or attached in this run; no reference is invented; nothing is described outside the requested duration.
- If any check fails, fix the rewrite silently. Never report the checks, never mention them — output only the corrected final prompt.

Return ONLY the final prompt text — no preamble, no commentary, no markdown code fences.`;

  /* Singularity V2 checkpoint addendum — the recommendations from the model card
     (huggingface.co/WarmBloodAban/Minimax-h3_Singularity) ahead of the team's
     enhanced specification, which ships verbatim in guides/singularity-en.txt.
     Sent only while Settings → Advanced → Singularity V2 is on (the run swaps
     in the Singularity checkpoint); FastH3 runs use the official guides only. */
  const SINGULARITY_RULES = `The target checkpoint is Singularity V2. The specification below refines the official guides above — where it is more specific, follow it (reference labeling with <Subject N> vs <Picture N>, extended retention levels, continuous action chains, concrete camera verbs, VFX triggers with physical consequences, observable acting). The six section names, their order, and the timing notation stay exactly as in the official guide.

Singularity V2 recommendations:
- Keep the final prompt within approximately 5,000 characters.
- Use clear descriptions of the subject, action, setting, lighting, and camera movement.
- Explicitly include the intended visual style, such as photorealistic, East Asian realism, 3D CG, or cinematic CG.
- Avoid repetitive descriptions, unnecessary instructions, and conflicting visual styles.
- For action scenes, describe the movement and sequence of events clearly.`;

  /* The system prompt holds ONLY text that is identical for every run of the
     same mode (rules + one guide), so Gemini's implicit caching and OpenAI's
     automatic prompt caching can reuse it — anything per-run (duration, counts…)
     lives in the user message (runContext). Like the node pack, a run gets
     either the base guide or the full-reference guide, never both: they define
     different output formats, and both together cost ~10k tokens per call. */
  function buildSystemPrompt({ withRef, guides, singularity }) {
    const parts = [SKILL_RULES, ''];
    if (withRef) {
      parts.push('===== Full-Reference Mode Rewrite Output Format Guide =====');
      parts.push(guides.ref);
    } else {
      parts.push('===== Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA) =====');
      parts.push(guides.base);
    }
    if (singularity) {
      parts.push('');
      parts.push('===== Singularity V2 Checkpoint Addendum (applies to every mode) =====');
      parts.push(SINGULARITY_RULES);
      parts.push('');
      parts.push(guides.singularity);
    }
    return parts.join('\n');
  }

  function runContext({ subMode, seconds, aspect, resolution, counts, attachedCount }) {
    return [
      'Run context',
      `- Mode: ${subMode}`,
      `- Target duration: ${seconds} seconds (format cut times to two decimals)`,
      '- Duration cap: this deployment generates up to 30 seconds — the official guide\'s 15-second maximum does NOT apply here. Never shorten, split, or flag a request between 16 and 30 seconds; write for the full requested duration.',
      `- Aspect ratio: ${aspect}`,
      resolution ? `- Resolution: ${resolution} — scale the density of visual detail to this resolution` : null,
      `- Reference media in this run: ${counts.images} image(s), ${counts.videos} video(s), ${counts.audios} audio(s)`,
      `- Still images actually attached to this message: ${attachedCount}`,
    ].filter(Boolean).join('\n');
  }

  function drawToJpeg(source, w, h) {
    const scale = Math.min(1, MAX_EDGE / Math.max(w || 1, h || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((w || 1) * scale));
    c.height = Math.max(1, Math.round((h || 1) * scale));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
  }

  function imagePart(file, url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { try { resolve({ inlineData: { mimeType: 'image/jpeg', data: drawToJpeg(img, img.naturalWidth, img.naturalHeight) } }); } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); } };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`could not decode ${file.name}`)); };
      img.src = url;
    });
  }

  /* still reference images only — videos and audio are never attached */
  async function mediaParts(files, onNote) {
    const parts = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(f);
      try {
        parts.push(await imagePart(f, url));
      } catch (e) {
        URL.revokeObjectURL(url);
        if (onNote) onNote(`${f.name}: ${e.message}`);
      }
    }
    return parts;
  }

  /* name each attachment so the model cannot mistake an image for a video reference */
  function buildUserText(prompt, attached, context) {
    const head = `${context}\n\n---\nUser request:\n${prompt}`;
    if (!attached.length) return head;
    const lines = attached.map((f, i) => `  ${i + 1}. @Image${i + 1} — ${f.name}`);
    return `${head}\n\n---\nStill reference images attached to this message, in order:\n${lines.join('\n')}\n` +
      'Only these still images are attached. No video frames and no audio are attached.';
  }

  async function callGemini({ apiKey, model, endpoint, system, prompt, parts }) {
    const url = `${endpoint || DEFAULT_ENDPOINT}/models/${encodeURIComponent(model)}:generateContent`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
          /* 16k: thinking models spend part of the budget before the answer */
          generationConfig: { temperature: 0.4, maxOutputTokens: 16384 },
        }),
      });
    } catch (e) {
      throw new Error(`Network error calling Gemini (${e.message}) — check your connection.`);
    }
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      const m = (out && out.error && out.error.message) || `HTTP ${res.status}`;
      throw new Error(`Gemini rejected the request: ${m}`);
    }
    const cand = out && out.candidates && out.candidates[0];
    const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) {
      const why = out && out.promptFeedback && out.promptFeedback.blockReason;
      throw new Error(why ? `Gemini blocked the request (${why}).` : 'Gemini returned an empty rewrite.');
    }
    /* a cut-off or filtered answer still carries text — never submit half a prompt */
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      throw new Error(`Gemini stopped early (${cand.finishReason}) — the rewrite is incomplete.`);
    }
    return text;
  }

  /* any OpenAI-compatible /chat/completions endpoint — OpenAI, OpenRouter, Groq,
     local servers. Same system+user text and the same downscaled JPEG images as
     the Gemini call, translated to the OpenAI dialect: Bearer auth (optional —
     keyless local servers are allowed), a messages array, image_url parts. */
  async function callOpenAI({ baseUrl, apiKey, model, system, prompt, parts }) {
    if (!baseUrl) throw new Error('No base URL set for the OpenAI-compatible provider — add one in ⚙ Settings.');
    if (!model) throw new Error('No model set for the OpenAI-compatible provider — add one in ⚙ Settings.');
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const content = [{ type: 'text', text: prompt },
      ...parts.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }))];
    const messages = [{ role: 'system', content: system }, { role: 'user', content }];
    /* classic dialect first (OpenRouter, Groq, local servers); OpenAI's reasoning
       models (gpt-5.x, o-series) reject max_tokens and a custom temperature, so
       an error naming either retries once with max_completion_tokens and no temperature */
    const send = async (modern) => {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
          },
          body: JSON.stringify(modern
            ? { model, messages, max_completion_tokens: 16384 }
            : { model, messages, temperature: 0.4, max_tokens: 16384 }),
        });
      } catch (e) {
        throw new Error(`Network error calling ${url} (${e.message}) — check the base URL and your connection.`);
      }
      const out = await res.json().catch(() => null);
      if (res.ok) return out;
      const raw = out && out.error && (out.error.message || out.error);
      const m = typeof raw === 'string' ? raw : (raw ? JSON.stringify(raw) : `HTTP ${res.status}`);
      if (!modern && res.status === 400 && /max_tokens|max_completion_tokens|temperature/i.test(m)) return send(true);
      throw new Error(`The model rejected the request: ${m}`);
    };
    const out = await send(false);
    const choice = out && out.choices && out.choices[0];
    if (choice && choice.finish_reason === 'length') throw new Error('The model stopped early (token limit) — the rewrite is incomplete.');
    const msg = choice && choice.message;
    /* content is a string on nearly every endpoint; a few return part arrays */
    let text = '';
    if (msg && typeof msg.content === 'string') text = msg.content;
    else if (msg && Array.isArray(msg.content)) text = msg.content.map((c) => (c && c.text) || '').join('');
    text = text.trim();
    if (!text) throw new Error('The model returned an empty rewrite.');
    return text;
  }

  /* is the run a keyframe mode or a full-reference mode, and which sub-mode exactly */
  function subModeOf({ mode, first, last }) {
    if (mode === 'reference') return 'full-reference Ref2VA';
    if (first && last) return 'FL2VA (first + last frame)';
    if (last) return 'L2VA (last frame only)';
    if (first) return 'I2VA (first frame only)';
    return 'T2VA (text to audio-visual)';
  }

  /* provider: 'gemini' (default) | 'openai' — everything above the HTTP call
     (guides, system prompt, image downscaling) is shared between the two */
  async function optimize({ provider, apiKey, model, endpoint, baseUrl, prompt, mode, seconds, aspect, resolution, first, last, mediaFiles = [], counts, readMedia, singularity = false, onNote }) {
    if (provider === 'openai') {
      if (!baseUrl) throw new Error('No base URL set for the OpenAI-compatible provider — add one in ⚙ Settings.');
      if (!model) throw new Error('No model set for the OpenAI-compatible provider — add one in ⚙ Settings.');
    } else if (!apiKey) {
      throw new Error('No Gemini API key set — add one in ⚙ Settings.');
    }
    const guides = await loadGuides(singularity);
    const withRef = mode === 'reference';
    const images = readMedia ? (mediaFiles || []).filter((f) => f.type.startsWith('image/')) : [];
    const parts = images.length ? await mediaParts(images, onNote) : [];
    const attached = parts.length ? images.slice(0, parts.length) : [];
    const system = buildSystemPrompt({ withRef, guides, singularity });
    const context = runContext({
      subMode: subModeOf({ mode, first, last }),
      seconds: seconds ?? 5, aspect: aspect || '9:16', resolution,
      counts: counts || { images: 0, videos: 0, audios: 0 },
      attachedCount: parts.length,
    });
    const userText = buildUserText(prompt, attached, context);
    return provider === 'openai'
      ? callOpenAI({ baseUrl, apiKey, model, system, prompt: userText, parts })
      : callGemini({ apiKey, model: model || DEFAULT_MODEL, endpoint, system, prompt: userText, parts });
  }

  /* cheap round-trip that proves the key + model actually work (Settings → Test) */
  async function ping({ provider, apiKey, model, baseUrl }) {
    const text = provider === 'openai'
      ? await callOpenAI({ baseUrl, apiKey, model, system: 'Reply with exactly: OK', prompt: 'ping', parts: [] })
      : await callGemini({ apiKey, model: model || DEFAULT_MODEL, system: 'Reply with exactly: OK', prompt: 'ping', parts: [] });
    return text.replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)';
  }

  /* Does this prompt ALREADY follow the guide's output format? A rewrite the
     app produced earlier carries the format's unmistakable field headers —
     re-optimizing it would drift the structure and cost a full call for
     nothing, so the run path skips the LLM entirely when these appear. */
  function looksFormatted(prompt) {
    /* base modes' core field, or full-reference mode's first section — as a
       line-start header, with or without the colon (rewrites often drop it) */
    return /(^|\n)\s*(integrated_multimodal_description|subject_definitions)\s*(:|\r?\n)/.test(prompt || '');
  }

  return { optimize, ping, looksFormatted, DEFAULT_MODEL };
})();
