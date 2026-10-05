# Does a hosted model do this better, and what does it cost?

Run outside the application on purpose: no SDKs, nothing imported from `public/`,
and nothing here is on the path a scan takes. It exists to answer the question
with numbers rather than opinion.

```bash
node experiments/ai-scan/run.mjs --task models  --provider gemini --env .env
node experiments/ai-scan/run.mjs --task corners --provider gemini --env .env \
  --image tmp/Scan.jpg --truth 619,1369 3164,1477 3595,4929 219,5152
node experiments/ai-scan/run.mjs --task clean   --provider gemini --env .env \
  --model gemini-2.5-flash-image --image tmp/Scan.jpg
node experiments/ai-scan/run.mjs --task qc      --provider gemini --env .env \
  --image tmp/Scan.jpg --against tmp/ai/Scan-gemini.png
```

Keys come from a `.env` the script is pointed at. It is git-ignored.

## What it found, on the workbook photograph

Ground truth is the four corners marked by hand with `public/corners.html`.

### Finding the corners

| | mean error | against the photo's diagonal |
|---|---|---|
| **this project: DocQuadNet + edge fitting** | **30 px** | **0.42 %** |
| Gemini 3 Flash | 273 px | 3.82 % |
| Mistral Pixtral 12B | 346 px | 4.85 % |
| GPT-5 mini | 638 px | 8.93 % |
| GPT-5 nano | 1 643 px | 23.0 % |
| Gemini Flash Lite | 2 319 px | 32.5 % |
| Gemini 3.1 Flash Lite | 2 611 px | 36.6 % |

About 0.055 cents a page for the cheap ones. The best hosted answer is nine
times worse than what already runs for nothing, and 273 px is a visibly wrong
crop. Gemini Flash Lite at least said `confident: false`; GPT-5 nano was
confidently 1 643 px out.

### Removing the shadow by generating a new image

| | cost a page | what came back |
|---|---|---|
| Gemini 2.5 Flash Image | ~3.9 cents | pseudo-French gibberish - "Imparfait de Indlicatiuf", "Mathémeiique", "piluwret de tnolvisont" - and **p.70 became p.79** |
| Gemini 3 Pro Image | ~13 cents | words correct, but the table drawn **twice, overlapping** |

Cheap models invent words; the expensive one kept the words and destroyed the
layout. Neither produced a usable document, because an image generator draws a
new page rather than cleaning the one it was given.

### The check that catches it

Reading both images back and comparing the words costs about **0.26 cents a
page** and caught both failures - the invented text and the duplicated table -
flagging the changed page number by name. If a generative step is ever used,
this gate is cheap and it works.

## What it means

Per page, the whole AI route is 4.2 cents at its cheapest and 13.3 cents at its
best, to produce output that then fails its own quality check. The arithmetic
in `public/clean.js` costs nothing and measures 30 px and a flat 252.

Where a hosted model would earn its place is reading, not geometry: OCR, naming
a document from its contents, pulling fields out of an invoice.
