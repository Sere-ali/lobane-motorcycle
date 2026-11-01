# Lobane Motorcycle – site marketplace

Site de vente de motos avec plusieurs boutiques :
- **Public** : accueil, catalogue (recherche, filtres type / boutique / prix, pagination), fiche moto, boutons Appeler et WhatsApp, formulaire de demande.
- **Admin boutique** (`/admin`) : ajouter, modifier, supprimer ses motos (photo, prix, statut), voir les demandes reçues, modifier son profil.
- **Super admin** (`/super`) : voit toutes les boutiques, motos et demandes ; crée, suspend, réactive, supprime les comptes boutique ; modifie ou supprime n'importe quelle moto.

## Design
- Couleurs et typographie tirées du logo (vert vif, noir italique très gras, filets rouges). Polices : Barlow et Barlow Condensed (Google Fonts, chargées en ligne).
- Responsive (téléphone, tablette, ordinateur), menu mobile, tableaux d'administration transformés en cartes sur téléphone, mode sombre automatique.
- Animations : entrée du héros, apparition au défilement, compteurs, bandeau défilant, survols. Elles sont désactivées automatiquement pour les visiteurs qui l'ont demandé dans leur système (`prefers-reduced-motion`).
- Fichiers : `public/style.css` (styles), `public/app.js` (menu et animations), `public/img/` (logo et photo de démonstration).

## Lancer en local
Node.js 22.13 ou plus récent requis.

    npm install
    npm start        # http://localhost:3000

Au premier démarrage, le compte super admin et deux boutiques de démonstration sont créés :

| Rôle | E-mail | Mot de passe |
|---|---|---|
| Super admin | superadmin@lobane.ci | Lobane@2026 |
| Boutique (démo) | boutique1@lobane.ci | Boutique@2026 |
| Boutique (démo) | boutique2@lobane.ci | Boutique@2026 |

**À changer avant la mise en ligne** (Mon profil > nouveau mot de passe), ou définir avant le premier lancement :
`SUPER_EMAIL`, `SUPER_PASSWORD`, et `NO_DEMO=1` pour ne pas créer les boutiques de démonstration.

## Variables d'environnement
| Variable | Rôle |
|---|---|
| `PORT` | Port du serveur (fourni par Render ; 3000 en local) |
| `DATA_DIR` | Dossier de la base SQLite, des photos et du secret de session (`./data` par défaut). **Doit être sur un disque persistant en production.** |
| `SESSION_SECRET` | Secret de signature des sessions (généré par Render) |
| `NODE_ENV=production` | Cookies sécurisés (HTTPS), en-tête HSTS |
| `SUPER_EMAIL`, `SUPER_PASSWORD` | Compte super admin créé au tout premier démarrage (sans `SUPER_PASSWORD` en production, un mot de passe aléatoire est écrit une fois dans les logs) |
| `NO_DEMO=1` | Ne crée pas les boutiques et motos de démonstration |

## Mise en ligne sur Render
1. Créer un dépôt GitHub (privé) et y envoyer le contenu de ce dossier (sans `node_modules` ni `data`, déjà exclus par `.gitignore`).
2. Sur Render : **New > Blueprint**, choisir le dépôt. Render lit `render.yaml`, crée le service web (Frankfurt) et son disque de 1 Go monté sur `/var/data`.
3. Renseigner `SUPER_EMAIL` et `SUPER_PASSWORD` quand Render les demande, puis lancer le déploiement.
4. Ouvrir l'adresse `https://lobane-motorcycle.onrender.com` (ou le nom attribué), se connecter sur `/connexion`, créer les boutiques depuis `/super`.
5. Nom de domaine : Render > service > Settings > Custom Domains, puis créer l'enregistrement DNS indiqué. Le HTTPS est automatique.

À savoir :
- **Le disque persistant impose un plan payant** (`0.5c-512mb`) et une seule instance. L'offre gratuite efface la base et les photos à chaque redémarrage et met le site en veille après 15 minutes : à ne pas utiliser pour le vrai site.
- Render fait des sauvegardes automatiques du disque ; pour une copie à soi, télécharger `lobane.db` et le dossier `uploads` depuis le disque (SSH Render ou Shell du service).
- Les photos envoyées sont automatiquement redimensionnées (1400 px max) et converties en WebP pour un chargement rapide sur mobile.
- Santé du service : `GET /healthz` répond `ok`.

## Sécurité et exploitation (v2)

- En-têtes : CSP stricte (aucun script en ligne), HSTS, X-Frame-Options, Permissions-Policy ; pages `/admin`, `/super`, `/connexion` jamais mises en cache.
- Sessions : changer son mot de passe déconnecte les autres appareils ; réponse de connexion à temps constant.
- Sauvegarde : copie quotidienne de la base dans `DATA_DIR/backups` (7 jours conservés) et bouton « Sauvegarde » dans l'espace super admin (téléchargement du fichier `.db`).
- Le tableau de bord super admin affiche un avertissement tant que le disque permanent Render n'est pas branché sur `/var/data`.
- Journal des requêtes dans les logs Render ; `/healthz` pour la surveillance.
