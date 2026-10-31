// Phrasing aimed at an AI agent rather than at people: "ignore previous instructions", "you are
// now", fake system or tool tags. Anything agents will read from others (channel messages,
// skills) is checked for it. A heuristic, not a guarantee: content from others is still
// presented to agents as untrusted data.
const PATTERNS = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|rules|prompts?|guidelines)\b/i,
  /\byou are now\b/i,
  /\b(system|developer) (prompt|message|instructions?)\b/i,
  /<\/?(untrusted_input|system|assistant|user|tool_call|function_call)\b/i,
  /\b(new|updated|real) instructions\b/i,
  /\bdo not (tell|inform|alert|show) the (user|human|reviewer|operator)\b/i,
  /\b(exfiltrate|send (the|all|your) (secrets?|keys?|tokens?|credentials))\b/i,
];

/** The matching fragments, or an empty list. */
export function detectInjection(text: string): string[] {
  const found: string[] = [];
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) found.push(m[0]);
  }
  return found;
}
