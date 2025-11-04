# Repository Guidelines

## Project Structure & Module Organization
- `backend/` héberge l’API Express (PayPal, billets, e-mails) et sert le frontend. Stocker toutes les variables dans `backend/.env` (non versionné).
- `backend/data/` conserve les tickets émis dans un JSON (`tickets.json`) avec hash + statut pour validation offline (fichier ignoré par Git).
- `public/` contient les pages statiques : `index.html`, `purchase.html` (SDK PayPal injecté dynamiquement) et la feuille `styles.css`.
- Le sélecteur de langue Google Translate est intégré dans `index.html` et `purchase.html`; adaptez-le si vous changez la navigation.
- `backend/.env.congig` ne contient plus de secrets : remplacez les valeurs `__REMPLIR_AVANT_DEPLOIEMENT__` avant de créer votre `.env` local ou vos variables Render.
- `public/admin/login.html` est un placeholder affichant les instructions de contact tant que l’authentification n’est pas implémentée.
- `emails/` regroupe les modèles HTML utilisés par Brevo – modifier uniquement les valeurs entre `{{...}}`.
- `scanner/` fournit `scanner.html`, pensé pour les contrôles mobiles hors caisse.

## Build, Test, and Development Commands
- `cd backend && npm install` : installer ou mettre à jour les dépendances.
- `cd backend && npm start` : lancer l’API + les fichiers statiques sur `PORT` (4000 par défaut).
- `curl http://localhost:4000/api/health` : vérifier la disponibilité et la configuration PayPal/Brevo.
- `curl http://localhost:4000/api/smtp-check` : s’assurer que le transport Brevo répond avant d’envoyer un vrai billet.
- `curl -X POST http://localhost:4000/api/test/generate-ticket -H "Content-Type: application/json" -d '{"name":"Test","email":"test@example.com","ticketType":"vip"}'` : générer un billet factice (sans paiement) et vérifier l’email + le stockage JSON (désactivable avec `ENABLE_TEST_TICKETS=false`).

## Coding Style & Naming Conventions
- CommonJS + indentation deux espaces dans `server.js`; factoriser dans de petites fonctions (`issueTicket`, `getPayPalAccessToken`, etc.).
- Variables d’environnement en MAJUSCULE_SNAKE_CASE (`PAYPAL_CLIENT_ID`, `CORS_ALLOWED_ORIGINS`). Nouvelles ressources statiques en kebab-case.
- Garder les vues en français, avec textes explicites et attributs ARIA pour les composants interactifs; les styles restent structurés (layout → modules → responsive).

## Testing Guidelines
- Parcours complet : configurer `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET` sandbox + `BREVO_API_KEY`/`FROM_EMAIL`, démarrer le serveur puis réaliser un achat via `http://localhost:4000/purchase.html`. Contrôler l’e-mail reçu et scanner le QR généré.
- API : tester la création d’ordre via
  ```bash
  curl -X POST http://localhost:4000/api/paypal/create-order \
    -H "Content-Type: application/json" \
    -d '{"name":"Test","email":"test@example.com","tickets":{"standard":2,"vip":1}}'
  ```
  Capturer ensuite l’`id` retourné avec `/api/paypal/capture-order` (après validation dans le dashboard sandbox). La réponse fournit la liste des `ticketIds` et le nombre d’e-mails effectivement envoyés.
- Valider le scanner avec un billet test : `curl -s http://localhost:4000/scanner/scanner.html` (vérifier le rendu) puis scanner le QR reçu, observer la réponse JSON (`BILLET_HASH_INVALID`, `BILLET_DEJA_UTILISE`, etc.).
- Pour une commande multi-billets, confirmer que la réponse `/api/paypal/capture-order` retourne bien la liste des `ticketIds`, que `backend/data/tickets.json` contient chaque hash, et que chaque e-mail individuel est reçu (un QR code par message).
## Commit & Pull Request Guidelines
- Commits impératifs et ciblés (`Implement Brevo mailer`). Rassembler backend + frontend dans la même PR pour chaque fonctionnalité.
- Dans la description : objectif, variables d’environnement à ajouter/mettre à jour (`PAYPAL_*`, `BREVO_API_KEY`, `FROM_EMAIL`, `CORS_ALLOWED_ORIGINS`, `ENABLE_TEST_TICKETS`), scénario de test manuel, captures responsives si l’UI évolue.
- Relier les tickets clients (Trello/Notion) pour garder la traçabilité.

## Security & Configuration Tips
- Ne jamais committer les secrets. `.env` doit inclure au minimum : `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `BREVO_API_KEY`, `FROM_EMAIL`, `JWT_SECRET`, `CORS_ALLOWED_ORIGINS=https://afaris-tickets.onrender.com`, `ENABLE_TEST_TICKETS=false` sur l’environnement de production.
- Ajouter d’autres origines séparées par des virgules si un domaine d’administration ou une préprod est prévu.
- Le QR reste signé côté serveur : tester régulièrement l’endpoint `/api/validate` depuis `scanner/scanner.html` et surveiller les journaux de validation lors des évènements.
