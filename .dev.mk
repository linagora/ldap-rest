#!/usr/bin/make -f

SRCBROWSER:=$(shell find src/browser -name '*.ts')
CORESRCFILES:=$(shell find packages/core/src -name '*.ts')
STORAGESRCFILES:=$(shell find packages/storage/src -name '*.ts')
DSTBROWSER:=$(subst .ts,.js,$(subst src/,static/,$(SRCBROWSER)))
SRCFILES:=$(shell find src/*/ -name '*.ts' | grep -v browser/)
_SRCFILES:=$(shell find src/*/ -name '*.ts' | grep -v src/config/schema | grep -v browser/)
DSTFILES:=$(subst .ts,.js,$(subst src/,dist/,$(_SRCFILES)))
PLUGINFILES:=$(shell find dist/plugins -name '*.js' | grep -v auth/ | grep -v json.js | grep -v appAccount)
ALLPLUGINS:=$(subst dist/plugins/,--plugin core/,$(subst .js,,$(PLUGINFILES)))
CORE_DIST:=packages/core/dist/index.js
STORAGE_DIST:=packages/storage/dist/storage.js

LDAPFLATSCHEMAS := $(shell find static/schemas/twake -name '*.json'|grep -v organization|grep -v groups|sed -e 's/^/--ldap-flat-schema /')

$(CORE_DIST): $(CORESRCFILES) packages/core/rollup.config.mjs packages/core/tsconfig.json
	cd packages/core && npx rollup -c

$(STORAGE_DIST): $(STORAGESRCFILES) packages/storage/rollup.config.mjs packages/storage/tsconfig.json
	cd packages/storage && npx rollup -c

all: $(DSTFILES)

dist/%.js: src/%.ts
	echo $*
	$(MAKE) -f .dev.mk _builddev

build:
	npm run build:prod

builddev: $(CORE_DIST) $(STORAGE_DIST) $(DSTFILES) $(DSTBROWSER) Dockerfile

_builddev:
	npx rimraf dist
	cd packages/core && npx rollup -c
	cd packages/storage && npx rollup -c
	npx rollup -c
	npx rollup -c rollup.browser.config.mjs
	node scripts/moveBrowserLibs.mjs

builddocker: Dockerfile
	docker build -t ldap-rest .

Dockerfile: scripts/buildDockerfile.ts $(SRCFILES) $(CORESRCFILES) $(STORAGESRCFILES) bin rollup.config.mjs tsconfig.json static
	npx tsx scripts/buildDockerfile.ts

doc: $(SRCFILES)
	typedoc --entryPoints src/bin/index.ts $(shell find src -name '*.ts' | grep -v bin/index) --out docs

start: $(DSTFILES)
	node bin/index.mjs --log-level debug $(ALLPLUGINS) $(LDAPFLATSCHEMAS)

test: $(CORE_DIST) $(STORAGE_DIST) $(DSTFILES)
	npm run test

.PHONY: builddev,builddocker,test
