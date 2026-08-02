const MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const ORIGINS = new Set([
  "https://unstamp.onrender.com",
  "https://unstamp.cgcreations.pro",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8091",
  "http://127.0.0.1:8091"
]);

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://unstamp.onrender.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function restorationGuidance(prompt) {
  const fallback = "Match the visible surrounding background, texture, colors, lighting, and perspective. Add no new objects.";
  if (!prompt) return fallback;

  const removalTerms = /\b(remove|erase|delete|watermark|logo|text|letter|word|number|timestamp|date|signature|stamp)\b/i;
  if (!removalTerms.test(prompt)) return prompt;

  // Keep the user's description of the desired background without repeating
  // the watermark wording, which can cause an inpainting model to draw letters.
  const continuation = prompt.match(/\b(?:continue|rebuild|reconstruct|match)\b[\s\S]*/i)?.[0]
    .replace(/\b(?:do not|don't|without)\b[\s\S]*/i, "")
    .trim();
  return continuation || fallback;
}

function isDailyAiLimit(error) {
  const details = [
    error?.code,
    error?.status,
    error?.message,
    error?.cause?.code,
    error?.cause?.status,
    error?.cause?.message
  ].filter(Boolean).join(" ");
  return /\b3036\b|daily free allocation|10,?000 neurons|account limited/i.test(details);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json(request, {
        ok: true,
        service: "Unstamp AI",
        endpoint: "POST /inpaint",
        model: MODEL
      });
    }
    if (request.method !== "POST" || url.pathname !== "/inpaint") {
      return json(request, { error: "Not found." }, 404);
    }

    try {
      const form = await request.formData();
      const image = form.get("image");
      const mask = form.get("mask");
      const prompt = String(form.get("prompt") || "").trim();
      const backgroundGuidance = restorationGuidance(prompt);

      if (String(form.get("authorized") || "") !== "true") {
        return json(request, { error: "Confirm that you own the image or have permission to edit it." }, 403);
      }
      if (!(image instanceof File) || !(mask instanceof File)) {
        return json(request, { error: "Upload both an image and a same-size PNG mask." }, 400);
      }
      if (!image.type.startsWith("image/") || !mask.type.startsWith("image/")) {
        return json(request, { error: "Image and mask must be image files." }, 400);
      }
      if (image.size > 10485760 || mask.size > 10485760) {
        return json(request, { error: "Each file must be 10 MB or smaller." }, 413);
      }

      const result = await env.AI.run(MODEL, {
        prompt: `Seamless photorealistic continuation of the existing scene inside the selected area. ${backgroundGuidance} Preserve the scene structure.`,
        negative_prompt: "text, letters, words, numbers, typography, captions, watermark, logo, signature, symbols, signs, labels, artificial objects, people, faces, hands, blur, distortion, artifacts",
        image: [...new Uint8Array(await image.arrayBuffer())],
        mask: [...new Uint8Array(await mask.arrayBuffer())],
        num_steps: 20,
        strength: 0.9
      });

      return new Response(result, {
        headers: {
          ...cors(request),
          "Content-Type": "image/png",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      console.error(JSON.stringify({ name: error?.name, message: String(error?.message || error) }));
      if (isDailyAiLimit(error)) {
        return json(request, {
          error: "Unstamp's free AI allowance has been used for today. Please try again after Cloudflare's daily reset at 00:00 UTC (8:00 PM Eastern during daylight saving time; 7:00 PM otherwise)."
        }, 429);
      }
      return json(request, { error: "Image restoration failed. Please try again with a clear mask." }, 500);
    }
  }
};
