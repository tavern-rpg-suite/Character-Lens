import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    saveSettings as stSaveSettings,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    eventSource,
    event_types,
} from '../../../../script.js';
import { selected_group, groups } from '../../../group-chats.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { MacrosParser } from '../../../macros.js';

const MODULE = 'character_lens';


/* ============================================================
   API. Своя пара URL / ключ / модель. Если поля пустые —
   одалживаем у соседей по набору (та же конвенция baseUrl /
   apiKey / model в extension_settings), чтобы не вбивать ключ
   в каждое расширение заново. Локальным эндпоинтам ключ не нужен.
   ============================================================ */
const KEY_SOURCES = ['tavern_rpg_engine', 'rpg_status_bar', 'tavern_bonds_engine', 'rpg_phone', 'rpg_diary', 'rpg_map_engine', 'rpg_map', 'rpg_dungeons', 'rpg_codex', 'tavern_doors'];

function isLocalEndpoint(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)([:/]|$)/.test(u)
        || /:(5001|5000|8080|8000|1234|11434|5002)(\/|$)/.test(u)
        || /192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./.test(u);
}

function borrowedRaw() {
    for (const src of KEY_SOURCES) {
        if (src === MODULE) continue;
        try {
            const x = extension_settings[src];
            if (x && x.apiKey && x.model) return { url: x.baseUrl, key: x.apiKey, model: x.model, from: src };
        } catch (e) { /* сосед со сломанными настройками не должен ломать нас */ }
    }
    return { url: '', key: '', model: '', from: null };
}

function normalizeBase(url) {
    let u = String(url || '').trim().replace(/\s+/g, '');
    if (!u) return u;
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/(chat\/completions|completions|embeddings)$/i, '');
    if (!/\/v\d+($|\/)/i.test(u)) u += '/v1';
    return u;
}

function apiConf() {
    const s = settings();
    const own = String(s.baseUrl || '').trim();
    const ownKey = String(s.apiKey || '').trim();
    const ownModel = String(s.model || '').trim();
    if (own) {
        const local = isLocalEndpoint(own);
        const b = (ownKey && ownModel) ? { key: '', model: '', from: null } : borrowedRaw();
        return {
            url: own,
            key: ownKey || (local ? 'local' : b.key),
            model: ownModel || (local ? '' : b.model),
            from: ownKey ? null : (local ? null : b.from),
        };
    }
    if (ownKey && ownModel) return { url: '', key: ownKey, model: ownModel, from: null };
    const b = borrowedRaw();
    return b.key ? b : { url: '', key: ownKey, model: ownModel, from: null };
}
function apiKeyVal() { return apiConf().key || ''; }
function apiUrl() { return normalizeBase(apiConf().url) || 'https://openrouter.ai/api/v1'; }
function apiModel() { return apiConf().model || ''; }
function borrowedFrom() { return apiConf().from; }

async function callAnalyzer(prompt) {
    const s = settings();
    const url = apiUrl().replace(/\/$/, '') + '/chat/completions';
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKeyVal().trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: apiModel(),
            messages: [{ role: 'user', content: prompt }],
            temperature: Number(s.temperature) || 0.6,
            max_tokens: Number(s.maxTokens) || 900,
        }),
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch (e) {}
        throw new Error(`HTTP ${resp.status} ${detail}`.trim());
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Unexpected API response');
    return content.trim();
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
/* Extension settings are plain-text JSON saved on every change — a full-resolution
   phone photo in there is how a "small" settings.json becomes multiple megabytes
   per character. Downscaled and re-encoded client-side before it ever touches
   extension_settings; still plenty for a model to recognise a face and outfit. */
function resizeImageFile(file, maxDim = 640, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('That does not look like an image.'));
            img.onload = () => {
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
}
/* The same little "saved" flash used after the analyzer textarea's own debounce —
   pulled out so Scene Art's own auto-saving fields can reuse it instead of
   duplicating the same two jQuery lines three more times. */
function flashSaved(sel) {
    const $el = $(sel);
    $el.addClass('on');
    setTimeout(() => $el.removeClass('on'), 1400);
}
const PROMPT_KEY = 'CHARACTER_LENS';

/* ── Tag mode, for local anime checkpoints only ──────────────
   Illustrious/Pony/SDXL anime models were trained on danbooru tags and handle prose
   badly, which is why a beautifully written sentence comes out as mush. Worse, in
   these models a character's *identity* does not travel in a description at all —
   "pink twin tails, blue eyes" gives you a girl with pink twin tails, not her. That
   comes from a character LoRA plus its trigger tag, both of which the person supplies
   per character. So the prompt is assembled from four blocks, and only two of them
   are written by the language model:

     {style}       — fixed, from the preset below
     {char}        — fixed, the character's identity tags and LoRA trigger
     {description} — written per scene: expression, blush, tears
     {pose}        — written per scene: body, hands, framing, setting

   The shape is borrowed from the ExpressionEngine node, which solves the same problem
   for sprites. Cloud models keep the old prose pipeline untouched. */
const DEFAULT_TAG_TEMPLATE = '{style},\n{char},\n{description},\n{pose}';

const TAG_STYLE_PRESETS = {
    illustrious: {
        label: 'Illustrious / anime CG',
        text: 'masterpiece, best quality, newest, absurdres, highres, very awa, anime coloring, detailed background, cinematic lighting, depth of field, soft light, visual novel cg',
    },
    watercolor: {
        label: 'Watercolour, painterly',
        // the background tags from a sprite workflow are deliberately left out here —
        // a scene CG needs a room to happen in, not a flat backdrop
        text: 'masterpiece, best quality, newest, absurdres, highres, very awa, wc_painting, watercolor, traditional media, watercolor \\(medium\\), soft edges, transparent layers, loose brushwork, pastel colors, hand drawn, illustration, painterly, detailed background',
    },
    shoujo: {
        label: 'Soft shoujo, pastel',
        text: 'masterpiece, best quality, absurdres, highres, pastel colors, soft lighting, shoujo manga style, delicate lineart, sparkles, warm colors, gentle shading, detailed background',
    },
    dramatic: {
        label: 'Dramatic, high contrast',
        text: 'masterpiece, best quality, absurdres, highres, dramatic lighting, high contrast, rim lighting, cinematic, chiaroscuro, rich saturated colors, detailed background',
    },
    none: { label: 'No style block', text: '' },
};

/* Quality and anatomy guards, plus the usual watermark/text junk. The sprite-only
   entries from a background-removal workflow (simple background, scenery, interior,
   table, leaning on object, pale skin) are NOT here on purpose: in a scene CG they
   would fight the setting the scene is supposed to have. */
const RECOMMENDED_NEGATIVE = 'photorealistic, (realistic:1), 3d, cleavage, cleavage cutout, (particles, adversarial_noise:1.2), multiple views, multiple angle, split view, grid view, two shot, outside border, picture frame, framed, border, letterboxed, pillarboxed, 2koma, cartoon, graphic, text, crayon, graphite, abstract, glitch, deformed, mutated, ugly, disfigured, long body, lowres, bad anatomy, bad hands, missing fingers, extra fingers, extra digits, fewer digits, cropped, very displeasing, (worst quality, bad quality:1.2), sketch, jpeg artifacts, signature, watermark, username, (censored, bar_censor, mosaic_censor:1.2), conjoined, bad ai-generated';

const defaults = {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.6,
    detail: 260,
    maxTokens: 900,
    position: extension_prompt_types.IN_CHAT,
    depth: 3,
    role: extension_prompt_roles.SYSTEM,
    template: '',
    groupMode: 'speaker',   // speaker | all
    profiles: {},           // avatar -> { text, date, name, off }

    // ── Scene Art (CG) ──────────────────────────────────────────
    // A separate, multimodal-capable API — the text analyzer above is not expected
    // to draw. Left empty, it borrows the analyzer's own url/key so one key can cover
    // both if the same provider (e.g. OpenRouter) serves both jobs.
    img: { apiUrl: '', apiKey: '', model: '', mode: 'auto' },   // mode: auto | images | chat | comfy
    cgPromptModel: '',      // small/cheap model that turns context into an image prompt; empty = reuse the analyzer model
    cgStyle: '',            // optional extra style line, on top of the preset below
    cgPreset: 'otome',      // which CG_PRESETS entry shapes the prompt-writer's instructions
    cgPresetOverrides: {},  // preset id -> edited text; unedited presets fall back to the built-in default
    cgProfiles: {},         // avatar -> { sprite: dataURL|null, desc: string, mode: 'both'|'sprite'|'text' }

    /* A local ComfyUI is not an OpenAI-shaped endpoint and cannot be described by the
       fields above: no key, no model name, and the whole graph travels with every
       request. It gets its own corner rather than overloading img.* with meanings
       that only apply to one of the three modes.

       template/stylePreset/style belong here too, and only here: booru tags are what
       Illustrious-style checkpoints were trained on, while the cloud models above read
       prose. Nothing in this block ever touches a cloud request. */
    comfy: {
        workflow: '', negative: '', timeout: 240,
        template: DEFAULT_TAG_TEMPLATE,
        stylePreset: 'illustrious',
        style: '',          // edited style block; empty means "use the preset as-is"
        /* One graph cannot serve everybody: a character with a LoRA needs a LoraLoader,
           an original character with only a reference picture needs an IPAdapter, and
           an empty lora_name is a validation error rather than a "skip this node" —
           the API format has no way to bypass a node without breaking its links. So
           workflows are a named list and each character points at one. */
        workflows: [],      // [{ id, name, text }]
        activeWorkflow: '', // which one the settings panel is currently editing
    },

    /* The other half of a two-person scene. Stored as an ordinary character profile
       under a reserved key, so references, tags and the vision tagger all work for it
       without a second copy of that machinery. */
    partnerMode: 'auto',    // auto (the prompt writer decides) | always | never
};

// the persona's profile lives in cgProfiles under a key no avatar filename can collide with
const PERSONA_KEY = '__persona__';

// кого показывает панель, и кто сейчас говорит в группе
let selectedAvatar = null;
let draftedAvatar = null;

async function saveNow() {
    try {
        if (typeof stSaveSettings === 'function') { await stSaveSettings(); return; }
    } catch (e) { console.warn('[Character Lens] immediate save failed, falling back', e); }
    saveSettingsDebounced();
}

function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = structuredClone(defaults);
    const s = extension_settings[MODULE];
    for (const k of Object.keys(defaults)) {
        if (s[k] === undefined) s[k] = defaults[k];
    }
    // img is nested — an older save missing just one sub-field must not lose the rest
    if (!s.img || typeof s.img !== 'object') s.img = structuredClone(defaults.img);
    for (const k of Object.keys(defaults.img)) {
        if (s.img[k] === undefined) s.img[k] = defaults.img[k];
    }
    if (!s.cgProfiles || typeof s.cgProfiles !== 'object') s.cgProfiles = {};
    if (!s.cgPresetOverrides || typeof s.cgPresetOverrides !== 'object') s.cgPresetOverrides = {};
    // comfy is nested for the same reason img is — repair it the same way
    if (!s.comfy || typeof s.comfy !== 'object') s.comfy = structuredClone(defaults.comfy);
    for (const k of Object.keys(defaults.comfy)) {
        if (s.comfy[k] === undefined) s.comfy[k] = defaults.comfy[k];
    }
    // лечим уже сохранённые NaN/мусор из числовых полей
    const num = (v, def, lo, hi) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : def;
    s.maxTokens = num(s.maxTokens, defaults.maxTokens, 200, 4000);
    s.detail = num(s.detail, defaults.detail, 80, 600);
    s.depth = num(s.depth, defaults.depth, 0, 99);
    s.position = num(s.position, defaults.position, 0, 2);
    s.role = num(s.role, defaults.role, 0, 2);
    s.comfy.timeout = num(s.comfy.timeout, defaults.comfy.timeout, 30, 1200);
    // a preset id that no longer exists would silently yield an empty style block
    if (!TAG_STYLE_PRESETS[s.comfy.stylePreset]) s.comfy.stylePreset = defaults.comfy.stylePreset;
    if (typeof s.comfy.template !== 'string' || !s.comfy.template.trim()) s.comfy.template = DEFAULT_TAG_TEMPLATE;
    if (typeof s.comfy.style !== 'string') s.comfy.style = '';

    /* Migration: a single saved workflow becomes the first entry of the list. Done
       here rather than at load so it also repairs a half-written save. The old field
       is emptied afterwards so this cannot run twice and duplicate the entry. */
    if (!Array.isArray(s.comfy.workflows)) s.comfy.workflows = [];
    s.comfy.workflows = s.comfy.workflows.filter(w => w && typeof w === 'object' && typeof w.id === 'string');
    for (const w of s.comfy.workflows) {
        w.name = typeof w.name === 'string' && w.name.trim() ? w.name : 'Untitled';
        w.text = typeof w.text === 'string' ? w.text : '';
    }
    if (typeof s.comfy.workflow === 'string' && s.comfy.workflow.trim()) {
        s.comfy.workflows.unshift({ id: newWorkflowId(), name: 'Default', text: s.comfy.workflow });
        s.comfy.workflow = '';
    }
    if (!s.comfy.workflows.some(w => w.id === s.comfy.activeWorkflow)) {
        s.comfy.activeWorkflow = s.comfy.workflows[0]?.id ?? '';
    }
    return s;
}

// ─────────────────────────────────────────────────────────────
// Промпт анализатора. Читает карту целиком, не выдёргивая слова.
// Не переписывает персонажа и не смягчает его — объясняет,
// как его черты выглядят у живого человека.
// ─────────────────────────────────────────────────────────────
const ANALYZER = `[No clinical, mechanical, exaggerated, or clichéd behavior; no kings or pawns. Keep actions emotionally alive and in-character.]

Read the character card below and create a short performance guide for the model that will roleplay this character.

Do not summarize the card. Do not explain the character's psychology, personality type, history or motivations. Do not analyse traits.

Instead, describe how this particular person should come across in an actual scene.

Show the model how to portray:

- their natural manner of moving, standing and using space;
- the way they speak, including sentence length, rhythm, vocabulary, humour and conversational habits;
- how their personality appears through ordinary actions and choices;
- how interest, amusement, irritation, embarrassment and affection become visible;
- what they naturally do when someone begins to matter to them;
- what makes their presence attractive, charming or fascinating;
- how their behaviour changes as familiarity and trust grow.

Be concrete. Do not write "he expresses affection through actions". Give examples of the kinds of actions, remarks, habits or changes in behaviour that would express it for THIS character.

Personality traits must never become stereotypes. A cold character can be warm, amused, talkative or playful with the right person. A shy character can have strong opinions. A serious character can joke. A restrained character can become visibly animated when something genuinely interests them.

Do not make the character emotionless, gloomy, rude or passive unless the card specifically requires it.

Do not make intelligence look like constant analysis. Intelligent characters can be fascinating because they explain things beautifully, tell stories, notice details, make clever observations, know interesting things, choose excellent words or become genuinely enthusiastic about their interests.

Dialogue is important. Never reduce the character to terse one-line replies such as "No", "Fine", "Interesting" or "Do as you wish". Let them speak naturally and at length when they have something to say. Their personality should be heard in their voice.

Avoid generic AI mannerisms and overused physical clichés. Do not use gestures such as clenched or tightened jaws, clenched fists, whitening knuckles, narrowed eyes, raised eyebrows, a muscle working in the cheek, breath hitching, sudden stillness, or similar stock reactions. Do not replace genuine characterization with these shortcuts.

Do not invent trauma, history or motives absent from the card.

Write 200–300 words maximum, in flowing prose, present tense, third person. This is guidance for portrayal, not a character biography.

The character should feel like a specific, attractive, living person, not an adjective translated into behaviour.

--- CHARACTER CARD ---

{{card}}

--- END CARD ---

Output only the performance guide.`;

/* A profile is written from a card, and cards get edited. Without a fingerprint there
   is no way to know that the guide on screen describes a version of the character that
   no longer exists — it just quietly goes on being wrong. */
function cardStamp(text) {
    let h = 2166136261;
    const t = String(text || '');
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + t.length;
}
function isStale(prof, card) {
    if (!prof || !card) return false;
    if (!prof.stamp) return false;          // written before stamps existed: unknown, not stale
    return prof.stamp !== cardStamp(card.text);
}

// Deliberately delegating to buildCard: a second, near-identical copy of "what counts
// as the card" would drift from it, and then every profile would look stale forever.
function cardOf(avatar) {
    try { return avatar ? buildCard(avatar) : null; } catch (e) { return null; }
}

function charByAvatar(avatar) {
    return getContext().characters?.find(c => c.avatar === avatar) ?? null;
}

function groupId() {
    return selected_group ?? getContext().groupId ?? null;
}

function groupMembers() {
    const id = groupId();
    if (!id) return [];
    const src = groups ?? getContext().groups ?? [];
    const g = src.find(x => x.id === id);
    return (g?.members ?? []).map(charByAvatar).filter(Boolean);
}

function buildCard(avatar) {
    const ch = avatar ? charByAvatar(avatar) : getContext().characters?.[getContext().characterId];
    if (!ch) return null;

    const parts = [];
    const add = (label, v) => { if (v && String(v).trim()) parts.push(`${label}:\n${String(v).trim()}`); };
    add('Name', ch.name);
    add('Description', ch.description);
    add('Personality', ch.personality);
    add('Scenario', ch.scenario);
    add('First message', ch.first_mes);
    add('Example dialogue', ch.mes_example);
    const cc = ch.data?.extensions?.depth_prompt?.prompt;
    add('Author note', cc);
    return { avatar: ch.avatar, name: ch.name, text: parts.join('\n\n') };
}

/* One reading of "who is open" was not enough: characterId is absent in some states,
   a string in others, and after a reload it can lag behind the chat by a moment. So
   the question is asked four ways and the first honest answer wins — the button used
   to go dead whenever the first one came back empty. */
// Only ever returns an avatar that charByAvatar can actually find. Handing back one
// that cannot be resolved is how the panel ended up saying "that card could not be
// read" about a character it had just claimed was open.
function usable(av) {
    if (!av) return null;
    try { return charByAvatar(av) ? av : null; } catch (e) { return null; }
}

function panelAvatar() {
    const ctx = getContext();
    if (groupId()) {
        const members = groupMembers();
        if (!members.length) return null;
        if (selectedAvatar && members.some(m => m.avatar === selectedAvatar)) return selectedAvatar;
        return members[0].avatar;
    }
    const chars = ctx.characters || [];

    // 1. the index SillyTavern reports, string or number
    const id = ctx.characterId;
    if (id !== undefined && id !== null && id !== '') {
        const byId = chars[Number(id)] ?? chars[id];
        if (usable(byId?.avatar)) return byId.avatar;
    }
    // 2. the same index under its older name
    try {
        const chid = window.this_chid;
        if (chid !== undefined && chid !== null && chid !== '') {
            const byChid = chars[Number(chid)] ?? chars[chid];
            if (usable(byChid?.avatar)) return byChid.avatar;
        }
    } catch (e) { }
    // 3. by the name the chat is addressed to
    if (ctx.name2) {
        const byName = chars.find(c => c && c.name === ctx.name2);
        if (usable(byName?.avatar)) return byName.avatar;
    }
    // 4. by whoever spoke last
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && m.name) {
            const byMsg = chars.find(c => c && c.name === m.name);
            if (usable(byMsg?.avatar)) return byMsg.avatar;
        }
    }
    return null;
}

function getProfile(avatar = panelAvatar()) {
    if (!avatar) return null;
    return settings().profiles[avatar] ?? null;
}

function activeText(avatar) {
    const p = settings().profiles[avatar];
    return (p && !p.off && p.text?.trim()) ? p.text.trim() : null;
}

