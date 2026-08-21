-- 0028_chart_annotations.sql：图表水平线、趋势线和文字标注。

CREATE TABLE chart_annotation (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  primary_instrument_id bigint NOT NULL REFERENCES market_instrument(id) ON DELETE CASCADE,
  view_type             text NOT NULL CHECK (view_type IN ('realtime','day','30m','futures_day')),
  coordinate_unit       text NOT NULL CHECK (coordinate_unit IN ('pct','price')),
  adjustment            text,
  context_json          jsonb NOT NULL CHECK (jsonb_typeof(context_json) = 'object'),
  context_sha256        text NOT NULL,
  annotation_type       text NOT NULL CHECK (annotation_type IN ('horizontal','trend','text')),
  anchors               jsonb NOT NULL CHECK (jsonb_typeof(anchors) = 'array'),
  text                  text CHECK (text IS NULL OR length(text) <= 500),
  style                 jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(style) = 'object'),
  version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chart_annotation_context
  ON chart_annotation (primary_instrument_id, view_type, context_sha256, id)
  WHERE deleted_at IS NULL;
