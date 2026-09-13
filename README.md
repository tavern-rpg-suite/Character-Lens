# 🔍 Character Lens

<img width="1671" height="941" alt="a1a13f98-47fa-4719-bcf6-b8010b748ece" src="https://github.com/user-attachments/assets/7f60338a-dcc3-48ed-bdda-339ba6a191a9" />


A SillyTavern extension in two halves that share one thing: **a picture of who your character is.**

**Character Lens** reads a character card and writes a short *performance guide* — not a summary, but how this person should come across in a scene — and keeps it in the model's context while you play. This helps cold, analytical characters behave more naturally.

**🎨 Scene Art** draws the moment. Click the camera on any message and get a CG of what just happened, framed as a photograph clipped to the chat.

Both halves read the same per-character profile, so you describe someone **once**.



---

## 📦 Install

**Extensions → Install Extension →** paste this repository's URL.

Or drop the folder into:

```text
SillyTavern/public/scripts/extensions/third-party/Character-Lens
```

Then refresh.

---

## 🧠 The Analyzer

<img width="471" height="412" alt="Screenshot_13" src="https://github.com/user-attachments/assets/fcdef9fd-b42b-40fb-aa31-a1246b0ee41f" />


Card summaries make models **play a description**.
A performance guide makes them **play a person**.

The analyzer sends the card to a model of your choice and asks for **200–300 words of portrayal guidance**:

* 🚶 How they move
* 🗣️ How they speak
* 😏 What their humour is like
* 💬 How they behave in conversation
* 🤝 What changes as trust grows

The result is injected into context, and you can edit it by hand at any time. **It's a text box, not a black box.**

| Setting                         | What it does                                            |
| ------------------------------- | ------------------------------------------------------- |
| **Analyzer API**                | URL, key and model. Any OpenAI-compatible endpoint.     |
| **In group chats inject**       | The speaker only, or everyone present.                  |
| **Inject at / Depth / As role** | Where the guide sits in context.                        |
| **Rewrite**                     | Regenerate the guide. Your edits are kept until you do. |

---

## 🎨 Scene Art

<img width="469" height="362" alt="Screenshot_10" src="https://github.com/user-attachments/assets/847797e2-fc2e-4d3f-90e6-f05b2ed9c57f" />


Two backends. Pick one under **Image API → Request format**.

### ☁️ Cloud

| Format                           | For                                    |
| -------------------------------- | -------------------------------------- |
| `/images/generations`            | OpenAI, most proxies                   |
| `/chat/completions` + modalities | OpenRouter — Gemini, Grok image models |

Leave the URL and key empty to reuse the Analyzer's.

A prompt-writer model turns the scene into a prose image prompt, while a **CG preset** shapes its style:

**Otome · Eroge · Shoujo · Dark Romance**

The reference image, if you saved one, is sent with the request.

---

### 🖥️ Local — ComfyUI

Start ComfyUI with CORS allowed, or the browser will not be permitted to reach it:

```bash
python main.py --enable-cors-header http://127.0.0.1:8000
```

Use the address you open SillyTavern on. Avoid `*` — it lets any open tab talk to your server.

In the ComfyUI desktop app this lives under **Settings → Server-Config**.

Then put:

```text
http://127.0.0.1:8188
```

in **Image API URL** and choose **ComfyUI**.

### 🧩 How the prompt is built

Local anime checkpoints are trained on danbooru tags, not prose, so the prompt is assembled from four blocks. The model only writes two of them:

```text
{style},        ← your style preset
{char},         ← this character's identity tags
{description},  ← written per scene: expression
{pose}          ← written per scene: body, framing, setting
```

**Style presets:** Illustrious / anime CG · Watercolour · Soft shoujo · Dramatic · None

**Insert recommended** fills a negative prompt tuned for anime models.

---

## 🧪 Workflows

Keep a named list and let each character pick theirs — a LoRA graph for one, an IPAdapter graph for another.

Export yours from ComfyUI with:

**Workflow → Export (API)**

The editor format is rejected with a message saying so.