// ─────────────────────────────────────────────────────────────
// Инъекция
// ─────────────────────────────────────────────────────────────
const HEADER = "How to play this character's personality. This does not replace the character card; it explains what the card's traits mean in behaviour.";

function inject() {
    const s = settings();
    const clear = () => setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth, false, s.role);
    if (!s.enabled) return clear();

    let body = '';

    if (groupId()) {
        if (s.groupMode === 'all') {
            const chunks = groupMembers()
                .map(m => ({ name: m.name, text: activeText(m.avatar) }))
                .filter(x => x.text)
                .map(x => `[${x.name}]\n${x.text}`);
            if (chunks.length) body = `<character_interpretation>\n${HEADER}\n\n${chunks.join('\n\n')}\n</character_interpretation>`;
        } else {
            const text = draftedAvatar ? activeText(draftedAvatar) : null;
            const name = draftedAvatar ? charByAvatar(draftedAvatar)?.name : '';
            if (text) body = `<character_interpretation>\n${HEADER}\n\n[${name}]\n${text}\n</character_interpretation>`;
        }
    } else {
        const text = activeText(panelAvatar());
        if (text) body = `<character_interpretation>\n${HEADER}\n\n${text}\n</character_interpretation>`;
    }

    if (!body) return clear();
    setExtensionPrompt(PROMPT_KEY, body, s.position, s.depth, false, s.role);
}

// ─────────────────────────────────────────────────────────────
// Анализ
// ─────────────────────────────────────────────────────────────
let running = false;

// The avatar is now a parameter so a batch can drive it. Called with nothing, it
// behaves exactly as before and works on whoever the panel is showing.
async function analyze(forAvatar) {
    // Anything that is not a plain avatar string is treated as "not given" — an event
    // object, an index, a jQuery element. The batch passes a real avatar; every other
    // caller passes nothing.
    if (typeof forAvatar !== 'string' || !forAvatar) forAvatar = null;
    const s = settings();
    if (running) return;
    if (!apiKeyVal()) { toastr.warning('Set an API key for the analyzer first.'); return; }
    if (!apiModel()) { toastr.warning('Set a model name for the analyzer first.'); return; }

    const target = forAvatar || panelAvatar();
    const card = buildCard(target);
    if (!card) {
        // Say which of the two it is, rather than one message for both.
        toastr.warning(target
            ? 'That character card could not be read.'
            : 'Open a character chat first — no character is selected.', 'Character Lens');
        return;
    }

    running = true;
    setBusy(true);
    try {
        const tpl = s.template?.trim() ? s.template : ANALYZER;
        if (!tpl.includes('{{card}}')) throw new Error('Your analyzer prompt has no {{card}} placeholder, the card would never be sent.');
        // {{words}} is still substituted for anyone whose own prompt uses it; the
        // selector that fed it is gone, so the default now decides its own length.
        const words = Number(s.detail) || 260;
        // функция-заменитель: иначе $& и $' в тексте карты трактуются как спецпаттерны
        const prompt = tpl.replace('{{words}}', () => String(words)).replace('{{card}}', () => card.text);
        const text = (await callAnalyzer(prompt)).trim();
        if (!text) throw new Error('Empty response from the analyzer model.');

        s.profiles[card.avatar] = { ...(s.profiles[card.avatar] ?? {}), text, date: new Date().toISOString(), name: card.name, stamp: cardStamp(card.text) };
        await saveNow();
        renderProfile();
        inject();
        if (!forAvatar) toastr.success(`Interpretation ready for ${esc(card.name)}.`);
    } catch (err) {
        console.error('[Character Lens]', err);
        toastr.error(esc(err?.message ?? err), 'Character Lens');
    } finally {
        running = false;
        setBusy(false);
    }
}

// ─────────────────────────────────────────────────────────────
// Scene Art (CG)
// A manual button per message, not an automatic trigger — the person decides which
// moments are worth drawing, so there is no heuristic here guessing "is this scene
// pretty enough". Two model calls: a small one turns the moment into an image
// prompt, a multimodal one draws it (optionally anchored to a saved reference).
// ─────────────────────────────────────────────────────────────
/* tags/lora/loraStrength are only read in ComfyUI mode, but they live on the same
   profile so a character keeps one identity no matter which backend draws them.

   The reference picture is NOT here. SillyTavern rewrites the whole settings object on
   every save, and a save is triggered by typing in any field on this panel — so a
   ~120 KB data URL per character turned every keystroke into rewriting megabytes. The
   bytes live in IndexedDB, exactly like drawn scenes, and only the key is kept here. */
const BLANK_PROFILE = {
    sprite: null,        // legacy: only used when IndexedDB is unavailable
    spriteKey: '',       // where the reference actually lives
    desc: '', mode: 'both', tags: '', lora: '', loraStrength: 1,
    workflowId: '',      // '' means "whichever workflow is first in the list"
    identity: 'auto',    // auto | lora | reference | tags
    ipWeight: 0.65,      // IPAdapter weight; 1.0 drags the reference's pose in too
};

/* Decoded references, by avatar. Everything that draws reads from here synchronously —
   the picture is needed in render paths that cannot wait on a database. */
const spriteCache = new Map();

function spriteKeyFor(avatar) { return `character_lens_sprite:${avatar}`; }

function spriteFor(avatar) {
    if (!avatar) return null;
    if (spriteCache.has(avatar)) return spriteCache.get(avatar);
    return settings().cgProfiles?.[avatar]?.sprite ?? null;   // the no-IndexedDB fallback
}

function hasSprite(avatar) {
    if (!avatar) return false;
    const prof = settings().cgProfiles?.[avatar];
    return !!(spriteCache.get(avatar) || prof?.spriteKey || prof?.sprite);
}

async function loadSprite(avatar) {
    if (!avatar || spriteCache.has(avatar)) return spriteFor(avatar);
    const prof = settings().cgProfiles?.[avatar];
    if (prof?.sprite) return prof.sprite;
    if (!prof?.spriteKey) return null;
    try {
        const data = (await cgStore()?.getItem(prof.spriteKey)) ?? null;
        if (data) spriteCache.set(avatar, data);
        return data;
    } catch (e) {
        console.warn('[Character Lens] could not read a reference image', e);
        return null;
    }
}

async function setSprite(avatar, dataUrl) {
    const prof = cgProfile(avatar);
    const store = cgStore();
    if (store) {
        const key = spriteKeyFor(avatar);
        await store.setItem(key, dataUrl);
        prof.spriteKey = key;
        prof.sprite = null;          // never let the bytes back into the settings file
    } else {
        prof.sprite = dataUrl;       // no database: better a fat settings file than no reference
        prof.spriteKey = '';
    }
    spriteCache.set(avatar, dataUrl);
}

async function clearSprite(avatar) {
    const prof = cgProfile(avatar);
    if (prof.spriteKey) {
        try { await cgStore()?.removeItem(prof.spriteKey); }
        catch (e) { console.warn('[Character Lens] could not delete a reference image', e); }
    }
    prof.spriteKey = '';
    prof.sprite = null;
    spriteCache.delete(avatar);
}

/* One-shot move of references saved by older versions. Runs once at start-up; each
   picture is written to IndexedDB and dropped from the profile, and the settings are
   saved once at the end rather than per character. */
async function migrateSprites() {
    const store = cgStore();
    if (!store) return 0;
    const profiles = settings().cgProfiles || {};
    let moved = 0;
    for (const [avatar, prof] of Object.entries(profiles)) {
        if (typeof prof?.sprite !== 'string' || !prof.sprite.startsWith('data:')) continue;
        try {
            const key = spriteKeyFor(avatar);
            await store.setItem(key, prof.sprite);
            spriteCache.set(avatar, prof.sprite);
            prof.spriteKey = key;
            prof.sprite = null;
            moved++;
        } catch (e) {
            console.warn('[Character Lens] could not move a reference image out of settings', e);
        }
    }
    if (moved) {
        await saveNow();
        console.debug(`[Character Lens] moved ${moved} reference image(s) out of the settings file`);
    }
    return moved;
}

function cgProfile(avatar) {
    const s = settings();
    if (!avatar) return structuredClone(BLANK_PROFILE);
    if (!s.cgProfiles[avatar]) s.cgProfiles[avatar] = structuredClone(BLANK_PROFILE);
    const p = s.cgProfiles[avatar];
    // a profile saved before these fields existed must not lose the ones it does have
    for (const k of Object.keys(BLANK_PROFILE)) if (p[k] === undefined) p[k] = BLANK_PROFILE[k];
    const n = Number(p.loraStrength);
    p.loraStrength = Number.isFinite(n) ? Math.max(-2, Math.min(3, n)) : 1;
    const w = Number(p.ipWeight);
    p.ipWeight = Number.isFinite(w) ? Math.max(0, Math.min(2, w)) : 0.65;
    if (!['auto', 'lora', 'reference', 'tags'].includes(p.identity)) p.identity = 'auto';
    return p;
}

/* ── The named workflow list ─────────────────────────────────
   Ids are generated rather than derived from the name, so renaming a workflow does
   not orphan every character pointing at it. */
