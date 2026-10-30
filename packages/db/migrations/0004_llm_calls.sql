-- One row per LLM call, used for cost tracking and evals.
-- Prompt text is never stored, only a hash of the rendered input.

CREATE TABLE llm_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  stage             text NOT NULL,
  prompt_id         text NOT NULL,
  prompt_version    integer NOT NULL CHECK (prompt_version > 0),
  model             text NOT NULL,
  status            text NOT NULL CHECK (status IN ('ok', 'error', 'refusal', 'truncated', 'invalid_output')),
  error_code        text,
  input_tokens      integer,
  output_tokens     integer,
  cache_read_tokens integer,
  latency_ms        integer NOT NULL,
  cost_usd          numeric(12, 6),
  input_hash        text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_tenant_time_idx ON llm_calls (tenant_id, created_at);

ALTER TABLE llm_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON llm_calls
  USING (tenant_id = mm_current_tenant())
  WITH CHECK (tenant_id = mm_current_tenant());

GRANT SELECT, INSERT ON llm_calls TO mm_app;