Placeholders are substituted into the parsed graph, so quotes and newlines in a prompt cannot break it:

| Placeholder                                | Becomes                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `%prompt%`                                 | The assembled scene prompt **(required)**                                |
| `%negative%`                               | The negative prompt                                                      |
| `%seed%`                                   | A fresh seed — without it every scene comes out identical                |
| `%image%`                                  | The reference image's filename, for a `LoadImage` node                   |
| `%lora%` `%lora_strength%`                 | This character's LoRA and its strength                                   |
| `%ipadapter_weight%`                       | This character's IPAdapter weight                                        |
| `%prompt_a%` `%prompt_b%` `%prompt_scene%` | The character, the partner, and what they share — for regional workflows |

### 🧰 Built-in Examples

Five starting points are one button each. Each reads your ComfyUI first and names a **real checkpoint**, so it runs on the first click:

* **Example: plain** — core nodes, nothing else.
* **Example: LoRA** — adds a `LoraLoader`. Both model *and* CLIP run through it, or the trigger word never fires.
* **Example: IPAdapter** — identity from a reference picture instead of a LoRA.
* **Example: hires (eyes)** — two passes with a latent upscale between them. The usual fix for mushy eyes.
* **Example: FaceDetailer** — crops the face, redraws it at full resolution, and pastes it back. Best result for eyes; needs two add-ons.
* **Example: two people** — regional conditioning with core nodes only. Each person is encoded separately and confined to one side of the canvas, with a shared low-strength branch for style and lighting.

For two-person scenes, this matters because a single flat prompt has no way to know whose hair is whose.

A hires second pass **without regional conditioning** can let the separated colours mix back together.

A character with no LoRA does not need a second workflow: the `LoraLoader` is spliced out of the request and everything downstream is rewired to the checkpoint. Only nodes carrying `%lora%` are touched, so a style LoRA you wired in by hand stays.

---

## 👤 Per-character Setup

Open the character block at the bottom of the panel.

It follows whoever spoke last; choosing someone by hand pins it until you switch chats.

### 🖼️ Reference Image

Upload one and it is resized to **640px** automatically.

**Draw from** decides whether the cloud gets the picture, the description, or both.

### 🏷️ Identity Tags

`{char}` is who this character *is*, written as tags:

```text
1girl, pink hair, long hair, blue eyes, pink tracksuit
```

For local models this is the anchor.

Prose will not do it: three paragraphs about pink hair still gives you *a* girl with pink hair, not **her**.

### 👁️ Tags from Reference

A vision model looks at the saved picture and writes the identity block for you.

This is the **single most useful button** if your character has no LoRA.

It uses the Analyzer endpoint, so set a model that can see images.

### 🎯 Identity Comes From

| Option              | Sends                        |
| ------------------- | ---------------------------- |
| **Whatever is set** | Tags + LoRA + reference      |
| **Character LoRA**  | Tags + LoRA                  |
| **Reference image** | Tags + reference (IPAdapter) |
| **Tags only**       | Tags                         |

### 🧬 LoRA

Picked from a list read straight out of ComfyUI, with strength, per character.

Put the trigger word in the identity tags or the LoRA loads and does nothing.

---

## 💞 You, the Partner

<img width="453" height="350" alt="Screenshot_14" src="https://github.com/user-attachments/assets/967ec783-c277-4f79-a969-f12b5b7817ad" />


A two-person moment needs a second person.

Without one, the model invents them — usually by copying the character standing next to them.

Fill in **You — the partner in the scene**:

* 🖼️ Reference picture
* 📝 Appearance notes
* 🏷️ Short tag block for local models

**Take from persona** copies SillyTavern's persona description.

**Tags from reference** reads the picture.

Keep partner tags short — **three to five**, contrasting with the main character.

Two people in one anime generation bleed into each other, and the longer the second description, the worse it gets.

Include `1boy` or `1girl` in each block. Each person's count tag is placed directly in front of their own tags:

```text
1boy, blonde hair ... 1girl, pink hair
```

rather than piling both counts at the front.