function newWorkflowId() {
    return 'wf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function workflowList() { return settings().comfy.workflows; }

function workflowById(id) {
    return workflowList().find(w => w.id === id) ?? null;
}

/* What a character actually draws with: their own choice, or the first workflow in the
   list when they have not chosen (or their choice has since been deleted). */
function workflowForProfile(prof) {
    return workflowById(prof?.workflowId) ?? workflowList()[0] ?? null;
}

function activeWorkflow() {
    return workflowById(settings().comfy.activeWorkflow) ?? workflowList()[0] ?? null;
}

function createWorkflow(name, text = '') {
    const wf = { id: newWorkflowId(), name: String(name || 'Untitled').trim() || 'Untitled', text: String(text || '') };
    workflowList().push(wf);
    settings().comfy.activeWorkflow = wf.id;
    return wf;
}

/* Deleting leaves the characters that pointed here pointing at nothing, which
   workflowForProfile() reads as "use the first one" — a sane landing spot, but it is
   worth telling the person how many of them there were. */
function deleteWorkflow(id) {
    const s = settings();
    const i = s.comfy.workflows.findIndex(w => w.id === id);
    if (i < 0) return 0;
    s.comfy.workflows.splice(i, 1);
    let orphans = 0;
    for (const prof of Object.values(s.cgProfiles)) {
        if (prof?.workflowId === id) { prof.workflowId = ''; orphans++; }
    }
    if (s.comfy.activeWorkflow === id) s.comfy.activeWorkflow = s.comfy.workflows[0]?.id ?? '';
    return orphans;
}

/* ── Tags from a reference picture ───────────────────────────
   The gap this fills: an original character off a card has no LoRA and never will,
   so their identity has to come from the tag block — and writing that block by hand,
   per character, is the actual chore. A multimodal model can read it off the very
   reference image already saved for them. Uses the Analyzer endpoint, not the image
   one: in ComfyUI mode the image endpoint is a local server that cannot see. */
const VISION_TAGGER_SYS = `Look at this character reference image and describe ONLY the character's permanent appearance as danbooru-style tags, for an anime image model.

Include, when visible: how many characters and their sex (1girl, 1boy, solo), hair colour, hair length and hairstyle, eye colour, distinctive features (hair ornaments, glasses, scars, animal ears), and their usual outfit piece by piece with its colours.

Do NOT include: the pose, the expression, the emotion, the background, the lighting, the framing, the art style, or any quality words like "masterpiece". Those are added separately and would fight with the scene.

Output one line of comma-separated lowercase tags and nothing else. No sentences, no explanation, no numbering.`;

async function callVisionTagger(dataUrl) {
    const s = settings();
    const model = s.cgPromptModel?.trim() || apiModel();
    if (!apiKeyVal()) throw new Error('No API key. Set the Analyzer API key above — reading a reference image borrows it.');
    if (!model) throw new Error('No model set. This needs a model that can see images, e.g. a Gemini or GPT vision model.');
    const url = apiUrl().replace(/\/$/, '') + '/chat/completions';
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKeyVal().trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: VISION_TAGGER_SYS },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            }],
            temperature: 0.2,   // this is transcription, not invention
            max_tokens: 300,
        }),
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch (e) { }
        throw new Error(`HTTP ${resp.status} ${detail}`.trim() + (resp.status === 400 ? ' — the model may not accept images. Set a vision-capable model in "Prompt writer model".' : ''));
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : content?.map?.(c => c?.text ?? '').join(' ');
    if (!text || !text.trim()) throw new Error('The model returned nothing. It may not be able to see images.');
    // models like to prefix "Tags:" or wrap the line in backticks
    return cleanTags(String(text).replace(/```/g, '').replace(/^\s*tags\s*:/i, ''));
}

/* Named to be told apart from callAnalyzer at a glance: this one writes a short
   image prompt, not a performance guide, and it is allowed to use a cheaper model. */
async function callPromptWriter(prompt) {
    const s = settings();
    const model = s.cgPromptModel?.trim() || apiModel();
    if (!apiKeyVal()) throw new Error('No API key. Set the Analyzer API key above — the prompt writer borrows it unless a separate model is set.');
    if (!model) throw new Error('No model for the prompt writer.');
    const url = apiUrl().replace(/\/$/, '') + '/chat/completions';
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKeyVal().trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.85,
            max_tokens: 350,
        }),
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch (e) { }
        throw new Error(`HTTP ${resp.status} ${detail}`.trim());
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty response from the prompt-writer model.');
    return content.trim();
}

/* Two real request shapes exist in the wild — guessing wrong just produces the
   same confusing "model not found" error one layer removed, so this is explicit
   rather than silently assumed:
   - "images": POST {base}/images/generations — {model, prompt, image_url, ...},
     response in data[0].url / data[0].b64_json. The OpenAI-standard shape; NavyAI,
     most proxy services, and OpenAI itself all use this one.
   - "chat": POST {base}/chat/completions with modalities:['image','text'] — the
     newer, OpenRouter-specific convention for routing to Gemini/Grok image models.
   - "comfy": a local ComfyUI. Not OpenAI-shaped at all: POST {base}/prompt with the
     whole graph, then poll {base}/history/{id} until the outputs appear, then read
     the file off {base}/view. Handled in its own function below. */
function imgApiMode() {
    const s = settings();
    if (s.img.mode === 'images' || s.img.mode === 'chat' || s.img.mode === 'comfy') return s.img.mode;
    const url = String(s.img.apiUrl || apiUrl()).toLowerCase();
    // ComfyUI's own port and name are unmistakable, and neither belongs to a cloud API
    if (/:8188(\/|$)/.test(url) || url.includes('comfyui')) return 'comfy';
    return url.includes('openrouter') ? 'chat' : 'images';
}

/* ── ComfyUI ─────────────────────────────────────────────────
   The URL is taken raw, never through normalizeBase(): that helper exists to bolt
   /v1 onto OpenAI-style endpoints, and http://127.0.0.1:8188/v1 is a 404 here. */
function comfyBase() {
    return String(settings().img.apiUrl || '').trim().replace(/\/+$/, '');
}

/* %prompt_a% / %prompt_b% / %prompt_scene% exist for regional workflows. A flat tag
   list cannot say whose hair is whose — the model reads "blonde hair, brown hair" as
   one pile and gives both people a bit of each. Splitting the two people into separate
   conditioning branches is the only thing that actually assigns ownership. */
const COMFY_TOKENS = ['%prompt%', '%prompt_a%', '%prompt_b%', '%prompt_scene%', '%negative%', '%seed%', '%image%', '%lora%', '%lora_strength%', '%ipadapter_weight%'];

function comfySleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Removes the LoRA loader from a graph for a character who has no LoRA, instead of
   refusing to draw. An empty lora_name fails ComfyUI's validation, and the API format
   has no "bypass" flag, so the node is spliced out by hand: everything that read its
   outputs is pointed at whatever fed its inputs. A LoraLoader passes MODEL through
   from `model` and CLIP from `clip`, so the mapping is exact rather than a guess.
   Only nodes carrying OUR %lora% placeholder are touched — a LoRA the person wired in
   deliberately, with a filename of their own, is none of this function's business. */
function comfyBypassLora(graph) {
    const passthrough = new Map();
    for (const [id, node] of Object.entries(graph)) {
        const type = node?.class_type;
        if (type !== 'LoraLoader' && type !== 'LoraLoaderModelOnly') continue;
        if (node?.inputs?.lora_name !== '%lora%') continue;
        const model = node.inputs.model;
        const clip = node.inputs.clip;
        if (!Array.isArray(model)) continue;                                  // nothing to splice to
        if (type === 'LoraLoader' && !Array.isArray(clip)) continue;
        passthrough.set(String(id), type === 'LoraLoader' ? { 0: model, 1: clip } : { 0: model });
    }
    if (!passthrough.size) return 0;

    const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'number';
    // loaders can be daisy-chained, so follow the trail until it leaves the removed set
    const resolve = (link, depth = 0) => {
        if (!isLink(link) || depth > 32) return link;
        const target = passthrough.get(String(link[0]));
        if (!target || target[link[1]] === undefined) return link;
        return resolve(target[link[1]], depth + 1);
    };
    for (const [id, node] of Object.entries(graph)) {
        if (passthrough.has(id) || !node?.inputs) continue;
        for (const k of Object.keys(node.inputs)) {
            if (isLink(node.inputs[k])) node.inputs[k] = resolve(node.inputs[k]);
        }
    }
    for (const id of passthrough.keys()) delete graph[id];
    return passthrough.size;
}

/* Substitution happens on the PARSED graph, not on the JSON text. Replacing tokens in
   the text first would break the moment a scene prompt contained a quote or a newline —
   the JSON would simply stop parsing. Walking the object also lets %seed% come out as a
   real number when it is the whole value, which is what KSampler expects. */
function comfyFillWorkflow(text, { prompt, promptA, promptB, promptScene, negative, imageName, lora, loraStrength, ipWeight, bypassLora }) {
    let graph;
    try {
        graph = JSON.parse(text);
    } catch (e) {
        throw new Error(`The ComfyUI workflow is not valid JSON: ${e.message}`);
    }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        throw new Error('The workflow must be a JSON object of nodes.');
    }
    if (Array.isArray(graph.nodes)) {
        throw new Error('That is the editor workflow, not the API one. In ComfyUI use Workflow → Export (API), or enable dev mode and use "Save (API format)".');
    }

    // done before substitution, while the placeholder is still recognisable
    const bypassed = bypassLora ? comfyBypassLora(graph) : 0;

    const counts = { '%prompt%': 0, '%prompt_a%': 0, '%prompt_b%': 0, '%prompt_scene%': 0, '%negative%': 0, '%seed%': 0, '%image%': 0, '%lora%': 0, '%lora_strength%': 0, '%ipadapter_weight%': 0 };
    const values = {
        '%prompt%': String(prompt ?? ''),
        // a regional workflow that is handed a one-person scene simply gets an empty
        // partner branch, which contributes nothing rather than breaking
        '%prompt_a%': String(promptA ?? prompt ?? ''),
        '%prompt_b%': String(promptB ?? ''),
        '%prompt_scene%': String(promptScene ?? ''),
        '%negative%': String(negative ?? ''),
        '%image%': String(imageName ?? ''),
        '%lora%': String(lora ?? ''),
    };
    const seed = Math.floor(Math.random() * 1_000_000_000_000_000);
    const strength = Number.isFinite(Number(loraStrength)) ? Number(loraStrength) : 1;
    const ipw = Number.isFinite(Number(ipWeight)) ? Number(ipWeight) : 0.65;
    const numbers = { '%seed%': seed, '%lora_strength%': strength, '%ipadapter_weight%': ipw };

    const walk = (node) => {
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                if (typeof node[i] === 'string') node[i] = swap(node[i]);
                else walk(node[i]);
            }
            return;
        }
        if (node && typeof node === 'object') {
            for (const k of Object.keys(node)) {
                if (typeof node[k] === 'string') node[k] = swap(node[k]);
                else walk(node[k]);
            }
        }
    };
    const swap = (str) => {
        // whole value is a number token: hand back a number, not "12345" — KSampler
        // and the IPAdapter nodes both reject a numeric input arriving as a string
        if (numbers[str] !== undefined) { counts[str]++; return numbers[str]; }
        let out = str;
        for (const t of COMFY_TOKENS) {
            if (numbers[t] !== undefined) continue;
            if (out.includes(t)) { counts[t] += out.split(t).length - 1; out = out.split(t).join(values[t]); }
        }
        // embedded in a longer string there is no choice but to print the number
        for (const [t, v] of Object.entries(numbers)) {
            if (out.includes(t)) { counts[t] += out.split(t).length - 1; out = out.split(t).join(String(v)); }
        }
        return out;
    };
    walk(graph);

    if (!counts['%prompt%'] && !counts['%prompt_a%']) {
        throw new Error('The workflow has no %prompt% or %prompt_a% placeholder, so the scene description would never reach it. Put %prompt% in the positive CLIPTextEncode node.');
    }
    /* An empty lora_name is not a "no LoRA" value — ComfyUI fails to validate the node.
       Saying so here is far clearer than the validation error that would come back. */
    if (counts['%lora%'] && !values['%lora%']) {
        throw new Error(bypassLora
            ? 'This character uses no LoRA, but the workflow\'s LoraLoader could not be removed automatically — its model input is not connected to anything. Pick a LoRA for this character, or take the node out of the workflow.'
            : 'The workflow has a %lora% placeholder but this character has no LoRA selected. Pick one in the character block above, or take the LoraLoader out of the workflow.');
    }
    return { graph, counts, seed, bypassed };
}

/* Reference images have to exist as a file on the ComfyUI side before a LoadImage node
   can name one — there is no "here is an image, inline" like the cloud APIs take. */
async function comfyUploadReference(base, dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append('image', blob, `character-lens-reference.png`);
    form.append('type', 'input');
    form.append('overwrite', 'true');   // one slot, reused, instead of littering input/
    const resp = await fetch(`${base}/upload/image`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`ComfyUI refused the reference image: HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data?.name) throw new Error('ComfyUI accepted the reference image but did not say where it put it.');
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function callComfyUI(promptText, spriteDataUrl, extras = {}) {
    const s = settings();
    const base = comfyBase();
    if (!base) throw new Error('ComfyUI needs its own address — put it in the Image API URL field, e.g. http://127.0.0.1:8188');

    const wf = extras.workflow ?? workflowList()[0] ?? null;
    if (!wf) throw new Error('No ComfyUI workflow saved yet. Add one under Scene Art, or press "Insert example".');
    const text = String(wf.text || '').trim();
    if (!text) throw new Error(`The workflow "${wf.name}" is empty. Paste a graph in API format, or press "Insert example".`);

    /* The identity source decides what is allowed to travel, not what happens to be
       filled in: a character set to "tags only" must not quietly keep using a LoRA
       left over from an experiment. */
    const identity = extras.identity || 'auto';
    const wantsReference = identity === 'auto' || identity === 'reference';
    const chosenLora = String(extras.lora || '');

    /* "auto" means whatever is actually set, so a character with no LoRA selected uses
       no LoRA — that is not an error state, it is the normal case for an original
       character off a card. Only an explicit "identity: LoRA" with nothing selected is
       a contradiction worth stopping for. */
    const useLora = (identity === 'lora' || identity === 'auto') && !!chosenLora;
    if (identity === 'lora' && !chosenLora) {
        throw new Error(`This character's identity is set to "Character LoRA", but no LoRA is selected for them. Pick one in the character block, or change the identity source.`);
    }

    // uploading a reference the graph has nowhere to put is just a wasted round trip
    let imageName = '';
    if (spriteDataUrl && wantsReference && text.includes('%image%')) {
        imageName = await comfyUploadReference(base, spriteDataUrl);
    }
    if (identity === 'reference' && text.includes('%image%') && !imageName) {
        throw new Error(`This character draws from their reference image, but none is saved. Upload one in the character block, or switch the identity source.`);
    }

    const { graph, counts, bypassed } = comfyFillWorkflow(text, {
        prompt: promptText,
        promptA: extras.promptA,
        promptB: extras.promptB,
        promptScene: extras.promptScene,
        negative: s.comfy.negative || '',
        imageName,
        lora: useLora ? chosenLora : '',
        loraStrength: extras.loraStrength,
        ipWeight: extras.ipWeight,
        bypassLora: !useLora,
    });

    /* The quiet failure this catches: a LoRA is picked for the character, the graph has
       no LoraLoader, and the picture comes out looking like nobody in particular with
       nothing anywhere saying why. Same for a reference that the graph cannot accept. */
    if (useLora && !counts['%lora%']) {
        toastr.warning(`The workflow "${esc(wf.name)}" has no %lora% placeholder, so the LoRA was not used. Add a LoraLoader node with %lora% in lora_name, or press "Example: LoRA".`, 'Character Lens', { timeOut: 12000 });
    }
    /* Checked against the graph text, not against counts: when the placeholder is
       missing the upload never happens either, so imageName is empty and a
       counts-based check here could never fire at all. */
    if (spriteDataUrl && wantsReference && !text.includes('%image%')) {
        toastr.warning(`The workflow "${esc(wf.name)}" has no %image% placeholder, so the reference image was not used. Press "Example: IPAdapter", or add a LoadImage node with %image%.`, 'Character Lens', { timeOut: 12000 });
    }
    // the exact graph that went out, for when something still looks wrong
    console.debug('[Character Lens] ComfyUI graph sent', { workflow: wf.name, lora: useLora ? chosenLora : null, bypassedLoraNodes: bypassed, counts, graph });

    const clientId = 'character-lens-' + Math.random().toString(36).slice(2, 10);
    let resp;
    try {
        resp = await fetch(`${base}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: graph, client_id: clientId }),
        });
    } catch (e) {
        // a browser CORS block and a dead server look identical from here, so say both
        throw new Error(`Could not reach ComfyUI at ${base}. Check that it is running, and that it was started with --enable-cors-header so the browser is allowed to talk to it.`);
    }
    if (!resp.ok) {
        let detail = '';
        try {
            const err = await resp.json();
            const node = err?.node_errors && Object.values(err.node_errors)[0];
            detail = node?.errors?.[0]?.message || err?.error?.message || err?.error || '';
        } catch (e) { /* ComfyUI answers with plain text on some failures */ }
        throw new Error(`ComfyUI rejected the workflow: HTTP ${resp.status} ${detail}`.trim());
    }
    const queued = await resp.json();
    const promptId = queued?.prompt_id;
    if (!promptId) throw new Error('ComfyUI did not return a prompt id.');
    if (queued?.node_errors && Object.keys(queued.node_errors).length) {
        const first = Object.entries(queued.node_errors)[0];
        throw new Error(`ComfyUI reported a problem in node ${first[0]}: ${first[1]?.errors?.[0]?.message || 'see the ComfyUI console'}`);
    }

    /* Polling rather than the websocket: one less connection to keep alive and to tear
       down when a chat is switched mid-render, and /history is the authoritative answer
       either way. */
    const deadline = Date.now() + (Number(s.comfy.timeout) || 240) * 1000;
    while (Date.now() < deadline) {
        await comfySleep(1200);
        let entry;
        try {
            const h = await fetch(`${base}/history/${encodeURIComponent(promptId)}`);
            if (!h.ok) continue;
            entry = (await h.json())?.[promptId];
        } catch (e) { continue; }   // a hiccup mid-render is not a failure; the deadline decides
        if (!entry) continue;

        const status = entry.status?.status_str;
        if (status === 'error') {
            const msg = entry.status?.messages?.find(m => m?.[0] === 'execution_error')?.[1];
            throw new Error(`ComfyUI failed while rendering: ${msg?.exception_message || 'see the ComfyUI console for the full traceback'}`);
        }
        for (const out of Object.values(entry.outputs || {})) {
            const img = out?.images?.[0];
            if (!img?.filename) continue;
            const q = new URLSearchParams({
                filename: img.filename,
                subfolder: img.subfolder || '',
                type: img.type || 'output',
            });
            // the browser loads this straight from the local server — no base64 round
            // trip, so a 2K CG does not become a multi-megabyte string in memory
            return `${base}/view?${q.toString()}`;
        }
        if (entry.status?.completed) {
            throw new Error('ComfyUI finished but produced no image. Does the workflow end in a SaveImage or PreviewImage node?');
        }
    }
    throw new Error(`ComfyUI did not finish within ${Number(s.comfy.timeout) || 240}s. Raise the wait time under Scene Art if your card needs longer.`);
}

/* The image call is deliberately separate from callAnalyzer/callPromptWriter —
   it needs a different endpoint and body shape entirely, on top of image input,
   neither of which the text calls above ever send. */
async function callImageModel(promptText, spriteDataUrl, extras = {}) {
    const s = settings();
    const mode = imgApiMode();

    // A local ComfyUI has no key and no model name to check — it is asked for first so
    // those two cloud-only guards below cannot reject a perfectly valid local setup.
    // extras is ignored by the cloud branches: a LoRA is a local-model idea.
    if (mode === 'comfy') return callComfyUI(promptText, spriteDataUrl, extras);

    const base = String(s.img.apiUrl || apiUrl()).replace(/\/$/, '');
    const key = String(s.img.apiKey || apiKeyVal()).trim();
    const model = String(s.img.model || '').trim();
    if (!key) throw new Error('No image API key. Set it under Scene Art, or leave it empty to reuse the Analyzer key.');
    if (!model) throw new Error('No image model set. Scene Art needs its own model name.');

    if (mode === 'images') {
        const body = { model, prompt: promptText, response_format: 'url', sync: true };
        if (spriteDataUrl) body.image_url = spriteDataUrl;
        const resp = await fetch(`${base}/images/generations`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            let detail = '';
            try { detail = (await resp.json())?.error?.message || ''; } catch (e) { }
            throw new Error(`HTTP ${resp.status} ${detail}`.trim());
        }
        const data = await resp.json();
        const item = Array.isArray(data?.data) ? data.data[0] : null;
        const imgUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
        if (imgUrl) return imgUrl;
        if (data?.id) throw new Error("This provider queued the job instead of answering right away (async). Polling isn't wired up here yet — try again, or pick a model/provider that answers synchronously.");
        throw new Error('The model returned no image. Check the model name under Scene Art.');
    }

    // mode === 'chat': OpenRouter-style chat/completions + modalities
    const content = [{ type: 'text', text: promptText }];
    if (spriteDataUrl) content.push({ type: 'image_url', image_url: { url: spriteDataUrl } });
    const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }),
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch (e) { }
        throw new Error(`HTTP ${resp.status} ${detail}`.trim());
    }
    const data = await resp.json();
    const images = data?.choices?.[0]?.message?.images;
    const found = Array.isArray(images) ? images[0] : null;
    const imgUrl = found?.image_url?.url || found?.url;
    if (typeof imgUrl !== 'string' || !imgUrl) {
        throw new Error('The model returned no image. It may not support image output — check the model name under Scene Art.');
    }
    return imgUrl;
}

/* A starting point that runs on a stock ComfyUI: core nodes only, nothing to install.
   The checkpoint is the one thing that cannot be guessed, so it is asked for — a
   workflow shipped with a made-up filename fails on the first click and looks broken. */
function comfyExampleWorkflow(ckpt) {
    return JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832, batch_size: 1 } },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
            },
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'CharacterLens', images: ['6', 0] } },
    }, null, 2);
}

/* The plain example with a LoraLoader spliced between the checkpoint and everything
   downstream. Both the model and the clip have to come through the loader, or the
   trigger word in the prompt reaches a CLIP that has never heard of it. */
function comfyLoraWorkflow(ckpt) {
    return JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        '8': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: '%lora%', strength_model: '%lora_strength%', strength_clip: '%lora_strength%',
                model: ['1', 0], clip: ['1', 1],
            },
        },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['8', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['8', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832, batch_size: 1 } },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                denoise: 1, model: ['8', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
            },
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'CharacterLens', images: ['6', 0] } },
    }, null, 2);
}

/* Two people without their attributes bleeding together. A flat tag list gives the
   model no way to know whose hair is whose, so each person is encoded separately and
   confined to one side of the canvas with ConditioningSetAreaPercentage. The scene
   branch covers the whole canvas at reduced strength so lighting and background stay
   shared. All core nodes.

   The two halves overlap in the middle on purpose — an embrace needs them to touch. */
function comfyRegionalWorkflow(ckpt) {
    return JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        '8': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: '%lora%', strength_model: '%lora_strength%', strength_clip: '%lora_strength%',
                model: ['1', 0], clip: ['1', 1],
            },
        },
        // style, count and framing — everything both people share. Encoded with the
        // BASE clip, not the LoRA one, so a character LoRA does not colour the shared
        // description of the room.
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt_scene%', clip: ['1', 1] } },
        // the character, left side — the only branch encoded through the LoRA's clip,
        // which is what binds their trigger word to this half rather than the whole image
        '20': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt_a%', clip: ['8', 1] } },
        // the partner, right side; base clip again, so the LoRA has no say in who they
        // are. Empty in a one-person scene, which costs nothing.
        '21': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt_b%', clip: ['1', 1] } },
        '22': { class_type: 'ConditioningSetAreaPercentage', inputs: { conditioning: ['2', 0], width: 1, height: 1, x: 0, y: 0, strength: 0.4 } },
        '23': { class_type: 'ConditioningSetAreaPercentage', inputs: { conditioning: ['20', 0], width: 0.55, height: 1, x: 0, y: 0, strength: 1 } },
        '24': { class_type: 'ConditioningSetAreaPercentage', inputs: { conditioning: ['21', 0], width: 0.55, height: 1, x: 0.45, y: 0, strength: 1 } },
        '25': { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['22', 0], conditioning_2: ['23', 0] } },
        '26': { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['25', 0], conditioning_2: ['24', 0] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['1', 1] } },
        // landscape: two people need room side by side
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832, batch_size: 1 } },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                denoise: 1, model: ['8', 0], positive: ['26', 0], negative: ['3', 0], latent_image: ['4', 0],
            },
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'CharacterLens', images: ['6', 0] } },
    }, null, 2);
}

/* Two passes over the same scene. Eyes come out mushy for an arithmetic reason rather
   than an artistic one: on a 1216x832 canvas a face is a small fraction of the frame
   and an eye is a handful of latent pixels, with nothing to build an iris out of. The
   second pass runs over an upscaled latent, so the same face is twice the pixels and
   the detail appears on its own. Core nodes only — nothing to install.

   The LoraLoader is included on purpose: a character without a LoRA has it spliced out
   of the request automatically, so one workflow serves everybody. */
function comfyHiresWorkflow(ckpt) {
    return JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        '8': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: '%lora%', strength_model: '%lora_strength%', strength_clip: '%lora_strength%',
                model: ['1', 0], clip: ['1', 1],
            },
        },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['8', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['8', 1] } },
        // portrait by default: a face fills more of the frame at the same pixel cost
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                denoise: 1, model: ['8', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
            },
        },
        // lower scale_by to 1.25 if VRAM is tight; this is the memory-hungry step
        '20': { class_type: 'LatentUpscaleBy', inputs: { samples: ['5', 0], upscale_method: 'nearest-exact', scale_by: 1.5 } },
        '21': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 14, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                // high enough to redraw detail, low enough to keep the composition
                denoise: 0.45, model: ['8', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['20', 0],
            },
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['21', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'CharacterLens', images: ['6', 0] } },
    }, null, 2);
}

/* Reads a node's own schema and fills in whatever it says the defaults are. FaceDetailer
   has around thirty required inputs and the set has changed between Impact Pack
   releases, so hardcoding them would ship an example that breaks on somebody's version.
   Link-typed inputs (MODEL, IMAGE, ...) have no default and are wired by the caller. */
function comfyDefaultInputs(info, nodeName) {
    const required = info?.[nodeName]?.input?.required ?? {};
    const out = {};
    for (const [name, spec] of Object.entries(required)) {
        if (!Array.isArray(spec)) continue;
        const [type, opts] = spec;
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'default')) out[name] = opts.default;
        else if (Array.isArray(type) && type.length) out[name] = type[0];   // a combo: take the first option
    }
    return out;
}

/* The strongest fix for eyes: the face is cropped out, redrawn on its own at full
   resolution, and pasted back. Needs Impact Pack plus Impact Subpack (the detector
   provider lives there) and a face detection model. */
function comfyFaceDetailerWorkflow(ckpt, info) {
    const detectorModels = info?.UltralyticsDetectorProvider?.input?.required?.model_name?.[0] ?? [];
    const bbox = detectorModels.find(m => String(m).startsWith('bbox/')) ?? detectorModels[0];
    if (!bbox) {
        throw new Error('ComfyUI has the detector node but no detection model. Download bbox/face_yolov8m.pt through the Manager (Model Manager), then try again.');
    }
    const detailer = comfyDefaultInputs(info, 'FaceDetailer');
    return JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        '8': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: '%lora%', strength_model: '%lora_strength%', strength_clip: '%lora_strength%',
                model: ['1', 0], clip: ['1', 1],
            },
        },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['8', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['8', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                denoise: 1, model: ['8', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
            },
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '30': { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: bbox } },
        '31': {
            class_type: 'FaceDetailer',
            inputs: {
                ...detailer,
                seed: '%seed%',
                denoise: 0.5,          // repaint the face without inventing a different one
                image: ['6', 0], model: ['8', 0], clip: ['8', 1], vae: ['1', 2],
                positive: ['2', 0], negative: ['3', 0], bbox_detector: ['30', 0],
            },
        },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'CharacterLens', images: ['31', 0] } },
    }, null, 2);
}

/* Which add-on to point at. The detector provider is the trap here: it does not live
   in Impact Pack itself but in the separate Impact Subpack, and being sent to the
   wrong one is a wasted evening. */
function packageFor(missing) {
    const names = missing.join(' ');
    const packs = [];
    if (/IPAdapter/.test(names)) packs.push('ComfyUI_IPAdapter_plus');
    if (/UltralyticsDetectorProvider/.test(names)) packs.push('ComfyUI-Impact-Subpack');
    if (/FaceDetailer|Detailer|SEGS/.test(names)) packs.push('ComfyUI-Impact-Pack');
    return packs.length ? packs.join(' and ') : 'the add-on that provides them';
}

/* The IPAdapter route, for characters who will never have a LoRA. Weight lives on
   %ipadapter_weight% because the right value is per character and per reference: at
   1.0 the adapter starts dragging the reference's pose and framing into every scene,
   so every picture comes out looking like the sprite. 0.6-0.7 is the usable band. */
function comfyIPAdapterWorkflow(ckpt) {
    return JSON.stringify({
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative%', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832, batch_size: 1 } },
        '10': { class_type: 'LoadImage', inputs: { image: '%image%', upload: 'image' } },
        '11': { class_type: 'IPAdapterUnifiedLoader', inputs: { model: ['1', 0], preset: 'PLUS (high strength)' } },
        '12': {
            class_type: 'IPAdapterAdvanced',
            inputs: {
                model: ['11', 0], ipadapter: ['11', 1], image: ['10', 0],
                weight: '%ipadapter_weight%', weight_type: 'linear', combine_embeds: 'concat',
                start_at: 0, end_at: 1, embeds_scaling: 'V only',
            },
        },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%', steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras',
                denoise: 1, model: ['12', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
            },
        },
        '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'CharacterLens', images: ['6', 0] } },
    }, null, 2);
}

/* Handing over a graph that names nodes ComfyUI does not have produces a validation
   error listing node ids, which explains nothing. Asking first turns that into a
   sentence naming the thing to install. */
async function comfyCheckNodes(names) {
    const base = comfyBase();
    if (!base) return { ok: false, missing: names, reachable: false };
    try {
        const r = await fetch(`${base}/object_info`);
        if (!r.ok) return { ok: false, missing: names, reachable: false };
        const info = await r.json();
        const missing = names.filter(n => !info[n]);
        return { ok: !missing.length, missing, reachable: true, info };
    } catch (e) {
        return { ok: false, missing: names, reachable: false };
    }
}

async function comfyFirstCheckpoint() {
    const base = comfyBase();
    if (!base) return null;
    try {
        const r = await fetch(`${base}/object_info/CheckpointLoaderSimple`);
        if (!r.ok) return null;
        const info = await r.json();
        const list = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        return Array.isArray(list) && list.length ? String(list[0]) : null;
    } catch (e) { return null; }   // offline is fine: the caller falls back to a placeholder
}

/* The LoRA list is read once and kept, so opening the character dropdown does not hit
   ComfyUI on every render. The refresh button clears it. */
let comfyLoraCache = null;
async function comfyLoraList({ force = false } = {}) {
    if (comfyLoraCache && !force) return comfyLoraCache;
    const base = comfyBase();
    if (!base) return null;
    try {
        const r = await fetch(`${base}/object_info/LoraLoader`);
        if (!r.ok) return null;
        const info = await r.json();
        const list = info?.LoraLoader?.input?.required?.lora_name?.[0];
        if (!Array.isArray(list)) return null;
        comfyLoraCache = list.map(String);
        return comfyLoraCache;
    } catch (e) { return null; }
}

/* Best-effort — matched by the character's own name against the roster, exactly
   the way panelAvatar()'s last resort already does for the settings panel. A
   message with no matching character (e.g. the user's own) returns null, and the
   caller declines rather than guessing which profile to draw with. */
function avatarForMessage(mesId) {
    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg || msg.is_user || msg.is_system) return null;
    const chars = ctx.characters || [];
    const byName = chars.find(c => c && c.name === msg.name);
    return byName?.avatar ?? null;
}

/* A short window around the clicked message, not the whole chat — the prompt
   writer needs to know what is happening right now, not summarise the story. */
function contextAround(mesId, span = 2) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const from = Math.max(0, mesId - span);
    return chat.slice(from, mesId + 1)
        .map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || '')}: ${String(m.mes || '').replace(/<[^>]+>/g, '').slice(0, 500)}`)
        .join('\n');
}

/* ── Style presets ──────────────────────────────────────────
   Each preset is baked into the PROMPT-WRITER's own instructions, not just
   tacked onto the end of the output — it shapes which pose, expression and
   lighting the writer reaches for, not just which words it decorates them with.
   Kept tasteful throughout: attractive, expressive, romantic — never explicit. */
const CG_PRESETS = {
    otome: {
        label: 'Otome / Bishounen Romance',
        text: `Genre: otome-game romance CG, aimed at a female player courted by an attractive man.
Character rendering: elegant, refined bishounen features — sharp but soft jawline, long lashes, detailed expressive eyes with a bright catchlight. Hair rendered with individual flowing strands and soft highlights.
Mood and expression: the face carries the emotional weight of the scene — a tender half-smile, a searching gaze, a faint blush at the cheeks when the moment calls for it. Never a blank or neutral expression.
Lighting: warm and soft — golden hour, candlelight, or moonlight through a window. Gentle rim light along hair and shoulder to separate the character from the background.
Framing: an intimate medium close-up, chest-up or waist-up, the character often leaning toward the viewer or reaching a hand into frame. Background softly blurred (bokeh) so the face stays the clear focus.
Rendering: clean anime/manga line art, soft cel-shading with delicate gradients, glossy eye highlights, the overall polish of a commercial otome visual-novel CG.`,
    },
    eroge: {
        label: 'Eroge / Intimate Romance (tasteful, non-explicit)',
        text: `Genre: eroge-style romance CG aimed at a male player, drawn by an attractive woman's presence in the scene — intimate and charged, but tasteful, never explicit or nude.
Character rendering: soft, alluring anime features — large expressive eyes with detailed light reflections, delicate skin shading, hair with glossy highlights.
Mood and expression: charged with romantic tension — a shy glance, a knowing smile, parted lips mid-sentence, a blush. The expression should make the emotional stakes of the moment unmistakable.
Lighting: moody and intimate — dim room light, warm lamplight, or moonlight, with soft shadow gradients across the face. Rim lighting to add a sensual, glowing edge.
Framing: close, intimate — the character near the implied viewer, an inviting or vulnerable pose, but always fully clothed and tasteful. Background dark or softly blurred to hold focus on the character.
Rendering: polished anime CG illustration quality, soft shading, glossy highlights on eyes and lips, comparable to a mainstream commercial visual-novel CG.`,
    },
    shoujo: {
        label: 'Shoujo Soft & Sweet',
        text: `Genre: shoujo-manga-style romance CG — light, sweet, sparkling.
Character rendering: large sparkling eyes with multiple tiny highlight dots, soft rounded facial features, hair with a gentle shine.
Mood and expression: bright and heartfelt — a wide happy smile, wide-eyed surprise, or a soft blush and downcast eyes. Emotion is worn openly on the face.
Lighting: bright and airy, pastel-toned, with floating light particles or soft flower petals drifting through the frame when the scene calls for it.
Framing: a warm medium shot, open and inviting, often with a slight upward or dynamic tilt to the pose.
Rendering: clean, bright cel-shaded anime art, pastel palette, glossy eye highlights, the polish of a shoujo-manga colour illustration.`,
    },
    dark: {
        label: 'Dark Romance / Gothic',
        text: `Genre: dark-fantasy or gothic romance CG — brooding, dramatic, intense.
Character rendering: striking, sharp features with intense, heavy-lidded eyes; dramatic hair rendering with deep shadow and sharp highlights.
Mood and expression: intense and charged — a smouldering gaze, a dangerous half-smile, or quiet vulnerability behind a guarded expression. Never flat or emotionless.
Lighting: high-contrast and moody — deep shadow, a single dramatic light source (candle, moonlight, firelight), rich saturated colour in the shadows (deep red, violet, blue).
Framing: close and imposing, often looking down at or intensely toward the viewer, dramatic negative space in the background.
Rendering: painterly anime illustration with strong contrast, glossy highlights, the polish of a dark-fantasy visual-novel CG.`,
    },
    none: { label: 'No preset (style field only)', text: '' },
};

function cgPresetText(id) {
    const s = settings();
    const override = s.cgPresetOverrides?.[id];
    if (typeof override === 'string' && override.trim()) return override;
    return CG_PRESETS[id]?.text || '';
}
function cgPresetDefaultText(id) { return CG_PRESETS[id]?.text || ''; }

const PROMPT_WRITER_SYS = `Read the character description and the recent moment below, then write ONE vivid, concrete prompt for an illustrator to draw a single scene (a "CG") capturing exactly this moment.

The prompt must specify: the character's pose, their exact facial expression and what emotion it shows, the setting, the lighting, and the framing. Two to five sentences.

This is a visual-novel-style character CG, not a flat neutral illustration — the character's face and emotional expression are the whole point of the image. A generic, emotionless or purely descriptive prompt is a FAILURE; every prompt must give the illustrator a clear, specific expression to draw (what the eyes are doing, what the mouth is doing) and a reason the character looks appealing in this exact moment — flattering angle, expressive eyes, attractive lighting on the face.

Describe only what should be SEEN. Never write dialogue, narration, or camera jargon like "shot" or "angle". Output the prompt text only, nothing else.`;

let cgRunning = new Set();   // mesIds currently generating, so a double-click cannot fire twice

/* The tag writer is a different job from PROMPT_WRITER_SYS above, not a variation of
   it: it must not describe, it must list, and it must stay off identity entirely —
   repeating "pink hair" here would fight the {char} block and the LoRA. */
const TAG_WRITER_SYS = `You write booru-style tag prompts for an anime image model. You are NOT writing prose.

Read the character and the recent moment above, then give the tags for exactly two things: what this character's face is doing in this moment, and how they are posed and framed.

Rules:
- Tags only: short comma-separated phrases in lowercase English, danbooru style, e.g. "blush, wide eyes, open mouth, trembling".
- Never write sentences, narration, dialogue, or camera jargon like "shot" or "angle".
- Never output identity: no name, hair colour, eye colour, hairstyle, clothing, or art style. Those are added separately and repeating them here fights with them.
- DESCRIPTION: the expression and emotional state only — eyes, brows, mouth, blush, tears, sweat. Between 4 and 10 tags. It must be a specific readable emotion, never neutral.
- POSE: body pose, what the hands are doing, the setting, the lighting, and one framing tag such as portrait, upper body, or cowboy shot. Between 4 and 10 tags.

Answer in exactly this format, two lines, nothing else:
DESCRIPTION: tag, tag, tag
POSE: tag, tag, tag`;

/* Appended only when a partner has actually been described. Without this the writer is
   never told a second person exists, and a moment like an embrace comes out as one
   person hugging nobody. */
const TAG_WRITER_PARTNER = `
There is a second person in this story, described above as PARTNER. Add one more line saying whether they are physically present in this exact moment — in the frame, being touched, spoken to face to face — rather than merely mentioned or elsewhere.

Add this as a third line, nothing else:
PARTNER: yes
or
PARTNER: no`;

/* Anime models treat the count tag as something close to syntax: without it two people
   in one prompt are merged into a single figure with too many limbs. The per-person
   tags carry their own "1girl"/"1boy", so those are pulled out and handed back
   separately — each person's own tag then goes immediately in front of their own
   description, which is the only ordering a flat prompt offers as a hint about who
   owns what. "solo" has to go too: it directly contradicts the scene. */
const SOLO_TAGS = /^(solo|solo focus)$/i;
const COUNT_TAGS = /^(1girl|1boy|1other|2girls|2boys|multiple girls|multiple boys)$/i;

function castTags(charTags, partnerTags) {
    const split = (text) => {
        let girls = 0, boys = 0, others = 0;
        const rest = [];
        for (const tag of String(text || '').split(',').map(t => t.trim()).filter(Boolean)) {
            if (SOLO_TAGS.test(tag)) continue;
            if (COUNT_TAGS.test(tag)) {
                const t = tag.toLowerCase();
                if (t === '1girl') girls++;
                else if (t === '1boy') boys++;
                else if (t === '1other') others++;
                continue;
            }
            rest.push(tag);
        }
        return { girls, boys, others, rest: rest.join(', ') };
    };
    const tally = ({ girls, boys, others }) => {
        const out = [];
        if (girls === 1) out.push('1girl'); else if (girls === 2) out.push('2girls'); else if (girls > 2) out.push('multiple girls');
        if (boys === 1) out.push('1boy'); else if (boys === 2) out.push('2boys'); else if (boys > 2) out.push('multiple boys');
        if (others === 1) out.push('1other'); else if (others > 1) out.push('multiple others');
        return out.join(', ');
    };
    const a = split(charTags), b = split(partnerTags);
    const total = { girls: a.girls + b.girls, boys: a.boys + b.boys, others: a.others + b.others };
    return {
        count: tally(total),          // the whole cast, e.g. "2boys" or "1girl, 1boy"
        countChar: tally(a),          // this character alone, e.g. "1boy"
        countPartner: tally(b),
        char: a.rest,
        partner: b.rest,
    };
}

/* Where the two people go in a flat prompt. Each person's own count tag sits directly
   in front of their own tags, so "1boy, blonde hair ... 1girl, brown hair" reads as two
   blocks rather than one pile of hair colours.

   The aggregate is only prepended when the inline tags cannot express it: 1boy + 1girl
   already says the cast, but 1boy + 1boy is not the same word as 2boys, and without
   that word the model tends to draw one person. */
function castBlocks(cast) {
    const sameKind = cast.countChar && cast.countChar === cast.countPartner;
    return {
        char: [sameKind ? cast.count : '', cast.countChar, cast.char].filter(Boolean).join(', '),
        partner: [cast.countPartner, cast.partner].filter(Boolean).join(', '),
    };
}

function cleanTags(text) {
    const seen = new Set();
    return String(text ?? '')
        .replace(/[\r\n]+/g, ',')
        .split(',')
        .map(t => t.trim().replace(/^[-*•]\s*/, ''))
        .filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
        .join(', ');
}

/* Models drift out of the requested format often enough that a strict parser would
   hand back nothing at all. If the two labels are missing the whole answer is treated
   as the description — a slightly wrong prompt still draws, an empty one does not. */
function parseTagWriter(text) {
    const raw = String(text ?? '');
    const grab = (label) => raw.match(new RegExp(`${label}\\s*:\\s*([^\\n]*)`, 'i'))?.[1] ?? '';
    const description = cleanTags(grab('DESCRIPTION'));
    const pose = cleanTags(grab('POSE'));
    // absent, or anything that is not a clear yes, means no — a partner added by
    // accident is far more disruptive than one left out
    const partner = /^\s*(yes|true|y)\b/i.test(grab('PARTNER'));
    if (!description && !pose) return { description: cleanTags(raw), pose: '', partner };
    return { description, pose, partner };
}

function tagStyleText() {
    const s = settings();
    const edited = String(s.comfy.style || '').trim();
    if (edited) return edited;
    return TAG_STYLE_PRESETS[s.comfy.stylePreset]?.text ?? '';
}

/* An empty block must not leave its comma behind: with no LoRA trigger set, a naive
   fill gives ",\n," and the model reads the stray commas as tag separators around
   nothing, which measurably degrades the result.

   {partner} is optional. When the template does not mention it — which is true of the
   default, and of every template written before partners existed — the partner's tags
   join {char}, so the feature works without anyone editing their template. */
function buildTagPrompt({ style, char, description, pose, partner }) {
    const tpl = String(settings().comfy.template || DEFAULT_TAG_TEMPLATE);
    const hasSlot = tpl.includes('{partner}');
    const map = {
        style,
        char: hasSlot ? char : [char, partner].map(t => String(t || '').trim()).filter(Boolean).join(', '),
        partner: hasSlot ? partner : '',
        description,
        pose,
    };
    return tpl
        .replace(/\{(style|char|partner|description|pose)\}/g, (_, k) => String(map[k] ?? '').trim())
        .replace(/,[ \t]*(,[ \t]*)+/g, ', ')
        .split('\n')
        .map(line => line.replace(/^[\s,]+/, '').replace(/[\s,]+$/, ''))
        .filter(Boolean)
        .join(',\n');
}

/* Which reference picture, if any, travels with the request.

   "Draw from" predates the identity source and means different things to the two
   backends. A cloud model is handed the picture directly, so "Description only" is a
   real instruction there. Locally the picture only exists to feed an IPAdapter, and
   the identity source is the setting that says whether that is wanted — so letting
   the older dropdown veto it produced a "no reference image is saved" error about a
   reference that was saved and sitting right there. Locally, identity wins. */
function referenceForRequest(prof, isComfy, sprite) {
    if (!sprite) return null;
    if (isComfy) return (prof?.identity === 'auto' || prof?.identity === 'reference') ? sprite : null;
    return prof?.mode !== 'text' ? sprite : null;
}

async function generateSceneForMessage(mesId) {
    if (cgRunning.has(mesId)) return;
    const $mes = $(`.mes[mesid="${mesId}"]`);
    if (!$mes.length) { toastr.warning('That message is not on screen anymore.'); return; }

    const avatar = avatarForMessage(mesId);
    const card = avatar ? buildCard(avatar) : null;
    const prof = avatar ? cgProfile(avatar) : { sprite: null, desc: '', mode: 'both' };
    const s = settings();

    cgRunning.add(mesId);
    setSceneBusy($mes, true);
    try {
        const isComfy = imgApiMode() === 'comfy';
        // the bytes live in IndexedDB now, so they have to be fetched before use
        const reference = referenceForRequest(prof, isComfy, await loadSprite(avatar));
        const useDesc = prof.mode !== 'sprite';
        const descBits = [];
        if (useDesc && card?.text) descBits.push(`CHARACTER:\n${card.text}`);
        if (useDesc && prof.desc?.trim()) descBits.push(`APPEARANCE NOTES:\n${prof.desc.trim()}`);

        /* The other person in the scene. Described to the writer whenever anything is
           filled in, even when the override says "never" — knowing who is being spoken
           to makes a better expression either way; only the drawing is suppressed. */
        const persona = cgProfile(PERSONA_KEY);
        const personaName = getContext().name1 || 'the partner';
        const partnerDescribed = !!(persona.desc?.trim() || persona.tags?.trim());
        if (partnerDescribed) {
            const bits = [`PARTNER (${personaName}), the person this character is with:`];
            if (persona.desc?.trim()) bits.push(persona.desc.trim());
            if (isComfy && persona.tags?.trim()) bits.push(`Appearance tags: ${persona.tags.trim()}`);
            descBits.push(bits.join('\n'));
        }
        descBits.push(`MOMENT:\n${contextAround(mesId)}`);

        // 'always' and 'never' are the manual override; 'auto' asks the writer
        const mode = s.partnerMode || 'auto';
        const askWriter = partnerDescribed && mode === 'auto';

        let scenePrompt;
        let regional = {};
        if (isComfy) {
            /* Local models: the language model only supplies the moment. Style comes
               from the preset, identity from the character's own tag block — so a
               weak writer can spoil the expression but can no longer spoil the face. */
            const written = await callPromptWriter(
                `${descBits.join('\n\n')}\n\n${TAG_WRITER_SYS}${askWriter ? `\n${TAG_WRITER_PARTNER}` : ''}`);
            const { description, pose, partner } = parseTagWriter(written);
            const withPartner = partnerDescribed && (mode === 'always' || (askWriter && partner));
            const cast = castTags(prof.tags, withPartner ? persona.tags : '');
            const blocks = castBlocks(cast);
            scenePrompt = buildTagPrompt({
                style: tagStyleText(),
                char: blocks.char,
                partner: blocks.partner,
                description,
                pose,
            });
            if (!scenePrompt.trim()) throw new Error('The prompt writer returned nothing usable. Try again, or give the writer a stronger model.');

            /* The same material split three ways, for regional workflows. Each region
               gets only its own occupant's count tag — telling a region that holds one
               boy that the scene has "1girl, 1boy" in it is what puts a second, unwanted
               figure in that half. The whole cast is named once, in the shared branch. */
            regional = {
                promptA: [cast.countChar, cast.char, description].filter(Boolean).join(', '),
                promptB: withPartner ? [cast.countPartner, cast.partner].filter(Boolean).join(', ') : '',
                promptScene: [tagStyleText(), cast.count, pose].filter(Boolean).join(', '),
            };
        } else {
            const presetText = cgPresetText(s.cgPreset);
            const writerPrompt = `${descBits.join('\n\n')}\n\n${PROMPT_WRITER_SYS}` +
                (presetText ? `\n\n${presetText}` : '');
            scenePrompt = (await callPromptWriter(writerPrompt)).trim();
            if (s.cgStyle?.trim()) scenePrompt += `\n\nStyle: ${s.cgStyle.trim()}`;
        }

        const imgUrl = await callImageModel(scenePrompt, reference, {
            lora: String(prof.lora || '').trim(),
            loraStrength: prof.loraStrength,
            ipWeight: prof.ipWeight,
            identity: prof.identity,
            workflow: workflowForProfile(prof),
            ...regional,
        });
        const who = (avatar ? charByAvatar(avatar)?.name : '') || getContext().chat?.[mesId]?.name || '';
        insertScene($mes, imgUrl, scenePrompt, who, mesId);
        // shown first, stored second: a storage hiccup must not cost the picture
        try {
            await cgSaveImage(mesId, imgUrl, scenePrompt, who);
        } catch (e) {
            console.warn('[Character Lens] the scene could not be saved to the chat', e);
            toastr.warning('The scene was drawn but could not be saved — it will disappear when you switch chats.', 'Character Lens');
        }
    } catch (err) {
        console.error('[Character Lens] scene art', err);
        toastr.error(esc(err?.message ?? err), 'Character Lens — Scene Art');
    } finally {
        cgRunning.delete(mesId);
        setSceneBusy($mes, false);
    }
}

function setSceneBusy(mes$, on) {
    const $btn = mes$.find('.cl_cg_btn');
    $btn.toggleClass('cl_cg_busy', !!on);
    $btn.attr('title', on ? 'Drawing…' : 'Draw a scene for this message (Character Lens)');
    mes$.find('.cl_cg_wrap').toggleClass('cl_cg_loading', !!on);
}

/* ── Keeping a scene ─────────────────────────────────────────
   A drawn CG used to live in the DOM and nowhere else, so switching chats — which
   makes SillyTavern rebuild the whole log — threw it away. It now rides along with
   the message it belongs to, in message.extra, and comes back when that message is
   rendered again.

   The picture itself is deliberately NOT put in message.extra: a base64 CG is
   megabytes, and the chat file is rewritten on every save. The bytes go to IndexedDB
   (localforage, which SillyTavern already ships) and only a short key travels with
   the message. A plain http(s) result — ComfyUI's own /view link, say — is already
   short, so that is stored as-is and no blob is kept at all. */
const CG_KEY = 'character_lens_cg';

function cgStore() {
    try { return globalThis.SillyTavern?.libs?.localforage ?? globalThis.localforage ?? null; }
    catch (e) { return null; }
}

async function cgForget(record) {
    if (!record?.key) return;
    try { await cgStore()?.removeItem(record.key); }
    catch (e) { console.warn('[Character Lens] could not drop a stored scene', e); }
}

async function cgResolve(record) {
    if (!record) return null;
    if (record.url) return record.url;
    if (!record.key) return null;
    try { return (await cgStore()?.getItem(record.key)) ?? null; }
    catch (e) { return null; }
}

async function cgSaveImage(mesId, imgUrl, promptText, name) {
    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;
    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};

    const record = { prompt: String(promptText || ''), date: new Date().toISOString(), name: String(name || msg.name || '') };
    if (/^data:/i.test(imgUrl)) {
        const store = cgStore();
        if (store) {
            const key = `${CG_KEY}:${ctx.getCurrentChatId?.() ?? 'chat'}:${mesId}:${Date.now().toString(36)}`;
            await store.setItem(key, imgUrl);
            record.key = key;
        } else {
            // no IndexedDB at all: better a heavy chat file than a picture that vanishes
            record.url = imgUrl;
        }
    } else {
        record.url = imgUrl;
    }

    await cgForget(msg.extra[CG_KEY]);   // redrawing replaces, so the old blob has no owner left
    msg.extra[CG_KEY] = record;
    await ctx.saveChat?.();
}

async function cgDeleteImage(mesId) {
    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    const record = msg?.extra?.[CG_KEY];
    if (!record) return;
    await cgForget(record);
    delete msg.extra[CG_KEY];
    await ctx.saveChat?.();
}

/* Put a saved scene back under its message. Reading from IndexedDB is asynchronous, so
   by the time the bytes arrive the chat may already have been switched again — hence
   the second look before anything is inserted. */
async function restoreScene(mesId) {
    if (typeof mesId !== 'number' || mesId < 0) return;
    const ctx = getContext();
    const record = ctx.chat?.[mesId]?.extra?.[CG_KEY];
    if (!record) return;
    if ($(`.mes[mesid="${mesId}"]`).find('.cl_cg_wrap').length) return;   // already on screen
    const chatBefore = ctx.getCurrentChatId?.();
    const url = await cgResolve(record);
    if (!url) return;
    if (getContext().getCurrentChatId?.() !== chatBefore) return;
    const $mes = $(`.mes[mesid="${mesId}"]`);
    if (!$mes.length || $mes.find('.cl_cg_wrap').length) return;
    insertScene($mes, url, record.prompt || '', record.name || '', mesId);
}

/* The tilt is derived from the prompt rather than drawn at random, so redrawing the
   same scene lands at the same angle instead of jumping every time, and two photos in
   one chat still rarely share one. Zero is left out of the table on purpose — a
   perfectly straight "photo" reads as a UI panel again. */
const PHOTO_TILTS = [-3.1, -2.4, -1.7, -1.2, 1.2, 1.7, 2.4, 3.1];
function photoTilt(seed) {
    let h = 0;
    const t = String(seed || '');
    for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) >>> 0;
    return PHOTO_TILTS[h % PHOTO_TILTS.length];
}

