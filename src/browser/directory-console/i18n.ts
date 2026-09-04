/**
 * Interface wording, in one language at a time.
 *
 * Every string the console shows goes through here. The catalogue holds only
 * *interface* words — action, column heading, empty state — never the name of
 * an entity or an attribute: those come from the schema, which is the
 * deployment's own vocabulary, and translating them here would put one
 * customer's words in the product.
 *
 * @module browser/directory-console/i18n
 */

export type Catalogue = Record<string, string>;

const en: Catalogue = {
  'app.title': 'Directory',
  'app.loading': 'Loading…',
  'app.error': 'Something went wrong',
  'app.retry': 'Retry',
  'app.close': 'Close',
  'app.cancel': 'Cancel',
  'app.save': 'Save',
  'app.create': 'Create',
  'app.edit': 'Edit',
  'app.delete': 'Delete',
  'app.confirm': 'Confirm',
  'app.back': 'Back',
  'app.language': 'Language',

  'nav.dashboard': 'Overview',

  'scope.title': 'You administer',
  'scope.none': 'You administer no branch',
  'scope.unrestricted': 'Unrestricted access',
  'scope.unavailable':
    'Your permissions could not be read ({error}) — read-only until they can',
  'scope.read': 'read',
  'scope.write': 'write',
  'scope.delete': 'delete',

  'dashboard.welcome': 'Signed in as {user}',
  'dashboard.entities': 'What you can manage',
  'dashboard.create': 'New {entity}',
  'dashboard.noCreate': 'Creation not allowed here',

  'list.open': 'Open',
  'list.listEverything': 'List everything (may be slow)',
  'list.search': 'Search',
  'list.searchIn': 'in',
  'list.searchAnywhere': 'Every field',
  'list.searchGuard': 'Type at least {count} characters to search',
  'list.empty': 'Nothing to show',
  'list.noMatch': 'No entry matches this search',
  'list.count': '{from}–{to} of {total}',
  'list.perPage': 'Per page',
  'list.previous': 'Previous',
  'list.next': 'Next',
  'list.selected': '{count} selected',
  'list.export': 'Export selection',
  'list.deleteSelected': 'Delete selection',
  'list.selectAll': 'Select all rows on this page',
  'list.selectRow': 'Select this row',

  'detail.attributes': 'Details',
  'detail.relations': 'Related entries',
  'detail.members': 'Attached entries',
  'detail.emptyRelations': 'No related entry',
  'detail.actions': 'Actions',
  'detail.notFound': 'This entry no longer exists',

  'form.required': 'Fields marked with * are required',
  'form.addValue': 'Press Enter to add a value',
  'form.removeValue': 'Remove this value',
  'form.none': '—',
  'form.choose': 'Choose…',
  'form.true': 'Yes',
  'form.false': 'No',

  'tree.title': 'Organizations',
  'tree.filter': 'Filter',
  'tree.empty': 'Select an organization',
  'tree.addChild': 'New organization here',

  'status.title': 'Account state',
  'status.change': 'Change state',
  'status.changed': 'State changed to {state}',
  'state.enabled': 'Enabled',
  'state.disabled': 'Disabled',
  'state.noAccess': 'No access',
  'state.toDelete': 'To be deleted',

  'password.title': 'Reset password',
  'password.generate': 'Generate a password',
  'password.choose': 'Set a password',
  'password.forceChange': 'Require a change at next sign-in',
  'password.generated':
    'New password: {password} — copy it now, it will not be shown again',
  'password.set': 'Password changed',

  'delete.confirm': 'Delete {name}? This cannot be undone.',
  'delete.confirmMany': 'Delete {count} entries? This cannot be undone.',
  'delete.done': 'Deleted',
  'delete.failed': '{name}: {error}',

  'save.done': 'Saved',
  'create.done': 'Created',
};

