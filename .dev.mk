#!/usr/bin/make -f

PACKAGESRCFILES:=$(shell find packages/*/src -name '*.ts')
UMBRELLASRCFILES:=$(shell find packages/ldap-rest/src -name '*.ts')

LDAPFLATSCHEMAS := $(shell find packages/schemas/static/schemas/twake -name '*.json'|grep -v organization|grep -v groups|sed -e 's/^/--ldap-flat-schema /')

buildpackages:
	node scripts/packages.mjs build --stale

staticassets:
	node scripts/composeAssets.mjs

build:
	npm run build:prod

builddev: buildpackages staticassets Dockerfile

builddocker: Dockerfile
	docker build -t ldap-rest .

Dockerfile: scripts/buildDockerfile.ts $(UMBRELLASRCFILES) $(PACKAGESRCFILES) packages/ldap-rest/bin packages/ldap-rest/package.json tsconfig.json
	npx tsx scripts/buildDockerfile.ts

doc: $(UMBRELLASRCFILES)
	typedoc --entryPoints packages/ldap-rest/src/bin/index.ts $(shell find packages/ldap-rest/src -name '*.ts' | grep -v bin/index) --out docs

start: staticassets
	node packages/ldap-rest/bin/index.mjs --log-level debug $(LDAPFLATSCHEMAS)

test: buildpackages staticassets
	npm run test

.PHONY: builddev builddocker buildpackages test