/* One scene box per message, reused on regeneration rather than stacking — asking
   again replaces the picture, it does not pile a second one under it.
   .cl_cg_wrap stays exactly what it was (the box the loading state is toggled on);
   the print itself lives one level in, on .cl_cg_photo, so the tilt and the drop
   shadow have room and cannot be clipped by the wrapper. */
function insertScene(mes$, imgUrl, promptText, name, mesId) {
    let $wrap = mes$.find('.cl_cg_wrap');
    if (!$wrap.length) {
        $wrap = $('<div class="cl_cg_wrap"></div>');
        mes$.find('.mes_text').first().after($wrap);
    }
    const $photo = $('<div class="cl_cg_photo"></div>')
        .css('--cl-tilt', `${photoTilt(promptText || imgUrl)}deg`)
        .append(
            // purely decorative, and pointer-events:none in CSS so it can never
            // swallow a click meant for the photo underneath it
            $('<div class="cl_cg_clip" aria-hidden="true"></div>').append(
                $('<i class="fa-solid fa-paperclip"></i>'),
                $('<span></span>').text(String(name || '').trim()
                    ? `${String(name).trim()} — photo attached`
                    : 'Photo attached'),
            ),
            $('<div class="cl_cg_print"></div>').append(
                /* NOT esc() here: .attr() escapes the value itself, so escaping first
                   printed the entities raw — a prompt with a quote in it showed up in
                   the tooltip as &quot; instead of ". */
                $('<img class="cl_cg_img">').attr('src', imgUrl).attr('title', String(promptText ?? '')),
            ),
            $('<div class="cl_cg_bar"></div>').append(
                $('<span class="cl_cg_hint">🎨 Character Lens</span>'),
                $('<span class="cl_icon cl_cg_remove" title="Remove"><i class="fa-solid fa-xmark"></i></span>')
                    .on('click', async () => {
                        $wrap.remove();
                        // removing is permanent, so the stored copy goes too — otherwise
                        // the picture would come straight back on the next chat switch
                        if (typeof mesId === 'number') {
                            try { await cgDeleteImage(mesId); }
                            catch (e) { console.warn('[Character Lens] could not delete a stored scene', e); }
                        }
                    }),
            ),
        );
    $wrap.empty().append($photo);
}

