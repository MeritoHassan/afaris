# AFARIS Tickets

Plateforme complète de billetterie pour l'événement Arido / AFARIS : landing marketing, tunnel d'achat PayPal, génération de billets QR et scanner d'administration sécurisé.

## Fonctionnalités clés
- **Front-end statique** (`public/`) : page d'accueil immersive (teaser vidéo, comparaison VIP), page d'achat responsive et accessibilité soignée.
- **Paiement PayPal** (`backend/server.js`) : création/capture d'ordre, gestion multi-billets (Standard + VIP), notifications visuelles en temps réel.
- **Billets QR + e-mail Brevo** : chaque billet est signé (JWT + hash) et envoyé via Brevo avec QR inline + pièce jointe PNG.
- **Stockage** Supabase (ou fallback JSON `backend/data/`) pour pérenniser l'état des billets et détecter les doublons.
- **Espace admin** (`admin/`) : login protégé, scanner QR en ligne/hors-ligne, export JSON des billets, file d'attente locale et resynchronisation automatique.
- **Intégrations** : Plausible analytics, Google Translate, cartes Google Maps intégrées pour les infos pratiques.

## Démarrage
```bash
cd backend
npm install
cp .env.congig .env  # puis remplir les secrets
npm start            # serveur sur http://localhost:4000
```

Variables essentielles (`.env` ou Render) : `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `BREVO_API_KEY`, `FROM_EMAIL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `ADMIN_PASSWORD`, `CORS_ALLOWED_ORIGINS`.

## Tests & vérifications
1. **Santé API** : `curl http://localhost:4000/api/health` et `curl /api/smtp-check`.
2. **Commande sandbox** : ouvrir `/purchase.html`, acheter 1 Standard + 1 VIP, confirmer dans le dashboard PayPal, vérifier les e-mails reçus.
3. **Scanner** : `/admin/login` → `/admin/scanner`. Tester un QR valide, invalide et déjà utilisé. Exporter la liste des billets puis activer le mode hors-ligne (couper le réseau, scanner, resynchroniser).

## Déploiement
- Backend déployé sur Render (Node.js). Ajouter les variables d’environnement dans l’onglet *Environment* avant chaque redeploy.
- DNS : `afaris.be` pointe sur Render (A 216.24.57.1 + CNAME www). Certificats gérés par Render.
- Emails : ajouter les enregistrements Brevo (SPF/DKIM/DMARC) dans la zone DNS pour sortir du dossier spam.

## Structure
```
backend/   API Express, PayPal, Billets, Supabase, Brevo
admin/     Login + scanner QR protégé, mode offline
public/    Pages statiques (index, purchase, assets)
emails/    Modèles HTML pour les tickets
```

## Support & contact
Pour toute question :  WhatsApp +32 493 92 55 77.

