# DEVBOX
Plateforme de déploiement et d'apprentissage. Node >= 22.13, aucune dépendance.

    cp .env.example .env && export $(grep -v '^#' .env | sed 's/ #.*//' | xargs)
    node server.mjs

Local : `ROOT_DOMAIN=localhost PUBLIC_SUFFIX=localhost:8080 PUBLIC_SCHEME=http node server.mjs`
(les sous-domaines `*.localhost` se résolvent dans Chrome/Firefox, mais ces liens ne sont pas publics).
Infrastructure, DNS, limites : `docs/INFRA.md`. Mobile : PWA (installable depuis le navigateur, Android et iOS)
et projet Capacitor dans `mobile/` + workflow `.github/workflows/mobile.yml` pour compiler l'APK.