function injectSceneButton(mesId) {
    if (typeof mesId !== 'number' || mesId < 0) return;
    const $mes = $(`.mes[mesid="${mesId}"]`);
    if (!$mes.length || $mes.find('.cl_cg_btn').length) return;
    const $row = $mes.find('.mes_buttons, .extraMesButtons').first();
    if (!$row.length) return;   // layout changed under us — fail quietly, never break message rendering
    const $btn = $('<div class="mes_button cl_cg_btn fa-solid fa-image" title="Draw a scene for this message (Character Lens)"></div>');
    $btn.on('click', () => generateSceneForMessage(mesId));
    $row.prepend($btn);
}

/* Same job as the Analyzer's "Analyze" button, one drawer down: reads the card and
   writes the field for you. The result lands in the same textarea you can edit by
   hand, exactly like the performance guide above — this never replaces editing,
   it just saves starting from a blank page. */
function setCgAnalyzeBusy(on) {
    const b = $('#cl_cg_analyze');
    b.toggleClass('busy', !!on);
    b.find('span').text(on ? 'Analyzing…' : 'Analyze appearance');
    b.find('i').attr('class', on ? 'fa-solid fa-spinner cl_spin' : 'fa-solid fa-wand-magic-sparkles');
}
async function analyzeAppearance() {
    const avatar = selectedCgAvatar;
    if (!avatar) { toastr.warning('No character selected.'); return; }
    if (!apiKeyVal()) { toastr.warning('Set an API key for the Analyzer first — Scene Art borrows it.'); return; }
    if (!apiModel()) { toastr.warning('Set a model name for the Analyzer first.'); return; }
    const card = buildCard(avatar);
    if (!card) { toastr.warning('That character card could not be read.'); return; }

    setCgAnalyzeBusy(true);
    try {
        const prompt = `Read this character card and write a short, concrete physical-appearance description meant as an image reference: hair colour and style, eye colour, build, skin tone, and any distinguishing features or their typical outfit. Plain prose, no headers or lists, two to four sentences. Only state what the card actually supports — never invent a detail it doesn't mention.\n\n--- CHARACTER CARD ---\n${card.text}\n--- END CARD ---\nOutput only the description.`;
        const text = (await callAnalyzer(prompt)).trim();
        if (!text) throw new Error('Empty response from the analyzer model.');
        cgProfile(avatar).desc = text;
        await saveNow();
        renderCG();
        flashSaved('#cl_cg_saved');
        toastr.success(`Appearance notes written for ${esc(card.name)}.`);
    } catch (err) {
        console.error('[Character Lens] appearance analyze', err);
        toastr.error(esc(err?.message ?? err), 'Character Lens');
    } finally {
        setCgAnalyzeBusy(false);
    }
}

// ─────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────
/* One at a time, on purpose: five parallel requests to the same endpoint is how you
   get rate-limited, and a failure halfway through should leave the ones already done
   intact rather than roll everything back. */
let batchRunning = false;
async function analyzeMissing() {
    if (batchRunning || running) return;
    const members = groupMembers();
    if (!members.length) return;
    const s = settings();
    const todo = members.filter(m => {
        const p = s.profiles[m.avatar];
        return !p?.text || isStale(p, cardOf(m.avatar));
    });
    if (!todo.length) { toastr.info('Everyone already has an up-to-date guide.'); return; }

    batchRunning = true;
    const btn = $('#cl_batch').addClass('disabled');
    let done = 0, failed = 0;
    for (const m of todo) {
        btn.text(`Analyzing ${done + failed + 1} of ${todo.length}…`);
        try { await analyze(m.avatar); done++; }
        catch (e) { console.warn('[Character Lens] batch failed for', m.name, e); failed++; }
    }
    batchRunning = false;
    btn.removeClass('disabled').text('Analyze everyone missing a guide');
    renderProfile();
    toastr[failed ? 'warning' : 'success'](failed ? `Written ${done}, failed ${failed}.` : `Written ${done}.`);
}

/* One place decides what the button looks like while it works, so a failure halfway
   through cannot leave it saying "Analyzing…" for ever. */
function setBusy(on) {
    const b = $('#cl_analyze');
    b.toggleClass('busy', !!on);
    b.find('span').text(on ? 'Analyzing…' : 'Analyze');
    b.find('i').attr('class', on ? 'fa-solid fa-spinner cl_spin' : 'fa-solid fa-wand-magic-sparkles');
}

function renderProfile() {
    const ctx = getContext();
    const isGroup = !!groupId();
    const avatar = panelAvatar();
    const p = avatar ? settings().profiles[avatar] : null;

    $('#cl_group_row').toggle(isGroup);
    $('#cl_batch_row').toggle(isGroup);
    if (isGroup) {
        const st = settings();
        const missing = groupMembers().filter(m => {
            const pp = st.profiles[m.avatar];
            return !pp?.text || isStale(pp, cardOf(m.avatar));
        }).length;
        $('#cl_batchnote').text(missing ? `${missing} of ${groupMembers().length} need one.` : 'Everyone has an up-to-date guide.');
        $('#cl_batch').toggleClass('disabled', !missing);
    }
    const sel = $('#cl_member').empty();
    if (isGroup) {
        for (const m of groupMembers()) {
            const pm = settings().profiles[m.avatar];
            const mark = pm?.text ? (isStale(pm, cardOf(m.avatar)) ? ' ⚠' : ' ✓') : '';
            sel.append($('<option>').val(m.avatar).text(m.name + mark));
        }
        sel.val(avatar);
        $('#cl_charname').text(charByAvatar(avatar)?.name ?? '—');
    } else {
        $('#cl_charname').text(ctx.characters?.[ctx.characterId]?.name ?? '—');
    }

    $('#cl_text').val(p?.text ?? '');
    $('#cl_off').prop('checked', !!p?.off).prop('disabled', !p?.text);
    const stale = isStale(p, cardOf(avatar));
    $('#cl_meta').text(p?.date ? `saved ${new Date(p.date).toLocaleString()}` : 'no interpretation yet');
    $('#cl_stale').toggle(!!stale);
    $('#cl_text').toggleClass('cl-stale', !!stale);

    const hasChar = !!avatar;
    $('#cl_analyze').toggleClass('off', !hasChar);
    $('#cl_text').attr('placeholder', hasChar
        ? 'Press "Analyze current character". The result appears here and can be edited by hand.'
        : 'No character open. Open a character chat, then press Analyze.');
    const tok = p?.text ? Math.round(p.text.length / 4) : 0;
    $('#cl_tokens').text(p?.text ? (p.off ? `~${tok} tokens · muted for this character` : `~${tok} tokens injected each turn`) : '');
}

// кого сейчас показывает вкладка Scene Art — независимо от того, кто открыт в чате,
// это отдельный список персонажей, а не "текущий собеседник"
let selectedCgAvatar = null;

/* Set when the person picks somebody from the dropdown by hand. Following the chat is
   the default, but a manual choice has to survive the next message arriving — otherwise
   editing a second character's tags while the first keeps talking is impossible. The
   pin is released on a chat switch, where the previous choice has stopped meaning
   anything anyway. */
let cgPinnedAvatar = null;

/* The avatar of whoever spoke last, ignoring the user's own messages — the panel is
   for drawing characters, and "the last person to speak" is almost always the one the
   next scene will be of. */
function lastSpeakerAvatar() {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;
        const found = avatarForMessage(i);
        if (found) return found;
    }
    return null;
}

function cgSelectedAvatar() {
    const ctx = getContext();
    const chars = (ctx.characters || []).filter(c => c && c.avatar);
    if (!chars.length) return null;
    const known = (a) => a && chars.some(c => c.avatar === a);
    if (known(cgPinnedAvatar)) return cgPinnedAvatar;
    // follow the chat
    const speaker = lastSpeakerAvatar();
    if (known(speaker)) return speaker;
    if (known(selectedCgAvatar)) return selectedCgAvatar;
    // default to whoever the main panel is already showing, if that is resolvable
    const fallback = panelAvatar();
    return known(fallback) ? fallback : chars[0].avatar;
}

/* Redraws the character block when the chat has moved on. Skipped while a field in
   that block has focus: swapping the panel under someone mid-sentence would throw away
   what they were typing. */
function cgFollowChat() {
    if (cgPinnedAvatar) return;
    const target = cgSelectedAvatar();
    if (!target || target === selectedCgAvatar) return;
    const active = document.activeElement;
    if (active && $(active).closest('#cl_cg_block').length) return;
    renderCG();
}

function renderCGApi() {
    const s = settings();
    $('#cl_img_url').val(s.img.apiUrl);
    $('#cl_img_key').val(s.img.apiKey);
    $('#cl_img_model').val(s.img.model);
    $('#cl_img_mode').val(s.img.mode || 'auto');
    $('#cl_cg_promptmodel').val(s.cgPromptModel);
    $('#cl_cg_style').val(s.cgStyle);
    $('#cl_comfy_negative').val(s.comfy.negative);
    $('#cl_comfy_timeout').val(s.comfy.timeout);
    if (document.activeElement?.id !== 'cl_comfy_workflow') $('#cl_comfy_workflow').val(activeWorkflow()?.text ?? '');
    renderWorkflowPicker();
    if (document.activeElement?.id !== 'cl_comfy_tpl') $('#cl_comfy_tpl').val(s.comfy.template);
    if (document.activeElement?.id !== 'cl_comfy_style') $('#cl_comfy_style').val(tagStyleText());

    const $tagPreset = $('#cl_comfy_stylepreset');
    if (!$tagPreset.children().length) {
        for (const [id, p] of Object.entries(TAG_STYLE_PRESETS)) $tagPreset.append($('<option>').val(id).text(p.label));
    }
    $tagPreset.val(s.comfy.stylePreset);
    $('#cl_comfy_stylereset').toggleClass('off', !String(s.comfy.style || '').trim());

    const $preset = $('#cl_cg_preset');
    if (!$preset.children().length) {
        for (const [id, p] of Object.entries(CG_PRESETS)) $preset.append($('<option>').val(id).text(p.label));
    }
    $preset.val(s.cgPreset);
    renderCGPresetText();

    const mode = imgApiMode();
    const isComfy = mode === 'comfy';
    $('#cl_comfy_box').toggle(isComfy);
    renderTemplateNote();
    // key and model mean nothing to a local ComfyUI — dimmed, never cleared, so
    // switching back to a cloud provider finds them exactly as they were left
    $('#cl_img_key, #cl_img_model').toggleClass('cl_dim', isComfy);
    renderComfyNote();

    if (isComfy) {
        $('#cl_img_note').text(comfyBase()
            ? `ComfyUI format · ${comfyBase()}`
            : 'ComfyUI format · no address yet — put http://127.0.0.1:8188 in the URL field above');
        return;
    }

    const usingOwnKey = !!s.img.apiKey?.trim();
    const usingOwnUrl = !!s.img.apiUrl?.trim();
    $('#cl_img_note').text(
        (usingOwnUrl ? '' : 'reusing Analyzer URL · ') +
        (usingOwnKey ? '' : 'reusing Analyzer key · ') +
        `using ${mode} format · ` +
        (s.img.model?.trim() ? `model: ${s.img.model.trim()}` : 'no image model set yet')
    );
}

function renderWorkflowPicker() {
    const s = settings();
    const $pick = $('#cl_comfy_pick').empty();
    for (const w of s.comfy.workflows) $pick.append($('<option>').val(w.id).text(w.name));
    if (!s.comfy.workflows.length) $pick.append($('<option>').val('').text('— no workflows yet —'));
    $pick.val(activeWorkflow()?.id ?? '');
    // with nothing to act on, the editing buttons would only produce error toasts
    $('#cl_comfy_rename, #cl_comfy_dup, #cl_comfy_del').toggleClass('disabled', !s.comfy.workflows.length);

    const $sel = $('#cl_cg_workflow').empty();
    $sel.append($('<option>').val('').text(s.comfy.workflows.length
        ? `Default (${s.comfy.workflows[0].name})`
        : '— no workflows yet —'));
    for (const w of s.comfy.workflows) $sel.append($('<option>').val(w.id).text(w.name));
    const prof = selectedCgAvatar ? cgProfile(selectedCgAvatar) : null;
    $sel.val(prof?.workflowId && workflowById(prof.workflowId) ? prof.workflowId : '');
}

/* The workflow is the one setting here that can be wrong in a dozen silent ways, so it
   is checked on every keystroke and says so in place, rather than waiting for a click
   on a message to find out. */
