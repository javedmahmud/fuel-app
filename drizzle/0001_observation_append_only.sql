-- fuel_price_observation is append-only: no UPDATE, no DELETE, ever, from application code.
-- 06_DATA_ARCHITECTURE.md §6.1: "Nothing derived is stored as truth... corrections are new
-- rows." The repository layer is expected to expose no mutation method for this table, but
-- that convention is only as strong as everyone remembering it — this trigger is the actual
-- enforcement, so a bug or a one-off manual query can't silently violate the invariant the
-- whole schema is built around (immutable raw observations, rebuildable derived tables).
CREATE OR REPLACE FUNCTION fuel_price_observation_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'fuel_price_observation is append-only (06_DATA_ARCHITECTURE.md §6.1) — % is not permitted. '
    'A restated price is a new row with a later retrieved_at, never an edit.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fuel_price_observation_no_update
  BEFORE UPDATE ON fuel_price_observation
  FOR EACH ROW
  EXECUTE FUNCTION fuel_price_observation_append_only();

CREATE TRIGGER fuel_price_observation_no_delete
  BEFORE DELETE ON fuel_price_observation
  FOR EACH ROW
  EXECUTE FUNCTION fuel_price_observation_append_only();
