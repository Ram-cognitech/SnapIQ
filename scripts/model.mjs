// Fetch the corner model: `npm run model`.
//
// DocQuadNet-256 from MakeACopy, Apache-2.0 (see NOTICE). Kept out of the
// repository because it is 13 MB of weights that never change.

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

const URL = 'https://raw.githubusercontent.com/egdels/makeacopy/main/app/src/main/assets/docquad/docquadnet256_trained_opset17.ort';
// Served to the phone, so it lives where the other assets do.
const PATH = 'public/models/docquadnet256.ort';

if (existsSync(PATH) && statSync(PATH).size > 1_000_000) {
  console.log(`${PATH} is already here (${(statSync(PATH).size / 1e6).toFixed(1)} MB)`);
  process.exit(0);
}
mkdirSync('public/models', { recursive: true });
console.log('fetching the corner model…');
const response = await fetch(URL);
if (!response.ok) {
  console.error(`could not fetch the model: ${response.status}`);
  process.exit(1);
}
writeFileSync(PATH, new Uint8Array(await response.arrayBuffer()));
console.log(`${PATH} (${(statSync(PATH).size / 1e6).toFixed(1)} MB)`);
