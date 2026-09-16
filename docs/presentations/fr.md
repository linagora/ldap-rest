---
title: LDAP-Rest
sub_title: Gestionnaire d'annuaire léger avec architecture à plugins
---

# LDAP-Rest

## Gestionnaire d'annuaire léger avec architecture à plugins

![LDAP-Rest Logo](../linagora.png)

<!-- end_slide -->

# Qu'est-ce que LDAP-Rest ?

Un gestionnaire d'annuaire **léger** et **extensible** pour LDAP

## Caractéristiques principales

- 🔌 **Architecture à plugins** - Fonctionnalités modulaires et extensibles
- 🔄 **Cohérence LDAP automatique** - Plugins de cohérence des données
- 🌐 **API REST complète** - Gestion LDAP via HTTP
- 🎨 **Bibliothèques browser** - Composants UI prêts à l'emploi
- 🔐 **Authentification configurable** - Token, OIDC, LLNG, etc.
- ⚡ **Léger et rapide** - Empreinte mémoire minimale
- 📦 **TypeScript** - Typage strict et sécurité

<!-- end_slide -->

# Architecture

## Stack technique

```
┌─────────────────────────────────────┐
│         API REST (Express)          │
├─────────────────────────────────────┤
│      Système de Plugins             │
│  ┌──────────┬──────────┬─────────┐  │
│  │   Auth   │   LDAP   │  Twake  │  │
│  └──────────┴──────────┴─────────┘  │
├─────────────────────────────────────┤
│      Client LDAP (ldapts)           │
└─────────────────────────────────────┘
```

- **Runtime**: Node.js + TypeScript (ES Modules)
- **Build**: Rollup (dual config: server + browser)
- **Test**: Mocha + Chai
- **LDAP**: ldapts (client moderne)

<!-- end_slide -->

# Architecture des Plugins

## Système d'événements et hooks

```typescript
export default class MyPlugin extends DmPlugin {
  name = 'myPlugin';
  dependencies = { onChange: 'core/ldap/onChange' };

  hooks: Hooks = {
    onLdapChange: async (dn, changes) => {
      // Réagir aux changements LDAP
    },
    onBeforeResponse: async (req, res, data) => {
      // Modifier les réponses API
    },
  };
}
```

<!-- end_slide -->

# Plugins Disponibles

## Authentification

- **token** - Authentification Bearer Token
- **openidconnect** - OpenID Connect / OAuth2
- **llng** - LemonLDAP::NG SSO
- **crowdsec** - Protection contre les abus
- **rateLimit** - Limitation de débit
- **authzPerBranch** - Autorisation par branche LDAP
- **authzLinid1** - Autorisation LinID v1

<!-- end_slide -->

# Plugins Disponibles (suite)

## LDAP Core

- **onChange** - Détection et notification des changements
- **flatGeneric** - Gestion générique pilotée par schémas
- **groups** - Gestion des groupes LDAP
- **organization** - Hiérarchie organisationnelle
- **externalUsersInGroups** - Utilisateurs externes dans les groupes

## Intégrations

- **twake/james** - Synchronisation Apache James (mail)
- **twake/calendar** - Ressources et utilisateurs Twake Calendar

<!-- end_slide -->

# Plugin Apache James

## Plugin de cohérence LDAP ↔ Messagerie

