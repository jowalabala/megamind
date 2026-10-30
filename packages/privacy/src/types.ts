export type DetectionCategory = "secret" | "pii";

/** A span to remove, in UTF-16 offsets of the text it was found in. */
export interface Detection {
  start: number;
  end: number;
  category: DetectionCategory;
  /** Short label, e.g. "github_token", "email", "person". */
  label: string;
  /** Text that replaces the span. Defaults to a placeholder built from the label. */
  replacement?: string;
}

export interface RedactionResult {
  text: string;
  /** How many spans were removed, keyed by "<category>:<label>". Never contains values. */
  counts: Record<string, number>;
}

/** A synchronous, deterministic detector (safe to run anywhere, including on a laptop). */
export interface Detector {
  name: string;
  detect(text: string): Detection[];
}

/** An external detector, such as AWS Comprehend. Runs after secrets are already removed. */
export interface AsyncDetector {
  name: string;
  detect(text: string): Promise<Detection[]>;
}
