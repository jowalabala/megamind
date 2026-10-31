// PII and secret redaction, shared by the server pipeline and the local bridge.
// Layers: secret rules -> PII rules -> tenant directory pseudonyms -> optional Comprehend.
export { createDirectoryDetector, pseudonym, type DirectoryEntry } from "./directory.ts";
export { piiDetector } from "./pii.ts";
export { detectInjection } from "./injection.ts";
export {
  applyDetections,
  createRedactor,
  mergeCounts,
  type Redactor,
  type RedactorOptions,
} from "./redact.ts";
export { looksLikeSecret, secretDetector } from "./secrets.ts";
export type {
  AsyncDetector,
  Detection,
  DetectionCategory,
  Detector,
  RedactionResult,
} from "./types.ts";
