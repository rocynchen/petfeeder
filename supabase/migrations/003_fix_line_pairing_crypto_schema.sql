CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.create_line_pairing()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
hid uuid;
rawcode text;
BEGIN
SELECT household_id INTO hid
FROM household_members
WHERE user_id = auth.uid()
AND role IN ('founder', 'owner')
LIMIT 1;

IF hid IS NULL THEN
RAISE EXCEPTION 'Only household administrators can create a pairing code';
END IF;

rawcode := upper(substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 10));

INSERT INTO line_pairings(
household_id, code_hash, expires_at, created_by
)
VALUES(
hid,
encode(extensions.digest(rawcode, 'sha256'), 'hex'),
now() + interval '10 minutes',
auth.uid()
);

RETURN rawcode;
END;
$function$;
