// The three providers, their cheapest vision models, and what they cost.
//
// Prices are per million tokens unless stated, taken from each provider's
// public pricing page in October 2026. They move; `node run.mjs --prices`
// prints what is being assumed so a figure is never quoted without its source.
//
// Everything here is raw HTTP on purpose - an experiment should not drag three
// SDKs into the project it is measuring.

export const PRICES = {
  // Vision in, text out. The cheapest model each provider offers that can
  // look at a photograph.
  'gemini-flash-lite':  { in: 0.30, out: 2.50, source: 'ai.google.dev/gemini-api/docs/pricing' },
  'gpt-5-nano':         { in: 0.05, out: 0.40, source: 'developers.openai.com/api/docs/pricing' },
  'gpt-4o-mini':        { in: 0.15, out: 0.60, source: 'developers.openai.com/api/docs/pricing' },
  // Mistral's page did not state a per-model vision price; the run reports
  // tokens and leaves the cost blank rather than inventing one.
  'pixtral-12b':        { in: null, out: null, source: 'not stated on mistral.ai/pricing' },
  'mistral-small':      { in: null, out: null, source: 'not stated on mistral.ai/pricing' },

  // Image in, image out. This is the expensive kind, and the kind that
  // rewrites documents.
  'gemini-flash-lite-image': { perImage: 0.0336, source: 'ai.google.dev, ~1K resolution' },
  'gemini-flash-image':      { perImage: 0.067,  source: 'ai.google.dev, ~1K resolution' },
  'gpt-image-1-mini':        { in: 2.00, imageOut: 8.00,  source: 'developers.openai.com' },
  'gpt-image-1':             { in: 5.00, imageOut: 40.00, source: 'developers.openai.com' },
};

export const PROVIDERS = {
  gemini: {
    key: 'GEMINI_API_KEY',
    vision: 'gemini-flash-lite-latest',
    priceKey: 'gemini-flash-lite',
    image: 'gemini-flash-lite-image-latest',
    imagePriceKey: 'gemini-flash-lite-image',
    async ask({ model, prompt, images, key, json }) {
      const parts = [{ text: prompt }];
      for (const image of images) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: json ? { responseMimeType: 'application/json' } : {},
          }),
        }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`);
      const candidate = body.candidates?.[0]?.content?.parts ?? [];
      return {
        text: candidate.map((p) => p.text).filter(Boolean).join(''),
        imageOut: candidate.find((p) => p.inline_data || p.inlineData)?.inline_data?.data
          ?? candidate.find((p) => p.inlineData)?.inlineData?.data ?? null,
        usage: {
          in: body.usageMetadata?.promptTokenCount ?? 0,
          out: body.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  },

  openai: {
    key: 'OPENAI_API_KEY',
    vision: 'gpt-5-nano',
    priceKey: 'gpt-5-nano',
    image: 'gpt-image-1-mini',
    imagePriceKey: 'gpt-image-1-mini',
    async ask({ model, prompt, images, key, json }) {
      const content = [{ type: 'input_text', text: prompt }];
      for (const image of images) {
        content.push({ type: 'input_image', image_url: `data:${image.mime};base64,${image.data}` });
      }
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          input: [{ role: 'user', content }],
          ...(json ? { text: { format: { type: 'json_object' } } } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`);
      const text = (body.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join('');
      return {
        text,
        imageOut: null,
        usage: { in: body.usage?.input_tokens ?? 0, out: body.usage?.output_tokens ?? 0 },
      };
    },
  },

  mistral: {
    key: 'MISTRAL_API_KEY',
    vision: 'pixtral-12b-latest',
    priceKey: 'pixtral-12b',
    image: null,                      // Mistral has no image-generation model
    imagePriceKey: null,
    async ask({ model, prompt, images, key, json }) {
      const content = [{ type: 'text', text: prompt }];
      for (const image of images) {
        content.push({ type: 'image_url', image_url: `data:${image.mime};base64,${image.data}` });
      }
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`);
      return {
        text: body.choices?.[0]?.message?.content ?? '',
        imageOut: null,
        usage: { in: body.usage?.prompt_tokens ?? 0, out: body.usage?.completion_tokens ?? 0 },
      };
    },
  },
};

export function costOf(priceKey, usage) {
  const price = PRICES[priceKey];
  if (!price || price.in === null || price.in === undefined) return null;
  return (usage.in / 1e6) * price.in + (usage.out / 1e6) * price.out;
}

export const money = (value) =>
  value === null ? 'not priced' : value < 0.01 ? `${(value * 100).toFixed(3)} cents` : `$${value.toFixed(4)}`;