function renderComfyNote() {
    const $note = $('#cl_comfy_note').removeClass('cl_bad cl_good');
    const text = String(activeWorkflow()?.text || '').trim();
    if (!text) { $note.text('No workflow yet — paste one, or press "Insert example".'); return; }
    let graph;
    try { graph = JSON.parse(text); } catch (e) { $note.addClass('cl_bad').text(`Invalid JSON: ${e.message}`); return; }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        $note.addClass('cl_bad').text('The workflow must be a JSON object of nodes.'); return;
    }
    if (Array.isArray(graph.nodes)) {
        $note.addClass('cl_bad').text('This is the editor format. Export it again with Workflow → Export (API).'); return;
    }
    const has = t => text.includes(t);
    if (!has('%prompt%') && !has('%prompt_a%')) {
        $note.addClass('cl_bad').text('No %prompt% or %prompt_a% placeholder — the scene description would never reach the workflow.'); return;
    }
    const bits = [`${Object.keys(graph).length} nodes`, has('%prompt%') ? '%prompt% ✓' : '%prompt_a% ✓'];
    for (const t of ['%prompt_a%', '%prompt_b%', '%prompt_scene%', '%negative%', '%seed%', '%image%', '%lora%', '%lora_strength%', '%ipadapter_weight%']) if (has(t)) bits.push(`${t} ✓`);
    if (!has('%seed%')) bits.push('no %seed% — every scene will come out identical');
    $note.addClass(has('%seed%') ? 'cl_good' : '').text(bits.join(' · '));
}

/* {description} and {pose} are the only two blocks the language model writes. Dropping
   them turns every scene into the same picture, which is confusing enough to be worth
   saying out loud rather than leaving to be discovered. */
function renderTemplateNote() {
    const $note = $('#cl_comfy_tplnote').removeClass('cl_bad cl_good');
    const tpl = String(settings().comfy.template || '');
    const missing = ['{style}', '{char}', '{description}', '{pose}'].filter(t => !tpl.includes(t));
    if (!tpl.trim()) { $note.addClass('cl_bad').text('Empty template — nothing would be sent.'); return; }
    if (missing.includes('{description}') && missing.includes('{pose}')) {
        $note.addClass('cl_bad').text('Neither {description} nor {pose} is used, so the scene itself never reaches the model.');
        return;
    }
    if (!missing.length) { $note.addClass('cl_good').text('All four blocks in use.'); return; }
    $note.text(`Not used: ${missing.join(', ')}${missing.includes('{char}') ? ' — without {char} the character has no identity tags' : ''}`);
}

function renderCGPresetText() {
    const id = settings().cgPreset;
    $('#cl_cg_presettext').val(cgPresetText(id));
    $('#cl_cg_reset').toggleClass('off', cgPresetText(id) === cgPresetDefaultText(id));
}

function renderCG() {
    const ctx = getContext();
    const chars = (ctx.characters || []).filter(c => c && c.avatar);
    const avatar = cgSelectedAvatar();
    selectedCgAvatar = avatar;

    const $sel = $('#cl_cg_member').empty();
    for (const c of chars) {
        const has = settings().cgProfiles[c.avatar];
        $sel.append($('<option>').val(c.avatar).text(c.name + (hasSprite(c.avatar) || has?.desc ? ' ✓' : '')));
    }
    $sel.val(avatar);

    const charName = avatar ? (charByAvatar(avatar)?.name ?? '—') : '—';
    $('#cl_cg_charname').text(charName);
    /* Said out loud, because a panel that changes by itself is unsettling unless you
       know it is meant to, and a pinned one looks broken unless you know why. */
    $('#cl_cg_follow').empty().append(cgPinnedAvatar
        ? $('<span>Pinned to this character. </span>').append(
            $('<a href="#" id="cl_cg_unpin">follow the chat again</a>'))
        : $('<span>Following the chat — this changes with whoever spoke last.</span>'));
    $('#cl_cg_analyze').toggleClass('off', !avatar);

    const prof = avatar ? cgProfile(avatar) : { sprite: null, desc: '', mode: 'both' };
    const $prev = $('#cl_cg_spritepreview').empty();
    const cached = spriteFor(avatar);
    if (cached) {
        $prev.append($('<img>').attr('src', cached));
    } else if (hasSprite(avatar)) {
        // stored but not decoded yet: fetch it, then fill this preview in place
        $prev.append('<span>loading reference…</span>');
        loadSprite(avatar).then((data) => {
            if (data && selectedCgAvatar === avatar) renderCG();
        });
    } else {
        $prev.append('<span>no reference image</span>');
    }
    $('#cl_cg_desc').val(prof.desc || '');
    $('#cl_cg_mode').val(prof.mode || 'both');

    // the identity/LoRA block only means anything to a local model
    const isComfy = imgApiMode() === 'comfy';
    $('#cl_cg_localbox').toggle(isComfy);
    $('#cl_cg_tags').val(prof.tags || '');
    $('#cl_cg_lorastr').val(prof.loraStrength ?? 1);
    $('#cl_cg_ipweight').val(prof.ipWeight ?? 0.65);
    $('#cl_cg_identity').val(prof.identity || 'auto');
    $('#cl_cg_readref').toggleClass('off', !avatar || !hasSprite(avatar));
    if (isComfy) {
        renderWorkflowPicker();
        renderLoraChoices(prof.lora || '');
        renderTagNote('#cl_cg_tagnote', prof.tags);
    }
    renderPersona();
}

/* The persona's block mirrors the character one, minus the parts that make no sense
   for it: no LoRA (nobody trains one for a user persona) and no workflow choice, since
   the partner is drawn by whichever workflow the character uses. */
function renderPersona() {
    const s = settings();
    const persona = cgProfile(PERSONA_KEY);
    const isComfy = imgApiMode() === 'comfy';

    $('#cl_persona_mode').val(s.partnerMode || 'auto');
    $('#cl_persona_tagbox').toggle(isComfy);
    if (document.activeElement?.id !== 'cl_persona_desc') $('#cl_persona_desc').val(persona.desc || '');
    if (document.activeElement?.id !== 'cl_persona_tags') $('#cl_persona_tags').val(persona.tags || '');
    if (isComfy) renderTagNote('#cl_persona_tagnote', persona.tags);
    $('#cl_persona_readref').toggleClass('off', !hasSprite(PERSONA_KEY));

    const $prev = $('#cl_persona_prev').empty();
    const cached = spriteFor(PERSONA_KEY);
    if (cached) {
        $prev.append($('<img>').attr('src', cached));
    } else if (hasSprite(PERSONA_KEY)) {
        $prev.append('<span>loading reference…</span>');
        loadSprite(PERSONA_KEY).then((data) => { if (data) renderPersona(); });
    } else {
        $prev.append('<span>no reference image</span>');
    }
}

/* SillyTavern's persona description is not part of the context API, so it is read from
   whichever of these places the running build happens to expose. */
function personaDescriptionText() {
    try {
        const fromCtx = getContext()?.powerUserSettings?.persona_description;
        if (typeof fromCtx === 'string' && fromCtx.trim()) return fromCtx;
    } catch (e) { /* older builds do not expose it there */ }
    const fromGlobal = globalThis.power_user?.persona_description;
    if (typeof fromGlobal === 'string' && fromGlobal.trim()) return fromGlobal;
    const fromDom = $('#persona_description').val();
    return typeof fromDom === 'string' ? fromDom : '';
}

/* Catches the three mistakes that cost the most and look the most innocent.

   Parentheses are the big one: in SDXL-family prompts they are emphasis, not grouping —
   "(1boy, blonde hair)" does not mark out a person, it multiplies that whole run by 1.1,
   and "((blonde hair))" at 1.21 becomes the loudest thing in the prompt and paints
   everyone in the frame blonde. */
function renderTagNote(sel, text) {
    const $note = $(sel).removeClass('cl_bad cl_good');
    const raw = String(text || '');
    if (!raw.trim()) { $note.text(''); return; }
    const problems = [];

    if (/\([^()]*,[^()]*\)/.test(raw)) {
        problems.push('Parentheses are emphasis (×1.1), not grouping — a comma inside them does not separate people. Remove them and let the order do the work.');
    }
    const heavy = raw.match(/\({2,}\s*([^()]+?)\s*\){2,}/);
    if (heavy) {
        problems.push(`"${heavy[1]}" is weighted ×1.2 or more. A heavily weighted colour is the loudest tag in the prompt and tends to spread onto everyone in frame.`);
    }
    const fake = raw.split(',').map(t => t.trim()).find(t => /^\d+\s*(characters?|people|persons?)$/i.test(t));
    if (fake) {
        problems.push(`"${fake}" is not a tag these models know. Use 1boy / 1girl here — the tag for the pair is worked out for you.`);
    }
    if (!/\b(1girl|1boy|1other)\b/i.test(raw)) {
        problems.push('No 1boy / 1girl / 1other here. Without one, a two-person scene cannot be counted and the figures merge.');
    }

    if (!problems.length) { $note.addClass('cl_good').text('Tags look well-formed.'); return; }
    $note.addClass('cl_bad').text(problems.join(' '));
}

/* The saved LoRA is always offered, even when ComfyUI is unreachable or the file has
   been renamed — otherwise opening the panel offline would quietly wipe the setting. */
async function renderLoraChoices(selected) {
    const $sel = $('#cl_cg_lora');
    const $note = $('#cl_cg_loranote').removeClass('cl_bad cl_good');
    const list = await comfyLoraList();
    const options = ['', ...(list ?? [])];
    if (selected && !options.includes(selected)) options.push(selected);

    $sel.empty();
    for (const name of options) {
        $sel.append($('<option>').val(name).text(name || '— no LoRA —'));
    }
    $sel.val(selected || '');

    if (!list) {
        $note.addClass('cl_bad').text('Could not read the LoRA list from ComfyUI — check the address above, or press refresh once it is running.');
        return;
    }

    /* Checked here as well as at draw time: finding out that the LoRA was ignored only
       after waiting through a render is a poor way to learn it. */
    const prof = selectedCgAvatar ? cgProfile(selectedCgAvatar) : null;
    const wf = workflowForProfile(prof);
    const graphText = String(wf?.text || '');
    if (selected && prof && (prof.identity === 'lora' || prof.identity === 'auto') && wf && !graphText.includes('%lora%')) {
        $note.addClass('cl_bad').text(`The workflow "${wf.name}" has no %lora% placeholder, so this LoRA will be ignored. Press "Example: LoRA" below, or add a LoraLoader with %lora% in lora_name.`);
        return;
    }
    if (!selected && prof && prof.identity === 'lora') {
        $note.addClass('cl_bad').text('Identity is set to "Character LoRA" but none is selected, so nothing will draw. Pick one, or change the identity source.');
        return;
    }
    if (!selected && wf && graphText.includes('%lora%')) {
        $note.text(`No LoRA — the LoraLoader in "${wf.name}" is removed from the request, so this character draws from tags alone.`);
        return;
    }
    if (selected && prof && (prof.identity === 'tags' || prof.identity === 'reference')) {
        const label = prof.identity === 'tags' ? 'Tags only' : 'Reference image';
        $note.text(graphText.includes('%lora%')
            ? `Identity is "${label}", so this LoRA is not sent and the workflow's LoraLoader is removed from the request.`
            : `Identity is "${label}", so this LoRA is not sent. Switch the identity source to use it.`);
        return;
    }
    if (selected && !list.includes(selected)) {
        $note.addClass('cl_bad').text(`"${selected}" is not in ComfyUI's list anymore — it was kept, but it will fail unless the file is back.`);
    } else if (selected) {
        $note.addClass('cl_good').text('Put the LoRA trigger word in the identity tags above, or it will not fire.');
    } else {
        $note.text(`${list.length} LoRAs available.`);
    }
}

