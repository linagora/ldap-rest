#!/usr/bin/make -f

SRCFILES=$(shell find src/*/ -name '*.ts')
DSTFILES=$(subst .ts,.js,$(subst src/,dist/,$(SRCFILES)))
PLUGINFILES=$(shell find dist/plugins -name '*.js' | grep -v auth/)
ALLPLUGINS=$(subst dist/plugins/,--plugin core/,$(subst .js,,$(PLUGINFILES)))

all: $(DSTFILES)

dist/%.js: src/%.ts
	$(MAKE) -f .dev.mk _builddev

build:
	npm run build:prod

builddev: $(DSTFILES) Dockerfile

_builddev:
	npx rimraf dist
	npx rollup -c

builddocker: Dockerfile
	docker build -t mini-dm .

Dockerfile: scripts/buildDockerfile.ts $(SRCFILES) bin rollup.config.mjs tsconfig.json static
	npx tsx scripts/buildDockerfile.ts

doc: $(SRCFILES)
	typedoc --entryPoints src/bin/index.ts $(shell find src -name '*.ts' | grep -v bin/index) --out docs

start: $(DSTFILES)
	node bin/index.mjs --log-level debug $(ALLPLUGINS)

test: $(DSTFILES)
	npm run test

.PHONY: builddev,builddocker,test