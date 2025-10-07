#!/usr/bin/make -f

SRCBROWSER:=$(shell find src/browser -name '*.ts')
DSTBROWSER:=$(subst .ts,.js,$(subst src/,dist/,$(SRCBROWSER)))
SRCFILES:=$(shell find src/*/ -name '*.ts' | grep -v browser/)
_SRCFILES:=$(shell find src/*/ -name '*.ts' | grep -v src/config/schema | grep -v browser/)
DSTFILES:=$(subst .ts,.js,$(subst src/,dist/,$(_SRCFILES)))
PLUGINFILES:=$(shell find dist/plugins -name '*.js' | grep -v auth/ | grep -v json.js)
ALLPLUGINS:=$(subst dist/plugins/,--plugin core/,$(subst .js,,$(PLUGINFILES)))

LDAPFLATSCHEMAS := $(shell find static/schemas/twake -name '*.json'|grep -v organization|grep -v groups|sed -e 's/^/--ldap-flat-schema /')

all: $(DSTFILES)

dist/%.js: src/%.ts
	echo $*
	$(MAKE) -f .dev.mk _builddev

build:
	npm run build:prod

builddev: $(DSTFILES) $(DSTBROWSER) Dockerfile

_builddev:
	npx rimraf dist
	npx rollup -c
	npx rollup -c rollup.browser.config.mjs
	node scripts/moveBrowserLibs.mjs

builddocker: Dockerfile
	docker build -t mini-dm .

Dockerfile: scripts/buildDockerfile.ts $(SRCFILES) bin rollup.config.mjs tsconfig.json static
	npx tsx scripts/buildDockerfile.ts

doc: $(SRCFILES)
	typedoc --entryPoints src/bin/index.ts $(shell find src -name '*.ts' | grep -v bin/index) --out docs

start: $(DSTFILES)
	node bin/index.mjs --log-level debug $(ALLPLUGINS) $(LDAPFLATSCHEMAS)

test: $(DSTFILES)
	npm run test

.PHONY: builddev,builddocker,test