const HTML = `
<div class="character-lens">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b><i class="fa-solid fa-magnifying-glass"></i> Character Lens</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <label class="checkbox_label">
        <input id="cl_enabled" type="checkbox">
        <span>Enabled</span>
      </label>

      <hr class="sysHR">
      <h4>🔌 Analyzer API</h4>
      <small>A separate model reads the card once. Nothing runs during normal chat.</small>
      <div class="flex-container alignitemscenter flexgap5 margin-b-10">
        <input type="text" id="cl_baseurl" class="text_pole flex1" placeholder="URL — https://openrouter.ai/api/v1">
      </div>
      <div class="flex-container alignitemscenter flexgap5 margin-b-10">
        <input type="password" id="cl_apikey" class="text_pole flex1" placeholder="API Key">
      </div>
      <div class="flex-container alignitemscenter flexgap5 margin-b-10">
        <input type="text" id="cl_model" class="text_pole flex1" placeholder="Model — e.g. deepseek/deepseek-chat">
      </div>
      <div class="flex-container alignitemscenter flexgap5 margin-b-10">
        <label style="min-width:110px;">Temperature</label>
        <input type="range" id="cl_temp" min="0" max="2" step="0.1" style="flex:1;">
        <span id="cl_tempval" style="min-width:30px;text-align:right;"></span>
      </div>
      <div class="cl_buttons">
        <div id="cl_test" class="menu_button">Test connection</div>
      </div>
      <small id="cl_apinote"></small>
      <div id="cl_stale" class="cl_warn" style="display:none;">
        <span>The card changed after this guide was written.</span>
        <div id="cl_restale" class="cl_mini">Rewrite</div>
      </div>

      <div id="cl_batch_row" class="cl_batch" style="display:none;">
        <div id="cl_batch" class="cl_mini wide"><i class="fa-solid fa-users"></i> Analyze everyone missing a guide</div>
        <small id="cl_batchnote"></small>
      </div>
      <div id="cl_group_row" class="cl_row" style="display:none">
        <div>
          <label for="cl_member">Group member</label>
          <select id="cl_member" class="text_pole"></select>
        </div>
        <div>
          <label for="cl_groupmode">In group chats inject</label>
          <select id="cl_groupmode" class="text_pole">
            <option value="speaker">only the character speaking</option>
            <option value="all">all members with a profile</option>
          </select>
        </div>
      </div>

      <div class="cl_row">
        <div>
          <label for="cl_position">Inject at</label>
          <select id="cl_position" class="text_pole">
            <option value="0">System prompt</option>
            <option value="1">In chat, at depth</option>
          </select>
        </div>
        <div>
          <label for="cl_depth">Depth</label>
          <input id="cl_depth" class="text_pole" type="number" min="0" max="99">
        </div>
        <div>
          <label for="cl_injrole">As role</label>
          <select id="cl_injrole" class="text_pole">
            <option value="0">System</option>
            <option value="1">User</option>
            <option value="2">Assistant</option>
          </select>
        </div>
      </div>
      <small id="cl_depthhint"></small>

      <label for="cl_maxtokens">Analyzer max tokens</label>
      <input id="cl_maxtokens" class="text_pole" type="number" min="200" max="4000" step="50">

      <hr>
      <div class="cl_card">
        <div class="cl_head">
          <div class="cl_who">
            <b id="cl_charname">—</b>
            <small id="cl_meta"></small>
          </div>
          <div id="cl_analyze" class="cl_go" title="Write a performance guide from this character's card">
            <i class="fa-solid fa-wand-magic-sparkles"></i><span>Analyze</span>
          </div>
        </div>

        <textarea id="cl_text" class="text_pole textarea_compact" rows="14"
          placeholder="No interpretation yet. Open a character and press Analyze."></textarea>

        <div class="cl_foot">
          <label class="cl_mute" title="Keep the text but stop sending it to the model">
            <input id="cl_off" type="checkbox"><span>Mute</span>
          </label>
          <small id="cl_tokens"></small>
          <span id="cl_saved" class="cl_saved">saved</span>
          <div id="cl_delete" class="cl_icon danger" title="Delete this guide"><i class="fa-solid fa-trash-can"></i></div>
        </div>
      </div>

      <div class="cl_promptbox">
        <label for="cl_template"><i class="fa-solid fa-sliders"></i> Analyzer prompt</label>
        <textarea id="cl_template" class="text_pole textarea_compact" rows="6"
          placeholder="Leave empty for the built-in prompt. Use {{card}} where the character card should go."></textarea>
      </div>

      <hr class="sysHR">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-image"></i> Scene Art (CG)</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <small>A button appears on every character message. It draws nothing by itself — click it to make a scene for that exact moment.</small>

          <h4>🖌 Image API</h4>
          <small>Needs an actual image-capable model (e.g. a Gemini/Grok image model via OpenRouter). Leave URL/key empty to reuse the Analyzer's.</small>
          <input type="text" id="cl_img_url" class="text_pole margin-b-10" placeholder="Image API URL — leave empty to reuse Analyzer URL">
          <input type="password" id="cl_img_key" class="text_pole margin-b-10" placeholder="Image API key — leave empty to reuse Analyzer key">
          <input type="text" id="cl_img_model" class="text_pole margin-b-10" placeholder="Image model — e.g. google/gemini-3.1-flash-image, nano-banana-2">
          <label for="cl_img_mode">Request format</label>
          <select id="cl_img_mode" class="text_pole margin-b-10">
            <option value="auto">Auto-detect from the URL</option>
            <option value="images">/images/generations (OpenAI, NavyAI, most proxies)</option>
            <option value="chat">/chat/completions + modalities (OpenRouter)</option>
            <option value="comfy">ComfyUI (local — your own workflow)</option>
          </select>
          <small id="cl_img_note"></small>

          <div id="cl_comfy_box" class="cl_comfy" style="display:none;">
            <div class="cl_head">
              <label for="cl_comfy_pick" style="margin:0;"><i class="fa-solid fa-diagram-project"></i> ComfyUI workflows</label>
              <span id="cl_comfy_saved" class="cl_saved">saved</span>
            </div>
            <small>Keep one per setup — a LoRA graph, an IPAdapter graph, a plain one — and let each character pick theirs in the block above. Paste in <b>API format</b> (Workflow → Export (API)). Placeholders: <b>%prompt%</b>, <b>%negative%</b>, <b>%seed%</b>, <b>%image%</b>, <b>%lora%</b>, <b>%lora_strength%</b>, <b>%ipadapter_weight%</b>. For regional workflows: <b>%prompt_a%</b> (the character), <b>%prompt_b%</b> (the partner), <b>%prompt_scene%</b> (style and framing). Start ComfyUI with <b>--enable-cors-header</b> or the browser will not be allowed to reach it.</small>
            <select id="cl_comfy_pick" class="text_pole margin-b-10"></select>
            <div class="cl_buttons">
              <div id="cl_comfy_new" class="cl_mini">New</div>
              <div id="cl_comfy_rename" class="cl_mini">Rename</div>
              <div id="cl_comfy_dup" class="cl_mini">Duplicate</div>
              <div id="cl_comfy_del" class="cl_mini">Delete</div>
            </div>
            <textarea id="cl_comfy_workflow" class="text_pole textarea_compact" rows="8"
              placeholder="Paste the API-format workflow JSON here, or press an example button below."></textarea>
            <div class="cl_buttons">
              <div id="cl_comfy_example" class="cl_mini">Example: plain</div>
              <div id="cl_comfy_examplelora" class="cl_mini">Example: LoRA</div>
              <div id="cl_comfy_exampleip" class="cl_mini">Example: IPAdapter</div>
              <div id="cl_comfy_examplehires" class="cl_mini">Example: hires (eyes)</div>
              <div id="cl_comfy_exampleface" class="cl_mini">Example: FaceDetailer</div>
              <div id="cl_comfy_exampleregion" class="cl_mini">Example: two people</div>
              <div id="cl_comfy_clear" class="cl_mini">Clear</div>
            </div>
            <small id="cl_comfy_note"></small>

            <label for="cl_comfy_tpl">Prompt template</label>
            <small>Local models read tags, not sentences, so the prompt is assembled from blocks instead of written as prose. <b>{style}</b> and <b>{char}</b> are yours; the model only fills <b>{description}</b> (the expression) and <b>{pose}</b>. Cloud modes ignore all of this.</small>
            <textarea id="cl_comfy_tpl" class="text_pole textarea_compact" rows="4"
              placeholder="{style},&#10;{char},&#10;{description},&#10;{pose}"></textarea>
            <div class="cl_buttons">
              <div id="cl_comfy_tplreset" class="cl_mini">Reset template</div>
            </div>
            <small id="cl_comfy_tplnote"></small>

            <div class="cl_head">
              <label for="cl_comfy_stylepreset" style="margin:0;"><i class="fa-solid fa-palette"></i> Style block ({style})</label>
              <span id="cl_comfy_stylereset" class="cl_icon" title="Back to the preset text"><i class="fa-solid fa-rotate-left"></i></span>
            </div>
            <select id="cl_comfy_stylepreset" class="text_pole margin-b-10"></select>
            <textarea id="cl_comfy_style" class="text_pole textarea_compact" rows="4"
              placeholder="Style tags. Edit freely — the preset above is only a starting point."></textarea>

            <label for="cl_comfy_negative">Negative prompt (fills %negative%)</label>
            <input type="text" id="cl_comfy_negative" class="text_pole" placeholder="e.g. lowres, bad anatomy, extra fingers, watermark">
            <div class="cl_buttons">
              <div id="cl_comfy_negdefault" class="cl_mini">Insert recommended</div>
              <div id="cl_comfy_negclear" class="cl_mini">Clear</div>
            </div>

            <label for="cl_comfy_timeout">Wait for the image up to (seconds)</label>
            <input type="number" id="cl_comfy_timeout" class="text_pole margin-b-10" min="30" max="1200" step="10">
          </div>
          <label for="cl_cg_promptmodel">Prompt-writer model (optional)</label>
          <input type="text" id="cl_cg_promptmodel" class="text_pole margin-b-10" placeholder="Leave empty to reuse the Analyzer model">

          <hr>
          <div class="cl_card" id="cl_cg_block">
            <div class="cl_head">
              <div class="cl_who">
                <b id="cl_cg_charname">—</b>
                <small id="cl_cg_meta">reference &amp; appearance for Scene Art</small>
              </div>
              <div id="cl_cg_analyze" class="cl_go" title="Write appearance notes from this character's card">
                <i class="fa-solid fa-wand-magic-sparkles"></i><span>Analyze appearance</span>
              </div>
            </div>
            <select id="cl_cg_member" class="text_pole"></select>
            <small id="cl_cg_follow" class="margin-b-10" style="display:block;"></small>

            <div class="cl_cg_spritebox">
              <div id="cl_cg_spritepreview" class="cl_cg_spritepreview"><span>no reference image</span></div>
              <div class="cl_buttons">
                <input type="file" id="cl_cg_spritefile" accept="image/*" style="display:none;">
                <div id="cl_cg_spritepick" class="cl_mini">Upload reference</div>
                <div id="cl_cg_spriteclear" class="cl_mini">Remove</div>
              </div>
            </div>

            <textarea id="cl_cg_desc" class="text_pole textarea_compact" rows="4"
              placeholder="Anything the reference image or card doesn't already say — hair colour, a scar, a favourite outfit. Or press Analyze appearance above."></textarea>

            <hr>
            <div class="cl_head">
              <label style="margin:0;"><i class="fa-solid fa-user"></i> You — the partner in the scene</label>
              <span id="cl_persona_saved" class="cl_saved">saved</span>
            </div>
            <small>A two-person moment needs a second person. Without this the model invents one, usually by copying the character standing next to them.</small>

            <div class="cl_cg_spritebox">
              <div id="cl_persona_prev" class="cl_cg_spritepreview"><span>no reference image</span></div>
              <div class="cl_buttons">
                <input type="file" id="cl_persona_file" accept="image/*" style="display:none;">
                <div id="cl_persona_upload" class="cl_mini">Upload reference</div>
                <div id="cl_persona_clear" class="cl_mini">Remove</div>
              </div>
            </div>

            <label for="cl_persona_mode">Partner in frame</label>
            <select id="cl_persona_mode" class="text_pole margin-b-10">
              <option value="auto">When the scene has them in it</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>

            <div class="cl_head">
              <label for="cl_persona_desc" style="margin:0;">Appearance notes</label>
              <div id="cl_persona_frompersona" class="cl_go" title="Copy from the SillyTavern persona description">
                <i class="fa-solid fa-download"></i><span>Take from persona</span>
              </div>
            </div>
            <textarea id="cl_persona_desc" class="text_pole textarea_compact" rows="3"
              placeholder="What you look like, in prose. Used by cloud models and as context for the tag writer."></textarea>

            <div id="cl_persona_tagbox" style="display:none;">
              <div class="cl_head">
                <label for="cl_persona_tags" style="margin:0;">Identity tags ({partner}) — local models</label>
                <div id="cl_persona_readref" class="cl_go" title="Read appearance tags off the reference image above">
                  <i class="fa-solid fa-eye"></i><span>Tags from reference</span>
                </div>
              </div>
              <small>Keep it short and contrasting — three to five tags. Two characters bleed into each other if both are described at length. Include <b>1boy</b> or <b>1girl</b>; the count tag for the pair is worked out from there.</small>
              <textarea id="cl_persona_tags" class="text_pole textarea_compact" rows="2"
                placeholder="1boy, short black hair, green eyes, dark suit"></textarea>
              <small id="cl_persona_tagnote"></small>
            </div>

            <div id="cl_cg_localbox" class="cl_comfy" style="display:none;">
              <div class="cl_head">
                <label for="cl_cg_tags" style="margin:0;"><i class="fa-solid fa-tags"></i> Identity tags ({char}) — local models</label>
                <div id="cl_cg_readref" class="cl_go" title="Read appearance tags off the saved reference image">
                  <i class="fa-solid fa-eye"></i><span>Tags from reference</span>
                </div>
              </div>
              <small>Who this character <i>is</i>, in tags. For an original character with no LoRA this block is what makes them look like themselves — a local model gets a face from tags, not from prose.</small>
              <textarea id="cl_cg_tags" class="text_pole textarea_compact" rows="3"
                placeholder="1girl, solo, pink hair, long hair, blue eyes, pink tracksuit, highly detailed face, beautiful face"></textarea>
              <small id="cl_cg_tagnote"></small>

              <label for="cl_cg_identity">Identity comes from</label>
              <select id="cl_cg_identity" class="text_pole">
                <option value="auto">Whatever is set (tags + LoRA + reference)</option>
                <option value="lora">Character LoRA</option>
                <option value="reference">Reference image (IPAdapter)</option>
                <option value="tags">Tags only</option>
              </select>
              <small class="margin-b-10" style="display:block;">In this mode it is this setting, not "Draw from" below, that decides whether the reference image is sent.</small>

              <label for="cl_cg_workflow">Draw with workflow</label>
              <select id="cl_cg_workflow" class="text_pole margin-b-10"></select>

              <div class="cl_head">
                <label for="cl_cg_lora" style="margin:0;">Character LoRA (fills %lora%)</label>
                <span id="cl_cg_lorarefresh" class="cl_icon" title="Re-read the list from ComfyUI"><i class="fa-solid fa-rotate"></i></span>
              </div>
              <select id="cl_cg_lora" class="text_pole margin-b-10"></select>
              <label for="cl_cg_lorastr">LoRA strength (fills %lora_strength%)</label>
              <input type="number" id="cl_cg_lorastr" class="text_pole margin-b-10" min="-2" max="3" step="0.05">
              <label for="cl_cg_ipweight">IPAdapter weight (fills %ipadapter_weight%)</label>
              <input type="number" id="cl_cg_ipweight" class="text_pole" min="0" max="2" step="0.05">
              <small>Around 0.6–0.7. At 1.0 the adapter pulls the reference's pose and framing into every scene.</small>
              <small id="cl_cg_loranote"></small>
            </div>

            <div class="cl_foot">
              <label for="cl_cg_mode" style="margin:0;opacity:.8;font-size:.8rem;">Draw from</label>
              <select id="cl_cg_mode" class="text_pole" style="flex:1;">
                <option value="both">Reference + description</option>
                <option value="sprite">Reference only</option>
                <option value="text">Description only</option>
              </select>
              <span id="cl_cg_saved" class="cl_saved">saved</span>
            </div>
          </div>

          <div class="cl_promptbox">
            <div class="cl_head">
              <label for="cl_cg_preset" style="margin:0;"><i class="fa-solid fa-sliders"></i> CG style preset</label>
              <div id="cl_cg_reset" class="cl_icon" title="Reset this preset's prompt to the built-in default"><i class="fa-solid fa-rotate-left"></i></div>
            </div>
            <select id="cl_cg_preset" class="text_pole margin-b-10"></select>
            <textarea id="cl_cg_presettext" class="text_pole textarea_compact" rows="8"
              placeholder="The prompt-writer's style instructions for this preset."></textarea>
            <div class="cl_foot">
              <small style="flex:1;">Shapes the prompt-writer's instructions — edit freely, reset any time.</small>
              <span id="cl_cg_preset_saved" class="cl_saved">saved</span>
            </div>
            <label for="cl_cg_style">Extra style notes (optional, on top of the preset)</label>
            <input type="text" id="cl_cg_style" class="text_pole margin-b-10" placeholder="e.g. warmer palette, rain outside the window">
          </div>
        </div>
      </div>

    </div>
  </div>
</div>`;

function refreshApiNote() {
    const from = borrowedFrom();
    const parts = [];
    if (from) parts.push(`borrowing key/model from ${from}`);
    if (!apiKeyVal()) parts.push('no API key yet');
    else if (!apiModel()) parts.push('no model name yet');
    else parts.push(`${apiModel()} @ ${apiUrl()}`);
    $('#cl_apinote').text(parts.join(' · '));
}

function refreshInjectUI() {
    const s = settings();
    const inChat = Number(s.position) === extension_prompt_types.IN_CHAT;
    $('#cl_depth').prop('disabled', !inChat).closest('div').css('opacity', inChat ? 1 : 0.4);
    $('#cl_injrole').prop('disabled', !inChat).closest('div').css('opacity', inChat ? 1 : 0.4);
    $('#cl_depthhint').text(inChat
        ? (Number(s.depth) === 0
            ? 'Depth 0 — after the last message, closest to generation. Strongest, but sits between the last message and the reply.'
            : `Depth ${s.depth} — inserted ${s.depth} message(s) back from the end.`)
        : 'System prompt: goes with the other system instructions at the top. Depth and role do not apply here.');
}

