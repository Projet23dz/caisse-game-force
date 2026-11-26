# CashPro (cash-gameforce) — consignes pour Claude

- Projet : logiciel Windows de trésorerie multi-activités (Game Force, ETP). Réponses à l'utilisateur en arabe.
- Spécifications : `docs/ملاحظات-المالك-v1.md`. Référence API : `api/API.md`.
- Règles financières et permissions : dans PostgreSQL (`database/`), jamais seulement dans l'API ou l'interface.
- Avant chaque commit : base → `database/tests/test_rules.sql` (62/62), API → `npm test` dans `api/` (tsc sans erreur + tests verts).
- **Sauvegarde automatique demandée par le propriétaire :** à la fin de chaque session de travail, committer toutes les modifications et pousser sur `main` de ce dépôt (messages de commit clairs). Garder aussi le projet claude.ai « Projet Sofian » à jour.
- Interface : `client/` (TypeScript sans dépendance, compilée par `npm run build` dans `api/`), servie par l'API. Application Windows : `desktop/` (Electron), installateur construit par GitHub Actions (job `desktop`, tags `v*` → Release).
- Vérifier l'interface avec Playwright + Chrome (captures) avant de livrer.
- Ne jamais committer de secrets (`cashpro.env`, `.env`, mots de passe, dumps).
