/**
 * LDAP attributes holding credential material, lower-cased. A password hash
 * handed over HTTP is an offline cracking target, so the APIs that expose
 * entries keep these out by default. Covers OpenLDAP, Samba, Kerberos and AD
 * spellings.
 */
export const SECRET_ATTRIBUTES: readonly string[] = [
  'userpassword',
  'pwdhistory',
  'sambantpassword',
  'sambalmpassword',
  'sambapasswordhistory',
  'krbprincipalkey',
  'krbextradata',
  'krbpwdhistory',
  'unicodepwd',
  'dbcspwd',
  'lmpwdhistory',
  'ntpwdhistory',
  'supplementalcredentials',
  'userpkcs12',
  'authpassword',
  // AD local administrator (LAPS) and managed service account passwords
  'ms-mcs-admpwd',
  'mslaps-password',
  'mslaps-encryptedpassword',
  'mslaps-encrypteddsrmpassword',
  'msds-managedpassword',
];