`solo` is removed, and when both are the same kind the word for the pair (`2boys`) is added once. Anime models need it to draw two figures instead of one with too many limbs.

> 💡 **Ordering is a hint, not ownership.**
> A flat prompt has no way to say whose hair is whose. For that, use the two-people workflow.

### 🧬 LoRA + Two People

A character LoRA applies to the **whole image**, not to one figure — it will pull both people toward the same face.

The two-people workflow narrows this as far as core nodes allow: only the character's own branch is encoded through the LoRA's CLIP, so their trigger word binds to their half.

The model side stays global, so lower `strength_model` to **0.6–0.8** for two-person scenes.

### 👥 Partner in Frame

**Auto** lets the prompt writer judge each moment:

* An embrace → two people
* Character alone at a window → stays alone

**Always** and **never** are manual overrides.

A `{partner}` placeholder in the template gives them their own block. Without one they join `{char}`, so existing templates keep working.

### 🎯 IPAdapter Weight

Around **0.6–0.7** is a good starting point.

At 1.0 the adapter drags the reference's pose and palette into every scene.

Crop the reference to **head and shoulders on a plain background**. IPAdapter embeds the whole picture, so a lantern and blue glow can travel with the face.

---

## 📥 Downloads for Local Extras

Neither set installs itself.

Both are checked before an example is inserted, and the missing piece is named.

### 🧩 IPAdapter — Identity from a Picture

**Node:** `ComfyUI_IPAdapter_plus`

Install through:

**Manager → Custom Nodes Manager → "IPAdapter plus"**

Restart ComfyUI **and** reload the browser tab afterwards.

Models, from **h94/IP-Adapter**:

| File                                          | Goes in                       |
| --------------------------------------------- | ----------------------------- |
| `ip-adapter-plus_sdxl_vit-h.safetensors`      | `ComfyUI/models/ipadapter/`   |
| `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | `ComfyUI/models/clip_vision/` |

Both encoders ship under the **same original filename**. Rename them and match the names above exactly.

The Unified Loader looks them up by name and will not find a near miss.

> ⚠️ **Skip the FaceID models.**
> They need InsightFace, whose face detector is trained on photographs and routinely fails on drawn faces.

### 👁️ FaceDetailer — Sharp Eyes

**Nodes:** `ComfyUI-Impact-Pack` + `ComfyUI-Impact-Subpack`

The detector provider lives in the Subpack, not the main one — this trips up most people.

**Model:** `bbox/face_yolov8m.pt`

Install through **Manager → Model Manager**. It lands in:

```text
ComfyUI/models/ultralytics/bbox/
```

FaceDetailer has ~30 required inputs and they have changed between releases, so the example is built against **your installed version** by reading the node's own schema.

---

## 💾 Storage

Drawn scenes and reference images live in **IndexedDB**.

Only short keys are kept in SillyTavern's settings, which are rewritten on every keystroke.

For ten characters with references:

**~1 MB → under 1 KB**

Migration is automatic and runs once.

Scenes are attached to the message they belong to and come back when that message is rendered again — after a chat switch, an edit, a swipe, or scrolling back up.

---

## 🛠️ When Something Looks Wrong

The exact graph sent to ComfyUI is logged on every render.

Open the console and look for:

```text
[Character Lens] ComfyUI graph sent
```

`counts` shows which placeholders were substituted, which answers most questions on its own.

| Symptom                                      | Usually                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| 🔄 Buttons missing after an update           | Cached JS. Hard-refresh, then restart the ST server.                  |
| 🎲 Every scene comes out identical           | No `%seed%` in the workflow.                                          |
| 🧬 LoRA has no effect                        | No `%lora%` in the workflow, or no trigger word in the identity tags. |
| 🌈 Everything tinted the reference's colour  | IPAdapter weight too high, or the reference is a full scene. Crop it. |
| 👁️ Eyes without detail                      | Face too small in frame. Portrait canvas, then hires or FaceDetailer. |
| 🧩 `"does not have IPAdapterUnifiedLoader…"` | The add-on is not installed — see Downloads.                          |


