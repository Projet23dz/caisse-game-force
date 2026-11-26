-- =====================================================================
-- CashPro 1.3.6 — 11_offline.sql  (rejouable : exécuté à chaque installation / mise à jour)
--  Mode hors connexion (العمل دون اتصال) : un poste (téléphone, PC employé) qui ne joint plus le serveur
--  garde les opérations saisies dans une file locale et les renvoie au retour de la connexion.
--  Chaque envoi porte une clé unique (Idempotency-Key, générée sur l'appareil au moment de la saisie) :
--  un même envoi répété (coupure pendant la réponse, double appui…) n'enregistre l'opération qu'UNE fois ;
--  le renvoi reçoit la réponse du premier enregistrement.
--  La clé est réservée dans la MÊME transaction SQL que l'opération : si l'opération échoue, rien n'est gardé.
-- =====================================================================
SET search_path = cashpro, public;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  endpoint    text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 100),
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_keys_own ON idempotency_keys;
CREATE POLICY idempotency_keys_own ON idempotency_keys FOR SELECT USING (user_id = current_uid());
-- écriture uniquement par les fonctions ci-dessous (SECURITY DEFINER)

-- Réserve la clé pour l'utilisateur courant.
--   NULL      → clé nouvelle : exécuter l'opération puis appeler idem_finish
--   jsonb     → opération déjà enregistrée avec cette clé : renvoyer cette réponse sans rien refaire
-- Deux envois simultanés de la même clé : le second attend la fin du premier (clé primaire).
CREATE OR REPLACE FUNCTION idem_begin(p_key uuid, p_endpoint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE r idempotency_keys;
BEGIN
  IF current_uid() IS NULL THEN
    RAISE EXCEPTION 'CP001: utilisateur non identifié' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'CP105: clé d''envoi manquante' USING ERRCODE = 'check_violation';
  END IF;
  -- ménage : clés de plus de 120 jours (une file hors connexion ne reste jamais aussi longtemps)
  IF random() < 0.02 THEN
    DELETE FROM idempotency_keys WHERE created_at < now() - interval '120 days';
  END IF;
  INSERT INTO idempotency_keys (key, user_id, endpoint) VALUES (p_key, current_uid(), p_endpoint)
  ON CONFLICT (key) DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM idempotency_keys WHERE key = p_key;
  IF r.user_id IS DISTINCT FROM current_uid() OR r.endpoint IS DISTINCT FROM p_endpoint OR r.response IS NULL THEN
    RAISE EXCEPTION 'CP105: clé d''envoi déjà utilisée pour une autre opération' USING ERRCODE = 'check_violation';
  END IF;
  RETURN r.response;
END $$;

CREATE OR REPLACE FUNCTION idem_finish(p_key uuid, p_response jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
BEGIN
  UPDATE idempotency_keys SET response = coalesce(p_response, 'null'::jsonb)
  WHERE key = p_key AND user_id = current_uid() AND response IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CP105: clé d''envoi inconnue' USING ERRCODE = 'check_violation';
  END IF;
END $$;

GRANT SELECT ON idempotency_keys TO cashpro_app, cashpro_backup;
REVOKE EXECUTE ON FUNCTION idem_begin(uuid, text), idem_finish(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION idem_begin(uuid, text), idem_finish(uuid, jsonb) TO cashpro_app;
