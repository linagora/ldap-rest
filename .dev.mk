#!/usr/bin/make -f

PACKAGESRCFILES:=$(shell find packages/*/src -name '*.ts')
SRCFILES:=$(shell find src/*/ -name '*.ts' | grep -v browser/)
_SRCFILES:=$(shell find src/*/ -name '*.ts' | grep -v src/config/schema | grep -v browser/)
DSTFILES:=$(subst .ts,.js,$(subst src/,dist/,$(_SRCFILES)))
PLUGINFILES:=$(shell find dist/plugins -name '*.js' | grep -v auth/ | grep -v json.js | grep -v appAccount)
ALLPLUGINS:=$(subst dist/plugins/,--plugin core/,$(subst .js,,$(PLUGINFILES)))

LDAPFLATSCHEMAS := $(shell find packages/schemas/static/schemas/twake -name '*.json'|grep -v organization|grep -v groups|sed -e 's/^/--ldap-flat-schema /')

buildpackages:
	node scripts/packages.mjs build --stale

staticassets:
	node scripts/composeAssets.mjs

all: $(DSTFILES)

dist/%.js: src/%.ts
	echo $*
	$(MAKE) -f .dev.mk _builddev

build:
	npm run build:prod

builddev: buildpackages staticassets $(DSTFILES) Dockerfile

_builddev:
	npx rimraf dist
	node scripts/packages.mjs build
	node scripts/composeAssets.mjs
	npx rollup -c

builddocker: Dockerfile
	docker build -t ldap-rest .

Dockerfile: scripts/buildDockerfile.ts $(SRCFILES) $(PACKAGESRCFILES) bin rollup.config.mjs tsconfig.json static
	npx tsx scripts/buildDockerfile.ts

doc: $(SRCFILES)
	typedoc --entryPoints src/bin/index.ts $(shell find src -name '*.ts' | grep -v bin/index) --out docs

start: staticassets $(DSTFILES)
	node bin/index.mjs --log-level debug $(ALLPLUGINS) $(LDAPFLATSCHEMAS)

test: buildpackages staticassets $(DSTFILES)
	npm run test

.PHONY: builddev builddocker buildpackages test
