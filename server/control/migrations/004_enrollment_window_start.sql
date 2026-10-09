BEGIN;
-- Preserve counters from tracked installations using the quoted legacy column.
-- Fresh installations already use window_start. Ambiguous schemas are refused.
DO $$
DECLARE
  has_legacy boolean;
  has_current boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'control_enrollment_limits'::regclass AND attname = 'window' AND NOT attisdropped),
         EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'control_enrollment_limits'::regclass AND attname = 'window_start' AND NOT attisdropped)
    INTO has_legacy, has_current;
  IF has_legacy AND has_current THEN
    RAISE EXCEPTION USING ERRCODE = '42701', MESSAGE = 'Enrollment window schema is ambiguous';
  ELSIF has_legacy THEN
    ALTER TABLE control_enrollment_limits RENAME COLUMN "window" TO window_start;
  ELSIF NOT has_current THEN
    RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = 'Enrollment window column is missing';
  END IF;
END;
$$;
COMMIT;
