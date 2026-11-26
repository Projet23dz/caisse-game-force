#!/usr/bin/env bash
# Publie des fichiers dans la release "$TAG" : création si absente, sinon ajout (--clobber).
# Résiste aux erreurs passagères de GitHub (504) et publie une release restée en brouillon.
# usage : release-upload.sh TAG fichier...
set -u
TAG="$1"; shift
NOTES="Installateurs Windows CashPro $TAG — serveur : CashPro-Server-Setup (ou Paramètres > Mises à jour) ; postes : mise à jour automatique depuis le serveur."
ok=0
for i in 1 2 3 4 5; do
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$@" --clobber && { ok=1; break; }
  else
    gh release create "$TAG" "$@" --target "$GITHUB_SHA" --title "CashPro $TAG" --notes "$NOTES" && { ok=1; break; }
  fi
  echo "Nouvelle tentative ($i)…"; sleep $((i * 15))
done
[ "$ok" = 1 ] || { echo "Échec de la publication de $TAG"; exit 1; }
# une création interrompue (504) peut laisser un brouillon : on le publie (avec nouvelles tentatives)
for i in 1 2 3 4 5 6; do
  ID=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=30" --jq ".[] | select(.tag_name==\"$TAG\") | select(.draft) | .id" 2>/dev/null | head -1) || ID=""
  DRAFTS=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=30" --jq "[.[] | select(.tag_name==\"$TAG\")] | length" 2>/dev/null) || DRAFTS=""
  [ -n "$DRAFTS" ] && [ -z "$ID" ] && exit 0          # release trouvée et déjà publiée
  if [ -n "$ID" ] && gh api -X PATCH "repos/$GITHUB_REPOSITORY/releases/$ID" -F draft=false >/dev/null 2>&1; then
    echo "Brouillon $TAG publié"; exit 0
  fi
  echo "Publication du brouillon : nouvelle tentative ($i)…"; sleep $((i * 15))
done
echo "Avertissement : la release $TAG est peut-être restée en brouillon"; exit 0
