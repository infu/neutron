import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCertifiedAssetsCandidateBindingInput,
  certifiedAssetsCandidateBindingInputBytes,
  validateCertifiedAssetsCandidateBindingInput,
} from "./certified_assets_candidate_binding.ts";

const bindingPath = path.resolve(
  import.meta.dir,
  "../certified-assets-candidate-binding.json",
);
const generated =
  buildCertifiedAssetsCandidateBindingInput();
const generatedBytes =
  certifiedAssetsCandidateBindingInputBytes(generated);

if (process.argv.includes("--write")) {
  await writeFile(bindingPath, generatedBytes);
  console.log(
    "Wrote the generic Certified Assets candidate-binding input.",
  );
} else {
  const checkedBytes = await readFile(bindingPath);
  const checked = JSON.parse(checkedBytes.toString("utf8"));
  validateCertifiedAssetsCandidateBindingInput(checked);
  if (!Buffer.from(generatedBytes).equals(checkedBytes)) {
    throw new Error(
      "Certified Assets candidate-binding input is valid but not canonical",
    );
  }
  console.log(
    "Certified Assets candidate-binding input matches the current implementation.",
  );
}