function bind() {
    const s = settings();

    $('#cl_enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = !!$(this).prop('checked'); saveSettingsDebounced(); inject();
    });

    $('#cl_baseurl').val(s.baseUrl).on('input', function () {
        s.baseUrl = $(this).val(); saveSettingsDebounced(); refreshApiNote();
    });
    $('#cl_apikey').val(s.apiKey).on('input', function () {
        s.apiKey = $(this).val(); saveSettingsDebounced(); refreshApiNote();
    });
    $('#cl_model').val(s.model).on('input', function () {
        s.model = $(this).val(); saveSettingsDebounced(); refreshApiNote();
    });
    $('#cl_temp').val(s.temperature).on('input', function () {
        const v = Number($(this).val());
        s.temperature = Number.isFinite(v) ? v : 0.6;
        $('#cl_tempval').text(s.temperature.toFixed(1));
        saveSettingsDebounced();
    });
    $('#cl_tempval').text(Number(s.temperature).toFixed(1));


    $('#cl_batch').on('click', analyzeMissing);
    $('#cl_restale').on('click', () => analyze());
    $('#cl_test').on('click', async () => {
        const $b = $('#cl_test');
        if ($b.hasClass('disabled')) return;
        if (!apiKeyVal()) { toastr.warning('No API key.'); return; }
        if (!apiModel()) { toastr.warning('No model name.'); return; }
        $b.addClass('disabled').text('Testing…');
        try {
            const r = await callAnalyzer('Reply with the single word: ready');
            toastr.success(`${esc(apiModel())} answered: ${esc(r.slice(0, 40))}`);
        } catch (e) {
            toastr.error(esc(e?.message ?? e), 'Character Lens');
        } finally {
            $b.removeClass('disabled').text('Test connection');
        }
    });

    $('#cl_position').val(String(s.position)).on('change', function () {
        s.position = Number($(this).val()); saveSettingsDebounced(); refreshInjectUI(); inject();
    });
    $('#cl_depth').val(s.depth).on('input', function () {
        const v = Math.max(0, Math.min(99, Number($(this).val()) || 0));
        s.depth = v; saveSettingsDebounced(); refreshInjectUI(); inject();
    });
    $('#cl_injrole').val(String(s.role)).on('change', function () {
        s.role = Number($(this).val()); saveSettingsDebounced(); inject();
    });
    $('#cl_maxtokens').val(s.maxTokens).on('input', function () {
        const v = Number($(this).val());
        s.maxTokens = Number.isFinite(v) && v > 0 ? Math.max(200, Math.min(4000, v)) : defaults.maxTokens;
        saveSettingsDebounced();
    }).on('blur', function () { $(this).val(settings().maxTokens); });
    $('#cl_template').val(s.template).on('input', function () {
        s.template = $(this).val(); saveSettingsDebounced();
    });

    $('#cl_member').on('change', function () {
        selectedAvatar = String($(this).val()); renderProfile();
    });
    $('#cl_groupmode').val(s.groupMode).on('change', function () {
        s.groupMode = String($(this).val()); saveSettingsDebounced(); inject();
    });
    $('#cl_off').on('change', function () {
        const avatar = panelAvatar();
        if (!avatar || !s.profiles[avatar]) return;
        s.profiles[avatar].off = !!$(this).prop('checked');
        saveSettingsDebounced(); renderProfile(); inject();
    });

    // NOT `.on('click', analyze)`: jQuery hands the handler a click event, which then
    // arrived as forAvatar and was looked up as if it were a character. That is why
    // the single-character button started answering "that card could not be read".
    $('#cl_analyze').on('click', () => analyze());

    /* Typing IS saving. A button that exists to confirm what you just did is a button
       that eventually loses someone's edits — a short pause after the last keystroke
       is the whole mechanism, and the word "saved" fades in to say so. */
    let saveTimer = null;
    $('#cl_text').on('input', function () {
        const avatar = panelAvatar();
        if (!avatar) return;
        const text = String($(this).val() ?? '');
        clearTimeout(saveTimer);
        $('#cl_saved').removeClass('on');
        saveTimer = setTimeout(() => {
            const prev = s.profiles[avatar];
            if (!text.trim()) {
                // Emptying the box is not the same as deleting: the entry stays so
                // that muting, dates and the card fingerprint are not lost.
                if (prev) { prev.text = ''; saveNow(); inject(); }
            } else {
                s.profiles[avatar] = { ...(prev ?? {}), text: text.trim(), date: new Date().toISOString() };
                saveNow(); inject();
            }
            $('#cl_saved').addClass('on');
            setTimeout(() => $('#cl_saved').removeClass('on'), 1400);
        }, 700);
    });

    $('#cl_delete').on('click', () => {
        const avatar = panelAvatar();
        if (!avatar || !s.profiles[avatar]) return;
        delete s.profiles[avatar];
        saveNow(); renderProfile(); inject();
        toastr.info('Deleted.');
    });

    // ── Scene Art (CG) ──────────────────────────────────────
    $('#cl_img_url').val(s.img.apiUrl).on('input', function () {
        s.img.apiUrl = $(this).val(); saveSettingsDebounced(); renderCGApi();
    });
    $('#cl_img_key').val(s.img.apiKey).on('input', function () {
        s.img.apiKey = $(this).val(); saveSettingsDebounced(); renderCGApi();
    });
    $('#cl_img_model').val(s.img.model).on('input', function () {
        s.img.model = $(this).val(); saveSettingsDebounced(); renderCGApi();
    });
    $('#cl_img_mode').val(s.img.mode || 'auto').on('change', function () {
        s.img.mode = String($(this).val());
        saveSettingsDebounced();
        renderCGApi();
        // the identity/LoRA block lives on the character card and appears or hides
        // with the very same switch, so that panel has to be redrawn as well
        renderCGProfile();
    });
    $('#cl_cg_promptmodel').val(s.cgPromptModel).on('input', function () {
        s.cgPromptModel = $(this).val(); saveSettingsDebounced();
    });

    /* Same "typing is saving" contract as every other box in this panel. The note under
       it re-validates on each keystroke, but the write itself waits for a pause. */
    let comfyTimer = null;
    $('#cl_comfy_workflow').val(activeWorkflow()?.text ?? '').on('input', function () {
        const wf = activeWorkflow();
        if (!wf) return;   // nothing selected: typing has nowhere to land
        wf.text = String($(this).val() ?? '');
        renderComfyNote();
        clearTimeout(comfyTimer);
        $('#cl_comfy_saved').removeClass('on');
        comfyTimer = setTimeout(() => { saveNow(); flashSaved('#cl_comfy_saved'); }, 700);
    });

    $('#cl_comfy_pick').on('change', function () {
        s.comfy.activeWorkflow = String($(this).val() ?? '');
        $('#cl_comfy_workflow').val(activeWorkflow()?.text ?? '');
        renderComfyNote();
        saveSettingsDebounced();
    });
    $('#cl_comfy_new').on('click', async function () {
        const name = prompt('Name for the new workflow:', `Workflow ${s.comfy.workflows.length + 1}`);
        if (name === null) return;
        createWorkflow(name);
        $('#cl_comfy_workflow').val('');
        renderWorkflowPicker(); renderComfyNote();
        await saveNow();
    });
    $('#cl_comfy_rename').on('click', async function () {
        const wf = activeWorkflow();
        if (!wf) return;
        const name = prompt('Rename this workflow:', wf.name);
        if (name === null || !name.trim()) return;
        wf.name = name.trim();
        renderWorkflowPicker();
        await saveNow();
    });
    $('#cl_comfy_dup').on('click', async function () {
        const wf = activeWorkflow();
        if (!wf) return;
        createWorkflow(`${wf.name} copy`, wf.text);
        $('#cl_comfy_workflow').val(activeWorkflow()?.text ?? '');
        renderWorkflowPicker(); renderComfyNote();
        await saveNow();
    });
    $('#cl_comfy_del').on('click', async function () {
        const wf = activeWorkflow();
        if (!wf) return;
        if (!confirm(`Delete the workflow "${wf.name}"?`)) return;
        const orphans = deleteWorkflow(wf.id);
        $('#cl_comfy_workflow').val(activeWorkflow()?.text ?? '');
        renderWorkflowPicker(); renderComfyNote();
        await saveNow();
        // characters pointing here now fall back to the first workflow, which is a
        // quiet change of behaviour unless it is said out loud
        toastr.info(orphans
            ? `Deleted. ${orphans} character${orphans > 1 ? 's' : ''} now fall back to the first workflow.`
            : 'Workflow deleted.');
    });
    $('#cl_comfy_negative').val(s.comfy.negative).on('input', function () {
        s.comfy.negative = $(this).val(); saveSettingsDebounced();
    });
    $('#cl_comfy_negdefault').on('click', async function () {
        if (String(s.comfy.negative || '').trim() && !confirm('Replace the negative prompt with the recommended one?')) return;
        s.comfy.negative = RECOMMENDED_NEGATIVE;
        $('#cl_comfy_negative').val(s.comfy.negative);
        await saveNow();
        toastr.success('Recommended negative prompt inserted.');
    });
    $('#cl_comfy_negclear').on('click', async function () {
        if (!String(s.comfy.negative || '').trim()) return;
        s.comfy.negative = '';
        $('#cl_comfy_negative').val('');
        await saveNow();
    });

    $('#cl_comfy_tpl').val(s.comfy.template).on('input', function () {
        s.comfy.template = String($(this).val() ?? '');
        renderTemplateNote();
        saveSettingsDebounced();
    });
    $('#cl_comfy_tplreset').on('click', async function () {
        s.comfy.template = DEFAULT_TAG_TEMPLATE;
        $('#cl_comfy_tpl').val(s.comfy.template);
        renderTemplateNote();
        await saveNow();
    });

    /* Style works like the CG preset above it: the dropdown supplies a starting text,
       editing it stores an override, and the reset arrow drops back to the preset. */
    $('#cl_comfy_stylepreset').on('change', async function () {
        const id = $(this).val();
        if (String(s.comfy.style || '').trim() && !confirm('You have edited the style block. Replace it with this preset?')) {
            $(this).val(s.comfy.stylePreset);
            return;
        }
        s.comfy.stylePreset = id;
        s.comfy.style = '';
        $('#cl_comfy_style').val(tagStyleText());
        $('#cl_comfy_stylereset').addClass('off');
        await saveNow();
    });
    $('#cl_comfy_style').val(tagStyleText()).on('input', function () {
        const val = String($(this).val() ?? '');
        // matching the preset exactly is not an override — keep it as "unedited"
        s.comfy.style = val.trim() === (TAG_STYLE_PRESETS[s.comfy.stylePreset]?.text ?? '').trim() ? '' : val;
        $('#cl_comfy_stylereset').toggleClass('off', !s.comfy.style.trim());
        saveSettingsDebounced();
    });
    $('#cl_comfy_stylereset').on('click', async function () {
        if (!String(s.comfy.style || '').trim()) return;
        s.comfy.style = '';
        $('#cl_comfy_style').val(tagStyleText());
        $(this).addClass('off');
        await saveNow();
    });

    $('#cl_cg_tags').on('input', function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        cgProfile(avatar).tags = String($(this).val() ?? '');
        renderTagNote('#cl_cg_tagnote', cgProfile(avatar).tags);
        saveSettingsDebounced();
        flashSaved('#cl_cg_saved');
    });
    $('#cl_cg_lora').on('change', async function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        cgProfile(avatar).lora = String($(this).val() ?? '');
        await saveNow();
        renderLoraChoices(cgProfile(avatar).lora);
        flashSaved('#cl_cg_saved');
    });
    $('#cl_cg_lorastr').on('input', function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        const v = Number($(this).val());
        cgProfile(avatar).loraStrength = Number.isFinite(v) ? Math.max(-2, Math.min(3, v)) : 1;
        saveSettingsDebounced();
    }).on('blur', function () {
        if (selectedCgAvatar) $(this).val(cgProfile(selectedCgAvatar).loraStrength);
    });
    $('#cl_cg_identity').on('change', async function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        cgProfile(avatar).identity = String($(this).val() ?? 'auto');
        await saveNow();
        renderLoraChoices(cgProfile(avatar).lora || '');   // the warning above depends on it
        flashSaved('#cl_cg_saved');
    });
    $('#cl_cg_workflow').on('change', async function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        cgProfile(avatar).workflowId = String($(this).val() ?? '');
        await saveNow();
        renderLoraChoices(cgProfile(avatar).lora || '');   // a different graph, a different verdict
        flashSaved('#cl_cg_saved');
    });
    $('#cl_cg_ipweight').on('input', function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        const v = Number($(this).val());
        cgProfile(avatar).ipWeight = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 0.65;
        saveSettingsDebounced();
    }).on('blur', function () {
        if (selectedCgAvatar) $(this).val(cgProfile(selectedCgAvatar).ipWeight);
    });

    /* Reads the tag block off the reference picture the character already has. This is
       the answer for original characters: they will never have a LoRA, so the tags are
       the only identity anchor, and writing them by hand is the actual chore. */
    $('#cl_cg_readref').on('click', async function () {
        const $b = $(this);
        if ($b.hasClass('off') || $b.hasClass('disabled')) return;
        const avatar = selectedCgAvatar;
        const prof = avatar ? cgProfile(avatar) : null;
        if (!hasSprite(avatar)) { toastr.warning('This character has no reference image yet.'); return; }
        if (String(prof.tags || '').trim() && !confirm('Replace the identity tags with what the model reads from the reference?')) return;
        $b.addClass('disabled').find('span').text('Looking…');
        try {
            const sprite = await loadSprite(avatar);
            if (!sprite) throw new Error('The reference image could not be read back from storage.');
            const tags = await callVisionTagger(sprite);
            if (!tags) throw new Error('The model returned no tags.');
            prof.tags = tags;
            $('#cl_cg_tags').val(tags);
            await saveNow();
            flashSaved('#cl_cg_saved');
            toastr.success('Identity tags read from the reference. Check them — a model can misread an outfit.');
        } catch (e) {
            console.error('[Character Lens] vision tagger', e);
            toastr.error(esc(e?.message ?? e), 'Character Lens');
        } finally {
            $b.removeClass('disabled').find('span').text('Tags from reference');
        }
    });

    $('#cl_cg_lorarefresh').on('click', async function () {
        comfyLoraCache = null;
        const list = await comfyLoraList({ force: true });
        renderLoraChoices(selectedCgAvatar ? cgProfile(selectedCgAvatar).lora : '');
        toastr[list ? 'success' : 'warning'](list ? `${list.length} LoRAs found.` : 'ComfyUI did not answer.');
    });
    $('#cl_comfy_timeout').val(s.comfy.timeout).on('input', function () {
        const v = Number($(this).val());
        s.comfy.timeout = Number.isFinite(v) && v > 0 ? Math.max(30, Math.min(1200, v)) : defaults.comfy.timeout;
        saveSettingsDebounced();
    }).on('blur', function () { $(this).val(settings().comfy.timeout); });

    /* Both example buttons share this: make sure there is somewhere to put the graph,
       do not overwrite work without asking, and name a real checkpoint so the example
       runs on the first click instead of failing on a made-up filename. */
    async function insertExample($b, label, build, requiredNodes) {
        if ($b.hasClass('disabled')) return;
        if (!activeWorkflow()) createWorkflow('Workflow 1');
        const wf = activeWorkflow();
        if (String(wf.text || '').trim() && !confirm(`Replace the contents of "${wf.name}" with the example?`)) return;
        $b.addClass('disabled').text('Reading ComfyUI…');
        let info = null;
        try {
            if (requiredNodes?.length) {
                const check = await comfyCheckNodes(requiredNodes);
                info = check.info ?? null;
                if (!check.reachable) {
                    toastr.warning('ComfyUI could not be reached, so the required nodes could not be checked. Inserting anyway.');
                } else if (!check.ok) {
                    toastr.error(`ComfyUI does not have ${esc(check.missing.join(', '))}. Install ${esc(packageFor(check.missing))} through the Manager (and its models), then try again.`, 'Character Lens', { timeOut: 14000 });
                    return;
                }
            }
            const ckpt = await comfyFirstCheckpoint();
            wf.text = build(ckpt || 'PUT-YOUR-CHECKPOINT-HERE.safetensors', info);
            $('#cl_comfy_workflow').val(wf.text);
            await saveNow();
            renderWorkflowPicker();
            renderComfyNote();
            flashSaved('#cl_comfy_saved');
            toastr[ckpt ? 'success' : 'info'](ckpt
                ? `Example inserted, using ${esc(ckpt)}.`
                : 'Example inserted, but ComfyUI could not be reached — set ckpt_name to your own checkpoint by hand.');
        } finally {
            $b.removeClass('disabled').text(label);
        }
    }
    $('#cl_comfy_example').on('click', function () {
        insertExample($(this), 'Example: plain', comfyExampleWorkflow, null);
    });
    $('#cl_comfy_examplelora').on('click', function () {
        insertExample($(this), 'Example: LoRA', comfyLoraWorkflow, ['LoraLoader']);
    });
    $('#cl_comfy_exampleip').on('click', function () {
        insertExample($(this), 'Example: IPAdapter', comfyIPAdapterWorkflow, ['IPAdapterUnifiedLoader', 'IPAdapterAdvanced', 'LoadImage']);
    });
    $('#cl_comfy_examplehires').on('click', function () {
        insertExample($(this), 'Example: hires (eyes)', comfyHiresWorkflow, ['LatentUpscaleBy', 'LoraLoader']);
    });
    $('#cl_comfy_exampleregion').on('click', function () {
        insertExample($(this), 'Example: two people', comfyRegionalWorkflow, ['ConditioningSetAreaPercentage', 'ConditioningCombine', 'LoraLoader']);
    });
    $('#cl_comfy_exampleface').on('click', function () {
        insertExample($(this), 'Example: FaceDetailer', comfyFaceDetailerWorkflow, ['FaceDetailer', 'UltralyticsDetectorProvider']);
    });
    $('#cl_comfy_clear').on('click', async function () {
        const wf = activeWorkflow();
        if (!wf || !String(wf.text || '').trim()) return;
        if (!confirm(`Empty the workflow "${wf.name}"? The entry itself stays in the list.`)) return;
        wf.text = '';
        $('#cl_comfy_workflow').val('');
        await saveNow();
        renderComfyNote();
    });
    $('#cl_cg_preset').on('change', function () {
        s.cgPreset = String($(this).val()); saveSettingsDebounced(); renderCGPresetText();
    });
    $('#cl_cg_style').val(s.cgStyle).on('input', function () {
        s.cgStyle = $(this).val(); saveSettingsDebounced();
    });

    /* Editing a preset's own prompt is exactly the same "typing is saving" pattern
       as everything else here — an edit is stored per preset id, keyed separately
       from the built-in CG_PRESETS text so Reset always has something to return to. */
    let cgPresetTimer = null;
    $('#cl_cg_presettext').on('input', function () {
        const id = settings().cgPreset;
        const val = String($(this).val() ?? '');
        clearTimeout(cgPresetTimer);
        cgPresetTimer = setTimeout(() => {
            const def = cgPresetDefaultText(id);
            // typed back to exactly the default: drop the override rather than store a no-op copy
            if (val.trim() === def.trim()) delete s.cgPresetOverrides[id];
            else s.cgPresetOverrides[id] = val;
            saveNow();
            $('#cl_cg_reset').toggleClass('off', val.trim() === def.trim());
            flashSaved('#cl_cg_preset_saved');
        }, 600);
    });
    $('#cl_cg_reset').on('click', function () {
        if ($(this).hasClass('off')) return;   // already at default, nothing to do
        const id = settings().cgPreset;
        delete s.cgPresetOverrides[id];
        saveNow();
        renderCGPresetText();
        toastr.info('Preset prompt reset to default.');
    });

    $('#cl_cg_member').on('change', function () {
        // choosing by hand pins the panel until the chat changes
        selectedCgAvatar = String($(this).val());
        cgPinnedAvatar = selectedCgAvatar;
        renderCG();
    });
    // the link is rebuilt by renderCG on every redraw, so the handler is delegated
    $(document).on('click', '#cl_cg_unpin', function (e) {
        e.preventDefault();
        cgPinnedAvatar = null;
        renderCG();
    });
    $('#cl_cg_analyze').on('click', () => analyzeAppearance());

    $('#cl_cg_spritepick').on('click', () => $('#cl_cg_spritefile').trigger('click'));
    $('#cl_cg_spritefile').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';   // так тот же файл можно выбрать снова после «Убрать»
        const avatar = selectedCgAvatar;
        if (!file || !avatar) return;
        try {
            const dataUrl = await resizeImageFile(file);
            await setSprite(avatar, dataUrl);
            await saveNow();
            renderCG();
            flashSaved('#cl_cg_saved');
        } catch (e) {
            toastr.error(esc(e?.message ?? e), 'Character Lens');
        }
    });
    $('#cl_cg_spriteclear').on('click', async () => {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        await clearSprite(avatar);
        await saveNow();
        renderCG();
        flashSaved('#cl_cg_saved');
    });

    // ── the persona block: the other person in the scene ──
    $('#cl_persona_upload').on('click', () => $('#cl_persona_file').trigger('click'));
    $('#cl_persona_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            await setSprite(PERSONA_KEY, await resizeImageFile(file));
            await saveNow();
            renderPersona();
            flashSaved('#cl_persona_saved');
        } catch (e) {
            toastr.error(esc(e?.message ?? e), 'Character Lens');
        }
    });
    $('#cl_persona_clear').on('click', async () => {
        await clearSprite(PERSONA_KEY);
        await saveNow();
        renderPersona();
        flashSaved('#cl_persona_saved');
    });
    $('#cl_persona_mode').on('change', async function () {
        s.partnerMode = String($(this).val() ?? 'auto');
        await saveNow();
        flashSaved('#cl_persona_saved');
    });
    let personaTimer = null;
    const personaField = (sel, key) => $(sel).on('input', function () {
        cgProfile(PERSONA_KEY)[key] = String($(this).val() ?? '');
        if (key === 'tags') renderTagNote('#cl_persona_tagnote', cgProfile(PERSONA_KEY).tags);
        clearTimeout(personaTimer);
        personaTimer = setTimeout(() => { saveNow(); flashSaved('#cl_persona_saved'); }, 500);
    });
    personaField('#cl_persona_desc', 'desc');
    personaField('#cl_persona_tags', 'tags');

    $('#cl_persona_frompersona').on('click', async function () {
        const text = String(personaDescriptionText() || '').trim();
        if (!text) {
            toastr.warning('No persona description found in SillyTavern. Write one under User Settings → Persona, or type it here.');
            return;
        }
        const persona = cgProfile(PERSONA_KEY);
        if (persona.desc?.trim() && !confirm('Replace the appearance notes with the persona description?')) return;
        persona.desc = text;
        $('#cl_persona_desc').val(text);
        await saveNow();
        flashSaved('#cl_persona_saved');
        toastr.success('Copied from the persona description. Trim it to appearance — motives and history only confuse the image.');
    });

    $('#cl_persona_readref').on('click', async function () {
        const $b = $(this);
        if ($b.hasClass('off') || $b.hasClass('disabled')) return;
        const persona = cgProfile(PERSONA_KEY);
        if (String(persona.tags || '').trim() && !confirm('Replace the partner tags with what the model reads from the reference?')) return;
        $b.addClass('disabled').find('span').text('Looking…');
        try {
            const sprite = await loadSprite(PERSONA_KEY);
            if (!sprite) throw new Error('The reference image could not be read back from storage.');
            const tags = await callVisionTagger(sprite);
            if (!tags) throw new Error('The model returned no tags.');
            persona.tags = tags;
            $('#cl_persona_tags').val(tags);
            await saveNow();
            flashSaved('#cl_persona_saved');
            toastr.success('Partner tags read from the reference. Trim them — a short, contrasting list holds up better with two people in frame.');
        } catch (e) {
            console.error('[Character Lens] persona vision tagger', e);
            toastr.error(esc(e?.message ?? e), 'Character Lens');
        } finally {
            $b.removeClass('disabled').find('span').text('Tags from reference');
        }
    });

    /* Same "typing is saving" idea as the analyzer text box above, just a shorter
       debounce — these notes are a few words, not a page of prose. */
    let cgDescTimer = null;
    $('#cl_cg_desc').on('input', function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        const val = String($(this).val() ?? '');
        clearTimeout(cgDescTimer);
        cgDescTimer = setTimeout(() => {
            cgProfile(avatar).desc = val;
            saveNow();
            flashSaved('#cl_cg_saved');
        }, 500);
    });
    $('#cl_cg_mode').on('change', function () {
        const avatar = selectedCgAvatar;
        if (!avatar) return;
        cgProfile(avatar).mode = String($(this).val());
        saveNow(); flashSaved('#cl_cg_saved');
    });
}

// ─────────────────────────────────────────────────────────────
jQuery(async () => {
    settings();
    const host = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    $(host).append(HTML);
    bind();
    refreshApiNote();
    refreshInjectUI();
    renderProfile();
    renderCGApi();
    renderCG();
    inject();

    for (const ev of [event_types.CHAT_CHANGED, event_types.CHARACTER_EDITED, event_types.GROUP_UPDATED]) {
        if (ev) eventSource.on(ev, () => { selectedAvatar = null; selectedCgAvatar = null; draftedAvatar = null; renderProfile(); renderCG(); inject(); });
    }
    // список персонажей может быть ещё не готов на момент загрузки расширения
    for (const ev of [event_types.APP_READY, event_types.CHARACTER_PAGE_LOADED, event_types.SETTINGS_LOADED]) {
        if (ev) eventSource.on(ev, () => { renderProfile(); renderCG(); inject(); });
    }
    setTimeout(() => { renderProfile(); renderCG(); inject(); }, 1500);
    // и при каждом раскрытии панели — на случай, если событие всё-таки не пришло
    $(document).off('click.charlens').on('click.charlens', '.character-lens .inline-drawer-toggle', () => {
        setTimeout(renderProfile, 50);
    });

    // в группе SillyTavern сообщает, кто сейчас будет говорить
    for (const ev of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        if (ev) eventSource.on(ev, () => { draftedAvatar = null; });
    }

    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (id) => {
        draftedAvatar = typeof id === 'number'
            ? (getContext().characters?.[id]?.avatar ?? null)
            : (typeof id === 'string' ? id : null);
        inject();
    });

    // ── Scene Art (CG): put the button on every message that has one already
    // rendered, and on every one that renders from here on. Saved scenes come back
    // at the same moments — SillyTavern rebuilds the whole log on a chat switch, so
    // every restore point has to be a render point. ──
    function refreshMessage(id) {
        if (!Number.isFinite(id)) return;
        injectSceneButton(id);
        // deliberately not awaited — the button must appear instantly — but a failed
        // read must stay a console line, not an unhandled rejection
        Promise.resolve(restoreScene(id)).catch(e => console.warn('[Character Lens] could not restore a scene', e));
    }
    function injectAllVisibleButtons() {
        $('.mes[mesid]').each(function () {
            refreshMessage(Number($(this).attr('mesid')));
        });
    }
    for (const ev of [event_types.USER_MESSAGE_RENDERED, event_types.CHARACTER_MESSAGE_RENDERED]) {
        if (ev) eventSource.on(ev, (id) => refreshMessage(Number(id)));
    }
    // the Scene Art panel follows whoever spoke last
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => cgFollowChat());
    }
    /* Editing a message makes SillyTavern re-render that one block, which wipes the
       photo out of the DOM exactly the way a chat switch does — just for one message. */
    for (const ev of [event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        if (ev) eventSource.on(ev, (id) => setTimeout(() => refreshMessage(Number(id)), 60));
    }
    // scrolling up loads older messages into a log that was already on screen
    for (const ev of [event_types.MORE_MESSAGES_LOADED]) {
        if (ev) eventSource.on(ev, () => setTimeout(injectAllVisibleButtons, 60));
    }
    // после смены чата ST перерисовывает весь лог заново — старые кнопки ушли вместе с DOM
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => {
        cgRunning.clear();
        // a character pinned in the previous chat means nothing in this one
        cgPinnedAvatar = null;
        setTimeout(() => { injectAllVisibleButtons(); cgFollowChat(); }, 200);
    });
    setTimeout(injectAllVisibleButtons, 1500);

    /* Moves references saved by older versions out of the settings file. Deliberately
       after the UI is up and not awaited: it is a one-off housekeeping pass, and the
       panel must not wait on it. */
    migrateSprites()
        .then((moved) => { if (moved) renderCG(); })
        .catch((e) => console.warn('[Character Lens] reference migration failed', e));

    /* SillyTavern moved macro registration to a new registry and now warns loudly in
       the console about the old call. Both are used depending on what this build has,
       so the warning goes away on new versions without breaking older ones. */
    (() => {
        const fn = () => getProfile()?.text ?? '';
        try {
            const reg = getContext()?.macros?.registry ?? globalThis.macros?.registry;
            if (reg && typeof reg.registerMacro === 'function') { reg.registerMacro('charlens', fn); return; }
        } catch (e) { /* fall through to the old way */ }
        try { MacrosParser.registerMacro('charlens', fn); }
        catch (e) { console.warn('[Character Lens] macro not registered:', e); }
    })();

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lens',
        callback: async () => { await analyze(); return getProfile()?.text ?? ''; },
        helpString: 'Analyze the current character and store the interpretation layer.',
        returns: 'the interpretation text',
    }));

    console.log('[Character Lens] ready');
});