[Apache James](https://james.apache.org/) est un serveur de messagerie open source (SMTP, IMAP, POP3)

### Fonctionnalités du plugin

- 📧 **Synchronisation automatique LDAP → James**
- 🔄 **Changement d'adresse mail** - Renommage compte + données
- 💾 **Gestion des quotas** - Mise à jour automatique
- 👥 **Listes de diffusion** - Groupes LDAP → Address Groups
- 📨 **Alias mail** - mailAlternateAddress → James aliases
- 🎯 **WebAdmin API** - Communication via REST

### 🔐 Garantie de cohérence

**Toute modification LDAP est automatiquement propagée à James**

- ✅ Pas de désynchronisation
- ✅ Pas d'intervention manuelle
- ✅ Cohérence temps réel

<!-- end_slide -->

# Plugin James - Scénarios de cohérence

## 1. Changement d'adresse mail

```
LDAP: mail = alice@example.com → alice.smith@example.com
  ↓ onChange détecte le changement
  ↓ Hook onLdapMailChange déclenché
  ↓
James WebAdmin: POST /users/alice@.../rename/alice.smith@...
  → Compte renommé
  → Boîte mail préservée (inbox, sent, folders)
  → Ancien alias créé automatiquement
  ✅ COHÉRENCE GARANTIE
```

## 2. Mise à jour de quota

```
LDAP: mailQuota = 1000000000 → 5000000000 (1GB → 5GB)
  ↓ onChange détecte le changement
  ↓ Hook onLdapQuotaChange déclenché
  ↓
James WebAdmin: PUT /quota/users/alice@.../size
  → Quota mis à jour immédiatement
  ✅ COHÉRENCE GARANTIE
```

<!-- end_slide -->

# Plugin James - Cohérence des listes

## Groupes LDAP → James Address Groups

```bash
# Création d'un groupe avec attribut mail
POST /api/v1/ldap/groups
{
  "cn": "engineering",
  "mail": "engineering@company.com",
  "member": ["uid=alice,...", "uid=bob,..."]
}
```

### Cohérence automatique des listes

1. ✅ **Création** → Groupe créé dans James + membres ajoutés
2. ✅ **Ajout membre** → Membre ajouté à la liste James
3. ✅ **Retrait membre** → Membre retiré de la liste James
4. ✅ **Suppression groupe** → Liste supprimée dans James

### Garantie

**LDAP est la source de vérité, James reste synchronisé**

<!-- end_slide -->

# Cohérence LDAP

## Plugins de cohérence automatique

LDAP-Rest maintient automatiquement la **cohérence** entre LDAP et les systèmes externes

### Mécanismes

1. **onChange** détecte tous les changements LDAP
2. Les plugins réagissent via hooks
3. Actions correctives automatiques
4. **Garantie de l'intégrité référentielle**

### Exemples - Cohérence LDAP

- **Suppression d'utilisateur** → Retrait automatique des groupes
- **Changement de DN** → Mise à jour des références
- **Utilisateurs externes** → Maintien dans les groupes

### Exemples - Cohérence LDAP ↔ James

- **Changement mail** → Renommage compte + alias James
- **Modification quotas** → Propagation immédiate
- **Gestion alias** → Synchronisation bidirectionnelle LDAP/James

<!-- end_slide -->

# API REST

## Endpoints principaux

```bash
# Organisations
GET    /api/v1/ldap/organizations/:dn
GET    /api/v1/ldap/organizations/:dn/subnodes
GET    /api/v1/ldap/organizations/:dn/subnodes/search

# Utilisateurs (flatGeneric)
GET    /api/v1/ldap/users
POST   /api/v1/ldap/users
GET    /api/v1/ldap/users/:dn
PUT    /api/v1/ldap/users/:dn
DELETE /api/v1/ldap/users/:dn

# Groupes
GET    /api/v1/ldap/groups
POST   /api/v1/ldap/groups
```

<!-- end_slide -->

# Schémas JSON

## Architecture pilotée par schémas

Les schémas définissent :

- Structure des objets LDAP
- Validation des données
- UI auto-générée (browser)
- Documentation automatique

```json
{
  "objectClass": "inetOrgPerson",
  "fields": {
    "uid": { "type": "string", "required": true },
    "mail": { "type": "string", "format": "email" },
    "displayName": { "type": "string" }
  }
}
```

<!-- end_slide -->

# Schémas Disponibles

## Standard LDAP

- **users** - Utilisateurs (inetOrgPerson)
- **groups** - Groupes (groupOfNames)
- **organizations** - Organisations (organizationalUnit)

## Active Directory

- **ad/users** - Utilisateurs AD
- **ad/groups** - Groupes AD

## Twake

- **twake/users** - Extensions Twake
- **twake/groups** - Groupes Twake
- **twake/positions** - Postes/Fonctions

<!-- end_slide -->

# Bibliothèques Browser

## Composants UI prêts à l'emploi

### LdapTreeViewer

Arbre interactif de navigation dans les organisations LDAP

### LdapUserEditor

Interface complète de gestion d'utilisateurs

- Arbre organisationnel
- Liste d'utilisateurs
- Formulaire d'édition

<!-- end_slide -->

# LdapTreeViewer

## Utilisation

```typescript
import LdapTreeViewer from 'ldap-rest/browser-ldap-tree-viewer-index';

const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  onNodeClick: node => {
    console.log('Sélection:', node.dn);
  },
});

await viewer.init();
```

<!-- end_slide -->

# LdapUserEditor

## Utilisation

```typescript
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';

const editor = new LdapUserEditor({
  containerId: 'editor-container',
  apiBaseUrl: 'http://localhost:8081',
  onUserSaved: userDn => {
    console.log('Utilisateur sauvegardé:', userDn);
  },
});

await editor.init();
```

<!-- end_slide -->

# Installation et Démarrage

## Installation

```bash
npm install ldap-rest
```

## Démarrage rapide

```bash
npx ldap-rest \
  --ldap-base 'dc=example,dc=com' \
  --ldap-dn 'cn=admin,dc=example,dc=com' \
  --ldap-pwd admin \
  --ldap-url ldap://localhost \
  --plugin core/ldap/groups \
  --plugin core/ldap/organization
```

<!-- end_slide -->

# Configuration

## Variables d'environnement

```bash
# Connexion LDAP
DM_LDAP_URL=ldap://localhost:389
DM_LDAP_DN=cn=admin,dc=example,dc=com
DM_LDAP_PWD=adminpassword
DM_LDAP_BASE=ou=users,dc=example,dc=com

# Serveur HTTP
DM_PORT=8081
DM_HOST=0.0.0.0

# Logging
DM_LOG_LEVEL=info  # debug, info, warn, error
```

<!-- end_slide -->

# Développement

## Commandes principales

```bash
# Développement
npm run build:dev        # Build dev rapide
npm run start:dev        # Démarrer serveur dev
npm run dev              # build + start

# Tests
npm test                 # Tous les tests
npm run test:one <file>  # Test unique

# Qualité
npm run check            # lint + format check
npm run fix              # lint + format fix
```

<!-- end_slide -->

# Build et Déploiement

## Build Production

```bash
npm run build:prod
# → Génère dist/, static/browser/, Dockerfile
```

## Docker

```bash
npm run build:docker     # Build image
docker run -p 8081:8081 ldap-rest
```

## Distribution

- Package NPM avec exports TypeScript
- Binaires CLI: `ldap-rest`, `sync-james`, `cleanup-external-users`
- Fichiers statiques prêts pour CDN

<!-- end_slide -->

# Cas d'Usage

## Scénarios d'utilisation

✅ **Annuaire d'entreprise**

- Gestion centralisée des utilisateurs
- **Synchronisation messagerie (Apache James)**
- Interface web de gestion
- **Cohérence automatique des données**

✅ **Plateforme collaborative (Twake)**

- Multi-tenant avec authzPerBranch
- **Mail, calendrier, listes de diffusion**
- Composants UI réutilisables
- **Intégrité référentielle garantie**

✅ **Service de provisioning**

- **Hooks pour synchronisation externe (James, etc.)**
- **Cohérence LDAP automatique**
- Audit des changements
- **Nettoyage automatique des incohérences**

<!-- end_slide -->

# Extensibilité

## Créer un plugin personnalisé

```typescript
import DmPlugin from 'ldap-rest/plugin-abstract';
import { Hooks } from 'ldap-rest/hooks';

export default class CustomPlugin extends DmPlugin {
  name = 'custom/myPlugin';

  hooks: Hooks = {
    onLdapChange: async (dn, changes) => {
      // Votre logique métier
      await this.syncToExternalSystem(dn, changes);
    },
  };

  routes() {
    return [
      {
        method: 'get',
        path: '/api/v1/custom/stats',
        handler: async (req, res) => {
          res.json({ stats: await this.getStats() });
        },
      },
    ];
  }
}
```

<!-- end_slide -->

# Sécurité

## Mécanismes de sécurité

- 🔐 **Authentification multi-méthodes** (Token, OIDC, LLNG)
- 🛡️ **Autorisation granulaire** (par branche, par utilisateur)
- 🚦 **Rate limiting** (protection DoS)
- 🔒 **CrowdSec** (détection d'intrusion)
- 📝 **Audit des changements** (via onChange)
- 🔑 **LDAP bind sécurisé** (TLS supporté)

<!-- end_slide -->

# Performance

## Optimisations

- ⚡ **Lazy loading** - Chargement à la demande
- 🎯 **Cache intelligent** - Réduction des requêtes LDAP
- 📦 **Bundle optimisé** - Tree-shaking, minification
- 🔄 **Connexions persistantes** - Pool LDAP
- 🎨 **Rendering efficace** - Virtual DOM (browser libs)

## Métriques typiques

- Démarrage: < 500ms
- Requête API: < 50ms
- Empreinte mémoire: ~50MB

<!-- end_slide -->

# Roadmap

## Fonctionnalités à venir

- 🔍 **Recherche avancée** - Filtres LDAP complexes
- 📊 **Dashboard admin** - Monitoring et statistiques
- 🌍 **i18n** - Internationalisation complète
- 🔔 **Webhooks** - Notifications externes
- 📱 **Mobile-first UI** - Responsive design amélioré
- 🧪 **Playground interactif** - Démo en ligne

<!-- end_slide -->

# Documentation

## Ressources disponibles

📚 **Guides**

- [Developer Guide](./DEVELOPER_GUIDE.md)
- [Browser Libraries](./browser/LIBRARIES.md)
- [REST API Reference](./api/REST_API.md)

🔌 **Plugins**

- [Plugin Development](./plugins/DEVELOPMENT.md)
- [Hooks Reference](HOOKS.md)

📦 **Schémas**

- [JSON Schemas Guide](./schemas/SCHEMAS.md)

<!-- end_slide -->

# Communauté

## Contribuer

- 🐛 **Issues**: https://github.com/linagora/ldap-rest/issues
- 💡 **Discussions**: GitHub Discussions
- 📖 **Wiki**: https://deepwiki.com/linagora/ldap-rest
- 🤝 **Contributions**: Voir [CONTRIBUTING.md](CONTRIBUTING.md)

## License

**AGPL-3.0** - Copyright 2025-present LINAGORA

Logiciel libre et open source

<!-- end_slide -->

# Exemples Concrets

## Intégration Twake + Apache James

```bash
# Configuration complète
npx ldap-rest \
  --plugin core/ldap/onChange \
  --plugin core/ldap/groups \
  --plugin twake/james \
  --james-webadmin-url http://james:8000 \
  --james-webadmin-token "admin-token" \
  --mail-attribute mail \
  --quota-attribute mailQuota \
  --alias-attribute mailAlternateAddress
```

### Flux de synchronisation

```
Changement LDAP → onChange → Hook → James WebAdmin API
                     ↓
                  Logging + Audit
```

## Plugins de cohérence - Exemples

```typescript
// 1. Cohérence des groupes LDAP
import groups from 'ldap-rest/plugin-ldap-groups';
dm.registerPlugin('groups', groups);

// Suppression utilisateur:
// → Retrait automatique de tous ses groupes
// → Mise à jour des attributs member/uniqueMember

// 2. Cohérence LDAP ↔ James
import james from 'ldap-rest/plugin-twake-james';
dm.registerPlugin('james', james);

// Changement mail LDAP:
// → Renommage compte James
// → Mise à jour alias
// → Propagation quota
// → Cohérence garantie sans intervention manuelle
```

<!-- end_slide -->

# Exemples Concrets (suite)

## Interface Web Custom

```typescript
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';

// Intégration dans votre app React/Vue/Angular
const editor = new LdapUserEditor({
  containerId: 'users',
  apiBaseUrl: process.env.API_URL,
  onUserSaved: dn => {
    analytics.track('user_updated', { dn });
    notifications.success('Utilisateur sauvegardé');
  },
  onError: err => {
    errorTracker.capture(err);
  },
});
```

<!-- end_slide -->

# Comparaison

## LDAP-Rest vs Alternatives

| Fonctionnalité       | LDAP-Rest | LDAP Account Manager | phpLDAPadmin |
| -------------------- | --------- | -------------------- | ------------ |
| TypeScript           | ✅        | ❌                   | ❌           |
| Architecture Plugins | ✅        | ⚠️                   | ❌           |
| API REST             | ✅        | ⚠️                   | ❌           |
| Browser Libraries    | ✅        | ❌                   | ❌           |
| Modern Stack         | ✅        | ⚠️                   | ❌           |
| Extensibilité        | ✅✅      | ⚠️                   | ⚠️           |
| Sync James           | ✅        | ❌                   | ❌           |
| Cohérence auto       | ✅        | ❌                   | ❌           |

<!-- end_slide -->

# Pourquoi LDAP-Rest ?

## Avantages clés

🎯 **Moderne**

- Stack JavaScript moderne
- TypeScript first
- ES Modules natifs

🔧 **Flexible**

- Plugins personnalisables
- Hooks extensibles
- Schémas configurables

🚀 **Productif**

- API REST complète
- Composants UI prêts
- Documentation riche

<!-- end_slide -->

# Questions & Démo

## Contact

- 📧 Email: yadd@debian.org
- 🐙 GitHub: https://github.com/linagora/ldap-rest
- 🏢 LINAGORA: https://linagora.com

## Démo Live

```bash
# Lancer la démo
git clone https://github.com/linagora/ldap-rest
cd ldap-rest
npm install
npm run dev
```

Ouvrez http://localhost:8081

<!-- end_slide -->

# Merci !

## LDAP-Rest - Gestionnaire d'annuaire léger

[![Powered by LINAGORA](../linagora.png)](https://linagora.com)

**GitHub**: https://github.com/linagora/ldap-rest

**License**: AGPL-3.0

---

_Questions ?_
