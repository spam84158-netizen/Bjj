# Mise en ligne réelle de DEVBOX

## Ce que fait déjà le code
Un seul serveur Node sert l'application ET les sites déployés : il lit l'en-tête `Host`, trouve `<slug>.ROOT_DOMAIN`
et sert la version LIVE du projet depuis `DATA_DIR/sites/<slug>/v<N>/`. Pipeline réel : QUEUED, BUILDING (écriture
des fichiers), TESTING (index.html non vide, fichiers référencés présents), DEPLOYING (bascule atomique), LIVE ou FAILED
avec l'erreur exacte. Les versions précédentes restent sur disque : retour arrière, arrêt (410) et logs sont réels.
Droits, quotas Premium, XP, badges et classement sont vérifiés et stockés côté serveur (SQLite).

## Ce qu'il faut configurer vous-même (je ne peux pas le faire d'ici)
1. **Serveur** avec IP publique et Docker (ou Node >= 22.13), disque persistant monté sur `/data`.
2. **DNS** chez votre registrar : `A yureixsiryx.dev -> IP` et `A *.yureixsiryx.dev -> IP` (le wildcard est indispensable).
3. **HTTPS wildcard** : exige un challenge DNS-01. Utilisez le `Caddyfile` fourni (Caddy + module DNS de votre registrar).
4. Variables : copiez `.env.example`, renseignez `OWNER_EMAIL` puis créez votre compte avec cet email : il devient OWNER.
5. **Google (optionnel)** : créez un ID client OAuth Web, autorisez votre domaine, mettez-le dans `GOOGLE_CLIENT_ID`.

Hébergeurs : Render, Railway ou Pterodactyl conviennent pour l'application, mais les sous-domaines dynamiques
demandent un domaine wildcard chez l'hébergeur (à vérifier) ou le proxy ci-dessus. Sans wildcard, le repli
`https://app/s/<slug>/` fonctionne, sans être un lien propre.

## Limites actuelles, sans simulation
- Sites statiques texte uniquement (html, css, js, json, svg, txt, md, xml). Pas de build npm ni de conteneur par projet,
  pas d'upload binaire (images) : à ajouter avant d'ouvrir à des inconnus.
- Pas de vérification SMS du téléphone (il faut un fournisseur SMS).
- Pas de paiement : `/api/billing/checkout` répond 501. Premium s'accorde depuis l'onglet Admin.
- Pas encore : domaines personnalisés, équipes, signalements, analytics, e-mails.
- SQLite sur un seul serveur : suffisant pour démarrer, à migrer vers PostgreSQL pour plusieurs instances.

## Connexion Google (à faire une fois)
1. console.cloud.google.com > APIs et services > Identifiants > Créer des identifiants > ID client OAuth > Application Web.
2. Origines JavaScript autorisées : l'adresse exacte de DEVBOX (ex. `https://app.yureixsiryx.dev`). Pas de localhost en production.
3. Copiez l'ID client dans la variable `GOOGLE_CLIENT_ID` du serveur, puis redémarrez.
4. Ouvrez DEVBOX dans **Chrome via son adresse https** : Google bloque la connexion dans les WebView, les aperçus d'éditeur et les fichiers ouverts en `file://`.
Le serveur vérifie lui-même le jeton auprès de Google (audience, e-mail vérifié) avant de créer la session.