const fr: Catalogue = {
  'app.title': 'Annuaire',
  'app.loading': 'Chargement…',
  'app.error': 'Une erreur est survenue',
  'app.retry': 'Réessayer',
  'app.close': 'Fermer',
  'app.cancel': 'Annuler',
  'app.save': 'Enregistrer',
  'app.create': 'Créer',
  'app.edit': 'Modifier',
  'app.delete': 'Supprimer',
  'app.confirm': 'Confirmer',
  'app.back': 'Retour',
  'app.language': 'Langue',

  'nav.dashboard': 'Vue d’ensemble',

  'scope.title': 'Vous administrez',
  'scope.none': 'Vous n’administrez aucune branche',
  'scope.unrestricted': 'Accès sans restriction',
  'scope.unavailable':
    'Vos permissions n’ont pas pu être lues ({error}) — lecture seule tant qu’elles ne le sont pas',
  'scope.read': 'lecture',
  'scope.write': 'écriture',
  'scope.delete': 'suppression',

  'dashboard.welcome': 'Connecté en tant que {user}',
  'dashboard.entities': 'Ce que vous pouvez gérer',
  'dashboard.create': 'Créer : {entity}',
  'dashboard.noCreate': 'Création non autorisée ici',

  'list.open': 'Ouvrir',
  'list.listEverything': 'Tout lister (peut être long)',
  'list.search': 'Rechercher',
  'list.searchIn': 'dans',
  'list.searchAnywhere': 'Tous les champs',
  'list.searchGuard': 'Saisissez au moins {count} caractères pour rechercher',
  'list.empty': 'Rien à afficher',
  'list.noMatch': 'Aucune entrée ne correspond',
  'list.count': '{from}–{to} sur {total}',
  'list.perPage': 'Par page',
  'list.previous': 'Précédent',
  'list.next': 'Suivant',
  'list.selected': '{count} sélectionné(s)',
  'list.export': 'Exporter la sélection',
  'list.deleteSelected': 'Supprimer la sélection',
  'list.selectAll': 'Sélectionner toutes les lignes de la page',
  'list.selectRow': 'Sélectionner cette ligne',

  'detail.attributes': 'Fiche',
  'detail.relations': 'Entrées liées',
  'detail.members': 'Entrées rattachées',
  'detail.emptyRelations': 'Aucune entrée liée',
  'detail.actions': 'Actions',
  'detail.notFound': 'Cette entrée n’existe plus',

  'form.required': 'Les champs marqués d’une * sont obligatoires',
  'form.addValue': 'Appuyez sur Entrée pour ajouter une valeur',
  'form.removeValue': 'Retirer cette valeur',
  'form.none': '—',
  'form.choose': 'Choisir…',
  'form.true': 'Oui',
  'form.false': 'Non',

  'tree.title': 'Organisations',
  'tree.filter': 'Filtrer',
  'tree.empty': 'Sélectionnez une organisation',
  'tree.addChild': 'Nouvelle organisation ici',

  'status.title': 'État du compte',
  'status.change': 'Changer l’état',
  'status.changed': 'État passé à {state}',
  'state.enabled': 'Actif',
  'state.disabled': 'Désactivé',
  'state.noAccess': 'Sans accès',
  'state.toDelete': 'À supprimer',

  'password.title': 'Réinitialiser le mot de passe',
  'password.generate': 'Générer un mot de passe',
  'password.choose': 'Définir un mot de passe',
  'password.forceChange': 'Exiger un changement à la prochaine connexion',
  'password.generated':
    'Nouveau mot de passe : {password} — copiez-le maintenant, il ne sera plus affiché',
  'password.set': 'Mot de passe modifié',

  'delete.confirm': 'Supprimer {name} ? Cette action est irréversible.',
  'delete.confirmMany':
    'Supprimer {count} entrées ? Cette action est irréversible.',
  'delete.done': 'Supprimé',
  'delete.failed': '{name} : {error}',

  'save.done': 'Enregistré',
  'create.done': 'Créé',
};

const catalogues: Record<string, Catalogue> = { en, fr };

/** Languages the console ships with. */
export const availableLanguages = Object.keys(catalogues);

export class Translator {
  private catalogue: Catalogue;
  readonly language: string;

  /**
   * @param requested language tag, or undefined to follow the browser
   */
  constructor(requested?: string) {
    const wanted =
      requested ||
      (typeof navigator !== 'undefined' ? navigator.language : 'en') ||
      'en';
    const short = wanted.split('-')[0].toLowerCase();
    this.language = catalogues[short] ? short : 'en';
    this.catalogue = catalogues[this.language];
  }

  /**
   * Translate a key, substituting `{name}` placeholders.
   *
   * An unknown key returns itself rather than an empty string: a missing
   * translation should be visible, not invisible.
   *
   * @param key catalogue key
   * @param values placeholder values
   * @returns the translated string
   */
  t(key: string, values: Record<string, string | number> = {}): string {
    const template = this.catalogue[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match
    );
  }
}
